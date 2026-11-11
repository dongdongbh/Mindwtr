


import {
    SYNC_ENCRYPTION_KEYED_STATES,
    buildSyncLocationScope,
    isSyncEncryptionStateBlocked,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionState,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
} from './sync-encryption';
import {
    SYNC_ENCRYPTION_LOG_EVENTS,
    buildSyncEncryptionStateExtra,
    formatSyncEncryptionDiagnostics,
    syncEncryptionLogMessage,
    type SyncEncryptionLogEvent,
    type SyncEncryptionStateDecision,
} from './sync-encryption-diagnostics';
import type { SyncCryptoKdfParams, SyncKeyMaterial } from './sync-crypto';
import { base64ToBytes, bytesToBase64 } from './base64-bytes';
import {
    CLOUD_PROVIDER_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
    SYNC_ENCRYPTION_STATE_KEY,
    SYNC_PATH_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    type SyncKeyValueStoragePort,
} from './sync-storage-keys';
import type { SecureSyncConfigStore } from './sync-secret-storage';

const SYNC_KEY_LEN = 32;


export const readSyncLocationScope = async (
    storage: Pick<SyncKeyValueStoragePort, 'getItem'>,
): Promise<string | null> => {
    try {
        const [backend, webdavUrl, webdavUsername, cloudProvider, cloudUrl, syncPath] = await Promise.all([
            storage.getItem(SYNC_BACKEND_KEY),
            storage.getItem(WEBDAV_URL_KEY),
            storage.getItem(WEBDAV_USERNAME_KEY),
            storage.getItem(CLOUD_PROVIDER_KEY),
            storage.getItem(CLOUD_URL_KEY),
            storage.getItem(SYNC_PATH_KEY),
        ]);
        return buildSyncLocationScope({
            backend,
            webdavUrl,
            webdavUsername,
            cloudProvider,
            cloudUrl,
            syncPath,
        });
    } catch {
        return null;
    }
};


export class SyncEncryptionNoKeyError extends Error {
    constructor(message = 'This sync folder is encrypted. Enter the sync passphrase to continue.') {
        super(message);
        this.name = 'SyncEncryptionNoKeyError';
    }
}


export class SyncEncryptionKeyMissingError extends Error {
    constructor(message = 'The sync passphrase is no longer available on this device. Enter it again to continue.') {
        super(message);
        this.name = 'SyncEncryptionKeyMissingError';
    }
}


export class SyncEncryptionStateUnavailableError extends Error {
    constructor(message = 'The local sync encryption state could not be read. Try again before syncing.') {
        super(message);
        this.name = 'SyncEncryptionStateUnavailableError';
    }
}

const isKdfParams = (value: unknown): value is SyncCryptoKdfParams => {
    if (!value || typeof value !== 'object') return false;
    const { mKib, t, p } = value as Record<string, unknown>;
    return typeof mKib === 'number' && typeof t === 'number' && typeof p === 'number';
};

const parseLocalState = (raw: string | null): SyncEncryptionLocalState | null => {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<SyncEncryptionLocalState>;
        const incompleteTransition = parsed?.incompleteTransition;
        if (incompleteTransition !== undefined
            && incompleteTransition !== 'enable'
            && incompleteTransition !== 'disable'
            && incompleteTransition !== 'change-passphrase'
            && incompleteTransition !== 'upgrade') {
            throw new SyncEncryptionStateUnavailableError();
        }
        if (parsed?.state !== 'enabled'
            && parsed?.state !== 'remote-encrypted-no-key'
            && parsed?.state !== 'remote-plaintext'
            && !(parsed?.state === 'off' && (incompleteTransition || typeof parsed?.partlyEncryptedScope === 'string'))) {
            throw new SyncEncryptionStateUnavailableError();
        }
        return {
            state: parsed.state,
            discoveredSalt: typeof parsed.discoveredSalt === 'string' ? parsed.discoveredSalt : undefined,
            discoveredParams: isKdfParams(parsed.discoveredParams) ? parsed.discoveredParams : undefined,


            discoveredScope: typeof parsed.discoveredScope === 'string' ? parsed.discoveredScope : undefined,
            incompleteTransition,
            ...(typeof parsed.partlyEncryptedScope === 'string' ? { partlyEncryptedScope: parsed.partlyEncryptedScope } : {}),
        };
    } catch (error) {
        if (error instanceof SyncEncryptionStateUnavailableError) throw error;
        throw new SyncEncryptionStateUnavailableError();
    }
};

const hexToBytes = (hex: string): Uint8Array => {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};


