import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

test("native CI generates clean projects and compiles Android and iOS sources", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const androidJob = workflow.match(
    /\n  android-native:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];
  const iosJob = workflow.match(
    /\n  ios-native:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];

  expect(workflow).toContain('apps/mobile/modules/**/android/**');
  expect(workflow.match(/- "apps\/android-native\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "packages\/core\/package\.json"/g)).toHaveLength(2);
  expect(workflow).toContain('android_client: ${{ steps.filter.outputs.android_client }}');
  expect(workflow).toContain('apps/android-native/*|apps/mobile/modules/sync-file-lock/*|apps/mobile/modules/sync-file-transition-cas/*|packages/core/src/*|packages/core/package.json|');
  // The native app builds RN's File Sync lock C++ (S5): its job installs the NDK and CMake and checks the packaged JNI.
  expect(workflow).toContain('ndk;27.1.12297006 cmake;3.22.1');
  expect(workflow).toContain('name: Verify the native app\'s File Sync lock JNI');
  const clientJob = parse(workflow).jobs['android-client'];
  expect(clientJob.if).toContain("needs.changes.outputs.android_client == 'true'");
  expect(clientJob.steps.find((step) => step.name === 'Build Android Compose client')).toMatchObject({
    'working-directory': 'apps/android-native/android',
    run: './gradlew :app:assembleDebug :app:checkVariantIdentity --no-daemon',
  });
  expect(workflow).toContain('apps/mobile/modules/**/ios/**');
  expect(
    workflow.match(/- "apps\/mobile\/modules\/\*\*\/expo-module\.config\.json"/g),
  ).toHaveLength(2);
  // The maintained iOS sources live outside the gitignored generated ios/
  // project, so the triggers must name them directly or edits skip CI.
  expect(workflow.match(/- "apps\/mobile\/ios-app-intents\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "apps\/mobile\/widgets-ios\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "scripts\/ci\/setup-ruby\.sh"/g)).toHaveLength(2);
  expect(workflow).toContain("ios: ${{ steps.filter.outputs.ios }}");
  expect(workflow).toMatch(/apps\/mobile\/ios-app-intents\/\*\|apps\/mobile\/widgets-ios\/\*\|[^\n]*scripts\/ci\/setup-ruby\.sh\|/);
  expect(workflow).toMatch(
    /apps\/mobile\/modules\/\*\/android\/\*\|apps\/mobile\/modules\/\*\/expo-module\.config\.json\|/,
  );
  expect(workflow).toMatch(
    /apps\/mobile\/modules\/\*\/ios\/\*\|apps\/mobile\/modules\/\*\/expo-module\.config\.json\|/,
  );
  // The generated projects are gitignored; filters on them never match a
  // committed diff and only feign coverage.
  expect(workflow).not.toContain("apps/mobile/ios/**");
  expect(workflow).not.toContain("apps/mobile/android/**");

  expect(workflow).toContain("Generate Android native project");
  expect(workflow).toMatch(/prebuild \\\n\s+--clean \\\n\s+--platform android/);
  expect(workflow).toContain(":app:compileDebugKotlin");
  expect(androidJob).toContain("name: Run Android compatibility-lock process regression");
  expect(androidJob).toContain("file_compat_lock_test.cpp");
  expect(androidJob).toContain("name: Run Android exact-directory retirement regression");
  expect(androidJob).toContain("exact_directory_retirement.cpp");
  expect(androidJob).toContain("exact_directory_retirement_test.cpp");
  expect(androidJob).toContain(":attachment-file-installer:assembleDebug");
  expect(androidJob).toContain(":sync-file-lock:assembleDebug");
  expect(androidJob).toContain("name: Verify packaged Android lock JNI symbols");
  expect(androidJob).toContain("jni/arm64-v8a/libsync-file-lock.so");
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_syncfilelock_StableRootLockNative_tryLock",
  );
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_syncfilelock_StableRootLockNative_tryOfdLock",
  );
  expect(androidJob).toContain("name: Verify packaged Android attachment JNI symbols");
  expect(androidJob).toContain("jni/arm64-v8a/libattachment-file-installer.so");
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_attachmentfileinstaller_ExactAttachmentPublisherNative_publishRelativeNoReplace",
  );
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_attachmentfileinstaller_ExactAttachmentPublisherNative_retireEmptyDirectoryIfIdentity",
  );
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_attachmentfileinstaller_ExactAttachmentPublisherNative_retireReservedPrivateStage",
  );
  expect(androidJob).toContain("name: Run Android native recovery and system bar tests");
  expect(androidJob).toContain(":attachment-file-installer:testDebugUnitTest");
  expect(androidJob).toContain(":sync-file-lock:testDebugUnitTest");
  expect(androidJob).toContain(":sync-file-transition-cas:testDebugUnitTest");
  expect(androidJob).toContain(":system-bars:testDebugUnitTest");

  expect(workflow).toContain("name: iOS Swift compile");
  expect(workflow).toContain("gem install cocoapods --version 1.16.2 --no-document");
  expect(workflow).toMatch(/prebuild \\\n\s+--clean \\\n\s+--platform ios/);
  const hostCompile = parse(workflow).jobs["ios-native"].steps
    .find((step) => step.name === "Build bundled Release app for the iOS 27 simulator").run;
  expect(hostCompile).not.toContain("-sdk iphonesimulator");
  expect(iosJob).toContain("-target MindwtrWatch");
  expect(iosJob).toContain("-sdk watchsimulator");
  expect(iosJob).toContain('MINDWTR_WATCH_ENABLED: "true"');
  expect(iosJob).toContain("swift test --package-path apps/mobile/modules/watch-connectivity");
  expect(iosJob).toContain("swift test --package-path apps/mobile/modules/ios-widget");
  expect(workflow.match(/- "apps\/mobile\/modules\/ios-widget\/Package\.swift"/g)).toHaveLength(2);
  expect(workflow.match(/- "apps\/mobile\/modules\/ios-widget\/tests\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "apps\/mobile\/modules\/ios-scene-lifecycle\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "apps\/mobile\/modules\/ios-siri-actions\/\*\*"/g)).toHaveLength(2);
  expect(workflow).toContain("apps/mobile/modules/ios-siri-actions/*|");
  expect(iosJob).toContain("swift test --package-path apps/mobile/modules/ios-siri-actions");
  expect(workflow.match(/- "apps\/mobile\/hooks\/use-ios-scene-diagnostics\.ts"/g)).toHaveLength(2);
  expect(workflow).toContain("apps/mobile/modules/ios-widget/Package.swift|apps/mobile/modules/ios-widget/tests/*|");
  const widgetActionStore = readFileSync("apps/mobile/modules/ios-widget/ios/MindwtrWidgetActionStore.swift", "utf8");
  expect(widgetActionStore).not.toContain("Darwin.flock(");
  expect(widgetActionStore).not.toContain("Glibc.flock(");
  expect(widgetActionStore).toContain("func cancel(id: String) throws -> Bool");
  expect(iosJob).toContain("name: Run Watch outbox retry tests");
  expect(iosJob).toContain("swift test --package-path apps/mobile/targets/watch");
  expect(iosJob).toContain("name: Validate generated Watch Xcode project");
  expect(iosJob).toContain("name: Typecheck Watch receiver against the iOS SDK");
  expect(iosJob).toContain("apps/mobile/modules/watch-connectivity/ios/MindwtrWatchConnectivityReceiver.swift");
  expect(workflow).toContain("CODE_SIGNING_ALLOWED=NO");
  expect(iosJob).toContain("name: Run attachment installer Swift recovery tests");
  expect(iosJob).toContain(
    "swift test --package-path apps/mobile/modules/attachment-file-installer/ios",
  );
  expect(iosJob).toContain("name: Run File Sync stable-lock Swift tests");
  expect(iosJob).toContain(
    "swift test --package-path apps/mobile/modules/sync-file-lock/ios",
  );
  expect(iosJob).toContain("name: Run CloudKit attachment error classifier tests");
  expect(iosJob).toContain(
    "swift test --package-path apps/mobile/modules/cloudkit-sync",
  );
  expect(
    workflow.match(/- "apps\/mobile\/modules\/cloudkit-sync\/Package\.swift"/g),
  ).toHaveLength(2);
  expect(
    workflow.match(/- "apps\/mobile\/modules\/cloudkit-sync\/tests\/\*\*"/g),
  ).toHaveLength(2);
  expect(workflow).toMatch(
    /apps\/mobile\/modules\/cloudkit-sync\/Package\.swift\|apps\/mobile\/modules\/cloudkit-sync\/tests\/\*\|/,
  );
});

