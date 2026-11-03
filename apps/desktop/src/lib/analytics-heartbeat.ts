import {
    type AppData,
    generateUUID,
    resetHeartbeatOptOutMarker,
    sendDailyHeartbeat,
    sendHeartbeatOptOut,
} from '@mindwtr/core';

import { getInstallSourceOrFallback, isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import { normalizeAnalyticsInstallChannel } from './install-source';
import { webStorage } from './storage-adapter-web';

const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';
const ANALYTICS_HEARTBEAT_URL = String(import.meta.env.VITE_ANALYTICS_HEARTBEAT_URL || '').trim();
const ANALYTICS_RELEASE_VERSION = String(
    import.meta.env.VITE_ANALYTICS_RELEASE_VERSION || import.meta.env.VITE_RELEASE_VERSION || ''
).trim();

const parseBool = (value: string | undefined): boolean => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const heartbeatDisabled = parseBool(import.meta.env.VITE_DISABLE_HEARTBEAT);

export const isDesktopAnalyticsHeartbeatConfigured = (): boolean => (
    isTauriRuntime()
    && !heartbeatDisabled
    && Boolean(ANALYTICS_HEARTBEAT_URL)
);

const canSendDesktopAnalyticsHeartbeat = (): boolean => (
    isDesktopAnalyticsHeartbeatConfigured()
    && !import.meta.env.DEV
    && !import.meta.env.VITEST
    && import.meta.env.MODE !== 'test'
    && process.env.NODE_ENV !== 'test'
);

export const detectDesktopPlatform = (): string => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) return 'windows';
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
    return 'unknown';
};

export const getDesktopLocale = (): string => {
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
    return String(candidates?.[0] || '').trim();
};

export const getDesktopOsMajor = (platform: string): string => {
    const userAgent = navigator.userAgent;
    if (platform === 'windows') {
        const match = userAgent.match(/windows nt\s+(\d+)/i);
        if (match?.[1]) return `windows-${match[1]}`;
        return 'windows';
    }
    if (platform === 'macos') {
        const match = userAgent.match(/mac os x\s+(\d+)/i);
        if (match?.[1]) return `macos-${match[1]}`;
        return 'macos';
    }
    if (platform === 'linux') {
        return 'linux';
    }
    return 'unknown';
};

const getOrCreateAnalyticsDistinctId = (): string => {
    const existing = localStorage.getItem(ANALYTICS_DISTINCT_ID_KEY)?.trim();
    if (existing) return existing;
    const generated = generateUUID();
    localStorage.setItem(ANALYTICS_DISTINCT_ID_KEY, generated);
    return generated;
};

export const getDesktopChannel = async (): Promise<string> => {
    if (!isTauriRuntime()) return 'web';
    try {
        const source = await getInstallSourceOrFallback('unknown');
        return normalizeAnalyticsInstallChannel(source);
    } catch {
        return 'unknown';
    }
};

export const resolveDesktopAnalyticsVersion = (
    baseVersion: string,
    releaseVersion: string | null | undefined = ANALYTICS_RELEASE_VERSION
): string => {
    const base = String(baseVersion || '').trim() || '0.0.0';
    const release = String(releaseVersion || '').trim().replace(/^v/i, '');
    if (!release || release === base) return base;
    if (release.startsWith(`${base}-`)) return release;
    return base;
};

export const getDesktopVersion = async (): Promise<string> => {
    if (!isTauriRuntime()) return 'web';
    try {
        const { getVersion } = await import('@tauri-apps/api/app');
        return resolveDesktopAnalyticsVersion(await getVersion());
    } catch {
        return resolveDesktopAnalyticsVersion('0.0.0');
    }
};

type StartupAnalyticsSettings = { heartbeatEnabled: boolean; profileId: string | null };


const getStartupAnalyticsSettings = async (): Promise<StartupAnalyticsSettings> => {
    try {
        const data = isTauriRuntime()
            ? await invokeNative<AppData>('get_data')
            : await webStorage.getData();
        return {
            heartbeatEnabled: data?.settings?.analytics?.heartbeatEnabled !== false,
            profileId: data?.settings?.analyticsProfileId ?? null,
        };
    } catch {
        return { heartbeatEnabled: true, profileId: null };
    }
};

const buildDesktopHeartbeatOptions = async (profileId: string | null = null) => {
    const [channel, appVersion] = await Promise.all([
        getDesktopChannel(),
        getDesktopVersion(),
    ]);
    const platform = detectDesktopPlatform();
    return {
        enabled: true,
        endpointUrl: ANALYTICS_HEARTBEAT_URL,
        distinctId: getOrCreateAnalyticsDistinctId(),
        profileId,
        platform,
        channel,
        appVersion,
        deviceClass: 'desktop',
        osMajor: getDesktopOsMajor(platform),
        locale: getDesktopLocale(),
        storage: localStorage,
        fetcher: fetch,
    };
};

export const sendDesktopAnalyticsOptOut = async (): Promise<boolean> => {
    if (!canSendDesktopAnalyticsHeartbeat()) return false;
    return sendHeartbeatOptOut(await buildDesktopHeartbeatOptions());
};

export const resetDesktopAnalyticsOptOutMarker = async (): Promise<void> => {
    await resetHeartbeatOptOutMarker(localStorage);
};

export const sendDesktopDailyHeartbeat = async (): Promise<void> => {
    if (!canSendDesktopAnalyticsHeartbeat()) return;
    const { heartbeatEnabled, profileId } = await getStartupAnalyticsSettings();
    if (!heartbeatEnabled) return;
    await sendDailyHeartbeat(await buildDesktopHeartbeatOptions(profileId));
};
