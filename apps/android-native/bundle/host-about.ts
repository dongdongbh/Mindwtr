import { logInfo, logWarn, type NativeAboutHost, type NativeStartupPromptHost } from '@mindwtr/core';


type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};


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


const deviceLocale = (): string => {
    try {
        return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
    } catch {
        return '';
    }
};


const aboutLog: Pick<NativeAboutHost, 'logWarn' | 'logInfo'> = {
    logWarn: (message, error) => {
        try {
            logWarn(message, { scope: 'about', context: { error: error instanceof Error ? error.message : String(error) } });
        } catch {                                                    }
    },
    logInfo: (message, context) => {
        try { logInfo(message, { scope: 'about', context }); } catch {                }
    },
};


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
        ...aboutLog,
    };
};


export const createIOSStartupPromptHost = (keyValue: KeyValue): NativeStartupPromptHost => ({
    app: { platform: 'ios', isFossBuild: false, version: '', packageName: '' },
    storage: {
        getItem: (key) => keyValue.get(key),
        setItem: (key, value) => keyValue.set(key, value),
        removeItem: (key) => keyValue.remove(key),
    },
    fetcher: () => Promise.reject(new Error('Update checks are not available on iOS')),
    ...aboutLog,
});
