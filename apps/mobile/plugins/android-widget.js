const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const { buildWidgetPreviewXml } = require('./android-widget-preview');
const { compactWidgetLocales, compactWidgetValuesDirectory } = require('./android-widget-locales');

// Registers the native home-screen widget and the quick-capture dialog that
// live in modules/android-widget (Kotlin). The module's own manifest carries no
// components on purpose: the launcher label, the appwidget-provider XML and
// the preview image depend on app config (the Dev variant relabels them).
const MODULE_PACKAGE = 'tech.dongdongbh.mindwtr.androidwidget';
const SERVICE_NAME = `${MODULE_PACKAGE}.TasksWidgetService`;
const ACTIVITY_NAME = `${MODULE_PACKAGE}.QuickCaptureActivity`;
const CONFIGURE_ACTIVITY_NAME = `${MODULE_PACKAGE}.WidgetConfigureActivity`;
const TAP_ACTIVITY_NAME = `${MODULE_PACKAGE}.WidgetTapActivity`;
const PEEK_ACTIVITY_NAME = `${MODULE_PACKAGE}.TaskPeekActivity`;
const CAPTURE_RECEIVER_NAME = `${MODULE_PACKAGE}.CaptureIntentReceiver`;
const CAPTURE_ACTION = 'tech.dongdongbh.mindwtr.action.CAPTURE';
const WIDGET_UPDATE_ACTION = 'android.appwidget.action.APPWIDGET_UPDATE';
const WIDGET_DATE_ACTIONS = ['android.intent.action.DATE_CHANGED', 'android.intent.action.TIME_SET', 'android.intent.action.TIMEZONE_CHANGED'];
const WIDGET_PROVIDER_META = 'android.appwidget.provider';
const LEGACY_TASKS_RECEIVER_CLASS_SUFFIX = '.widget.TasksWidget';
const LEGACY_TASKS_INFO_RESOURCE = 'mindwtr_legacy_tasks_widget_info';
const WIDGET_STRINGS_FILE_NAME = 'mindwtr_widget_strings.xml';
const WIDGET_STYLES_FILE_NAME = 'mindwtr_widget_styles.xml';
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
  previewImage: './assets/images/widget-tasks-preview.png',
};

const resolveProps = (props) => ({ ...DEFAULT_PROPS, ...(props ?? {}) });

// One row per widget kind (mirrors WidgetKind.kt). Adding a kind: one row here,
// one enum row + provider subclass + layout in the module. `label` is the
// launcher-picker name under the app; `description` the picker subtitle.
const buildWidgetKinds = (props) => [
  {
    kind: 'Tasks',
    receiver: `${MODULE_PACKAGE}.TasksWidgetProvider`,
    infoResource: 'mindwtr_tasks_widget_info',
    label: props.label,
    description: props.description,
    descriptionResource: 'mindwtr_widget_description',
    layout: 'mindwtr_widget',
    minWidth: props.minWidth,
    minHeight: props.minHeight,
    minResizeWidth: props.minResizeWidth,
    minResizeHeight: props.minResizeHeight,
    targetCellWidth: props.targetCellWidth,
    targetCellHeight: props.targetCellHeight,
    resizeMode: props.resizeMode,
    previewImage: props.previewImage,
    // Picks the list on placement; `reconfigurable` adds the launcher's edit action (#1173).
    configure: CONFIGURE_ACTIVITY_NAME,
    widgetFeatures: 'reconfigurable|configuration_optional',
  },
  {
    kind: 'Compact',
    receiver: `${MODULE_PACKAGE}.CompactWidgetProvider`,
    infoResource: 'mindwtr_compact_widget_info',
    label: `${props.label} ${compactWidgetLocales.en[0]}`,
    labelResource: 'mindwtr_compact_widget_label',
    description: compactWidgetLocales.en[1],
    descriptionResource: 'mindwtr_compact_widget_description',
    layout: 'mindwtr_compact_widget',
    minWidth: '120dp',
    minHeight: '120dp',
    minResizeWidth: '120dp',
    minResizeHeight: '120dp',
    targetCellWidth: 2,
    targetCellHeight: 2,
    resizeMode: 'horizontal|vertical',
    previewImage: './assets/images/widget-compact-preview.png',
  },
  {
    kind: 'QuickCapture',
    receiver: `${MODULE_PACKAGE}.QuickCaptureWidgetProvider`,
    infoResource: 'mindwtr_quick_capture_widget_info',
    label: `${props.label} quick capture`,
    description: 'Add a task to the Inbox without opening the app',
    descriptionResource: 'mindwtr_quick_capture_widget_description',
    layout: 'mindwtr_quick_capture_widget',
    minWidth: '40dp',
    minHeight: '40dp',
    minResizeWidth: '40dp',
    minResizeHeight: '40dp',
    targetCellWidth: 1,
    targetCellHeight: 1,
    resizeMode: 'none',
    previewImage: './assets/images/widget-quick-capture-preview.png',
  },
];

