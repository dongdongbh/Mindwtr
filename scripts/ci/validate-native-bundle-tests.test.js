import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

test("CI runs the native bundle tests on the pinned native runner", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  expect(scripts["test:native-bundle"]).toBe("bash scripts/ci/run-native-bundle-tests.sh");

  const job = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs["native-bundle"];
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job.steps.at(-1).run).toBe("bun run test:native-bundle");
});

test("each bundle test file runs in its own process and any failure fails the run", () => {
  const root = mkdtempSync(join(tmpdir(), "native-bundle-tests-"));
  try {
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    copyFileSync("scripts/ci/run-native-bundle-tests.sh", join(root, "scripts/ci/run-native-bundle-tests.sh"));
    for (const file of ["apps/android-native/bundle/a.test.ts", "apps/android-native/bundle/b.test.ts", "apps/ios-native/bundle/c.test.ts"]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), `#!/bin/sh\necho "$@" >> "${join(root, "calls.txt")}"\n[ "$2" != apps/android-native/bundle/a.test.ts ]\n`);
    chmodSync(join(bin, "bun"), 0o755);

    const result = spawnSync("/bin/bash", [join(root, "scripts/ci/run-native-bundle-tests.sh")], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("FAILED apps/android-native/bundle/a.test.ts\n");
    expect(readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n")).toEqual([
      "test apps/android-native/bundle/a.test.ts",
      "test apps/android-native/bundle/b.test.ts",
      "test apps/ios-native/bundle/c.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