test("native CI uses one Xcode 27 lane and retains Apple validation coverage", () => {
  const workflowText = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const workflow = parse(workflowText);
  const job = workflow.jobs["ios-native"];
  const lanes = Object.fromEntries(
    appleRouting(false, false).matrix.include.map((entry) => [entry.lane, entry]),
  );

  expect(job.strategy["fail-fast"]).toBe(false);
  expect(Object.keys(lanes)).toEqual(["xcode27"]);
  expect(lanes.xcode27.runner).toBe("xcode-27");
  expect(workflow.on.push.branches).toContain("fix/ios27-1193");

  const generation = job.steps.find((step) => step.name === "Generate iOS native project");
  expect(generation.env.CI).toBe("1");
  expect(generation.run).toMatch(/prebuild \\\n\s+--clean \\\n\s+--platform ios/);
  expect(job.steps.find((step) => step.name === "Validate generated iOS scene lifecycle").run)
    .toContain("validate-ios-scene-lifecycle.js apps/mobile/ios");

  const environment = job.steps.find((step) => step.name === "Capture and validate Xcode 27 environment");
  expect(environment.if).toContain("matrix.lane == 'xcode27'");
  expect(environment.run).toContain("collect-ios27-environment.sh");

  const selectSimulator = job.steps.find((step) => step.name === "Select an available iOS 27 simulator");
  expect(selectSimulator.if).toContain("matrix.lane == 'xcode27'");
  expect(selectSimulator.run).toContain("select-ios27-simulator.sh");

  for (const stepName of [
    "Typecheck iOS widgets at the minimum deployment target",
    "Typecheck Watch receiver against the iOS SDK",
    "Run attachment installer Swift recovery tests",
    "Run File Sync stable-lock Swift tests",
    "Run CloudKit attachment error classifier tests",
    "Run Watch payload and receipt recovery tests",
    "Test iOS widget durable action queue",
    "Test iOS Siri durable action transport",
    "Run Watch outbox retry tests",
  ]) {
    const step = job.steps.find((step) => step.name === stepName);
    expect(step).toBeDefined();
    expect(step.if).toBeUndefined();
  }

  expect(job.steps.find((step) => step.name === "Compile Watch app and complications").if)
    .toBeUndefined();
  expect(job.steps.find((step) => step.name === "Select the requested Apple SDK").run)
    .toContain("select-apple-sdk.sh 27");

  const simulatorBuild = job.steps.find((step) => step.name === "Build bundled Release app for the iOS 27 simulator");
  expect(simulatorBuild.if).toContain("matrix.lane == 'xcode27'");
  expect(simulatorBuild.env.NODE_ENV).toBe("production");
  expect(simulatorBuild.env.RCT_NO_LAUNCH_PACKAGER).toBe("1");
  expect(simulatorBuild.run).toContain("-configuration Release");
  expect(simulatorBuild.run).toContain("platform=iOS Simulator,id=${{ steps.ios27_simulator.outputs.simulator_udid }}");
  expect(simulatorBuild.run).toContain("CODE_SIGNING_ALLOWED=NO");

  const smoke = job.steps.find((step) => step.name === "Smoke test cold and warm links on the iOS 27 simulator");
  expect(smoke.run).toContain("smoke-ios27-simulator.sh");
  const smokeScript = readFileSync("scripts/ci/smoke-ios27-simulator.sh", "utf8");
  expect(smokeScript).toContain("main.jsbundle");
  expect(smokeScript).toContain("mindwtr://capture?title=CI%20iOS%2027%20Smoke&requestId=");
  expect(smokeScript).toContain("mindwtr://open-feature?feature=waiting");
  expect(smokeScript).toContain("cold-link-screen.png");
  expect(smokeScript).toContain("STABLE_COLD_PID");
  expect(smokeScript).toContain("WARM_PID");
  expect(smokeScript).toContain("stage=sceneConnected deliveryKind=url");
  expect(smokeScript).toContain("stage=rootStarted deliveryKind=url");
  expect(smokeScript).toContain("stage=coldDelivery deliveryKind=url");
  expect(smokeScript).toContain("stage=warmDelivery deliveryKind=url");
  expect(smokeScript).toContain("stage=bridgeReady deliveryKind=none");

  const archive = job.steps.find((step) => step.name === "Create unsigned Release device archive with Xcode 27");
  expect(archive.run).toContain("-destination 'generic/platform=iOS'");
  expect(archive.run).toContain("CODE_SIGNING_ALLOWED=NO");
  expect(archive.run).toContain("CODE_SIGNING_REQUIRED=NO");
  expect(archive.run).toContain("Mindwtr-unsigned.xcarchive");
  expect(archive.run).not.toContain("-sdk iphoneos");

  const upload = job.steps.find((step) => step.name === "Upload Xcode 27 validation evidence");
  expect(upload.uses).toBe(
    "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
  );
  expect(upload.with.path).toBe("${{ runner.temp }}/ios27-artifacts");

  for (const script of [
    "scripts/ci/collect-ios27-environment.sh",
    "scripts/ci/select-ios27-simulator.sh",
    "scripts/ci/smoke-ios27-simulator.sh",
  ]) {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    expect(workflowText.match(new RegExp(`- "${script.replaceAll("/", "\\/")}"`, "g")))
      .toHaveLength(2);
  }
});

