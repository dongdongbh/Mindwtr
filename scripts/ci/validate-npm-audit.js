import { readFileSync } from "node:fs";

export const AUDIT_EXCEPTIONS = {
  "node-forge": { version: "1.4.0", advisories: { "GHSA-86w9-cpqp-85rv": "<=1.4.0" } },
  "image-size": { version: "1.2.1", advisories: {
    "GHSA-5p2g-fcmc-qvqq": ">=1.2.0 <=2.0.2",
    "GHSA-w3rx-r6r6-pgpr": ">=0.6.3 <=2.0.2",
  } },
};
const PROFILE_ROOTS = {
  mobile: ["node-forge", "image-size"], eas: ["node-forge"],
};
export const PROFILE_PREFIXES = { mobile: "apps/mobile", eas: "tools/eas-cli" };
const reviewedTopology = JSON.parse(readFileSync(new URL("./audit-build-tool-topology.json", import.meta.url), "utf8"));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const dependencyName = (path) => path.split("node_modules/").at(-1);
const sorted = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, metadata]) => [
  name, { ...metadata, edges: Object.fromEntries(Object.entries(metadata.edges).sort(([a], [b]) => a.localeCompare(b))) },
]));

// Snapshot every reviewed ancestor version and dependency edge. New consumers, nested
// copies, versions, or production classifications cannot inherit these exceptions.
// Peer-only audit propagation through React Native/Expo does not itself bundle their
// separate Node CLI packages into the mobile application's runtime.
export const npmAuditTopology = (lockfile, profile) => {
  if (!PROFILE_ROOTS[profile] || lockfile?.lockfileVersion !== 3 || !isRecord(lockfile.packages)) throw new Error("invalid audit profile or npm lockfile");
  const names = new Set(PROFILE_ROOTS[profile]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, metadata] of Object.entries(lockfile.packages)) {
      if (!path || !isRecord(metadata)) continue;
      if (Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).some((name) => names.has(name))) {
        const name = dependencyName(path);
        if (!names.has(name)) { names.add(name); changed = true; }
      }
    }
  }
  const graph = {};
  for (const [path, metadata] of Object.entries(lockfile.packages)) {
    if (path && !names.has(dependencyName(path))) continue;
    if (!isRecord(metadata)) throw new Error("invalid npm lockfile package metadata");
    const edges = {};
    for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(metadata[kind] ?? {})) if (names.has(name)) edges[`${kind}:${name}`] = version;
    }
    graph[path] = { version: path ? metadata.version : null, edges };
  }
  return graph;
};

export const validateNpmAuditTopology = (lockfile, profile) => {
  if (sorted(npmAuditTopology(lockfile, profile)) !== sorted(reviewedTopology[profile])) throw new Error(`unreviewed ${profile} build-tool dependency topology or version; remove or review the audit exceptions`);
};

export const bunAuditTopology = (lockfile) => {
  if (!isRecord(lockfile?.packages) || !isRecord(lockfile.workspaces)) throw new Error("invalid Bun lockfile");
  const names = new Set(Object.keys(AUDIT_EXCEPTIONS));
  let changed = true;
  while (changed) {
    changed = false;
    for (const metadata of Object.values(lockfile.packages)) {
      if (Object.keys({ ...metadata[2]?.dependencies, ...metadata[2]?.optionalDependencies }).some((name) => names.has(name))) {
        const name = metadata[0].slice(0, metadata[0].lastIndexOf("@"));
        if (!names.has(name)) { names.add(name); changed = true; }
      }
    }
  }
  const graph = {};
  for (const [path, metadata] of Object.entries(lockfile.packages)) {
    if (!names.has(metadata[0].slice(0, metadata[0].lastIndexOf("@")))) continue;
    const edges = {};
    for (const kind of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(metadata[2]?.[kind] ?? {})) if (names.has(name)) edges[`${kind}:${name}`] = version;
    }
    graph[path] = { version: metadata[0], edges };
  }
  for (const [path, metadata] of Object.entries(lockfile.workspaces)) {
    const edges = {};
    for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(metadata[kind] ?? {})) if (names.has(name)) edges[`${kind}:${name}`] = version;
    }
    if (Object.keys(edges).length) graph[`workspace:${path}`] = { version: null, edges };
  }
  return graph;
};

export const validateBunAuditTopology = (lockfile) => {
  if (sorted(bunAuditTopology(lockfile)) !== sorted(reviewedTopology.bun)) throw new Error("unreviewed Bun build-tool dependency topology or version; remove or review the audit exceptions");
};

