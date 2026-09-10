import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const readIosRelease = () => parse(readFileSync('.github/workflows/release-ios-appstore.yml', 'utf8'));
const asNeedsList = (needs) => (Array.isArray(needs) ? needs : [needs]);

test('Watch release routing embeds Watch in stable and RC archives', () => {
  const stable = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
  const rc = parse(readFileSync('.github/workflows/release-rc.yml', 'utf8'));
  const stableIos = stable.jobs['ios-appstore'];
  expect(stableIos.with.include_watch).toBe(true);
  expect(stableIos.with.testflight_only).toBe(false);
  expect(stableIos.with.submit_for_review).toBe(true);
  expect(stableIos.with.distribute_testflight).toBe(true);
  expect(stable.jobs['ios-watch-testflight']).toBeUndefined();
  expect(stable.on.workflow_dispatch.inputs.run_ios_watch_testflight).toBeUndefined();

  const rcIos = rc.jobs['ios-appstore'];
  expect(rcIos.with.include_watch).toBe(true);
  expect(rcIos.with.testflight_only).toBe(true);
  expect(rcIos.with.submit_for_review).toBe(false);
  expect(rcIos.with.distribute_testflight).toBe(true);
  expect(rcIos.with.force_appstore_upload ?? false).toBe(false);

  const ios = readIosRelease();
  expect(ios.jobs['ios-appstore'].env.MINDWTR_WATCH_ENABLED)
    .toBe("${{ inputs.include_watch && 'true' || 'false' }}");
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    expect(ios.on[trigger].inputs.include_watch.default).toBe(false);
    expect(ios.on[trigger].inputs.testflight_only.default).toBe(false);
  }
  expect(ios.on.workflow_call.outputs.app_build_number.value)
    .toBe('${{ jobs.ios-appstore.outputs.app_build_number }}');
  expect(ios.jobs['ios-appstore'].outputs.app_build_number)
    .toBe('${{ steps.ios-version.outputs.app_build_number }}');
});

test('stable Watch release keeps the existing iOS recovery selection gate', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
  const expression = workflow.jobs['ios-appstore'].if
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/always\(\)/g, 'true')
    .replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]');
  const selected = new Function('github', 'inputs', 'needs', `return Boolean(${expression})`);
  const needs = {
    validate: { result: 'success' },
    'android-version-code': { result: 'success' },
  };
  expect(selected({ event_name: 'push' }, {}, needs)).toBe(true);
  expect(selected({ event_name: 'workflow_dispatch' }, {}, needs)).toBe(false);
  const iosOnly = { run_ios_appstore: true };
  const skipped = {
    ...needs,
    'android-version-code': { result: 'skipped' },
  };
  expect(selected({ event_name: 'workflow_dispatch' }, iosOnly, skipped)).toBe(true);
  expect(selected({ event_name: 'workflow_dispatch' }, { ...iosOnly, run_android: true }, skipped)).toBe(false);
  for (const dependency of ['validate', 'android-version-code']) {
    expect(selected({ event_name: 'push' }, {}, { ...needs, [dependency]: { result: 'failure' } })).toBe(false);
  }
});

test('TestFlight-only builds reject production submission and forced App Store upload', () => {
  const steps = readIosRelease().jobs['ios-appstore'].steps;
  const gate = steps.find((step) => step.name === 'Validate iOS distribution mode');
  expect(steps.indexOf(gate)).toBeLessThan(steps.findIndex((step) => step.name === 'Import iOS distribution certificate'));
  for (const testflightOnly of [false, true]) {
    for (const review of [false, true]) {
      for (const force of [false, true]) {
        const execute = () => execFileSync('bash', ['-c', gate.run], {
          env: {
            ...process.env,
            TESTFLIGHT_ONLY: String(testflightOnly),
            REQUESTED_SUBMIT_FOR_REVIEW: String(review),
            FORCE_APPSTORE_UPLOAD: String(force),
          },
          stdio: 'pipe',
        });
        if (testflightOnly && (review || force)) expect(execute).toThrow();
        else expect(execute).not.toThrow();
      }
    }
  }
});