const buildLegacyTasksWidgetKind = (props, androidPackage) => ({
  ...buildWidgetKinds(props)[0],
  kind: 'LegacyTasks',
  receiver: `${androidPackage}${LEGACY_TASKS_RECEIVER_CLASS_SUFFIX}`,
  infoResource: LEGACY_TASKS_INFO_RESOURCE,
  // API 28+ launchers can hide the compatibility component from the picker;
  // older hosts ignore the hint but keep already-placed widgets alive.
  widgetFeatures: 'reconfigurable|configuration_optional|hide_from_picker',
});

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '\\\'');

const buildWidgetInfoXml = (kind) => `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="${kind.minWidth}"
    android:minHeight="${kind.minHeight}"
    android:minResizeWidth="${kind.minResizeWidth}"
    android:minResizeHeight="${kind.minResizeHeight}"
    android:targetCellWidth="${kind.targetCellWidth}"
    android:targetCellHeight="${kind.targetCellHeight}"
    android:updatePeriodMillis="${kind.configure ? 30 * 60 * 1000 : 0}"
    android:initialLayout="@layout/${kind.layout}"${kind.previewImage ? `
    android:previewImage="@drawable/${kind.layout}_preview"` : ''}
    android:previewLayout="@layout/${kind.layout}_preview"
    android:resizeMode="${kind.resizeMode}"${kind.configure ? `
    android:configure="${kind.configure}"` : ''}${kind.widgetFeatures ? `
    android:widgetFeatures="${kind.widgetFeatures}"` : ''}
    android:widgetCategory="home_screen|keyguard"
    android:description="@string/${kind.descriptionResource}" />
`;

const buildWidgetStringsXml = (kinds) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
${kinds.filter((kind) => kind.kind !== 'Compact').map((kind) => `  <string name="${kind.descriptionResource}" translatable="false">${escapeXml(kind.description)}</string>`).join('\n')}
</resources>
`;

const buildCompactWidgetStringsXml = (label, locale = 'en') => {
  const [name, description] = compactWidgetLocales[locale];
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="mindwtr_compact_widget_label">${escapeXml(`${label} ${name}`)}</string>
  <string name="mindwtr_compact_widget_description">${escapeXml(description)}</string>
</resources>
`;
};

// The dialog inherits AppCompat's DayNight dialog so it follows the system
// theme; every label inside it comes from the stored widget payload.
const buildWidgetStylesXml = () => `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="${QUICK_CAPTURE_THEME}" parent="Theme.AppCompat.DayNight.Dialog">
    <item name="windowNoTitle">true</item>
    <item name="windowActionBar">false</item>
    <item name="android:windowBackground">@android:color/transparent</item>
    <item name="android:windowIsFloating">true</item>
    <item name="android:backgroundDimEnabled">true</item>
    <item name="android:windowMinWidthMajor">60%</item>
    <item name="android:windowMinWidthMinor">90%</item>
    <item name="colorAccent">#2563EB</item>
  </style>
</resources>
`;

const findByName = (entries, name) => entries.find((entry) => entry?.$?.['android:name'] === name);

const ensureArray = (parent, key) => {
  if (!Array.isArray(parent[key])) parent[key] = [];
  return parent[key];
};

