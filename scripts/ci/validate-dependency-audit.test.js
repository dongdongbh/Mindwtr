import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";

import { validateMobileAuditReport } from "./validate-mobile-npm-audit.js";
import { validateBunAuditTopology, validateNpmAuditTopology, validateNpmAuditReport } from "./validate-npm-audit.js";

const rootRequire = createRequire(import.meta.url);

const IMAGE_SIZE_ADVISORIES = ["GHSA-5p2g-fcmc-qvqq", "GHSA-w3rx-r6r6-pgpr"];
const FORGE_ADVISORY = "GHSA-86w9-cpqp-85rv";
const BUN_ADVISORIES = [...IMAGE_SIZE_ADVISORIES, FORGE_ADVISORY];
const profiles = {mobile: "apps/mobile", eas: "tools/eas-cli"};
const npmLock = (profile) => JSON.parse(readFileSync(`${profiles[profile]}/package-lock.json`, "utf8"));
const bunLock = () => {
  const parsed = ts.parseConfigFileTextToJson("bun.lock", readFileSync("bun.lock", "utf8"));
  expect(parsed.error).toBeUndefined();
  return parsed.config;
};

const REQUIRED_PULL_REQUEST_PATHS = [
  ".github/workflows/dependency-audit.yml",
  "**/package-lock.json",
  "apps/*/package.json",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/Cargo.toml",
  "bun.lock",
  "package.json",
  "packages/*/package.json",
  "scripts/ci/validate-dependency-audit.test.js",
  "scripts/ci/validate-mobile-npm-audit.js",
  "scripts/ci/validate-npm-audit.js",
  "scripts/ci/audit-build-tool-topology.json",
  "tools/eas-cli/package.json",
];

const TRACKED_NPM_LOCKFILES = execFileSync(
  "git",
  ["ls-files", "*package-lock.json"],
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean).sort();