test('TestFlight-only route bypasses production version state and uses only pilot upload', () => {
  const steps = readIosRelease().jobs['ios-appstore'].steps;
  const route = steps.find((step) => step.name === 'Resolve App Store review submission flag');
  const temp = mkdtempSync(join(tmpdir(), 'mindwtr-watch-routing-'));
  try {
    const output = join(temp, 'env');
    execFileSync('bash', ['-c', route.run], {
      env: {
        PATH: process.env.PATH,
        GITHUB_ENV: output,
        MINDWTR_WATCH_ENABLED: 'true',
        TESTFLIGHT_ONLY: 'true',
        REQUESTED_DISTRIBUTE_TESTFLIGHT: 'true',
      },
      stdio: 'pipe',
    });
    expect(readFileSync(output, 'utf8')).toBe(
      'EFFECTIVE_SUBMIT_FOR_REVIEW=false\nSKIP_APPSTORE_UPLOAD=true\nENABLE_TESTFLIGHT_EXTERNAL_RELEASE=true\n',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const production = steps.find((step) => step.name === 'Upload IPA to App Store Connect');
  expect(production.if).toContain('!inputs.testflight_only');
  for (const name of ['Prepare Fastlane metadata', 'Prepare Fastlane screenshots']) {
    expect(steps.find((step) => step.name === name).if).toContain('!inputs.testflight_only');
  }
  const beta = steps.find((step) => step.name === 'Upload TestFlight-only IPA');
  expect(beta.if).toBe('${{ inputs.upload && inputs.testflight_only }}');
  expect(beta.run).toContain('upload_to_testflight(');
  expect(beta.run).toContain('skip_submission: true');
  expect(beta.run).toContain('skip_waiting_for_build_processing: false');
  expect(beta.run).not.toContain('deliver(');
  const distribute = steps.find((step) => step.name === 'Distribute upload to TestFlight external group');
  expect(distribute.run).toContain('build_number: ENV.fetch("APP_BUILD_NUMBER")');
  expect(distribute.run).toContain('distribute_only: true');
});

test('Watch build numbering exceeds both prior upload and ASC and fails closed', () => {
  const step = readIosRelease().jobs['ios-appstore'].steps.find((item) => item.id === 'ios-version');
  const offset = step.run.indexOf('if [ "$MINDWTR_WATCH_ENABLED" = "true" ]');
  expect(offset).toBeGreaterThan(0);
  const tail = step.run.slice(offset);
  const run = (overrides = {}) => {
    const temp = mkdtempSync(join(tmpdir(), 'mindwtr-watch-number-'));
    try {
      const output = join(temp, 'output');
      execFileSync('bash', ['-c', `set -euo pipefail\n${tail}`], {
        env: {
          ...process.env,
          MINDWTR_WATCH_ENABLED: 'true', REQUESTED_UPLOAD: 'true',
          REMOTE_LOOKUP_STATUS: 'ok', REMOTE_MAX_BUILD: '100',
          PREVIOUS_BUILD_NUMBER: '105', APP_BUILD_NUMBER_BASE: '90', APP_VERSION: '1.2.9',
          GITHUB_ENV: join(temp, 'env'), GITHUB_OUTPUT: output,
          ...overrides,
        },
        stdio: 'pipe',
      });
      return readFileSync(output, 'utf8').trim();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };
  expect(run()).toBe('app_build_number=106');
  expect(run({ REMOTE_MAX_BUILD: '110' })).toBe('app_build_number=111');
  expect(run({ APP_BUILD_NUMBER_BASE: '120' })).toBe('app_build_number=121');
  expect(run({ PREVIOUS_BUILD_NUMBER: '0' })).toBe('app_build_number=101');
  expect(run({ PREVIOUS_BUILD_NUMBER: '000108' })).toBe('app_build_number=109');
  expect(() => run({ PREVIOUS_BUILD_NUMBER: 'invalid' })).toThrow();
  expect(() => run({ REMOTE_LOOKUP_STATUS: 'api_error' })).toThrow();
  expect(() => run({ REQUESTED_UPLOAD: 'false', REMOTE_LOOKUP_STATUS: 'api_error' })).not.toThrow();
});

test('production and TestFlight-only artifact names cannot collide', () => {
  const job = readIosRelease().jobs['ios-appstore'];
  expect(job.env.IOS_ARTIFACT_VARIANT).toBe("${{ inputs.testflight_only && 'watch-testflight' || 'appstore' }}");
  const names = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
    .map((step) => step.with.name);
  expect(names.length).toBeGreaterThanOrEqual(3);
  for (const name of names) expect(name).toContain('${{ env.IOS_ARTIFACT_VARIANT }}');
  const rendered = ['appstore', 'watch-testflight'].flatMap((variant) => names.map((name) => name.replace('${{ env.IOS_ARTIFACT_VARIANT }}', variant)));
  expect(new Set(rendered).size).toBe(rendered.length);
});

test("Docker app builds receive only validated release identities", () => {
  const workflow = parse(
    readFileSync(".github/workflows/docker-image-reusable.yml", "utf8"),
  );
  const steps = workflow.jobs["build-and-push-image"].steps;
  const resolveStep = steps.find(
    (step) => step.name === "Resolve Docker release identity",
  );
  expect(resolveStep).toBeDefined();

  const resolveVersion = ({ inputTag = "", ref, refName }) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "mindwtr-docker-version-"));
    const outputPath = join(fixtureRoot, "github-output");
    try {
      execFileSync("bash", ["-c", resolveStep.run], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REF: ref,
          GITHUB_REF_NAME: refName,
          INPUT_TAG: inputTag,
        },
        stdio: "pipe",
      });
      return Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };

  expect(resolveVersion({
    inputTag: "v1.2.5",
    ref: "refs/heads/main",
    refName: "main",
  })).toEqual({ tag: "v1.2.5", version: "1.2.5" });
  expect(resolveVersion({
    ref: "refs/tags/v1.2.6-rc.3",
    refName: "v1.2.6-rc.3",
  })).toEqual({ tag: "v1.2.6-rc.3", version: "1.2.6-rc.3" });
  expect(resolveVersion({
    ref: "refs/heads/main",
    refName: "main",
  })).toEqual({ tag: "", version: "" });

  expect(() => resolveVersion({
    inputTag: "release-candidate",
    ref: "refs/heads/main",
    refName: "main",
  })).toThrow();

  const buildStep = steps.find((step) => step.name === "Build and push Docker image");
  expect(buildStep.with["build-args"]).toContain("VITE_RELEASE_VERSION");
  expect(buildStep.with["build-args"]).toContain("mindwtr-app");

  const dockerfile = readFileSync("docker/app/Dockerfile", "utf8");
  expect(dockerfile).toContain("ARG VITE_RELEASE_VERSION");
  expect(dockerfile).toContain('VITE_RELEASE_VERSION="$VITE_RELEASE_VERSION" bun desktop:web:build');
});

