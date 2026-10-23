import { createAppSearchIndexing, nameNotifyListener, useTaskStore } from '@mindwtr/core';

import { logInfo, logWarn } from '@/lib/app-log';
import {
    removeAppSearchDocuments,
    upsertAppSearchDocuments,
    wipeAppSearchIndexNative,
} from '@/modules/app-search';

import {
    clearAppSearchWipeOwed,
    isAppSearchSupported,
    markAppSearchWipeOwed,
    readAppSearchIndexingEnabled,
    readAppSearchWipeOwed,
} from './app-search-preference';

// The Android AppSearch secondary index (#1017): core's service (packages/core/src/app-search-service.ts, shared with the
// native Android app), bound to this app's Expo module, AsyncStorage keys, log and store.
const indexing = createAppSearchIndexing({
    isSupported: () => isAppSearchSupported(),
    readEnabled: () => readAppSearchIndexingEnabled(),
    readWipeOwed: () => readAppSearchWipeOwed(),
    markWipeOwed: () => markAppSearchWipeOwed(),
    clearWipeOwed: () => clearAppSearchWipeOwed(),
    upsert: (docs) => upsertAppSearchDocuments(docs),
    remove: (ids) => removeAppSearchDocuments(ids),
    wipe: () => wipeAppSearchIndexNative(),
    logInfo: (message, extra) => { void logInfo(message, { scope: 'app-search', extra }); },
    logWarn: (message, extra) => { void logWarn(message, { scope: 'app-search', extra }); },
    store: {
        getState: () => useTaskStore.getState(),
        subscribe: (listener) => useTaskStore.subscribe(listener),
    },
    nameListener: (name, listener) => nameNotifyListener(name, listener as never) as typeof listener,
});

export const isAppSearchIndexingArmed = (): boolean => indexing.isArmed();
/** Arms the debounced store subscription. Idempotent and a no-op when unsupported. */
export const armAppSearchIndexing = (): void => indexing.arm();
/** Disarms the subscription without touching the native index (see `wipeAppSearchIndex` for toggle-off). */
export const disarmAppSearchIndexing = (): void => indexing.disarm();
/** Rebuilds the index from scratch: wipe, then upsert every indexable task/project/area. */
export const runFullAppSearchReindex = (): Promise<void> => indexing.runFullReindex();
/** Runs a full reindex, then arms only if the preference still reads on (a toggle-off mid-reindex wins). */
export const enableAppSearchIndexing = (): Promise<void> => indexing.enable();
/** Wipes the native index and disarms — used when the user turns the setting off. */
export const wipeAppSearchIndex = (): Promise<void> => indexing.wipe();
/** Arms (with a seeding full reindex) when the preference is on; finishes an owed wipe when it is off. */
export const syncAppSearchIndexingWithPreference = (): Promise<void> => indexing.syncWithPreference();
