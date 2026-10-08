// The mobile apps' sync-encryption API (#1056 phase 2). Every function dispatches on the
// configured backend and then delegates to the transition orchestration in
// sync-encryption.ts with a remote port — the ordering, verify-before-delete, and resume
// semantics all live there, in one place, for File Sync, WebDAV and Dropbox alike.
//
// The host supplies its stores, crypto, fetch, XML parser and backend config through
// `SyncEncryptionServiceDeps`; File Sync's folder IO and lock stay behind the host's
// `fileSync` port.
//
// Out of scope by design: CloudKit and self-hosted mindwtr-cloud.

import { runSerializedSyncDocumentOperation } from './data-transfer-transaction';
import {
    deleteDropboxFileVersioned,
    downloadDropboxFileVersioned,
    listDropboxFolderFiles,
    uploadDropboxFileVersioned,
} from './dropbox';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeoutAndConsume, readResponseText } from './http-utils';
import { getBaseSyncUrl } from './attachment-paths';
import { bytesToBase64 } from './base64-bytes';
import {
    SyncCryptoUnsupportedError,
    deriveSyncKeyMaterial,
    inspectSyncArtifact,
    type SyncCryptoPrimitives,
} from './sync-crypto';
import {
    SyncEncryptionRemoteConflictError,
    SyncEncryptionBackendIncompatibleError,
    SyncEncryptionRemoteVersionUnavailableError,
    SyncEncryptionTerminalError,
    decryptRemoteArtifactOrThrow,
    reaffirmRemoteEncryptionNoKey,
    runChangeSyncEncryptionPassphraseOverRemote,
    runDisableSyncEncryptionLocalOnly,
    runDisableSyncEncryptionOverRemote,
    runAbandonSyncEncryptionTransition,
    runEnableSyncEncryptionLocalOnly,
    runEnableSyncEncryptionOverRemote,
    runProvideSyncEncryptionPassphraseOverRemote,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemoteInventory,
    type SyncEncryptionRemotePort,
    type SyncEncryptionRemoteRead,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
    type SyncEncryptionTransitionProgress,
} from './sync-encryption';
import {
    SYNC_ENCRYPTION_LOG_EVENTS,
    buildSyncEncryptionTransitionExtra,
    type SyncEncryptionTransitionLogKind,
    type SyncEncryptionTransitionOutcome,
} from './sync-encryption-diagnostics';
import { readSyncLocationScope, type SyncEncryptionStateStore } from './sync-encryption-local-state';
import { sanitizeAttachmentCloudKeyForSyncMerge } from './sync-normalization';
import {
    SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS,
    SyncRemoteMutationFenceUnavailableError,
    acquireSyncRemoteMutationFence,
    isSyncRemoteMutationFenceError,
    type SyncRemoteMutationFenceLease,
    type SyncRemoteMutationFencePort,
} from './sync-remote-fence';
import {
    createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort,
} from './sync-remote-fence-providers';
import { SYNC_FILE_NAME, SyncFileLockUnavailableError } from './sync-service-utils';
import {
    ATTACHMENT_PRESENCE_RECONCILE_KEY,
    CLOUD_PROVIDER_KEY,
    FAST_SYNC_STATE_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    type SyncKeyValueStoragePort,
} from './sync-storage-keys';
import type { AppData } from './types';
import { parseWebdavAttachmentInventory, type WebdavXmlParser } from './webdav-attachment-inventory';
import {
    assertWebdavStrongEtagSupport,
    webdavDeleteFileVersioned,
    webdavGetFileVersioned,
    webdavMakeDirectory,
    webdavPutFileVersioned,
    type WebDavOptions,
} from './webdav';

const BACKUP_FILE_NAME = `${SYNC_FILE_NAME}.bak`;
const DROPBOX_PROVIDER = 'dropbox';
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
        public readonly cleanupKind: 'remote-fence' | 'file-lock' = 'remote-fence',
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
    ownerId: 'mindwtr-mobile',
    purpose: 'encryption-transition' as const,
};
const REMOTE_DOCUMENT_NAMES = new Set([
    SYNC_FILE_NAME,
    `${SYNC_FILE_NAME}.enc`,
    BACKUP_FILE_NAME,
    `${SYNC_FILE_NAME}.enc.bak`,
]);

const sanitizeBlobAttachmentKey = (value: unknown): string | undefined => {
    const key = sanitizeAttachmentCloudKeyForSyncMerge(value);
    return key?.startsWith('attachments/') ? key : undefined;
};

const assertManagedRemoteArtifactName = (name: string): string => {
    if (REMOTE_DOCUMENT_NAMES.has(name)) return name;
    if (sanitizeBlobAttachmentKey(name) === name) return name;
    throw new Error('Invalid sync encryption remote artifact name');
};

export type SyncEncryptionProgressCallback = (progress: SyncEncryptionTransitionProgress) => void;

/** Phase-3 API. `appData` is the caller's current local document — it supplies the
 *  attachment worklist. Transitions never write to it; local data is untouched by
 *  design (backward-compat requirement #4). */
export type SyncEncryptionTransitionOptions = {
    appData?: AppData | null;
    onProgress?: SyncEncryptionProgressCallback;
};

/** Maps a thrown transition failure onto the fixed outcome vocabulary. Anything unrecognised
 *  stays `error` and carries the error NAME plus a clamped, sanitized message — never a
 *  passphrase, which no transition error message contains. */
const transitionOutcomeForError = (error: unknown): SyncEncryptionTransitionOutcome => {
    if (error instanceof SyncEncryptionRemoteConflictError) return 'conflict';
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/only available for File Sync|no sync backend|not configured/i.test(message)) return 'backend-required';
    if (/wrong passphrase/i.test(message)) return 'wrong-passphrase';
    return 'error';
};

/**
 * The artifact set a transition covers, derived from authoritative provider enumeration
 * plus the remote document. The provider list includes unreferenced files; the document
 * keeps referenced-but-missing keys in the inventory so a peer creation is also detected.
 *
 * Both the plaintext and `.enc` names are listed for every document: core uses the `.enc`
 * entries to resume (re-deriving the key from an already-written header) and the plain
 * entries as the migration worklist, and its port reads return `null` for whichever side
 * does not exist.
 */