test("later RC app images rebuild for their embedded release identity", () => {
  const workflow = parse(
    readFileSync(".github/workflows/docker-image-reusable.yml", "utf8"),
  );
  const rcStep = workflow.jobs["build-and-push-image"].steps.find(
    (step) => step.name === "Check Docker-relevant changes since previous RC",
  );
  expect(rcStep).toBeDefined();

  const appIdentityGate = rcStep.run.indexOf(
    'if [[ "$IMAGE_SUFFIX" == "mindwtr-app" ]]; then',
  );
  const previousTagFetch = rcStep.run.indexOf("git fetch --force --tags origin");
  expect(appIdentityGate).toBeGreaterThanOrEqual(0);
  expect(appIdentityGate).toBeLessThan(previousTagFetch);
  expect(rcStep.run).toContain(
    "the embedded PWA release identity changes for every RC tag",
  );
});

test("tag-accepting release workflows queue by effective tag or shared Store flight", () => {
  const workflowDirectory = ".github/workflows";
  const effectiveTag = "${{ inputs.tag || github.ref_name }}";
  const expectedGroups = new Map([
    ["release-android-foss.yml", `release-android-foss-${effectiveTag}`],
    ["release-android.yml", `release-android-${effectiveTag}`],
    ["release-ios-appstore.yml", `release-ios-appstore-${effectiveTag}`],
    ["release-linux.yml", `release-linux-${effectiveTag}`],
    ["release-macos-appstore.yml", `release-macos-appstore-${effectiveTag}`],
    ["release-macos.yml", `release-macos-${effectiveTag}`],
    ["release-msstore-flight.yml", 'msstore-beta-flight'],
    ["release-rc.yml", `release-rc-${effectiveTag}`],
    ["release-windows.yml", `release-windows-${effectiveTag}`],
    ["release.yml", `\${{ github.workflow }}-${effectiveTag}`],
  ]);
  const tagAcceptingFiles = readdirSync(workflowDirectory)
    .filter((file) => /^release(?:-.+)?\.yml$/.test(file))
    .filter((file) => {
      const workflow = parse(
        readFileSync(join(workflowDirectory, file), "utf8"),
      );
      return Boolean(
        workflow.on?.workflow_call?.inputs?.tag ||
          workflow.on?.workflow_dispatch?.inputs?.tag,
      );
    })
    .sort();

  expect(tagAcceptingFiles).toEqual([...expectedGroups.keys()]);
  for (const file of tagAcceptingFiles) {
    const workflow = parse(
      readFileSync(join(workflowDirectory, file), "utf8"),
    );
    expect(workflow.concurrency.group).toBe(expectedGroups.get(file));
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  }
});

