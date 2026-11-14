import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "android-version-code-policy.js");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (localCode, env, releases) => {
  const dir = mkdtempSync(join(tmpdir(), "android-version-code-"));
  dirs.push(dir);
  const appJson = join(dir, "app.json");
  const output = join(dir, "output");
  writeFileSync(appJson, JSON.stringify({ expo: { android: { versionCode: localCode } } }));
  writeFileSync(output, "");
  if (releases) {
    const file = join(dir, "play.json");
    writeFileSync(file, JSON.stringify({ maxVersionCode: 0, releases }));
    env = { ...env, PLAY_RELEASES_FILE: file };
  }
  const result = spawnSync("node", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, APP_JSON_PATH: appJson, GITHUB_OUTPUT: output, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("=")),
  );
  return { status: result.status, stderr: result.stderr, outputs, appJson: JSON.parse(readFileSync(appJson, "utf8")) };
};

const release = (track, name, ...codes) => ({ track, name, versionCodes: codes });
const stable = (code, version = "1.3.8") => [
  release("production", version, code),
  release("beta", `${version} stable beta`, code),
  release("internal", `${version} stable internal`, code),
];
const nativeRc = (code, version = "1.4.0-rc.1") => [
  release("beta", `${version} native testing`, code),
  release("internal", `${version} native testing`, code),
];
const native = (localCode, releases, env = {}) => run(localCode, { ANDROID_CLIENT: "native", ...env }, releases);

test("the first native RC starts 15 above React Native, before any RC exists", () => {
  const result = native(160, stable(160));
  expect(result.status).toBe(0);
  expect(result.outputs.resolved_code).toBe("175");
});

test("the first native RC also clears an old React Native RC still on beta", () => {
  const result = native(160, [release("production", "1.3.7", 159), release("beta", "1.3.8-rc.1 testing", 160)]);
  expect(result.outputs.resolved_code).toBe("175");
  const crowded = native(160, [release("production", "1.3.7", 159), release("internal", "1.3.8-rc.9 testing", 180)]);
  expect(crowded.outputs.resolved_code).toBe("195");
});

test("a native RC counts the tracked app.json code as the React Native code", () => {
  expect(native(162, stable(160)).outputs.resolved_code).toBe("177");
});

test("several native RCs in a row each go up by one", () => {
  expect(native(160, [...stable(160).slice(0, 1), ...nativeRc(175)]).outputs.resolved_code).toBe("176");
  expect(native(160, [...stable(160).slice(0, 1), ...nativeRc(176, "1.4.0-rc.2")]).outputs.resolved_code).toBe("177");
});

test("a native RC after a React Native stable keeps the 15-code lead", () => {
  const releases = [release("production", "1.3.9", 161), ...nativeRc(177, "1.4.0-rc.3")];
  expect(native(161, releases).outputs.resolved_code).toBe("178");
  const later = [release("production", "1.3.12", 170), ...nativeRc(178, "1.4.0-rc.4")];
  expect(native(170, later).outputs.resolved_code).toBe("185");
});

test("a requested native code must meet the minimum", () => {
  const releases = [release("production", "1.3.8", 160), ...nativeRc(175)];
  expect(native(160, releases, { REQUESTED_VERSION_CODE: "176" }).outputs.resolved_code).toBe("176");
  const reused = native(160, releases, { REQUESTED_VERSION_CODE: "175" });
  expect(reused.status).toBe(1);
  expect(reused.stderr).toContain("must be at least 176");
  expect(native(160, undefined, { REQUESTED_VERSION_CODE: "174" }).status).toBe(1);
});