test("iOS 27 smoke scopes and verifies simulator URL-scheme approval", () => {
  const smokeScript = readFileSync("scripts/ci/smoke-ios27-simulator.sh", "utf8");

  expect(smokeScript).toContain(
    'SCHEME_APPROVAL_DOMAIN="com.apple.launchservices.schemeapproval"',
  );
  expect(smokeScript).toContain(
    'SCHEME_APPROVAL_KEY="com.apple.CoreSimulator.CoreSimulatorBridge-->${URL_SCHEME}"',
  );
  expect(smokeScript).toMatch(
    /xcrun simctl spawn "\$SIMULATOR_UDID" defaults write \\\n\s+"\$SCHEME_APPROVAL_DOMAIN" \\\n\s+"\$SCHEME_APPROVAL_KEY" \\\n\s+-string "\$BUNDLE_ID"/,
  );
  expect(smokeScript).toMatch(
    /xcrun simctl spawn "\$SIMULATOR_UDID" defaults read \\\n\s+"\$SCHEME_APPROVAL_DOMAIN" \\\n\s+"\$SCHEME_APPROVAL_KEY"/,
  );
  expect(smokeScript).toContain('if [ "$approved_bundle_id" != "$BUNDLE_ID" ]');
  expect(smokeScript).toContain('if [ "${GITHUB_ACTIONS:-}" != "true" ]');
  expect(smokeScript).toContain('approval_scope=github_actions_simulator');
  expect(smokeScript).toContain('approval_status=refused_outside_github_actions');
  expect(smokeScript).toContain('approval_status=verified');
  expect(smokeScript).toContain(
    'xcrun simctl get_app_container "$SIMULATOR_UDID" "$BUNDLE_ID" app',
  );

  const installIndex = smokeScript.indexOf('xcrun simctl install "$SIMULATOR_UDID" "$APP_PATH"');
  const approvalIndex = smokeScript.lastIndexOf("\napprove_url_scheme\n");
  const firstOpenIndex = smokeScript.indexOf('open_url "$COLD_URL"');
  expect(installIndex).toBeGreaterThan(-1);
  expect(approvalIndex).toBeGreaterThan(installIndex);
  expect(firstOpenIndex).toBeGreaterThan(approvalIndex);
  expect(smokeScript.match(/xcrun simctl openurl/g)).toHaveLength(1);
  expect(smokeScript).toContain('open_url "$WARM_URL"');
  expect(smokeScript).not.toContain("xcrun simctl launch");
  expect(smokeScript).not.toContain("com.apple.launchservices.schemeapproval.plist");
});

