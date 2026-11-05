const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withPlugins,
  withXcodeProject,
} = require('@expo/config-plugins');

const TARGET_NAME = 'MindwtrWidgets';
const WIDGETS_FOLDER = 'widgets-ios';
const APP_INTENTS_FOLDER = 'ios-app-intents';
const IOS_WIDGET_MODULE_FOLDER = path.join('modules', 'ios-widget', 'ios');
const SHARED_WIDGET_ACTION_STORE = 'MindwtrWidgetActionStore.swift';
const SHARED_WIDGET_FILES = [SHARED_WIDGET_ACTION_STORE, 'MindwtrWidgetTaskItem.swift'];
const APP_GROUP = 'group.tech.dongdongbh.mindwtr';
const SHORTCUT_URL_KEY = 'url';
const SIRI_CAPTURE_SHORTCUTS_PROVIDER = 'MindwtrSiriCaptureShortcuts';
const SPOTLIGHT_INDEXER = 'MindwtrShortcutsSpotlightIndexer';
const SHORTCUT_ITEMS = [
  {
    UIApplicationShortcutItemType: 'tech.dongdongbh.mindwtr.add_task',
    UIApplicationShortcutItemTitle: 'Add task',
    UIApplicationShortcutItemSubtitle: 'Add task to Inbox',
    UIApplicationShortcutItemIconType: 'UIApplicationShortcutIconTypeCompose',
    UIApplicationShortcutItemUserInfo: { [SHORTCUT_URL_KEY]: 'mindwtr:///capture-quick?mode=text' },
  },
  {
    UIApplicationShortcutItemType: 'tech.dongdongbh.mindwtr.open_focus',
    UIApplicationShortcutItemTitle: 'Focus',
    UIApplicationShortcutItemSubtitle: 'Open Focus view',
    UIApplicationShortcutItemIconType: 'UIApplicationShortcutIconTypeTask',
    UIApplicationShortcutItemUserInfo: { [SHORTCUT_URL_KEY]: 'mindwtr:///focus' },
  },
  {
    UIApplicationShortcutItemType: 'tech.dongdongbh.mindwtr.open_calendar',
    UIApplicationShortcutItemTitle: 'Calendar',
    UIApplicationShortcutItemSubtitle: 'Open Calendar view',
    UIApplicationShortcutItemIconType: 'UIApplicationShortcutIconTypeDate',
    UIApplicationShortcutItemUserInfo: { [SHORTCUT_URL_KEY]: 'mindwtr:///calendar' },
  },
];

const copyRecursive = (sourceDir, targetDir) => {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
};

