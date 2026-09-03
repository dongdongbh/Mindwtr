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