const buildTransitionEntries = (appData: AppData | null): SyncEncryptionRemoteEntry[] => {
    const entries: SyncEncryptionRemoteEntry[] = [
        { name: SYNC_FILE_NAME, kind: 'document' },
        { name: `${SYNC_FILE_NAME}.enc`, kind: 'document' },
        { name: BACKUP_FILE_NAME, kind: 'document' },
        { name: `${SYNC_FILE_NAME}.enc.bak`, kind: 'document' },
    ];
    if (!appData) return entries;
    const seen = new Set<string>();
    for (const entity of [...(appData.tasks ?? []), ...(appData.projects ?? [])]) {
        if (entity.deletedAt) continue;
        for (const attachment of entity.attachments ?? []) {
            const cloudKey = sanitizeBlobAttachmentKey(attachment.cloudKey);
            if (!cloudKey || seen.has(cloudKey)) continue;
            seen.add(cloudKey);
            entries.push({ name: cloudKey, kind: 'attachment' });
        }
    }
    return entries;
};

const PROVIDER_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
const DAV_PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

const listTransitionEntries = async (
    listAttachmentKeys: () => Promise<string[]>,
    referencedAttachmentKeys: readonly string[],
): Promise<SyncEncryptionRemoteEntry[]> => [
    ...buildTransitionEntries(null),
    ...Array.from(new Set([...await listAttachmentKeys(), ...referencedAttachmentKeys]))
        .sort()
        .map((name) => ({ name, kind: 'attachment' as const })),
];

const createAuthorizedDropboxFencePort = (
    authorized: <T>(operation: (token: string) => Promise<T>) => Promise<T>,
): SyncRemoteMutationFencePort => {
    const portFor = (token: string) => createDropboxSyncRemoteMutationFencePort(token);
    const conflictClassifier = portFor('');
    return {
        read: () => authorized((token) => portFor(token).read()),
        write: (bytes, expectedVersion) => authorized((token) =>
            portFor(token).write(bytes, expectedVersion)),
        remove: (expectedVersion) => authorized((token) => portFor(token).remove(expectedVersion)),
        isConflict: conflictClassifier.isConflict,
    };
};

/** The state store members the service reads and writes. */
export type SyncEncryptionServiceStatePort = Pick<
    SyncEncryptionStateStore,
    | 'loadSyncEncryptionLocalState'
    | 'reloadSyncEncryptionLocalStateForRecovery'
    | 'flushSyncEncryptionLocalState'
    | 'syncEncryptionLocalState'
    | 'syncEncryptionKeyCache'
    | 'getSyncEncryptionMaterial'
    | 'getSyncEncryptionStatus'
    | 'logSyncEncryptionEvent'
>;

export type SyncEncryptionWebDavConfig = {
    url: string;
    username?: string;
    password?: string;
    allowInsecureHttp?: boolean;
};

/** File Sync's folder, held by the host's folder lock. */
export type SyncEncryptionFileSyncPort<Lease> = {
    /** Takes the same folder lock an ordinary sync takes. */
    acquireLease(syncPath: string): Promise<Lease>;
    /** Opens the folder's artifacts as a transition remote, or `null` when the folder cannot
     *  be opened. Runs while the lease is held, after the host has recovered any attachment
     *  publication this device left unfinished. */
    openRemotePort(syncPath: string): Promise<SyncEncryptionRemotePort | null>;
    revalidateLease(lease: Lease): Promise<void>;
    releaseLease(lease: Lease): Promise<void>;
    /** True for the release error that means the lock file was replaced under us. */
    isLeaseIdentityLostError(error: unknown): boolean;
};

export type SyncEncryptionServiceDeps<Lease> = {
    /** Host WebDAV transport cap; omitted for RN and other backends. */
    maxEncryptedArtifactBytes?: number;
    storage: Pick<SyncKeyValueStoragePort, 'getItem' | 'removeItem'>;
    state: SyncEncryptionServiceStatePort;
    crypto: SyncCryptoPrimitives;
    /** The default fetcher for provider inventory requests. */
    fetch: typeof fetch;
    parseWebdavXml: WebdavXmlParser;
    loadWebDavConfig(): Promise<SyncEncryptionWebDavConfig | null>;
    webDavRequestOptions(allowInsecureHttp?: boolean): WebDavOptions;
    getDropboxClientId(): Promise<string>;
    /** Runs `operation` with a valid access token, refreshing once on an unauthorized error. */
    runDropboxAuthorized<T>(clientId: string, operation: (accessToken: string) => Promise<T>): Promise<T>;
    /** Absent on a host without File Sync; the backend then reports unsupported. */
    fileSync?: SyncEncryptionFileSyncPort<Lease>;
};

/** What a location holds: no ciphertext, only ciphertext, or both (an encryption change cut off there). */
export type SyncLocationCiphertext = 'plaintext' | 'encrypted' | 'mixed';

type BackendTarget<Lease> =
    | { kind: 'remote'; port: SyncEncryptionRemotePort; fileSyncLease?: Lease }
    | { kind: 'local-only' }
    | { kind: 'unsupported' };

