import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const checker = "scripts/ci/check-android-16kb-page-size.sh";
const requiredLinkerFlags = [
  "-Wl,-z,max-page-size=16384",
  "-Wl,-z,common-page-size=16384",
];

test("Mindwtr native Android modules request 16 KB ELF alignment", () => {
  for (const cmakePath of [
    "apps/mobile/modules/attachment-file-installer/android/src/main/cpp/CMakeLists.txt",
    "apps/mobile/modules/sync-file-lock/android/src/main/cpp/CMakeLists.txt",
  ]) {
    const cmake = readFileSync(cmakePath, "utf8");
    for (const flag of requiredLinkerFlags) {
      expect(cmake).toContain(flag);
    }
  }
});

const buildFixture = (alignment) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "mindwtr-android-pagesize-"));
  const libraryDir = join(fixtureRoot, "lib", "x86_64");
  const sourcePath = join(fixtureRoot, "fixture.c");
  const libraryPath = join(libraryDir, "libfixture.so");
  const apkPath = join(fixtureRoot, `fixture-${alignment}.apk`);
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(sourcePath, "int mindwtr_fixture(void) { return 1; }\n");
  execFileSync("cc", [
    "-shared",
    "-fPIC",
    `-Wl,-z,max-page-size=${alignment}`,
    `-Wl,-z,common-page-size=${alignment}`,
    "-o",
    libraryPath,
    sourcePath,
  ]);
  execFileSync("zip", ["-q", "-r", apkPath, "lib"], { cwd: fixtureRoot });
  return { fixtureRoot, apkPath };
};

test("Android artifact checker rejects 4 KB ELF LOAD segments", () => {
  const fixture = buildFixture(4096);
  try {
    const result = spawnSync("bash", [checker, fixture.apkPath], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("UNALIGNED");
    expect(`${result.stdout}${result.stderr}`).toContain("0x1000");
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("Android artifact checker accepts 16 KB ELF LOAD segments", () => {
  const fixture = buildFixture(16384);
  try {
    const output = execFileSync("bash", [checker, fixture.apkPath], {
      encoding: "utf8",
    });
    expect(output).toContain("16 KB ELF alignment verified");
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("all release Android artifacts are checked before upload or signing", () => {
  const android = parse(
    readFileSync(".github/workflows/release-android.yml", "utf8"),
  );
  for (const [jobName, buildStepName] of [
    ["build-aab", "Build Android AAB (local EAS)"],
    ["build-internal-test-aab", "Build Android internal profileable AAB (local EAS)"],
    ["build-apk", "Build Android APK (local EAS)"],
  ]) {
    const steps = android.jobs[jobName].steps;
    const buildIndex = steps.findIndex((step) => step.name === buildStepName);
    const checkIndex = steps.findIndex(
      (step) => step.name === "Verify 16 KB native library alignment",
    );
    const uploadIndex = steps.findIndex((step) =>
      step.name?.startsWith("Upload Android"),
    );
    expect(buildIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeGreaterThan(buildIndex);
    expect(uploadIndex).toBeGreaterThan(checkIndex);
    expect(steps[checkIndex].run).toContain(checker);
  }

  const foss = parse(
    readFileSync(".github/workflows/release-android-foss.yml", "utf8"),
  );
  const fossSteps = foss.jobs["android-foss"].steps;
  const signIndex = fossSteps.findIndex(
    (step) => step.name === "Sign FOSS APK with release key",
  );
  const checkIndex = fossSteps.findIndex(
    (step) => step.name === "Verify 16 KB native library alignment",
  );
  const uploadIndex = fossSteps.findIndex(
    (step) => step.name === "Upload Android FOSS artifacts",
  );
  expect(checkIndex).toBeGreaterThan(signIndex);
  expect(uploadIndex).toBeGreaterThan(checkIndex);
  expect(fossSteps[checkIndex].run).toContain(checker);
});
