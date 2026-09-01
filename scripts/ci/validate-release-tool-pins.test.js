import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const dockerfiles = ["docker/app/Dockerfile", "docker/cloud/Dockerfile"];

const externalDockerBases = (dockerfile) => {
  const stages = new Set();
  const bases = [];

  for (const line of dockerfile.split("\n")) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i);
    if (!from) continue;

    const [, base, stage] = from;
    if (!stages.has(base)) bases.push(base);
    if (stage) stages.add(stage);
  }

  return bases;
};

test("Docker bases and Bun installs follow the repository release pins", () => {
  const bunVersion = read(".bun-version").trim();
  const app = read("docker/app/Dockerfile");
  const cloud = read("docker/cloud/Dockerfile");

  for (const path of dockerfiles) {
    const dockerfile = read(path);
    const externalBases = externalDockerBases(dockerfile);

    expect(externalBases.length).toBeGreaterThan(0);
    for (const base of externalBases) {
      expect(base).toMatch(/@sha256:[a-f0-9]{64}$/);
    }

    expect(
      externalBases.some((base) =>
        base.startsWith(`oven/bun:${bunVersion}-alpine@sha256:`),
      ),
    ).toBe(true);
  }

  expect(
    externalDockerBases(app).some((base) =>
      base.startsWith("nginx:1.31.4-alpine@sha256:"),
    ),
  ).toBe(true);
  expect(app).toContain("RUN bun install --frozen-lockfile");
  expect(cloud).toContain("RUN bun install --production --frozen-lockfile");
});

test("MCP publisher is versioned and checksum-verified before credentials are used", () => {
  const workflow = read(".github/workflows/publish-mcp.yml");

  expect(workflow).toContain('MCP_PUBLISHER_VERSION: "1.8.0"');
  expect(workflow).toMatch(/MCP_PUBLISHER_LINUX_AMD64_SHA256: "[a-f0-9]{64}"/);
  expect(workflow).toContain(
    "releases/download/v${MCP_PUBLISHER_VERSION}/${archive}",
  );
  expect(workflow).toContain("sha256sum --check --strict");
  expect(workflow).not.toContain("releases/latest/download");
  const npmInstall = workflow.match(/npm install -g npm@([^\s]+)/);
  expect(npmInstall?.[1]).toBe("11.5.1");
  expect(npmInstall?.[1]).not.toMatch(/[~^*xX]/);

  const installIndex = workflow.indexOf("- name: Install mcp-publisher");
  const loginIndex = workflow.indexOf("./mcp-publisher login github-oidc");
  expect(installIndex).toBeGreaterThanOrEqual(0);
  expect(loginIndex).toBeGreaterThan(installIndex);
});

test("Linux AppImage repair pins and verifies appimagetool and its runtime", () => {
  const workflow = read(".github/workflows/release-linux.yml");

  expect(workflow).toContain('APPIMAGETOOL_VERSION: "1.9.1"');
  expect(workflow).toContain(
    'APPIMAGETOOL_X86_64_SHA256: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"',
  );
  expect(workflow).toContain(
    "releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage",
  );
  expect(workflow).toContain(
    "printf '%s  appimagetool.AppImage\\n' \"$APPIMAGETOOL_X86_64_SHA256\"",
  );
  expect(workflow).toContain(
    'sha256sum --check --strict appimagetool.sha256',
  );
  expect(workflow).not.toContain("releases/download/continuous/");
  expect(workflow).toContain(
    'APPIMAGE_RUNTIME_COMMIT: "75849dce7cc37e4319b633df1f116ca895c71a12"',
  );
  expect(workflow).toContain('APPIMAGE_RUNTIME_ASSET_ID: "456065460"');
  expect(workflow).toContain(
    'APPIMAGE_RUNTIME_X86_64_SHA256: "1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf"',
  );
  expect(workflow).toContain(
    "api.github.com/repos/AppImage/type2-runtime/releases/assets/${APPIMAGE_RUNTIME_ASSET_ID}",
  );
  expect(workflow).toContain('-H "Accept: application/octet-stream"');
  expect(workflow).toContain(
    "printf '%s  runtime-x86_64\\n' \"$APPIMAGE_RUNTIME_X86_64_SHA256\"",
  );
  expect(workflow).toContain("sha256sum --check --strict runtime.sha256");

  const downloadIndex = workflow.indexOf('curl -fsSL "$TOOL_URL"');
  const checksumIndex = workflow.indexOf("sha256sum --check --strict");
  const chmodIndex = workflow.indexOf('chmod +x "$TOOL_PATH"');
  const executionIndex = workflow.indexOf("./appimagetool.AppImage --appimage-extract");

  expect(downloadIndex).toBeGreaterThanOrEqual(0);
  expect(checksumIndex).toBeGreaterThan(downloadIndex);
  expect(chmodIndex).toBeGreaterThan(checksumIndex);
  expect(executionIndex).toBeGreaterThan(checksumIndex);

  const runtimeDownloadIndex = workflow.indexOf('"$RUNTIME_URL"');
  const runtimeChecksumIndex = workflow.indexOf(
    "sha256sum --check --strict runtime.sha256",
  );
  const runtimeUseIndex = workflow.indexOf('--runtime-file "$RUNTIME_PATH"');

  expect(runtimeDownloadIndex).toBeGreaterThanOrEqual(0);
  expect(runtimeChecksumIndex).toBeGreaterThan(runtimeDownloadIndex);
  expect(runtimeUseIndex).toBeGreaterThan(runtimeChecksumIndex);
});

test("Android releases use the isolated, repository-locked EAS CLI", () => {
  const manifest = JSON.parse(read("tools/eas-cli/package.json"));
  const lock = JSON.parse(read("tools/eas-cli/package-lock.json"));
  const workflow = read(".github/workflows/release-android.yml");

  expect(manifest.dependencies["eas-cli"]).toBe("21.5.0");
  expect(lock.packages["node_modules/eas-cli"].version).toBe("21.5.0");
  expect(workflow).toContain("npm ci --prefix tools/eas-cli --ignore-scripts");
  expect(workflow).toContain(
    "$GITHUB_WORKSPACE/tools/eas-cli/node_modules/.bin/eas",
  );
  expect(workflow).not.toContain("npm install -g eas-cli");
});

test("Apple release workflows execute the locked Fastlane bundle", () => {
  const gemfile = read("Gemfile");
  const lockfile = read("Gemfile.lock");

  expect(gemfile).toContain('gem "fastlane", "2.237.0"');
  expect(lockfile).toContain("fastlane (= 2.237.0)");
  expect(lockfile).toContain("BUNDLED WITH\n  4.0.3");

  for (const path of [
    ".github/workflows/release-ios-appstore.yml",
    ".github/workflows/release-macos-appstore.yml",
  ]) {
    const workflow = read(path);
    expect(workflow).toContain("bundle install --jobs 4 --retry 3");
    expect(workflow).toContain("bundle exec fastlane");
    expect(workflow).not.toContain("gem install fastlane --no-document");
  }
});