test("stable release validates tags and committed versions before any build or publish", () => {
  const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const validate = workflow.jobs.validate;
  const steps = validate.steps;
  const stepNames = steps.map((step) => step.name);

  expect(stepNames).toContain("Validate stable tag naming");
  expect(stepNames).toContain("Resolve and validate release notes");
  expect(stepNames).toContain("Verify app versions match the stable tag");
  expect(stepNames).toContain(
    "Verify committed FOSS release version matches the stable tag",
  );
  expect(stepNames).toContain(
    "Verify CloudKit production schema is fully deployed",
  );
  expect(stepNames).toContain("Verify stable tag points at this commit");
  expect(validate.outputs.release_notes_path).toBe(
    "${{ steps.release_notes.outputs.body_path }}",
  );

  const versionStep = steps.find(
    (step) => step.name === "Verify app versions match the stable tag",
  );
  expect(versionStep.run).toContain("apps/desktop/src-tauri/tauri.conf.json");
  expect(versionStep.run).toContain("apps/desktop/src-tauri/Cargo.toml");
  const releaseNotesStep = steps.find(
    (step) => step.name === "Resolve and validate release notes",
  );
  expect(releaseNotesStep.run).toContain("docs/release-notes/${TAG}.md");
  expect(releaseNotesStep.run).toContain("docs/release-notes/${VERSION}.md");
  expect(releaseNotesStep.run).toContain(
    '[[ "$heading" != "# Mindwtr ${VERSION}" && "$heading" != "# Mindwtr ${TAG}" ]]',
  );
  expect(releaseNotesStep.run).not.toContain('!= *"$VERSION"*');
  const fossStep = steps.find(
    (step) =>
      step.name ===
      "Verify committed FOSS release version matches the stable tag",
  );
  expect(fossStep.run).toContain("apps/mobile/release-version.json");

  const releaseSteps = workflow.jobs.release.steps;
  expect(
    releaseSteps.some((step) => step.name === "Resolve release notes"),
  ).toBe(false);
  const createReleaseStep = releaseSteps.find(
    (step) => step.name === "Create Release",
  );
  expect(createReleaseStep.env.NOTES_FILE).toBe(
    "${{ needs.validate.outputs.release_notes_path }}",
  );
  expect(createReleaseStep.run).toContain('--notes-file "$NOTES_FILE"');

  const buildJobs = [
    "linux",
    "macos",
    "windows",
    "android-version-code",
    "android",
    "android-foss",
    "ios-appstore",
    "macos-appstore",
    "release",
  ];
  for (const jobName of buildJobs) {
    expect(asNeedsList(workflow.jobs[jobName].needs)).toContain("validate");
  }

  for (const jobName of [
    "linux",
    "macos",
    "windows",
    "ios-appstore",
    "macos-appstore",
  ]) {
    const job = workflow.jobs[jobName];
    expect(asNeedsList(job.needs)).toContain("android-version-code");
    expect(job.if).toContain(
      "needs['android-version-code'].result == 'success'",
    );
    expect(job.if).toContain(
      "github.event_name == 'workflow_dispatch' && !inputs.run_android && !inputs.run_android_foss",
    );
  }

  const publishJobs = [
    "update-packages",
    "update-flathub",
    "update-flathub-beta",
    "update-linux-repos",
    "update-aur-beta-bin",
    "update-linux-repos-beta",
    "publish-chocolatey",
    "update-aur",
  ];
  for (const jobName of publishJobs) {
    const job = workflow.jobs[jobName];
    expect(asNeedsList(job.needs)).toContain("validate");
    expect(job.if).toContain("needs.validate.result == 'success'");
  }
});

