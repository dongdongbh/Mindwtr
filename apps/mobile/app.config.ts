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
// APP_VARIANT=development builds "Mindwtr Dev" with its own Android
// applicationId / iOS bundle id, so a dev client installs beside the store app
// instead of replacing it and keeps its own data. Every Android config plugin
// derives its package from android.package, so the suffix carries through.
// iOS keeps sharing the widget App Group and the CloudKit container with the
// store app (both are literal strings in Swift and entitlements); a dev build
// hits CloudKit's Development environment anyway, only widget payloads collide.
const isDevVariant = (process.env.APP_VARIANT ?? '').trim() === 'development';
const isBenchmarkVariant = (process.env.APP_VARIANT ?? '').trim() === 'benchmark';
// RC workflows and development/preview profiles opt in. Stable is off by default.
const watchEnabledValue = (process.env.MINDWTR_WATCH_ENABLED ?? '').trim().toLowerCase();
const watchEnabled = watchEnabledValue === '1' || watchEnabledValue === 'true'
  || (!watchEnabledValue && isDevVariant);
const DEV_VARIANT_ID_SUFFIX = '.dev';
const DEV_VARIANT_NAME_SUFFIX = ' Dev';

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
  };

  return withAppVariant({
    ...base,
    extra,
    ios: {
      ...base.ios,
      infoPlist: { ...base.ios?.infoPlist, MindwtrWatchEnabled: watchEnabled },
    },
    plugins: [
      ...(base.plugins ?? []).filter((entry) => (Array.isArray(entry) ? entry[0] : entry) !== './plugins/ios-watch'),
      ['./plugins/ios-watch', { enabled: watchEnabled }],
    ],
  });
};