test("native codes never pass Google Play's limit", () => {
  const result = native(160, [release("production", "9.9.9", 2100000000)]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("2100000000");
});

test("native codes are never written into the React Native app.json", () => {
  const result = native(160, undefined, { WRITE_APP_JSON: "1" });
  expect(result.status).toBe(1);
  expect(result.appJson.expo.android.versionCode).toBe(160);
});

test("React Native stable after a native RC uses the highest React Native code", () => {
  const releases = [release("production", "1.3.8", 160), ...nativeRc(175)];
  const result = run(161, {}, releases);
  expect(result.status).toBe(0);
  expect(result.outputs.resolved_code).toBe("161");
  expect(result.outputs.remote_max_code).toBe("160");
});

test("React Native stable still refuses a code Play already has", () => {
  const result = run(160, {}, [release("production", "1.3.8", 160), ...nativeRc(175)]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("bump apps/mobile/app.json above 160");
});

test("React Native may come within one of the native RC but never reach it", () => {
  const releases = [release("production", "1.3.20", 173), ...nativeRc(175)];
  expect(run(174, {}, releases).status).toBe(0);
  const caught = run(175, {}, releases);
  expect(caught.status).toBe(1);
  expect(caught.stderr).toContain("Cut a new native release candidate first");
  expect(run(176, {}, releases).status).toBe(1);
});

test("release prep bumps app.json above React Native codes only, and stops at the native RC", () => {
  const releases = [release("production", "1.3.8", 158), ...nativeRc(173)];
  const bumped = run(150, { WRITE_APP_JSON: "1", AUTO_BUMP_APP_JSON_VERSION_CODE: "1" }, releases);
  expect(bumped.status).toBe(0);
  expect(bumped.appJson.expo.android.versionCode).toBe(159);
  const blocked = run(150, { WRITE_APP_JSON: "1", AUTO_BUMP_APP_JSON_VERSION_CODE: "1" }, [release("production", "1.3.8", 172), ...nativeRc(173)]);
  expect(blocked.status).toBe(1);
  expect(blocked.appJson.expo.android.versionCode).toBe(150);
});

test("a React Native stable after several native RCs stays below the newest RC, and the next RC still goes up", () => {
  const releases = [release("production", "1.3.8", 160), ...nativeRc(177, "1.4.0-rc.3")];
  const reactNative = run(161, {}, releases);
  expect(reactNative.status).toBe(0);
  expect(reactNative.outputs.resolved_code).toBe("161");
  expect(run(177, {}, releases).status).toBe(1);
  const afterStable = [release("production", "1.3.9", 161), ...nativeRc(177, "1.4.0-rc.3")];
  expect(native(161, afterStable).outputs.resolved_code).toBe("178");
});

test("a native-looking name on production never counts as a native RC", () => {
  const result = run(161, {}, [release("production", "1.3.8 native testing", 160)]);
  expect(result.status).toBe(0);
  expect(result.outputs.remote_max_code).toBe("160");
});

test("an unknown release on a testing track fails loudly instead of guessing", () => {
  for (const name of ["", "160 (1.3.8)", "1.4.0-rc.1 Native testing", "hotfix"]) {
    const reactNative = run(161, {}, [release("production", "1.3.8", 160), release("internal", name, 170)]);
    expect(reactNative.status).toBe(1);
    expect(reactNative.stderr).toContain("will not guess");
    expect(native(161, [release("beta", name, 170)]).status).toBe(1);
  }
});

test.each([
  "1.2.6-rc.1 release candidate",
  "1.2.0 internal diagnostic 512",
  "1.1.0 (internal)",
  "1.3.8",
  "1.3.9-beta.1 testing",
])("the historical React Native name %p counts as React Native, even above production", (name) => {
  const releases = [release("production", "1.3.7", 159), release("internal", name, 165)];
  const reactNative = run(166, {}, releases);
  expect(reactNative.status).toBe(0);
  expect(reactNative.outputs.remote_max_code).toBe("165");
  expect(run(165, {}, releases).status).toBe(1);
  expect(native(166, releases).outputs.resolved_code).toBe("181");
});

test("an empty release with no name and no codes is ignored", () => {
  const releases = [release("production", "1.3.8", 160), { track: "internal" }, { track: "beta", name: "", versionCodes: [] }];
  expect(run(161, {}, releases).status).toBe(0);
  expect(native(160, releases).outputs.resolved_code).toBe("175");
});

test("an unknown release at or below production is ignored instead of blocking the run", () => {
  const releases = [release("production", "1.3.8", 160), release("alpha", "Old closed test", 120, 160), release("internal", "", 158)];
  const reactNative = run(161, {}, releases);
  expect(reactNative.status).toBe(0);
  expect(reactNative.outputs.resolved_code).toBe("161");
  expect(native(160, releases).outputs.resolved_code).toBe("175");
});

test("an unknown client is refused", () => {
  expect(run(160, { ANDROID_CLIENT: "hybrid" }).status).toBe(1);
});