test("RC tag pushes publish Android builds to Play internal and open testing", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-rc.yml", "utf8"),
  );
  const playTrack = workflow.jobs.android.with.play_track;

  expect(playTrack).toContain("'internal,beta'");
});

test("RC workflow dispatch defaults include Play open testing", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-rc.yml", "utf8"),
  );

  expect(workflow.on.workflow_dispatch.inputs.play_track.default).toBe("beta");
});

test("RC Android Play and FOSS builds share a parallel versionCode preflight", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-rc.yml", "utf8"),
  );

  expect(workflow.jobs["android-version-code"]).toBeDefined();
  expect(workflow.jobs.android.needs).toEqual([
    "validate",
    "android-version-code",
  ]);
  expect(workflow.jobs.android.with.version_code).toBe(
    "${{ needs['android-version-code'].outputs.version_code }}",
  );
  expect(workflow.jobs["android-foss"].needs).toEqual([
    "validate",
    "android-version-code",
  ]);
  expect(workflow.jobs["android-foss"].with.version_code).toBe(
    "${{ needs['android-version-code'].outputs.version_code }}",
  );
});

test("direct-download Android APK build gives R8 a release-sized heap", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-android.yml", "utf8"),
  );

  expect(workflow.jobs["build-apk"].env.GRADLE_OPTS).toContain("-Xmx6144m");
});

test("Android release centralizes Google Play edit transactions", () => {
  const text = readFileSync(".github/workflows/release-android.yml", "utf8");
  const workflow = parse(text);
  const publishSteps = workflow.jobs.publish.steps;
  const production = publishSteps.find(
    (step) => step.name === "Publish to Google Play Store (Production)",
  );

  expect(text).not.toContain("androidpublisher.googleapis.com");
  expect(text).not.toContain("curl ");
  expect(text).not.toContain("EDIT_ID");
  expect(text).not.toContain("/edits/");
  expect(text).toContain("scripts/ci/google-play-edit.py max-version-code");
  expect(text).toContain("scripts/ci/google-play-edit.py publish");
  expect(production.run).toContain('"track": "production"');
  expect(production.run).toContain('"track": "beta"');
  expect(
    production.run.match(/scripts\/ci\/google-play-edit\.py publish/g),
  ).toHaveLength(1);
  expect(
    text.match(/scripts\/ci\/google-play-edit\.py publish/g),
  ).toHaveLength(3);
  expect(
    publishSteps.some(
      (step) =>
        step.name ===
        "Publish same production versionCode to beta track (no re-upload)",
    ),
  ).toBe(false);

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  expect(packageJson.scripts["test:governance"]).toContain(
    "scripts/ci/google-play-edit.test.py",
  );
});

test("RC validation checks the committed FOSS version before platform builds start", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-rc.yml", "utf8"),
  );
  const steps = workflow.jobs.validate.steps;
  const versionCheckIndex = steps.findIndex(
    (step) =>
      step.name === "Verify committed FOSS release version matches the RC tag",
  );
  const tagCommitCheckIndex = steps.findIndex(
    (step) => step.name === "Verify RC tag points at this commit",
  );

  expect(versionCheckIndex).toBeGreaterThan(-1);
  expect(steps[versionCheckIndex].run).toContain(
    "apps/mobile/release-version.json",
  );
  expect(steps[versionCheckIndex].run).toContain("./scripts/bump-version.sh");
  expect(versionCheckIndex).toBeLessThan(tagCommitCheckIndex);
});

