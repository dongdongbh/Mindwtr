import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const plugin = require('./android-widget');
const { buildWidgetPreviewXml } = require('./android-widget-preview');
const { compactWidgetLocales, compactWidgetValuesDirectory } = require('./android-widget-locales');

const {
  ACTIVITY_NAME,
  CAPTURE_ACTION,
  CAPTURE_RECEIVER_NAME,
  CONFIGURE_ACTIVITY_NAME,
  SERVICE_NAME,
  TAP_ACTIVITY_NAME,
  buildWidgetInfoXml,
  buildCompactWidgetStringsXml,
  buildWidgetKinds,
  buildLegacyTasksWidgetKind,
  buildLegacyTasksWidgetSource,
  buildWidgetStringsXml,
  buildWidgetStylesXml,
  ensureWidgetComponents,
  resolveProps,
  writeLegacyTasksWidgetSource,
} = plugin.__testables;

const appJsonProps = () => {
  const appJson = require('../app.json');
  const entry = appJson.expo.plugins.find((item) => Array.isArray(item) && item[0] === './plugins/android-widget');
  return entry?.[1];
};

describe('android-widget', () => {
  it('localizes the Compact picker label and description for every app language', () => {
    const locales = fs.readdirSync(path.resolve(__dirname, '../../..', 'packages/core/src/i18n/locales'))
      .filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -3)).sort();
    expect(Object.keys(compactWidgetLocales).sort()).toEqual(locales);
    for (const locale of locales) {
      const xml = buildCompactWidgetStringsXml('Mindwtr Dev', locale);
      expect(xml).toContain('name="mindwtr_compact_widget_label">Mindwtr Dev ');
      expect(xml).toContain('name="mindwtr_compact_widget_description"');
      expect(xml).not.toContain('translatable="false"');
    }
    expect(buildCompactWidgetStringsXml('Mindwtr Dev', 'zh-Hans')).toContain('Mindwtr Dev 简洁');
    expect(compactWidgetValuesDirectory('zh-Hant')).toBe('values-b+zh+Hant');
    expect(compactWidgetValuesDirectory('de')).toBe('values-de');
  });

  it('builds each picker preview from its native layout with sample content', () => {
    const readLayout = (name) => fs.readFileSync(path.join(__dirname, '../modules/android-widget/android/src/main/res/layout', `${name}.xml`), 'utf8');
    const previews = buildWidgetKinds(resolveProps()).map((kind) => buildWidgetPreviewXml(kind, readLayout));
    expect(previews[0]).toContain('mindwtr_widget_item_ring_target');
    expect(previews[0]).toContain('android:text="Plan the week"');
    expect(previews[0]).toContain('android:text="Work"');
    expect(previews[1]).toContain('android:text="• Plan the week"');
    expect(previews[1]).toContain('android:textSize="12sp"');
    expect(previews[1]).not.toContain('mindwtr_widget_item_ring_target');
    expect(previews[1]).not.toContain('mindwtr_widget_section_title');
    expect(previews[2]).toContain('android:text="Quick capture"');
    expect(previews[2]).not.toContain('Plan the week');
    for (const preview of previews) {
      expect(preview).not.toContain('<ListView');
      const ids = [...preview.matchAll(/android:id="@\+id\/([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('carries the previous widget sizing and preview over from app.json', () => {
    const props = resolveProps(appJsonProps());
    expect(props.label).toBe('Mindwtr');
    expect(props.minWidth).toBe('120dp');
    expect(props.minResizeHeight).toBe('120dp');
    expect(props.resizeMode).toBe('horizontal|vertical');
    expect(props.previewImage).toBe('./assets/images/widget-tasks-preview.png');

    const [tasks, compact, quickCapture] = buildWidgetKinds(props);
    expect(new Set([tasks, compact, quickCapture].map((kind) => kind.previewImage)).size).toBe(3);
    for (const kind of [tasks, compact, quickCapture]) {
      expect(fs.existsSync(path.resolve(__dirname, '..', kind.previewImage))).toBe(true);
      expect(buildWidgetInfoXml(kind)).toContain(`android:previewLayout="@layout/${kind.layout}_preview"`);
    }
    expect(tasks.kind).toBe('Tasks');
    expect(tasks.receiver).toBe('tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider');
    const xml = buildWidgetInfoXml(tasks);
    expect(xml).toContain('android:minWidth="120dp"');
    expect(xml).toContain('android:minResizeWidth="120dp"');
    expect(xml).toContain('android:targetCellWidth="3"');
    expect(xml).toContain('android:targetCellHeight="2"');
    expect(xml).toContain('android:resizeMode="horizontal|vertical"');
    // keyguard lets the OS list the widget in its lock-screen picker where it
    // offers one (Android 15+ tablets first); home_screen keeps the launcher.
    expect(xml).toContain('android:widgetCategory="home_screen|keyguard"');
    expect(xml).toContain('android:initialLayout="@layout/mindwtr_widget"');
    expect(xml).toContain('android:previewImage="@drawable/mindwtr_widget_preview"');
    expect(xml).toContain('android:updatePeriodMillis="0"');
    expect(xml).toContain(`android:configure="${CONFIGURE_ACTIVITY_NAME}"`);
    // reconfigurable = the launcher's edit action on a placed widget;
    // configuration_optional = placement skips the picker and lands on the
    // default list, because the widget's own header opens the chooser (#1173).
    expect(xml).toContain('android:widgetFeatures="reconfigurable|configuration_optional"');
    expect(buildWidgetStringsXml([tasks, quickCapture])).toContain('Inbox, focus, and quick capture');

    expect(quickCapture.kind).toBe('QuickCapture');
    expect(quickCapture.receiver).toBe('tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWidgetProvider');
    const captureXml = buildWidgetInfoXml(quickCapture);
    expect(captureXml).toContain('android:targetCellWidth="1"');
    expect(captureXml).toContain('android:targetCellHeight="1"');
    expect(captureXml).toContain('android:resizeMode="none"');
    expect(captureXml).toContain('android:initialLayout="@layout/mindwtr_quick_capture_widget"');
    expect(captureXml).toContain('android:previewImage="@drawable/mindwtr_quick_capture_widget_preview"');
    expect(captureXml).not.toContain('android:configure');
    expect(buildWidgetKinds(resolveProps({ label: 'Mindwtr Dev' })).map((kind) => kind.label)).toEqual(['Mindwtr Dev', 'Mindwtr Dev Compact', 'Mindwtr Dev quick capture']);
    const compactXml = buildWidgetInfoXml(compact);
    expect(compactXml).toContain('android:targetCellWidth="2"');
    expect(compactXml).toContain('android:targetCellHeight="2"');
    expect(compactXml).toContain('android:initialLayout="@layout/mindwtr_compact_widget"');
    expect(compactXml).toContain('android:previewImage="@drawable/mindwtr_compact_widget_preview"');
    expect(compactXml).not.toContain('android:configure');
    expect(compactXml).not.toContain('reconfigurable');
  });

  it('derives the dialog theme from the AppCompat DayNight dialog without a title', () => {
    const xml = buildWidgetStylesXml();
    expect(xml).toContain('parent="Theme.AppCompat.DayNight.Dialog"');
    expect(xml).toContain('<item name="windowNoTitle">true</item>');
    // The dialog draws its own rounded surface in the app palette; the window itself stays clear.
    expect(xml).toContain('<item name="android:windowBackground">@android:color/transparent</item>');
    expect(xml).toContain('<item name="android:backgroundDimEnabled">true</item>');
  });

  it('registers the receiver, list service and capture activity with explicit boundaries, idempotently', () => {
    const manifest = { manifest: { application: [{}] } };

    ensureWidgetComponents(manifest, { label: 'Mindwtr Dev' }, 'tech.dongdongbh.mindwtr.dev');
    const once = JSON.stringify(manifest);
    ensureWidgetComponents(manifest, { label: 'Mindwtr Dev' }, 'tech.dongdongbh.mindwtr.dev');
    expect(JSON.stringify(manifest)).toBe(once);

    const application = manifest.manifest.application[0];
    expect(application.receiver).toEqual([{
      $: { 'android:name': 'tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider', 'android:label': 'Mindwtr Dev', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/mindwtr_tasks_widget_info' } }],
    }, {
      $: { 'android:name': 'tech.dongdongbh.mindwtr.androidwidget.CompactWidgetProvider', 'android:label': '@string/mindwtr_compact_widget_label', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/mindwtr_compact_widget_info' } }],
    }, {
      $: { 'android:name': 'tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWidgetProvider', 'android:label': 'Mindwtr Dev quick capture', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/mindwtr_quick_capture_widget_info' } }],
    }, {
      $: { 'android:name': 'tech.dongdongbh.mindwtr.dev.widget.TasksWidget', 'android:label': 'Mindwtr Dev', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/mindwtr_legacy_tasks_widget_info' } }],
    }, {
      $: { 'android:name': CAPTURE_RECEIVER_NAME, 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': CAPTURE_ACTION } }] }],
    }]);
    expect(application.service).toEqual([{
      $: { 'android:name': SERVICE_NAME, 'android:permission': 'android.permission.BIND_REMOTEVIEWS', 'android:exported': 'false' },
    }]);
    expect(application.activity).toHaveLength(4);
    // The task sheet a widget row opens: floating, own task, never exported.
    expect(application.activity[3].$).toMatchObject({
      'android:name': 'tech.dongdongbh.mindwtr.androidwidget.TaskPeekActivity',
      'android:exported': 'false',
      'android:theme': '@style/Theme.Mindwtr.QuickCapture',
      'android:excludeFromRecents': 'true',
      'android:taskAffinity': '',
    });
    expect(application.activity[2].$).toMatchObject({ 'android:name': TAP_ACTIVITY_NAME, 'android:exported': 'false', 'android:theme': '@android:style/Theme.NoDisplay' });
    // No affinity: the widget header's chooser runs in its own task, so closing
    // it goes back to the launcher rather than to the app's last screen (#1173).
    expect(application.activity[1].$).toMatchObject({ 'android:name': CONFIGURE_ACTIVITY_NAME, 'android:exported': 'true', 'android:taskAffinity': '' });
    expect(application.activity[1]['intent-filter'][0].action[0].$['android:name']).toBe('android.appwidget.action.APPWIDGET_CONFIGURE');
    expect(application.activity[0].$).toMatchObject({
      'android:name': ACTIVITY_NAME,
      'android:exported': 'false',
      'android:theme': '@style/Theme.Mindwtr.QuickCapture',
      'android:excludeFromRecents': 'true',
      'android:noHistory': 'true',
      'android:taskAffinity': '',
    });
  });

  it('keeps the receiver filter to the widget update action only', () => {
    const manifest = {
      manifest: {
        application: [{
          receiver: [{
            $: { 'android:name': 'tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider' },
            'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } }] }],
          }],
        }],
      },
    };

    ensureWidgetComponents(manifest, {});

    const actions = manifest.manifest.application[0].receiver[0]['intent-filter']
      .flatMap((filter) => filter.action.map((action) => action.$['android:name']));
    expect(actions).toEqual(['android.appwidget.action.APPWIDGET_UPDATE']);
  });

  it.each([
    'tech.dongdongbh.mindwtr',
    'tech.dongdongbh.mindwtr.dev',
  ])('generates an idempotent real legacy provider for %s and replaces the retired RNWidget source', async (androidPackage) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-widget-compat-'));
    const mainRoot = path.join(projectRoot, 'app', 'src', 'main');
    const sourcePath = path.join(mainRoot, 'java', ...androidPackage.split('.'), 'widget', 'TasksWidget.java');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'public class TasksWidget extends RNWidgetProvider {}\n');

    try {
      await writeLegacyTasksWidgetSource(mainRoot, androidPackage);
      const generated = fs.readFileSync(sourcePath, 'utf8');
      expect(generated).toBe(buildLegacyTasksWidgetSource(androidPackage));
      expect(generated).toContain(`package ${androidPackage}.widget;`);
      expect(generated).toContain('extends tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider');
      expect(generated).not.toContain('RNWidgetProvider');

      await writeLegacyTasksWidgetSource(mainRoot, androidPackage);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(generated);

      const legacyKind = buildLegacyTasksWidgetKind(resolveProps({ label: 'Mindwtr' }), androidPackage);
      expect(legacyKind.receiver).toBe(`${androidPackage}.widget.TasksWidget`);
      expect(buildWidgetInfoXml(legacyKind)).toContain('android:widgetFeatures="reconfigurable|configuration_optional|hide_from_picker"');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
