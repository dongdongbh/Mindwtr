const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');

const MAIN_ACTIVITY_SUFFIX = '.MainActivity';
const SHORTCUTS_RESOURCE = '@xml/mindwtr_shortcuts';
const SHORTCUTS_FILE_NAME = 'mindwtr_shortcuts.xml';
const SHORTCUTS_STRINGS_FILE_NAME = 'mindwtr_shortcuts_strings.xml';
const ANDROIDX_CORE_DEPENDENCY = 'implementation "androidx.core:core:1.13.1"';
const CREATE_NOTE_ACTION = 'com.google.android.gms.actions.CREATE_NOTE';
const VIEW_ACTION = 'android.intent.action.VIEW';
const DEFAULT_CATEGORY = 'android.intent.category.DEFAULT';
const BROWSABLE_CATEGORY = 'android.intent.category.BROWSABLE';
const VOICE_CATEGORY = 'android.intent.category.VOICE';

// The native quick-capture dialog (modules/android-widget, #1169): saves to the
// Inbox queue and closes without bringing the app forward.
const QUICK_CAPTURE_ACTIVITY = 'tech.dongdongbh.mindwtr.androidwidget.QuickCaptureActivity';

const buildShortcutsXml = (packageName) => `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <capability android:name="actions.intent.CREATE_THING">
    <intent android:action="android.intent.action.VIEW">
      <url-template android:value="mindwtr:///capture{?title,note}" />
      <parameter
        android:name="thing.name"
        android:key="title"
        android:required="true" />
      <parameter
        android:name="thing.description"
        android:key="note" />
    </intent>
    <intent android:action="android.intent.action.VIEW">
      <url-template android:value="mindwtr:///capture" />
    </intent>
  </capability>

  <capability android:name="actions.intent.GET_THING">
    <intent android:action="android.intent.action.VIEW">
      <url-template android:value="mindwtr:///global-search{?q}" />
      <parameter
        android:name="thing.name"
        android:key="q"
        android:required="true" />
    </intent>
    <intent android:action="android.intent.action.VIEW">
      <url-template android:value="mindwtr:///global-search" />
    </intent>
  </capability>

  <capability android:name="actions.intent.OPEN_APP_FEATURE">
    <intent android:action="android.intent.action.VIEW">
      <url-template android:value="mindwtr:///open-feature{?feature}" />
      <parameter
        android:name="feature"
        android:key="feature"
        android:required="true" />
    </intent>
    <intent android:action="android.intent.action.VIEW">
      <url-template android:value="mindwtr:///inbox" />
    </intent>
  </capability>

  <shortcut android:shortcutId="capture">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_capture_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="inbox">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_inbox_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="focus">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_focus_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="waiting">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_waiting_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="someday">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_someday_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="projects">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_projects_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="review">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_review_names" />
    </capability-binding>
  </shortcut>
  <shortcut android:shortcutId="calendar">
    <capability-binding android:key="actions.intent.OPEN_APP_FEATURE">
      <parameter-binding
        android:key="feature"
        android:value="@array/app_action_feature_calendar_names" />
    </capability-binding>
  </shortcut>

  <shortcut
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutId="add_task_inbox"
    android:shortcutLongLabel="@string/shortcut_add_task_long"
    android:shortcutShortLabel="@string/shortcut_add_task_short">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${packageName}"
      android:targetClass="${QUICK_CAPTURE_ACTIVITY}" />
  </shortcut>
  <shortcut
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutId="open_focus"
    android:shortcutLongLabel="@string/shortcut_open_focus_long"
    android:shortcutShortLabel="@string/shortcut_open_focus_short">
    <intent
      android:action="android.intent.action.VIEW"
      android:data="mindwtr:///focus" />
  </shortcut>
  <shortcut
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutId="open_calendar"
    android:shortcutLongLabel="@string/shortcut_open_calendar_long"
    android:shortcutShortLabel="@string/shortcut_open_calendar_short">
    <intent
      android:action="android.intent.action.VIEW"
      android:data="mindwtr:///calendar" />
  </shortcut>
</shortcuts>
`;