test("existing RC releases stay immutable while dispatch can retry beta channels", () => {
  const text = readFileSync(".github/workflows/release-rc.yml", "utf8");
  const workflow = parse(text);
  const validate = workflow.jobs.validate;
  const detectStep = validate.steps.find(
    (step) => step.name === "Detect existing RC release",
  );

  expect(validate.outputs.existing_release).toBe(
    "${{ steps.existing_release.outputs.exists }}",
  );
  expect(detectStep).toBeDefined();
  expect(detectStep.run).toContain('gh release view "$TAG"');
  expect(detectStep.run).not.toContain('if [ "$EVENT_NAME" != "push" ]');

  for (const jobName of [
    "linux",
    "macos",
    "windows",
    "android-version-code",
    "android",
    "android-foss",
    "ios-appstore",
    "macos-appstore",
    "prerelease",
  ]) {
    expect(workflow.jobs[jobName].if).toContain(
      "needs.validate.outputs.existing_release != 'true'",
    );
  }

  const createStep = workflow.jobs.prerelease.steps.find(
    (step) => step.name === "Create GitHub prerelease",
  );
  expect(createStep.run).toContain('gh release create "$TAG"');
  expect(createStep.run).not.toContain("gh release edit");
  expect(createStep.run).not.toContain("gh release upload");
  expect(text).not.toContain("--clobber");

  for (const jobName of ["flathub-beta", "aur-beta", "linux-repos-beta"]) {
    const condition = workflow.jobs[jobName].if;
    expect(condition).toContain("needs.prerelease.result == 'success'");
    expect(condition).toContain(
      "needs.validate.outputs.existing_release == 'true'",
    );
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
  }
});

test("Windows release signs and publishes exactly the current NSIS installer", () => {
  const windowsText = readFileSync(
    ".github/workflows/release-windows.yml",
    "utf8",
  );
  const windows = parse(windowsText);
  const steps = windows.jobs.standalone.steps;
  const bundleStep = steps.find((step) => step.name === "Bundle installer");
  const stageExeStep = steps.find(
    (step) => step.name === "Stage unsigned app binary for signing",
  );
  const resolveStep = steps.find(
    (step) => step.name === "Resolve current NSIS installer",
  );
  const stageStep = steps.find(
    (step) => step.name === "Stage unsigned installer for signing",
  );
  const applyStep = steps.find(
    (step) => step.name === "Apply and verify signed installer",
  );
  const collectStep = steps.find(
    (step) => step.name === "Collect Windows artifacts",
  );

  expect(bundleStep.run).toContain(
    'Remove-Item -Recurse -Force "$bundleDir"',
  );
  expect(bundleStep.run.indexOf("Remove-Item")).toBeLessThan(
    bundleStep.run.indexOf("bunx tauri bundle"),
  );
  expect(stageExeStep.if).toContain(
    "vars.SIGNPATH_SIGNING_ENABLED == 'true'",
  );
  expect(resolveStep).toBeDefined();
  expect(resolveStep.run).toContain("tauri.conf.json");
  expect(resolveStep.run).toContain("$tauriConfig.productName");
  expect(resolveStep.run).toContain(
    '"${productName}_${baseVersion}_x64-setup.exe"',
  );
  expect(resolveStep.run).toContain("$installers.Count -ne 1");
  expect(resolveStep.run).toContain("$installer.FullName -ne $expectedPath");

  const installerOutput =
    "${{ steps.current-installer.outputs.installer_path }}";
  expect(stageStep.run).toContain(installerOutput);
  expect(applyStep.run).toContain(installerOutput);
  expect(collectStep.run).toContain(installerOutput);
  expect(stageStep.run).not.toContain("Select-Object -First 1");
  expect(collectStep.run).not.toContain(
    'Get-ChildItem "apps/desktop/src-tauri/target/release/bundle/nsis/*.exe"',
  );

  const stable = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const validateAssets = stable.jobs.release.steps.find(
    (step) => step.name === "Validate release assets",
  );
  expect(validateAssets.run).toContain(
    'expected_windows_installer="./release-assets/mindwtr_${VERSION}_x64-setup.exe"',
  );
  expect(validateAssets.run).toContain(
    "${windows_installers[@]}",
  );
  expect(validateAssets.run).toContain(
    '"${#windows_installers[@]}" -ne 1',
  );
});

