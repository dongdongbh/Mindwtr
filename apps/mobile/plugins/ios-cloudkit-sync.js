const {
  withEntitlementsPlist,
  withInfoPlist,
  withPlugins,
} = require('@expo/config-plugins');

const CLOUDKIT_CONTAINER = 'iCloud.tech.dongdongbh.mindwtr';


const withCloudKitEntitlements = (config) => {
  return withEntitlementsPlist(config, (mod) => {
    const entitlements = mod.modResults;


    entitlements['com.apple.developer.icloud-services'] = ['CloudKit'];


    const containers = entitlements['com.apple.developer.icloud-container-identifiers'] ?? [];
    if (!containers.includes(CLOUDKIT_CONTAINER)) {
      containers.push(CLOUDKIT_CONTAINER);
    }
    entitlements['com.apple.developer.icloud-container-identifiers'] = containers;


    if (!entitlements['aps-environment']) {
      entitlements['aps-environment'] = 'production';
    }

    return mod;
  });
};


const withRemoteNotificationBackground = (config) => {
  return withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    const modes = plist.UIBackgroundModes ?? [];
    if (!modes.includes('remote-notification')) {
      modes.push('remote-notification');
    }
    plist.UIBackgroundModes = modes;
    return mod;
  });
};

const withCloudKitSync = (config) => {
  return withPlugins(config, [
    withCloudKitEntitlements,
    withRemoteNotificationBackground,
  ]);
};

module.exports = withCloudKitSync;
