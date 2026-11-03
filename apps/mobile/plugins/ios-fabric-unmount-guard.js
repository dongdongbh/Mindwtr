const fs = require('fs');
const path = require('path');
const { IOSConfig, withXcodeProject } = require('@expo/config-plugins');


const NATIVE_SOURCES_FOLDER = 'ios-native';
const SOURCE_EXTENSIONS = ['.h', '.m', '.mm'];

const collectNativeSources = (sourceDir) => {
  if (!fs.existsSync(sourceDir)) return [];
  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort();
};

const isCompiledSource = (fileName) => path.extname(fileName) !== '.h';


const withFabricUnmountGuard = (config) =>
  withXcodeProject(config, (cfg) => {
    const xcodeProject = cfg.modResults;
    const appName = IOSConfig.XcodeUtils.sanitizedName(cfg.name);
    const sourceDir = path.join(cfg.modRequest.projectRoot, NATIVE_SOURCES_FOLDER);
    const targetDir = path.join(cfg.modRequest.platformProjectRoot, appName);

    const fileNames = collectNativeSources(sourceDir);
    if (fileNames.length === 0) {
      throw new Error(`[ios-fabric-unmount-guard] No native sources found in ${sourceDir}`);
    }

    const groupKey =
      xcodeProject.findPBXGroupKey({ name: appName }) || xcodeProject.findPBXGroupKey({ path: appName });
    if (!groupKey) {
      throw new Error(`[ios-fabric-unmount-guard] Could not find main iOS group: ${appName}`);
    }

    const targetUuid = xcodeProject.getFirstTarget().uuid;
    fs.mkdirSync(targetDir, { recursive: true });

    for (const fileName of fileNames) {
      fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));

      const filePath = `${appName}/${fileName}`;
      if (xcodeProject.hasFile(filePath)) continue;
      if (isCompiledSource(fileName)) {
        xcodeProject.addSourceFile(filePath, { target: targetUuid }, groupKey);
      } else {
        xcodeProject.addHeaderFile(filePath, {}, groupKey);
      }
    }

    return cfg;
  });

module.exports = withFabricUnmountGuard;
module.exports.__testables = {
  NATIVE_SOURCES_FOLDER,
  collectNativeSources,
  isCompiledSource,
};
