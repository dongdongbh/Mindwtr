


import {
    SYNC_ENCRYPTION_LOG_EVENTS,
    buildSyncEncryptionRemoteReadExtra,
    createSyncEncryptionService,
    syncEncryptionLogMessage,
    type SyncEncryptionRemoteReadLogInput,
    decryptRemoteArtifactOrThrow,
    defaultSyncCryptoPrimitives,
    encryptSyncArtifact,
    inspectSyncArtifact,
    SYNC_ENCRYPTION_KEYED_STATES,
    SyncCryptoUnsupportedError,
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionTerminalError,
    assertSyncAttachmentEncryptionPosture,
    type SyncCryptoKdfParams,
    type SyncCryptoPrimitives,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionLocationPort,
    type SyncEncryptionService,
    type SyncEncryptionServiceDeps,
    type SyncEncryptionServiceStatePort,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
    type SyncKeyMaterial,
} from '@mindwtr/core';
import { DOMParser } from '@xmldom/xmldom';
import { logInfo, logWarn } from './app-log';
import { invokeNative, invokeNativeOr } from './tauri-invoke';

export {
    isSyncEncryptionCleanupDeferredError,
    SyncEncryptionCleanupDeferredError,
} from '@mindwtr/core';


export const logSyncEncryptionEvent: SyncEncryptionServiceStatePort['logSyncEncryptionEvent'] = (
    event,
    extra,
    options,
) => {
    const message = syncEncryptionLogMessage(event);
    const context = { scope: 'sync', extra, force: options?.force };
    const written = options?.level === 'warn' ? logWarn(message, context) : logInfo(message, context);
    return Promise.resolve(written).then(() => undefined, () => undefined);
};


const logSyncEncryptionRemoteRead = (input: SyncEncryptionRemoteReadLogInput): void => {
    void logInfo(
        syncEncryptionLogMessage(SYNC_ENCRYPTION_LOG_EVENTS.remoteRead),
        { scope: 'sync', extra: buildSyncEncryptionRemoteReadExtra(input) },
    );
};

const OFF_STATUS: SyncEncryptionStatus = { state: 'off' };

type NativeKdfParams = { mKib: number; t: number; p: number };
type NativeKeyMaterial = { key: string; salt: string; kdfParams: NativeKdfParams };
type NativeStatus = {
    state: SyncEncryptionStatus['state'];
    kdfParams?: NativeKdfParams;
    hasKey: boolean;
    incompleteTransition?: SyncEncryptionTransitionKind;


    saltPrefix?: string;


    discoveredScopeLabel?: string;
};


export type DesktopSyncEncryptionPosture = {
    state: SyncEncryptionStatus['state'];
    kdfParams?: SyncCryptoKdfParams;
    hasKey: boolean;
    incompleteTransition?: SyncEncryptionTransitionKind;
    saltPrefix?: string;

    discoveredScopeLabel?: string;
};

export async function getSyncEncryptionPosture(): Promise<DesktopSyncEncryptionPosture> {
    const status = await invokeNativeOr<NativeStatus | null>(null, 'get_sync_encryption_status');
    if (!status) return { state: 'off', hasKey: false };
    return {
        state: status.state,
        kdfParams: status.kdfParams,
        hasKey: status.hasKey,
        incompleteTransition: status.incompleteTransition,
        saltPrefix: status.saltPrefix,
        discoveredScopeLabel: status.discoveredScopeLabel,
    };
}

const base64ToBytes = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
};

const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const hexToBytes = (hex: string): Uint8Array => {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let index = 0; index < out.length; index += 1) {
        out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
};

const toMaterial = (payload: NativeKeyMaterial): SyncKeyMaterial => ({
    key: base64ToBytes(payload.key),
    salt: hexToBytes(payload.salt),
    params: payload.kdfParams,
});


let materialCache: { material: SyncKeyMaterial | null; enabledButLocked: boolean } | null = null;

export const clearSyncEncryptionMaterialCache = (): void => {
    materialCache = null;
};


export async function getSyncEncryptionMaterial(): Promise<SyncKeyMaterial | null> {
    if (materialCache) return materialCache.material;
    const [payload, status] = await Promise.all([
        invokeNativeOr<NativeKeyMaterial | null>(null, 'get_sync_encryption_key_material'),
        invokeNativeOr<NativeStatus | null>(null, 'get_sync_encryption_status'),
    ]);
    const material = payload ? toMaterial(payload) : null;
    const keyed = Boolean(status && SYNC_ENCRYPTION_KEYED_STATES.includes(status.state));
    materialCache = { material, enabledButLocked: keyed && !material };
    return material;
}