const backendFromScope = (scope: string | null): string => {
    if (!scope) return '-';
    try {
        const parsed: unknown = JSON.parse(scope);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) return parsed[0];
    } catch {

    }
    return '-';
};

type SyncEncryptionPosture = {
    backend: string;
    activeScope: string | null;
    state: SyncEncryptionState | 'unknown';
    hasMaterial: boolean | null;
    localState: SyncEncryptionLocalState | null;
    decision: SyncEncryptionStateDecision;
};

export type SyncEncryptionLogContext = {
    scope: string;
    extra: Record<string, string>;
    force?: boolean;
};


export type SyncEncryptionLogPort = {
    info(message: string, context: SyncEncryptionLogContext): unknown;
    warn(message: string, context: SyncEncryptionLogContext): unknown;
};

export type SyncEncryptionStateStoreDeps = {
    storage: SyncKeyValueStoragePort;
    secureConfig: SecureSyncConfigStore;

    readActiveScope: () => Promise<string | null>;
    log: SyncEncryptionLogPort;
};


export type SyncEncryptionMaterialSnapshot = {
    state: SyncEncryptionLocalState | null;
    key: Uint8Array | null;
};

export type SyncEncryptionStateStore = {
    loadSyncEncryptionLocalState(): Promise<SyncEncryptionLocalState | null>;


    reloadSyncEncryptionLocalStateForRecovery(): Promise<SyncEncryptionLocalState | null>;


    restoreAfterFenceLoss(before: SyncEncryptionMaterialSnapshot, attempted: SyncEncryptionMaterialSnapshot): Promise<void>;
    flushSyncEncryptionLocalState(): Promise<void>;
    syncEncryptionLocalState: SyncEncryptionLocalStatePort;
    syncEncryptionKeyCache: SyncEncryptionKeyCachePort;
    getSyncEncryptionMaterial(): Promise<SyncKeyMaterial | null>;
    getSyncEncryptionStatus(): Promise<SyncEncryptionStatus>;
    getIncompleteSyncEncryptionTransition(): Promise<SyncEncryptionTransitionKind | null>;
    isSyncEncryptionBlocked(activeScope: string | null): Promise<boolean>;
    isSyncEncryptionPostureUnestablished(
        activeScope: string | null,
        hasCompletedCycleAgainstLocation: boolean,
    ): Promise<boolean>;
    logSyncEncryptionEvent(
        event: SyncEncryptionLogEvent,
        extra: Record<string, string>,
        options?: { level?: 'info' | 'warn'; force?: boolean },
    ): Promise<void>;
    getSyncEncryptionDiagnosticsLines(): Promise<string[]>;
    logSyncEncryptionDiagnosticsBlock(): Promise<void>;
    reset(): void;
};

