const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const MLKIT_ACTIVITY = 'com.google.mlkit.vision.codescanner.internal.GmsBarcodeScanningDelegateActivity';
const MAIN_ACTIVITY = '.MainActivity';
// Fully qualified: these classes live in the local context-automation Expo
// module (apps/mobile/modules/context-automation), not the app's own package,
// so the manifest-relative `.ClassName` shorthand no longer resolves.
const CONTEXT_AUTOMATION_HEADLESS_SERVICE = 'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationHeadlessService';
const CONTEXT_AUTOMATION_RECEIVER = 'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver';
const CONTEXT_INTENT_ACTIONS = [
  'tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT',
  'tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT',
];
const GMS_MODULE_DEPENDENCIES_SERVICE = 'com.google.android.gms.metadata.ModuleDependencies';
const PERMISSIONS_TO_REMOVE = [
  'android.permission.CAMERA',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
];
const isFossBuild = process.env.FOSS_BUILD === '1' || process.env.FOSS_BUILD === 'true';
const androidProfileableEnabled =
    process.env.ANDROID_PROFILEABLE === '1' || process.env.ANDROID_PROFILEABLE === 'true';

const ensureArray = (target, key) => {
  if (!Array.isArray(target[key])) {
    target[key] = [];
  }
  return target[key];
};

const hasAction = (filter, actionName) => (
  Array.isArray(filter.action)
  && filter.action.some((action) => action?.$?.['android:name'] === actionName)
);

const hasCategory = (filter, categoryName) => (
  Array.isArray(filter.category)
  && filter.category.some((category) => category?.$?.['android:name'] === categoryName)
);

const hasDataScheme = (filter, scheme) => (
  Array.isArray(filter.data)
  && filter.data.some((data) => data?.$?.['android:scheme'] === scheme)
);

const hasContextIntentFilter = (filter, { dataScheme } = {}) => (
  CONTEXT_INTENT_ACTIONS.every((actionName) => hasAction(filter, actionName))
  && hasCategory(filter, 'android.intent.category.DEFAULT')
  && (dataScheme ? hasDataScheme(filter, dataScheme) : !Array.isArray(filter.data))
);

const buildContextIntentFilter = ({ dataScheme } = {}) => ({
  action: CONTEXT_INTENT_ACTIONS.map((actionName) => ({
    $: { 'android:name': actionName },
  })),
  category: [
    { $: { 'android:name': 'android.intent.category.DEFAULT' } },
  ],
  ...(dataScheme
    ? { data: [{ $: { 'android:scheme': dataScheme } }] }
    : {}),
});

const ensureContextIntentFilters = (activity) => {
  const filters = ensureArray(activity, 'intent-filter');
  if (!filters.some((filter) => hasContextIntentFilter(filter))) {
    filters.push(buildContextIntentFilter());
  }
  if (!filters.some((filter) => hasContextIntentFilter(filter, { dataScheme: 'mindwtr' }))) {
    filters.push(buildContextIntentFilter({ dataScheme: 'mindwtr' }));
  }
};

const removeContextIntentFilters = (activity) => {
  if (!Array.isArray(activity['intent-filter'])) return;
  activity['intent-filter'] = activity['intent-filter'].filter((filter) => (
    !hasContextIntentFilter(filter) && !hasContextIntentFilter(filter, { dataScheme: 'mindwtr' })
  ));
};

const ensureContextAutomationReceiver = (application) => {
  const receivers = ensureArray(application, 'receiver');
  let receiver = receivers.find((entry) => entry?.$?.['android:name'] === CONTEXT_AUTOMATION_RECEIVER);
  if (!receiver) {
    receiver = { $: {} };
    receivers.push(receiver);
  }

  receiver.$['android:name'] = CONTEXT_AUTOMATION_RECEIVER;
  receiver.$['android:exported'] = 'true';
  ensureContextIntentFilters(receiver);
};