const copySharedWidgetActionStore = (projectRoot, targetDir) => {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of SHARED_WIDGET_FILES) {
    const sourcePath = path.join(projectRoot, IOS_WIDGET_MODULE_FOLDER, name);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`[ios-widgets-and-shortcuts] Missing shared widget source: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(targetDir, name));
  }
  return SHARED_WIDGET_ACTION_STORE;
};

const collectWidgetFiles = (targetDir) => {
  const widgetFiles = {
    swiftFiles: [],
    entitlementFiles: [],
    plistFiles: [],
    assetDirectories: [],
    intentFiles: [],
    otherFiles: [],
  };

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (name.endsWith('.xcassets')) {
        widgetFiles.assetDirectories.push(name);
      } else {
        widgetFiles.otherFiles.push(name);
      }
      continue;
    }

    const ext = name.split('.').pop();
    if (ext === 'swift') widgetFiles.swiftFiles.push(name);
    else if (ext === 'entitlements') widgetFiles.entitlementFiles.push(name);
    else if (ext === 'plist') widgetFiles.plistFiles.push(name);
    else if (ext === 'intentdefinition') widgetFiles.intentFiles.push(name);
    else widgetFiles.otherFiles.push(name);
  }

  return widgetFiles;
};

const collectSwiftFiles = (targetDir) => {
  if (!fs.existsSync(targetDir)) return [];
  return fs.readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.swift'))
    .map((entry) => entry.name)
    .sort();
};

const ensureSourceFileInTarget = (xcodeProject, { filePath, groupKey, targetUuid }) => {
  if (!filePath || !groupKey || !targetUuid) return false;
  if (xcodeProject.hasFile(filePath)) return false;
  xcodeProject.addSourceFile(filePath, { target: targetUuid }, groupKey);
  return true;
};

const ensureWidgetSwiftSourcesInTarget = (
  xcodeProject,
  { swiftFiles, groupKey, targetUuid }
) => {


  const objects = xcodeProject.hash.project.objects;
  for (const phase of objects.PBXNativeTarget[targetUuid].buildPhases) {
    if (objects.PBXSourcesBuildPhase[phase.value]) {
      phase.comment = 'Sources';
      objects.PBXSourcesBuildPhase[`${phase.value}_comment`] = 'Sources';
    }
  }
  return swiftFiles.filter((fileName) => ensureSourceFileInTarget(xcodeProject, {

    filePath: fileName,
    groupKey,
    targetUuid,
  }));
};

const addSiriShortcutsRegistrationToAppDelegate = (contents) => {
  const registrationCall = `${SIRI_CAPTURE_SHORTCUTS_PROVIDER}.updateAppShortcutParameters()`;


  const reindexCall = `${SPOTLIGHT_INDEXER}.reindexIfNeeded()`;
  const needsRegistration = !contents.includes(registrationCall);
  const needsReindex = !contents.includes(reindexCall);
  if (!needsRegistration && !needsReindex) return contents;

  const bindLine = '    bindReactNativeFactory(factory)\n';
  if (!contents.includes(bindLine)) return contents;

  let insertion = '';
  if (needsRegistration) {
    insertion += `\n    if #available(iOS 16.0, *) {\n      ${registrationCall}\n    }\n`;
  }
  if (needsReindex) {
    insertion += `\n    if #available(iOS 18.0, *) {\n      ${reindexCall}\n    }\n`;
  }

  return contents.replace(bindLine, `${bindLine}${insertion}`);
};

const addQuickActionsToInfoPlist = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationShortcutItems = SHORTCUT_ITEMS;
    return cfg;
  });

const addAppGroupEntitlement = (config) =>
  withEntitlementsPlist(config, (cfg) => {
    const key = 'com.apple.security.application-groups';
    const existing = Array.isArray(cfg.modResults[key]) ? cfg.modResults[key] : [];
    if (!existing.includes(APP_GROUP)) {
      cfg.modResults[key] = [APP_GROUP, ...existing];
    }
    return cfg;
  });


const addAppDelegateShortcutsRegistration = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const appName = IOSConfig.XcodeUtils.sanitizedName(cfg.name);
      const appDelegatePath = path.join(cfg.modRequest.platformProjectRoot, appName, 'AppDelegate.swift');
      if (!fs.existsSync(appDelegatePath)) return cfg;

      let contents = fs.readFileSync(appDelegatePath, 'utf8');
      contents = addSiriShortcutsRegistrationToAppDelegate(contents);
      fs.writeFileSync(appDelegatePath, contents);
      return cfg;
    },
  ]);

