import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GLOB_ADVISORY = "GHSA-3g3m-2fjr-6pw4";
const MINIMATCH_ADVISORY = "GHSA-g3hv-75wg-m249";

export const UPSTREAM_GUARDS = [
  { advisory: GLOB_ADVISORY, consumer: "@expo/cli", range: "^54.0.20", dependency: "glob", fixed: "14.0.2" },
  { advisory: MINIMATCH_ADVISORY, consumer: "eslint", range: "^9.39.1", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "@eslint/config-array", range: "^0.21.1", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "@eslint/eslintrc", range: "^3.3.3", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "glob", range: "^7.2.3", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "glob", range: "^10.5.0", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "glob", range: "^13.0.0", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "@expo/cli", range: "^54.0.20", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "@expo/fingerprint", range: "^0.15.4", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: MINIMATCH_ADVISORY, consumer: "@expo/metro-config", range: "^54.0.12", dependency: "minimatch", fixed: "11.0.1" },
];

export const upstreamGuardFailure = (guard, ranges) => {
  const published = [ranges].flat().filter((range) => typeof range === "string");
  const line = `${guard.consumer}@${guard.range}`;
  if (!published.length) return `${line} no longer depends on ${guard.dependency}: re-check ${guard.advisory} and its audit exception.`;
  if (published.some((range) => Bun.semver.satisfies(guard.fixed, range))) {
    return `${line} now accepts ${guard.dependency} ${guard.fixed}: update it and drop the ${guard.advisory} audit exception.`;
  }
  return null;
};

export const bunLockedVersions = (lockText, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return [...new Set([...lockText.matchAll(new RegExp(`\\["${escaped}@([^"]+)"`, "g"))].map((match) => match[1]))].sort();
};

export const unwatchedLockedVersions = (lockText, guards = UPSTREAM_GUARDS) => {
  const failures = [];
  for (const key of new Set(guards.map((guard) => `${guard.advisory}\0${guard.consumer}\0${guard.dependency}`))) {
    const [advisory, consumer, dependency] = key.split("\0");
    const ranges = guards.filter((guard) => guard.advisory === advisory && guard.consumer === consumer && guard.dependency === dependency)
      .map((guard) => guard.range);
    const locked = bunLockedVersions(lockText, consumer);
    if (!locked.length) failures.push(`${consumer} is no longer in bun.lock: re-check the ${advisory} guard for ${dependency}.`);
    for (const version of locked) {
      if (!ranges.some((range) => Bun.semver.satisfies(version, range))) {
        failures.push(`${consumer}@${version} in bun.lock is outside the ${advisory} guard ranges ${ranges.join(", ")} for ${dependency}: move the guard to the locked line.`);
      }
    }
  }
  return failures;
};

const publishedRanges = ({ consumer, range, dependency }) => {
  const output = execFileSync("npm", ["view", `${consumer}@${range}`, `dependencies.${dependency}`, "--json"], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
};

if (import.meta.main) {
  const failures = [
    ...unwatchedLockedVersions(readFileSync("bun.lock", "utf8")),
    ...UPSTREAM_GUARDS.map((guard) => upstreamGuardFailure(guard, publishedRanges(guard))).filter(Boolean),
  ];
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exit(1);
  console.log("Every locked glob and minimatch consumer is watched, and no release in those lines accepts the fix yet.");
}
