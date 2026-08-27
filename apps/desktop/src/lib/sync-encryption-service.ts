// Desktop's glue for sync encryption (#1056, phase 2 of 3).
//
// Rust owns key derivation and the OS-keyring cache (apps/desktop/src-tauri/src/
// sync_encryption.rs), plus the two storage seams it drives itself: the File Sync backend and
// the native WebDAV get/put. This module is the other half — the seams that live in the
// webview: Dropbox's data document, all three backends' attachment bytes, WebDAV when a config
// override sends the request through TS instead of Rust, and the shared transition
// orchestration from @mindwtr/core.
//
// Desktop TS never keeps a key cache of its own; every getKey/setKey/clearKey here is a Tauri
// call into Rust's keyring, so there is exactly one source of truth on the device.
//
// Deliberately imports nothing from ./sync-service — that module imports this one.

import {
    acquireSyncRemoteMutationFence,
    createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort,
    DEFAULT_TIMEOUT_MS,
    decryptRemoteArtifactOrThrow,
    defaultSyncCryptoPrimitives,
    deleteDropboxFileVersioned,
    deriveSyncKeyMaterial,
    downloadDropboxFileVersioned,
    encryptSyncArtifact,
    fetchWithTimeout,
    inspectSyncArtifact,
    isSyncRemoteMutationFenceError,
    listDropboxFolderFiles,
    readResponseText,
    runChangeSyncEncryptionPassphraseOverRemote,
    runDisableSyncEncryptionLocalOnly,
    runDisableSyncEncryptionOverRemote,
    runEnableSyncEncryptionLocalOnly,
    runEnableSyncEncryptionOverRemote,
    runProvideSyncEncryptionPassphraseOverRemote,
    sanitizeAttachmentCloudKeyForSyncMerge,
    SYNC_ENCRYPTION_KEYED_STATES,
    SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS,
    SyncCryptoUnsupportedError,
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionTerminalError,
    uploadDropboxFileVersioned,
    webdavDeleteFileVersioned,
    webdavGetFileVersioned,
    webdavPutFileVersioned,
    type AppData,
    type Attachment,
    type SyncCryptoKdfParams,
    type SyncCryptoPrimitives,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemoteInventory,
    type SyncEncryptionRemotePort,
    type SyncEncryptionRemoteRead,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionProgress,
    type SyncEncryptionTransitionKind,
    type SyncKeyMaterial,
    type SyncRemoteMutationFenceLease,
    type SyncRemoteMutationFencePort,
    SyncRemoteMutationFenceUnavailableError,
    type WebDavOptions,
} from '@mindwtr/core';
import { DOMParser } from '@xmldom/xmldom';
import { invokeNative, invokeNativeOr } from './tauri-invoke';

/** The document names a blob remote can hold. Reads of an absent name resolve to `null` and
 *  the core transition loops skip them, so probing existence up front buys nothing. */
const REMOTE_DOCUMENT_NAMES = ['data.json', 'data.json.bak', 'data.json.enc', 'data.json.enc.bak'];

type TransitionRemotePort = SyncEncryptionRemotePort & {
    acquireRemoteMutationFence?: () => Promise<SyncRemoteMutationFenceLease>;
};

/** The transition and durable local commit completed, but the conditional remote
 * fence cleanup did not. Callers must refresh/close as success and show a bounded
 * cleanup warning; retrying the already-completed transition is the wrong remedy. */
export class SyncEncryptionCleanupDeferredError<T = void> extends Error {
    readonly retryAfterMs: number;

    constructor(
        public readonly outcome: T,
        public readonly cleanupCause: unknown,
        retryAfterMs: number,
    ) {
        super('SYNC_ENCRYPTION_COMMITTED_CLEANUP_DEFERRED');
        this.name = 'SyncEncryptionCleanupDeferredError';
        this.retryAfterMs = Math.max(0, Math.floor(retryAfterMs));
        (this as Error & { cause?: unknown }).cause = cleanupCause;
    }
}

export const isSyncEncryptionCleanupDeferredError = (
    error: unknown,
): error is SyncEncryptionCleanupDeferredError<unknown> => (
    error instanceof SyncEncryptionCleanupDeferredError
);

const TRANSITION_FENCE_OPTIONS = {
    ownerId: 'mindwtr-desktop',
    purpose: 'encryption-transition' as const,
};

const sanitizeBlobAttachmentKey = (value: unknown): string | undefined => {
    const key = sanitizeAttachmentCloudKeyForSyncMerge(value);
    return key?.startsWith('attachments/') ? key : undefined;
};

const assertManagedRemoteArtifactName = (name: string): string => {
    if (REMOTE_DOCUMENT_NAMES.includes(name)) return name;
    if (sanitizeBlobAttachmentKey(name) === name) return name;
    throw new Error('Invalid sync encryption remote artifact name');
};

