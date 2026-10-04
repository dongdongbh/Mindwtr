const fs = require('fs');
const path = require('path');
const PbxFile = require('xcode/lib/pbxFile');
const { generateImageAsync } = require('@expo/image-utils');
const {
  withInfoPlist,
  withPlugins,
  withXcodeProject,
} = require('@expo/config-plugins');

const WATCH_TARGET_NAME = 'MindwtrWatch';
const WIDGET_TARGET_NAME = 'MindwtrWatchWidgets';
const WATCH_SOURCE_FOLDER = path.join('targets', 'watch');
const WATCH_GENERATED_FOLDER = WATCH_TARGET_NAME;
const WIDGET_GENERATED_FOLDER = WIDGET_TARGET_NAME;
const WATCH_DEPLOYMENT_TARGET = '10.0';
// Xcode 14+ single-target SwiftUI Watch apps are ordinary application
// products with WKApplication in Info.plist. watchapp2 is the legacy split
// WatchKit app + extension product type and fails modern watchOS validation.
const WATCH_PRODUCT_TYPE = 'com.apple.product-type.application';
const WIDGET_PRODUCT_TYPE = 'com.apple.product-type.app-extension';
const COMMENT_SUFFIX = '_comment';

const unquote = (value) => String(value ?? '').replace(/^"|"$/g, '');

const targetName = (target) => unquote(target?.name);

const ensureSection = (project, name) => {
  if (!project.hash.project.objects[name]) project.hash.project.objects[name] = {};
  return project.hash.project.objects[name];
};

const copyDirectoryContents = (source, destination) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryContents(sourcePath, destinationPath);
    else fs.copyFileSync(sourcePath, destinationPath);
  }
};

const copyFiles = (source, destination, predicate = () => true) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && predicate(entry.name)) {
      fs.copyFileSync(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
};

const copyWatchSources = async ({ projectRoot, platformProjectRoot }) => {
  const sourceRoot = path.join(projectRoot, WATCH_SOURCE_FOLDER);
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`[ios-watch] Missing Watch source folder: ${sourceRoot}`);
  }

  const watchDirectory = path.join(platformProjectRoot, WATCH_GENERATED_FOLDER);
  const widgetDirectory = path.join(platformProjectRoot, WIDGET_GENERATED_FOLDER);
  fs.rmSync(watchDirectory, { recursive: true, force: true });
  fs.rmSync(widgetDirectory, { recursive: true, force: true });
  fs.mkdirSync(watchDirectory, { recursive: true });
  fs.mkdirSync(widgetDirectory, { recursive: true });

  copyFiles(path.join(sourceRoot, 'App'), watchDirectory, (name) => name.endsWith('.swift'));
  copyFiles(path.join(sourceRoot, 'Shared'), watchDirectory, (name) => name.endsWith('.swift'));
  copyFiles(path.join(sourceRoot, 'Widgets'), widgetDirectory, (name) => name.endsWith('.swift'));
  copyFiles(path.join(sourceRoot, 'Shared'), widgetDirectory, (name) => name.endsWith('.swift'));

  const resources = path.join(sourceRoot, 'Resources');
  fs.copyFileSync(path.join(resources, 'Watch-Info.plist'), path.join(watchDirectory, 'Info.plist'));
  fs.copyFileSync(path.join(resources, 'Widgets-Info.plist'), path.join(widgetDirectory, 'Info.plist'));
  fs.copyFileSync(path.join(resources, 'Watch.entitlements'), path.join(watchDirectory, `${WATCH_TARGET_NAME}.entitlements`));
  fs.copyFileSync(path.join(resources, 'Widgets.entitlements'), path.join(widgetDirectory, `${WIDGET_TARGET_NAME}.entitlements`));
  fs.copyFileSync(path.join(resources, 'PrivacyInfo.xcprivacy'), path.join(watchDirectory, 'PrivacyInfo.xcprivacy'));
  fs.copyFileSync(path.join(resources, 'PrivacyInfo.xcprivacy'), path.join(widgetDirectory, 'PrivacyInfo.xcprivacy'));
  fs.copyFileSync(path.join(resources, 'Localizable.xcstrings'), path.join(watchDirectory, 'Localizable.xcstrings'));
  fs.copyFileSync(path.join(resources, 'Localizable.xcstrings'), path.join(widgetDirectory, 'Localizable.xcstrings'));

  const assetsDirectory = path.join(watchDirectory, 'Assets.xcassets');
  const appIconDirectory = path.join(assetsDirectory, 'AppIcon.appiconset');
  copyDirectoryContents(path.join(resources, 'AppIcon.appiconset'), appIconDirectory);
  fs.writeFileSync(
    path.join(assetsDirectory, 'Contents.json'),
    `${JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2)}\n`,
  );
  const { source: icon } = await generateImageAsync(
    { projectRoot, cacheType: 'watch-app-icon' },
    {
      src: path.join(projectRoot, 'assets', 'images', 'icon.png'),
      width: 1024,
      height: 1024,
      resizeMode: 'cover',
      backgroundColor: '#ffffff',
      removeTransparency: true,
    },
  );
  fs.writeFileSync(path.join(appIconDirectory, 'AppIcon.png'), icon);

  return { watchDirectory, widgetDirectory };
};

