#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');


const expectedHostDeploymentTarget = '16.4';
const expectedSceneDelegate = 'MindwtrSceneDelegate';
const launchScreenKeys = [
  'UILaunchStoryboardName',
  'UILaunchStoryboards',
  'UILaunchScreen',
  'UILaunchScreens',
];

const fail = (message) => {
  throw new Error(`[ios-scene-lifecycle] ${message}`);
};

const directElements = (node) => {
  const result = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child);
  }
  return result;
};

const parsePlistValue = (node) => {
  switch (node.nodeName) {
    case 'dict': {
      const children = directElements(node);
      const value = {};
      for (let index = 0; index < children.length; index += 2) {
        const keyNode = children[index];
        const valueNode = children[index + 1];
        if (keyNode?.nodeName !== 'key' || !valueNode) {
          fail('Info.plist contains a malformed dictionary.');
        }
        value[keyNode.textContent] = parsePlistValue(valueNode);
      }
      return value;
    }
    case 'array':
      return directElements(node).map(parsePlistValue);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'integer':
      return Number.parseInt(node.textContent, 10);
    case 'real':
      return Number.parseFloat(node.textContent);
    case 'data':
    case 'date':
    case 'string':
      return node.textContent;
    default:
      fail(`Info.plist contains an unsupported ${node.nodeName} value.`);
  }
};

const parsePlist = (filePath) => {
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(fs.readFileSync(filePath, 'utf8'), 'application/xml');
  if (errors.length > 0) {
    fail(`Unable to parse ${filePath}: ${errors.join('; ')}`);
  }
  const plist = document.documentElement;
  const root = directElements(plist)[0];
  if (plist?.nodeName !== 'plist' || root?.nodeName !== 'dict') {
    fail(`${filePath} is not an XML property-list dictionary.`);
  }
  return parsePlistValue(root);
};

const walkFiles = (directory, predicate) => {
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'Pods' || entry.name === 'build') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (predicate(absolute, entry.name)) matches.push(absolute);
    }
  };
  visit(directory);
  return matches;
};