const ensureWidgetReceiver = (application, kind) => {
  const receivers = ensureArray(application, 'receiver');
  let receiver = findByName(receivers, kind.receiver);
  if (!receiver) {
    receiver = { $: {} };
    receivers.push(receiver);
  }
  // Launchers update widgets; protected clock broadcasts re-evaluate cached Upcoming dates.
  receiver.$ = {
    'android:name': kind.receiver,
    'android:label': kind.labelResource ? `@string/${kind.labelResource}` : kind.label,
    'android:exported': 'true',
  };
  receiver['intent-filter'] = [{ action: [WIDGET_UPDATE_ACTION, ...(kind.configure ? WIDGET_DATE_ACTIONS : [])]
    .map((action) => ({ $: { 'android:name': action } })) }];
  receiver['meta-data'] = [{ $: { 'android:name': WIDGET_PROVIDER_META, 'android:resource': `@xml/${kind.infoResource}` } }];
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

const ensureCaptureIntentReceiver = (application) => {
  const receivers = ensureArray(application, 'receiver');
  let receiver = findByName(receivers, CAPTURE_RECEIVER_NAME);
  if (!receiver) {
    receiver = { $: {} };
    receivers.push(receiver);
  }
  // Intentionally exported for explicit cross-app automation. The receiver
  // validates the exact action, string extras, device-local token and text
  // bounds before it queues anything.
  receiver.$ = {
    'android:name': CAPTURE_RECEIVER_NAME,
    'android:exported': 'true',
  };
  receiver['intent-filter'] = [{ action: [{ $: { 'android:name': CAPTURE_ACTION } }] }];
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

const ensureConfigureActivity = (application) => {
  const activities = ensureArray(application, 'activity');
  let activity = findByName(activities, CONFIGURE_ACTIVITY_NAME);
  if (!activity) {
    activity = { $: {} };
    activities.push(activity);
  }
  // The launcher starts it through the system's configure flow; the
  // APPWIDGET_CONFIGURE filter is the one entry it needs. No task affinity so
  // the widget header's own chooser (started with FLAG_ACTIVITY_NEW_TASK) gets
  // a task of its own and closing it returns to the launcher instead of
  // surfacing whatever screen the app was left on; the launcher's own
  // startActivityForResult ignores affinity and still gets its result.
  activity.$ = {
    'android:name': CONFIGURE_ACTIVITY_NAME,
    'android:exported': 'true',
    'android:theme': `@style/${QUICK_CAPTURE_THEME}`,
    'android:excludeFromRecents': 'true',
    'android:taskAffinity': '',
  };
  activity['intent-filter'] = [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_CONFIGURE' } }] }];
};

// Invisible trampoline behind the widget rows' PendingIntent template: opens
// the tapped task or toggles a check-off, then finishes. Never exported.
const ensureTapActivity = (application) => {
  const activities = ensureArray(application, 'activity');
  let activity = findByName(activities, TAP_ACTIVITY_NAME);
  if (!activity) {
    activity = { $: {} };
    activities.push(activity);
  }
  activity.$ = {
    'android:name': TAP_ACTIVITY_NAME,
    'android:exported': 'false',
    'android:theme': '@android:style/Theme.NoDisplay',
    'android:excludeFromRecents': 'true',
    'android:noHistory': 'true',
    'android:taskAffinity': '',
  };
};

// The task sheet a widget row opens: floats over the launcher in its own task,
// like the capture dialog, and never surfaces MainActivity.
const ensurePeekActivity = (application) => {
  const activities = ensureArray(application, 'activity');
  let activity = findByName(activities, PEEK_ACTIVITY_NAME);
  if (!activity) {
    activity = { $: {} };
    activities.push(activity);
  }
  activity.$ = {
    'android:name': PEEK_ACTIVITY_NAME,
    'android:exported': 'false',
    'android:theme': `@style/${QUICK_CAPTURE_THEME}`,
    'android:excludeFromRecents': 'true',
    'android:noHistory': 'true',
    'android:taskAffinity': '',
  };
};

const ensureWidgetComponents = (androidManifest, props, androidPackage) => {
  const application = androidManifest?.manifest?.application?.[0];
  if (!application) return androidManifest;
  const resolved = resolveProps(props);
  for (const kind of buildWidgetKinds(resolved)) {
    ensureWidgetReceiver(application, kind);
  }
  if (androidPackage) ensureWidgetReceiver(application, buildLegacyTasksWidgetKind(resolved, androidPackage));
  ensureCaptureIntentReceiver(application);
  ensureListService(application);
  ensureQuickCaptureActivity(application);
  ensureConfigureActivity(application);
  ensureTapActivity(application);
  ensurePeekActivity(application);
  return androidManifest;
};

const buildLegacyTasksWidgetSource = (androidPackage) => `package ${androidPackage}.widget;

/** Keeps the provider component used by Mindwtr 1.2.7 widgets alive after upgrade. */
public final class TasksWidget extends tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider {}
`;

const writeLegacyTasksWidgetSource = async (mainRoot, androidPackage) => {
  const sourcePath = path.join(
    mainRoot,
    'java',
    ...androidPackage.split('.'),
    'widget',
    'TasksWidget.java',
  );
  await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.promises.writeFile(sourcePath, buildLegacyTasksWidgetSource(androidPackage), 'utf8');
  return sourcePath;
};

module.exports = function withAndroidWidget(config, props = {}) {
  const resolved = resolveProps(props);

  const withManifest = withAndroidManifest(config, (cfg) => {
    ensureWidgetComponents(cfg.modResults, resolved, cfg.android?.package);
    return cfg;
  });

  return withDangerousMod(withManifest, [
    'android',
    async (cfg) => {
      const mainRoot = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main');
      const xmlDir = path.join(mainRoot, 'res', 'xml');
      const valuesDir = path.join(mainRoot, 'res', 'values');
      const drawableDir = path.join(mainRoot, 'res', 'drawable');
      const layoutDir = path.join(mainRoot, 'res', 'layout');
      await fs.promises.mkdir(xmlDir, { recursive: true });
      await fs.promises.mkdir(valuesDir, { recursive: true });
      await fs.promises.mkdir(drawableDir, { recursive: true });
      await fs.promises.mkdir(layoutDir, { recursive: true });
      const kinds = buildWidgetKinds(resolved);
      const androidPackage = cfg.android?.package;
      const resourceKinds = androidPackage
        ? [...kinds, buildLegacyTasksWidgetKind(resolved, androidPackage)]
        : kinds;
      for (const kind of resourceKinds) {
        await fs.promises.writeFile(path.join(xmlDir, `${kind.infoResource}.xml`), buildWidgetInfoXml(kind), 'utf8');
      }
      const nativeLayoutDir = path.join(cfg.modRequest.projectRoot, 'modules/android-widget/android/src/main/res/layout');
      for (const kind of kinds) {
        const xml = buildWidgetPreviewXml(kind, (name) => fs.readFileSync(path.join(nativeLayoutDir, `${name}.xml`), 'utf8'));
        await fs.promises.writeFile(path.join(layoutDir, `${kind.layout}_preview.xml`), xml, 'utf8');
      }
      await fs.promises.writeFile(path.join(valuesDir, WIDGET_STRINGS_FILE_NAME), buildWidgetStringsXml(kinds), 'utf8');
      for (const locale of Object.keys(compactWidgetLocales)) {
        const directory = locale === 'en' ? valuesDir : path.join(mainRoot, 'res', compactWidgetValuesDirectory(locale));
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(path.join(directory, 'mindwtr_compact_widget_strings.xml'), buildCompactWidgetStringsXml(resolved.label, locale), 'utf8');
      }
      await fs.promises.writeFile(path.join(valuesDir, WIDGET_STYLES_FILE_NAME), buildWidgetStylesXml(), 'utf8');
      for (const kind of kinds) {
        await fs.promises.copyFile(
          path.resolve(cfg.modRequest.projectRoot, kind.previewImage),
          path.join(drawableDir, `${kind.layout}_preview.png`),
        );
      }
      if (androidPackage) await writeLegacyTasksWidgetSource(mainRoot, androidPackage);
      return cfg;
    },
  ]);
};

module.exports.__testables = {
  buildCompactWidgetStringsXml,
  ACTIVITY_NAME,
  CAPTURE_ACTION,
  CAPTURE_RECEIVER_NAME,
  CONFIGURE_ACTIVITY_NAME,
  SERVICE_NAME,
  TAP_ACTIVITY_NAME,
  buildWidgetInfoXml,
  buildWidgetKinds,
  buildLegacyTasksWidgetKind,
  buildLegacyTasksWidgetSource,
  buildWidgetStringsXml,
  buildWidgetStylesXml,
  ensureWidgetComponents,
  resolveProps,
  writeLegacyTasksWidgetSource,
};
