#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const suspiciousCommand =
  /(^|[;&|()\s])(curl|wget|eval|base64|systemctl|crontab|socat)([;&|()\s]|$)|(^|[;&|()\s])nc\s|\/dev\/tcp|authorized_keys/i;

function parseArgs(argv) {
  const args = { policy: resolve(repoRoot, "aur/trusted-packages.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (
      value === "--package-dir" ||
      value === "--package" ||
      value === "--policy"
    ) {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      args[value.slice(2).replace("package-dir", "packageDir")] =
        value === "--package-dir" || value === "--policy"
          ? resolve(next)
          : next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.packageDir || !args.package)
    throw new Error("--package-dir and --package are required");
  return args;
}

function parseSrcinfo(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    const values = fields.get(key) ?? [];
    values.push(value);
    fields.set(key, values);
  }
  return fields;
}

function sourceUrl(value) {
  const separator = value.indexOf("::");
  return separator >= 0 ? value.slice(separator + 2) : value;
}

function isTrustedSource(value, upstreamRepository) {
  const url = sourceUrl(value);
  if (!url.includes("://"))
    return !url.includes("/") && !url.includes("\\") && url !== "";
  return (
    url.startsWith(`${upstreamRepository}/`) ||
    url.startsWith(`git+${upstreamRepository}.git`)
  );
}

function isSignature(value) {
  return /\.(asc|sig)(?:[?#].*)?$/i.test(sourceUrl(value));
}

export function validatePackageDir({ packageDir, packageName, policyPath }) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const packagePolicy = policy.packages[packageName];
  if (!packagePolicy)
    throw new Error(`Unknown trusted AUR package: ${packageName}`);

  const pkgbuild = readFileSync(resolve(packageDir, "PKGBUILD"), "utf8");
  const srcinfo = readFileSync(resolve(packageDir, ".SRCINFO"), "utf8");
  const trackedFiles = execFileSync("git", ["-C", packageDir, "ls-files"], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const allowedFiles = [...packagePolicy.trackedFiles].sort();
  const unexpected = trackedFiles.filter(
    (file) => !allowedFiles.includes(file),
  );
  if (unexpected.length)
    throw new Error(
      `${packageName} has unexpected tracked files: ${unexpected.join(", ")}`,
    );
  if (trackedFiles.some((file) => file.endsWith(".install")))
    throw new Error(`${packageName} contains an install script`);
  if (/^\s*install\s*=/m.test(pkgbuild))
    throw new Error(`${packageName} declares an install script`);

  for (const rawLine of pkgbuild.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (suspiciousCommand.test(line))
      throw new Error(
        `${packageName} PKGBUILD contains a forbidden command: ${rawLine.trim()}`,
      );
  }

  const pkgnameMatch = pkgbuild.match(
    /^pkgname=(?:["'])?([A-Za-z0-9@._+-]+)(?:["'])?\s*$/m,
  );
  const urlMatch = pkgbuild.match(/^url=["']([^"']+)["']\s*$/m);
  if (pkgnameMatch?.[1] !== packageName) {
    throw new Error(
      `${packageName} PKGBUILD declares a different package identity`,
    );
  }
  if (urlMatch?.[1] !== policy.upstreamRepository) {
    throw new Error(`${packageName} PKGBUILD has an untrusted upstream URL`);
  }
  const trustedPkgbuildUrls = [
    policy.upstreamRepository,
    ...(packagePolicy.trustedPkgbuildUrls ?? []),
  ];
  for (const url of pkgbuild.match(/(?:git\+)?https?:\/\/[^\s"')]+/g) ?? []) {
    if (
      !trustedPkgbuildUrls.some(
        (trustedUrl) => url === trustedUrl || url.startsWith(`${trustedUrl}/`),
      )
    ) {
      throw new Error(
        `${packageName} PKGBUILD contains an untrusted URL: ${url}`,
      );
    }
  }

  const fields = parseSrcinfo(srcinfo);
  if (
    fields.get("pkgbase")?.[0] !== packageName ||
    fields.get("pkgname")?.[0] !== packageName
  ) {
    throw new Error(
      `${packageName} PKGBUILD and .SRCINFO identity do not match`,
    );
  }
  if (fields.get("url")?.[0] !== policy.upstreamRepository) {
    throw new Error(`${packageName} .SRCINFO has an untrusted upstream URL`);
  }

  for (const [field, sources] of fields.entries()) {
    if (field !== "source" && !field.startsWith("source_")) continue;
    const suffix = field.slice("source".length);
    const checksumField = `sha256sums${suffix}`;
    const checksums = fields.get(checksumField) ?? [];
    if (sources.length !== checksums.length) {
      throw new Error(
        `${packageName} ${field} count does not match ${checksumField}`,
      );
    }
    sources.forEach((source, index) => {
      if (!isTrustedSource(source, policy.upstreamRepository)) {
        throw new Error(`${packageName} has an untrusted source: ${source}`);
      }
      const checksum = checksums[index];
      if (checksum === "SKIP") {
        if (!isSignature(source))
          throw new Error(
            `${packageName} skips the checksum for executable/source content: ${source}`,
          );
      } else if (!/^[0-9a-f]{64}$/i.test(checksum)) {
        throw new Error(
          `${packageName} has an invalid SHA-256 checksum for ${source}`,
        );
      }
    });
  }

  const signatureSources = [...fields.entries()]
    .filter(([field]) => field === "source" || field.startsWith("source_"))
    .flatMap(([, values]) => values)
    .filter(isSignature);
  if (signatureSources.length) {
    const validKeys = fields.get("validpgpkeys") ?? [];
    if (!validKeys.includes(policy.releaseSigningKeyFingerprint)) {
      throw new Error(
        `${packageName} signature sources do not trust the documented Mindwtr signing key`,
      );
    }
  }

  return { packageName, trackedFiles, signatureSources };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validatePackageDir({
    packageDir: args.packageDir,
    packageName: args.package,
    policyPath: args.policy,
  });
  process.stdout.write(
    `Validated ${result.packageName}: trusted sources, checksums, commands, and tracked files.\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
