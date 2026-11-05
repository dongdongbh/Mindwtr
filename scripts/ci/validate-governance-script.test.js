import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";


const GOVERNANCE_COMMANDS = [
  "bun run i18n:check",
  "python3 scripts/ci/prepare-ubuntu-apt.test.py",
  "python3 -m unittest discover -s scripts/ci -p test_cleanup_apple_outputs.py",
  "python3 -m unittest discover -s scripts/maintenance -p test_cleanup_merged_worktrees.py",
  "bun run test:governance",
  "bun run docs:check-readme",
  "bash scripts/ci/validate-store-image-assets.sh",
  "python3 scripts/ci/validate-appstream-locales.py",
  "node scripts/ci/validate-workflow-json-newlines.js",
  "node scripts/ci/check-package-lock-sync.js packages/core/package.json packages/core/package-lock.json --check-overrides",
  "node scripts/ci/check-package-lock-sync.js apps/desktop/package.json apps/desktop/package-lock.json --check-overrides",
  "node scripts/ci/check-mobile-foss-lock-sync.js",
  "npm ci --prefix tools/eas-cli --ignore-scripts --legacy-peer-deps --dry-run",
  "python3 scripts/ci/prepare-google-play-listing-metadata.test.py",
  "python3 scripts/ci/prepare-google-play-listing-metadata.py",
  "node scripts/ci/check-changelog-length.js",
  "python3 scripts/ci/validate-fastlane-metadata.test.py",
  "python3 scripts/ci/validate-watch-bundle.test.py",
  "python3 scripts/ci/validate-macos-private-apis.test.py",
  "scripts/ci/prepare-fastlane-metadata.sh",
  "node scripts/ci/validate-ios-app-intents-availability.js",
  "python3 scripts/ci/validate-apple-plists.py",
];

test("CI and verify run the same governance script", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  expect(scripts.governance).toBe("bash scripts/ci/governance.sh");
  expect(scripts.verify).toContain("bun run governance");
  for (const covered of ["test:governance", "i18n:check", "docs:check-readme"]) {
    expect(scripts.verify).not.toContain(covered);
  }

  const steps = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs.governance.steps;
  const install = steps.findIndex((step) => step.name === "Install dependencies");
  expect(steps.slice(install + 1).map((step) => step.run)).toEqual(["bun run governance"]);
});

test("the governance script keeps the CI commands in order", () => {
  const script = readFileSync("scripts/ci/governance.sh", "utf8");
  let previous = -1;
  for (const command of GOVERNANCE_COMMANDS) {
    const index = script.indexOf(command, previous + 1);
    expect({ command, found: index > previous }).toEqual({ command, found: true });
    previous = index;
  }
});


test.each([
  ["locally", {}, 0, "SKIP Example check: python3 is not installed"],
  ["in CI", { CI: "true" }, 1, "Example check needs python3, which is not installed"],
])("a check whose tool is missing %s", (_where, env, status, message) => {
  const result = spawnSync(
    "/bin/bash",
    ["-c", 'source scripts/ci/governance.sh && PATH=/nonexistent run "Example check" python3 -- true'],
    { encoding: "utf8", env: { HOME: process.env.HOME ?? "", ...env } },
  );
  expect(result.status).toBe(status);
  expect(result.stderr).toContain(message);
});
