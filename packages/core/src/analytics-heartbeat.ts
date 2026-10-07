type StorageLike = {
    getItem: (key: string) => string | null | Promise<string | null>;
    setItem: (key: string, value: string) => void | Promise<void>;
    removeItem?: (key: string) => void | Promise<void>;
};

type HeartbeatFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type AnalyticsHeartbeatEvent = 'heartbeat' | 'opt_out';

type SendHeartbeatRequestOptions = {
    endpointUrl?: string | null;
    distinctId?: string | null;
    /** settings.analyticsProfileId: one id per synced dataset, so several installs count as one profile. */
    profileId?: string | null;
    platform?: string | null;
    channel?: string | null;
    appVersion?: string | null;
    deviceClass?: string | null;
    osMajor?: string | null;
    locale?: string | null;
    storage: StorageLike;
    storageKey?: string;
    enabled?: boolean;
    timeoutMs?: number;
    fetcher: HeartbeatFetch;
    now?: () => Date;
};

export type SendDailyHeartbeatOptions = SendHeartbeatRequestOptions;
export type SendHeartbeatOptOutOptions = SendHeartbeatRequestOptions;

export const HEARTBEAT_LAST_SENT_DAY_KEY = 'mindwtr-analytics-last-heartbeat-day';
export const HEARTBEAT_OPT_OUT_SENT_KEY = 'mindwtr-analytics-opt-out-sent';

const trimValue = (value: string | null | undefined): string => String(value ?? '').trim();

const getIsoDay = (now: Date): string => now.toISOString().slice(0, 10);

const parseEndpoint = (value: string): string | null => {
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (!parsed.protocol || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return null;
        return parsed.toString();
    } catch {
        return null;
    }
};

const buildHeartbeatPayload = (
    options: SendHeartbeatRequestOptions,
    event: AnalyticsHeartbeatEvent
): Record<string, string> | null => {
    const distinctId = trimValue(options.distinctId);
    const profileId = trimValue(options.profileId);
    const platform = trimValue(options.platform);
    const channel = trimValue(options.channel);
    const appVersion = trimValue(options.appVersion);
    const deviceClass = trimValue(options.deviceClass);
    const osMajor = trimValue(options.osMajor);
    const locale = trimValue(options.locale);

    if (!distinctId || !platform || !channel || !appVersion) return null;

    const payload: Record<string, string> = {
        distinct_id: distinctId,
        ...(profileId ? { profile_id: profileId } : {}),
        platform,
        channel,
        app_version: appVersion,
        // Compatibility for servers that still expect `version`.
        version: appVersion,
    };
    if (event !== 'heartbeat') {
        payload.event = event;
    }
    if (event === 'opt_out') {
        payload.analytics_enabled = 'false';
    }
    if (deviceClass) payload.device_class = deviceClass;
    if (osMajor) payload.os_major = osMajor;
    if (locale) payload.locale = locale;
    return payload;
};

