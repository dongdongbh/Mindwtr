import type { ConfigContext, ExpoConfig } from 'expo/config';
import { readFileSync } from 'fs';
import { join } from 'path';

const isFossBuild = process.env.FOSS_BUILD === '1' || process.env.FOSS_BUILD === 'true';
const analyticsHeartbeatDisabled = process.env.ANALYTICS_HEARTBEAT_DISABLED === '1'
  || process.env.ANALYTICS_HEARTBEAT_DISABLED === 'true';
const configuredAnalyticsHeartbeatUrl = (process.env.ANALYTICS_HEARTBEAT_URL ?? '').trim();
// Committed default so source-built releases (F-Droid, IzzyOnDroid reproducible builds)
// send the anonymous opt-out heartbeat too — a CI secret cannot reach those builds, and
// baking it from source keeps the FOSS APK byte-identical across rebuilds. Dev builds
// and Expo Go never send regardless of this value.
const DEFAULT_ANALYTICS_HEARTBEAT_URL = 'https://mindwtr-analytics.mindwtr.workers.dev/';
const analyticsHeartbeatUrl = analyticsHeartbeatDisabled
  ? ''
  : (configuredAnalyticsHeartbeatUrl || DEFAULT_ANALYTICS_HEARTBEAT_URL);
const analyticsHeartbeatChannel = (
  process.env.ANALYTICS_HEARTBEAT_CHANNEL
    ?? (isFossBuild && analyticsHeartbeatUrl ? 'fdroid' : '')
).trim();
// Committed by scripts/bump-version.sh so env-free reproducible builds (F-Droid,
// IzzyOnDroid) still report the full release version including any -rc.N suffix.
const committedReleaseVersion = (() => {
  try {
    const parsed = JSON.parse(readFileSync(join(__dirname, 'release-version.json'), 'utf8'));
    return String(parsed.releaseVersion ?? '').trim();
  } catch {
    return '';
  }
})();
const analyticsReleaseVersion = (process.env.ANALYTICS_RELEASE_VERSION ?? '').trim() || committedReleaseVersion;
const feedbackEndpointUrl = (process.env.FEEDBACK_ENDPOINT_URL ?? '').trim();
const dropboxAppKey = (process.env.DROPBOX_APP_KEY ?? '').trim();
const donationPromptEnabled = process.env.DONATION_PROMPT_ENABLED === '1'
  || process.env.DONATION_PROMPT_ENABLED === 'true';
const promptTestControlsEnabled = process.env.PROMPT_TEST_CONTROLS_ENABLED === '1'
  || process.env.PROMPT_TEST_CONTROLS_ENABLED === 'true';
const nanoClarificationRequested = process.env.MINDWTR_NANO_ENABLED === '1'
  || process.env.MINDWTR_NANO_ENABLED === 'true';
// APP_VARIANT=development builds "Mindwtr Dev" with its own Android
// applicationId / iOS bundle id, so a dev client installs beside the store app
// instead of replacing it and keeps its own data. Every Android config plugin
// derives its package from android.package, so the suffix carries through.
// iOS keeps sharing the widget App Group and the CloudKit container with the
// store app (both are literal strings in Swift and entitlements); a dev build
// hits CloudKit's Development environment anyway, only widget payloads collide.
const isDevVariant = (process.env.APP_VARIANT ?? '').trim() === 'development';
const isBenchmarkVariant = (process.env.APP_VARIANT ?? '').trim() === 'benchmark';
// #1215 stays an explicit development evaluation. FOSS and normal builds keep
// API 24 and resolve no ML Kit/AICore dependency.
const nanoClarificationEnabled = nanoClarificationRequested && isDevVariant && !isFossBuild;
// RC workflows and development/preview profiles opt in. Stable is off by default.
const watchEnabledValue = (process.env.MINDWTR_WATCH_ENABLED ?? '').trim().toLowerCase();
const watchEnabled = watchEnabledValue === '1' || watchEnabledValue === 'true'
  || (!watchEnabledValue && isDevVariant);