const removeGeneratedWatchDirectories = (platformProjectRoot) => {
  fs.rmSync(path.join(platformProjectRoot, WATCH_GENERATED_FOLDER), { recursive: true, force: true });
  fs.rmSync(path.join(platformProjectRoot, WIDGET_GENERATED_FOLDER), { recursive: true, force: true });
};

const configurationSettings = ({
  target,
  bundleIdentifier,
  hostBundleIdentifier,
  appGroup,
  currentProjectVersion,
  marketingVersion,
  widget,
}) => ({
  ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: 'YES',
  ASSETCATALOG_COMPILER_APPICON_NAME: widget ? '""' : 'AppIcon',
  CODE_SIGN_ENTITLEMENTS: `"${target}/${target}.entitlements"`,
  CODE_SIGN_STYLE: 'Automatic',
  CURRENT_PROJECT_VERSION: `"${currentProjectVersion}"`,
  ENABLE_PREVIEWS: 'YES',
  GENERATE_INFOPLIST_FILE: 'NO',
  INFOPLIST_FILE: `"${target}/Info.plist"`,
  LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks"',
  MARKETING_VERSION: `"${marketingVersion}"`,
  MINDWTR_SPOKEN_NAME: hostBundleIdentifier.endsWith('.dev') ? '"Mind Water Dev"' : '"Mind Water"',
  MINDWTR_HOST_BUNDLE_IDENTIFIER: `"${hostBundleIdentifier}"`,
  MINDWTR_WATCH_APP_GROUP: `"${appGroup}"`,
  PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
  PRODUCT_NAME: '"$(TARGET_NAME)"',
  SDKROOT: 'watchos',
  SKIP_INSTALL: 'YES',
  SUPPORTED_PLATFORMS: '"watchos watchsimulator"',
  SWIFT_EMIT_LOC_STRINGS: 'YES',
  SWIFT_VERSION: '5.0',
  TARGETED_DEVICE_FAMILY: '4',
  WATCHOS_DEPLOYMENT_TARGET: `"${WATCH_DEPLOYMENT_TARGET}"`,
  ...(widget ? { APPLICATION_EXTENSION_API_ONLY: 'YES' } : {}),
});

const addNativeTarget = (project, {
  name,
  productExtension,
  productType,
  buildSettings,
}) => {
  const targetUuid = project.generateUuid();
  const configurationList = project.addXCConfigurationList(
    [
      { name: 'Debug', isa: 'XCBuildConfiguration', buildSettings: { ...buildSettings, SWIFT_OPTIMIZATION_LEVEL: '"-Onone"' } },
      { name: 'Release', isa: 'XCBuildConfiguration', buildSettings: { ...buildSettings } },
    ],
    'Release',
    `Build configuration list for PBXNativeTarget "${name}"`,
  );
  const productFile = project.addProductFile(name, {
    basename: `${name}.${productExtension}`,
    explicitFileType: productExtension === 'app' ? 'wrapper.application' : 'wrapper.app-extension',
    group: productExtension === 'app' ? 'Embed Watch Content' : 'Embed Watch Extensions',
    includeInIndex: 0,
    path: `${name}.${productExtension}`,
    sourceTree: 'BUILT_PRODUCTS_DIR',
    target: targetUuid,
  });
  const target = {
    uuid: targetUuid,
    pbxNativeTarget: {
      isa: 'PBXNativeTarget',
      name,
      productName: name,
      productReference: productFile.fileRef,
      productType: `"${productType}"`,
      buildConfigurationList: configurationList.uuid,
      buildPhases: [],
      buildRules: [],
      dependencies: [],
    },
  };
  project.addToPbxNativeTargetSection(target);
  project.addToPbxProjectSection(target);
  return { target, productFile };
};

