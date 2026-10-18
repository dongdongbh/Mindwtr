import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const plugin = require('./android-app-shortcuts');

const {
  addAndroidxCoreDependency,
  ensureManifestAppActions,
  SHORTCUTS_STRINGS_XML,
  buildShortcutsXml,
} = plugin.__testables;

const SHORTCUTS_XML = buildShortcutsXml('tech.dongdongbh.mindwtr');

describe('android-app-shortcuts', () => {
  it('generates App Actions capabilities and open-feature inline inventory', () => {
    expect(SHORTCUTS_XML).toContain('actions.intent.CREATE_THING');
    expect(SHORTCUTS_XML).toContain('mindwtr:///capture{?title,note}');
    expect(SHORTCUTS_XML).toContain('actions.intent.GET_THING');
    expect(SHORTCUTS_XML).toContain('mindwtr:///global-search{?q}');
    expect(SHORTCUTS_XML).toContain('actions.intent.OPEN_APP_FEATURE');
    expect(SHORTCUTS_XML).toContain('mindwtr:///open-feature{?feature}');
    expect(SHORTCUTS_XML).toContain('android:value="@array/app_action_feature_focus_names"');
    expect(SHORTCUTS_XML).toContain('android:targetPackage="tech.dongdongbh.mindwtr"');
    expect(SHORTCUTS_XML).toContain('android:targetClass="tech.dongdongbh.mindwtr.androidwidget.QuickCaptureActivity"');
    expect(buildShortcutsXml('tech.dongdongbh.mindwtr.dev')).toContain('android:targetPackage="tech.dongdongbh.mindwtr.dev"');
    expect(SHORTCUTS_STRINGS_XML).toContain('<item>Today</item>');
    expect(SHORTCUTS_STRINGS_XML).toContain('<item>Quick capture</item>');
  });

  it.each(['tech.dongdongbh.mindwtr', 'tech.dongdongbh.mindwtr.dev'])(
    'keeps native capture and targets the detailed sheet explicitly in %s',
    (packageName) => {
      const xml = buildShortcutsXml(packageName);
      const shortcuts = xml.match(/<shortcut\s[\s\S]*?<\/shortcut>/g);
      const nativeCapture = shortcuts.find((shortcut) => shortcut.includes('android:shortcutId="add_task_inbox"'));
      const detailedCapture = shortcuts.find((shortcut) => shortcut.includes('android:shortcutId="add_task_details"'));

      expect(nativeCapture).toContain(`android:targetPackage="${packageName}"`);
      expect(nativeCapture).toContain('android:targetClass="tech.dongdongbh.mindwtr.androidwidget.QuickCaptureActivity"');
      expect(nativeCapture).not.toContain('capture-quick');
      expect(detailedCapture).toContain(`android:targetPackage="${packageName}"`);
      expect(detailedCapture).toContain('android:targetClass="tech.dongdongbh.mindwtr.androidwidget.DetailedCaptureActivity"');
      expect(detailedCapture).toContain('android:data="mindwtr:///capture-quick?mode=text&amp;entry=details"');
      expect(detailedCapture).toContain('@string/shortcut_add_task_details_short');
      expect(detailedCapture).toContain('@string/shortcut_add_task_details_long');
      expect(shortcuts.filter((shortcut) => shortcut.includes('android:enabled="true"'))).toHaveLength(4);
      expect(xml).toContain('android:shortcutId="open_focus"');
      expect(xml).toContain('android:shortcutId="open_calendar"');
      expect(SHORTCUTS_STRINGS_XML).toContain('>Capture</string>');
      expect(SHORTCUTS_STRINGS_XML).toContain('>Quick capture to Inbox</string>');
      expect(SHORTCUTS_STRINGS_XML).toContain('>Add task…</string>');
      expect(SHORTCUTS_STRINGS_XML).toContain('>Add task with details</string>');
    },
  );

  it('adds manifest metadata, deep links, and create-note support idempotently', () => {
    const manifest = {
      manifest: {
        application: [
          {
            activity: [
              {
                $: {
                  'android:name': '.MainActivity',
                },
              },
            ],
          },
        ],
      },
    };

    ensureManifestAppActions(manifest);
    const once = JSON.stringify(manifest);
    ensureManifestAppActions(manifest);

    expect(JSON.stringify(manifest)).toBe(once);
    const mainActivity = manifest.manifest.application[0].activity[0];
    expect(manifest.manifest.application[0].activity).toContainEqual({
      $: {
        'android:name': 'tech.dongdongbh.mindwtr.androidwidget.DetailedCaptureActivity',
        'android:exported': 'false',
        'android:theme': '@android:style/Theme.NoDisplay',
        'android:excludeFromRecents': 'true',
        'android:noHistory': 'true',
        'android:taskAffinity': '',
      },
    });
    expect(mainActivity.$['android:exported']).toBe('true');
    expect(mainActivity.$['android:launchMode']).toBe('singleTask');
    expect(mainActivity['meta-data']).toEqual([
      {
        $: {
          'android:name': 'android.app.shortcuts',
          'android:resource': '@xml/mindwtr_shortcuts',
        },
      },
    ]);
    expect(mainActivity['intent-filter']).toContainEqual({
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.DEFAULT' } },
        { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
      ],
      data: [{ $: { 'android:scheme': 'mindwtr' } }],
    });
    expect(mainActivity['intent-filter']).toContainEqual({
      action: [{ $: { 'android:name': 'com.google.android.gms.actions.CREATE_NOTE' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.DEFAULT' } },
        { $: { 'android:name': 'android.intent.category.VOICE' } },
      ],
      data: [
        { $: { 'android:mimeType': 'text/plain' } },
        { $: { 'android:mimeType': '*/*' } },
      ],
    });
  });

  it('forwards the detailed launcher through a fixed fresh intent that reuses MainActivity', () => {
    const nativeSourceDir = new URL('../modules/android-widget/android/src/main/java/tech/dongdongbh/mindwtr/androidwidget/', import.meta.url);
    const activitySource = readFileSync(new URL('DetailedCaptureActivity.kt', nativeSourceDir), 'utf8');
    const rendererSource = readFileSync(new URL('WidgetRenderer.kt', nativeSourceDir), 'utf8');
    const appIntentSource = rendererSource.slice(rendererSource.indexOf('fun appIntent('));

    expect(activitySource).toContain('WidgetRenderer.appIntent(this, "mindwtr:///capture-quick?mode=text&entry=details")');
    // appIntent gives a mindwtr: link the app's scheme; RN's own app keeps the module's default, mindwtr.
    expect(appIntentSource).toContain('linkInScheme(uri, context.getString(R.string.mindwtr_link_scheme))');
    expect(readFileSync(new URL('../../../../../res/values/link_scheme.xml', nativeSourceDir), 'utf8'))
      .toContain('<string name="mindwtr_link_scheme" translatable="false">mindwtr</string>');
    expect(activitySource).toContain('finally {\n      finish()');
    expect(activitySource).not.toMatch(/intent[?.]|Intent\(intent|putExtra|FLAG_ACTIVITY_CLEAR_TASK/);
    expect(appIntentSource).toContain('Intent(Intent.ACTION_VIEW)');
    expect(appIntentSource).toContain('setClassName(context.packageName, "${context.packageName}.MainActivity")');
    expect(appIntentSource).toContain('Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP');
    expect(appIntentSource).not.toContain('FLAG_ACTIVITY_CLEAR_TASK');
  });

  it('adds the AndroidX core dependency required by App Actions shortcut capabilities', () => {
    const gradle = `android {
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

    const patched = addAndroidxCoreDependency(gradle);
    expect(patched).toContain('implementation "androidx.core:core:1.13.1"');
    expect(addAndroidxCoreDependency(patched)).toBe(patched);
  });
});
