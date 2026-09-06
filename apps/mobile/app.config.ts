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
const DEV_VARIANT_ID_SUFFIX = '.dev';
const DEV_VARIANT_NAME_SUFFIX = ' Dev';

const withDevVariant = (base: ExpoConfig): ExpoConfig => {
  if (!isDevVariant) return base;
  const plugins = (base.plugins ?? []).map((entry) => {
    if (!Array.isArray(entry) || entry[0] !== './plugins/android-widget') return entry;
    const props = (entry[1] ?? {}) as { label?: string };
    // The launcher's widget picker lists both apps; label the dev one.
    return [entry[0], { ...props, label: `${props.label ?? base.name}${DEV_VARIANT_NAME_SUFFIX}` }] as typeof entry;
  });
  return {
    ...base,
    name: `${base.name}${DEV_VARIANT_NAME_SUFFIX}`,
    android: { ...base.android, package: `${base.android?.package}${DEV_VARIANT_ID_SUFFIX}` },
    ios: { ...base.ios, bundleIdentifier: `${base.ios?.bundleIdentifier}${DEV_VARIANT_ID_SUFFIX}` },
    plugins,
  };
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  const extra = {
    ...(base.extra ?? {}),
    isFossBuild,
    analyticsHeartbeatUrl,
    analyticsHeartbeatChannel,
    analyticsReleaseVersion,
    feedbackEndpointUrl,
    dropboxAppKey,
    donationPromptEnabled,
    promptTestControlsEnabled,
  };

  return withDevVariant({
    ...base,
    extra,
  });
};
