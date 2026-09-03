import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const tempRoots = [];
const script = resolve("scripts/ci/update-flathub-checkout.sh");
const fixtures = resolve("scripts/ci/fixtures/flathub");
const commit = "fedcba9876543210fedcba9876543210fedcba98";

test("desktop declares XML parsing as an isolated-install dependency", () => {
  const packageJson = JSON.parse(
    readFileSync("apps/desktop/package.json", "utf8"),
  );
  const packageLock = JSON.parse(
    readFileSync("apps/desktop/package-lock.json", "utf8"),
  );

  expect(packageJson.dependencies["@xmldom/xmldom"]).toBe("0.8.15");
  expect(packageLock.packages["node_modules/@xmldom/xmldom"].version).toBe(
    "0.8.15",
  );
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runFixture = (fixtureName) => {
  const root = mkdtempSync(join(tmpdir(), "mindwtr-flathub-manifest-"));
  tempRoots.push(root);
  const manifest = join(root, "tech.dongdongbh.mindwtr.yml");
  cpSync(join(fixtures, fixtureName), manifest);
  const result = spawnSync("bash", [script, commit, root, root], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      MINDWTR_FLATHUB_MANIFEST_ONLY: "1",
      ANALYTICS_HEARTBEAT_URL: "https://analytics.fixture/",
      VITE_ANALYTICS_RELEASE_VERSION: "1.2.5",
      VITE_DROPBOX_APP_KEY: "fixture-key",
      VITE_FEEDBACK_ENDPOINT_URL: "https://feedback.fixture/",
    },
  });
  return { manifest, result };
};

test("updates an unpatched Flathub manifest fixture", () => {
  const { manifest, result } = runFixture("unpatched.yml");
  expect(result.status, result.stderr).toBe(0);

  const updated = readFileSync(manifest, "utf8");
  expect(updated).toContain(`commit: ${commit}`);
  expect(updated).toContain('if requested_spec.startswith("workspace:")');
  expect(updated).toContain('local_spec = f"file:{locked_resolved}"');
  expect(updated).toContain("- shared-modules/libayatana-appindicator/libayatana-appindicator-gtk3.json");
  expect(updated).not.toContain("appstream-homepage.patch");
  expect(updated).not.toContain("org.tech_dongdongbh_mindwtr.SingleInstance");
  expect(updated).toContain("- --socket=pulseaudio");
  expect(updated).toContain("- --talk-name=org.freedesktop.Notifications");
  expect(updated).toContain("- VITE_ANALYTICS_HEARTBEAT_URL=https://analytics.fixture/");
  expect(updated).toContain("- VITE_ANALYTICS_RELEASE_VERSION=1.2.5");
  expect(updated).toContain("- VITE_DROPBOX_APP_KEY=fixture-key");
  expect(updated).toContain("- VITE_FEEDBACK_ENDPOINT_URL=https://feedback.fixture/");
});

test("is idempotent after the workspace repair block has been patched", () => {
  const { manifest, result } = runFixture("unpatched.yml");
  expect(result.status, result.stderr).toBe(0);
  const once = readFileSync(manifest, "utf8");

  const second = spawnSync("bash", [script, commit, manifest.replace(/\/[^/]+$/, ""), "."], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      MINDWTR_FLATHUB_MANIFEST_ONLY: "1",
      ANALYTICS_HEARTBEAT_URL: "https://analytics.fixture/",
      VITE_ANALYTICS_RELEASE_VERSION: "1.2.5",
      VITE_DROPBOX_APP_KEY: "fixture-key",
      VITE_FEEDBACK_ENDPOINT_URL: "https://feedback.fixture/",
    },
  });

  expect(second.status, second.stderr).toBe(0);
  expect(readFileSync(manifest, "utf8")).toBe(once);
});

test("fails closed when the generator repair block drifts", () => {
  const { result } = runFixture("drifted.yml");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Could not find the desktop workspace dependency repair block");
});

test("fails closed when a generated workspace repair block is only partially intact", () => {
  const { result } = runFixture("partially-drifted.yml");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Could not find the desktop workspace dependency repair block");
});