export const validateNpmAuditReport = (report, profile, lockfile) => {
  validateNpmAuditTopology(lockfile, profile);
  if (!isRecord(report) || Object.hasOwn(report, "error") || report.auditReportVersion !== 2 || !isRecord(report.vulnerabilities)) throw new Error("npm audit returned an error or malformed report");
  const vulnerabilities = report.vulnerabilities;
  const counts = report.metadata?.vulnerabilities;
  const severities = ["info", "low", "moderate", "high", "critical"];
  if (!isRecord(counts) || [...severities, "total"].some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)
    || counts.total !== Object.keys(vulnerabilities).length
    || severities.reduce((sum, severity) => sum + counts[severity], 0) !== counts.total) throw new Error("npm audit returned invalid vulnerability counts");

  const directAdvisories = [];
  const edges = new Map();
  const observedCounts = Object.fromEntries(severities.map((severity) => [severity, 0]));
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!isRecord(vulnerability) || vulnerability.name !== name || !severities.includes(vulnerability.severity)
      || !Array.isArray(vulnerability.via) || !vulnerability.via.length
      || !Array.isArray(vulnerability.nodes) || !vulnerability.nodes.length) throw new Error(`npm audit returned an invalid dependency record for ${name}`);
    observedCounts[vulnerability.severity] += 1;
    for (const node of vulnerability.nodes) {
      if (typeof node !== "string" || dependencyName(node) !== name || !isRecord(lockfile.packages[node])) throw new Error(`npm audit returned an unknown lockfile node for ${name}`);
    }
    const causes = [];
    for (const cause of vulnerability.via) {
      if (typeof cause === "string") {
        if (!vulnerability.nodes.some((node) => ["dependencies", "optionalDependencies", "peerDependencies"]
          .some((kind) => cause in (lockfile.packages[node][kind] ?? {})))) throw new Error(`npm audit returned an unrecognized dependency edge ${name} -> ${cause}`);
        causes.push(cause);
      } else if (isRecord(cause)) {
        const match = typeof cause.url === "string" && cause.url.match(/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/);
        if (!match || cause.name !== name || cause.dependency !== name || !PROFILE_ROOTS[profile].includes(name)
          || AUDIT_EXCEPTIONS[name]?.advisories[match[1]] !== cause.range
          || vulnerability.nodes.some((node) => lockfile.packages[node].version !== AUDIT_EXCEPTIONS[name].version)) throw new Error(`npm audit returned unexpected direct advisories for ${name}`);
        directAdvisories.push(`${name}:${match[1]}`);
      } else throw new Error(`npm audit returned an invalid cause for ${name}`);
    }
    edges.set(name, causes);
  }
  if (severities.some((severity) => observedCounts[severity] !== counts[severity])) throw new Error("npm audit returned inconsistent severity counts");
  const expected = PROFILE_ROOTS[profile].flatMap((name) => Object.keys(AUDIT_EXCEPTIONS[name].advisories).map((id) => `${name}:${id}`)).sort();
  if (JSON.stringify(directAdvisories.sort()) !== JSON.stringify(expected)) throw new Error("npm audit returned unexpected direct advisories; exceptions require the exact reviewed advisory set");
  for (const [name, causes] of edges) for (const cause of causes) if (!edges.has(cause)) throw new Error(`npm audit linked ${name} to missing vulnerability ${cause}`);
  const reachesAllowedCause = (name, visiting = new Set()) => {
    if (PROFILE_ROOTS[profile].includes(name)) return true;
    if (visiting.has(name)) return false;
    const next = new Set(visiting).add(name);
    return (edges.get(name) ?? []).some((cause) => reachesAllowedCause(cause, next));
  };
  for (const name of edges.keys()) if (!reachesAllowedCause(name)) throw new Error(`npm audit vulnerability ${name} is not caused by a reviewed build-tool advisory`);
};

if (import.meta.main) {
  try {
    const [reportPath, profile] = process.argv.slice(2);
    if (!reportPath || !PROFILE_PREFIXES[profile]) throw new Error("usage: validate-npm-audit.js <report.json> <mobile|eas>");
    const lockfile = JSON.parse(readFileSync(`${PROFILE_PREFIXES[profile]}/package-lock.json`, "utf8"));
    validateNpmAuditReport(JSON.parse(readFileSync(reportPath, "utf8")), profile, lockfile);
    console.log(`Accepted only the reviewed ${profile} build-tool advisory closure.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
