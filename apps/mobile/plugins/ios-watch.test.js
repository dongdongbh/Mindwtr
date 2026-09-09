import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const fs = require('fs');
const os = require('os');
const path = require('path');
const PbxProject = require('xcode/lib/pbxProject');
const plugin = require('./ios-watch');
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

const {
  WATCH_DEPLOYMENT_TARGET,
  WATCH_PRODUCT_TYPE,
  WATCH_TARGET_NAME,
  WIDGET_PRODUCT_TYPE,
  WIDGET_TARGET_NAME,
  copyWatchSources,
  reconcileEasExtensions,
  reconcileWatchProject,
  removeGeneratedWatchDirectories,
} = plugin.__testables;

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createFixtureProject = () => {
  const project = new PbxProject('/fixture/Mindwtr.xcodeproj/project.pbxproj');
  project.hash = {
    project: {
      archiveVersion: '1',
      classes: {},
      objectVersion: '56',
      objects: {
        PBXBuildFile: {},
        PBXContainerItemProxy: {},
        PBXCopyFilesBuildPhase: {},
        PBXFileReference: {
          HOST_PRODUCT: {
            explicitFileType: 'wrapper.application',
            includeInIndex: 0,
            path: 'Mindwtr.app',
            sourceTree: 'BUILT_PRODUCTS_DIR',
          },
          HOST_PRODUCT_comment: 'Mindwtr.app',
        },
        PBXFrameworksBuildPhase: {
          HOST_FRAMEWORKS: {
            isa: 'PBXFrameworksBuildPhase',
            buildActionMask: 2147483647,
            files: [],
            runOnlyForDeploymentPostprocessing: 0,
          },
          HOST_FRAMEWORKS_comment: 'Frameworks',
        },
        PBXGroup: {
          ROOT_GROUP: {
            isa: 'PBXGroup',
            children: [{ value: 'PRODUCTS_GROUP', comment: 'Products' }],
            sourceTree: '"<group>"',
          },
          ROOT_GROUP_comment: 'Mindwtr',
          PRODUCTS_GROUP: {
            isa: 'PBXGroup',
            children: [{ value: 'HOST_PRODUCT', comment: 'Mindwtr.app' }],
            name: 'Products',
            sourceTree: '"<group>"',
          },
          PRODUCTS_GROUP_comment: 'Products',
        },
        PBXNativeTarget: {
          HOST_TARGET: {
            isa: 'PBXNativeTarget',
            buildConfigurationList: 'HOST_CONFIG_LIST',
            buildPhases: [{ value: 'HOST_FRAMEWORKS', comment: 'Frameworks' }],
            buildRules: [],
            dependencies: [],
            name: 'Mindwtr',
            productName: 'Mindwtr',
            productReference: 'HOST_PRODUCT',
            productType: '"com.apple.product-type.application"',
          },
          HOST_TARGET_comment: 'Mindwtr',
        },
        PBXProject: {
          PROJECT: {
            isa: 'PBXProject',
            attributes: { TargetAttributes: { HOST_TARGET: { ProvisioningStyle: 'Automatic' } } },
            buildConfigurationList: 'PROJECT_CONFIG_LIST',
            compatibilityVersion: '"Xcode 14.0"',
            developmentRegion: 'en',
            hasScannedForEncodings: 0,
            knownRegions: ['en', 'Base'],
            mainGroup: 'ROOT_GROUP',
            productRefGroup: 'PRODUCTS_GROUP',
            projectDirPath: '""',
            projectRoot: '""',
            targets: [{ value: 'HOST_TARGET', comment: 'Mindwtr' }],
          },
          PROJECT_comment: 'Project object',
        },
        PBXResourcesBuildPhase: {},
        PBXSourcesBuildPhase: {},
        PBXTargetDependency: {},
        XCBuildConfiguration: {
          HOST_DEBUG: { isa: 'XCBuildConfiguration', buildSettings: {}, name: 'Debug' },
          HOST_DEBUG_comment: 'Debug',
          HOST_RELEASE: { isa: 'XCBuildConfiguration', buildSettings: {}, name: 'Release' },
          HOST_RELEASE_comment: 'Release',
          PROJECT_DEBUG: { isa: 'XCBuildConfiguration', buildSettings: {}, name: 'Debug' },
          PROJECT_DEBUG_comment: 'Debug',
          PROJECT_RELEASE: { isa: 'XCBuildConfiguration', buildSettings: {}, name: 'Release' },
          PROJECT_RELEASE_comment: 'Release',
        },
        XCConfigurationList: {
          HOST_CONFIG_LIST: {
            isa: 'XCConfigurationList',
            buildConfigurations: [
              { value: 'HOST_DEBUG', comment: 'Debug' },
              { value: 'HOST_RELEASE', comment: 'Release' },
            ],
            defaultConfigurationIsVisible: 0,
            defaultConfigurationName: 'Release',
          },
          HOST_CONFIG_LIST_comment: 'Build configuration list for PBXNativeTarget "Mindwtr"',
          PROJECT_CONFIG_LIST: {
            isa: 'XCConfigurationList',
            buildConfigurations: [
              { value: 'PROJECT_DEBUG', comment: 'Debug' },
              { value: 'PROJECT_RELEASE', comment: 'Release' },
            ],
            defaultConfigurationIsVisible: 0,
            defaultConfigurationName: 'Release',
          },
          PROJECT_CONFIG_LIST_comment: 'Build configuration list for PBXProject "Mindwtr"',
        },
      },
      rootObject: 'PROJECT',
      rootObject_comment: 'Project object',
    },
  };
  return project;
};

