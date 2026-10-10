import { describe, expect, it, vi } from 'vitest';

import {
    ANALYTICS_DISTINCT_ID_KEY,
    HEARTBEAT_LAST_SENT_DAY_KEY,
    HEARTBEAT_OPT_OUT_SENT_KEY,
    isMobileAnalyticsHeartbeatConfigured,
    resetHeartbeatOptOutMarker,
    resolveMobileAnalyticsVersion,
    sendDailyHeartbeat,
    sendHeartbeatOptOut,
    sendMobileAnalyticsOptOut,
    sendMobileDailyHeartbeat,
} from './analytics-heartbeat';

type MemoryStore = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    dump: () => Record<string, string>;
};

const createMemoryStore = (initial: Record<string, string> = {}): MemoryStore => {
    const map = new Map<string, string>(Object.entries(initial));
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, value);
        },
        removeItem: (key: string) => {
            map.delete(key);
        },
        dump: () => Object.fromEntries(map.entries()),
    };
};

const fixedDate = new Date('2026-02-19T12:00:00.000Z');

describe('sendDailyHeartbeat', () => {
    it('sends heartbeat and stores last-sent day', async () => {
        const store = createMemoryStore();
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const sent = await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'ios',
            channel: 'app-store',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(sent).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const call = fetcher.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(String(call.body));
        expect(body).toMatchObject({
            distinct_id: 'device-123',
            platform: 'ios',
            channel: 'app-store',
            app_version: '0.6.17',
            version: '0.6.17',
        });
        expect(store.dump()[HEARTBEAT_LAST_SENT_DAY_KEY]).toBe('2026-02-19');
        expect(body.profile_id).toBeUndefined();
    });

    it('sends the synced analytics profile id next to the install id', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            profileId: ' profile-abc ',
            platform: 'ios',
            channel: 'app-store',
            appVersion: '0.6.17',
            storage: createMemoryStore(),
            now: () => fixedDate,
            fetcher,
        });

        const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
        expect(body).toMatchObject({ distinct_id: 'device-123', profile_id: 'profile-abc' });
    });


    it('preserves prerelease versions in the heartbeat payload', async () => {
        const store = createMemoryStore();
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const sent = await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-rc',
            platform: 'android',
            channel: 'beta',
            appVersion: '1.0.5-rc.1',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(sent).toBe(true);
        const call = fetcher.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(String(call.body));
        expect(body).toMatchObject({
            app_version: '1.0.5-rc.1',
            version: '1.0.5-rc.1',
        });
    });

    it('skips when heartbeat was already sent today', async () => {
        const store = createMemoryStore({
            [HEARTBEAT_LAST_SENT_DAY_KEY]: '2026-02-19',
        });
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const sent = await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'android',
            channel: 'play-store',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(sent).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not store sent day when server responds non-2xx', async () => {
        const store = createMemoryStore();
        const fetcher = vi.fn().mockResolvedValue({ ok: false });

        const sent = await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'macos',
            channel: 'homebrew',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(sent).toBe(false);
        expect(store.dump()[HEARTBEAT_LAST_SENT_DAY_KEY]).toBeUndefined();
    });

    it('skips when disabled or endpoint is invalid', async () => {
        const store = createMemoryStore();
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const disabled = await sendDailyHeartbeat({
            enabled: false,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'linux',
            channel: 'aur-bin',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });
        const invalidUrl = await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'not-a-url',
            distinctId: 'device-123',
            platform: 'linux',
            channel: 'aur-bin',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(disabled).toBe(false);
        expect(invalidUrl).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('includes optional device fields when provided', async () => {
        const store = createMemoryStore();
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const sent = await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'linux',
            channel: 'aur-source',
            appVersion: '0.6.17',
            deviceClass: 'desktop',
            osMajor: 'linux-6',
            locale: 'en-US',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(sent).toBe(true);
        const call = fetcher.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(String(call.body));
        expect(body.device_class).toBe('desktop');
        expect(body.os_major).toBe('linux-6');
        expect(body.locale).toBe('en-US');
    });

    it('fails silently when storage getItem throws', async () => {
        const store = {
            getItem: () => {
                throw new Error('storage read failed');
            },
            setItem: () => undefined,
        };
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        await expect(sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'ios',
            channel: 'app-store',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        })).resolves.toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('fails silently when storage setItem throws', async () => {
        const store = {
            getItem: () => null,
            setItem: () => {
                throw new Error('storage write failed');
            },
        };
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        await expect(sendDailyHeartbeat({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'android',
            channel: 'play-store',
            appVersion: '0.6.17',
            storage: store,
            now: () => fixedDate,
            fetcher,
        })).resolves.toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('sends a one-shot opt-out heartbeat even when daily heartbeat was already sent', async () => {
        const store = createMemoryStore({
            [HEARTBEAT_LAST_SENT_DAY_KEY]: '2026-02-19',
        });
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const sent = await sendHeartbeatOptOut({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'linux',
            channel: 'flathub',
            appVersion: '0.9.4',
            deviceClass: 'desktop',
            osMajor: 'linux',
            locale: 'en-US',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(sent).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const call = fetcher.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(String(call.body));
        expect(body).toMatchObject({
            distinct_id: 'device-123',
            platform: 'linux',
            channel: 'flathub',
            app_version: '0.9.4',
            version: '0.9.4',
            event: 'opt_out',
            analytics_enabled: 'false',
            device_class: 'desktop',
            os_major: 'linux',
            locale: 'en-US',
        });
        expect(store.dump()[HEARTBEAT_LAST_SENT_DAY_KEY]).toBe('2026-02-19');
        expect(store.dump()[HEARTBEAT_OPT_OUT_SENT_KEY]).toBe(fixedDate.toISOString());
    });

    it('skips repeated opt-out heartbeat until the marker is reset', async () => {
        const store = createMemoryStore({
            [HEARTBEAT_OPT_OUT_SENT_KEY]: fixedDate.toISOString(),
        });
        const fetcher = vi.fn().mockResolvedValue({ ok: true });

        const skipped = await sendHeartbeatOptOut({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'android',
            channel: 'play-store',
            appVersion: '0.9.4',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });
        await resetHeartbeatOptOutMarker(store);
        const sent = await sendHeartbeatOptOut({
            enabled: true,
            endpointUrl: 'https://analytics.example.com/heartbeat',
            distinctId: 'device-123',
            platform: 'android',
            channel: 'play-store',
            appVersion: '0.9.4',
            storage: store,
            now: () => fixedDate,
            fetcher,
        });

        expect(skipped).toBe(false);
        expect(sent).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('the mobile heartbeat (React Native and the native hosts)', () => {
    const config = {
        analyticsHeartbeatUrl: 'https://analytics.example.com/heartbeat',
        appVersion: '0.9.4',
        isExpoGo: false,
        isFossBuild: false,
    };
    const device = () => {
        const store = new Map<string, string>();
        const reads: string[] = [];
        const bodies: Record<string, string>[] = [];
        return {
            store, reads, bodies,
            value: {
                platform: 'android', platformVersion: 34, osRelease: '14', locale: 'en-US', isDev: false,
                storage: {
                    getItem: async (key: string) => { reads.push(key); return store.get(key) ?? null; },
                    setItem: async (key: string, value: string) => { store.set(key, value); },
                    removeItem: async (key: string) => { store.delete(key); },
                },
                fetcher: async (_url: string, init?: RequestInit) => {
                    bodies.push(JSON.parse(String(init?.body)));
                    return { ok: true } as Response;
                },
                generateId: () => 'generated-id',
            },
        };
    };

    it('does not read storage or send when the setting is off', async () => {
        const d = device();
        await expect(sendMobileDailyHeartbeat(config, { analytics: { heartbeatEnabled: false } }, d.value)).resolves.toBe(false);
        expect(d.reads).toEqual([]);
        expect(d.bodies).toEqual([]);
    });

    it('lets a configured FOSS build send on its baked channel', async () => {
        const d = device();
        const fossConfig = { ...config, analyticsHeartbeatChannel: 'fdroid', isFossBuild: true };
        expect(isMobileAnalyticsHeartbeatConfigured(fossConfig)).toBe(true);
        await expect(sendMobileDailyHeartbeat(fossConfig, {}, d.value)).resolves.toBe(true);
        expect(d.bodies[0]).toMatchObject({ channel: 'fdroid', distinct_id: 'generated-id', os_major: 'android-14', device_class: 'phone' });
        expect(d.bodies[0].profile_id).toBeUndefined();
    });

    it('sends the synced profile id and keeps the made distinct id', async () => {
        const d = device();
        await expect(sendMobileDailyHeartbeat(config, { analyticsProfileId: 'profile-1' }, d.value)).resolves.toBe(true);
        expect(d.bodies[0]).toMatchObject({ distinct_id: 'generated-id', profile_id: 'profile-1' });
        expect(d.store.get(ANALYTICS_DISTINCT_ID_KEY)).toBe('generated-id');
    });

    it('never sends from a development build', async () => {
        const d = device();
        await expect(sendMobileDailyHeartbeat(config, {}, { ...d.value, isDev: true })).resolves.toBe(false);
        await expect(sendMobileAnalyticsOptOut(config, { ...d.value, isDev: true })).resolves.toBe(false);
        expect(d.bodies).toEqual([]);
    });

    it('sends the opt-out once, from the explicit opt-out', async () => {
        const d = device();
        await expect(sendMobileAnalyticsOptOut(config, d.value)).resolves.toBe(true);
        await expect(sendMobileAnalyticsOptOut(config, d.value)).resolves.toBe(false);
        expect(d.bodies).toHaveLength(1);
        expect(d.bodies[0]).toMatchObject({ event: 'opt_out', analytics_enabled: 'false' });
    });

    it('shows the RC tag only when it extends the app version', () => {
        expect(resolveMobileAnalyticsVersion('1.0.5', 'v1.0.5-rc.1')).toBe('1.0.5-rc.1');
        expect(resolveMobileAnalyticsVersion('1.0.5', 'v1.0.6-rc.1')).toBe('1.0.5');
    });
});
