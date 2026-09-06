import { describe, expect, it } from 'vitest';

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
    expect(SHORTCUTS_XML).not.toContain('capture-quick');
    expect(buildShortcutsXml('tech.dongdongbh.mindwtr.dev')).toContain('android:targetPackage="tech.dongdongbh.mindwtr.dev"');
    expect(SHORTCUTS_STRINGS_XML).toContain('<item>Today</item>');
    expect(SHORTCUTS_STRINGS_XML).toContain('<item>Quick capture</item>');
  });

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