const SHORTCUTS_STRINGS_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="shortcut_add_task_long" translatable="false">Add task to Inbox</string>
  <string name="shortcut_add_task_short" translatable="false">Add task</string>
  <string name="shortcut_open_focus_long" translatable="false">Open Focus view</string>
  <string name="shortcut_open_focus_short" translatable="false">Focus</string>
  <string name="shortcut_open_calendar_long" translatable="false">Open Calendar view</string>
  <string name="shortcut_open_calendar_short" translatable="false">Calendar</string>

  <string-array name="app_action_feature_capture_names" translatable="false">
    <item>Capture</item>
    <item>Quick capture</item>
    <item>Add task</item>
    <item>New task</item>
  </string-array>
  <string-array name="app_action_feature_inbox_names" translatable="false">
    <item>Inbox</item>
    <item>Task inbox</item>
  </string-array>
  <string-array name="app_action_feature_focus_names" translatable="false">
    <item>Focus</item>
    <item>Today</item>
    <item>Next actions</item>
  </string-array>
  <string-array name="app_action_feature_waiting_names" translatable="false">
    <item>Waiting</item>
    <item>Waiting for</item>
  </string-array>
  <string-array name="app_action_feature_someday_names" translatable="false">
    <item>Someday</item>
    <item>Maybe</item>
    <item>Someday maybe</item>
  </string-array>
  <string-array name="app_action_feature_projects_names" translatable="false">
    <item>Projects</item>
    <item>Project list</item>
  </string-array>
  <string-array name="app_action_feature_review_names" translatable="false">
    <item>Review</item>
    <item>Daily review</item>
    <item>Weekly review</item>
  </string-array>
  <string-array name="app_action_feature_calendar_names" translatable="false">
    <item>Calendar</item>
    <item>Schedule</item>
  </string-array>