const addAppIntentSourcesToMainTarget = (config) =>
  withXcodeProject(config, (cfg) => {
    const xcodeProject = cfg.modResults;
    const platformProjectRoot = cfg.modRequest.platformProjectRoot;
    const projectRoot = cfg.modRequest.projectRoot;
    const appName = IOSConfig.XcodeUtils.sanitizedName(cfg.name);
    const sourceDir = path.join(projectRoot, APP_INTENTS_FOLDER);
    const targetDir = path.join(platformProjectRoot, appName);

    if (!fs.existsSync(sourceDir)) {
      throw new Error(`[ios-widgets-and-shortcuts] Missing app intents template folder: ${sourceDir}`);
    }

    copyRecursive(sourceDir, targetDir);

    const swiftFiles = collectSwiftFiles(sourceDir);
    if (swiftFiles.length === 0) return cfg;

    const mainTargetUuid = xcodeProject.getFirstTarget().uuid;
    const mainGroupKey =
      xcodeProject.findPBXGroupKey({ name: appName })
      || xcodeProject.findPBXGroupKey({ path: appName });

    if (!mainGroupKey) {
      throw new Error(`[ios-widgets-and-shortcuts] Could not find main iOS group: ${appName}`);
    }

    for (const fileName of swiftFiles) {
      ensureSourceFileInTarget(xcodeProject, {
        filePath: `${appName}/${fileName}`,
        groupKey: mainGroupKey,
        targetUuid: mainTargetUuid,
      });
    }

    return cfg;
  });