const ensureContextAutomationHeadlessService = (application) => {
    const services = ensureArray(application, 'service');
    let service = services.find((entry) => entry?.$?.['android:name'] === CONTEXT_AUTOMATION_HEADLESS_SERVICE);
  if (!service) {
    service = { $: {} };
    services.push(service);
  }

    service.$['android:name'] = CONTEXT_AUTOMATION_HEADLESS_SERVICE;
    service.$['android:exported'] = 'false';
};

// expo-secure-store ships `<include domain="sharedpref" path="."/>`, which
// enrols every present and future SharedPreferences file in Google cloud backup
// and device transfer. Mindwtr owns its rules instead and enrols nothing: sync
// has its own transport, and an app whose data lives in SQLite has nothing in
// sharedpref worth shipping to Google. An exhaustive include list naming a path
// that never exists is how the platform spells "nothing" — an empty rule set
// means "everything". `android:allowBackup` is untouched.
const BACKUP_RULES_FILE_NAME = 'mindwtr_backup_rules.xml';
const DATA_EXTRACTION_RULES_FILE_NAME = 'mindwtr_data_extraction_rules.xml';
const BACKUP_RULES_RESOURCE = '@xml/mindwtr_backup_rules';
const DATA_EXTRACTION_RULES_RESOURCE = '@xml/mindwtr_data_extraction_rules';

const BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Auto Backup configuration for Android 11 and lower. Generated by plugins/android-manifest-fixes.js. -->
<full-backup-content>
  <include domain="sharedpref" path="mindwtr_backup_none"/>
</full-backup-content>
`;

const DATA_EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Auto Backup configuration for Android 12 and higher. Generated by plugins/android-manifest-fixes.js. -->
<data-extraction-rules>
  <cloud-backup>
    <include domain="sharedpref" path="mindwtr_backup_none"/>
  </cloud-backup>
  <device-transfer>
    <include domain="sharedpref" path="mindwtr_backup_none"/>
  </device-transfer>
</data-extraction-rules>
`;

const ensureBackupRules = (application) => {
  application.$['android:fullBackupContent'] = BACKUP_RULES_RESOURCE;
  application.$['android:dataExtractionRules'] = DATA_EXTRACTION_RULES_RESOURCE;
};

const setProfileable = (application, enabled = androidProfileableEnabled) => {
    if (enabled) {
        application.profileable = [
            {
                $: {
                    'android:shell': 'true',
                },
            },
        ];
    } else {
        delete application.profileable;
    }
};

const mergeToolsRemove = (existing, attribute) => [...new Set(
  [...(Array.isArray(existing) ? existing : [existing ?? '']), attribute]
    .flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean),
)].join(',');

const ensureConfigChange = (existing, configChange) => [...new Set(
  `${existing ?? ''}|${configChange}`
    .split('|').map((value) => value.trim()).filter(Boolean),
)].join('|');