const objectBlockAt = (source, start) => {
  const openingBrace = source.indexOf('{', start);
  if (openingBrace < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
};

const findObjectBlock = (project, objectId) => {
  const pattern = new RegExp(`(?:^|\\n)\\s*${objectId} \\/\\*[^\\n]*?\\*\\/ = \\{`, 'm');
  const match = pattern.exec(project);
  return match ? objectBlockAt(project, match.index) : null;
};

const findHostTarget = (project) => {
  const objectPattern = /(?:^|\n)\s*([A-F0-9]{24}) \/\* Mindwtr \*\/ = \{/g;
  for (const match of project.matchAll(objectPattern)) {
    const block = objectBlockAt(project, match.index);
    if (block?.includes('isa = PBXNativeTarget;') && /\bname = "?Mindwtr"?;/.test(block)) {
      return block;
    }
  }
  fail('Mindwtr PBXNativeTarget is missing from the generated Xcode project.');
};

const listObjectIds = (block, property) => {
  const list = block.match(new RegExp(`${property} = \\(\\s*([\\s\\S]*?)\\s*\\);`))?.[1] ?? '';
  return [...list.matchAll(/([A-F0-9]{24}) \/\*/g)].map((match) => match[1]);
};

const validateSourceRegistration = (project) => {
  if (!project.includes(`${expectedSceneDelegate}.swift`)) {
    fail(`${expectedSceneDelegate}.swift has no Xcode project reference.`);
  }
  const target = findHostTarget(project);
  const sourcePhases = listObjectIds(target, 'buildPhases')
    .map((id) => findObjectBlock(project, id))
    .filter((block) => block?.includes('isa = PBXSourcesBuildPhase;'));
  if (sourcePhases.length !== 1) {
    fail(`Expected one Sources build phase for the Mindwtr target, found ${sourcePhases.length}.`);
  }
  if (!sourcePhases[0].includes(`${expectedSceneDelegate}.swift in Sources`)) {
    fail(`${expectedSceneDelegate}.swift is not compiled by the Mindwtr host target.`);
  }
};

const versionParts = (version) => version.split('.').map((part) => Number.parseInt(part, 10));
const compareVersions = (left, right) => {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const validateDeploymentTarget = (project, infoPlist) => {
  const target = findHostTarget(project);
  const configurationListId = target.match(/buildConfigurationList = ([A-F0-9]{24}) \/\*/)?.[1];
  if (!configurationListId) {
    fail('Mindwtr host target has no build configuration list.');
  }
  const configurationList = findObjectBlock(project, configurationListId);
  if (!configurationList) {
    fail('Mindwtr host build configuration list is missing from the generated project.');
  }
  const configurationIds = listObjectIds(configurationList, 'buildConfigurations');
  if (configurationIds.length === 0) {
    fail('Mindwtr host target has no build configurations.');
  }
  for (const configurationId of configurationIds) {
    const configuration = findObjectBlock(project, configurationId);
    const deploymentTarget = configuration?.match(
      /IPHONEOS_DEPLOYMENT_TARGET = "?([0-9]+(?:\.[0-9]+)*)"?;/,
    )?.[1];
    if (!deploymentTarget) {
      fail(`Mindwtr host build configuration ${configurationId} has no explicit iOS deployment target.`);
    }
    if (compareVersions(deploymentTarget, expectedHostDeploymentTarget) !== 0) {
      fail(`Mindwtr host deployment floor is iOS ${deploymentTarget} in build configuration ${configurationId}; expected ${expectedHostDeploymentTarget}.`);
    }
  }
  if (
    infoPlist.MinimumOSVersion !== undefined
    && infoPlist.MinimumOSVersion !== expectedHostDeploymentTarget
  ) {
    fail(`Info.plist MinimumOSVersion is ${infoPlist.MinimumOSVersion}; expected ${expectedHostDeploymentTarget}.`);
  }
};

const functionBodyContaining = (source, marker) => {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const openingBrace = source.indexOf('{', markerIndex);
  if (openingBrace < 0) return null;
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace, index + 1);
    }
  }
  return null;
};

