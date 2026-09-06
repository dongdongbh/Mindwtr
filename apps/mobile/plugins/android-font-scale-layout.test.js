import { describe, expect, it } from 'vitest';

const { IMPORTS, OVERRIDE_MARKER, patchMainApplication } = require('./android-font-scale-layout').__testables;

const template = `package tech.dongdongbh.mindwtr

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage

class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}
`;

// android-startup-trace wraps the same call in a startupSection block.
const wrappedTemplate = template.replace(
  '    loadReactNative(this)\n',
  '    startupSection("native.react_native.load") {\n      loadReactNative(this)\n    }\n',
);

describe('android-font-scale-layout', () => {
  it('forces the font-scale layout flag right after loadReactNative and adds the imports', () => {
    const patched = patchMainApplication(template);
    const lines = patched.split('\n');
    const loadIndex = lines.findIndex((line) => line.trim() === 'loadReactNative(this)');
    expect(loadIndex).toBeGreaterThan(0);
    expect(lines[loadIndex + 1]).toBe('    val accessedFeatureFlags = ReactNativeFeatureFlags.dangerouslyForceOverride(');
    expect(patched).toContain(OVERRIDE_MARKER);
    expect(patched).toContain('ReactNativeFeatureFlagsProvider by ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android(');
    expect(patched).toContain('android.util.Log.i("Mindwtr", "font-scale layout flag enabled');
    for (const line of IMPORTS) {
      expect(patched).toContain(line);
    }
    // The override runs before Expo's lifecycle dispatcher, which is the first thing that could read a flag.
    expect(patched.indexOf(OVERRIDE_MARKER)).toBeLessThan(patched.indexOf('ApplicationLifecycleDispatcher.onApplicationCreate'));
  });

  it('keeps the indentation of a loadReactNative call wrapped by the startup trace', () => {
    const patched = patchMainApplication(wrappedTemplate);
    expect(patched).toContain('      loadReactNative(this)\n      val accessedFeatureFlags = ReactNativeFeatureFlags.dangerouslyForceOverride(');
    expect(patched).toContain('        override fun enableFontScaleChangesUpdatingLayout(): Boolean = true');
  });

  it('is idempotent', () => {
    const once = patchMainApplication(template);
    expect(patchMainApplication(once)).toBe(once);
    expect(once.match(/dangerouslyForceOverride/g)).toHaveLength(1);
  });

  it('leaves a template without loadReactNative untouched', () => {
    const source = template.replace('    loadReactNative(this)\n', '');
    expect(patchMainApplication(source)).toBe(source);
  });
});
