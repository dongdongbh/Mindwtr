import { execFileSync } from "node:child_process";

export const UPSTREAM_GUARDS = [
  { advisory: "GHSA-3g3m-2fjr-6pw4", consumer: "@expo/cli@^54.0.20", dependency: "glob", fixed: "14.0.2" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "eslint@^9.39.1", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "@eslint/config-array@^0.21.1", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "@eslint/eslintrc@^3.3.3", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "glob@^13.0.0", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "@expo/cli@^54.0.20", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "@expo/fingerprint@^0.15.4", dependency: "minimatch", fixed: "11.0.1" },
  { advisory: "GHSA-g3hv-75wg-m249", consumer: "@expo/metro-config@^54.0.12", dependency: "minimatch", fixed: "11.0.1" },
];

export const upstreamGuardFailure = (guard, ranges) => {
  const published = [ranges].flat().filter((range) => typeof range === "string");
  if (!published.length) return `${guard.consumer} no longer depends on ${guard.dependency}: re-check ${guard.advisory} and its audit exception.`;
  if (published.some((range) => Bun.semver.satisfies(guard.fixed, range))) {
    return `${guard.consumer} now accepts ${guard.dependency} ${guard.fixed}: update it and drop the ${guard.advisory} audit exception.`;
  }
  return null;
};

const publishedRanges = ({ consumer, dependency }) => {
  const output = execFileSync("npm", ["view", consumer, `dependencies.${dependency}`, "--json"], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
};

if (import.meta.main) {
  const failures = UPSTREAM_GUARDS.map((guard) => upstreamGuardFailure(guard, publishedRanges(guard))).filter(Boolean);
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exit(1);
  console.log("No upstream release in the locked lines accepts a fixed glob or minimatch yet.");
}