const validateSwiftLifecycle = (sceneSource, appDelegateSource) => {
  if (!/class\s+MindwtrSceneDelegate\b/.test(sceneSource)) {
    fail(`${expectedSceneDelegate}.swift does not declare ${expectedSceneDelegate}.`);
  }
  if (!/UIWindowSceneDelegate/.test(sceneSource)) {
    fail(`${expectedSceneDelegate} does not conform to UIWindowSceneDelegate.`);
  }
  const connectBody = functionBodyContaining(sceneSource, 'willConnectTo');
  if (!connectBody) fail(`${expectedSceneDelegate} has no scene willConnectTo implementation.`);
  if (!/appDelegate\.mindwtrStartReactNative\s*\(/.test(connectBody)) {
    fail(`${expectedSceneDelegate}.willConnectTo does not hand root startup to AppDelegate.`);
  }
  if (!/\.windowScene\s*=\s*windowScene\b/.test(connectBody)) {
    fail(`${expectedSceneDelegate}.willConnectTo does not attach the window to its UIWindowScene.`);
  }
  for (const stage of ['sceneConnected', 'rootStarted', 'coldDelivery', 'warmDelivery']) {
    if (!sceneSource.includes(`stage: "${stage}"`)) {
      fail(`${expectedSceneDelegate} does not emit the ${stage} validation marker.`);
    }
  }
  const combined = `${sceneSource}\n${appDelegateSource}`;
  if (/UIScreen\s*\.\s*main\b/.test(combined) || /UIWindow\s*\(\s*frame\s*:/.test(combined)) {
    fail('Generated lifecycle uses legacy screen geometry instead of UIWindowScene geometry.');
  }
  const launchBody = functionBodyContaining(appDelegateSource, 'didFinishLaunchingWithOptions');
  if (!launchBody) fail('Generated AppDelegate has no didFinishLaunchingWithOptions implementation.');
  const legacyRootPatterns = [
    /startReactNative\s*\(/,
    /RCTAppSetupPrepareApp\s*\(/,
    /rootViewController\s*=/,
    /makeKeyAndVisible\s*\(/,
  ];
  if (legacyRootPatterns.some((pattern) => pattern.test(launchBody))) {
    fail('AppDelegate.didFinishLaunchingWithOptions still performs legacy root-window startup.');
  }
};

const validate = (iosDirectory) => {
  const resolvedDirectory = path.resolve(iosDirectory);
  if (!fs.statSync(resolvedDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Generated iOS directory does not exist: ${resolvedDirectory}`);
  }

  const infoCandidates = walkFiles(
    resolvedDirectory,
    (_absolute, name) => name === 'Info.plist',
  ).map((filePath) => ({ filePath, value: parsePlist(filePath) }));
  const scenePlists = infoCandidates.filter(({ value }) => value.UIApplicationSceneManifest);
  if (scenePlists.length !== 1) {
    fail(`Expected one generated Info.plist with UIApplicationSceneManifest, found ${scenePlists.length}.`);
  }
  const { filePath: infoPath, value: infoPlist } = scenePlists[0];
  if (!launchScreenKeys.some((key) => infoPlist[key] !== undefined)) {
    fail(`Generated Info.plist has none of the iOS 27 launch screen keys: ${launchScreenKeys.join(', ')}.`);
  }
  const manifest = infoPlist.UIApplicationSceneManifest;
  if (manifest.UIApplicationSupportsMultipleScenes !== false) {
    fail('UIApplicationSceneManifest must explicitly disable multiple scenes.');
  }
  const configurations = manifest.UISceneConfigurations?.UIWindowSceneSessionRoleApplication;
  if (!Array.isArray(configurations) || configurations.length !== 1
      || configurations[0]?.UISceneConfigurationName !== 'Default Configuration'
      || configurations[0]?.UISceneDelegateClassName !== `$(PRODUCT_MODULE_NAME).${expectedSceneDelegate}`) {
    fail(`UIApplicationSceneManifest does not point its single application configuration at $(PRODUCT_MODULE_NAME).${expectedSceneDelegate}.`);
  }

  const sceneSources = walkFiles(
    resolvedDirectory,
    (_absolute, name) => name === `${expectedSceneDelegate}.swift`,
  );
  if (sceneSources.length !== 1) {
    fail(`Expected one generated ${expectedSceneDelegate}.swift, found ${sceneSources.length}.`);
  }
  const appDelegates = walkFiles(
    resolvedDirectory,
    (_absolute, name) => name === 'AppDelegate.swift',
  );
  if (appDelegates.length !== 1) {
    fail(`Expected one generated AppDelegate.swift, found ${appDelegates.length}.`);
  }
  const projectFiles = walkFiles(
    resolvedDirectory,
    (_absolute, name) => name === 'project.pbxproj',
  );
  if (projectFiles.length !== 1) {
    fail(`Expected one generated project.pbxproj, found ${projectFiles.length}.`);
  }

  const project = fs.readFileSync(projectFiles[0], 'utf8');
  validateSourceRegistration(project);
  validateDeploymentTarget(project, infoPlist);
  validateSwiftLifecycle(
    fs.readFileSync(sceneSources[0], 'utf8'),
    fs.readFileSync(appDelegates[0], 'utf8'),
  );

  console.log(`Validated scene lifecycle in ${path.relative(process.cwd(), resolvedDirectory) || '.'}:`);
  console.log(`- manifest: ${path.relative(resolvedDirectory, infoPath)}`);
  console.log(`- scene delegate: ${path.relative(resolvedDirectory, sceneSources[0])}`);
  console.log(`- host deployment floor: iOS ${expectedHostDeploymentTarget}`);
};

if (require.main === module) {
  try {
    validate(process.argv[2] ?? 'apps/mobile/ios');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = { validate };