const addProductEmbedPhase = (project, parentTargetUuid, productFile, {
  name,
  targetType,
  destination,
}) => {
  project.addToPbxBuildFileSection(productFile);
  const phase = project.addBuildPhase(
    [],
    'PBXCopyFilesBuildPhase',
    name,
    parentTargetUuid,
    targetType,
    destination,
  );
  phase.buildPhase.files.push({
    value: productFile.uuid,
    comment: `${productFile.basename} in ${productFile.group}`,
  });
};

const addTargetGroup = (project, name, files) => {
  const groupUuid = project.generateUuid();
  const group = {
    isa: 'PBXGroup',
    children: [],
    name,
    path: name,
    sourceTree: '"<group>"',
  };
  const fileReferences = new Map();
  const groupSection = ensureSection(project, 'PBXGroup');

  for (const fileName of files) {
    // xcode's addPbxGroup and addBuildPhase helpers de-duplicate by path across
    // the whole project. The Watch app and widget intentionally have shared
    // filenames, so each target needs its own file reference beneath its own
    // group instead of reusing the other target's object.
    // Later plugins (notably the Share Extension) also use addBuildPhase's
    // global path lookup. Namespace paths from SOURCE_ROOT so their bare
    // PrivacyInfo.xcprivacy cannot reuse a Watch resource build file.
    const file = new PbxFile(path.posix.join(name, fileName));
    file.sourceTree = 'SOURCE_ROOT';
    file.fileRef = project.generateUuid();
    project.addToPbxFileReferenceSection(file);
    group.children.push({ value: file.fileRef, comment: file.basename });
    fileReferences.set(fileName, file);
  }

  groupSection[groupUuid] = group;
  groupSection[`${groupUuid}${COMMENT_SUFFIX}`] = name;
  const firstProject = project.getFirstProject();
  const rootGroupUuid = firstProject.firstProject.mainGroup;
  const rootGroup = groupSection[rootGroupUuid];
  if (rootGroup && !rootGroup.children.some((child) => child.value === groupUuid)) {
    rootGroup.children.push({ value: groupUuid, comment: name });
  }
  return { groupUuid, fileReferences };
};

const addTargetFileBuildPhase = (project, targetUuid, phaseType, phaseName, files) => {
  const phase = project.addBuildPhase([], phaseType, phaseName, targetUuid, undefined, '""');
  for (const file of files) {
    // A PBXBuildFile belongs to exactly one build phase. Reusing it between
    // Sources phases makes Ruby xcodeproj reject the graph during CocoaPods.
    const buildFile = {
      uuid: project.generateUuid(),
      fileRef: file.fileRef,
      basename: file.basename,
      group: phaseName,
    };
    project.addToPbxBuildFileSection(buildFile);
    phase.buildPhase.files.push({
      value: buildFile.uuid,
      comment: `${file.basename} in ${phaseName}`,
    });
  }
  return phase;
};

const addTargetBuildPhases = (project, targetUuid, targetNameValue, directory) => {
  const names = fs.readdirSync(directory, { withFileTypes: true });
  const swiftFiles = names.filter((entry) => entry.isFile() && entry.name.endsWith('.swift')).map((entry) => entry.name).sort();
  const resourceFiles = names
    .filter((entry) => entry.name === 'PrivacyInfo.xcprivacy'
      || entry.name.endsWith('.xcassets')
      || entry.name.endsWith('.xcstrings'))
    .map((entry) => entry.name)
    .sort();

  const groupedFiles = [
    ...swiftFiles,
    ...resourceFiles,
    'Info.plist',
    `${targetNameValue}.entitlements`,
  ];
  const { fileReferences } = addTargetGroup(project, targetNameValue, groupedFiles);
  addTargetFileBuildPhase(
    project,
    targetUuid,
    'PBXSourcesBuildPhase',
    'Sources',
    swiftFiles.map((name) => fileReferences.get(name)),
  );
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', targetUuid, undefined, '""');
  addTargetFileBuildPhase(
    project,
    targetUuid,
    'PBXResourcesBuildPhase',
    'Resources',
    resourceFiles.map((name) => fileReferences.get(name)),
  );
};