export async function isSyncEncryptionEnabledButLocked(): Promise<boolean> {
    await getSyncEncryptionMaterial();
    return materialCache?.enabledButLocked ?? false;
}

export async function getSyncEncryptionStatus(): Promise<SyncEncryptionStatus> {
    const status = await invokeNativeOr<NativeStatus | null>(null, 'get_sync_encryption_status');
    if (!status) return OFF_STATUS;
    return {
        state: status.state,
        kdfParams: status.kdfParams,
        incompleteTransition: status.incompleteTransition,
    };
}


export async function markRemoteSyncEncryptionDiscovered(discovered: {
    salt: Uint8Array;
    params: SyncCryptoKdfParams;
}, locationScope?: string | null): Promise<void> {


    await invokeNativeOr(null, 'mark_sync_encryption_remote_discovered', {
        salt: bytesToHex(discovered.salt),
        kdfParams: discovered.params,


        locationScope: locationScope ?? null,
    });
    clearSyncEncryptionMaterialCache();
}


export async function restoreVerifiedRemoteSyncEncryption(
    material: SyncKeyMaterial,
    locationScope: string,
): Promise<boolean> {
    const restored = await invokeNativeOr(false, 'restore_sync_encryption_verified_remote', {
        salt: bytesToHex(material.salt),
        kdfParams: material.params,
        locationScope,
    });
    if (restored) clearSyncEncryptionMaterialCache();
    return restored;
}


export async function markRemoteSyncEncryptionPlaintext(locationScope?: string | null): Promise<void> {
    await invokeNativeOr(null, 'mark_sync_encryption_remote_plaintext', {
        locationScope: locationScope ?? null,
    });
    clearSyncEncryptionMaterialCache();
}


export const desktopSyncCryptoPrimitives: SyncCryptoPrimitives = {
    ...defaultSyncCryptoPrimitives,
    async argon2id(pass, salt, params, dkLen) {
        if (dkLen !== 32) throw new Error(`unsupported derived key length ${dkLen}`);
        const payload = await invokeNative<NativeKeyMaterial>('derive_sync_encryption_key', {

            passphrase: new TextDecoder().decode(pass),
            salt: bytesToHex(salt),
            kdfParams: params,
        });
        return base64ToBytes(payload.key);
    },
};

const persistNativeEnabledMaterial = async (
    key: Uint8Array,
    state: SyncEncryptionLocalState,
): Promise<void> => {
    if (!state.discoveredSalt || !state.discoveredParams) {
        throw new Error('sync encryption enabled material is incomplete');
    }
    await invokeNative('set_sync_encryption_key_material', {
        key: bytesToBase64(key),
        salt: state.discoveredSalt,
        kdfParams: state.discoveredParams,
    });
};

const restoreNativeTransitionSnapshot = async (
    previousState: SyncEncryptionLocalState | null,
    previousMaterial: SyncKeyMaterial | null,
    attemptedState: SyncEncryptionLocalState,
): Promise<void> => {
    if (previousMaterial) {
        await persistNativeEnabledMaterial(previousMaterial.key, {
            state: 'enabled',
            discoveredSalt: bytesToHex(previousMaterial.salt),
            discoveredParams: previousMaterial.params,
        });
        if (previousState?.state === 'remote-plaintext') {
            await invokeNative('mark_sync_encryption_remote_plaintext');
        }
    } else {
        await invokeNative('clear_sync_encryption_key_material');
        if (previousState?.state === 'remote-encrypted-no-key') {
            const salt = previousState.discoveredSalt ?? attemptedState.discoveredSalt;
            const params = previousState.discoveredParams ?? attemptedState.discoveredParams;
            if (!salt || !params) throw new Error('sync encryption rollback material is incomplete');
            await invokeNative('mark_sync_encryption_remote_discovered', {
                salt,
                kdfParams: params,
            });
        }
    }
    if (previousState?.incompleteTransition) {
        await invokeNative('mark_sync_encryption_transition_incomplete', {
            transitionKind: previousState.incompleteTransition,
        });
    }
};