// T5: the two SignPath submissions are scheduled to change (migration to two
// single-file submissions). Pin both artifact-configuration slugs and the full
// outcome chain so an edit to either can't silently start signing/uploading the
// wrong artifact, or run a downstream step whose staging step never succeeded.
// There are two chains, not one: the app-exe chain gates on stage-unsigned-exe;
// the installer chain gates on stage-unsigned-installer, which itself only
// stages once stage-unsigned-exe succeeded — that link is what actually
// prevents the installer from signing/uploading when the app binary wasn't.
test("Windows release retries a failed Bun install after clearing its package cache", () => {
  const windows = parse(
    readFileSync(".github/workflows/release-windows.yml", "utf8"),
  );
  const install = windows.jobs.standalone.steps.find(
    (step) => step.name === "Install dependencies",
  );

  expect(install).toBeDefined();
  expect(install.shell).toBe("pwsh");
  expect(install.run.match(/bun install --frozen-lockfile/g)).toHaveLength(2);
  expect(install.run).toContain("bun pm cache rm");
  expect(install.run).toContain("bun pm cache clean");
  expect(install.run).toContain("exit $LASTEXITCODE");
});

test("Windows release SignPath submissions are gated end to end and target the pinned slugs", () => {
  const windows = parse(
    readFileSync(".github/workflows/release-windows.yml", "utf8"),
  );
  const steps = windows.jobs.standalone.steps;
  const find = (name) => {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step).toBeDefined();
    return step;
  };

  const stageExeOutcome = "steps.stage-unsigned-exe.outcome == 'success'";
  const stageInstallerOutcome =
    "steps.stage-unsigned-installer.outcome == 'success'";

  const uploadExeStep = find("Upload unsigned app binary");
  const submitExeStep = find(
    "Submit SignPath signing request for the app binary",
  );
  const applyExeStep = find("Apply signed app binary");
  for (const step of [uploadExeStep, submitExeStep, applyExeStep]) {
    expect(step.if).toContain(stageExeOutcome);
  }
  expect(submitExeStep.with["artifact-configuration-slug"]).toBe("initial");

  const stageInstallerStep = find("Stage unsigned installer for signing");
  expect(stageInstallerStep.if).toContain(stageExeOutcome);

  const uploadInstallerStep = find("Upload unsigned installer");
  const submitInstallerStep = find(
    "Submit SignPath signing request for the installer",
  );
  const applyInstallerStep = find("Apply and verify signed installer");
  for (const step of [
    uploadInstallerStep,
    submitInstallerStep,
    applyInstallerStep,
  ]) {
    expect(step.if).toContain(stageInstallerOutcome);
  }
  expect(submitInstallerStep.with["artifact-configuration-slug"]).toBe(
    "windows-installer",
  );
});

test("stable and RC releases sign and verify the checksum manifest", () => {
  const stable = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const rc = parse(readFileSync(".github/workflows/release-rc.yml", "utf8"));

  for (const [job, validateStepName] of [
    [stable.jobs.release, "Validate release assets"],
    [rc.jobs.prerelease, "Validate RC assets"],
  ]) {
    expect(
      job.steps.some(
        (step) => step.name === "Import Mindwtr release signing key",
      ),
    ).toBe(true);
    const validateStep = job.steps.find(
      (step) => step.name === validateStepName,
    );
    expect(validateStep.run).toContain("SHA256SUMS.asc");
    expect(validateStep.run).toContain(
      "gpg --batch --verify SHA256SUMS.asc SHA256SUMS",
    );
  }
});

