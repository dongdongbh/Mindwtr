import { describe, expect, it } from 'vitest';

const plugin = require('./android-widget');

const {
  ACTIVITY_NAME,
  RECEIVER_NAME,
  SERVICE_NAME,
  buildWidgetInfoXml,
  buildWidgetStringsXml,
  buildWidgetStylesXml,
  ensureWidgetComponents,
  resolveProps,
} = plugin.__testables;

const appJsonProps = () => {
  const appJson = require('../app.json');
  const entry = appJson.expo.plugins.find((item) => Array.isArray(item) && item[0] === './plugins/android-widget');
  return entry?.[1];
};

describe('android-widget', () => {
  it('carries the previous widget sizing and preview over from app.json', () => {
    const props = resolveProps(appJsonProps());
    expect(props.label).toBe('Mindwtr');
    expect(props.minWidth).toBe('120dp');
    expect(props.minResizeHeight).toBe('120dp');
    expect(props.resizeMode).toBe('horizontal|vertical');
    expect(props.previewImage).toBe('./assets/images/widget-preview.png');

    const xml = buildWidgetInfoXml(props);
    expect(xml).toContain('android:minWidth="120dp"');
    expect(xml).toContain('android:minResizeWidth="120dp"');
    expect(xml).toContain('android:targetCellWidth="3"');
    expect(xml).toContain('android:targetCellHeight="2"');
    expect(xml).toContain('android:resizeMode="horizontal|vertical"');
    expect(xml).toContain('android:initialLayout="@layout/mindwtr_widget"');
    expect(xml).toContain('android:previewImage="@drawable/mindwtr_widget_preview"');
    expect(xml).toContain('android:updatePeriodMillis="0"');
    expect(buildWidgetStringsXml(props)).toContain('Inbox, focus, and quick capture');
  });

  it('derives the dialog theme from the AppCompat DayNight dialog without a title', () => {
    const xml = buildWidgetStylesXml();
    expect(xml).toContain('parent="Theme.AppCompat.DayNight.Dialog"');
    expect(xml).toContain('<item name="windowNoTitle">true</item>');
  });

  it('registers the receiver, list service and capture activity with explicit boundaries, idempotently', () => {
    const manifest = { manifest: { application: [{}] } };

    ensureWidgetComponents(manifest, { label: 'Mindwtr Dev' });
    const once = JSON.stringify(manifest);
    ensureWidgetComponents(manifest, { label: 'Mindwtr Dev' });
    expect(JSON.stringify(manifest)).toBe(once);

    const application = manifest.manifest.application[0];
    expect(application.receiver).toEqual([{
      $: { 'android:name': RECEIVER_NAME, 'android:label': 'Mindwtr Dev', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/mindwtr_tasks_widget_info' } }],
    }]);
    expect(application.service).toEqual([{
      $: { 'android:name': SERVICE_NAME, 'android:permission': 'android.permission.BIND_REMOTEVIEWS', 'android:exported': 'false' },
    }]);
    expect(application.activity).toHaveLength(1);
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
            $: { 'android:name': RECEIVER_NAME },
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
});