const createDesktopSyncEncryptionState = (): SyncEncryptionServiceStatePort => {
    let current: SyncEncryptionLocalState | null = null;
    let pendingKey: Uint8Array | null = null;
    let persistedMaterial: SyncKeyMaterial | null | undefined;
    let queued: Promise<unknown>[] = [];

    const keyCache: SyncEncryptionKeyCachePort = {
        async getKey() {
            const material = await getSyncEncryptionMaterial();
            if (persistedMaterial === undefined) persistedMaterial = material;
            return material?.key ?? null;
        },
        async setKey(key) {
            pendingKey = key;
        },
        async clearKey() {
            pendingKey = null;
        },
    };

    const localState: SyncEncryptionLocalStatePort = {
        read: () => current,
        write: (next) => {
            const previous = current;
            current = next;
            const key = pendingKey;
            const operation = (async () => {
                try {
                    if (next?.incompleteTransition) {
                        await invokeNative('mark_sync_encryption_transition_incomplete', {
                            transitionKind: next.incompleteTransition,
                        });
                    } else if (!next || next.state === 'off') {
                        await invokeNative('clear_sync_encryption_key_material');
                    } else if (key && next.discoveredSalt && next.discoveredParams) {
                        await persistNativeEnabledMaterial(key, next);
                    }
                    clearSyncEncryptionMaterialCache();
                } catch (error) {
                    if (current === next) current = previous;
                    if (next && next.state === 'enabled' && key) {
                        try {
                            await restoreNativeTransitionSnapshot(
                                previous,
                                persistedMaterial ?? null,
                                next,
                            );
                        } catch (rollbackError) {
                            clearSyncEncryptionMaterialCache();
                            const commitMessage = error instanceof Error ? error.message : String(error);
                            const rollbackMessage = rollbackError instanceof Error
                                ? rollbackError.message
                                : String(rollbackError);
                            const combined = new Error(
                                `Failed to persist sync encryption material (${commitMessage}); rollback failed (${rollbackMessage})`,
                            );
                            (combined as Error & { cause?: unknown }).cause = error;
                            throw combined;
                        }
                    }
                    clearSyncEncryptionMaterialCache();
                    throw error;
                }
            })();
            queued.push(operation);
            return operation;
        },
    };

    const flush = async () => {
        await Promise.all(queued);
    };

    return {
        loadSyncEncryptionLocalState: async () => {
            current = statusToLocalState(await getSyncEncryptionStatus());
            pendingKey = null;
            persistedMaterial = undefined;
            queued = [];
            void logInfo('Sync encryption state loaded for the core service', {
                scope: 'sync',
                extra: { releaseCheck: 'v1.3.5/desktop-encryption-core-service' },
                force: true,
            });
            return current;
        },

        restoreAfterFenceLoss: async (before, attempted) => {
            pendingKey = before.key;
            current = before.state;
            await restoreNativeTransitionSnapshot(
                before.state,
                persistedMaterial ?? null,
                attempted.state ?? before.state ?? { state: 'off' },
            );
            clearSyncEncryptionMaterialCache();
            await flush();
        },
        flushSyncEncryptionLocalState: flush,
        syncEncryptionLocalState: localState,
        syncEncryptionKeyCache: keyCache,
        getSyncEncryptionMaterial,
        getSyncEncryptionStatus,
        logSyncEncryptionEvent,
    };
};

const statusToLocalState = (status: SyncEncryptionStatus): SyncEncryptionLocalState | null =>
    status.state === 'off' && !status.incompleteTransition
        ? null
        : {
            state: status.state,
            discoveredParams: status.kdfParams,
            incompleteTransition: status.incompleteTransition,
        };


export type DesktopSyncEncryptionHost = Pick<
    SyncEncryptionServiceDeps<string>,
    'fetch' | 'loadWebDavConfig' | 'webDavRequestOptions' | 'getDropboxClientId' | 'runDropboxAuthorized' | 'readTrustedLocalData' | 'fileSync'
> & { location: SyncEncryptionLocationPort };

export const createDesktopSyncEncryptionService = (host: DesktopSyncEncryptionHost): SyncEncryptionService =>
    createSyncEncryptionService<string>({
        ...host,
        fenceOwnerId: 'mindwtr-desktop',
        state: createDesktopSyncEncryptionState(),
        crypto: desktopSyncCryptoPrimitives,
        parseWebdavXml: (source) => {
            const errors: string[] = [];
            const document = new DOMParser({
                errorHandler: (level, message) => errors.push(`${level}: ${String(message)}`),
            }).parseFromString(source, 'application/xml') as unknown as Document;
            return { document, errors };
        },
    });


