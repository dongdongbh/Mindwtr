import {
    createAppSearchIndexing,
    isSandboxMode,
    logInfo,
    logWarn,
    MOBILE_APP_SEARCH_STORAGE_KEY,
    MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY,
    nameNotifyListener,
    useTaskStore,
    type AppSearchDoc,
    type SettingsDeviceWrite,
} from '@mindwtr/core';

/** RN's AsyncStorage in place (host-entry.ts keyValue, over RnKeyValue.kt): a write is on disk when it resolves. */
type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};

/** HostAppSearch.call through the polyfill's channel: `{ op, ... }`, answering once AppSearch did. */
export type AppSearchCall = (request: { op: 'upsert'; docs: AppSearchDoc[] } | { op: 'remove'; ids: string[] } | { op: 'wipe' } | { op: 'ids' }) => Promise<unknown>;

const APP_SEARCH_KEYS = new Set([MOBILE_APP_SEARCH_STORAGE_KEY, MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY]);

/**
 * Android system search (RN's #1017, pass O2d): core's AppSearch service (app-search-service.ts) on this host. The switch and
 * the owed wipe stay RN's device keys in RN's RKStorage (so an upgraded RN user keeps both, and RN's index is this one);
 * HostAppSearch.kt runs RN's index. Nothing runs below Android 12 or in the sandbox. Null without Kotlin's bridge (iOS, gates).
 */
export const createNativeAppSearch = (info: unknown, call: AppSearchCall | undefined, keyValue: KeyValue) => {
    const parsed = typeof info === 'string' ? (() => { try { return JSON.parse(info) as unknown; } catch { return null; } })() : null;
    if (!call || !parsed || typeof parsed !== 'object') return null;
    const { supported, scheme } = parsed as { supported?: unknown; scheme?: unknown };
    if (typeof supported !== 'boolean' || typeof scheme !== 'string' || !scheme) return null;
    // The ports never reject (core's contract): a key that cannot be stored only loses a retry at the next start.
    const quietly = async (work: () => Promise<void>) => { try { await work(); } catch { /* see above */ } };
    const indexing = createAppSearchIndexing({
        isSupported: () => supported && !isSandboxMode(),
        readEnabled: async () => (await keyValue.get(MOBILE_APP_SEARCH_STORAGE_KEY).catch(() => null)) === 'true',
        readWipeOwed: async () => (await keyValue.get(MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY).catch(() => null)) === 'true',
        markWipeOwed: () => quietly(() => keyValue.set(MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY, 'true')),
        clearWipeOwed: () => quietly(() => keyValue.remove(MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY)),
        upsert: (docs) => call({ op: 'upsert', docs }),
        remove: (ids) => call({ op: 'remove', ids }),
        wipe: () => call({ op: 'wipe' }),
        logInfo: (message, extra) => { logInfo(message, { scope: 'app-search', context: extra }); },
        logWarn: (message, extra) => { logWarn(message, { scope: 'app-search', context: extra }); },
        store: { getState: () => useTaskStore.getState(), subscribe: (listener) => useTaskStore.subscribe(listener) },
        nameListener: (name, listener) => nameNotifyListener(name, listener as never) as typeof listener,
        scheme,
    });
    /** General's switch as core's getGeneralSettings reads it; read again at the start and after each edit. */
    let device = { supported, enabled: false };
    const readSwitch = async () => {
        device = { supported, enabled: (await keyValue.get(MOBILE_APP_SEARCH_STORAGE_KEY).catch(() => null)) === 'true' };
    };
    return {
        /** General's `appSearch` input: the row shows only where the index runs. */
        device: () => (isSandboxMode() ? { supported: false, enabled: false } : device),
        /** At the start (after the validated load and the journal replay): live indexing, or a wipe a switch-off owes. */
        start: async () => {
            if (isSandboxMode()) return;
            await readSwitch();
            await indexing.syncWithPreference();
            try {
                // A tester's proof the start ran: indexing, off, or no index on this Android (below 12).
                logInfo('Native Android system search started', { scope: 'app-search', context: {
                    releaseCheck: 'v1.3.7/native-app-search', outcome: !supported ? 'unsupported' : device.enabled ? 'indexing' : 'off' } });
            } catch { /* logging never changes the start */ }
        },
        /**
         * General's switch (setGeneralSetting's reply): its device writes (owed wipe first, then the switch) go to RKStorage here,
         * never to Kotlin's device store, and the index follows: on, a full reindex then live indexing; off, a wipe.
         */
        applyEdit: async (writes: readonly SettingsDeviceWrite[]): Promise<SettingsDeviceWrite[]> => {
            const own = writes.filter((write) => APP_SEARCH_KEYS.has(write.key));
            if (own.length === 0) return [...writes];
            for (const write of own) {
                if (write.value === null) await keyValue.remove(write.key);
                else await keyValue.set(write.key, write.value);
            }
            await readSwitch();
            void (device.enabled ? indexing.enable() : indexing.wipe());
            return writes.filter((write) => !APP_SEARCH_KEYS.has(write.key));
        },
        /** Debug device check: the ids in the index. */
        ids: () => call({ op: 'ids' }),
    };
};
export type NativeAppSearch = NonNullable<ReturnType<typeof createNativeAppSearch>>;
