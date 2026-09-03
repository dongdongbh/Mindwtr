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
  expect(workflow).toContain(
    "npm ci --prefix tools/eas-cli --ignore-scripts --legacy-peer-deps",
  );
  expect(workflow).toContain(
    "$GITHUB_WORKSPACE/tools/eas-cli/node_modules/.bin/eas",
  );
  expect(workflow).not.toContain("npm install -g eas-cli");

  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain(
    "npm ci --prefix tools/eas-cli --ignore-scripts --legacy-peer-deps --dry-run",
  );
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

test("Flathub generation is locked and credential-free until publication", () => {
  const workflow = read(".github/workflows/update-flathub.yml");
  const requirements = read("scripts/ci/flathub-generator-requirements.txt");

  const checkoutCount =
    workflow.match(/uses: actions\/checkout@/g)?.length ?? 0;
  const nonPersistingCheckoutCount =
    workflow.match(/persist-credentials: false/g)?.length ?? 0;

  expect(checkoutCount).toBeGreaterThan(0);
  expect(nonPersistingCheckoutCount).toBe(checkoutCount);

  const flathubCheckoutStart = workflow.indexOf(
    "- name: Checkout Flathub repo",
  );
  const flathubCheckoutEnd = workflow.indexOf(
    "\n      - name:",
    flathubCheckoutStart + 1,
  );
  const flathubCheckout = workflow.slice(
    flathubCheckoutStart,
    flathubCheckoutEnd,
  );

  expect(flathubCheckoutStart).toBeGreaterThanOrEqual(0);
  expect(flathubCheckout).not.toContain("FLATHUB_REPO_TOKEN");
  expect(flathubCheckout).not.toMatch(/^\s+token:/m);

  const tokenReferences =
    workflow.match(/\$\{\{\s*secrets\.FLATHUB_REPO_TOKEN\s*\}\}/g) ?? [];
  expect(tokenReferences).toHaveLength(1);

  expect(workflow).toContain(
    "uses: actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405 # v6.2.0",
  );
  expect(workflow).toContain("python-version: '3.12.14'");
  expect(workflow).toContain(
    'python -m venv "$RUNNER_TEMP/flathub-generator-venv"',
  );
  expect(workflow).toContain("--require-hashes --only-binary=:all:");
  expect(workflow).toContain(
    '--no-deps --no-build-isolation "$GITHUB_WORKSPACE/flatpak-builder-tools/node"',
  );
  expect(workflow).not.toContain("pipx");
  expect(workflow).not.toContain("pip install --user");
  expect(workflow).not.toContain("--upgrade pip");
  expect(workflow).toContain(
    'echo "$generator_venv/bin" >> "$GITHUB_PATH"',
  );
  expect(workflow).not.toContain('$HOME/.local/bin');

  const publicationStart = workflow.indexOf(
    "- name: Create or update Flathub PR",
  );
  const publicationEnd = workflow.indexOf(
    "\n      - name:",
    publicationStart + 1,
  );
  const publication = workflow.slice(publicationStart, publicationEnd);
  const authIndex = publication.indexOf(
    "gh auth setup-git --hostname github.com",
  );
  const pushIndex = publication.indexOf("git push");

  expect(publicationStart).toBeGreaterThanOrEqual(0);
  expect(publication).toContain("GH_TOKEN: ${{ secrets.FLATHUB_REPO_TOKEN }}");
  expect(authIndex).toBeGreaterThanOrEqual(0);
  expect(pushIndex).toBeGreaterThan(authIndex);

  const expectedRequirements = [
    "aiohappyeyeballs==2.7.1 --hash=sha256:9243213661e29250eb41368e5daa826fc017156c3b8a11440826b2e3ed376472",
    "aiohttp==3.14.3 --hash=sha256:543906c127fb1d929b95076db19b83fa2d46751006ff1e23b093aa5ac4d8db42",
    "aiosignal==1.4.0 --hash=sha256:053243f8b92b990551949e63930a839ff0cf0b0ebbe0597b0f3fb19e1a0fe82e",
    "attrs==26.1.0 --hash=sha256:c647aa4a12dfbad9333ca4e71fe62ddc36f4e63b2d260a37a8b83d2f043ac309",
    "frozenlist==1.8.0 --hash=sha256:494a5952b1c597ba44e0e78113a7266e656b9794eec897b19ead706bd7074383",
    "idna==3.19 --hash=sha256:815e7be7a7806d54abb586dc943addc79e8b2ee16915059658cbeff4b1b43bf4",
    "multidict==6.7.1 --hash=sha256:bfde23ef6ed9db7eaee6c37dcec08524cb43903c60b285b172b6c094711b3961",
    "poetry-core==2.4.1 --hash=sha256:acf06f9537cd2625bdaec926d95d90b557ba15353bc71d27a3a8a441042b5316",
    "propcache==0.5.2 --hash=sha256:6f328175a2cde1f0ff2c4ed8ce968b9dcfb55f3a7153f39e2957ed994da13476",
    "pyyaml==6.0.3 --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc",
    "tomlkit==0.15.1 --hash=sha256:177a05aece5a8ca5266fd3c448abb47b8d352f09d477d3ca8332db4d89b24304",
    "typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
    "yarl==1.24.5 --hash=sha256:f08c7513ecef5aad65687bfdf6bc601ae9fccd04a42904501f8f7141abad9eb9",
  ];
  const requirementLines = requirements
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  expect(requirementLines).toEqual(expectedRequirements);
  for (const line of requirementLines) {
    expect(line).toMatch(
      /^([A-Za-z0-9_.-]+)==([A-Za-z0-9.+-]+) --hash=sha256:([a-f0-9]{64})$/,
    );
  }
});