export const createSyncEncryptionService = <Lease>(deps: SyncEncryptionServiceDeps<Lease>) => {
    if (deps.maxEncryptedArtifactBytes !== undefined
        && (!Number.isSafeInteger(deps.maxEncryptedArtifactBytes) || deps.maxEncryptedArtifactBytes <= 0)) {
        throw new RangeError('maxEncryptedArtifactBytes must be a positive safe integer');
    }
    const { storage, state, crypto } = deps;

    // -----------------------------------------------------------------------
    // Transition diagnostics (#1056 diagnostics trail)
    // -----------------------------------------------------------------------

    const logTransition = (input: Parameters<typeof buildSyncEncryptionTransitionExtra>[0]): void => {
        state.logSyncEncryptionEvent(
            SYNC_ENCRYPTION_LOG_EVENTS.transition,
            buildSyncEncryptionTransitionExtra(input),
            // Transitions rewrite every artifact at the sync location. Their outcome must be in
            // the shareable log whether or not Debug logging happened to be on at the time.
            { level: input.outcome && input.outcome !== 'ok' ? 'warn' : 'info', force: true },
        );
    };

    /**
     * Start/end lines around one transition, plus a per-phase progress line when a phase
     * completes. Deliberately NOT one line per artifact: a folder with hundreds of attachments
     * would push the rest of the cycle out of the rotated log for no extra diagnosis.
     */
    const withTransitionDiagnostics = async <T>(
        kind: SyncEncryptionTransitionLogKind,
        options: SyncEncryptionTransitionOptions | undefined,
        run: (onProgress: SyncEncryptionProgressCallback | undefined) => Promise<T>,
        outcomeOf: (value: T) => SyncEncryptionTransitionOutcome = () => 'ok',
    ): Promise<T> => {
        const backend = (await storage.getItem(SYNC_BACKEND_KEY).catch(() => null))?.trim() || 'off';
        logTransition({ kind, backend, phase: 'start' });
        const callerProgress = options?.onProgress;
        // Core reports BEFORE it increments its counter, so `completed` never reaches `total`
        // inside the callback. A phase is finished when the NEXT phase reports (its `completed`
        // is exactly what the finished phase got through) or when the run returns.
        let last: SyncEncryptionTransitionProgress | undefined;
        const logPhase = (phase: string, planned: number, done: number) => {
            logTransition({ kind, backend, phase: 'artifact', artifact: phase, planned, done });
        };
        const onProgress: SyncEncryptionProgressCallback | undefined = (progress) => {
            if (last && last.phase !== progress.phase) {
                logPhase(last.phase, progress.total, progress.completed);
            }
            last = progress;
            callerProgress?.(progress);
        };
        try {
            const value = await run(onProgress);
            if (last) logPhase(last.phase, last.total, last.total);
            logTransition({ kind, backend, phase: 'end', outcome: outcomeOf(value) });
            return value;
        } catch (error) {
            logTransition({
                kind,
                backend,
                phase: 'end',
                outcome: transitionOutcomeForError(error),
                errorName: error instanceof Error ? error.name : 'unknown',
                errorMessage: error instanceof Error ? error.message : String(error ?? ''),
            });
            throw error;
        }
    };

    const parseWebdavAttachmentKeys = (xml: string, collectionUrl: string): string[] =>
        parseWebdavAttachmentInventory(xml, collectionUrl, deps.parseWebdavXml);

    const listWebdavAttachmentKeys = async (
        baseUrl: string,
        options: WebDavOptions,
    ): Promise<string[]> => {
        const collectionUrl = `${baseUrl.replace(/\/+$/, '')}/attachments/`;
        const headers: Record<string, string> = {
            ...(options.headers ?? {}),
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '1',
        };
        if (options.username && typeof options.password === 'string') {
            headers.Authorization = `Basic ${bytesToBase64(new TextEncoder().encode(`${options.username}:${options.password}`))}`;
        }
        const fetcher = options.fetcher ?? deps.fetch;
        // `null` = the collection itself answered 404.
        const propfind = (): Promise<string[] | null> => fetchWithTimeoutAndConsume(
            collectionUrl,
            { method: 'PROPFIND', headers, body: DAV_PROPFIND_BODY, signal: options.signal },
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            fetcher,
            'WebDAV attachment inventory timed out',
            async (response, signal) => {
                if (response.status === 404) return null;
                if (!response.ok) {
                    throw new Error(`WebDAV attachment inventory PROPFIND failed (${response.status})`);
                }
                const xml = await readResponseText(response, PROVIDER_INVENTORY_MAX_BYTES, signal);
                return parseWebdavAttachmentKeys(xml, collectionUrl);
            },
        );
        const keys = await propfind();
        if (keys) return keys;
        // A sync root that never held an attachment has no `attachments/` collection yet (#1250).
        // A bare 404 is not proof of an empty inventory, so create the collection and list it
        // again: only the server's own listing of it counts, and a second 404 still fails closed.
        await webdavMakeDirectory(collectionUrl, { ...options, fetcher });
        const created = await propfind();
        if (!created) throw new Error('WebDAV attachment inventory PROPFIND failed (404)');
        return created;
    };

    const listDropboxAttachmentKeys = async (
        accessToken: string,
        fetcher: typeof fetch = deps.fetch,
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

    const decodeInventoryDocument = async (
        bytes: Uint8Array | null,
        key: Uint8Array | null,
        recoveryPassphrase?: string,
    ): Promise<AppData | null> => {
        if (!bytes) return null;
        const inspected = inspectSyncArtifact(bytes);
        if (inspected.kind === 'unsupported') {
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
                crypto,
            );
            candidates.push(recovered.key);
        }
        for (const candidate of candidates) {
            try {
                const plain = await decryptRemoteArtifactOrThrow(bytes, candidate, crypto);
                return JSON.parse(new TextDecoder().decode(plain)) as AppData;
            } catch (error) {
                if (!(error instanceof SyncEncryptionTerminalError)) throw error;
            }
        }
        return null;
    };

    /** Reads every managed document once, derives the attachment worklist from those exact
     * bytes, and returns the document generations alongside the entries. Core reuses this
     * snapshot for CAS instead of opening a list-to-preflight race with a second document read. */
    const captureTransitionInventory = async (
        read: (name: string) => Promise<SyncEncryptionRemoteRead>,
        listAttachmentKeys: () => Promise<string[]>,
        recoveryPassphrase?: string,
    ): Promise<SyncEncryptionRemoteInventory & { referencedAttachmentKeys: string[] }> => {
        const documentEntries = buildTransitionEntries(null);
        const snapshot = new Map<string, SyncEncryptionRemoteRead>();
        for (const entry of documentEntries) snapshot.set(entry.name, await read(entry.name));
        const listedAttachmentKeys = await listAttachmentKeys();
        const key = (await state.getSyncEncryptionMaterial())?.key ?? null;
        const referencedAttachmentKeys = new Set<string>();
        for (const name of [`${SYNC_FILE_NAME}.enc`, SYNC_FILE_NAME, `${SYNC_FILE_NAME}.enc.bak`, BACKUP_FILE_NAME]) {
            const data = await decodeInventoryDocument(snapshot.get(name)?.bytes ?? null, key, recoveryPassphrase);
            for (const entry of buildTransitionEntries(data)) {
                if (entry.kind === 'attachment') referencedAttachmentKeys.add(entry.name);
            }
        }
        const referenced = Array.from(referencedAttachmentKeys).sort();
        const attachmentKeys = new Set([...listedAttachmentKeys, ...referenced]);
        for (const name of attachmentKeys) snapshot.set(name, await read(name));
        return {
            entries: [
                ...documentEntries,
                ...Array.from(attachmentKeys).sort().map((name) => ({ name, kind: 'attachment' as const })),
            ],
            snapshot,
            referencedAttachmentKeys: referenced,
        };
    };

    const runWithRemoteMutationFence = async <T>(
        remote: SyncEncryptionRemotePort,
        operation: (
            guardedRemote: SyncEncryptionRemotePort,
            guardedKeyCache: SyncEncryptionKeyCachePort,
            guardedLocalState: SyncEncryptionLocalStatePort,
        ) => Promise<T>,
        assertLocalFileFenceHeld?: () => Promise<void>,
        releaseLocalFileFence?: () => Promise<void>,
    ): Promise<T> => {
        const syncEncryptionKeyCache = state.syncEncryptionKeyCache;
        const syncEncryptionLocalState = state.syncEncryptionLocalState;
        const flushSyncEncryptionLocalState = () => state.flushSyncEncryptionLocalState();
        const acquire = (remote as TransitionRemotePort).acquireRemoteMutationFence;
        if (!acquire) {
            if (!assertLocalFileFenceHeld) {
                const result = await operation(remote, syncEncryptionKeyCache, syncEncryptionLocalState);
                await flushSyncEncryptionLocalState();
                return result;
            }
            const previousState = syncEncryptionLocalState.read();
            const previousKey = await syncEncryptionKeyCache.getKey();
            let localMaterialTouched = false;
            let stateBeforeFinalCommit = previousState;
            const assertHeld = () => assertLocalFileFenceHeld();
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
                    await assertHeld();
                    await remote.write(name, bytes, expectedVersion);
                },
                remove: async (name, expectedVersion) => {
                    await assertHeld();
                    await remote.remove(name, expectedVersion);
                },
            };
            const guardedKeyCache: SyncEncryptionKeyCachePort = {
                getKey: () => syncEncryptionKeyCache.getKey(),
                setKey: async (key) => {
                    await assertHeld();
                    localMaterialTouched = true;
                    await syncEncryptionKeyCache.setKey(key);
                },
                clearKey: async () => {
                    await assertHeld();
                    localMaterialTouched = true;
                    await syncEncryptionKeyCache.clearKey();
                },
            };
            const guardedLocalState: SyncEncryptionLocalStatePort = {
                read: () => syncEncryptionLocalState.read(),
                write: async (nextState) => {
                    await assertHeld();
                    localMaterialTouched = true;
                    if (nextState?.incompleteTransition) {
                        stateBeforeFinalCommit = nextState;
                    } else {
                        stateBeforeFinalCommit = syncEncryptionLocalState.read();
                    }
                    await syncEncryptionLocalState.write(nextState);
                },
            };
            try {
                const result = await operation(guardedRemote, guardedKeyCache, guardedLocalState);
                await assertHeld();
                await flushSyncEncryptionLocalState();
                await assertHeld();
                // Native release performs the final lock-path identity validation before
                // dropping the stable authority. Keep it inside the material transaction:
                // a legacy peer that replaces `.mindwtr.lock` in the last await gap must
                // restore the recovery journal/key instead of leaving enabled state behind.
                await releaseLocalFileFence?.();
                return result;
            } catch (primaryError) {
                if (!localMaterialTouched) throw primaryError;
                try {
                    // The retained stable authority remains held even when the compatibility
                    // lock path was replaced. Restore the durable journal/state before the
                    // independent SecureStore domain, then surface the lock loss.
                    await syncEncryptionLocalState.write(stateBeforeFinalCommit);
                    await flushSyncEncryptionLocalState();
                    if (previousKey) await syncEncryptionKeyCache.setKey(previousKey);
                    else await syncEncryptionKeyCache.clearKey();
                } catch (rollbackError) {
                    const failure = new Error('Failed to roll back sync encryption material after File Sync lock loss');
                    (failure as Error & { cause?: unknown; rollbackError?: unknown }).cause = primaryError;
                    (failure as Error & { rollbackError?: unknown }).rollbackError = rollbackError;
                    throw failure;
                }
                throw primaryError;
            }
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
        const previousState = syncEncryptionLocalState.read();
        const previousKey = await syncEncryptionKeyCache.getKey();
        let localMaterialTouched = false;
        let finalStateWriteAttempted = false;
        let stateBeforeFinalCommit = previousState;
        let attemptedFinalState: SyncEncryptionLocalState | null = previousState;
        let attemptedFinalKey = previousKey;
        const keysEqual = (left: Uint8Array | null, right: Uint8Array | null): boolean => {
            if (!left || !right) return left === right;
            if (left.length !== right.length) return false;
            return left.every((value, index) => value === right[index]);
        };
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
            const incompleteTransition = stateBeforeFinalCommit?.incompleteTransition;
            if (!incompleteTransition) return nextState;
            return nextState
                ? { ...nextState, incompleteTransition }
                : { state: 'off', incompleteTransition };
        };
        const restoreDurableStateAndMatchingKey = async (): Promise<void> => {
            try {
                // State/journal is the durable recovery authority. Persist it before changing
                // SecureStore so a crash between the two writes always leaves a retry marker.
                await writeLocalStateDurably(stateBeforeFinalCommit);
                await restoreKey(previousKey);
                return;
            } catch (initialRollbackError) {
                // A failed queued write may have reverted only the optimistic cache. Re-read both
                // persistence domains before retrying the complete state-then-key compensation.
                // A transient recovery read must not strand the already-known journal: the
                // authoritative pre-commit state and key are still safe to write in order.
                let recoveryReadError: unknown = null;
                try {
                    await state.reloadSyncEncryptionLocalStateForRecovery();
                    await syncEncryptionKeyCache.getKey();
                } catch (error) {
                    recoveryReadError = error;
                }
                try {
                    await writeLocalStateDurably(stateBeforeFinalCommit);
                    await restoreKey(previousKey);
                    return;
                } catch (retryRollbackError) {
                    await state.reloadSyncEncryptionLocalStateForRecovery();
                    const durableKey = await syncEncryptionKeyCache.getKey();

                    // If one persistence domain did commit, leave a state/key pair that describes
                    // the key which actually survived. The incomplete journal remains present so
                    // restart cannot mistake this reconciliation for a completed transition.
                    if (keysEqual(durableKey, previousKey)) {
                        await writeLocalStateDurably(stateBeforeFinalCommit);
                        return;
                    } else if (finalStateWriteAttempted && keysEqual(durableKey, attemptedFinalKey)) {
                        await writeLocalStateDurably(stateWithRetryJournal(attemptedFinalState));
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
            getKey: () => syncEncryptionKeyCache.getKey(),
            setKey: async (key) => {
                await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
                localMaterialTouched = true;
                await syncEncryptionKeyCache.setKey(key);
                attemptedFinalKey = key;
            },
            clearKey: async () => {
                await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
                localMaterialTouched = true;
                await syncEncryptionKeyCache.clearKey();
                attemptedFinalKey = null;
            },
        };
        const guardedLocalState: SyncEncryptionLocalStatePort = {
            read: () => syncEncryptionLocalState.read(),
            write: async (nextState) => {
                if (nextState?.incompleteTransition) {
                    await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
                } else {
                    stateBeforeFinalCommit = syncEncryptionLocalState.read();
                    attemptedFinalState = nextState;
                    finalStateWriteAttempted = true;
                    await renewHeld();
                }
                await syncEncryptionLocalState.write(nextState);
            },
        };

        let result: T;
        try {
            result = await operation(guardedRemote, guardedKeyCache, guardedLocalState);
            await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            await flushSyncEncryptionLocalState();
            await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
        } catch (primaryError) {
            let failureToThrow = primaryError;
            if (isSyncRemoteMutationFenceError(primaryError) && (localMaterialTouched || finalStateWriteAttempted)) {
                try {
                    if (finalStateWriteAttempted) {
                        await restoreDurableStateAndMatchingKey();
                    } else {
                        await restoreKey(previousKey);
                    }
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

    const createWebdavRemotePort = async (appData: AppData | null, override?: SyncEncryptionWebDavConfig): Promise<TransitionRemotePort> => {
        void appData;
        const config = override ?? await deps.loadWebDavConfig();
        if (!config?.url) throw new Error('WebDAV is not configured');
        const baseSyncUrl = getBaseSyncUrl(config.url);
        const requestOptions = {
            ...deps.webDavRequestOptions(config.allowInsecureHttp),
            username: config.username,
            password: config.password,
        };
        // Documents sit at the sync root; attachment entry names are already the `cloudKey`
        // (`attachments/<id><ext>`), which is root-relative too.
        const urlFor = (name: string): string => `${baseSyncUrl}/${assertManagedRemoteArtifactName(name)}`;
        const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
            webdavGetFileVersioned(urlFor(name), requestOptions);
        // The first bytes only (a ranged GET); a server that ignores the range sends the whole file, read whole within the
        // download limit.
        const readHead = async (name: string): Promise<Uint8Array | null> => {
            const head = await webdavGetFileVersioned(urlFor(name), {
                ...requestOptions, headers: { Range: 'bytes=0-63' }, maxBytes: 1024 * 1024, treatOversizeAsAbsent: true,
            });
            if (head.bytes) return head.bytes;
            return (await read(name)).bytes;
        };
        const listAttachmentKeys = () => listWebdavAttachmentKeys(baseSyncUrl, requestOptions);
        let referencedAttachmentKeys: string[] = [];
        return {
            maxEncryptedArtifactBytes: deps.maxEncryptedArtifactBytes,
            acquireRemoteMutationFence: async () => {
                // The fence is a versioned write like every transition write: a server without strong ETags is refused
                // here, before the fence file is written (it could never be read back or removed there).
                try {
                    await assertWebdavStrongEtagSupport(urlFor(SYNC_FILE_NAME), requestOptions);
                } catch (error) {
                    if (error instanceof SyncEncryptionRemoteVersionUnavailableError) throw new SyncEncryptionBackendIncompatibleError(error);
                    throw error;
                }
                return acquireSyncRemoteMutationFence(
                    createWebdavSyncRemoteMutationFencePort(urlFor(SYNC_FILE_NAME), requestOptions),
                    TRANSITION_FENCE_OPTIONS,
                );
            },
            list: () => listTransitionEntries(listAttachmentKeys, referencedAttachmentKeys),
            captureInventory: async (recoveryPassphrase) => {
                const inventory = await captureTransitionInventory(read, listAttachmentKeys, recoveryPassphrase);
                referencedAttachmentKeys = inventory.referencedAttachmentKeys;
                return inventory;
            },
            read,
            readHead,
            write: async (name, bytes, expectedVersion) => {
                await webdavPutFileVersioned(
                    urlFor(name), bytes, 'application/octet-stream', expectedVersion, requestOptions,
                );
            },
            remove: async (name, expectedVersion) => {
                await webdavDeleteFileVersioned(urlFor(name), expectedVersion, requestOptions);
            },
        };
    };

    const createDropboxRemotePort = async (appData: AppData | null): Promise<TransitionRemotePort> => {
        void appData;
        const clientId = await deps.getDropboxClientId();
        if (!clientId) throw new Error('Dropbox is not configured');
        const authorized = <T,>(operation: (accessToken: string) => Promise<T>): Promise<T> =>
            deps.runDropboxAuthorized(clientId, operation);
        const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
            authorized((token) => downloadDropboxFileVersioned(token, `/${assertManagedRemoteArtifactName(name)}`));
        const listAttachmentKeys = () => authorized((token) => listDropboxAttachmentKeys(token));
        let referencedAttachmentKeys: string[] = [];
        return {
            acquireRemoteMutationFence: () => acquireSyncRemoteMutationFence(
                createAuthorizedDropboxFencePort(authorized),
                TRANSITION_FENCE_OPTIONS,
            ),
            list: () => listTransitionEntries(listAttachmentKeys, referencedAttachmentKeys),
            captureInventory: async (recoveryPassphrase) => {
                const inventory = await captureTransitionInventory(read, listAttachmentKeys, recoveryPassphrase);
                referencedAttachmentKeys = inventory.referencedAttachmentKeys;
                return inventory;
            },
            read,
            write: async (name, bytes, expectedVersion) => {
                await authorized((token) => uploadDropboxFileVersioned(
                    token, `/${assertManagedRemoteArtifactName(name)}`, bytes, expectedVersion,
                ));
            },
            remove: async (name, expectedVersion) => {
                await authorized((token) => deleteDropboxFileVersioned(
                    token, `/${assertManagedRemoteArtifactName(name)}`, expectedVersion,
                ));
            },
        };
    };

    /**
     * Whether the location holds ciphertext beside plaintext: 'mixed' when an encryption change was cut off there. Not
     * serialized and takes no fence, so a cycle may ask it (WebDAV and Dropbox; File Sync takes the folder's lock, which a
     * running cycle already holds). `sample` (the default) reads the first and the last attachment in name order: a
     * transition seals or opens attachments one at a time in that order, so one it cut off leaves the first sealed and the
     * last not (enable) or the other way round (disable). `full` reads every artifact.
     */
    const probeSyncLocationCiphertext = async (
        options: { full?: boolean; webdav?: SyncEncryptionWebDavConfig } = {},
    ): Promise<SyncLocationCiphertext> => {
        const target = options.webdav ? { kind: 'remote' as const, port: await createWebdavRemotePort(null, options.webdav) }
            : await resolveTransitionTarget(null);
        if (target.kind !== 'remote') return 'plaintext';
        return runWithFileTransitionLease(target, async (port) => {
            const entries = await port.list();
            const attachments = entries.filter((entry) => entry.kind === 'attachment').map((entry) => entry.name).sort();
            let encrypted = false;
            let plaintext = false;
            const note = (bytes: Uint8Array | null) => {
                if (!bytes) return;
                if (inspectSyncArtifact(bytes).kind === 'plaintext') plaintext = true;
                else encrypted = true;
            };
            if (options.full) {
                for (const entry of entries) if (entry.kind === 'document') note((await port.read(entry.name)).bytes);
            }
            const picked = options.full ? attachments : Array.from(new Set([attachments[0], attachments[attachments.length - 1]]))
                .filter((name): name is string => Boolean(name));
            for (const name of picked) note(port.readHead ? await port.readHead(name) : (await port.read(name)).bytes);
            // A sample reads attachments only; the cycle asking already read the document as plaintext.
            if (!options.full) return encrypted ? 'mixed' : 'plaintext';
            return encrypted && plaintext ? 'mixed' : encrypted ? 'encrypted' : 'plaintext';
        });
    };

    const resolveTransitionTarget = async (appData: AppData | null): Promise<BackendTarget<Lease>> => {
        const backend = (await storage.getItem(SYNC_BACKEND_KEY))?.trim();
        // No durable backend yet (a typed-but-unproven config persists nothing until its
        // activation probe passes). Enable/disable stay available as local-only key
        // management so the passphrase can be set BEFORE the first sync uploads a byte
        // (#1001); anything that must read remote artifacts rejects instead.
        if (!backend || backend === 'off') return { kind: 'local-only' };
        if (backend === 'file') {
            const fileSync = deps.fileSync;
            if (!fileSync) return { kind: 'unsupported' };
            const syncPath = await storage.getItem(SYNC_PATH_KEY);
            if (!syncPath) throw new Error('No sync folder configured');
            // Acquire before the port opens the directory and snapshots artifact
            // generations. A transition must not authenticate or preflight bytes
            // captured before it owned the same folder lock as ordinary sync.
            const fileSyncLease = await fileSync.acquireLease(syncPath);
            try {
                const port = await fileSync.openRemotePort(syncPath);
                if (!port) throw new Error('Unable to open the sync folder');
                return { kind: 'remote', port, fileSyncLease };
            } catch (error) {
                await fileSync.releaseLease(fileSyncLease);
                throw error;
            }
        }
        if (backend === 'webdav') {
            return { kind: 'remote', port: await createWebdavRemotePort(appData) };
        }
        if (backend === 'cloud') {
            const provider = ((await storage.getItem(CLOUD_PROVIDER_KEY)) || '').trim();
            if (provider === DROPBOX_PROVIDER) {
                return { kind: 'remote', port: await createDropboxRemotePort(appData) };
            }
        }
        return { kind: 'unsupported' };
    };

    const requireTransitionTarget = async (
        appData: AppData | null,
    ): Promise<Extract<BackendTarget<Lease>, { kind: 'remote' }>> => {
        const target = await resolveTransitionTarget(appData);
        if (target.kind === 'local-only') {
            throw new Error('SYNC_ENCRYPTION_BACKEND_REQUIRED');
        }
        if (target.kind !== 'remote') {
            throw new Error('Sync encryption is only available for File Sync, WebDAV and Dropbox.');
        }
        return target;
    };

    const runWithFileTransitionLease = async <T>(
        target: Extract<BackendTarget<Lease>, { kind: 'remote' }>,
        operation: (
            port: SyncEncryptionRemotePort,
            releaseFence?: () => Promise<void>,
        ) => Promise<T>,
    ): Promise<T> => {
        const fileSync = deps.fileSync;
        if (!target.fileSyncLease || !fileSync) return operation(target.port);
        const fileSyncLease = target.fileSyncLease;
        let leaseSettled = false;
        let releaseCleanupError: unknown;
        const releaseFence = async (): Promise<void> => {
            if (leaseSettled) throw new SyncFileLockUnavailableError();
            // The native module consumes the token before validating and closing, so
            // an error still means this lease cannot be released a second time.
            leaseSettled = true;
            try {
                await fileSync.releaseLease(fileSyncLease);
            } catch (error) {
                if (fileSync.isLeaseIdentityLostError(error)) throw error;
                releaseCleanupError = error;
            }
        };
        let result: T;
        try {
            result = await operation(target.port, releaseFence);
        } catch (primaryError) {
            if (!leaseSettled) {
                try {
                    await releaseFence();
                } catch (cleanupError) {
                    if (primaryError instanceof Error) {
                        (primaryError as Error & { cleanupError?: unknown }).cleanupError = cleanupError;
                    }
                }
            }
            if (releaseCleanupError && primaryError instanceof Error) {
                (primaryError as Error & { cleanupError?: unknown }).cleanupError = releaseCleanupError;
            }
            throw primaryError;
        }
        if (leaseSettled) {
            if (releaseCleanupError) {
                throw new SyncEncryptionCleanupDeferredError(result, releaseCleanupError, 0, 'file-lock');
            }
            return result;
        }
        try {
            await releaseFence();
        } catch (cleanupError) {
            throw new SyncEncryptionCleanupDeferredError(result, cleanupError, 0, 'file-lock');
        }
        if (releaseCleanupError) {
            throw new SyncEncryptionCleanupDeferredError(result, releaseCleanupError, 0, 'file-lock');
        }
        return result;
    };

    const revalidateFenceFor = (
        target: Extract<BackendTarget<Lease>, { kind: 'remote' }>,
    ): (() => Promise<void>) | undefined => {
        const fileSync = deps.fileSync;
        const lease = target.fileSyncLease;
        return lease && fileSync ? () => fileSync.revalidateLease(lease) : undefined;
    };

    const runProvidePassphraseOverRemote = async (
        passphrase: string,
        port: SyncEncryptionRemotePort,
        assertLocalFileFenceHeld?: () => Promise<void>,
        releaseLocalFileFence?: () => Promise<void>,
    ): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'> => {
        return runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
            runProvideSyncEncryptionPassphraseOverRemote(
                passphrase,
                SYNC_FILE_NAME,
                guardedRemote,
                keyCache,
                localState,
                crypto,
            ), assertLocalFileFenceHeld, releaseLocalFileFence);
    };

    // Every mutating transition below runs through the SAME serialized queue a sync cycle's
    // `MobileSyncRun.run()` uses. That queue is a strict FIFO chain
    // (`createSerializedAsyncQueue` — the next entry's callback does not start until the
    // previous one's promise, awaits included, has fully settled), so a transition and a sync
    // cycle can never interleave: whichever one is enqueued first runs to completion —
    // including its write — before the other starts. This is what closes the race a
    // mid-transition `getSyncEncryptionMaterial()` read could otherwise hit (a cycle that
    // resolved `material = null` moments before encryption was enabled, then writing a
    // plaintext `data.json` after the transition finished): that cycle either finishes
    // (plaintext write included) entirely before the transition begins, or is queued behind
    // it and re-resolves `material` fresh, after enable, once it actually starts. Mutual
    // exclusion at the primitive that already guards every other complete-document
    // read/replace is the correct fix for a "must never interleave" hazard — strictly
    // stronger than detecting the interleaving after the fact.

    const enableSyncEncryption = async (
        passphrase: string,
        options: SyncEncryptionTransitionOptions = {},
    ): Promise<void> => runSerializedSyncDocumentOperation(async () => {
        await state.loadSyncEncryptionLocalState();
        const target = await resolveTransitionTarget(options.appData ?? null);
        if (target.kind === 'local-only') {
            await withTransitionDiagnostics('enable-local-only', options, async () => {
                await runEnableSyncEncryptionLocalOnly(
                    passphrase,
                    state.syncEncryptionKeyCache,
                    state.syncEncryptionLocalState,
                    crypto,
                );
                await state.flushSyncEncryptionLocalState();
            });
            return;
        }
        if (target.kind !== 'remote') {
            throw new Error('Sync encryption is only available for File Sync, WebDAV and Dropbox.');
        }
        await withTransitionDiagnostics('enable', options, (onProgress) =>
            runWithFileTransitionLease(target, (port, releaseFence) =>
                runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
                    runEnableSyncEncryptionOverRemote(
                        passphrase,
                        guardedRemote,
                        keyCache,
                        localState,
                        onProgress,
                        crypto,
                    ), revalidateFenceFor(target), releaseFence)));
    });

    const disableSyncEncryption = async (
        options: SyncEncryptionTransitionOptions = {},
    ): Promise<void> => runSerializedSyncDocumentOperation(async () => {
        await state.loadSyncEncryptionLocalState();
        const target = await resolveTransitionTarget(options.appData ?? null);
        if (target.kind === 'local-only') {
            await withTransitionDiagnostics('disable-local-only', options, async () => {
                await runDisableSyncEncryptionLocalOnly(state.syncEncryptionKeyCache, state.syncEncryptionLocalState);
                await state.flushSyncEncryptionLocalState();
            });
            return;
        }
        if (target.kind !== 'remote') {
            throw new Error('Sync encryption is only available for File Sync, WebDAV and Dropbox.');
        }
        await withTransitionDiagnostics('disable', options, (onProgress) =>
            runWithFileTransitionLease(target, (port, releaseFence) =>
                runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
                    runDisableSyncEncryptionOverRemote(
                        guardedRemote,
                        keyCache,
                        localState,
                        onProgress,
                        crypto,
                    ), revalidateFenceFor(target), releaseFence)));
    });

    const changeSyncEncryptionPassphrase = async (
        current: string,
        next: string,
        options: SyncEncryptionTransitionOptions = {},
    ): Promise<void> => runSerializedSyncDocumentOperation(async () => {
        await state.loadSyncEncryptionLocalState();
        const target = await requireTransitionTarget(options.appData ?? null);
        await withTransitionDiagnostics('change-passphrase', options, (onProgress) =>
            runWithFileTransitionLease(target, (port, releaseFence) =>
                runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
                    runChangeSyncEncryptionPassphraseOverRemote(
                        current,
                        next,
                        guardedRemote,
                        keyCache,
                        localState,
                        onProgress,
                        crypto,
                    ), revalidateFenceFor(target), releaseFence)));
    });

    /** `'no-encrypted-remote'` (#1138): this location holds nothing encrypted, so the no-key
     *  state it was carrying described somewhere else (or a folder since emptied). Core clears
     *  the state back to off; the card tells the user encryption is now off here. */
    const provideSyncEncryptionPassphrase = async (
        passphrase: string,
    ): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'> => runSerializedSyncDocumentOperation(async () => {
        await state.loadSyncEncryptionLocalState();
        const target = await requireTransitionTarget(null);
        return withTransitionDiagnostics(
            'unlock',
            undefined,
            () => runWithFileTransitionLease(target, (port, releaseFence) => runProvidePassphraseOverRemote(
                passphrase,
                port,
                revalidateFenceFor(target),
                releaseFence,
            )),
            (result) => (result === 'ok' ? 'ok' : result),
        );
    });

    return {
        getSyncEncryptionStatus: (): Promise<SyncEncryptionStatus> => state.getSyncEncryptionStatus(),
        /** True while no durable sync backend exists — enable/disable then run local-only. */
        isSyncEncryptionBackendPending: async (): Promise<boolean> => {
            const backend = (await storage.getItem(SYNC_BACKEND_KEY))?.trim();
            return !backend || backend === 'off';
        },
        enableSyncEncryption,
        disableSyncEncryption,
        changeSyncEncryptionPassphrase,
        provideSyncEncryptionPassphrase,
        /** "Not now". Re-affirms the persisted no-key state; automatic and background sync stay
         *  off for this backend until a passphrase actually validates. */
        declineSyncEncryptionPassphrase: async (): Promise<void> => {
            await state.loadSyncEncryptionLocalState();
            reaffirmRemoteEncryptionNoKey(state.syncEncryptionLocalState);
            await state.flushSyncEncryptionLocalState();
        },
        /** "Abandon setup" (sync-encryption.ts runAbandonSyncEncryptionTransition): on the sync queue, local only. */
        abandonSyncEncryptionTransition: (): Promise<SyncEncryptionTransitionKind | null> => runSerializedSyncDocumentOperation(async () => {
            await state.loadSyncEncryptionLocalState();
            const abandoned = await runAbandonSyncEncryptionTransition(
                state.syncEncryptionKeyCache, state.syncEncryptionLocalState, await readSyncLocationScope(storage),
            );
            await state.flushSyncEncryptionLocalState();
            if (abandoned) {
                const backend = (await storage.getItem(SYNC_BACKEND_KEY).catch(() => null))?.trim() || 'off';
                state.logSyncEncryptionEvent(SYNC_ENCRYPTION_LOG_EVENTS.transition, {
                    ...buildSyncEncryptionTransitionExtra({ kind: 'abandon', backend, phase: 'end', outcome: 'ok' }),
                    abandoned,
                    releaseCheck: 'v1.3.4/encryption-abandon-setup',
                }, { level: 'warn', force: true });
            }
            return abandoned;
        }),
        probeSyncLocationCiphertext,
        /**
         * "Check this location again" for a location this device holds as partly encrypted: every artifact, whole
         * (documents) or by its first bytes (attachments). Whole again (all plaintext, or all encrypted) clears the mark and
         * sync resumes (an encrypted location is then found and locked as ever); still mixed keeps it. On the sync queue.
         */
        recheckPartlyEncryptedLocation: (): Promise<SyncLocationCiphertext> => runSerializedSyncDocumentOperation(async () => {
            const current = await state.loadSyncEncryptionLocalState();
            const found = await probeSyncLocationCiphertext({ full: true });
            if (found !== 'mixed' && current?.partlyEncryptedScope) {
                // Old completed cycles cannot establish the newly rechecked encryption posture.
                // Invalidate both durable proofs before admitting the next discovery cycle.
                await storage.removeItem(FAST_SYNC_STATE_KEY);
                await storage.removeItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
                await state.syncEncryptionLocalState.write(null);
                await state.flushSyncEncryptionLocalState();
                try {
                    await state.logSyncEncryptionEvent(SYNC_ENCRYPTION_LOG_EVENTS.transition, {
                        kind: 'recheck', phase: 'end', outcome: 'ok',
                        releaseCheck: 'v1.3.5/encryption-recheck-posture',
                    }, { level: 'info', force: true });
                } catch { /* A diagnostic cannot fail the durable quarantine exit. */ }
            }
            const backend = (await storage.getItem(SYNC_BACKEND_KEY).catch(() => null))?.trim() || 'off';
            state.logSyncEncryptionEvent(SYNC_ENCRYPTION_LOG_EVENTS.transition, {
                ...buildSyncEncryptionTransitionExtra({ kind: 'recheck', backend, phase: 'end', outcome: 'ok' }),
                found,
                releaseCheck: 'v1.3.4/encryption-abandon-setup',
            }, { level: found === 'mixed' ? 'warn' : 'info', force: true });
            return found;
        }),
        __testUtils: {
            buildTransitionEntries,
            captureTransitionInventory,
            listDropboxAttachmentKeys,
            listWebdavAttachmentKeys,
            createDropboxRemotePort,
            createWebdavRemotePort,
            runProvidePassphraseOverRemote,
            runWithRemoteMutationFence,
        },
    };
};

export type SyncEncryptionService = ReturnType<typeof createSyncEncryptionService>;