export async function sealAttachmentBytes(bytes: Uint8Array, artifact?: string | null): Promise<Uint8Array> {
    const label = artifact ?? '';
    const material = await getSyncEncryptionMaterial();
    assertSyncAttachmentEncryptionPosture(await getSyncEncryptionStatus(), material);
    if (material) {
        logSyncEncryptionRemoteRead({ artifact: label, exists: null, kind: 'encrypted', decision: 'seal' });
        return encryptSyncArtifact(bytes, material, desktopSyncCryptoPrimitives, { kind: 'attachment', cloudKey: artifact ?? '' });
    }
    if (await isSyncEncryptionEnabledButLocked()) {


        logSyncEncryptionRemoteRead({ artifact: label, exists: null, kind: 'encrypted', decision: 'no-key' });
        throw new SyncEncryptionTerminalError(
            new SyncCryptoUnsupportedError('sync encryption is enabled but no key is available on this device'),
        );
    }
    logSyncEncryptionRemoteRead({ artifact: label, exists: null, kind: 'plaintext', decision: 'seal' });
    return bytes;
}

export async function assertPlaintextAttachmentTransfer(): Promise<void> {
    assertSyncAttachmentEncryptionPosture(await getSyncEncryptionStatus(), null);
}


export async function openAttachmentBytes(bytes: Uint8Array, artifact?: string | null): Promise<Uint8Array> {
    const label = artifact ?? '';
    const currentMaterial = await getSyncEncryptionMaterial();
    assertSyncAttachmentEncryptionPosture(await getSyncEncryptionStatus(), currentMaterial);
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind === 'unsupported') {
        logSyncEncryptionRemoteRead({ artifact: label, exists: true, kind: 'unsupported', decision: 'decrypt' });
        throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
    }
    if (inspected.kind === 'plaintext') {
        if (await getSyncEncryptionMaterial() || await isSyncEncryptionEnabledButLocked()) {
            throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError('SYNC_ENCRYPTION_PLAINTEXT_ATTACHMENT: restore the attachment from a trusted local copy'));
        }
        logSyncEncryptionRemoteRead({ artifact: label, exists: true, kind: 'plaintext', decision: 'plaintext' });
        return bytes;
    }
    const material = await getSyncEncryptionMaterial();
    if (!material) {
        logSyncEncryptionRemoteRead({
            artifact: label,
            exists: true,
            kind: 'encrypted',
            headerSalt: inspected.salt,
            headerKdf: inspected.params,
            decision: 'no-key',
        });
        await markRemoteSyncEncryptionDiscovered({ salt: inspected.salt, params: inspected.params });
        throw new SyncEncryptionTerminalError(
            new SyncCryptoUnsupportedError('encrypted attachment: no key on this device'),
        );
    }
    logSyncEncryptionRemoteRead({
        artifact: label,
        exists: true,
        kind: 'encrypted',
        headerSalt: inspected.salt,
        headerKdf: inspected.params,
        decision: 'decrypt',
    });
    return decryptRemoteArtifactOrThrow(bytes, material.key, desktopSyncCryptoPrimitives, { kind: 'attachment', cloudKey: artifact ?? '' });
}


export const SYNC_ENCRYPTION_TERMINAL = 'SYNC_ENCRYPTION_TERMINAL';
export const SYNC_ENCRYPTION_STATE_UNAVAILABLE = 'SYNC_ENCRYPTION_STATE_UNAVAILABLE';
export const SYNC_ENCRYPTION_REMOTE_ENCRYPTED = 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED';
export const SYNC_ENCRYPTION_REMOTE_PLAINTEXT = 'SYNC_ENCRYPTION_REMOTE_PLAINTEXT';
export const SYNC_ENCRYPTION_TRANSITION_INCOMPLETE = 'SYNC_ENCRYPTION_TRANSITION_INCOMPLETE';

export type SyncEncryptionFailure =
    | 'local-state-unavailable'
    | 'needs-passphrase'
    | 'remote-encrypted-no-key'
    | 'remote-plaintext'
    | 'transition-incomplete';


export function classifySyncEncryptionFailure(error: unknown): SyncEncryptionFailure | null {
    if (error instanceof SyncEncryptionRemotePlaintextError) return 'remote-plaintext';
    if (error instanceof SyncEncryptionTerminalError) return 'needs-passphrase';
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';


    if (message.includes(SYNC_ENCRYPTION_STATE_UNAVAILABLE)) return 'local-state-unavailable';
    if (message.includes(SYNC_ENCRYPTION_TRANSITION_INCOMPLETE)) return 'transition-incomplete';
    if (message.includes(SYNC_ENCRYPTION_REMOTE_ENCRYPTED)) return 'remote-encrypted-no-key';
    if (message.includes(SYNC_ENCRYPTION_REMOTE_PLAINTEXT)) return 'remote-plaintext';
    if (message.includes(SYNC_ENCRYPTION_TERMINAL)) return 'needs-passphrase';
    return null;
}

export const isSyncEncryptionFailure = (error: unknown): boolean =>
    classifySyncEncryptionFailure(error) !== null;