async function sendHeartbeatRequest(
    options: SendHeartbeatRequestOptions,
    event: AnalyticsHeartbeatEvent
): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
        if (!options || options.enabled === false) return false;

        const endpoint = parseEndpoint(trimValue(options.endpointUrl));
        const storage = options.storage;
        const payload = buildHeartbeatPayload(options, event);

        if (
            !endpoint
            || !payload
            || !storage
            || typeof storage.getItem !== 'function'
            || typeof storage.setItem !== 'function'
        ) {
            return false;
        }

        const now = options.now ? options.now() : new Date();

        const fetcher = options.fetcher;
        if (typeof fetcher !== 'function') return false;

        const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(500, options.timeoutMs as number) : 5_000;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        timeout = controller
            ? setTimeout(() => controller.abort(), timeoutMs)
            : null;

        const response = await fetcher(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) return false;
        if (event === 'heartbeat') {
            const storageKey = trimValue(options.storageKey) || HEARTBEAT_LAST_SENT_DAY_KEY;
            await storage.setItem(storageKey, getIsoDay(now));
        } else {
            const storageKey = trimValue(options.storageKey) || HEARTBEAT_OPT_OUT_SENT_KEY;
            await storage.setItem(storageKey, now.toISOString());
        }
        return true;
    } catch {
        return false;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function sendDailyHeartbeat(options: SendDailyHeartbeatOptions): Promise<boolean> {
    try {
        if (!options || options.enabled === false) return false;
        const storage = options.storage;
        if (!storage || typeof storage.getItem !== 'function') return false;
        const storageKey = trimValue(options.storageKey) || HEARTBEAT_LAST_SENT_DAY_KEY;
        const now = options.now ? options.now() : new Date();
        const today = getIsoDay(now);
        const lastSentDay = await storage.getItem(storageKey);
        if (lastSentDay === today) return false;
        return await sendHeartbeatRequest(options, 'heartbeat');
    } catch {
        return false;
    }
}

export async function sendHeartbeatOptOut(options: SendHeartbeatOptOutOptions): Promise<boolean> {
    try {
        if (!options || options.enabled === false) return false;
        const storage = options.storage;
        if (!storage || typeof storage.getItem !== 'function') return false;
        const storageKey = trimValue(options.storageKey) || HEARTBEAT_OPT_OUT_SENT_KEY;
        const optOutSentAt = trimValue(await storage.getItem(storageKey));
        if (optOutSentAt) return false;
        return await sendHeartbeatRequest({ ...options, storageKey }, 'opt_out');
    } catch {
        return false;
    }
}

export async function resetHeartbeatOptOutMarker(
    storage: StorageLike,
    storageKey = HEARTBEAT_OPT_OUT_SENT_KEY
): Promise<void> {
    if (!storage) return;
    if (typeof storage.removeItem === 'function') {
        await storage.removeItem(storageKey);
        return;
    }
    if (typeof storage.setItem === 'function') {
        await storage.setItem(storageKey, '');
    }
}

// ---- The mobile apps' heartbeat (React Native's and the native hosts'): their ids, channel, device fields and gates ----

/** The install's anonymous id: a UUID made on the first heartbeat, kept under RN's AsyncStorage key. */
export const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';

export type MobileAnalyticsHeartbeatConfig = {
    analyticsHeartbeatUrl: string;
    analyticsHeartbeatChannel?: string;
    appVersion: string;
    isExpoGo: boolean;
    isFossBuild: boolean;
};

/** The device a mobile heartbeat describes, and its storage and fetch. */
export type MobileHeartbeatDevice = {
    /** RN's Platform.OS. */
    platform: string;
    /** RN's Platform.Version. */
    platformVersion?: string | number | null;
    /** Android's release name (RN's Platform.constants.Release). */
    osRelease?: string | null;
    isPad?: boolean;
    locale: string;
    /** A development build (RN's __DEV__) never sends. */
    isDev: boolean;
    storage: StorageLike;
    fetcher: HeartbeatFetch;
    generateId: () => string;
};

export function isMobileAnalyticsHeartbeatConfigured({
    analyticsHeartbeatUrl,
    isExpoGo,
}: Pick<MobileAnalyticsHeartbeatConfig, 'analyticsHeartbeatUrl' | 'isExpoGo' | 'isFossBuild'>): boolean {
    return !isExpoGo && Boolean(analyticsHeartbeatUrl.trim());
}

export function resolveMobileAnalyticsVersion(
    baseVersion: string,
    releaseVersion?: string | null
): string {
    const base = String(baseVersion || '').trim() || '0.0.0';
    const release = String(releaseVersion || '').trim().replace(/^v/i, '');
    if (!release || release === base) return base;
    if (release.startsWith(`${base}-`)) return release;
    return base;
}

export function getMobileAnalyticsChannel(
    platform: string,
    isFossBuild: boolean,
    configuredChannel?: string | null
): string {
    const channel = String(configuredChannel ?? '').trim();
    if (channel) return channel;
    if (platform === 'ios') return 'app-store';
    if (platform !== 'android') return platform || 'mobile';
    // Release builds bake ANALYTICS_HEARTBEAT_CHANNEL (play-store, android-internal-test,
    // android-direct), so this fallback only fires for builds without one. The old
    // install-referrer probe is gone: testing-track installs carry no referrer and the
    // API can reject, which misfiled Play testers as android-sideload/android-unknown.
    return isFossBuild ? 'fdroid' : 'play-store';
}

export async function getOrCreateAnalyticsDistinctId(storage: StorageLike, generateId: () => string): Promise<string> {
    const existing = (await storage.getItem(ANALYTICS_DISTINCT_ID_KEY) || '').trim();
    if (existing) return existing;
    const generated = generateId();
    await storage.setItem(ANALYTICS_DISTINCT_ID_KEY, generated);
    return generated;
}

export function getMobileDeviceClass(platform: string, isPad?: boolean): string {
    if (platform === 'ios') return isPad === true ? 'tablet' : 'phone';
    if (platform === 'android') return 'phone';
    return 'desktop';
}

export function getMobileOsMajor(platform: string, platformVersion?: string | number | null, osRelease?: string | null): string {
    if (platform === 'ios') {
        const raw = String(platformVersion ?? '');
        const major = raw.match(/\d+/)?.[0];
        return major ? `ios-${major}` : 'ios';
    }
    if (platform === 'android') {
        const raw = String(osRelease ?? platformVersion ?? '');
        const major = raw.match(/\d+/)?.[0];
        return major ? `android-${major}` : 'android';
    }
    return platform || 'mobile';
}

const canSendMobileAnalyticsHeartbeat = (config: MobileAnalyticsHeartbeatConfig, device: MobileHeartbeatDevice): boolean =>
    isMobileAnalyticsHeartbeatConfigured(config) && !device.isDev;

async function buildMobileHeartbeatOptions(config: MobileAnalyticsHeartbeatConfig, device: MobileHeartbeatDevice, profileId: string | null = null) {
    const [distinctId, channel] = await Promise.all([
        getOrCreateAnalyticsDistinctId(device.storage, device.generateId),
        getMobileAnalyticsChannel(device.platform, config.isFossBuild, config.analyticsHeartbeatChannel),
    ]);
    return {
        enabled: true,
        endpointUrl: config.analyticsHeartbeatUrl,
        distinctId,
        profileId,
        platform: device.platform,
        channel,
        appVersion: config.appVersion,
        deviceClass: getMobileDeviceClass(device.platform, device.isPad),
        osMajor: getMobileOsMajor(device.platform, device.platformVersion, device.osRelease),
        locale: device.locale,
        storage: device.storage,
        fetcher: device.fetcher,
    };
}

/** The one opt-out event, when the user turns the heartbeat off. */
export async function sendMobileAnalyticsOptOut(config: MobileAnalyticsHeartbeatConfig, device: MobileHeartbeatDevice): Promise<boolean> {
    if (!canSendMobileAnalyticsHeartbeat(config, device)) return false;
    return sendHeartbeatOptOut(await buildMobileHeartbeatOptions(config, device));
}

/** The day's heartbeat at startup, unless the user turned it off (settings.analytics.heartbeatEnabled). */
export async function sendMobileDailyHeartbeat(
    config: MobileAnalyticsHeartbeatConfig,
    settings: { analytics?: { heartbeatEnabled?: boolean }; analyticsProfileId?: string | null },
    device: MobileHeartbeatDevice,
): Promise<boolean> {
    if (!canSendMobileAnalyticsHeartbeat(config, device)) return false;
    if (settings.analytics?.heartbeatEnabled === false) {
        return false;
    }
    return sendDailyHeartbeat(await buildMobileHeartbeatOptions(config, device, settings.analyticsProfileId ?? null));
}