test("Bun audit exceptions stay limited to exact reviewed build-tool advisories and topology", () => {
  const workflow = readFileSync(".github/workflows/dependency-audit.yml", "utf8");
  const lockfile = readFileSync("bun.lock", "utf8");

  for (const advisory of BUN_ADVISORIES) {
    expect(workflow.match(new RegExp(`--ignore=${advisory}`, "g"))).toHaveLength(1);
  }
  expect(workflow.match(/--ignore=/g)).toHaveLength(BUN_ADVISORIES.length);
  expect(() => validateBunAuditTopology(bunLock())).not.toThrow();

  const imageSizeReferences = lockfile.match(/"image-size": "[^"]+"/g) ?? [];
  expect(imageSizeReferences).toEqual([
    '"image-size": "bin/image-size.js"',
    '"image-size": "^1.0.2"',
  ]);
  expect(lockfile).toContain('["image-size@1.2.1"');
  expect(lockfile).toMatch(
    /\["metro@[^\n]+"[^\n]+"dependencies": \{[^\n]+"image-size": "\^1\.0\.2"/,
  );
});

test("mobile query parsing keeps a patched CommonJS-compatible resolution", () => {
  const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
  const mobileManifest = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
  const mobileLock = JSON.parse(readFileSync("apps/mobile/package-lock.json", "utf8"));
  const bunLock = readFileSync("bun.lock", "utf8");
  const compatibilityPatch = readFileSync(
    "patches/query-string@7.1.3.patch",
    "utf8",
  );

  expect(rootManifest.dependencies["decode-uri-component"]).toBe("0.5.0");
  expect(rootManifest.dependencies["query-string"]).toBe("^9.3.1");
  expect(rootManifest.overrides["decode-uri-component"]).toBe("0.5.0");
  expect(rootManifest.resolutions["decode-uri-component"]).toBe("0.5.0");
  expect(rootManifest.patchedDependencies["query-string@7.1.3"]).toBe(
    "patches/query-string@7.1.3.patch",
  );
  expect(mobileManifest.dependencies["decode-uri-component"]).toBe("0.5.0");
  expect(mobileManifest.dependencies["query-string"]).toBe("7.1.3");
  expect(mobileManifest.overrides["decode-uri-component"]).toBe("0.5.0");
  expect(mobileManifest.overrides["query-string"]).toBe("7.1.3");
  expect(mobileManifest.scripts.postinstall).toBe(
    "node scripts/patch_query_string_cjs.js",
  );
  expect(compatibilityPatch).toContain(
    "const decodeComponent = decodeComponentModule.default ?? decodeComponentModule;",
  );

  const decodeVersions = new Set();
  const queryStringVersions = new Set();
  for (const [path, metadata] of Object.entries(mobileLock.packages)) {
    if (
      path === "node_modules/decode-uri-component" ||
      path.endsWith("/node_modules/decode-uri-component")
    ) {
      decodeVersions.add(metadata.version);
    }
    if (
      path === "node_modules/query-string" ||
      path.endsWith("/node_modules/query-string")
    ) {
      queryStringVersions.add(metadata.version);
    }
  }
  expect([...decodeVersions]).toEqual(["0.5.0"]);
  expect([...queryStringVersions]).toEqual(["7.1.3"]);
  expect(bunLock).toContain('["decode-uri-component@0.5.0"');
  expect(bunLock).not.toMatch(/decode-uri-component@(?:0\.[0-4](?:\.|\")|0\.4\.2)/);
  expect(new Set(bunLock.match(/\["query-string@[^\"]+"/g))).toEqual(new Set([
    '["query-string@7.1.3"',
    '["query-string@9.3.1"',
  ]));

  const { hasCompatibleImport, patchQueryString } = rootRequire(
    "../../apps/mobile/scripts/patch_query_string_cjs.js",
  );
  const compatibleImport = [
    "const decodeComponentModule = require('decode-uri-component');",
    "const decodeComponent = decodeComponentModule.default ?? decodeComponentModule;",
  ];
  expect(hasCompatibleImport(compatibleImport.join("\n"))).toBe(true);
  expect(hasCompatibleImport(compatibleImport.join("\r\n"))).toBe(true);
  expect(() => patchQueryString()).not.toThrow();

  const navigationRequire = createRequire(
    rootRequire.resolve("@react-navigation/core/package.json"),
  );
  const queryString = navigationRequire("query-string");
  expect(typeof queryString.parse).toBe("function");
  expect(queryString.parse("screen=Inbox%20Today&tag=next")).toEqual({
    screen: "Inbox Today",
    tag: "next",
  });
});

test("dependency changes run the audit before merge", () => {
  const workflow = readFileSync(".github/workflows/dependency-audit.yml", "utf8");
  const pullRequestBlock = workflow.match(/\n  pull_request:\n    paths:\n((?:      - .+\n)+)/)?.[1];

  expect(pullRequestBlock).toBeDefined();
  const paths = pullRequestBlock
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").replace(/^['\"]|['\"]$/g, ""))
    .sort();

  expect(paths).toEqual([...REQUIRED_PULL_REQUEST_PATHS].sort());
  expect(workflow).toContain('cron: "23 3 * * 1"');
  expect(workflow).toMatch(/\n  workflow_dispatch:\s*\n/);
});

test("every tracked npm package lock triggers and runs its own audit", () => {
  const workflow = readFileSync(".github/workflows/dependency-audit.yml", "utf8");
  const pullRequestBlock = workflow.match(/\n  pull_request:\n    paths:\n((?:      - .+\n)+)/)?.[1] ?? "";
  const pullRequestPaths = pullRequestBlock
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").replace(/^['\"]|['\"]$/g, ""));

  expect(pullRequestPaths).toContain("**/package-lock.json");

  const auditedPrefixes = [...workflow.matchAll(
    /npm audit --prefix ([^\s]+) --audit-level=low/g,
  )].map((match) => match[1]).sort();
  expect(auditedPrefixes).toEqual(
    TRACKED_NPM_LOCKFILES.map((lockfile) => dirname(lockfile)).sort(),
  );

  expect(workflow).toContain(
    'npm audit --prefix apps/mobile --audit-level=low --json > "$mobile_audit_report"',
  );
  expect(workflow).toContain(
    'bun scripts/ci/validate-mobile-npm-audit.js "$mobile_audit_report"',
  );
});

const advisory = (name, id, range) => ({
  name, dependency: name, range, url: `https://github.com/advisories/${id}`,
});

const allowedReport = (profile) => {
  const vulnerabilities = {
    "node-forge": {name: "node-forge", severity: "high", via: [advisory("node-forge", FORGE_ADVISORY, "<=1.4.0")], nodes: ["node_modules/node-forge"]},
  };
  if (profile === "mobile") vulnerabilities["image-size"] = {
    name: "image-size", severity: "high", via: [
      advisory("image-size", IMAGE_SIZE_ADVISORIES[0], ">=1.2.0 <=2.0.2"),
      advisory("image-size", IMAGE_SIZE_ADVISORIES[1], ">=0.6.3 <=2.0.2"),
    ], nodes: ["node_modules/image-size"],
  };
  return {auditReportVersion: 2, vulnerabilities, metadata: {vulnerabilities: {
    info: 0, low: 0, moderate: 0, high: Object.keys(vulnerabilities).length, critical: 0, total: Object.keys(vulnerabilities).length,
  }}};
};

for (const profile of Object.keys(profiles)) {
  test(`${profile} npm audit accepts only the exact reviewed advisory set`, () => {
    expect(() => validateNpmAuditReport(allowedReport(profile), profile, npmLock(profile))).not.toThrow();
    if (profile === "mobile") expect(() => validateMobileAuditReport(allowedReport(profile))).not.toThrow();
    const unexpected = allowedReport(profile);
    unexpected.vulnerabilities["node-forge"].via.push(advisory("node-forge", "GHSA-unexpected-advisory", "<=1.4.0"));
    expect(() => validateNpmAuditReport(unexpected, profile, npmLock(profile))).toThrow(/unexpected direct advisories/);
    const missing = allowedReport(profile);
    missing.vulnerabilities["node-forge"].via = [];
    expect(() => validateNpmAuditReport(missing, profile, npmLock(profile))).toThrow(/invalid dependency record/);
  });

  test(`${profile} exceptions fail on version, topology, or runtime exposure drift`, () => {
    for (const mutate of [
      (lock) => { lock.packages["node_modules/node-forge"].version = "1.4.1"; },
      (lock) => { lock.packages["node_modules/new-runtime"] = {version: "1.0.0", dependencies: {"node-forge": "1.4.0"}}; },
      (lock) => { lock.packages["node_modules/nested/node_modules/node-forge"] = {version: "1.4.0"}; },
      (lock) => { lock.packages[""].dependencies["node-forge"] = "1.4.0"; },
      (lock) => { lock.packages["node_modules/@expo/code-signing-certificates"].dependencies["node-forge"] = "^0.10.0"; },
    ]) {
      const lock = npmLock(profile);
      mutate(lock);
      expect(() => validateNpmAuditTopology(lock, profile)).toThrow(/unreviewed/);
    }
  });
}

test("npm exceptions reject malformed reports, API errors, unknown records, and altered IDs or ranges", () => {
  for (const mutate of [
    (r) => { r.error = {code: "EAUDITNETWORK"}; },
    (r) => { r.auditReportVersion = 1; },
    (r) => { r.vulnerabilities = []; },
    (r) => { delete r.metadata; },
    (r) => { r.metadata.vulnerabilities.total = 999; },
    (r) => { r.metadata.vulnerabilities.high = -1; },
    (r) => { r.vulnerabilities["node-forge"].name = "unrelated"; },
    (r) => { r.vulnerabilities["node-forge"].severity = "unknown"; },
    (r) => { r.vulnerabilities["node-forge"].nodes = ["node_modules/unknown"]; },
    (r) => { r.vulnerabilities["node-forge"].via[0].dependency = "unrelated"; },
    (r) => { r.vulnerabilities["node-forge"].via[0].url = `https://evil.example/advisories/${FORGE_ADVISORY}`; },
    (r) => { r.vulnerabilities["node-forge"].via[0].range = "*"; },
    (r) => { r.vulnerabilities["node-forge"].via.push(null); },
    (r) => { r.vulnerabilities["node-forge"].via.push("unrelated"); },
    (r) => { r.vulnerabilities["node-forge"].via.push(r.vulnerabilities["node-forge"].via[0]); },
  ]) {
    const report = allowedReport("mobile");
    mutate(report);
    expect(() => validateMobileAuditReport(report)).toThrow();
  }
});

test("npm advisory closure rejects missing dependencies and unrelated cycles", () => {
  const missing = allowedReport("mobile");
  missing.vulnerabilities["@expo/code-signing-certificates"] = {
    name: "@expo/code-signing-certificates", severity: "high", via: ["node-forge"], nodes: ["node_modules/@expo/code-signing-certificates"],
  };
  missing.metadata.vulnerabilities.high += 1;
  missing.metadata.vulnerabilities.total += 1;
  expect(() => validateMobileAuditReport(missing)).not.toThrow();
  delete missing.vulnerabilities["node-forge"];
  missing.metadata.vulnerabilities.high -= 1;
  missing.metadata.vulnerabilities.total -= 1;
  expect(() => validateMobileAuditReport(missing)).toThrow(/unexpected direct advisories/);
  const unrelated = allowedReport("mobile");
  unrelated.vulnerabilities["metro-config"] = {name: "metro-config", severity: "high", via: ["metro"], nodes: ["node_modules/metro-config"]};
  unrelated.vulnerabilities.metro = {name: "metro", severity: "high", via: ["metro-config"], nodes: ["node_modules/metro"]};
  unrelated.metadata.vulnerabilities.high += 2;
  unrelated.metadata.vulnerabilities.total += 2;
  expect(() => validateMobileAuditReport(unrelated)).toThrow(/not caused by a reviewed build-tool advisory/);
});

test("Bun exceptions reject new runtime consumers, nested copies, and changed versions", () => {
  for (const mutate of [
    (lock) => { lock.packages["node-forge"][0] = "node-forge@1.4.1"; },
    (lock) => { lock.packages["unexpected-runtime"] = ["unexpected-runtime@1.0.0", "", {dependencies: {"node-forge": "1.4.0"}}]; },
    (lock) => { lock.packages["nested/node-forge"] = structuredClone(lock.packages["node-forge"]); },
    (lock) => { lock.workspaces["apps/cloud"].dependencies["node-forge"] = "1.4.0"; },
  ]) {
    const lock = bunLock();
    mutate(lock);
    expect(() => validateBunAuditTopology(lock)).toThrow(/unreviewed/);
  }
});

test("Hono is pinned to the patched version throughout the Bun lock", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.overrides.hono).toBe("4.13.13");
  expect(manifest.resolutions.hono).toBe("4.13.13");
  const versions = Object.values(bunLock().packages).filter((metadata) => metadata[0].startsWith("hono@"));
  expect(versions.map((metadata) => metadata[0])).toEqual(["hono@4.13.13"]);
});

const buildToolImportNames = [
  "braces", "node-forge", "image-size", "micromatch", "chokidar", "fast-glob", "tailwindcss", "metro", "metro-config",
  "@expo/cli", "@expo/code-signing-certificates", "@expo/pkcs12", "jks-js", "nativewind/metro",
];
const buildToolImports = (source, path = "runtime.ts") => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const matches = [];
  const visit = (node) => {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) literal = node.arguments[0];
    if (literal && ts.isStringLiteralLike(literal)
      && buildToolImportNames.some((name) => literal.text === name || literal.text.startsWith(`${name}/`))) matches.push(literal.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
};

test("runtime exposure guard catches static, side-effect, dynamic, and template-literal imports", () => {
  for (const source of [
    'import {expand} from "braces";',
    'import "node-forge";',
    'export * from "micromatch";',
    'require ("@expo/cli/build");',
    'import(`node-forge`);',
  ]) expect(buildToolImports(source)).toHaveLength(1);
  expect(buildToolImports('import {Text} from "react-native"; const label = "braces";')).toEqual([]);
});

test("shipped runtime sources never import the excepted Node build-tool chains", () => {
  const files = (path) => readdirSync(path, {withFileTypes: true}).flatMap((entry) => {
    // build/.build/Pods hold Gradle, SwiftPM, and CocoaPods output under the native module dirs, never shipped JS source.
    if (["node_modules", "__tests__", ".expo", "dist", "build", ".build", "Pods"].includes(entry.name)) return [];
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [child] : [];
  });
  const roots = [
    "apps/desktop/src", "apps/mobile/app", "apps/mobile/lib", "apps/mobile/components", "apps/mobile/hooks",
    "apps/mobile/contexts", "apps/mobile/constants", "apps/mobile/utils", "apps/mobile/modules", "apps/mobile/shims",
    "packages/core/src", "apps/cloud/src", "apps/mcp-server/src",
  ];
  const sources = [...roots.flatMap(files), "apps/mobile/index.js", "apps/mobile/polyfills.js"];
  // Parsing all ~1,300 files takes over 20 s on a loaded machine; a file that never names a chain cannot import it.
  const imports = sources.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    if (!buildToolImportNames.some((name) => source.includes(name))) return [];
    return buildToolImports(source, path).map((name) => `${path}: ${name}`);
  });
  expect(imports).toEqual([]);
}, 20_000);
