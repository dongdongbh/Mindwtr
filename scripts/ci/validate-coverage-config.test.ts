import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { glob } from "tinyglobby";

import desktopConfig from "../../apps/desktop/vitest.config";
import mobileConfig from "../../apps/mobile/vitest.config";
import coreConfig from "../../packages/core/vitest.config";

type ConfigObject = {
  test?: {
    coverage?: unknown;
  };
};

const LEGACY_RAW_NUL_EXCLUSION = "**/\0*";
const SELECTED_SOURCE = "src/unloaded.ts";
const COMMON_EXCLUDED_FIXTURES = [
  "coverage/generated.ts",
  "dist/generated.ts",
  "src/__tests__/helper.ts",
  "src/feature.spec.ts",
  "src/feature.test.ts",
  "tests/helper.ts",
  "virtual:generated.ts",
  "__x00__generated.ts",
] as const;

const CONFIGS = [
  { name: "core", config: coreConfig, extraExcludedFixtures: [] },
  {
    name: "desktop",
    config: desktopConfig,
    extraExcludedFixtures: ["src-tauri/target/debug/generated.ts"],
  },
  { name: "mobile", config: mobileConfig, extraExcludedFixtures: [] },
] as const satisfies ReadonlyArray<{
  name: string;
  config: ConfigObject;
  extraExcludedFixtures: readonly string[];
}>;

const fixtureRoots = new Map<string, string>();
let fixtureRoot = "";

const coveragePatterns = (name: string, config: ConfigObject) => {
  const coverage = config.test?.coverage;
  if (!coverage || typeof coverage !== "object") {
    throw new Error(`${name} must define coverage options`);
  }

  const include = "include" in coverage ? coverage.include : undefined;
  const exclude = "exclude" in coverage ? coverage.exclude : undefined;
  if (
    !Array.isArray(include)
    || !include.every((pattern) => typeof pattern === "string")
    || !Array.isArray(exclude)
    || !exclude.every((pattern) => typeof pattern === "string")
  ) {
    throw new Error(`${name} coverage include/exclude must be string arrays`);
  }

  return { include, exclude };
};

const writeFixture = async (root: string, relativePath: string) => {
  const absolutePath = join(root, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "export const fixture = true;\n");
};

const selectCoverageFiles = async (
  name: string,
  config: ConfigObject,
  extraExclude: readonly string[] = [],
) => {
  const root = fixtureRoots.get(name);
  if (!root) throw new Error(`Missing fixture root for ${name}`);
  const { include, exclude } = coveragePatterns(name, config);
  return glob(include, {
    cwd: root,
    dot: true,
    ignore: [...exclude, ...extraExclude],
    onlyFiles: true,
  });
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "mindwtr-coverage-config-"));
  for (const { name, extraExcludedFixtures } of CONFIGS) {
    const root = join(fixtureRoot, name);
    fixtureRoots.set(name, root);
    await Promise.all([
      SELECTED_SOURCE,
      ...COMMON_EXCLUDED_FIXTURES,
      ...extraExcludedFixtures,
    ].map((relativePath) => writeFixture(root, relativePath)));
  }
});

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe.each(CONFIGS)("$name Vitest coverage config", ({ name, config }) => {
  test("selects unloaded source while excluding tests and generated files", async () => {
    expect(await selectCoverageFiles(name, config)).toEqual([SELECTED_SOURCE]);
  });

  test("rejects the legacy raw-NUL exclusion that empties the source set", async () => {
    const { exclude } = coveragePatterns(name, config);
    expect(exclude).not.toContain(LEGACY_RAW_NUL_EXCLUSION);
    expect(
      await selectCoverageFiles(name, config, [LEGACY_RAW_NUL_EXCLUSION]),
    ).toEqual([]);
  });
});
