import type { ConfigContext, ExpoConfig } from 'expo/config';
import { readFileSync } from 'fs';
import { join } from 'path';

const isFossBuild = process.env.FOSS_BUILD === '1' || process.env.FOSS_BUILD === 'true';
const analyticsHeartbeatDisabled = process.env.ANALYTICS_HEARTBEAT_DISABLED === '1'
  || process.env.ANALYTICS_HEARTBEAT_DISABLED === 'true';
const configuredAnalyticsHeartbeatUrl = (process.env.ANALYTICS_HEARTBEAT_URL ?? '').trim();


const DEFAULT_ANALYTICS_HEARTBEAT_URL = 'https://mindwtr-analytics.mindwtr.workers.dev/';
const analyticsHeartbeatUrl = analyticsHeartbeatDisabled
  ? ''
  : (configuredAnalyticsHeartbeatUrl || DEFAULT_ANALYTICS_HEARTBEAT_URL);
const analyticsHeartbeatChannel = (
  process.env.ANALYTICS_HEARTBEAT_CHANNEL
    ?? (isFossBuild && analyticsHeartbeatUrl ? 'fdroid' : '')
).trim();


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


const isDevVariant = (process.env.APP_VARIANT ?? '').trim() === 'development';
const isBenchmarkVariant = (process.env.APP_VARIANT ?? '').trim() === 'benchmark';
const BENCHMARK_SCHEME = 'mindwtr-benchmark';
const gmailEnabled = !isFossBuild && !isBenchmarkVariant && (isDevVariant
  ? process.env.MINDWTR_GMAIL_DEV_ENABLED === '1'
  : process.env.MINDWTR_GMAIL_PRODUCTION_VERIFIED === '1');
const configuredGmailIosClientId = (process.env.MINDWTR_GMAIL_IOS_CLIENT_ID ?? '').trim();
const gmailIosClientId = /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(configuredGmailIosClientId)
  ? configuredGmailIosClientId
  : '';
const gmailIosEnabled = gmailEnabled && Boolean(gmailIosClientId);
const pccEvaluationOptIn = (process.env.MINDWTR_PCC_EVALUATION_ENABLED ?? '').trim() === '1';
const applePccEvaluationEnabled = isDevVariant && pccEvaluationOptIn;
const PCC_ENTITLEMENT = 'com.apple.developer.private-cloud-compute';

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

  const idSuffix = isBenchmarkVariant ? '.benchmark' : DEV_VARIANT_ID_SUFFIX;
  const nameSuffix = isBenchmarkVariant ? ' Benchmark' : DEV_VARIANT_NAME_SUFFIX;
  const plugins = (base.plugins ?? []).map((entry) => {
    if (!Array.isArray(entry) || entry[0] !== './plugins/android-widget') return entry;
    const props = (entry[1] ?? {}) as { label?: string };

    return [entry[0], { ...props, label: `${props.label ?? base.name}${nameSuffix}` }] as typeof entry;
  });
  return {
    ...base,
    name: `${base.name}${nameSuffix}`,
    ...(isBenchmarkVariant ? { platforms: ['android' as const], scheme: BENCHMARK_SCHEME } : {}),
    android: { ...base.android, package: `${base.android?.package}${idSuffix}` },
    ios: { ...base.ios, bundleIdentifier: `${base.ios?.bundleIdentifier}${idSuffix}` },
    plugins,
  };
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  const inheritedIosInfoPlist = { ...(base.ios?.infoPlist ?? {}) };
  const previousGmailClientId = String(inheritedIosInfoPlist.MindwtrGmailClientId ?? '');
  delete inheritedIosInfoPlist.MindwtrGmailClientId;
  delete inheritedIosInfoPlist.MindwtrGmailEnabled;
  const previousGmailScheme = previousGmailClientId.split('.').reverse().join('.');
  const inheritedUrlTypes = Array.isArray(inheritedIosInfoPlist.CFBundleURLTypes)
    ? inheritedIosInfoPlist.CFBundleURLTypes as { CFBundleURLName?: string; CFBundleURLSchemes?: string[] }[]
    : [];
  const gmailUrlTypes = inheritedUrlTypes.map((entry) => ({
    ...entry,
    CFBundleURLSchemes: (entry.CFBundleURLSchemes ?? []).filter((scheme) => scheme !== previousGmailScheme),
  })).filter((entry) => entry.CFBundleURLSchemes.length > 0);

  const appSchemes = [...(isBenchmarkVariant ? [BENCHMARK_SCHEME] : []), ...(typeof base.scheme === 'string' ? [base.scheme] : (base.scheme ?? []))];
  const firstSchemes = [...appSchemes, ...(gmailUrlTypes[0]?.CFBundleURLSchemes ?? [])];
  if (gmailIosEnabled) firstSchemes.push(gmailIosClientId.split('.').reverse().join('.'));
  if (firstSchemes.length > 0) {
    const firstEntry = gmailUrlTypes.shift();
    gmailUrlTypes.unshift({ ...firstEntry, CFBundleURLSchemes: [...new Set(firstSchemes)] });
  }
  const inheritedIosEntitlements = { ...(base.ios?.entitlements ?? {}) };
  delete inheritedIosEntitlements[PCC_ENTITLEMENT];
  const iosEntitlements = applePccEvaluationEnabled
    ? { ...inheritedIosEntitlements, [PCC_ENTITLEMENT]: true }
    : inheritedIosEntitlements;
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


    appleClarificationPrototypeEnabled: isDevVariant,


    applePccEvaluationEnabled,
  };

  return withAppVariant({
    ...base,
    extra,
    ios: {
      ...base.ios,
      infoPlist: {
        ...inheritedIosInfoPlist,
        ...(gmailUrlTypes.length > 0 ? { CFBundleURLTypes: gmailUrlTypes } : { CFBundleURLTypes: [] }),
        MindwtrGmailEnabled: gmailIosEnabled,
        ...(gmailIosEnabled ? { MindwtrGmailClientId: gmailIosClientId } : {}),
        CFBundleSpokenName: isDevVariant ? 'Mind Water Dev' : 'Mind Water',
        INAlternativeAppNames: [{
          INAlternativeAppName: isDevVariant ? 'Mind Water Dev' : 'Mind Water',
          INAlternativeAppNamePronunciationHint: isDevVariant ? 'mind water dev' : 'mind water',
        }],
        MindwtrWatchEnabled: watchEnabled,
        MindwtrPccEvaluationEnabled: applePccEvaluationEnabled,
      },
      entitlements: Object.keys(iosEntitlements).length > 0 ? iosEntitlements : undefined,
    },
    plugins: [
      ...withIosSceneLifecyclePlugin(
        (base.plugins ?? []).filter((entry) => pluginName(entry) !== './plugins/ios-watch'),
      ),
      ['./plugins/ios-watch', { enabled: watchEnabled }],
      ['./plugins/android-gmail-authorization', { enabled: gmailEnabled }],
    ],
  });
};