const nonCommentEntries = (section) => Object.entries(section).filter(([key]) => !key.endsWith('_comment'));

const findTarget = (project, name) => nonCommentEntries(project.pbxNativeTargetSection())
  .find(([, target]) => String(target.name).replaceAll('"', '') === name);

const configurationSettingsForTarget = (project, target) => {
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  return list.buildConfigurations.map((entry) => project.pbxXCBuildConfigurationSection()[entry.value].buildSettings);
};

const dependenciesForTarget = (project, target) => target.dependencies.map((entry) => (
  project.hash.project.objects.PBXTargetDependency[entry.value].target
));

const phaseForTarget = (project, target, phaseType, name) => target.buildPhases
  .map((entry) => project.hash.project.objects[phaseType]?.[entry.value])
  .find((phase) => phase && String(phase.name ?? '').replaceAll('"', '') === name);

const sourceNamesForTarget = (project, target) => {
  const fileReferences = project.pbxFileReferenceSection();
  const buildFiles = project.pbxBuildFileSection();
  const phase = target.buildPhases
    .map((entry) => project.hash.project.objects.PBXSourcesBuildPhase?.[entry.value])
    .find(Boolean);
  return phase.files.map((entry) => {
    const fileRef = buildFiles[entry.value].fileRef;
    return path.posix.basename(String(fileReferences[fileRef].path).replaceAll('"', ''));
  });
};

const buildFileUseCounts = (project) => {
  const counts = new Map();
  for (const phaseType of ['PBXCopyFilesBuildPhase', 'PBXSourcesBuildPhase', 'PBXResourcesBuildPhase', 'PBXFrameworksBuildPhase']) {
    for (const [, phase] of nonCommentEntries(project.hash.project.objects[phaseType] ?? {})) {
      for (const file of phase.files ?? []) counts.set(file.value, (counts.get(file.value) ?? 0) + 1);
    }
  }
  return counts;
};

const groupParentCounts = (project) => {
  const counts = new Map();
  for (const [, group] of nonCommentEntries(project.hash.project.objects.PBXGroup ?? {})) {
    for (const child of group.children ?? []) counts.set(child.value, (counts.get(child.value) ?? 0) + 1);
  }
  return counts;
};

