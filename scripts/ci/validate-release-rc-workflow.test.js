import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const asNeedsList = (needs) => (Array.isArray(needs) ? needs : [needs]);

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

  const publishJobs = [
    "update-packages",
    "update-flathub",
    "update-flathub-beta",
    "update-linux-repos",
    "update-aur-beta-bin",
    "update-linux-repos-beta",
    "publish-chocolatey",
    "update-aur",
    "update-aur-source",
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

  // mindwtr (the source package) publishes directly too now that dongdongbh
  // co-maintains it: same validate/audit gates before the push, and the exact
  // published tree is still uploaded under the artifact name the manual
  // publish-aur.yml fallback consumes.
  const sourceSteps = stable.jobs["update-aur-source"].steps;
  const sourceValidateIndex = sourceSteps.findIndex(
    (step) => step.name === "Validate AUR package contents",
  );
  const sourceAuditIndex = sourceSteps.findIndex(
    (step) => step.name === "Verify AUR package ownership before push",
  );
  const sourceRecordIndex = sourceSteps.findIndex(
    (step) => step.name === "Preserve exact published tree as an artifact",
  );
  const sourcePushIndex = sourceSteps.findIndex((step) =>
    step.name.startsWith("Commit and push"),
  );
  expect(sourceValidateIndex).toBeGreaterThan(-1);
  expect(sourceAuditIndex).toBeGreaterThan(-1);
  expect(sourceRecordIndex).toBeGreaterThan(-1);
  expect(sourcePushIndex).toBeGreaterThan(sourceValidateIndex);
  expect(sourcePushIndex).toBeGreaterThan(sourceAuditIndex);
  expect(sourcePushIndex).toBeGreaterThan(sourceRecordIndex);
  const sourceCleanBuildIndex = sourceSteps.findIndex(
    (step) => step.name === "Validate source package build (clean container)",
  );
  expect(sourceCleanBuildIndex).toBeGreaterThan(sourceValidateIndex);
  expect(stableText).toContain("aur-proposal-mindwtr-");
  const bunLockGenerationStep = sourceSteps.find(
    (step) => step.name === "Generate frozen Bun lockfile for AUR",
  );
  expect(bunLockGenerationStep).toBeDefined();
  expect(bunLockGenerationStep.run).toContain("bun install --lockfile-only");
  expect(bunLockGenerationStep.run).toContain("--no-cache");
  expect(bunLockGenerationStep.run).toContain(
    "--registry=https://registry.npmjs.org",
  );
  expect(bunLockGenerationStep.run).toContain("aur-mindwtr/bun.lock");

  const bunCompatibilityStep = sourceSteps.find(
    (step) => step.name === "Use frozen Bun lockfile",
  );
  expect(bunCompatibilityStep).toBeDefined();
  expect(bunCompatibilityStep.run).toContain('cp "$srcdir/bun.lock" bun.lock');
  expect(bunCompatibilityStep.run).toContain("bun install --frozen-lockfile");
  expect(bunCompatibilityStep.run).toContain(
    "--registry=https://registry.npmjs.org",
  );
  expect(bunCompatibilityStep.run).not.toContain("bun install --no-save");
  expect(bunCompatibilityStep.run).not.toContain("--force");
  const sourcePushStep = sourceSteps.find((step) =>
    step.name.startsWith("Commit and push"),
  );
  expect(sourcePushStep.run).toContain(
    "PKGBUILD .SRCINFO bun.lock tauri-v2-schema.patch",
  );
  expect(sourcePushStep.run).toContain("git add PKGBUILD .SRCINFO bun.lock");

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
  expect(betaText).not.toContain("mindwtr-bin-beta");
  const betaSteps = beta.jobs["update-aur-beta"].steps;
  const betaClone = betaSteps.find(
    (step) => step.name === "Clone or initialize AUR beta repo",
  );
  const betaAudit = betaSteps.find(
    (step) => step.name === "Verify AUR package ownership before push",
  );
  const betaCreationAudit = betaSteps.find(
    (step) => step.name === "Verify newly created AUR package",
  );
  expect(betaClone.id).toBe("beta_repo");
  expect(betaClone.run).toContain("rev-parse --verify HEAD");
  expect(betaAudit.run).toContain('del(.packages["mindwtr-beta-bin"])');
  expect(betaCreationAudit.if).toContain("steps.beta_repo.outputs.initialized");
  expect(betaCreationAudit.run).toContain("audit-aur-state.mjs");
  expect(betaCreationAudit.run).toContain("REMOTE_HEAD");
  expect(betaCreationAudit.run).toContain("AUR RPC has not indexed");
});

test("AUR publication is a manual environment-gated recovery workflow", () => {
  const text = readFileSync(".github/workflows/publish-aur.yml", "utf8");
  const workflow = parse(text);
  const publish = workflow.jobs.publish;

  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(publish.environment).toBe("aur-publish");
  expect(text).toContain("audit-aur-state.mjs --compare");
  expect(text).toContain("AUR is down due to maintenance");
  expect(text).toContain("status=delayed");
  expect(text).toContain("git -C aur-live push origin HEAD:master");
  expect(text).toContain("SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4");
  expect(text).toContain("SOURCE_EVENT");
  expect(text).toContain("proposal/bun.lock");
  expect(text).toContain("PKGBUILD .SRCINFO bun.lock tauri-v2-schema.patch");
  expect(text).toContain("git -C aur-live add -- bun.lock");
  expect(text).not.toContain("--force");
});