</resources>
`;

const isMainActivity = (activityName) =>
  typeof activityName === 'string' && activityName.endsWith(MAIN_ACTIVITY_SUFFIX);

const hasAction = (filter, actionName) =>
  Array.isArray(filter?.action) && filter.action.some((action) => action?.$?.['android:name'] === actionName);

const hasCategory = (filter, categoryName) =>
  Array.isArray(filter?.category) && filter.category.some((category) => category?.$?.['android:name'] === categoryName);

const hasSchemeData = (filter, scheme) =>
  Array.isArray(filter?.data) && filter.data.some((data) => data?.$?.['android:scheme'] === scheme);

const hasMimeTypeData = (filter, mimeType) =>
  Array.isArray(filter?.data) && filter.data.some((data) => data?.$?.['android:mimeType'] === mimeType);

const ensureDeepLinkIntentFilter = (mainActivity) => {
  if (!Array.isArray(mainActivity['intent-filter'])) {
    mainActivity['intent-filter'] = [];
  }

  const existing = mainActivity['intent-filter'].find((filter) =>
    hasAction(filter, VIEW_ACTION)
    && hasCategory(filter, DEFAULT_CATEGORY)
    && hasCategory(filter, BROWSABLE_CATEGORY)
    && hasSchemeData(filter, 'mindwtr')
  );
  if (existing) return;

  mainActivity['intent-filter'].push({
    action: [{ $: { 'android:name': VIEW_ACTION } }],
    category: [
      { $: { 'android:name': DEFAULT_CATEGORY } },
      { $: { 'android:name': BROWSABLE_CATEGORY } },
    ],
    data: [{ $: { 'android:scheme': 'mindwtr' } }],
  });
};

const ensureCreateNoteIntentFilter = (mainActivity) => {
  if (!Array.isArray(mainActivity['intent-filter'])) {
    mainActivity['intent-filter'] = [];
  }

  const existing = mainActivity['intent-filter'].find((filter) =>
    hasAction(filter, CREATE_NOTE_ACTION)
    && hasCategory(filter, DEFAULT_CATEGORY)
    && hasMimeTypeData(filter, '*/*')
  );
  if (existing) {
    if (!hasCategory(existing, VOICE_CATEGORY)) {
      existing.category = [...(existing.category ?? []), { $: { 'android:name': VOICE_CATEGORY } }];
    }
    if (!hasMimeTypeData(existing, 'text/plain')) {
      existing.data = [...(existing.data ?? []), { $: { 'android:mimeType': 'text/plain' } }];
    }
    return;
  }

  mainActivity['intent-filter'].push({
    action: [{ $: { 'android:name': CREATE_NOTE_ACTION } }],
    category: [
      { $: { 'android:name': DEFAULT_CATEGORY } },
      { $: { 'android:name': VOICE_CATEGORY } },
    ],
    data: [
      { $: { 'android:mimeType': 'text/plain' } },
      { $: { 'android:mimeType': '*/*' } },
    ],
  });
};

const ensureShortcutsMetaData = (mainActivity) => {
  if (!Array.isArray(mainActivity['meta-data'])) {
    mainActivity['meta-data'] = [];
  }

  const existingShortcutsMeta = mainActivity['meta-data'].find(
    (meta) => meta?.$?.['android:name'] === 'android.app.shortcuts'
  );
  if (existingShortcutsMeta?.$) {
    existingShortcutsMeta.$['android:resource'] = SHORTCUTS_RESOURCE;
    return;
  }

  mainActivity['meta-data'].push({
    $: {
      'android:name': 'android.app.shortcuts',
      'android:resource': SHORTCUTS_RESOURCE,
    },
  });
};

const ensureMainActivityAppActions = (mainActivity) => {
  if (!mainActivity.$) {
    mainActivity.$ = {};
  }
  mainActivity.$['android:exported'] = 'true';
  mainActivity.$['android:launchMode'] = 'singleTask';
  ensureShortcutsMetaData(mainActivity);
  ensureDeepLinkIntentFilter(mainActivity);
  ensureCreateNoteIntentFilter(mainActivity);
};

const ensureManifestAppActions = (androidManifest) => {
  const application = androidManifest.manifest?.application?.[0];
  if (!application || !Array.isArray(application.activity)) {
    return androidManifest;
  }

  const mainActivity = application.activity.find((activity) =>
    isMainActivity(activity?.$?.['android:name'])
  );
  if (!mainActivity) {
    return androidManifest;
  }

  ensureMainActivityAppActions(mainActivity);
  return androidManifest;
};

const addAndroidxCoreDependency = (contents) => {
  if (contents.includes('androidx.core:core:')) {
    return contents;
  }
  const dependencyBlock = contents.match(/dependencies\s*\{[\s\S]*?\n\}/);
  if (!dependencyBlock) {
    return contents;
  }
  return contents.replace(
    dependencyBlock[0],
    dependencyBlock[0].replace(/\n\}/, `\n    ${ANDROIDX_CORE_DEPENDENCY}\n}`)
  );
};

module.exports = function withAndroidAppShortcuts(config) {
  const withManifest = withAndroidManifest(config, (cfg) => {
    ensureManifestAppActions(cfg.modResults);
    return cfg;
  });

  const withGradle = withAppBuildGradle(withManifest, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      return cfg;
    }
    cfg.modResults.contents = addAndroidxCoreDependency(cfg.modResults.contents);
    return cfg;
  });

  return withDangerousMod(withGradle, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      const valuesDir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'values');
      await fs.promises.mkdir(xmlDir, { recursive: true });
      await fs.promises.mkdir(valuesDir, { recursive: true });
      const packageName = cfg.android?.package || cfg.modRequest.projectName;
      await fs.promises.writeFile(path.join(xmlDir, SHORTCUTS_FILE_NAME), buildShortcutsXml(packageName), 'utf8');
      await fs.promises.writeFile(path.join(valuesDir, SHORTCUTS_STRINGS_FILE_NAME), SHORTCUTS_STRINGS_XML, 'utf8');
      return cfg;
    },
  ]);
};

module.exports.__testables = {
  addAndroidxCoreDependency,
  ensureManifestAppActions,
  SHORTCUTS_STRINGS_XML,
  buildShortcutsXml,
};
