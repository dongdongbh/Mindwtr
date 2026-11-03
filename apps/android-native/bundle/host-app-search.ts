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
} from '@mindwtr/core';


type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};


export type AppSearchCall = (request: { op: 'upsert'; docs: AppSearchDoc[] } | { op: 'remove'; ids: string[] } | { op: 'wipe' } | { op: 'ids' }) => Promise<unknown>;


export const createNativeAppSearch = (info: unknown, call: AppSearchCall | undefined, keyValue: KeyValue) => {
    const parsed = typeof info === 'string' ? (() => { try { return JSON.parse(info) as unknown; } catch { return null; } })() : null;
    if (!call || !parsed || typeof parsed !== 'object') return null;
    const { supported, scheme } = parsed as { supported?: unknown; scheme?: unknown };
    if (typeof supported !== 'boolean' || typeof scheme !== 'string' || !scheme) return null;

    const quietly = async (work: () => Promise<void>) => { try { await work(); } catch {                 } };
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

    let device = { supported, enabled: false };
    const readSwitch = async () => {
        device = { supported, enabled: (await keyValue.get(MOBILE_APP_SEARCH_STORAGE_KEY).catch(() => null)) === 'true' };
    };
    void readSwitch();
    let logged = false;
    return {

        device: () => (isSandboxMode() ? { supported: false, enabled: false } : device),

        start: async () => {
            if (isSandboxMode()) return;
            await readSwitch();
            await indexing.syncWithPreference();
            if (logged) return;
            logged = true;
            try {

                logInfo('Native Android system search started', { scope: 'app-search', context: {
                    releaseCheck: 'v1.3.8/native-app-search', outcome: !supported ? 'unsupported' : device.enabled ? 'indexing' : 'off' } });
            } catch {                                       }
        },


        apply: async () => {
            await readSwitch();
            void (device.enabled ? indexing.enable() : indexing.wipe());
        },

        ids: () => call({ op: 'ids' }),
    };
};
export type NativeAppSearch = NonNullable<ReturnType<typeof createNativeAppSearch>>;