module.exports = function withAndroidManifestFixes(config) {
  const withBackupRuleFiles = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      await fs.promises.mkdir(xmlDir, { recursive: true });
      await fs.promises.writeFile(path.join(xmlDir, BACKUP_RULES_FILE_NAME), BACKUP_RULES_XML, 'utf8');
      await fs.promises.writeFile(path.join(xmlDir, DATA_EXTRACTION_RULES_FILE_NAME), DATA_EXTRACTION_RULES_XML, 'utf8');
      return cfg;
    },
  ]);

  return withAndroidManifest(withBackupRuleFiles, (config) => {
    const manifest = config.modResults;

    if (!manifest.manifest.$) {
      manifest.manifest.$ = {};
    }
    if (!manifest.manifest.$['xmlns:tools']) {
      manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = manifest.manifest.application?.[0];
    if (!application) {
      return config;
    }
    if (!application.$) {
        application.$ = {};
    }
    setProfileable(application);
    ensureBackupRules(application);
    application.$['android:resizeableActivity'] = 'true';
    // WebDAV sync allows HTTP only for localhost, private IPs, and local hostnames in app code.
    // Android still needs cleartext enabled at the manifest level for those private endpoints.
    application.$['android:usesCleartextTraffic'] = 'true';

    const existingSupportsScreens = manifest.manifest['supports-screens']?.[0]?.$ ?? {};
    manifest.manifest['supports-screens'] = [
      {
        $: {
          ...existingSupportsScreens,
          'android:smallScreens': 'true',
          'android:normalScreens': 'true',
          'android:largeScreens': 'true',
          'android:xlargeScreens': 'true',
          'android:anyDensity': 'true',
          'android:resizeable': 'true',
        },
      },
    ];

    if (!Array.isArray(application.activity)) {
      application.activity = [];
    }

    let didUpdateMainActivity = false;
    let didUpdateMlkit = false;
    application.activity.forEach((activity) => {
      if (activity.$ && activity.$['android:name'] === MAIN_ACTIVITY) {
        // Explicitly allow both portrait and landscape on tablets/Chromebooks.
        activity.$['android:screenOrientation'] = 'fullUser';
        activity.$['android:resizeableActivity'] = 'true';
        activity.$['android:configChanges'] = ensureConfigChange(
          activity.$['android:configChanges'],
          'smallestScreenSize',
        );
        removeContextIntentFilters(activity);
        didUpdateMainActivity = true;
      }
      if (activity.$ && activity.$['android:name'] === MLKIT_ACTIVITY) {
        // Remove forced orientation for large screens.
        delete activity.$['android:screenOrientation'];
        activity.$['tools:remove'] = mergeToolsRemove(activity.$['tools:remove'], 'android:screenOrientation');
        didUpdateMlkit = true;
      }
    });

    if (!didUpdateMainActivity) {
      application.activity.push({
        $: {
          'android:name': MAIN_ACTIVITY,
          'android:screenOrientation': 'fullUser',
          'android:resizeableActivity': 'true',
          'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize',
          'tools:node': 'merge',
        },
      });
    }

    ensureContextAutomationReceiver(application);
    ensureContextAutomationHeadlessService(application);

    if (!didUpdateMlkit && application.activity.length > 0) {
      application.activity.push({
        $: {
          'android:name': MLKIT_ACTIVITY,
          'tools:remove': 'android:screenOrientation',
        },
      });
    }

    if (!Array.isArray(manifest.manifest['uses-permission'])) {
      manifest.manifest['uses-permission'] = [];
    }
    const permissions = manifest.manifest['uses-permission'];
    PERMISSIONS_TO_REMOVE.forEach((permissionName) => {
      const existingPermission = permissions.find(
        (permission) => permission?.$?.['android:name'] === permissionName
      );
      if (existingPermission?.$) {
        existingPermission.$['tools:node'] = 'remove';
        return;
      }
      permissions.push({
        $: {
          'android:name': permissionName,
          'tools:node': 'remove',
        },
      });
    });

    if (isFossBuild) {
      if (!Array.isArray(application.service)) {
        application.service = [];
      }

      let didMarkForRemoval = false;
      application.service.forEach((service) => {
        if (service?.$?.['android:name'] === GMS_MODULE_DEPENDENCIES_SERVICE) {
          service.$['tools:node'] = 'remove';
          didMarkForRemoval = true;
        }
      });

      if (!didMarkForRemoval) {
        application.service.push({
          $: {
            'android:name': GMS_MODULE_DEPENDENCIES_SERVICE,
            'tools:node': 'remove',
          },
        });
      }
    }

    return config;
  });
};

module.exports.__testables = {
  mergeToolsRemove,
    ensureConfigChange,
    BACKUP_RULES_XML,
    DATA_EXTRACTION_RULES_XML,
    buildContextIntentFilter,
    ensureBackupRules,
    ensureContextAutomationHeadlessService,
    ensureContextAutomationReceiver,
    removeContextIntentFilters,
    setProfileable,
};