const addWidgetTargetToXcode = (config) =>
  withXcodeProject(config, (cfg) => {
    const xcodeProject = cfg.modResults;
    const platformProjectRoot = cfg.modRequest.platformProjectRoot;
    const projectRoot = cfg.modRequest.projectRoot;
    const sourceWidgetsDir = path.join(projectRoot, WIDGETS_FOLDER);
    const targetWidgetsDir = path.join(platformProjectRoot, TARGET_NAME);

    if (!fs.existsSync(sourceWidgetsDir)) {
      throw new Error(`[ios-widgets-and-shortcuts] Missing widgets template folder: ${sourceWidgetsDir}`);
    }
    copyRecursive(sourceWidgetsDir, targetWidgetsDir);
    copySharedWidgetActionStore(projectRoot, targetWidgetsDir);

    const widgetFiles = collectWidgetFiles(targetWidgetsDir);

    const nativeTargets = xcodeProject.pbxNativeTargetSection();
    for (const [key, value] of Object.entries(nativeTargets)) {
      if (key.endsWith('_comment')) continue;
      const name = String(value.name || '').replace(/"/g, '');
      if (name === TARGET_NAME) {
        const widgetGroupKey =
          xcodeProject.findPBXGroupKey({ name: TARGET_NAME })
          || xcodeProject.findPBXGroupKey({ path: TARGET_NAME });
        if (!widgetGroupKey) {
          throw new Error(`[ios-widgets-and-shortcuts] Could not find widget iOS group: ${TARGET_NAME}`);
        }
        ensureWidgetSwiftSourcesInTarget(xcodeProject, {
          swiftFiles: widgetFiles.swiftFiles,
          groupKey: widgetGroupKey,
          targetUuid: key,
        });
        return cfg;
      }
    }

    const runnerBundleId = cfg.ios?.bundleIdentifier || 'tech.dongdongbh.mindwtr';
    const bundleIdentifier = `${runnerBundleId}.${TARGET_NAME}`;
    const deploymentTarget = '15.1';
    const currentProjectVersion = cfg.ios?.buildNumber || '1';
    const marketingVersion = cfg.version || '1.0.0';

    const targetUuid = xcodeProject.generateUuid();
    const xCConfigurationList = xcodeProject.addXCConfigurationList(
      [
        {
          name: 'Debug',
          isa: 'XCBuildConfiguration',
          buildSettings: {
            PRODUCT_NAME: '"$(TARGET_NAME)"',
            SWIFT_VERSION: '5.0',
            TARGETED_DEVICE_FAMILY: '"1,2"',
            INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
            CURRENT_PROJECT_VERSION: `"${currentProjectVersion}"`,
            IPHONEOS_DEPLOYMENT_TARGET: `"${deploymentTarget}"`,
            PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
            GENERATE_INFOPLIST_FILE: '"YES"',
            INFOPLIST_KEY_CFBundleDisplayName: TARGET_NAME,
            INFOPLIST_KEY_NSHumanReadableCopyright: '""',
            MARKETING_VERSION: `"${marketingVersion}"`,
            SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
            CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`,
          },
        },
        {
          name: 'Release',
          isa: 'XCBuildConfiguration',
          buildSettings: {
            PRODUCT_NAME: '"$(TARGET_NAME)"',
            SWIFT_VERSION: '5.0',
            TARGETED_DEVICE_FAMILY: '"1,2"',
            INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
            CURRENT_PROJECT_VERSION: `"${currentProjectVersion}"`,
            IPHONEOS_DEPLOYMENT_TARGET: `"${deploymentTarget}"`,
            PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
            GENERATE_INFOPLIST_FILE: '"YES"',
            INFOPLIST_KEY_CFBundleDisplayName: TARGET_NAME,
            INFOPLIST_KEY_NSHumanReadableCopyright: '""',
            MARKETING_VERSION: `"${marketingVersion}"`,
            CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`,
          },
        },
      ],
      'Release',
      `Build configuration list for PBXNativeTarget "${TARGET_NAME}"`
    );

    const productFile = xcodeProject.addProductFile(TARGET_NAME, {
      basename: `${TARGET_NAME}.appex`,
      group: 'Embed App Extensions',
      explicitFileType: 'wrapper.app-extension',
      settings: {
        ATTRIBUTES: ['RemoveHeadersOnCopy'],
      },
      includeInIndex: 0,
      path: `${TARGET_NAME}.appex`,
      sourceTree: 'BUILT_PRODUCTS_DIR',
    });

    const target = {
      uuid: targetUuid,
      pbxNativeTarget: {
        isa: 'PBXNativeTarget',
        name: TARGET_NAME,
        productName: TARGET_NAME,
        productReference: productFile.fileRef,
        productType: '"com.apple.product-type.app-extension"',
        buildConfigurationList: xCConfigurationList.uuid,
        buildPhases: [],
        buildRules: [],
        dependencies: [],
      },
    };
    xcodeProject.addToPbxNativeTargetSection(target);

    const frameworksGroup = xcodeProject.findPBXGroupKey({ name: 'Frameworks' });
    xcodeProject.addFile('WidgetKit.framework', frameworksGroup);
    xcodeProject.addFile('SwiftUI.framework', frameworksGroup);

    xcodeProject.addToPbxProjectSection(target);
    const firstProject = xcodeProject.getFirstProject().uuid;
    if (!xcodeProject.pbxProjectSection()[firstProject].attributes.TargetAttributes) {
      xcodeProject.pbxProjectSection()[firstProject].attributes.TargetAttributes = {};
    }
    xcodeProject.pbxProjectSection()[firstProject].attributes.TargetAttributes[target.uuid] = {
      LastSwiftMigration: 1250,
    };

    if (!xcodeProject.hash.project.objects.PBXTargetDependency) {
      xcodeProject.hash.project.objects.PBXTargetDependency = {};
    }
    if (!xcodeProject.hash.project.objects.PBXContainerItemProxy) {
      xcodeProject.hash.project.objects.PBXContainerItemProxy = {};
    }
    xcodeProject.addTargetDependency(xcodeProject.getFirstTarget().uuid, [target.uuid]);

    xcodeProject.addBuildPhase(
      [...widgetFiles.swiftFiles, ...widgetFiles.intentFiles],
      'PBXSourcesBuildPhase',
      'Sources',
      targetUuid,
      'app_extension',
      '""'
    );
    xcodeProject.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', targetUuid, 'app_extension', '""');
    xcodeProject.addBuildPhase([...widgetFiles.assetDirectories], 'PBXResourcesBuildPhase', 'Resources', targetUuid, 'app_extension', '""');

    const mainTargetUuid = xcodeProject.getFirstTarget().uuid;
    let embedPhase = xcodeProject.buildPhaseObject('PBXCopyFilesBuildPhase', 'Embed App Extensions', mainTargetUuid);
    if (!embedPhase) {
      xcodeProject.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed App Extensions', mainTargetUuid, 'app_extension', '""');
      embedPhase = xcodeProject.buildPhaseObject('PBXCopyFilesBuildPhase', 'Embed App Extensions', mainTargetUuid);
    }
    if (embedPhase && Array.isArray(embedPhase.files)) {
      const hasEntry = embedPhase.files.some((file) => String(file.value) === String(productFile.uuid));
      if (!hasEntry) {
        embedPhase.files.push({
          value: productFile.uuid,
          comment: `${productFile.basename} in ${productFile.group}`,
        });
      }
    }
    xcodeProject.addToPbxBuildFileSection(productFile);

    const groupFiles = [
      ...widgetFiles.swiftFiles,
      ...widgetFiles.intentFiles,
      ...widgetFiles.otherFiles,
      ...widgetFiles.plistFiles,
      ...widgetFiles.assetDirectories,
    ];
    const { uuid: pbxGroupUuid } = xcodeProject.addPbxGroup(groupFiles, TARGET_NAME, TARGET_NAME);
    const groups = xcodeProject.hash.project.objects.PBXGroup;
    if (pbxGroupUuid) {
      Object.keys(groups).forEach((key) => {
        if (groups[key].name === undefined && groups[key].path === undefined) {
          xcodeProject.addToPbxGroup(pbxGroupUuid, key);
        }
      });
    }

    return cfg;
  });

const ensureWidgetTargetInPodfile = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;
      const targetBlock = `\ntarget '${TARGET_NAME}' do\n  use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']\n  use_frameworks! :linkage => ENV['USE_FRAMEWORKS'].to_sym if ENV['USE_FRAMEWORKS']\nend\n`;
      const source = fs.readFileSync(podfilePath, 'utf8');
      if (!source.includes(`target '${TARGET_NAME}' do`)) {
        fs.writeFileSync(podfilePath, `${source.trimEnd()}\n${targetBlock}`);
      }
      return cfg;
    },
  ]);

