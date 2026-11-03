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

export const armAppSearchIndexing = (): void => indexing.arm();

export const disarmAppSearchIndexing = (): void => indexing.disarm();

export const runFullAppSearchReindex = (): Promise<void> => indexing.runFullReindex();

export const enableAppSearchIndexing = (): Promise<void> => indexing.enable();

export const wipeAppSearchIndex = (): Promise<void> => indexing.wipe();

export const syncAppSearchIndexingWithPreference = (): Promise<void> => indexing.syncWithPreference();
