import { logInfo, logWarn, type NativeAboutHost } from '@mindwtr/core';

/** RN's AsyncStorage in place (host-entry.ts keyValue, over RnKeyValue.kt): a write is on disk when it resolves. */
type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};

/** The build as Kotlin gives it (CoreHost's `__mindwtrAppInfo`, from BuildConfig and the device). */
export type NativeAppInfo = NativeAboutHost['app'];

const isAppInfo = (value: unknown): value is NativeAppInfo => {
    if (!value || typeof value !== 'object') return false;
    const info = value as Record<string, unknown>;
    return ['appName', 'version', 'releaseVersion', 'build', 'packageName', 'platform', 'osRelease', 'feedbackEndpointUrl', 'analyticsHeartbeatUrl',
        'analyticsHeartbeatChannel'].every((key) => typeof info[key] === 'string')
        && typeof info.isFossBuild === 'boolean' && typeof info.isDev === 'boolean'
        && (typeof info.platformVersion === 'string' || typeof info.platformVersion === 'number')
        && (info.githubReleasesApi === undefined || typeof info.githubReleasesApi === 'string');
};

/** RN's getDeviceLocale: the device locale the polyfill's Intl resolves (Android's ICU, as Hermes's). */
const deviceLocale = (): string => {
    try {
        return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
    } catch {
        return '';
    }
};

/**
 * Core's About device (createNativeHostContract's `about`, native-host-contract-about.ts) on an Android host: the build Kotlin
 * describes in `__mindwtrAppInfo`, RN's AsyncStorage for the update dot, the heartbeat's id and day and the prompt state (RN's
 * keys, so an upgrade keeps them), the polyfill's fetch (it logs no URL or body), and the recent diagnostics. Null without the
 * app info (the gates' stand-in bridge, iOS).
 */
export const createNativeAbout = (appInfo: unknown, keyValue: KeyValue, generateId: () => string,
    feedbackDiagnostics: () => Promise<string | null>): NativeAboutHost | null => {
    const parsed = typeof appInfo === 'string' ? (() => { try { return JSON.parse(appInfo) as unknown; } catch { return null; } })() : null;
    if (!isAppInfo(parsed)) return null;
    return {
        app: parsed,
        storage: {
            getItem: (key) => keyValue.get(key),
            setItem: (key, value) => keyValue.set(key, value),
            removeItem: (key) => keyValue.remove(key),
        },
        fetcher: (url, init) => fetch(url, init),
        locale: deviceLocale,
        generateId,
        feedbackDiagnostics,
        logWarn: (message, error) => {
            try {
                logWarn(message, { scope: 'about', context: { error: error instanceof Error ? error.message : String(error) } });
            } catch { /* a diagnostic line must never fail its caller */ }
        },
        logInfo: (message, context) => {
            try { logInfo(message, { scope: 'about', context }); } catch { /* as above */ }
        },
    };
};