function withIosWidgetsAndShortcuts(config) {
  const targetName = TARGET_NAME;
  const bundleIdentifier = `${config.ios?.bundleIdentifier || 'tech.dongdongbh.mindwtr'}.${TARGET_NAME}`;
  const appExtensions =
    config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  const alreadyConfigured = appExtensions.some((ext) => ext && ext.targetName === targetName);

  if (!alreadyConfigured) {
    config.extra = {
      ...(config.extra || {}),
      eas: {
        ...(config.extra?.eas || {}),
        build: {
          ...(config.extra?.eas?.build || {}),
          experimental: {
            ...(config.extra?.eas?.build?.experimental || {}),
            ios: {
              ...(config.extra?.eas?.build?.experimental?.ios || {}),
              appExtensions: [
                ...appExtensions,
                {
                  targetName,
                  bundleIdentifier,
                  entitlements: {
                    'com.apple.security.application-groups': [APP_GROUP],
                  },
                },
              ],
            },
          },
        },
      },
    };
  }

  return withPlugins(config, [
    addQuickActionsToInfoPlist,
    addAppGroupEntitlement,
    addAppDelegateShortcutsRegistration,
    addAppIntentSourcesToMainTarget,
    addWidgetTargetToXcode,
    ensureWidgetTargetInPodfile,
  ]);
}

module.exports = withIosWidgetsAndShortcuts;
module.exports.__testables = {
  APP_INTENTS_FOLDER,
  IOS_WIDGET_MODULE_FOLDER,
  SHARED_WIDGET_ACTION_STORE,
  SIRI_CAPTURE_SHORTCUTS_PROVIDER,
  SPOTLIGHT_INDEXER,
  addSiriShortcutsRegistrationToAppDelegate,
  collectSwiftFiles,
  copySharedWidgetActionStore,
  ensureSourceFileInTarget,
  ensureWidgetSwiftSourcesInTarget,
};