test("iOS 27 smoke accepts only openurl status 60 while requiring delivery proof", () => {
  const smokeScript = readFileSync("scripts/ci/smoke-ios27-simulator.sh", "utf8");
  const helper = smokeScript.match(/^open_url\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(helper).toBeDefined();
  const directory = mkdtempSync(join(tmpdir(), "mindwtr-ios-openurl-"));
  try {
    const calls = join(directory, "calls");
    for (const status of [0, 60, 42]) {
      for (const url of ["mindwtr://capture", "mindwtr://open-feature"]) {
        writeFileSync(calls, "");
        const result = spawnSync("bash", ["-euc", `${helper}\nxcrun() { printf '%s\\n' "$*" >> "$OPENURL_CALLS"; return "$OPENURL_STATUS"; }\nSIMULATOR_UDID=smoke-sim\nopen_url "$SMOKE_URL"`], {
          env: { ...process.env, OPENURL_CALLS: calls, OPENURL_STATUS: String(status), SMOKE_URL: url },
          encoding: "utf8",
        });
        expect(result.status).toBe(status === 42 ? 42 : 0);
        expect(readFileSync(calls, "utf8")).toBe(`simctl openurl smoke-sim ${url}\n`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  expect(smokeScript).toContain('COLD_PID="$(wait_for_pid)"');
  expect(smokeScript).toContain('if [ "$STABLE_COLD_PID" != "$COLD_PID" ]');
  expect(smokeScript).toContain('if [ "$WARM_PID" != "$COLD_PID" ]');
  expect(smokeScript).toContain("wait_for_marker '[MindwtrScene] stage=coldDelivery deliveryKind=url count='");
  expect(smokeScript).toContain("wait_for_marker '[MindwtrScene] stage=warmDelivery deliveryKind=url count='");
  expect(smokeScript).toContain("wait_for_marker_count '[MindwtrScene] stage=bridgeReady deliveryKind=none count=' 2");
});

test("native CI typechecks all maintained widgets before the expensive host build", () => {
  const workflow = parse(readFileSync(".github/workflows/native-platform-ci.yml", "utf8"));
  const steps = workflow.jobs["ios-native"].steps;
  const index = steps.findIndex((step) => step.name === "Typecheck iOS widgets at the minimum deployment target");
  expect(index).toBeGreaterThan(-1);
  expect(index).toBeLessThan(steps.findIndex((step) => step.name === "Generate iOS native project"));
  const command = steps[index].run;
  expect(command).toContain("xcrun swiftc");
  expect(command).toContain("-typecheck");
  expect(command).toContain("-application-extension");
  expect(command).toContain("-apple-ios15.1-simulator");
  expect(command).toContain("apps/mobile/widgets-ios/*.swift");
  expect(command).toContain("apps/mobile/modules/ios-widget/ios/MindwtrWidgetTaskItem.swift");
  expect(command).toContain("apps/mobile/modules/ios-widget/ios/MindwtrWidgetActionStore.swift");
});

test("attachment installer native CI collects the recovery suites", () => {
  const androidTests = readFileSync(
    "apps/mobile/modules/attachment-file-installer/android/src/test/java/tech/dongdongbh/mindwtr/attachmentfileinstaller/AttachmentFileInstallerCoreTest.kt",
    "utf8",
  );
  const androidPublisher = readFileSync(
    "apps/mobile/modules/attachment-file-installer/android/src/main/cpp/exact_attachment_publisher.cpp",
    "utf8",
  );
  const androidDirectoryRetirement = readFileSync(
    "apps/mobile/modules/attachment-file-installer/android/src/main/cpp/exact_directory_retirement.cpp",
    "utf8",
  );
  const androidDirectoryRetirementTests = readFileSync(
    "apps/mobile/modules/attachment-file-installer/android/src/test/cpp/exact_directory_retirement_test.cpp",
    "utf8",
  );
  const swiftPackage = readFileSync(
    "apps/mobile/modules/attachment-file-installer/ios/Package.swift",
    "utf8",
  );
  const swiftEngine = readFileSync(
    "apps/mobile/modules/attachment-file-installer/ios/AttachmentFileInstallerModule.swift",
    "utf8",
  );
  const swiftTests = readFileSync(
    "apps/mobile/modules/attachment-file-installer/ios/Tests/AttachmentFileInstallerEngineTests.swift",
    "utf8",
  );
  const cloudKitSwiftPackage = readFileSync(
    "apps/mobile/modules/cloudkit-sync/Package.swift",
    "utf8",
  );
  const cloudKitSwiftTests = readFileSync(
    "apps/mobile/modules/cloudkit-sync/tests/CloudKitAttachmentErrorClassifierTests.swift",
    "utf8",
  );

  expect(androidTests.match(/^\s*@Test$/gm)).toHaveLength(38);
  expect(androidTests).toContain(
    "unclaimedPrivateRetirementIsRecoveredFromItsDurableReservation",
  );
  expect(androidPublisher).toContain("fstatat(private_fd, \"stage\"");
  expect(androidPublisher).toContain("SYS_renameat2");
  expect(androidPublisher).toContain("RENAME_NOREPLACE");
  expect(androidPublisher).toContain("error == EINVAL");
  expect(androidPublisher).toContain(
    "static_assert(!rename_noreplace_needs_exact_handle_fallback(EEXIST))",
  );
  expect(androidPublisher).toContain("AT_SYMLINK_FOLLOW");
  expect(androidDirectoryRetirement).toContain("DirectoryRetirementResult::kMissing");
  expect(androidDirectoryRetirement).toContain("kBeforeFinalIdentityCheck");
  expect(androidDirectoryRetirement).toContain("kAfterRetirementBeforeParentSync");
  expect(androidDirectoryRetirement).toContain(
    'std::string(directory_name) + ".retiring"',
  );
  expect(androidDirectoryRetirementTests).toContain("preserves_a_peer_swapped_in_before_quarantine");
  expect(androidDirectoryRetirementTests).toContain(
    "preserves_a_peer_swapped_in_before_final_identity_check",
  );
  expect(androidDirectoryRetirementTests).toContain("resumes_after_crash_with_expected_quarantine");
  expect(androidDirectoryRetirementTests).toContain("confirms_missing_after_crash_before_parent_sync");
  expect(androidDirectoryRetirementTests).toContain("preserves_peer_after_crash_before_restore_sync");
  expect(androidDirectoryRetirementTests).toContain("rejects_a_rebound_parent");
  expect(androidDirectoryRetirementTests).toContain("preserves_a_preexisting_peer_quarantine");
  expect(androidDirectoryRetirementTests).toContain("retires_an_unclaimed_reserved_stage");
  expect(androidDirectoryRetirementTests).toContain("resumes_an_unclaimed_reserved_quarantine");
  expect(androidDirectoryRetirementTests).toContain("retains_the_open_parent_across_path_rebind");
  expect(swiftPackage).toContain(".testTarget(");
  expect(swiftEngine).not.toContain("Darwin.flock(");
  expect(swiftEngine.match(/\bflock\(descriptor, LOCK_(?:EX|UN)\)/g)).toHaveLength(4);
  expect(swiftTests).toContain("testAbsentGenerationUsesCreateNoReplace");
  expect(swiftTests).toContain("testPresentGenerationReplacesOnlyMatchingTargetAndPreservesIt");
  expect(swiftTests).toContain("testInitialJournalCrashRecoversUntouchedTargetAndRetries");
  expect(swiftTests).toContain("testLinkBeforeUnlinkCrashRecoversBothNamesAndRetries");
  expect(swiftTests).toContain("testLateWriterMutatesRetainedOldInodeWithoutTouchingInstalledGeneration");
  expect(swiftTests).toContain("testImmutablePublisherCreatesNoSharedInstallerRecoveryArtifacts");
  expect(swiftTests).toContain("testImmutablePublisherPreservesOwnedStageAndPeerTargetOnCollision");
  expect(swiftTests).toContain("testImmutablePublisherRejectsVerifiedStageNameSwap");
  expect(swiftTests).toContain("testPreparedPrivateStageRecoveryRemovesOnlyRecordedInode");
  expect(swiftTests).toContain("testOwnedStageRecoveryDeletesOnlyRecordedInodeAndDigest");
  expect(swiftTests).toContain("testOwnedStageRecoveryPreservesReplacementInodeWithSameDigest");
  expect(swiftTests).toContain("testOwnedStageRecoveryRejectsReplacedAttachmentRoot");
  expect(cloudKitSwiftPackage).toContain("CloudKitAttachmentErrorClassifierTests");
  expect(cloudKitSwiftPackage).toContain('.testTarget(');
  expect(cloudKitSwiftTests).toContain("testClassifiesMindwtrRecordAndAssetAbsenceAsTerminal");
  expect(cloudKitSwiftTests).toContain("testClassifiesCloudKitUnknownItemAsTerminal");
  expect(cloudKitSwiftTests).toContain("testPreservesTransientAndUnrelatedErrors");
});

test("File Sync lock native CI collects stable-authority suites", () => {
  const androidTests = readFileSync(
    "apps/mobile/modules/sync-file-lock/android/src/test/java/tech/dongdongbh/mindwtr/syncfilelock/SyncFileLockModuleTest.kt",
    "utf8",
  );
  const androidStableLock = readFileSync(
    "apps/mobile/modules/sync-file-lock/android/src/main/cpp/stable_root_lock.cpp",
    "utf8",
  );
  const androidCompatibilityLock = readFileSync(
    "apps/mobile/modules/sync-file-lock/android/src/main/cpp/file_compat_lock.cpp",
    "utf8",
  );
  const androidCompatibilityLockTest = readFileSync(
    "apps/mobile/modules/sync-file-lock/android/src/test/cpp/file_compat_lock_test.cpp",
    "utf8",
  );
  const swiftPackage = readFileSync(
    "apps/mobile/modules/sync-file-lock/ios/Package.swift",
    "utf8",
  );
  const swiftTests = readFileSync(
    "apps/mobile/modules/sync-file-lock/ios/Tests/SyncFileLockEngineTests.swift",
    "utf8",
  );
  const swiftEngine = readFileSync(
    "apps/mobile/modules/sync-file-lock/ios/SyncFileLockModule.swift",
    "utf8",
  );

  expect(androidTests.match(/^\s*@Test$/gm)).toHaveLength(7);
  expect(androidTests).toContain("safUsesPrivateStableAuthorityWithoutOpeningProviderDirectory");
  expect(androidTests).toContain("replacedLegacyLockCannotCreateSecondCurrentVersionOwner");
  expect(androidStableLock).toContain("flock(fd, LOCK_EX | LOCK_NB)");
  expect(androidStableLock).toContain("flock(fd, LOCK_UN)");
  expect(androidCompatibilityLock).toContain("F_OFD_SETLK");
  expect(androidCompatibilityLockTest).toContain("F_SETLK");
  expect(androidCompatibilityLockTest).toContain("fork()");
  expect(androidCompatibilityLockTest).toContain("validation_fd = open");
  expect(androidCompatibilityLockTest).toContain("legacy lock unexpectedly acquired after revalidation");
  expect(swiftPackage).toContain(".testTarget(");
  expect(swiftEngine).toContain("private var destroyed = false");
  expect(swiftEngine).toContain("guard !destroyed else");
  expect(swiftTests).toContain("testDrainRejectsAcquireCompletingAfterTeardown");
  expect(swiftTests).toContain("reachedRegistration");
  expect(swiftTests).toContain("testRootAuthorityBlocksReplacementLockOwner");
  expect(swiftTests).toContain("testSymlinkLockFailsClosedWithoutTouchingPeer");
});

test("desktop Rust pull requests check and test the native library on Windows", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const windowsJob = workflow.match(
    /\n  windows-rust:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];

  expect(workflow.match(/- "apps\/desktop\/src-tauri\/\*\*"/g)).toHaveLength(2);
  expect(workflow).toContain("windows: ${{ steps.filter.outputs.windows }}");
  expect(workflow).toMatch(
    /apps\/desktop\/src-tauri\/\*\|\.github\/workflows\/native-platform-ci\.yml\)\n\s+windows=true/,
  );
  expect(workflow).toContain('echo "windows=$windows" >> "$GITHUB_OUTPUT"');

  expect(windowsJob).toBeDefined();
  expect(windowsJob).toContain("if: needs.changes.outputs.windows == 'true'");
  expect(windowsJob).toContain("needs: changes");
  expect(windowsJob).toContain("runs-on: windows-latest");
  expect(windowsJob).toContain(
    "uses: dtolnay/rust-toolchain@631a55b12751854ce901bb631d5902ceb48146f7 # stable",
  );
  expect(windowsJob).toContain("RUSTFLAGS: -C target-feature=-crt-static");
  expect(windowsJob).toContain(
    "run: cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml",
  );
  expect(windowsJob).toContain("name: Run Windows native library tests");
  expect(windowsJob).toContain(
    "run: cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib",
  );
});

test("manual native CI selects one platform or all platforms", () => {
  const workflow = parse(readFileSync(".github/workflows/native-platform-ci.yml", "utf8"));
  const platforms = ["ios", "android", "macos", "windows"];
  const outputs = [...platforms, "android_client", "ios_client"];
  expect(workflow.on.workflow_dispatch.inputs.platform.default).toBe("all");
  const script = workflow.jobs.changes.steps.find((step) => step.id === "filter").run;
  const directory = mkdtempSync(join(tmpdir(), "mindwtr-native-dispatch-"));
  try {
    for (const selection of ["all", ...platforms]) {
      const output = join(directory, selection);
      execFileSync("bash", ["-euc", script], {
        env: { ...process.env, EVENT_NAME: "workflow_dispatch", DISPATCH_PLATFORM: selection, GITHUB_OUTPUT: output },
      });
      const actual = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=")));
      expect(actual).toEqual(Object.fromEntries(outputs.map((platform) => [
        platform, String(selection === "all" || selection === platform
          || (platform === "android_client" && selection === "android")
          || (platform === "ios_client" && selection === "ios")),
      ])));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SwiftUI client detection is retained while its CI job is paused for migration", () => {
  const workflow = parse(readFileSync(".github/workflows/native-platform-ci.yml", "utf8"));
  for (const event of ["push", "pull_request"]) {
    expect(workflow.on[event].paths).toContain("apps/ios-native/**");
  }
  const script = workflow.jobs.changes.steps.find((step) => step.id === "filter").run;
  const directory = mkdtempSync(join(tmpdir(), "mindwtr-ios-client-filter-"));
  try {
    for (const [path, expected] of [
      ["apps/ios-native/App/InboxView.swift", true],
      ["apps/android-native/bundle/host-entry.ts", true],
      ["packages/core/src/native-host-contract.ts", true],
      ["apps/mobile/app.config.ts", false],
      ["docs/README.md", false],
    ]) {
      const output = join(directory, "output");
      writeFileSync(output, "");
      writeFileSync(join(directory, "native-changed-paths.txt"), path + "\n");
      execFileSync("bash", ["-euc", script.slice(script.indexOf("android=false"))], {
        env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: output },
      });
      expect(readFileSync(output, "utf8")).toContain(`ios_client=${expected}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const job = workflow.jobs["ios-client"];
  expect(job.if).toStartWith("false && ");
  expect(job.if).toContain("needs.changes.outputs.ios_client == 'true'");
  expect(job.if).toContain("needs.changes.outputs.macmini != 'true'");
  const validation = job.steps.find((step) => step.run?.includes("bash apps/ios-native/scripts/validate.sh"));
  expect(validation).toBeDefined();
  expect(validation.run).toContain("set -o pipefail");
  expect(validation.run).toContain('bash apps/ios-native/scripts/validate.sh 2>&1 | tee "$RUNNER_TEMP/ios-swiftui-artifacts/validation.log"');
  expect(readFileSync("apps/ios-native/scripts/validate.sh", "utf8")).toContain("export TZ=America/New_York");
  expect(workflow.jobs["ios-macmini"].if).toBe("needs.changes.outputs.ios == 'true' && needs.changes.outputs.macmini == 'true'");
  expect(workflow.jobs["ios-native"].if).toBe("needs.changes.outputs.ios == 'true' && needs.changes.outputs.macmini != 'true'");
});

test("macOS native CI links the release Rust and Swift bridges", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const macosJob = workflow.match(
    /\n  macos-rust:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];

  expect(macosJob).toBeDefined();
  expect(macosJob).toContain("name: Link release macOS Rust and Swift bridges");
  expect(macosJob).toContain(
    "run: cargo build --release --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib",
  );
  expect(macosJob).toContain('MACOSX_DEPLOYMENT_TARGET: "10.15"');
  expect(workflow.match(/- "scripts\/ci\/test-build-macos-widget\.sh"/g)).toHaveLength(2);
  expect(macosJob).toContain("name: Exercise macOS widget packaging and signing order");
  expect(macosJob).toContain("run: bash scripts/ci/test-build-macos-widget.sh");
  const loadStep = parse(workflow).jobs["macos-rust"].steps.find(
    (step) => step.name === "Load release macOS library with the system Swift runtime",
  );
  expect(loadStep.run).toContain("target/release/libapp_lib.dylib");
  expect(loadStep.run).toContain("path /usr/lib/swift (offset");
  expect(loadStep.run).toContain("ctypes.CDLL(sys.argv[1])");
  expect(loadStep.run).toContain("env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH");
});

function appleRouting(privateRunner, enabled) {
  const workflow = parse(readFileSync(".github/workflows/native-platform-ci.yml", "utf8"));
  const step = workflow.jobs.changes.steps.find((step) => step.id === "routing");
  const root = mkdtempSync(join(tmpdir(), "mindwtr-routing-"));
  try {
    const output = join(root, "output");
    execFileSync("bash", ["-c", step.run], { env: {
      ...process.env, GITHUB_OUTPUT: output,
      PRIVATE_MACMINI: String(privateRunner), USE_MACMINI: String(enabled),
    }});
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return { matrix: JSON.parse(values.matrix), macmini: values.macmini };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Apple routing keeps hosted fallback and isolates the private Mac runner", () => {
  expect(appleRouting(false, false).matrix.include.map((lane) => lane.runner))
    .toEqual(["xcode-27"]);
  expect(appleRouting(false, true)).toMatchObject({
    matrix: { include: [{ lane: "xcode27", runner: "xcode-27" }] }, macmini: "true",
  });
  const privateRoute = appleRouting(true, true);
  expect(privateRoute.macmini).toBe("false");
  expect(privateRoute.matrix.include).toHaveLength(1);
  expect(privateRoute.matrix.include[0].runner).toEqual(["self-hosted", "macOS", "ARM64", "mindwtr-apple"]);
  const workflow = parse(readFileSync(".github/workflows/native-platform-ci.yml", "utf8"));
  const steps = workflow.jobs.changes.steps;
  const routing = steps.find((step) => step.id === "routing");
  expect(routing.env.USE_MACMINI).toContain("github.ref == 'refs/heads/main'");
  expect(routing.env.USE_MACMINI).toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
  expect(routing.env.USE_MACMINI).toContain("inputs.apple_runner != 'github'");
  expect(routing.env.PRIVATE_MACMINI).toContain("github.repository == 'dongdongbh/Mindwtr-native-ci'");
  const guard = steps.find((step) => step.name === "Require a commit already merged into public main");
  expect(guard.run).toBe('git merge-base --is-ancestor "$SOURCE_SHA" origin/main');
  expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(routing));
  expect(workflow.jobs["ios-native"].needs).toBe("changes");
  expect(workflow.jobs["ios-native"].if).toContain("needs.changes.outputs.macmini != 'true'");
  expect(workflow.jobs["ios-macmini"].if).toContain("needs.changes.outputs.macmini == 'true'");
  expect(workflow.jobs["ios-macmini"]["runs-on"]).toBe("ubuntu-latest");
});
