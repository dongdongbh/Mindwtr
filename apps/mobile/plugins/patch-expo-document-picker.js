const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');


const MODULE_RELATIVE_PATH = path.join(
  'expo-document-picker',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'documentpicker',
  'DocumentPickerModule.kt'
);

const getModuleCandidates = (projectRoot) => [
  path.join(projectRoot, 'node_modules', MODULE_RELATIVE_PATH),
  path.join(projectRoot, '..', '..', 'node_modules', MODULE_RELATIVE_PATH),
];

const APPLIED_MARKER = 'Mindwtr: keep an uncopied document readable after a reboot';

const ANCHOR = `    val details = if (!copyToCacheDirectory) {
      originalDocumentDetails
    } else {`;

const PATCHED = `    val details = if (!copyToCacheDirectory) {
      // ${APPLIED_MARKER} (the app keeps this URI).
      try {
        context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: SecurityException) {
        // The provider offers no persistable grant: the pick reads as before, until the process ends.
      }
      originalDocumentDetails
    } else {`;

const applyPersistableGrant = (original) =>
  original.includes(APPLIED_MARKER) || !original.includes(ANCHOR) ? original : original.replace(ANCHOR, PATCHED);

const patchModuleSource = (projectRoot) => {
  let satisfied = false;
  for (const candidate of getModuleCandidates(projectRoot)) {
    if (!fs.existsSync(candidate)) continue;
    const original = fs.readFileSync(candidate, 'utf8');
    const next = applyPersistableGrant(original);
    if (!next.includes(APPLIED_MARKER)) continue;
    if (next !== original) {
      fs.writeFileSync(candidate, next);
      console.log(`[patch-expo-document-picker] patched ${candidate}`);
    }
    satisfied = true;
  }
  if (!satisfied) {
    throw new Error(
      'patch-expo-document-picker did not apply and its marker was not found. '
      + 'DocumentPickerModule.kt likely changed upstream - recheck the anchor in '
      + 'plugins/patch-expo-document-picker.js.'
    );
  }
  return satisfied;
};

const withExpoDocumentPickerPatch = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      patchModuleSource(cfg.modRequest.projectRoot);
      return cfg;
    },
  ]);

module.exports = withExpoDocumentPickerPatch;
module.exports.__testables = {
  APPLIED_MARKER,
  applyPersistableGrant,
  getModuleCandidates,
  patchModuleSource,
};