const deleteKeys = (section, keys) => {
  for (const key of keys) {
    delete section[key];
    delete section[`${key}${COMMENT_SUFFIX}`];
  }
};

const removeTargetDependencies = (project, removedTargetUuids) => {
  const targetDependencies = ensureSection(project, 'PBXTargetDependency');
  const proxies = ensureSection(project, 'PBXContainerItemProxy');
  const dependencyUuids = new Set();
  const proxyUuids = new Set();

  for (const [uuid, dependency] of Object.entries(targetDependencies)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !dependency) continue;
    const proxy = proxies[dependency.targetProxy];
    if (removedTargetUuids.has(dependency.target)
      || removedTargetUuids.has(proxy?.remoteGlobalIDString)) {
      dependencyUuids.add(uuid);
      if (dependency.targetProxy) proxyUuids.add(dependency.targetProxy);
    }
  }

  for (const [uuid, target] of Object.entries(ensureSection(project, 'PBXNativeTarget'))) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !target?.dependencies) continue;
    target.dependencies = target.dependencies.filter((entry) => !dependencyUuids.has(entry.value));
  }
  deleteKeys(targetDependencies, dependencyUuids);
  deleteKeys(proxies, proxyUuids);
};

const removeWatchTargetsFromProject = (project) => {
  const nativeTargets = ensureSection(project, 'PBXNativeTarget');
  const removedTargetUuids = new Set();
  const buildPhaseUuids = new Set();
  const configurationListUuids = new Set();
  const productFileRefs = new Set();

  for (const [uuid, target] of Object.entries(nativeTargets)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !target) continue;
    if (targetName(target) !== WATCH_TARGET_NAME && targetName(target) !== WIDGET_TARGET_NAME) continue;
    removedTargetUuids.add(uuid);
    for (const phase of target.buildPhases ?? []) buildPhaseUuids.add(phase.value);
    if (target.buildConfigurationList) configurationListUuids.add(target.buildConfigurationList);
    if (target.productReference) productFileRefs.add(target.productReference);
  }

  removeTargetDependencies(project, removedTargetUuids);

  const buildFileSection = ensureSection(project, 'PBXBuildFile');
  const buildFileUuids = new Set();
  for (const [uuid, buildFile] of Object.entries(buildFileSection)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !buildFile) continue;
    if (productFileRefs.has(buildFile.fileRef)) buildFileUuids.add(uuid);
  }

  for (const phaseType of ['PBXCopyFilesBuildPhase', 'PBXSourcesBuildPhase', 'PBXResourcesBuildPhase', 'PBXFrameworksBuildPhase']) {
    const phaseSection = ensureSection(project, phaseType);
    for (const [uuid, phase] of Object.entries(phaseSection)) {
      if (uuid.endsWith(COMMENT_SUFFIX) || !phase) continue;
      phase.files = (phase.files ?? []).filter((file) => !buildFileUuids.has(file.value));
      if (buildPhaseUuids.has(uuid)) {
        for (const file of phase.files) buildFileUuids.add(file.value);
      }
    }
  }

  for (const [uuid, target] of Object.entries(nativeTargets)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !target?.buildPhases) continue;
    target.buildPhases = target.buildPhases.filter((phase) => !buildPhaseUuids.has(phase.value));
  }

  const configurationLists = ensureSection(project, 'XCConfigurationList');
  const configurationUuids = new Set();
  for (const listUuid of configurationListUuids) {
    for (const entry of configurationLists[listUuid]?.buildConfigurations ?? []) configurationUuids.add(entry.value);
  }

  for (const projectValue of Object.values(ensureSection(project, 'PBXProject'))) {
    if (!projectValue || !Array.isArray(projectValue.targets)) continue;
    projectValue.targets = projectValue.targets.filter((entry) => !removedTargetUuids.has(entry.value));
    if (projectValue.attributes?.TargetAttributes) {
      for (const targetUuid of removedTargetUuids) {
        delete projectValue.attributes.TargetAttributes[targetUuid];
      }
    }
  }

  const groupSection = ensureSection(project, 'PBXGroup');
  const groupUuids = new Set();
  const ownedFileRefs = new Set(productFileRefs);
  for (const [uuid, group] of Object.entries(groupSection)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !group) continue;
    const name = unquote(group.name || group.path);
    if (name === WATCH_TARGET_NAME || name === WIDGET_TARGET_NAME) {
      groupUuids.add(uuid);
      for (const child of group.children ?? []) ownedFileRefs.add(child.value);
    }
  }
  for (const [uuid, group] of Object.entries(groupSection)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !group?.children) continue;
    group.children = group.children.filter((child) => !groupUuids.has(child.value) && !productFileRefs.has(child.value));
  }

  for (const [uuid, buildFile] of Object.entries(buildFileSection)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !buildFile) continue;
    if (ownedFileRefs.has(buildFile.fileRef)) buildFileUuids.add(uuid);
  }
  for (const phaseType of ['PBXCopyFilesBuildPhase', 'PBXSourcesBuildPhase', 'PBXResourcesBuildPhase', 'PBXFrameworksBuildPhase']) {
    const phaseSection = ensureSection(project, phaseType);
    for (const [uuid, phase] of Object.entries(phaseSection)) {
      if (uuid.endsWith(COMMENT_SUFFIX) || !phase?.files) continue;
      phase.files = phase.files.filter((file) => !buildFileUuids.has(file.value));
    }
    deleteKeys(phaseSection, buildPhaseUuids);
  }

  deleteKeys(buildFileSection, buildFileUuids);
  deleteKeys(ensureSection(project, 'PBXFileReference'), ownedFileRefs);
  deleteKeys(groupSection, groupUuids);
  deleteKeys(ensureSection(project, 'XCBuildConfiguration'), configurationUuids);
  deleteKeys(configurationLists, configurationListUuids);
  deleteKeys(nativeTargets, removedTargetUuids);

  // The plugin owns the Watch embed phase. Remove it after its product is gone,
  // while leaving any unrelated copy phase intact.
  const copyPhases = ensureSection(project, 'PBXCopyFilesBuildPhase');
  const emptyWatchEmbedPhases = new Set();
  for (const [uuid, phase] of Object.entries(copyPhases)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !phase) continue;
    if (unquote(phase.name) === 'Embed Watch Content' && (phase.files ?? []).length === 0) {
      emptyWatchEmbedPhases.add(uuid);
    }
  }
  for (const [uuid, target] of Object.entries(nativeTargets)) {
    if (uuid.endsWith(COMMENT_SUFFIX) || !target?.buildPhases) continue;
    target.buildPhases = target.buildPhases.filter((phase) => !emptyWatchEmbedPhases.has(phase.value));
  }
  deleteKeys(copyPhases, emptyWatchEmbedPhases);
};

