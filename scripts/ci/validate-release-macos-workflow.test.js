import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/release-macos.yml";

const loadSteps = () => {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));
  return workflow.jobs.macos.steps;
};

// Strips shell comment lines so assertions check actual invocations, not
// prose explaining why a command is deliberately absent (e.g. a comment
// that mentions `tauri bundle` while explaining that it must not run).
const withoutShellComments = (run) =>
  (run || "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

test("nothing after the widget embed step re-invokes tauri bundle/build (#1054)", () => {
  const steps = loadSteps();
  const widgetIndex = steps.findIndex(
    (step) => step.name === "Build and embed macOS widget",
  );
  expect(widgetIndex).toBeGreaterThanOrEqual(0);

  const stepsAfterWidget = steps.slice(widgetIndex + 1);
  expect(stepsAfterWidget.length).toBeGreaterThan(0);

  for (const step of stepsAfterWidget) {
    const run = withoutShellComments(step.run);
    expect(run).not.toMatch(/\btauri\s+bundle\b/);
    expect(run).not.toMatch(/\btauri\s+build\b/);
  }
});

test("the DMG is verified to contain the widget before notarization", () => {
  const steps = loadSteps();
  const dmgIndex = steps.findIndex((step) => step.name === "Bundle macOS DMG");
  const verifyIndex = steps.findIndex(
    (step) => step.name === "Verify DMG contains the widget",
  );
  const notarizeIndex = steps.findIndex((step) => step.name === "Notarize DMG");

  expect(dmgIndex).toBeGreaterThanOrEqual(0);
  expect(verifyIndex).toBeGreaterThan(dmgIndex);
  expect(notarizeIndex).toBeGreaterThan(verifyIndex);

  const verifyStep = steps[verifyIndex];
  // Gated the same way as the widget embed step: unsigned builds never embed
  // a widget, so there is nothing for this step to verify either.
  expect(verifyStep.if).toBe("env.APPLE_SIGNING_IDENTITY != ''");
  expect(verifyStep.run).toContain(
    "Contents/PlugIns/MindwtrWidgets.appex/Contents/MacOS/MindwtrWidgets",
  );
  expect(verifyStep.run).toContain("hdiutil attach");
  expect(verifyStep.run).toContain("hdiutil detach");
  expect(verifyStep.run).toContain("codesign --verify --deep --strict");
});

test("the DMG step builds the DMG by hand instead of via tauri bundle", () => {
  const steps = loadSteps();
  const dmgStep = steps.find((step) => step.name === "Bundle macOS DMG");
  expect(dmgStep).toBeDefined();
  expect(dmgStep.run).toContain("scripts/build-macos-dmg.sh");
  expect(withoutShellComments(dmgStep.run)).not.toMatch(/\btauri\s+bundle\b/);
});

test("the temporary keychain password is masked before it reaches GITHUB_ENV", () => {
  const steps = loadSteps();
  const certStep = steps.find(
    (step) => step.name === "Import Developer ID certificate",
  );
  expect(certStep).toBeDefined();

  const run = certStep.run;
  const maskIndex = run.indexOf('echo "::add-mask::$KEYCHAIN_PASSWORD"');
  const exportIndex = run.indexOf('echo "KEYCHAIN_PASSWORD=$KEYCHAIN_PASSWORD" >> "$GITHUB_ENV"');
  expect(maskIndex).toBeGreaterThanOrEqual(0);
  expect(exportIndex).toBeGreaterThan(maskIndex);
});

// --- Mac App Store workflow (#1054) ----------------------------------------
// The App Store .pkg only carries the widget when the optional
// MAS_WIDGET_PROVISIONING_PROFILE secret is present; these tests pin the step
// order and gating so the widget can neither be dropped by a later Tauri
// re-bundle nor break a build that has no profile configured.

const APPSTORE_WORKFLOW_PATH = ".github/workflows/release-macos-appstore.yml";
const WIDGET_GATE = "env.HAS_MAS_WIDGET_PROFILE == '1'";

const loadAppStoreSteps = () => {
  const workflow = parse(readFileSync(APPSTORE_WORKFLOW_PATH, "utf8"));
  return workflow.jobs["macos-appstore"].steps;
};

test("App Store: the widget embed step sits between the app build and the installer, gated on the widget profile", () => {
  const steps = loadAppStoreSteps();
  const buildIndex = steps.findIndex(
    (step) => step.name === "Build signed macOS app bundle (App Store)",
  );
  const embedIndex = steps.findIndex(
    (step) => step.name === "Build and embed macOS widget (App Store)",
  );
  const installerIndex = steps.findIndex(
    (step) => step.name === "Build signed installer package",
  );

  expect(buildIndex).toBeGreaterThanOrEqual(0);
  expect(embedIndex).toBeGreaterThan(buildIndex);
  expect(installerIndex).toBeGreaterThan(embedIndex);

  const embedStep = steps[embedIndex];
  expect(embedStep.if).toBe(WIDGET_GATE);
  expect(embedStep.run).toContain("MINDWTR_WIDGET_DISTRIBUTION=appstore");
  expect(embedStep.run).toContain("scripts/build-macos-widget.sh");
  expect(embedStep.run).toContain("universal-apple-darwin");
  expect(embedStep.env.MAS_WIDGET_PROVISIONING_PROFILE).toBe(
    "${{ secrets.MAS_WIDGET_PROVISIONING_PROFILE }}",
  );
  expect(embedStep.env.APPLE_TEAM_ID).toBe("${{ secrets.APPLE_TEAM_ID }}");
  expect(embedStep.env.MAS_SIGNING_IDENTITY).toBe(
    "${{ secrets.MAS_SIGNING_IDENTITY }}",
  );
});

test("App Store: the widget is verified in the signed app before the installer is built", () => {
  const steps = loadAppStoreSteps();
  const embedIndex = steps.findIndex(
    (step) => step.name === "Build and embed macOS widget (App Store)",
  );
  const verifyIndex = steps.findIndex(
    (step) => step.name === "Verify App Store app contains the widget",
  );
  const installerIndex = steps.findIndex(
    (step) => step.name === "Build signed installer package",
  );

  expect(verifyIndex).toBe(embedIndex + 1);
  expect(installerIndex).toBeGreaterThan(verifyIndex);

  const verifyStep = steps[verifyIndex];
  expect(verifyStep.if).toBe(WIDGET_GATE);
  expect(verifyStep.run).toContain(
    "Contents/PlugIns/MindwtrWidgets.appex",
  );
  expect(verifyStep.run).toContain("Contents/MacOS/MindwtrWidgets");
  expect(verifyStep.run).toContain("Contents/embedded.provisionprofile");
  expect(verifyStep.run).toContain("codesign --verify --deep --strict --verbose=4");
  expect(verifyStep.run).toContain("codesign -d --entitlements :-");
  expect(verifyStep.run).toContain('"Host app" "<string>${APP_GROUP}</string>"');
  expect(verifyStep.run).toContain('"Widget appex" "<string>${APP_GROUP}</string>"');
  expect(verifyStep.run).toContain("com.apple.security.app-sandbox");
  expect(verifyStep.run).toContain(
    "tech.dongdongbh.mindwtr.MindwtrWidgets</string>",
  );
});

test("App Store: nothing after the widget embed step re-invokes tauri bundle/build (#1054)", () => {
  const steps = loadAppStoreSteps();
  const embedIndex = steps.findIndex(
    (step) => step.name === "Build and embed macOS widget (App Store)",
  );
  expect(embedIndex).toBeGreaterThanOrEqual(0);

  const stepsAfterEmbed = steps.slice(embedIndex + 1);
  expect(stepsAfterEmbed.length).toBeGreaterThan(0);

  for (const step of stepsAfterEmbed) {
    const run = withoutShellComments(step.run);
    expect(run).not.toMatch(/\btauri\s+bundle\b/);
    expect(run).not.toMatch(/\btauri\s+build\b/);
  }
});

test("App Store: the App Group is only baked into the binary, and kept in the host entitlements, when the widget ships", () => {
  const steps = loadAppStoreSteps();
  const validateStep = steps.find(
    (step) => step.name === "Validate required secrets",
  );
  expect(validateStep.env.MAS_WIDGET_PROVISIONING_PROFILE).toBe(
    "${{ secrets.MAS_WIDGET_PROVISIONING_PROFILE }}",
  );
  expect(validateStep.run).toContain('echo "HAS_MAS_WIDGET_PROFILE=1" >> "$GITHUB_ENV"');
  expect(validateStep.run).toContain('echo "HAS_MAS_WIDGET_PROFILE=0" >> "$GITHUB_ENV"');
  expect(validateStep.run).toContain("ships without the macOS widget");

  const buildStep = steps.find(
    (step) => step.name === "Build signed macOS app bundle (App Store)",
  );
  expect(buildStep.env.APPLE_TEAM_ID).toBe(
    "${{ env.HAS_MAS_WIDGET_PROFILE == '1' && secrets.APPLE_TEAM_ID || '' }}",
  );

  const dropIndex = steps.findIndex(
    (step) => step.name === "Drop the widget App Group from App Store entitlements",
  );
  const buildIndex = steps.indexOf(buildStep);
  expect(dropIndex).toBeGreaterThanOrEqual(0);
  expect(dropIndex).toBeLessThan(buildIndex);
  expect(steps[dropIndex].if).toBe("env.HAS_MAS_WIDGET_PROFILE != '1'");
  expect(steps[dropIndex].run).toContain("com.apple.security.application-groups");
});