export const createSyncEncryptionStateStore = ({
    storage,
    secureConfig,
    readActiveScope,
    log,
}: SyncEncryptionStateStoreDeps): SyncEncryptionStateStore => {
    let cachedLocalState: SyncEncryptionLocalState | null = null;
    let hydrated = false;

    const loadSyncEncryptionLocalState = async (): Promise<SyncEncryptionLocalState | null> => {
        if (hydrated) return cachedLocalState;
        try {
            cachedLocalState = parseLocalState(await storage.getItem(SYNC_ENCRYPTION_STATE_KEY));
        } catch (error) {
            void log.warn('Failed to read sync encryption state; stopping sync', {
                scope: 'sync',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
            cachedLocalState = null;
            hydrated = false;
            throw error instanceof SyncEncryptionStateUnavailableError
                ? error
                : new SyncEncryptionStateUnavailableError();
        }
        hydrated = true;
        return cachedLocalState;
    };

    const reloadSyncEncryptionLocalStateForRecovery = async (): Promise<SyncEncryptionLocalState | null> => {
        cachedLocalState = null;
        hydrated = false;
        return loadSyncEncryptionLocalState();
    };


    let pendingLocalStateWrites: Promise<unknown> = Promise.resolve();
    let localStateWriteQueue: Promise<unknown> = Promise.resolve();

    const flushSyncEncryptionLocalState = async (): Promise<void> => {
        await pendingLocalStateWrites;
    };

    const syncEncryptionLocalState: SyncEncryptionLocalStatePort = {
        read: () => cachedLocalState,
        write: (state) => {
            const previous = cachedLocalState;
            cachedLocalState = state;
            hydrated = true;
            const queuedWrite = localStateWriteQueue.then(async () => {
                try {
                    if (state === null) {
                        await storage.removeItem(SYNC_ENCRYPTION_STATE_KEY);
                    } else {
                        await storage.setItem(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify(state));
                    }
                } catch (error) {
                    if (cachedLocalState === state) cachedLocalState = previous;
                    void log.warn('Failed to persist sync encryption state', {
                        scope: 'sync',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                    throw error;
                }
            });
            pendingLocalStateWrites = queuedWrite;


            localStateWriteQueue = queuedWrite.catch(() => undefined);
            return queuedWrite;
        },
    };

    const syncEncryptionKeyCache: SyncEncryptionKeyCachePort = {
        getKey: async () => {
            const stored = await secureConfig.getSecureConfigValue(SYNC_ENCRYPTION_KEY_KEY);
            if (!stored) return null;
            const key = base64ToBytes(stored);


            return key.length === SYNC_KEY_LEN ? key : null;
        },
        setKey: async (key) => {
            await secureConfig.setSecureConfigValue(SYNC_ENCRYPTION_KEY_KEY, bytesToBase64(key));
        },
        clearKey: async () => {
            await secureConfig.deleteSecureConfigValue(SYNC_ENCRYPTION_KEY_KEY);
        },
    };

    const keysEqual = (left: Uint8Array | null, right: Uint8Array | null): boolean => {
        if (!left || !right) return left === right;
        if (left.length !== right.length) return false;
        return left.every((value, index) => value === right[index]);
    };

    const restoreAfterFenceLoss = async (
        before: SyncEncryptionMaterialSnapshot,
        attempted: SyncEncryptionMaterialSnapshot,
    ): Promise<void> => {
        const writeLocalStateDurably = async (nextState: SyncEncryptionLocalState | null): Promise<void> => {
            await syncEncryptionLocalState.write(nextState);
            await flushSyncEncryptionLocalState();
        };
        const restoreKey = async (key: Uint8Array | null): Promise<void> => {
            if (key) await syncEncryptionKeyCache.setKey(key);
            else await syncEncryptionKeyCache.clearKey();
        };
        const stateWithRetryJournal = (
            nextState: SyncEncryptionLocalState | null,
        ): SyncEncryptionLocalState | null => {
            const incompleteTransition = before.state?.incompleteTransition;
            if (!incompleteTransition) return nextState;
            return nextState
                ? { ...nextState, incompleteTransition }
                : { state: 'off', incompleteTransition };
        };
        try {


            await writeLocalStateDurably(before.state);
            await restoreKey(before.key);
            return;
        } catch (initialRollbackError) {


            let recoveryReadError: unknown = null;
            try {
                await reloadSyncEncryptionLocalStateForRecovery();
                await syncEncryptionKeyCache.getKey();
            } catch (error) {
                recoveryReadError = error;
            }
            try {
                await writeLocalStateDurably(before.state);
                await restoreKey(before.key);
                return;
            } catch (retryRollbackError) {
                await reloadSyncEncryptionLocalStateForRecovery();
                const durableKey = await syncEncryptionKeyCache.getKey();


                if (keysEqual(durableKey, before.key)) {
                    await writeLocalStateDurably(before.state);
                    return;
                } else if (keysEqual(durableKey, attempted.key)) {
                    await writeLocalStateDurably(stateWithRetryJournal(attempted.state));
                }

                const failure = new Error('Failed to reconcile sync encryption state and key after remote fence loss');
                (failure as Error & { cause?: unknown; retryRollbackError?: unknown }).cause = initialRollbackError;
                (failure as Error & { retryRollbackError?: unknown }).retryRollbackError = retryRollbackError;
                if (recoveryReadError) {
                    (failure as Error & { recoveryReadError?: unknown }).recoveryReadError = recoveryReadError;
                }
                throw failure;
            }
        }
    };


    const getSyncEncryptionMaterial = async (): Promise<SyncKeyMaterial | null> => {
        const state = await loadSyncEncryptionLocalState();


        if (!state || !SYNC_ENCRYPTION_KEYED_STATES.includes(state.state)) return null;
        if (!state.discoveredSalt || !state.discoveredParams) throw new SyncEncryptionKeyMissingError();
        const key = await syncEncryptionKeyCache.getKey();
        if (!key) throw new SyncEncryptionKeyMissingError();
        return { key, salt: hexToBytes(state.discoveredSalt), params: state.discoveredParams };
    };


    const logSyncEncryptionEvent = (
        event: SyncEncryptionLogEvent,
        extra: Record<string, string>,
        options?: { level?: 'info' | 'warn'; force?: boolean },
    ): Promise<void> => {
        const message = syncEncryptionLogMessage(event);
        const context = { scope: 'sync', extra, force: options?.force };
        const written = options?.level === 'warn' ? log.warn(message, context) : log.info(message, context);


        return Promise.resolve(written).then(() => undefined, () => undefined);
    };


    const readSyncEncryptionPosture = async (): Promise<SyncEncryptionPosture> => {
        const activeScope = await readActiveScope();
        const backend = backendFromScope(activeScope);
        let localState: SyncEncryptionLocalState | null = null;
        try {
            localState = await loadSyncEncryptionLocalState();
        } catch {

            return {
                backend,
                activeScope,
                state: 'unknown',
                hasMaterial: null,
                localState: null,
                decision: 'blocked-transition',
            };
        }
        let hasMaterial: boolean | null = null;
        try {
            hasMaterial = (await getSyncEncryptionMaterial()) !== null;
        } catch {

            hasMaterial = false;
        }
        const state = localState?.state ?? 'off';
        let decision: SyncEncryptionStateDecision = 'proceed';
        if (localState?.incompleteTransition) {
            decision = 'blocked-transition';
        } else if (isSyncEncryptionStateBlocked(localState, activeScope)) {
            decision = state === 'remote-plaintext' ? 'blocked-plaintext' : 'blocked-no-key';
        }
        return { backend, activeScope, state, hasMaterial, localState, decision };
    };

    return {
        loadSyncEncryptionLocalState,
        reloadSyncEncryptionLocalStateForRecovery,
        restoreAfterFenceLoss,
        flushSyncEncryptionLocalState,
        syncEncryptionLocalState,
        syncEncryptionKeyCache,
        getSyncEncryptionMaterial,
        getSyncEncryptionStatus: async () => {
            const state = await loadSyncEncryptionLocalState();
            if (!state || state.state === 'off') {

                const partly = state?.partlyEncryptedScope
                    && isSyncEncryptionStateBlocked({ state: 'off', partlyEncryptedScope: state.partlyEncryptedScope }, await readActiveScope().catch(() => null));
                return {
                    state: 'off', incompleteTransition: state?.incompleteTransition,
                    ...(partly ? { partlyEncrypted: true } : {}),
                };
            }
            return {
                state: state.state,
                kdfParams: state.discoveredParams,
                incompleteTransition: state.incompleteTransition,
            };
        },
        getIncompleteSyncEncryptionTransition: async () =>
            (await loadSyncEncryptionLocalState())?.incompleteTransition ?? null,


        isSyncEncryptionBlocked: async (activeScope) => (
            isSyncEncryptionStateBlocked(await loadSyncEncryptionLocalState(), activeScope)
        ),


        isSyncEncryptionPostureUnestablished: async (activeScope, hasCompletedCycleAgainstLocation) => {
            const localState = await loadSyncEncryptionLocalState();


            if (!localState || (localState.state === 'off' && !localState.incompleteTransition)) {
                if (localState?.partlyEncryptedScope && hasCompletedCycleAgainstLocation) {
                    void Promise.resolve(log.info('Sync encryption posture read as off beside a remembered partly encrypted location', {
                        scope: 'sync',
                        extra: { releaseCheck: 'v1.3.5/partly-encrypted-posture-off' },
                    })).catch(() => undefined);
                }
                return !hasCompletedCycleAgainstLocation;
            }
            if (SYNC_ENCRYPTION_KEYED_STATES.includes(localState.state)) return false;


            return localState.discoveredScope !== activeScope;
        },
        logSyncEncryptionEvent,


        getSyncEncryptionDiagnosticsLines: async () => {
            const posture = await readSyncEncryptionPosture();
            return formatSyncEncryptionDiagnostics({
                state: posture.state,
                hasMaterial: posture.hasMaterial,
                salt: posture.localState?.discoveredSalt,
                kdf: posture.localState?.discoveredParams,
                incompleteTransition: posture.localState?.incompleteTransition,
                activeScope: posture.activeScope,
            });
        },


        logSyncEncryptionDiagnosticsBlock: async () => {
            const posture = await readSyncEncryptionPosture();


            await logSyncEncryptionEvent(
                SYNC_ENCRYPTION_LOG_EVENTS.state,
                buildSyncEncryptionStateExtra({
                    backend: posture.backend,
                    trigger: 'manual',
                    state: posture.state,
                    hasMaterial: posture.hasMaterial,
                    salt: posture.localState?.discoveredSalt,
                    kdf: posture.localState?.discoveredParams,
                    incompleteTransition: posture.localState?.incompleteTransition,
                    discoveredScope: posture.localState?.discoveredScope,
                    activeScope: posture.activeScope,
                    decision: posture.decision,
                }),
                { force: true },
            );
        },
        reset: () => {
            cachedLocalState = null;
            hydrated = false;
            pendingLocalStateWrites = Promise.resolve();
            localStateWriteQueue = Promise.resolve();
        },
    };
};