const OFF_STATUS: SyncEncryptionStatus = { state: 'off' };

type NativeKdfParams = { mKib: number; t: number; p: number };
type NativeKeyMaterial = { key: string; salt: string; kdfParams: NativeKdfParams };
type NativeStatus = {
    state: SyncEncryptionStatus['state'];
    kdfParams?: NativeKdfParams;
    hasKey: boolean;
    incompleteTransition?: SyncEncryptionTransitionKind;
};

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

// A keyring read can be an IPC round-trip (and on some Linux backends a prompt), and the
// attachment seams ask for the material once per file. Memoized until a transition changes it —
// so populating `enabledButLocked` alongside it (one extra one-time invoke per cache
// population, not per attachment or per cycle) costs an existing off-state install nothing
// ongoing (backward-compat invariant #1).
let materialCache: { material: SyncKeyMaterial | null; enabledButLocked: boolean } | null = null;

export const clearSyncEncryptionMaterialCache = (): void => {
    materialCache = null;
};

/** `null` whenever this device is not in the 'enabled' state, or is enabled but has no key —
 *  in which case every seam that needs one fails closed rather than silently writing
 *  plaintext into an encrypted folder. Callers that would otherwise treat `null` as "encryption
 *  is off" (e.g. an upload seam falling back to a plaintext write) must check
 *  `isSyncEncryptionEnabledButLocked()` first — see S3. */
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

/** True when local state says `enabled` but no key resolved (S3) — an Android-Keystore-class
 *  keyring invalidation, or a corrupt fallback-key blob. Distinct from "encryption is off":
 *  a seam that resolves `null` material here must fail closed (surface
 *  `SyncEncryptionTerminalError`), never silently write a plaintext artifact into a folder
 *  every other device believes is encrypted. */
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

/** Persists `remote-encrypted-no-key` the moment a TS seam finds ciphertext it cannot open.
 *  Mirrors core's `markRemoteEncryptionDiscovered`; Rust refuses to downgrade a keyed device
 *  whose salt matches the discovery (and deliberately DOES downgrade one holding a
 *  foreign-salt key — that key is provably for another generation, and only the no-key state
 *  surfaces the unlock prompt), so this is safe to call unconditionally from a read path. */
export async function markRemoteSyncEncryptionDiscovered(discovered: {
    salt: Uint8Array;
    params: SyncCryptoKdfParams;
}): Promise<void> {
    // `Or`, not the throwing form: in the web build there is no keyring and no sidecar to
    // persist into, and a discovery must not turn into a second, confusing failure on top of
    // the terminal one the caller is already raising.
    await invokeNativeOr(null, 'mark_sync_encryption_remote_discovered', {
        salt: bytesToHex(discovered.salt),
        kdfParams: discovered.params,
    });
    clearSyncEncryptionMaterialCache();
}

/** Persists `remote-plaintext` when a TS seam holds a key and finds the sync location back in
 *  plaintext (a peer disabled encryption there). Mirrors core's `markRemotePlaintextDiscovered`;
 *  Rust refuses to move any state but `enabled`, so this is safe to call from a read path. */
export async function markRemoteSyncEncryptionPlaintext(): Promise<void> {
    await invokeNativeOr(null, 'mark_sync_encryption_remote_plaintext');
    clearSyncEncryptionMaterialCache();
}

/** No Argon2 in desktop JS: a pure-JS KDF on the webview thread is exactly the freeze the
 *  Tauri-command rules exist to prevent, and Rust already has the identical implementation.
 *  AES-GCM stays in WebCrypto (both desktop webviews have it), which is what core's defaults
 *  already use. */