test("update-aur and update-aur-beta publish directly with a pre-push ownership audit", () => {
  const stableText = readFileSync(".github/workflows/release.yml", "utf8");
  const rcText = readFileSync(".github/workflows/release-rc.yml", "utf8");
  const betaText = readFileSync(
    ".github/workflows/update-aur-beta.yml",
    "utf8",
  );
  const stable = parse(stableText);
  const rc = parse(rcText);
  const beta = parse(betaText);

  // Direct publishers need the SSH credential; nothing here force-pushes AUR.
  expect(stableText).toContain("AUR_SSH_PRIVATE_KEY");
  expect(betaText).toContain("AUR_SSH_PRIVATE_KEY");

  // Host key must be pinned to the known AUR fingerprint, not TOFU-trusted.
  const pinnedFingerprint = "SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4";
  expect(stableText).toContain(pinnedFingerprint);
  expect(betaText).toContain(pinnedFingerprint);
  const noForcePush = /git push[^\n]*(--force|-f\b)/;
  expect(stableText).not.toMatch(noForcePush);
  expect(rcText).not.toMatch(noForcePush);
  expect(betaText).not.toMatch(noForcePush);

  for (const jobName of ["update-aur", "update-aur-beta"]) {
    const steps =
      jobName === "update-aur-beta"
        ? beta.jobs["update-aur-beta"].steps
        : stable.jobs[jobName].steps;
    const auditIndex = steps.findIndex(
      (step) => step.name === "Verify AUR package ownership before push",
    );
    const validateIndex = steps.findIndex(
      (step) => step.name === "Validate AUR package contents",
    );
    const pushIndex = steps.findIndex((step) =>
      step.name.startsWith("Commit and push"),
    );
    expect(auditIndex).toBeGreaterThan(-1);
    expect(validateIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(auditIndex);
    expect(pushIndex).toBeGreaterThan(validateIndex);
    expect(
      steps.some((step) => step.name === "Prepare immutable AUR proposal"),
    ).toBe(false);
  }

  expect(stable.jobs["update-aur-beta-bin"].name).toContain(
    "Update AUR Beta",
  );
  expect(stable.jobs["update-aur-beta-bin"].secrets).toBe("inherit");
  expect(rc.jobs["aur-beta"].name).toContain("Update AUR Beta");
  expect(rc.jobs["aur-beta"].secrets).toBe("inherit");

  // Beta is dispatchable standalone, not gated behind the reviewed environment.
  expect(beta.on.workflow_dispatch.inputs.tag.required).toBe(true);
  expect(beta.jobs["update-aur-beta"].environment).toBeUndefined();
  expect(betaText).toContain("mindwtr-beta-bin");
  expect(
    beta.jobs["update-aur-beta"].strategy.matrix.include.map(
      (entry) => entry.package,
    ),
  ).toEqual(["mindwtr-beta-bin"]);
  const betaSteps = beta.jobs["update-aur-beta"].steps;
  const betaClone = betaSteps.find(
    (step) => step.name === "Clone existing AUR beta repo",
  );
  const betaAudit = betaSteps.find(
    (step) => step.name === "Verify AUR package ownership before push",
  );
  const betaPublishedAudit = betaSteps.find(
    (step) => step.name === "Verify published AUR package",
  );
  expect(betaClone).toBeDefined();
  expect(betaClone.run).toContain("rev-parse --verify HEAD");
  expect(betaClone.run).toContain("exit 1");
  expect(betaAudit.run).toContain("node scripts/ci/audit-aur-state.mjs");
  expect(betaAudit.run).not.toContain("del(.packages");
  expect(betaPublishedAudit.if).toContain("steps.publish.outputs.status == 'published'");
  expect(betaPublishedAudit.run).toContain("audit-aur-state.mjs");
  expect(betaPublishedAudit.run).toContain("REMOTE_HEAD");

  const canonicalTemplate = readFileSync(
    "aur/PKGBUILD-beta-bin.template",
    "utf8",
  );
  expect(canonicalTemplate).toContain("pkgname=mindwtr-beta-bin");
  expect(canonicalTemplate).toContain("replaces=('mindwtr-bin-beta')");

  const trustedPackages = JSON.parse(
    readFileSync("aur/trusted-packages.json", "utf8"),
  ).packages;
  expect(trustedPackages["mindwtr-beta-bin"]).toBeDefined();
  expect(trustedPackages["mindwtr-bin-beta"]).toBeUndefined();

  const aurDocs = readFileSync("aur/README.md", "utf8");
  expect(aurDocs).toContain("pacman -R mindwtr-bin-beta");
  expect(aurDocs).toContain("AUR helpers do not reliably migrate package identities");
});
