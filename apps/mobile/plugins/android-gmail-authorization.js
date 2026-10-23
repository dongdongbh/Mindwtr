const { withAndroidManifest } = require('@expo/config-plugins');

const setGmailMetadata = (manifest, enabled) => {
  const application = manifest.manifest.application?.[0];
  if (!application) throw new Error('Android application manifest is unavailable');
  const metadata = (application['meta-data'] ?? []).filter(
    (entry) => entry.$?.['android:name'] !== 'MindwtrGmailEnabled',
  );
  metadata.push({ $: { 'android:name': 'MindwtrGmailEnabled', 'android:value': String(enabled === true) } });
  application['meta-data'] = metadata;
  return manifest;
};

module.exports = (config, { enabled = false } = {}) => withAndroidManifest(config, (modConfig) => {
  setGmailMetadata(modConfig.modResults, enabled);
  return modConfig;
});

module.exports.__testables = { setGmailMetadata };