export const desktopSyncCryptoPrimitives: SyncCryptoPrimitives = {
    ...defaultSyncCryptoPrimitives,
    async argon2id(pass, salt, params, dkLen) {
        if (dkLen !== 32) throw new Error(`unsupported derived key length ${dkLen}`);
        const payload = await invokeNative<NativeKeyMaterial>('derive_sync_encryption_key', {
            // Rust NFC-normalizes too; normalization is idempotent, so re-encoding here is safe.
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

/** Rust's keyring and sidecar, exposed as core's two ports.
 *
 *  Core always calls `keyCache.setKey(key)` and then `localState.write({state, salt, params})`
 *  — the key alone cannot rebuild a header, so the persist is deferred to the write, where
 *  both halves are in hand for the one Rust command. That also
 *  keeps the "persist the enabled flag only after the transition has fully succeeded" rule:
 *  core never reaches the write if any artifact failed.
 *
 *  `localState.write` returns the native persistence promise. When Rust reports a partial
 *  enabled-material commit, the adapter restores the preceding key/state/journal snapshot
 *  before rejecting, so core's compensating key-cache write is not merely an in-memory update. */
const createTransitionPorts = (initial: SyncEncryptionLocalState | null) => {
    let current = initial;
    let pendingKey: Uint8Array | null = null;
    let persistedMaterial: SyncKeyMaterial | null | undefined;
    const queued: Promise<unknown>[] = [];

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

    return {
        keyCache,
        localState,
        restore: async (
            state: SyncEncryptionLocalState | null,
            key: Uint8Array | null,
            attemptedState: SyncEncryptionLocalState | null,
        ) => {
            pendingKey = key;
            current = state;
            await restoreNativeTransitionSnapshot(
                state,
                persistedMaterial ?? null,
                attemptedState ?? state ?? { state: 'off' },
            );
            clearSyncEncryptionMaterialCache();
        },
        flush: async () => {
            await Promise.all(queued);
        },
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

const openTransitionPorts = async () =>
    createTransitionPorts(statusToLocalState(await getSyncEncryptionStatus()));

const createAuthorizedDropboxFencePort = (
    withToken: <T>(operation: (token: string) => Promise<T>) => Promise<T>,
    fetcher: typeof fetch,
): SyncRemoteMutationFencePort => {
    const portFor = (token: string) => createDropboxSyncRemoteMutationFencePort(token, fetcher);
    const conflictClassifier = portFor('');
    return {
        read: () => withToken((token) => portFor(token).read()),
        write: (bytes, expectedVersion) => withToken((token) =>
            portFor(token).write(bytes, expectedVersion)),
        remove: (expectedVersion) => withToken((token) => portFor(token).remove(expectedVersion)),
        isConflict: conflictClassifier.isConflict,
    };
};

const runWithRemoteMutationFence = async <T>(
    remote: SyncEncryptionRemotePort,
    ports: ReturnType<typeof createTransitionPorts>,
    operation: (
        guardedRemote: SyncEncryptionRemotePort,
        guardedKeyCache: SyncEncryptionKeyCachePort,
        guardedLocalState: SyncEncryptionLocalStatePort,
    ) => Promise<T>,
): Promise<T> => {
    const acquire = (remote as TransitionRemotePort).acquireRemoteMutationFence;
    if (!acquire) {
        const result = await operation(remote, ports.keyCache, ports.localState);
        await ports.flush();
        return result;
    }

    const lease = await acquire();
    const runLeaseOperation = async (message: string, action: () => Promise<void>): Promise<void> => {
        try {
            await action();
        } catch (error) {
            if (isSyncRemoteMutationFenceError(error)) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new SyncRemoteMutationFenceUnavailableError(`${message}: ${detail}`);
        }
    };
    const assertHeld = (minRemainingMs = 0) => runLeaseOperation(
        'Remote sync mutation fence validation failed',
        () => lease.assertHeld(minRemainingMs),
    );
    const renewHeld = () => runLeaseOperation(
        'Remote sync mutation fence renewal failed',
        () => lease.renew(),
    );
    const previousState = ports.localState.read();
    const previousKey = await ports.keyCache.getKey();
    let localMaterialTouched = false;
    let finalStateWriteAttempted = false;
    let stateBeforeFinalCommit = previousState;
    let attemptedFinalState: SyncEncryptionLocalState | null = null;
    const guardedRemote: SyncEncryptionRemotePort = {
        ...remote,
        list: async () => {
            await assertHeld();
            return remote.list();
        },
        captureInventory: remote.captureInventory
            ? async (recoveryPassphrase) => {
                await assertHeld();
                return remote.captureInventory!(recoveryPassphrase);
            }
            : undefined,
        read: async (name) => {
            await assertHeld();
            return remote.read(name);
        },
        write: async (name, bytes, expectedVersion) => {
            await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            await remote.write(name, bytes, expectedVersion);
        },
        remove: async (name, expectedVersion) => {
            await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            await remote.remove(name, expectedVersion);
        },
    };
    const guardedKeyCache: SyncEncryptionKeyCachePort = {
        getKey: () => ports.keyCache.getKey(),
        setKey: async (key) => {
            await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            localMaterialTouched = true;
            await ports.keyCache.setKey(key);
        },
        clearKey: async () => {
            await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            localMaterialTouched = true;
            await ports.keyCache.clearKey();
        },
    };
    const guardedLocalState: SyncEncryptionLocalStatePort = {
        read: () => ports.localState.read(),
        write: async (state) => {
            if (state?.incompleteTransition) {
                await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            } else {
                stateBeforeFinalCommit = ports.localState.read();
                attemptedFinalState = state;
                finalStateWriteAttempted = true;
                await renewHeld();
            }
            await ports.localState.write(state);
        },
    };

    let result: T;
    try {
        result = await operation(guardedRemote, guardedKeyCache, guardedLocalState);
        await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
        await ports.flush();
        await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
    } catch (primaryError) {
        let failureToThrow = primaryError;
        if (isSyncRemoteMutationFenceError(primaryError) && (localMaterialTouched || finalStateWriteAttempted)) {
            try {
                if (finalStateWriteAttempted) {
                    await ports.restore(stateBeforeFinalCommit, previousKey, attemptedFinalState);
                } else if (previousKey) {
                    await ports.keyCache.setKey(previousKey);
                } else {
                    await ports.keyCache.clearKey();
                }
                await ports.flush();
            } catch (rollbackError) {
                const failure = new Error('Failed to roll back sync encryption material after remote fence loss');
                (failure as Error & { cause?: unknown; rollbackError?: unknown }).cause = primaryError;
                (failure as Error & { rollbackError?: unknown }).rollbackError = rollbackError;
                failureToThrow = failure;
            }
        }
        try {
            await lease.release();
        } catch (cleanupError) {
            if (failureToThrow instanceof Error) {
                (failureToThrow as Error & { cleanupError?: unknown }).cleanupError = cleanupError;
            }
        }
        throw failureToThrow;
    }

    try {
        await lease.release();
    } catch (cleanupError) {
        let retryAfterMs = 0;
        try {
            retryAfterMs = lease.retryAfterMs();
        } catch {
            // The cleanup failure remains bounded by the lease protocol even if
            // the adapter cannot provide a more precise remaining duration.
        }
        throw new SyncEncryptionCleanupDeferredError(result, cleanupError, retryAfterMs);
    }
    return result;
};

// ---------------------------------------------------------------------------
// Remote ports
// ---------------------------------------------------------------------------

const collectRemoteAttachmentKeys = (data: AppData | null): string[] => {
    if (!data) return [];
    const keys = new Set<string>();
    const visit = (attachments: Attachment[] | undefined) => {
        for (const attachment of attachments ?? []) {
            const key = sanitizeBlobAttachmentKey(attachment.cloudKey);
            if (key) keys.add(key);
        }
    };
    for (const task of data.tasks ?? []) visit(task.attachments);
    for (const project of data.projects ?? []) visit(project.attachments);
    return Array.from(keys).sort();
};

const PROVIDER_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
const DAV_NAMESPACE = 'DAV:';
const DAV_PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

const webdavInventoryHeaders = (options: WebDavOptions): Record<string, string> => {
    const headers: Record<string, string> = {
        ...(options.headers ?? {}),
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: '1',
    };
    if (options.username && typeof options.password === 'string') {
        headers.Authorization = `Basic ${bytesToBase64(new TextEncoder().encode(`${options.username}:${options.password}`))}`;
    }
    return headers;
};

const directDavChildren = (element: Element, localName: string): Element[] =>
    Array.from(element.childNodes).filter((node): node is Element => (
        node.nodeType === 1
        && (node as Element).namespaceURI === DAV_NAMESPACE
        && (node as Element).localName === localName
    ));

const requireSuccessfulDavStatus = (element: Element, context: string): void => {
    const statuses = directDavChildren(element, 'status');
    if (statuses.length !== 1) throw new Error(`WebDAV attachment inventory ${context} status is ambiguous`);
    const match = statuses[0]?.textContent?.trim().match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i);
    const status = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
        throw new Error(`WebDAV attachment inventory ${context} failed (${Number.isInteger(status) ? status : 'malformed status'})`);
    }
};

const parseWebdavAttachmentKeys = (xml: string, collectionUrl: string): string[] => {
    const parseErrors: string[] = [];
    const document = new DOMParser({
        errorHandler: (level, message) => parseErrors.push(`${level}: ${String(message)}`),
    }).parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    if (parseErrors.length > 0 || !root || root.namespaceURI !== DAV_NAMESPACE || root.localName !== 'multistatus') {
        throw new Error('WebDAV attachment inventory response is not a valid DAV:multistatus document');
    }

    const responses = directDavChildren(root, 'response');
    if (responses.length === 0) throw new Error('WebDAV attachment inventory has no DAV:response entries');
    const requested = new URL(collectionUrl);
    const collectionPath = decodeURIComponent(requested.pathname).replace(/\/+$/, '/');
    const seenPaths = new Set<string>();
    const keys = new Set<string>();
    let matchedCollection = false;

    for (const response of responses) {
        const hrefs = directDavChildren(response, 'href');
        if (hrefs.length !== 1 || !hrefs[0]?.textContent?.trim()) {
            throw new Error('WebDAV attachment inventory DAV:response href is ambiguous');
        }
        const href = new URL(hrefs[0].textContent.trim(), collectionUrl);
        if (href.origin !== requested.origin || href.search || href.hash) {
            throw new Error('WebDAV attachment inventory returned an unmatched href');
        }
        const path = decodeURIComponent(href.pathname);
        const normalizedPath = path.endsWith('/') ? path.replace(/\/+$/, '/') : path;
        if (seenPaths.has(normalizedPath)) {
            throw new Error('WebDAV attachment inventory returned a duplicate href');
        }
        seenPaths.add(normalizedPath);

        const responseStatuses = directDavChildren(response, 'status');
        if (responseStatuses.length > 0) requireSuccessfulDavStatus(response, `response for ${path}`);
        const propstats = directDavChildren(response, 'propstat');
        if (propstats.length === 0) {
            throw new Error(`WebDAV attachment inventory response for ${path} has no DAV:propstat`);
        }
        let resourceType: Element | null = null;
        for (const propstat of propstats) {
            requireSuccessfulDavStatus(propstat, `propstat for ${path}`);
            const props = directDavChildren(propstat, 'prop');
            if (props.length !== 1) {
                throw new Error(`WebDAV attachment inventory properties for ${path} are ambiguous`);
            }
            const resourceTypes = directDavChildren(props[0]!, 'resourcetype');
            if (resourceTypes.length > 1 || (resourceTypes.length === 1 && resourceType)) {
                throw new Error(`WebDAV attachment inventory resource type for ${path} is ambiguous`);
            }
            resourceType = resourceTypes[0] ?? resourceType;
        }
        if (!resourceType) {
            throw new Error(`WebDAV attachment inventory response for ${path} has no DAV:resourcetype`);
        }
        const isCollection = directDavChildren(resourceType, 'collection').length > 0;
        if (normalizedPath === collectionPath) {
            if (!isCollection || matchedCollection) {
                throw new Error('WebDAV attachment inventory requested collection is ambiguous');
            }
            matchedCollection = true;
            continue;
        }
        if (!normalizedPath.startsWith(collectionPath)) {
            throw new Error('WebDAV attachment inventory returned an unmatched href');
        }
        const leaf = normalizedPath.slice(collectionPath.length).replace(/\/+$/, '');
        if (!leaf || leaf.includes('/')) {
            throw new Error('WebDAV attachment inventory returned a non-child href');
        }
        if (isCollection) continue;
        const key = sanitizeBlobAttachmentKey(`attachments/${leaf}`);
        if (!key) throw new Error('WebDAV attachment inventory returned an invalid attachment name');
        keys.add(key);
    }
    if (!matchedCollection) {
        throw new Error('WebDAV attachment inventory did not identify the requested collection');
    }
    return Array.from(keys).sort();
};

const listWebdavAttachmentKeys = async (
    baseUrl: string,
    options: WebDavOptions,
): Promise<string[]> => {
    const collectionUrl = `${baseUrl.replace(/\/+$/, '')}/attachments/`;
    const response = await fetchWithTimeout(
        collectionUrl,
        {
            method: 'PROPFIND',
            headers: webdavInventoryHeaders(options),
            body: DAV_PROPFIND_BODY,
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.fetcher ?? fetch,
        'WebDAV attachment inventory timed out',
    );
    if (!response.ok) throw new Error(`WebDAV attachment inventory PROPFIND failed (${response.status})`);

    const xml = await readResponseText(response, PROVIDER_INVENTORY_MAX_BYTES);
    return parseWebdavAttachmentKeys(xml, collectionUrl);
};

const listDropboxAttachmentKeys = async (
    accessToken: string,
    fetcher: typeof fetch,
): Promise<string[]> => {
    const keys = new Set<string>();
    for (const entry of await listDropboxFolderFiles(accessToken, '/attachments', fetcher)) {
            const name = entry.name;
            const expectedLowerPath = `/attachments/${name.toLowerCase()}`;
            if (entry.pathLower !== expectedLowerPath) {
                throw new Error('Dropbox attachment inventory file identity is inconsistent');
            }
            const candidate = `attachments/${name}`;
            const key = sanitizeBlobAttachmentKey(candidate);
            if (key !== candidate) {
                throw new Error('Dropbox attachment inventory returned an invalid attachment name');
            }
            keys.add(key);
    }
    return Array.from(keys).sort();
};

/** Remote documents remain a second attachment index so a referenced-but-currently-missing
 *  key is captured as an expected absence. Provider enumeration adds unreferenced files; the
 *  union lets final inventory validation detect create, change, and removal races for both. */
/** Never throws on a document it cannot open — enumerating attachment names is its only job,
 *  and failing the listing aborts the whole transition before the recovery logic that would
 *  have fixed the artifact ever runs (that is what bricked a passphrase-change resume: the
 *  base document is rewrapped first, so the cached key stops opening it).
 *
 *  `recoveryPassphrase` is what keeps "returns null" from trading a hard abort for silent
 *  data loss: on a resume the document is sealed under an ABANDONED intermediate salt, and a
 *  null listing would enumerate zero attachments and leave every one of them behind under a
 *  key nothing ever derives again. Re-deriving from the artifact's OWN header is the same
 *  recovery core's `rewrap` performs on each artifact. */
const decodeDocument = async (
    bytes: Uint8Array | null,
    key: Uint8Array | null,
    recoveryPassphrase?: string,
): Promise<AppData | null> => {
    if (!bytes) return null;
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind === 'unsupported') {
        // Same classification core's `unsupportedArtifact` gives this input class. Parsing it
        // as JSON would throw a raw SyntaxError out of remote.list() instead.
        throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
    }
    if (inspected.kind === 'plaintext') {
        return JSON.parse(new TextDecoder().decode(bytes)) as AppData;
    }
    const candidates: Uint8Array[] = key ? [key] : [];
    if (recoveryPassphrase) {
        const recovered = await deriveSyncKeyMaterial(
            recoveryPassphrase,
            inspected.salt,
            inspected.params,
            desktopSyncCryptoPrimitives,
        );
        candidates.push(recovered.key);
    }
    for (const candidate of candidates) {
        try {
            const plain = await decryptRemoteArtifactOrThrow(bytes, candidate, desktopSyncCryptoPrimitives);
            return JSON.parse(new TextDecoder().decode(plain)) as AppData;
        } catch (error) {
            if (!(error instanceof SyncEncryptionTerminalError)) throw error;
        }
    }
    return null;
};

/** The key is resolved here rather than taken as a parameter: a caller that passed `null` by
 * mistake would enumerate zero attachments and a transition would silently skip all of them.
 * The returned snapshot includes the exact document generations used for that derivation, so
 * core never rereads a newer document and treats its attachment list as if it came from it. */
const captureRemoteInventory = async (
    read: (name: string) => Promise<SyncEncryptionRemoteRead>,
    listAttachmentKeys: () => Promise<string[]>,
    recoveryPassphrase?: string,
): Promise<SyncEncryptionRemoteInventory & { referencedAttachmentKeys: string[] }> => {
    const snapshot = new Map<string, SyncEncryptionRemoteRead>();
    for (const name of REMOTE_DOCUMENT_NAMES) snapshot.set(name, await read(name));
    const listedAttachmentKeys = await listAttachmentKeys();
    const key = (await getSyncEncryptionMaterial())?.key ?? null;
    const referencedAttachmentKeys = new Set<string>();
    for (const name of ['data.json.enc', 'data.json', 'data.json.enc.bak', 'data.json.bak']) {
        const data = await decodeDocument(snapshot.get(name)?.bytes ?? null, key, recoveryPassphrase);
        for (const attachmentKey of collectRemoteAttachmentKeys(data)) {
            referencedAttachmentKeys.add(attachmentKey);
        }
    }
    const referenced = Array.from(referencedAttachmentKeys).sort();
    const attachmentKeys = new Set([...listedAttachmentKeys, ...referenced]);
    for (const name of attachmentKeys) snapshot.set(name, await read(name));
    const entries: SyncEncryptionRemoteEntry[] = [
        ...REMOTE_DOCUMENT_NAMES.map((name) => ({ name, kind: 'document' as const })),
        ...Array.from(attachmentKeys).sort().map((name) => ({ name, kind: 'attachment' as const })),
    ];
    return { entries, snapshot, referencedAttachmentKeys: referenced };
};

const listRemoteEntries = async (
    listAttachmentKeys: () => Promise<string[]>,
    referencedAttachmentKeys: readonly string[],
): Promise<SyncEncryptionRemoteEntry[]> => [
    ...REMOTE_DOCUMENT_NAMES.map((name) => ({ name, kind: 'document' as const })),
    ...Array.from(new Set([...await listAttachmentKeys(), ...referencedAttachmentKeys]))
        .sort()
        .map((name) => ({ name, kind: 'attachment' as const })),
];

export type WebdavRemotePortConfig = {
    baseUrl: string;
    options: WebDavOptions;
};

export function createWebdavRemotePort(config: WebdavRemotePortConfig): TransitionRemotePort {
    const urlFor = (name: string) => `${config.baseUrl}/${assertManagedRemoteArtifactName(name)}`;
    const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
        webdavGetFileVersioned(urlFor(name), config.options);
    const listAttachmentKeys = () => listWebdavAttachmentKeys(config.baseUrl, config.options);
    let referencedAttachmentKeys: string[] = [];
    return {
        acquireRemoteMutationFence: () => acquireSyncRemoteMutationFence(
            createWebdavSyncRemoteMutationFencePort(urlFor('data.json'), config.options),
            TRANSITION_FENCE_OPTIONS,
        ),
        list: () => listRemoteEntries(listAttachmentKeys, referencedAttachmentKeys),
        captureInventory: async (recoveryPassphrase) => {
            const inventory = await captureRemoteInventory(read, listAttachmentKeys, recoveryPassphrase);
            referencedAttachmentKeys = inventory.referencedAttachmentKeys;
            return inventory;
        },
        read,
        write: async (name, bytes, expectedVersion) => {
            await webdavPutFileVersioned(
                urlFor(name), bytes, 'application/octet-stream', expectedVersion, config.options,
            );
        },
        remove: async (name, expectedVersion) => {
            await webdavDeleteFileVersioned(urlFor(name), expectedVersion, config.options);
        },
    };
}

export function createDropboxRemotePort(
    withToken: <T>(operation: (token: string) => Promise<T>) => Promise<T>,
    fetcher: typeof fetch,
): TransitionRemotePort {
    const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
        withToken((token) => downloadDropboxFileVersioned(token, assertManagedRemoteArtifactName(name), fetcher));
    const listAttachmentKeys = () => withToken((token) => listDropboxAttachmentKeys(token, fetcher));
    let referencedAttachmentKeys: string[] = [];
    return {
        acquireRemoteMutationFence: () => acquireSyncRemoteMutationFence(
            createAuthorizedDropboxFencePort(withToken, fetcher),
            TRANSITION_FENCE_OPTIONS,
        ),
        list: () => listRemoteEntries(listAttachmentKeys, referencedAttachmentKeys),
        captureInventory: async (recoveryPassphrase) => {
            const inventory = await captureRemoteInventory(read, listAttachmentKeys, recoveryPassphrase);
            referencedAttachmentKeys = inventory.referencedAttachmentKeys;
            return inventory;
        },
        read,
        write: async (name, bytes, expectedVersion) => {
            await withToken((token) =>
                uploadDropboxFileVersioned(
                    token, assertManagedRemoteArtifactName(name), bytes, expectedVersion, fetcher,
                ),
            );
        },
        remove: async (name, expectedVersion) => {
            await withToken((token) => deleteDropboxFileVersioned(
                token, assertManagedRemoteArtifactName(name), expectedVersion, fetcher,
            ));
        },
    };
}

// ---------------------------------------------------------------------------
// Transitions over a TS-driven remote (Dropbox always; WebDAV under a config override)
// ---------------------------------------------------------------------------

export async function runEnableOverRemote(
    passphrase: string,
    remote: SyncEncryptionRemotePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
): Promise<void> {
    const ports = await openTransitionPorts();
    await runWithRemoteMutationFence(remote, ports, (guardedRemote, keyCache, localState) =>
        runEnableSyncEncryptionOverRemote(
            passphrase,
            guardedRemote,
            keyCache,
            localState,
            onProgress,
            desktopSyncCryptoPrimitives,
        ));
}

/** No configured backend (#1001): derive+persist only, so the first sync a later backend
 *  runs writes ciphertext from its first byte. Core guards the entry state. */
export async function runEnableLocalOnly(passphrase: string): Promise<void> {
    const ports = await openTransitionPorts();
    await runEnableSyncEncryptionLocalOnly(
        passphrase,
        ports.keyCache,
        ports.localState,
        desktopSyncCryptoPrimitives,
    );
    await ports.flush();
}

/** No configured backend: clears this device's key and state; no remote is touched. */
export async function runDisableLocalOnly(): Promise<void> {
    const ports = await openTransitionPorts();
    await runDisableSyncEncryptionLocalOnly(ports.keyCache, ports.localState);
    await ports.flush();
}

export async function runDisableOverRemote(
    remote: SyncEncryptionRemotePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
): Promise<void> {
    const ports = await openTransitionPorts();
    await runWithRemoteMutationFence(remote, ports, (guardedRemote, keyCache, localState) =>
        runDisableSyncEncryptionOverRemote(
            guardedRemote,
            keyCache,
            localState,
            onProgress,
            desktopSyncCryptoPrimitives,
        ));
}

export async function runChangePassphraseOverRemote(
    currentPassphrase: string,
    nextPassphrase: string,
    remote: SyncEncryptionRemotePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
): Promise<void> {
    const ports = await openTransitionPorts();
    await runWithRemoteMutationFence(remote, ports, (guardedRemote, keyCache, localState) =>
        runChangeSyncEncryptionPassphraseOverRemote(
            currentPassphrase,
            nextPassphrase,
            guardedRemote,
            keyCache,
            localState,
            onProgress,
            desktopSyncCryptoPrimitives,
        ));
}

export async function runProvidePassphraseOverRemote(
    passphrase: string,
    remote: SyncEncryptionRemotePort,
): Promise<'ok' | 'wrong-passphrase'> {
    const ports = await openTransitionPorts();
    return runWithRemoteMutationFence(remote, ports, (guardedRemote, keyCache, localState) =>
        runProvideSyncEncryptionPassphraseOverRemote(
            passphrase,
            'data.json',
            guardedRemote,
            keyCache,
            localState,
            desktopSyncCryptoPrimitives,
        ));
}

// ---------------------------------------------------------------------------
// Attachment bytes (WebDAV, Dropbox, and the file backend — all three go through the
// webview's byte primitives, so all three are encrypted here rather than in Rust)
// ---------------------------------------------------------------------------

/** Attachments keep their exact remote name with encrypted bytes: `cloudKey` is identity-keyed
 *  and immutable once uploaded, so renaming would churn every record (pinned decision #1). */
export async function sealAttachmentBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const material = await getSyncEncryptionMaterial();
    if (material) return encryptSyncArtifact(bytes, material);
    if (await isSyncEncryptionEnabledButLocked()) {
        // S3: `enabled` but no key resolved must fail closed — the old `return bytes`
        // fallback here would silently upload a PLAINTEXT attachment into a folder every
        // other device believes is encrypted.
        throw new SyncEncryptionTerminalError(
            new SyncCryptoUnsupportedError('sync encryption is enabled but no key is available on this device'),
        );
    }
    return bytes;
}

/** Plaintext bytes pass straight through: during (and after an interrupted) transition a
 *  remote legitimately holds both generations, and a peer on an older app version can still
 *  upload plaintext. Ciphertext with no key is terminal — never "corrupt, re-upload". */
export async function openAttachmentBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind === 'unsupported') {
        throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
    }
    if (inspected.kind === 'plaintext') return bytes;
    const material = await getSyncEncryptionMaterial();
    if (!material) {
        await markRemoteSyncEncryptionDiscovered({ salt: inspected.salt, params: inspected.params });
        throw new SyncEncryptionTerminalError(
            new SyncCryptoUnsupportedError('encrypted attachment: no key on this device'),
        );
    }
    return decryptRemoteArtifactOrThrow(bytes, material.key, desktopSyncCryptoPrimitives);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Rust's sentinels, mirrored from apps/desktop/src-tauri/src/sync_encryption.rs. */
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

/** A decrypt failure is never a permission problem and never "corrupt data we repaired" — it
 *  is always "this device needs the passphrase again". Returning a discriminant (rather than a
 *  message) keeps the prose out of this module: desktop's toast-i18n test scans showToast's
 *  first argument for literals, so the caller resolves the string. */
export function classifySyncEncryptionFailure(error: unknown): SyncEncryptionFailure | null {
    if (error instanceof SyncEncryptionRemotePlaintextError) return 'remote-plaintext';
    if (error instanceof SyncEncryptionTerminalError) return 'needs-passphrase';
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    // `includes`, not `startsWith`: a Tauri rejection travels through the sync run's own error
    // wrapping before it gets here, the same reason `SYNC_FILE_WRITE_CONFLICT` is matched that
    // way. The two sentinels do not share a prefix, so order only decides which wins on the
    // (impossible) both-present case.
    if (message.includes(SYNC_ENCRYPTION_STATE_UNAVAILABLE)) return 'local-state-unavailable';
    if (message.includes(SYNC_ENCRYPTION_TRANSITION_INCOMPLETE)) return 'transition-incomplete';
    if (message.includes(SYNC_ENCRYPTION_REMOTE_ENCRYPTED)) return 'remote-encrypted-no-key';
    if (message.includes(SYNC_ENCRYPTION_REMOTE_PLAINTEXT)) return 'remote-plaintext';
    if (message.includes(SYNC_ENCRYPTION_TERMINAL)) return 'needs-passphrase';
    return null;
}

export const isSyncEncryptionFailure = (error: unknown): boolean =>
    classifySyncEncryptionFailure(error) !== null;

export const __syncEncryptionServiceTestUtils = {
    base64ToBytes,
    bytesToBase64,
    bytesToHex,
    hexToBytes,
    collectRemoteAttachmentKeys,
    captureRemoteInventory,
    listDropboxAttachmentKeys,
    listWebdavAttachmentKeys,
    parseWebdavAttachmentKeys,
    REMOTE_DOCUMENT_NAMES,
    runWithRemoteMutationFence,
};