const addWatchTargetsToProject = (project, options) => {
  const {
    hostBundleIdentifier,
    currentProjectVersion,
    marketingVersion,
    watchDirectory,
    widgetDirectory,
  } = options;
  const watchBundleIdentifier = `${hostBundleIdentifier}.watchkitapp`;
  const widgetBundleIdentifier = `${watchBundleIdentifier}.widgets`;
  const appGroup = `group.${hostBundleIdentifier}.watch`;

  ensureSection(project, 'PBXTargetDependency');
  ensureSection(project, 'PBXContainerItemProxy');

  const watch = addNativeTarget(project, {
    name: WATCH_TARGET_NAME,
    productExtension: 'app',
    productType: WATCH_PRODUCT_TYPE,
    buildSettings: configurationSettings({
      target: WATCH_TARGET_NAME,
      bundleIdentifier: watchBundleIdentifier,
      hostBundleIdentifier,
      appGroup,
      currentProjectVersion,
      marketingVersion,
      widget: false,
    }),
  });
  const widget = addNativeTarget(project, {
    name: WIDGET_TARGET_NAME,
    productExtension: 'appex',
    productType: WIDGET_PRODUCT_TYPE,
    buildSettings: configurationSettings({
      target: WIDGET_TARGET_NAME,
      bundleIdentifier: widgetBundleIdentifier,
      hostBundleIdentifier,
      appGroup,
      currentProjectVersion,
      marketingVersion,
      widget: true,
    }),
  });

  addTargetBuildPhases(project, watch.target.uuid, WATCH_TARGET_NAME, watchDirectory);
  addTargetBuildPhases(project, widget.target.uuid, WIDGET_TARGET_NAME, widgetDirectory);
  addProductEmbedPhase(project, project.getFirstTarget().uuid, watch.productFile, {
    name: 'Embed Watch Content',
    targetType: 'watch2_app',
    destination: '"$(CONTENTS_FOLDER_PATH)/Watch"',
  });
  addProductEmbedPhase(project, watch.target.uuid, widget.productFile, {
    // xcode.buildPhaseObject falls back to a global name lookup if the host
    // has no matching phase yet. Keep this distinct from iPhone extensions.
    name: 'Embed Watch Extensions',
    targetType: 'app_extension',
    destination: '""',
  });
  project.addTargetDependency(project.getFirstTarget().uuid, [watch.target.uuid]);
  project.addTargetDependency(watch.target.uuid, [widget.target.uuid]);

  const firstProject = project.getFirstProject();
  const attributes = firstProject.firstProject.attributes ?? (firstProject.firstProject.attributes = {});
  const targetAttributes = attributes.TargetAttributes ?? (attributes.TargetAttributes = {});
  targetAttributes[watch.target.uuid] = { CreatedOnToolsVersion: '16.0', ProvisioningStyle: 'Automatic' };
  targetAttributes[widget.target.uuid] = { CreatedOnToolsVersion: '16.0', ProvisioningStyle: 'Automatic' };
};