const DEV_VARIANT_ID_SUFFIX = '.dev';
const DEV_VARIANT_NAME_SUFFIX = ' Dev';
const IOS_WIDGETS_PLUGIN = './plugins/ios-widgets-and-shortcuts';
const IOS_SCENE_LIFECYCLE_PLUGIN = './plugins/ios-scene-lifecycle';

const pluginName = (entry: NonNullable<ExpoConfig['plugins']>[number]): string => (
  (Array.isArray(entry) ? entry[0] : entry) ?? ''
);

const withIosSceneLifecyclePlugin = (
  plugins: NonNullable<ExpoConfig['plugins']>,
): NonNullable<ExpoConfig['plugins']> => {
  const withoutScenePlugin = plugins.filter(
    (entry) => pluginName(entry) !== IOS_SCENE_LIFECYCLE_PLUGIN,
  );
  const widgetsIndex = withoutScenePlugin.findIndex(
    (entry) => pluginName(entry) === IOS_WIDGETS_PLUGIN,
  );
  if (widgetsIndex === -1) {
    throw new Error(
      `[app.config] ${IOS_SCENE_LIFECYCLE_PLUGIN} must run after ${IOS_WIDGETS_PLUGIN}`,
    );
  }
  withoutScenePlugin.splice(widgetsIndex + 1, 0, IOS_SCENE_LIFECYCLE_PLUGIN);
  return withoutScenePlugin;
};

const withAppVariant = (base: ExpoConfig): ExpoConfig => {
  if (!isDevVariant && !isBenchmarkVariant) return base;
  // Benchmark builds are Android-only: iOS extensions still share the store App Group.
  const idSuffix = isBenchmarkVariant ? '.benchmark' : DEV_VARIANT_ID_SUFFIX;
  const nameSuffix = isBenchmarkVariant ? ' Benchmark' : DEV_VARIANT_NAME_SUFFIX;
  const plugins = (base.plugins ?? []).map((entry) => {
    if (!Array.isArray(entry) || entry[0] !== './plugins/android-widget') return entry;
    const props = (entry[1] ?? {}) as { label?: string };
    // The launcher's widget picker lists both apps; label the non-store one.
    return [entry[0], { ...props, label: `${props.label ?? base.name}${nameSuffix}` }] as typeof entry;
  });
  return {
    ...base,
    name: `${base.name}${nameSuffix}`,
    ...(isBenchmarkVariant ? { platforms: ['android' as const], scheme: 'mindwtr-benchmark' } : {}),
    android: { ...base.android, package: `${base.android?.package}${idSuffix}` },
    ios: { ...base.ios, bundleIdentifier: `${base.ios?.bundleIdentifier}${idSuffix}` },
    plugins,
  };
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  const extra = {
    ...(base.extra ?? {}),
    isFossBuild,
    analyticsHeartbeatUrl: isBenchmarkVariant ? '' : analyticsHeartbeatUrl,
    analyticsHeartbeatChannel,
    analyticsReleaseVersion,
    feedbackEndpointUrl,
    dropboxAppKey,
    donationPromptEnabled,
    promptTestControlsEnabled,
    watchEnabled,
    // #1214 is an evaluation prototype. Store/preview builds omit every JS
    // route to the compiled optional module until device quality gates pass.
    appleClarificationPrototypeEnabled: isDevVariant,
    nanoClarificationPrototypeEnabled: nanoClarificationEnabled,
  };

  return withAppVariant({
    ...base,
    extra,
    ios: {
      ...base.ios,
      infoPlist: { ...base.ios?.infoPlist, MindwtrWatchEnabled: watchEnabled },
    },
    plugins: [
      // Expo config mods execute in stack order. Keep this before
      // expo-build-properties so the explicit evaluation floor wins last.
      ['./plugins/android-nano-clarification', { enabled: nanoClarificationEnabled }],
      ...withIosSceneLifecyclePlugin(
        (base.plugins ?? []).filter((entry) => pluginName(entry) !== './plugins/ios-watch'),
      ),
      ['./plugins/ios-watch', { enabled: watchEnabled }],
    ],
  });
};
