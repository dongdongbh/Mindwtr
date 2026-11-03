


import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    createSyncEncryptionStateStore,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionLogEvent,
    type SyncEncryptionStateStore,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
    type SyncKeyMaterial,
} from '@mindwtr/core';

import { logInfo, logWarn } from './app-log';
import { readActiveSyncLocationScope } from './sync-location-scope';
import { deleteSecureConfigValue, getSecureConfigValue, setSecureConfigValue } from './secure-config';

export {
    SyncEncryptionKeyMissingError,
    SyncEncryptionNoKeyError,
    SyncEncryptionStateUnavailableError,
} from '@mindwtr/core';


let store: SyncEncryptionStateStore | null = null;
const stateStore = (): SyncEncryptionStateStore => {
    store ??= createSyncEncryptionStateStore({
        storage: {
            getItem: (key) => AsyncStorage.getItem(key),
            setItem: (key, value) => AsyncStorage.setItem(key, value),
            removeItem: (key) => AsyncStorage.removeItem(key),
        },
        secureConfig: {
            getSecureConfigValue: (key) => getSecureConfigValue(key),
            setSecureConfigValue: (key, value) => setSecureConfigValue(key, value),
            deleteSecureConfigValue: (key) => deleteSecureConfigValue(key),
        },
        readActiveScope: () => readActiveSyncLocationScope(),
        log: {
            info: (message, context) => logInfo(message, context),
            warn: (message, context) => logWarn(message, context),
        },
    });
    return store;
};

export const loadSyncEncryptionLocalState = (): Promise<SyncEncryptionLocalState | null> =>
    stateStore().loadSyncEncryptionLocalState();


export const restoreAfterFenceLoss: SyncEncryptionStateStore['restoreAfterFenceLoss'] = (before, attempted) =>
    stateStore().restoreAfterFenceLoss(before, attempted);

export const flushSyncEncryptionLocalState = (): Promise<void> => stateStore().flushSyncEncryptionLocalState();

export const syncEncryptionLocalState: SyncEncryptionLocalStatePort = {
    read: () => stateStore().syncEncryptionLocalState.read(),
    write: (state) => stateStore().syncEncryptionLocalState.write(state),
};

export const syncEncryptionKeyCache: SyncEncryptionKeyCachePort = {
    getKey: () => stateStore().syncEncryptionKeyCache.getKey(),
    setKey: (key) => stateStore().syncEncryptionKeyCache.setKey(key),
    clearKey: () => stateStore().syncEncryptionKeyCache.clearKey(),
};


export const getSyncEncryptionMaterial = (): Promise<SyncKeyMaterial | null> =>
    stateStore().getSyncEncryptionMaterial();

export const getMobileSyncEncryptionStatus = (): Promise<SyncEncryptionStatus> =>
    stateStore().getSyncEncryptionStatus();

export const getIncompleteSyncEncryptionTransition = (): Promise<SyncEncryptionTransitionKind | null> =>
    stateStore().getIncompleteSyncEncryptionTransition();


export const isSyncEncryptionBlocked = (activeScope: string | null): Promise<boolean> =>
    stateStore().isSyncEncryptionBlocked(activeScope);


export const isSyncEncryptionPostureUnestablished = (
    activeScope: string | null,
    hasCompletedCycleAgainstLocation: boolean,
): Promise<boolean> => stateStore().isSyncEncryptionPostureUnestablished(activeScope, hasCompletedCycleAgainstLocation);


export const logSyncEncryptionEvent = (
    event: SyncEncryptionLogEvent,
    extra: Record<string, string>,
    options?: { level?: 'info' | 'warn'; force?: boolean },
): Promise<void> => stateStore().logSyncEncryptionEvent(event, extra, options);


export const getSyncEncryptionDiagnosticsLines = (): Promise<string[]> =>
    stateStore().getSyncEncryptionDiagnosticsLines();


export const logSyncEncryptionDiagnosticsBlock = (): Promise<void> =>
    stateStore().logSyncEncryptionDiagnosticsBlock();

export const __resetSyncEncryptionStateForTests = (): void => {
    stateStore().reset();
};
