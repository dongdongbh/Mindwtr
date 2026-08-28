import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("native CI generates clean projects and compiles Android and iOS sources", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const androidJob = workflow.match(
    /\n  android-native:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];
  const iosJob = workflow.match(
    /\n  ios-native:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];

  expect(workflow).toContain('apps/mobile/modules/**/android/**');
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
  expect(androidJob).toContain(":sync-file-lock:assembleDebug");
  expect(androidJob).toContain("name: Verify packaged Android lock JNI symbols");
  expect(androidJob).toContain("jni/arm64-v8a/libsync-file-lock.so");
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_syncfilelock_StableRootLockNative_tryLock",
  );
  expect(androidJob).toContain(
    "Java_tech_dongdongbh_mindwtr_syncfilelock_StableRootLockNative_tryOfdLock",
  );
  expect(androidJob).toContain("name: Run Android native recovery tests");
  expect(androidJob).toContain(":attachment-file-installer:testDebugUnitTest");
  expect(androidJob).toContain(":sync-file-lock:testDebugUnitTest");

  expect(workflow).toContain("name: iOS Swift compile");
  expect(workflow).toContain("gem install cocoapods --version 1.16.2 --no-document");
  expect(workflow).toMatch(/prebuild \\\n\s+--clean \\\n\s+--platform ios/);
  expect(workflow).toContain("-sdk iphonesimulator");
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

test("attachment installer native CI collects the recovery suites", () => {
  const androidTests = readFileSync(
    "apps/mobile/modules/attachment-file-installer/android/src/test/java/tech/dongdongbh/mindwtr/attachmentfileinstaller/AttachmentFileInstallerCoreTest.kt",
    "utf8",
  );
  const androidPublisher = readFileSync(
    "apps/mobile/modules/attachment-file-installer/android/src/main/cpp/exact_attachment_publisher.cpp",
    "utf8",
  );
  const swiftPackage = readFileSync(
    "apps/mobile/modules/attachment-file-installer/ios/Package.swift",
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

  expect(androidTests.match(/^\s*@Test$/gm)).toHaveLength(27);
  expect(androidPublisher).toContain("fstatat(private_fd, \"stage\"");
  expect(androidPublisher).toContain("SYS_renameat2");
  expect(androidPublisher).toContain("RENAME_NOREPLACE");
  expect(androidPublisher).toContain("error == EINVAL");
  expect(androidPublisher).toContain(
    "static_assert(!rename_noreplace_needs_exact_handle_fallback(EEXIST))",
  );
  expect(androidPublisher).toContain("AT_SYMLINK_FOLLOW");
  expect(swiftPackage).toContain(".testTarget(");
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
  expect(workflow).toContain('echo "windows=true" >> "$GITHUB_OUTPUT"');
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
  expect(windowsJob).toContain(
    "run: cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml",
  );
  expect(windowsJob).toContain("name: Run Windows native library tests");
  expect(windowsJob).toContain(
    "run: cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib",
  );
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
});