const reconcileWatchProject = (project, options) => {
  removeWatchTargetsFromProject(project);
  if (options.enabled) addWatchTargetsToProject(project, options);
  return project;
};

const reconcileEasExtensions = (config, enabled) => {
  const hostBundleIdentifier = config.ios?.bundleIdentifier || 'tech.dongdongbh.mindwtr';
  const watchBundleIdentifier = `${hostBundleIdentifier}.watchkitapp`;
  const appGroup = `group.${hostBundleIdentifier}.watch`;
  const existing = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  const withoutWatch = existing.filter((extension) => (
    extension?.targetName !== WATCH_TARGET_NAME && extension?.targetName !== WIDGET_TARGET_NAME
  ));
  const appExtensions = enabled ? [
    ...withoutWatch,
    {
      targetName: WATCH_TARGET_NAME,
      bundleIdentifier: watchBundleIdentifier,
      entitlements: { 'com.apple.security.application-groups': [appGroup] },
    },
    {
      targetName: WIDGET_TARGET_NAME,
      bundleIdentifier: `${watchBundleIdentifier}.widgets`,
      entitlements: { 'com.apple.security.application-groups': [appGroup] },
    },
  ] : withoutWatch;

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
            appExtensions,
          },
        },
      },
    },
  };
  return config;
};

const withWatchInfoPlist = (enabled) => (config) => withInfoPlist(config, (cfg) => {
  cfg.modResults.MindwtrWatchEnabled = enabled;
  return cfg;
});

const withWatchTargets = (enabled) => (config) => withXcodeProject(config, async (cfg) => {
  const projectRoot = cfg.modRequest.projectRoot;
  const platformProjectRoot = cfg.modRequest.platformProjectRoot;
  let directories = {};
  if (enabled) directories = await copyWatchSources({ projectRoot, platformProjectRoot });
  else removeGeneratedWatchDirectories(platformProjectRoot);

  reconcileWatchProject(cfg.modResults, {
    enabled,
    hostBundleIdentifier: cfg.ios?.bundleIdentifier || 'tech.dongdongbh.mindwtr',
    currentProjectVersion: cfg.ios?.buildNumber || '1',
    marketingVersion: cfg.version || '1.0.0',
    ...directories,
  });
  return cfg;
});

function withIosWatch(config, props = {}) {
  const enabled = props.enabled === true;
  reconcileEasExtensions(config, enabled);
  return withPlugins(config, [
    withWatchInfoPlist(enabled),
    withWatchTargets(enabled),
  ]);
}

module.exports = withIosWatch;
module.exports.__testables = {
  WATCH_DEPLOYMENT_TARGET,
  WATCH_GENERATED_FOLDER,
  WATCH_PRODUCT_TYPE,
  WATCH_SOURCE_FOLDER,
  WATCH_TARGET_NAME,
  WIDGET_GENERATED_FOLDER,
  WIDGET_PRODUCT_TYPE,
  WIDGET_TARGET_NAME,
  configurationSettings,
  copyWatchSources,
  reconcileEasExtensions,
  reconcileWatchProject,
  removeGeneratedWatchDirectories,
  removeWatchTargetsFromProject,
};