const createGeneratedSources = async () => {
  const platformProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-watch-plugin-'));
  temporaryDirectories.push(platformProjectRoot);
  return {
    platformProjectRoot,
    ...await copyWatchSources({
      projectRoot: path.resolve(testDirectory, '..'),
      platformProjectRoot,
    }),
  };
};

const enabledOptions = (directories) => ({
  enabled: true,
  hostBundleIdentifier: 'tech.dongdongbh.mindwtr.preview',
  currentProjectVersion: '1175',
  marketingVersion: '1.2.9-rc.1',
  watchDirectory: directories.watchDirectory,
  widgetDirectory: directories.widgetDirectory,
});

describe('ios-watch', () => {
  it('copies separated Watch app/widget sources and the existing brand icon', async () => {
    const directories = await createGeneratedSources();

    expect(fs.existsSync(path.join(directories.watchDirectory, 'MindwtrWatchApp.swift'))).toBe(true);
    expect(fs.existsSync(path.join(directories.watchDirectory, 'MindwtrWatchWidgets.swift'))).toBe(false);
    expect(fs.existsSync(path.join(directories.widgetDirectory, 'MindwtrWatchWidgets.swift'))).toBe(true);
    expect(fs.existsSync(path.join(directories.widgetDirectory, 'MindwtrWatchApp.swift'))).toBe(false);
    expect(fs.existsSync(path.join(directories.watchDirectory, 'WatchProtocol.swift'))).toBe(true);
    expect(fs.existsSync(path.join(directories.widgetDirectory, 'WatchProtocol.swift'))).toBe(true);
    expect(fs.existsSync(path.join(directories.watchDirectory, 'PrivacyInfo.xcprivacy'))).toBe(true);
    expect(fs.readFileSync(path.join(directories.watchDirectory, 'PrivacyInfo.xcprivacy'), 'utf8')).toContain('1C8F.1');
    expect(fs.existsSync(path.join(directories.watchDirectory, 'Localizable.xcstrings'))).toBe(true);

    const generatedIcon = fs.readFileSync(path.join(
      directories.watchDirectory,
      'Assets.xcassets',
      'AppIcon.appiconset',
      'AppIcon.png',
    ));
    expect(generatedIcon.readUInt32BE(16)).toBe(1024);
    expect(generatedIcon.readUInt32BE(20)).toBe(1024);
    // PNG IHDR color type2 is RGB, without an alpha channel.
    expect(generatedIcon[25]).toBe(2);
  });

  it('builds the generated Xcode graph with companion IDs, embeds, dependencies and isolated @main sources', async () => {
    const directories = await createGeneratedSources();
    const project = createFixtureProject();
    reconcileWatchProject(project, enabledOptions(directories));

    const [watchUuid, watchTarget] = findTarget(project, WATCH_TARGET_NAME);
    const [widgetUuid, widgetTarget] = findTarget(project, WIDGET_TARGET_NAME);
    const hostTarget = findTarget(project, 'Mindwtr')[1];
    expect(WATCH_PRODUCT_TYPE).toBe('com.apple.product-type.application');
    expect(watchTarget.productType).toBe('"com.apple.product-type.application"');
    expect(widgetTarget.productType).toBe(`"${WIDGET_PRODUCT_TYPE}"`);
    expect(dependenciesForTarget(project, hostTarget)).toEqual([watchUuid]);
    expect(dependenciesForTarget(project, watchTarget)).toEqual([widgetUuid]);

    for (const settings of configurationSettingsForTarget(project, watchTarget)) {
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('"tech.dongdongbh.mindwtr.preview.watchkitapp"');
      expect(settings.WATCHOS_DEPLOYMENT_TARGET).toBe(`"${WATCH_DEPLOYMENT_TARGET}"`);
      expect(settings.MARKETING_VERSION).toBe('"1.2.9-rc.1"');
      expect(settings.CURRENT_PROJECT_VERSION).toBe('"1175"');
      expect(settings.MINDWTR_WATCH_APP_GROUP).toBe('"group.tech.dongdongbh.mindwtr.preview.watch"');
    }
    for (const settings of configurationSettingsForTarget(project, widgetTarget)) {
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('"tech.dongdongbh.mindwtr.preview.watchkitapp.widgets"');
      expect(settings.APPLICATION_EXTENSION_API_ONLY).toBe('YES');
    }

    const watchSources = sourceNamesForTarget(project, watchTarget);
    const widgetSources = sourceNamesForTarget(project, widgetTarget);
    expect(watchSources).toContain('MindwtrWatchApp.swift');
    expect(watchSources).toContain('MindwtrWatchIntents.swift');
    expect(watchSources).not.toContain('MindwtrWatchWidgets.swift');
    expect(widgetSources).toContain('MindwtrWatchWidgets.swift');
    expect(widgetSources).not.toContain('MindwtrWatchApp.swift');
    expect(watchSources.filter((name) => name === 'WatchProtocol.swift')).toHaveLength(1);
    expect(widgetSources.filter((name) => name === 'WatchProtocol.swift')).toHaveLength(1);

    const buildFiles = nonCommentEntries(project.pbxBuildFileSection());
    const buildFileUses = buildFileUseCounts(project);
    expect(buildFiles.every(([uuid]) => buildFileUses.get(uuid) === 1)).toBe(true);
    const fileReferences = project.pbxFileReferenceSection();
    const fileReferenceParents = groupParentCounts(project);
    expect(buildFiles.every(([, buildFile]) => fileReferenceParents.get(buildFile.fileRef) === 1)).toBe(true);

    const sharedSourceRefs = buildFiles
      .filter(([, buildFile]) => buildFile.fileRef_comment === 'WatchSnapshotStore.swift')
      .map(([, buildFile]) => buildFile.fileRef);
    expect(sharedSourceRefs).toHaveLength(2);
    expect(new Set(sharedSourceRefs)).toHaveLength(2);
    expect(sharedSourceRefs.map((uuid) => fileReferences[uuid].path)).toEqual([
      '"MindwtrWatch/WatchSnapshotStore.swift"',
      '"MindwtrWatchWidgets/WatchSnapshotStore.swift"',
    ]);

    expect(phaseForTarget(project, hostTarget, 'PBXCopyFilesBuildPhase', 'Embed Watch Content').files).toHaveLength(1);
    expect(phaseForTarget(project, watchTarget, 'PBXCopyFilesBuildPhase', 'Embed Watch Extensions').files).toHaveLength(1);
    expect(project.writeSync()).toContain('MindwtrWatchWidgets.appex in Embed Watch Extensions');
    // The iPhone widget plugin asks this before creating its own embed phase.
    // node-xcode must not return the Watch target's phase as a global fallback.
    expect(project.buildPhaseObject('PBXCopyFilesBuildPhase', 'Embed App Extensions', 'HOST_TARGET')).toBeNull();
  });

  it('does not let a later extension reuse the Watch privacy resource build file', async () => {
    const directories = await createGeneratedSources();
    const project = createFixtureProject();
    reconcileWatchProject(project, enabledOptions(directories));

    // expo-share-intent adds a bare privacy manifest after our plugin during
    // clean prebuild; xcode's helper searches all targets by file path.
    project.addBuildPhase(['PrivacyInfo.xcprivacy'], 'PBXResourcesBuildPhase', 'Resources', 'HOST_TARGET');
    const uses = buildFileUseCounts(project);
    expect([...uses.values()].every((count) => count === 1)).toBe(true);
    reconcileWatchProject(project, { enabled: false });
    const remainingPrivacy = nonCommentEntries(project.pbxBuildFileSection())
      .filter(([, file]) => file.fileRef_comment === 'PrivacyInfo.xcprivacy');
    expect(remainingPrivacy).toHaveLength(1);
  });

  it('is idempotent and removes every owned graph reference and generated directory when disabled', async () => {
    const directories = await createGeneratedSources();
    const project = createFixtureProject();
    const options = enabledOptions(directories);

    reconcileWatchProject(project, options);
    reconcileWatchProject(project, options);
    expect(nonCommentEntries(project.pbxNativeTargetSection()).filter(([, target]) => target.name === WATCH_TARGET_NAME)).toHaveLength(1);
    expect(nonCommentEntries(project.pbxNativeTargetSection()).filter(([, target]) => target.name === WIDGET_TARGET_NAME)).toHaveLength(1);
    expect(nonCommentEntries(project.hash.project.objects.PBXGroup).filter(([, group]) => group.name === WATCH_TARGET_NAME)).toHaveLength(1);
    expect(nonCommentEntries(project.hash.project.objects.PBXGroup).filter(([, group]) => group.name === WIDGET_TARGET_NAME)).toHaveLength(1);

    reconcileWatchProject(project, { enabled: false });
    removeGeneratedWatchDirectories(directories.platformProjectRoot);

    expect(findTarget(project, WATCH_TARGET_NAME)).toBeUndefined();
    expect(findTarget(project, WIDGET_TARGET_NAME)).toBeUndefined();
    expect(Object.keys(project.getFirstProject().firstProject.attributes.TargetAttributes)).toEqual(['HOST_TARGET']);
    expect(JSON.stringify(project.hash.project.objects)).not.toContain(WATCH_TARGET_NAME);
    expect(JSON.stringify(project.hash.project.objects)).not.toContain(WIDGET_TARGET_NAME);
    expect(fs.existsSync(directories.watchDirectory)).toBe(false);
    expect(fs.existsSync(directories.widgetDirectory)).toBe(false);
    expect(project.writeSync()).not.toContain(WATCH_TARGET_NAME);
  });

  it('adds and removes EAS signing entries without disturbing other extensions', () => {
    const config = {
      ios: { bundleIdentifier: 'tech.dongdongbh.mindwtr' },
      extra: {
        eas: {
          build: {
            experimental: {
              ios: {
                appExtensions: [{ targetName: 'MindwtrWidgets', bundleIdentifier: 'existing.widget' }],
              },
            },
          },
        },
      },
    };

    reconcileEasExtensions(config, true);
    reconcileEasExtensions(config, true);
    expect(config.extra.eas.build.experimental.ios.appExtensions.map((entry) => entry.targetName)).toEqual([
      'MindwtrWidgets',
      WATCH_TARGET_NAME,
      WIDGET_TARGET_NAME,
    ]);

    reconcileEasExtensions(config, false);
    expect(config.extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: 'MindwtrWidgets', bundleIdentifier: 'existing.widget' },
    ]);
  });

  it('keeps captures durable until app-level receipts and ships foreground capture plus glanceable widgets', () => {
    const sourceRoot = path.resolve(testDirectory, '..', 'targets', 'watch');
    const protocolSource = fs.readFileSync(path.join(sourceRoot, 'Shared', 'WatchProtocol.swift'), 'utf8');
    const audioRecorderSource = fs.readFileSync(path.join(sourceRoot, 'App', 'WatchAudioRecorder.swift'), 'utf8');
    const connectivitySource = fs.readFileSync(path.join(sourceRoot, 'App', 'WatchConnectivityModel.swift'), 'utf8');
    const outboxSource = fs.readFileSync(path.join(sourceRoot, 'App', 'WatchOutbox.swift'), 'utf8');
    const viewsSource = fs.readFileSync(path.join(sourceRoot, 'App', 'MindwtrWatchViews.swift'), 'utf8');
    const intentsSource = fs.readFileSync(path.join(sourceRoot, 'App', 'MindwtrWatchIntents.swift'), 'utf8');
    const widgetSource = fs.readFileSync(path.join(sourceRoot, 'Widgets', 'MindwtrWatchWidgets.swift'), 'utf8');
    const watchInfo = fs.readFileSync(path.join(sourceRoot, 'Resources', 'Watch-Info.plist'), 'utf8');

    const textCapture = protocolSource.slice(
      protocolSource.indexOf('static func textCapture'),
      protocolSource.indexOf('static func command'),
    );
    expect(textCapture).toContain('maximumCaptureCharacters');
    expect(textCapture).toContain('maximumCaptureUtf8Bytes');
    expect(textCapture).not.toContain('.prefix(');
    expect(protocolSource).toContain('completionAlert: (pomodoroDictionary["completionAlert"] as? NSNumber)?.boolValue ?? true');

    expect(outboxSource).toContain('options: .atomic');
    const reversedUuidRecords = [
      { id: '00000000-0000-4000-8000-000000000000', createdAt: '2026-09-06T18:00:01.000Z' },
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', createdAt: '2026-09-06T18:00:00.000Z' },
    ];
    expect(reversedUuidRecords.sort((lhs, rhs) => (
      lhs.createdAt === rhs.createdAt
        ? lhs.id.localeCompare(rhs.id)
        : lhs.createdAt.localeCompare(rhs.createdAt)
    )).map(({ id }) => id)).toEqual([
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(outboxSource).toContain('if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }');
    expect(outboxSource).not.toContain('.sorted { $0.lastPathComponent < $1.lastPathComponent }');
    expect(connectivitySource).toContain('pendingOwner.prepareText(trimmed)');
    expect(connectivitySource).toContain('id: pending.id');
    expect(connectivitySource).toContain('rejectedCaptureDraft = saved ? nil : text');
    expect(protocolSource).toContain('if outboxRetried { payload["outboxRetried"] = true }');
    expect(connectivitySource).toContain('func transferAudio(');
    expect(connectivitySource).toContain('outboxRetried: Bool = false');
    expect(connectivitySource).toContain('outboxRetried: pending.outboxRetried');
    expect(outboxSource).toContain('outboxRetried: true');
    expect(audioRecorderSource).toContain('pendingCapture.persistPending');
    expect(audioRecorderSource).toContain('!handledCompletion');
    expect(audioRecorderSource).toContain('hasPendingRecording = !saved');
    expect(viewsSource).toContain('"Retry recording"');
    expect(viewsSource).toContain('"Resend capture"');
    expect(connectivitySource).toContain('session.activationState == .activated');
    expect(connectivitySource).toContain('outstandingUserInfoTransfers');
    expect(connectivitySource).toContain('receipt["kind"] as? String == "receipt"');
    expect(connectivitySource).toContain('MindwtrWatchOutbox.remove(id: id, removeAudio: removeAudio)');
    const fileFinished = connectivitySource.slice(connectivitySource.indexOf('didFinish fileTransfer'));
    expect(fileFinished).not.toContain('removeAudio: true');

    expect(intentsSource).toContain('static var openAppWhenRun: Bool { true }');
    expect(intentsSource).toContain('.foreground(.immediate)');
    expect(intentsSource).not.toContain('AudioRecordingIntent');
    const intentDescriptions = Array.from(
      intentsSource.matchAll(/IntentDescription\("([^"]+)"\)/g),
      (match) => match[1],
    );
    expect(intentDescriptions.length).toBeGreaterThan(0);
    expect(intentDescriptions.every((description) => !/\bapple\b/i.test(description))).toBe(true);
    expect(widgetSource).toContain('.accessoryCircular');
    expect(widgetSource).toContain('.accessoryRectangular');
    expect(widgetSource).toContain('.accessoryInline');
    expect(watchInfo).toContain('<key>WKApplication</key>');
    expect(watchInfo).toContain('$(MARKETING_VERSION)');
    expect(watchInfo).toContain('$(CURRENT_PROJECT_VERSION)');
  });
});
