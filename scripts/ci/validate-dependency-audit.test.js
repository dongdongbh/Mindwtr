import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { validateMobileAuditReport } from "./validate-mobile-npm-audit.js";

const rootRequire = createRequire(import.meta.url);

const IMAGE_SIZE_ADVISORIES = ["GHSA-5p2g-fcmc-qvqq", "GHSA-w3rx-r6r6-pgpr"];

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
  "tools/eas-cli/package.json",
];

const TRACKED_NPM_LOCKFILES = execFileSync(
  "git",
  ["ls-files", "*package-lock.json"],
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean).sort();

test("Bun audit exceptions stay limited to Metro's unpatched build dependency", () => {
  const workflow = readFileSync(".github/workflows/dependency-audit.yml", "utf8");
  const lockfile = readFileSync("bun.lock", "utf8");

  for (const advisory of IMAGE_SIZE_ADVISORIES) {
    expect(workflow.match(new RegExp(`--ignore=${advisory}`, "g"))).toHaveLength(1);
  }
  expect(workflow.match(/--ignore=/g)).toHaveLength(IMAGE_SIZE_ADVISORIES.length);

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

const advisory = (id) => ({
  url: `https://github.com/advisories/${id}`,
});

const allowedMobileAuditReport = () => ({
  vulnerabilities: {
    "image-size": {
      name: "image-size",
      via: IMAGE_SIZE_ADVISORIES.map(advisory),
    },
    metro: {
      name: "metro",
      via: ["image-size", "metro-config"],
    },
    "metro-config": {
      name: "metro-config",
      via: ["metro", "image-size"],
    },
  },
});

test("mobile npm audit accepts only the exact Metro image-size advisory closure", () => {
  expect(() => validateMobileAuditReport(allowedMobileAuditReport())).not.toThrow();

  const unexpectedAdvisory = allowedMobileAuditReport();
  unexpectedAdvisory.vulnerabilities["image-size"].via.push(
    advisory("GHSA-unexpected-advisory"),
  );
  expect(() => validateMobileAuditReport(unexpectedAdvisory)).toThrow(
    /unexpected direct advisories/,
  );

  const missingAdvisory = allowedMobileAuditReport();
  missingAdvisory.vulnerabilities["image-size"].via.pop();
  expect(() => validateMobileAuditReport(missingAdvisory)).toThrow(
    /unexpected direct advisories/,
  );

  const unrelatedCycle = allowedMobileAuditReport();
  unrelatedCycle.vulnerabilities.unrelated = {
    name: "unrelated",
    via: ["unrelated-helper"],
  };
  unrelatedCycle.vulnerabilities["unrelated-helper"] = {
    name: "unrelated-helper",
    via: ["unrelated"],
  };
  expect(() => validateMobileAuditReport(unrelatedCycle)).toThrow(
    /not transitively caused by image-size/,
  );
});
