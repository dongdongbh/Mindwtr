const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

// Registers the native home-screen widget and the quick-capture dialog that
// live in modules/android-widget (Kotlin). The module's own manifest carries no
// components on purpose: the launcher label, the appwidget-provider XML and
// the preview image depend on app config (the Dev variant relabels them).
const MODULE_PACKAGE = 'tech.dongdongbh.mindwtr.androidwidget';
const RECEIVER_NAME = `${MODULE_PACKAGE}.MindwtrTasksWidgetProvider`;
const SERVICE_NAME = `${MODULE_PACKAGE}.TasksWidgetService`;
const ACTIVITY_NAME = `${MODULE_PACKAGE}.QuickCaptureActivity`;
const WIDGET_UPDATE_ACTION = 'android.appwidget.action.APPWIDGET_UPDATE';
const WIDGET_PROVIDER_META = 'android.appwidget.provider';
const WIDGET_INFO_RESOURCE = '@xml/mindwtr_tasks_widget_info';
const WIDGET_INFO_FILE_NAME = 'mindwtr_tasks_widget_info.xml';
const WIDGET_STRINGS_FILE_NAME = 'mindwtr_widget_strings.xml';
const WIDGET_STYLES_FILE_NAME = 'mindwtr_widget_styles.xml';
const WIDGET_PREVIEW_FILE_NAME = 'mindwtr_widget_preview.png';
const QUICK_CAPTURE_THEME = 'Theme.Mindwtr.QuickCapture';

const DEFAULT_PROPS = {
  label: 'Mindwtr',
  description: 'Inbox, focus, and quick capture',
  minWidth: '120dp',
  minHeight: '120dp',
  minResizeWidth: '120dp',
  minResizeHeight: '120dp',
  targetCellWidth: 3,
  targetCellHeight: 2,
  resizeMode: 'horizontal|vertical',
  previewImage: './assets/images/widget-preview.png',
};

const resolveProps = (props) => ({ ...DEFAULT_PROPS, ...(props ?? {}) });

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '\\\'');

const buildWidgetInfoXml = (props) => `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="${props.minWidth}"
    android:minHeight="${props.minHeight}"
    android:minResizeWidth="${props.minResizeWidth}"
    android:minResizeHeight="${props.minResizeHeight}"
    android:targetCellWidth="${props.targetCellWidth}"
    android:targetCellHeight="${props.targetCellHeight}"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/mindwtr_widget"
    android:previewImage="@drawable/mindwtr_widget_preview"
    android:resizeMode="${props.resizeMode}"
    android:widgetCategory="home_screen"
    android:description="@string/mindwtr_widget_description" />
`;

const buildWidgetStringsXml = (props) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="mindwtr_widget_description" translatable="false">${escapeXml(props.description)}</string>
</resources>
`;

// The dialog inherits AppCompat's DayNight dialog so it follows the system
// theme; every label inside it comes from the stored widget payload.
const buildWidgetStylesXml = () => `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="${QUICK_CAPTURE_THEME}" parent="Theme.AppCompat.DayNight.Dialog">
    <item name="windowNoTitle">true</item>
    <item name="windowActionBar">false</item>
    <item name="android:windowMinWidthMajor">65%</item>
    <item name="android:windowMinWidthMinor">92%</item>
    <item name="colorAccent">#2563EB</item>
  </style>
</resources>
`;

const findByName = (entries, name) => entries.find((entry) => entry?.$?.['android:name'] === name);

const ensureArray = (parent, key) => {
  if (!Array.isArray(parent[key])) parent[key] = [];
  return parent[key];
};

const ensureWidgetReceiver = (application, props) => {
  const receivers = ensureArray(application, 'receiver');
  let receiver = findByName(receivers, RECEIVER_NAME);
  if (!receiver) {
    receiver = { $: {} };
    receivers.push(receiver);
  }
  // Exported only because the launcher's APPWIDGET_UPDATE broadcast needs it;
  // the intent filter admits nothing else.
  receiver.$ = {
    'android:name': RECEIVER_NAME,
    'android:label': props.label,
    'android:exported': 'true',
  };
  receiver['intent-filter'] = [{ action: [{ $: { 'android:name': WIDGET_UPDATE_ACTION } }] }];
  receiver['meta-data'] = [{ $: { 'android:name': WIDGET_PROVIDER_META, 'android:resource': WIDGET_INFO_RESOURCE } }];
};

const ensureListService = (application) => {
  const services = ensureArray(application, 'service');
  let service = findByName(services, SERVICE_NAME);
  if (!service) {
    service = { $: {} };
    services.push(service);
  }
  service.$ = {
    'android:name': SERVICE_NAME,
    'android:permission': 'android.permission.BIND_REMOTEVIEWS',
    'android:exported': 'false',
  };
};

const ensureQuickCaptureActivity = (application) => {
  const activities = ensureArray(application, 'activity');
  let activity = findByName(activities, ACTIVITY_NAME);
  if (!activity) {
    activity = { $: {} };
    activities.push(activity);
  }
  // Own task with no affinity so it floats over whatever is on screen and never
  // pulls MainActivity's task forward; gone from Recents and history on finish.
  activity.$ = {
    'android:name': ACTIVITY_NAME,
    'android:exported': 'false',
    'android:theme': `@style/${QUICK_CAPTURE_THEME}`,
    'android:excludeFromRecents': 'true',
    'android:noHistory': 'true',
    'android:taskAffinity': '',
    'android:launchMode': 'singleTask',
    'android:windowSoftInputMode': 'stateVisible|adjustResize',
  };
};

const ensureWidgetComponents = (androidManifest, props) => {
  const application = androidManifest?.manifest?.application?.[0];
  if (!application) return androidManifest;
  const resolved = resolveProps(props);
  ensureWidgetReceiver(application, resolved);
  ensureListService(application);
  ensureQuickCaptureActivity(application);
  return androidManifest;
};

module.exports = function withAndroidWidget(config, props = {}) {
  const resolved = resolveProps(props);

  const withManifest = withAndroidManifest(config, (cfg) => {
    ensureWidgetComponents(cfg.modResults, resolved);
    return cfg;
  });

  return withDangerousMod(withManifest, [
    'android',
    async (cfg) => {
      const mainRoot = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main');
      const xmlDir = path.join(mainRoot, 'res', 'xml');
      const valuesDir = path.join(mainRoot, 'res', 'values');
      const drawableDir = path.join(mainRoot, 'res', 'drawable');
      await fs.promises.mkdir(xmlDir, { recursive: true });
      await fs.promises.mkdir(valuesDir, { recursive: true });
      await fs.promises.mkdir(drawableDir, { recursive: true });
      await fs.promises.writeFile(path.join(xmlDir, WIDGET_INFO_FILE_NAME), buildWidgetInfoXml(resolved), 'utf8');
      await fs.promises.writeFile(path.join(valuesDir, WIDGET_STRINGS_FILE_NAME), buildWidgetStringsXml(resolved), 'utf8');
      await fs.promises.writeFile(path.join(valuesDir, WIDGET_STYLES_FILE_NAME), buildWidgetStylesXml(), 'utf8');
      await fs.promises.copyFile(
        path.resolve(cfg.modRequest.projectRoot, resolved.previewImage),
        path.join(drawableDir, WIDGET_PREVIEW_FILE_NAME),
      );
      return cfg;
    },
  ]);
};

module.exports.__testables = {
  ACTIVITY_NAME,
  RECEIVER_NAME,
  SERVICE_NAME,
  buildWidgetInfoXml,
  buildWidgetStringsXml,
  buildWidgetStylesXml,
  ensureWidgetComponents,
  resolveProps,
};
