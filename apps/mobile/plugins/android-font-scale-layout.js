const { createRunOncePlugin, withMainApplication } = require('@expo/config-plugins');

// React Native 0.81 keeps the Android text layout from the moment a surface was
// laid out. When the system font scale changes while the app process is alive
// (Settings > Display, or an OEM ROM re-applying its font setting to a process
// the background sync worker kept around), MainActivity is recreated on the same
// ReactHost: the new TextViews draw at the new scale while Yoga still holds the
// old measurements, so the last glyph of short labels hard-clips and longer
// labels wrap onto a hidden second line (facebook/react-native#52895, #1161).
// The `enableFontScaleChangesUpdatingLayout` feature flag makes ReactHost
// refresh DisplayMetricsHolder on configuration changes and pass the real
// fontScale to the surface layout constraints. RN only lets `override` run
// once and `loadReactNative` already spent that call, so the app applies its
// flag through `dangerouslyForceOverride` right after it. The returned string
// lists flags that were read before the override (null on RN 0.81) and is
// logged so a logcat capture proves the override landed first.
const IMPORTS = [
  'import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags',
  'import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android',
  'import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsProvider',
];

const OVERRIDE_MARKER = 'override fun enableFontScaleChangesUpdatingLayout(): Boolean = true';

const buildOverride = (indent) => [
  `${indent}val accessedFeatureFlags = ReactNativeFeatureFlags.dangerouslyForceOverride(`,
  `${indent}  object : ReactNativeFeatureFlagsProvider by ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android(`,
  `${indent}    BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,`,
  `${indent}    BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,`,
  `${indent}    BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,`,
  `${indent}  ) {`,
  `${indent}    ${OVERRIDE_MARKER}`,
  `${indent}  }`,
  `${indent})`,
  `${indent}android.util.Log.i("Mindwtr", "font-scale layout flag enabled; flags read before override: " + (accessedFeatureFlags ?: "none"))`,
].join('\n');

const patchMainApplication = (source) => {
  if (source.includes(OVERRIDE_MARKER)) {
    return source;
  }
  const match = source.match(/^([ \t]*)loadReactNative\(this\)[ \t]*\n/m);
  if (!match) {
    return source;
  }
  let next = source.replace(match[0], `${match[0]}${buildOverride(match[1])}\n`);
  const missingImports = IMPORTS.filter((line) => !next.includes(line));
  if (missingImports.length > 0) {
    next = next.replace(
      /^import com\.facebook\.react\.ReactNativeHost\n/m,
      (line) => `${line}${missingImports.join('\n')}\n`,
    );
  }
  return next;
};

const withAndroidFontScaleLayout = (config) =>
  withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      return cfg;
    }
    const patched = patchMainApplication(cfg.modResults.contents);
    if (!patched.includes(OVERRIDE_MARKER)) {
      console.warn('[android-font-scale-layout] unable to patch MainApplication.kt');
    }
    cfg.modResults.contents = patched;
    return cfg;
  });

module.exports = createRunOncePlugin(
  withAndroidFontScaleLayout,
  'mindwtr-android-font-scale-layout',
  '1.0.0',
);

module.exports.__testables = { IMPORTS, OVERRIDE_MARKER, patchMainApplication };
