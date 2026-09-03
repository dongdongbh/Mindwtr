// The phase-3-facing sync-encryption API for mobile (#1056 phase 2). Every function
// dispatches on the configured backend and then delegates to core's transition
// orchestration (`packages/core/src/sync-encryption.ts`) with a mobile port — the
// ordering, verify-before-delete, and resume semantics all live there, in one place,
// for File Sync, WebDAV and Dropbox alike.
//
// Out of scope by design: CloudKit and self-hosted mindwtr-cloud.

import {
    SYNC_ENCRYPTION_LOG_EVENTS,
    SyncEncryptionRemoteConflictError,
    buildSyncEncryptionTransitionExtra,
    type SyncEncryptionTransitionLogKind,
    type SyncEncryptionTransitionOutcome,
    acquireSyncRemoteMutationFence,
    createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort,
    DEFAULT_TIMEOUT_MS,
    decryptRemoteArtifactOrThrow,
    deriveSyncKeyMaterial,
    fetchWithTimeoutAndConsume,
    getBaseSyncUrl,
    inspectSyncArtifact,
    isSyncRemoteMutationFenceError,
    listDropboxFolderFiles,
    parseWebdavAttachmentInventory,
    readResponseText,
    reaffirmRemoteEncryptionNoKey,
    runChangeSyncEncryptionPassphraseOverRemote,
    runDisableSyncEncryptionLocalOnly,
    runDisableSyncEncryptionOverRemote,
    runEnableSyncEncryptionLocalOnly,
    runEnableSyncEncryptionOverRemote,
    runProvideSyncEncryptionPassphraseOverRemote,
    runSerializedSyncDocumentOperation,
    sanitizeAttachmentCloudKeyForSyncMerge,
    SYNC_FILE_NAME,
    SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS,
    webdavDeleteFileVersioned,
    webdavGetFileVersioned,
    webdavPutFileVersioned,
    SyncCryptoUnsupportedError,
    SyncEncryptionTerminalError,
    SyncFileLockUnavailableError,
    type AppData,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemoteInventory,
    type SyncEncryptionRemotePort,
    type SyncEncryptionRemoteRead,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionProgress,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncRemoteMutationFenceLease,
    type SyncRemoteMutationFencePort,
    SyncRemoteMutationFenceUnavailableError,
    type WebDavOptions,
} from '@mindwtr/core';
import { DOMParser } from '@xmldom/xmldom';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    deleteDropboxFileVersioned,
    downloadDropboxFileVersioned,
    uploadDropboxFileVersioned,
} from './dropbox-sync';
import {
    bytesToBase64,
    getDropboxClientId,
    loadWebDavConfig,
    runDropboxAuthorized,
} from './attachment-sync-utils';
import {
    createFileSyncEncryptionRemotePort,
    resolveFileSyncEncryptionTarget,
} from './storage-file-encryption';
import { recoverFileSyncAttachmentPublications } from './attachment-file-installer';
import {
    acquireMobileFileSyncLease,
    revalidateMobileFileSyncLease,
    releaseMobileFileSyncLease,
    SyncFileLockIdentityLostError,
    type MobileFileSyncLease,
} from './sync-file-lock';
import { getMobileWebDavRequestOptions } from './webdav-request-options';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import {
    flushSyncEncryptionLocalState,
    getSyncEncryptionMaterial,
    getMobileSyncEncryptionStatus,
    logSyncEncryptionEvent,
    syncEncryptionKeyCache,
    syncEncryptionLocalState,
    loadSyncEncryptionLocalState,
    reloadSyncEncryptionLocalStateForRecovery,
} from './sync-encryption-state';
import {
    CLOUD_PROVIDER_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
} from './sync-constants';
import { backgroundSafeFetch } from './background-safe-fetch';

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

// ---------------------------------------------------------------------------
// Transition diagnostics (#1056 diagnostics trail)
// ---------------------------------------------------------------------------

const logTransition = (input: Parameters<typeof buildSyncEncryptionTransitionExtra>[0]): void => {
    logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.transition,
        buildSyncEncryptionTransitionExtra(input),
        // Transitions rewrite every artifact at the sync location. Their outcome must be in
        // the shareable log whether or not Debug logging happened to be on at the time.
        { level: input.outcome && input.outcome !== 'ok' ? 'warn' : 'info', force: true },
    );
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
    const backend = (await AsyncStorage.getItem(SYNC_BACKEND_KEY).catch(() => null))?.trim() || 'off';
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

const parseWebdavAttachmentKeys = (xml: string, collectionUrl: string): string[] =>
  parseWebdavAttachmentInventory(xml, collectionUrl, (source) => {
    const errors: string[] = [];
    const document = new DOMParser({
      errorHandler: (level, message) => errors.push(`${level}: ${String(message)}`),
    }).parseFromString(source, 'application/xml') as unknown as Document;
    return { document, errors };
  });

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
  return fetchWithTimeoutAndConsume(
    collectionUrl,
    { method: 'PROPFIND', headers, body: DAV_PROPFIND_BODY, signal: options.signal },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.fetcher ?? backgroundSafeFetch,
        'WebDAV attachment inventory timed out',
        async (response, signal) => {
          if (!response.ok) {
            throw new Error(`WebDAV attachment inventory PROPFIND failed (${response.status})`);
          }
          const xml = await readResponseText(response, PROVIDER_INVENTORY_MAX_BYTES, signal);
          return parseWebdavAttachmentKeys(xml, collectionUrl);
        },
    );
};

const listDropboxAttachmentKeys = async (
    accessToken: string,
    fetcher: typeof fetch = backgroundSafeFetch,
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
            mobileSyncCryptoPrimitives,
        );
        candidates.push(recovered.key);
    }
    for (const candidate of candidates) {
        try {
            const plain = await decryptRemoteArtifactOrThrow(bytes, candidate, mobileSyncCryptoPrimitives);
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
    const key = (await getSyncEncryptionMaterial())?.key ?? null;
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
      write: async (state) => {
        await assertHeld();
        localMaterialTouched = true;
        if (state?.incompleteTransition) {
          stateBeforeFinalCommit = state;
        } else {
          stateBeforeFinalCommit = syncEncryptionLocalState.read();
        }
        await syncEncryptionLocalState.write(state);
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
  const writeLocalStateDurably = async (state: SyncEncryptionLocalState | null): Promise<void> => {
    await syncEncryptionLocalState.write(state);
    await flushSyncEncryptionLocalState();
  };
  const restoreKey = async (key: Uint8Array | null): Promise<void> => {
    if (key) await syncEncryptionKeyCache.setKey(key);
    else await syncEncryptionKeyCache.clearKey();
  };
  const stateWithRetryJournal = (
    state: SyncEncryptionLocalState | null,
  ): SyncEncryptionLocalState | null => {
    const incompleteTransition = stateBeforeFinalCommit?.incompleteTransition;
    if (!incompleteTransition) return state;
    return state
      ? { ...state, incompleteTransition }
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
        await reloadSyncEncryptionLocalStateForRecovery();
        await syncEncryptionKeyCache.getKey();
      } catch (error) {
        recoveryReadError = error;
      }
      try {
        await writeLocalStateDurably(stateBeforeFinalCommit);
        await restoreKey(previousKey);
        return;
      } catch (retryRollbackError) {
        await reloadSyncEncryptionLocalStateForRecovery();
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
    write: async (state) => {
      if (state?.incompleteTransition) {
        await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
      } else {
        stateBeforeFinalCommit = syncEncryptionLocalState.read();
        attemptedFinalState = state;
        finalStateWriteAttempted = true;
        await renewHeld();
      }
      await syncEncryptionLocalState.write(state);
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

const createWebdavRemotePort = async (appData: AppData | null): Promise<TransitionRemotePort> => {
    void appData;
    const config = await loadWebDavConfig();
    if (!config?.url) throw new Error('WebDAV is not configured');
    const baseSyncUrl = getBaseSyncUrl(config.url);
    const requestOptions = {
        ...getMobileWebDavRequestOptions(config.allowInsecureHttp),
        username: config.username,
        password: config.password,
    };
    // Documents sit at the sync root; attachment entry names are already the `cloudKey`
    // (`attachments/<id><ext>`), which is root-relative too.
    const urlFor = (name: string): string => `${baseSyncUrl}/${assertManagedRemoteArtifactName(name)}`;
    const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
        webdavGetFileVersioned(urlFor(name), requestOptions);
    const listAttachmentKeys = () => listWebdavAttachmentKeys(baseSyncUrl, requestOptions);
    let referencedAttachmentKeys: string[] = [];
    return {
        acquireRemoteMutationFence: () => acquireSyncRemoteMutationFence(
          createWebdavSyncRemoteMutationFencePort(urlFor(SYNC_FILE_NAME), requestOptions),
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
    const clientId = await getDropboxClientId();
    if (!clientId) throw new Error('Dropbox is not configured');
    const authorized = <T,>(operation: (accessToken: string) => Promise<T>): Promise<T> =>
        runDropboxAuthorized(clientId, operation);
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

type BackendTarget =
    | { kind: 'remote'; port: SyncEncryptionRemotePort; fileSyncLease?: MobileFileSyncLease }
    | { kind: 'local-only' }
    | { kind: 'unsupported' };

const resolveTransitionTarget = async (appData: AppData | null): Promise<BackendTarget> => {
    const backend = (await AsyncStorage.getItem(SYNC_BACKEND_KEY))?.trim();
    // No durable backend yet (a typed-but-unproven config persists nothing until its
    // activation probe passes). Enable/disable stay available as local-only key
    // management so the passphrase can be set BEFORE the first sync uploads a byte
    // (#1001); anything that must read remote artifacts rejects instead.
    if (!backend || backend === 'off') return { kind: 'local-only' };
    if (backend === 'file') {
        const syncPath = await AsyncStorage.getItem(SYNC_PATH_KEY);
        if (!syncPath) throw new Error('No sync folder configured');
        // Acquire before the port opens the directory and snapshots artifact
        // generations. A transition must not authenticate or preflight bytes
        // captured before it owned the same folder lock as ordinary sync.
        const fileSyncLease = await acquireMobileFileSyncLease(syncPath);
        try {
            const fileTarget = await resolveFileSyncEncryptionTarget(syncPath);
            if (fileTarget?.attachmentsDirUri?.startsWith('file://')) {
                // Abort before the transition snapshots or mutates any artifact
                // unless every exact scratch reserved by this device is gone.
                await recoverFileSyncAttachmentPublications(fileTarget.attachmentsDirUri);
            }
            const port = await createFileSyncEncryptionRemotePort(syncPath);
            if (!port) throw new Error('Unable to open the sync folder');
            return { kind: 'remote', port, fileSyncLease };
        } catch (error) {
            await releaseMobileFileSyncLease(fileSyncLease);
            throw error;
        }
    }
    if (backend === 'webdav') {
        return { kind: 'remote', port: await createWebdavRemotePort(appData) };
    }
    if (backend === 'cloud') {
        const provider = ((await AsyncStorage.getItem(CLOUD_PROVIDER_KEY)) || '').trim();
        if (provider === DROPBOX_PROVIDER) {
            return { kind: 'remote', port: await createDropboxRemotePort(appData) };
        }
    }
    return { kind: 'unsupported' };
};

const requireTransitionTarget = async (appData: AppData | null): Promise<Extract<BackendTarget, { kind: 'remote' }>> => {
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
    target: Extract<BackendTarget, { kind: 'remote' }>,
    operation: (
      port: SyncEncryptionRemotePort,
      releaseFence?: () => Promise<void>,
    ) => Promise<T>,
): Promise<T> => {
    if (!target.fileSyncLease) return operation(target.port);
    let leaseSettled = false;
    let releaseCleanupError: unknown;
    const releaseFence = async (): Promise<void> => {
      if (leaseSettled) throw new SyncFileLockUnavailableError();
      // The native module consumes the token before validating and closing, so
      // an error still means this lease cannot be released a second time.
      leaseSettled = true;
      try {
        await releaseMobileFileSyncLease(target.fileSyncLease!);
      } catch (error) {
        if (error instanceof SyncFileLockIdentityLostError) throw error;
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

/** Phase-3 API. `appData` is the caller's current local document — it supplies the
 *  attachment worklist. Transitions never write to it; local data is untouched by
 *  design (backward-compat requirement #4). */
export type SyncEncryptionTransitionOptions = {
    appData?: AppData | null;
    onProgress?: SyncEncryptionProgressCallback;
};

export const getSyncEncryptionStatus = async (): Promise<SyncEncryptionStatus> =>
    getMobileSyncEncryptionStatus();

/** True while no durable sync backend exists — enable/disable then run local-only. */
export const isSyncEncryptionBackendPending = async (): Promise<boolean> => {
    const backend = (await AsyncStorage.getItem(SYNC_BACKEND_KEY))?.trim();
    return !backend || backend === 'off';
};

// Every mutating transition below runs through the SAME serialized queue a sync cycle's
// `MobileSyncRun.run()` uses (`apps/mobile/lib/sync-service.ts:1503`). That queue is a
// strict FIFO chain (`createSerializedAsyncQueue` — the next entry's callback does not
// start until the previous one's promise, awaits included, has fully settled), so a
// transition and a sync cycle can never interleave: whichever one is enqueued first runs
// to completion — including its write — before the other starts. This is what closes the
// race a mid-transition `getSyncEncryptionMaterial()` read could otherwise hit (a cycle
// that resolved `material = null` moments before encryption was enabled, then writing a
// plaintext `data.json` after the transition finished): that cycle either finishes
// (plaintext write included) entirely before the transition begins, or is queued behind
// it and re-resolves `material` fresh, after enable, once it actually starts. Mutual
// exclusion at the primitive that already guards every other complete-document
// read/replace is the correct fix for a "must never interleave" hazard — strictly
// stronger than detecting the interleaving after the fact.

export const enableSyncEncryption = async (
    passphrase: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const target = await resolveTransitionTarget(options.appData ?? null);
    if (target.kind === 'local-only') {
        await withTransitionDiagnostics('enable-local-only', options, async () => {
            await runEnableSyncEncryptionLocalOnly(
                passphrase,
                syncEncryptionKeyCache,
                syncEncryptionLocalState,
                mobileSyncCryptoPrimitives,
            );
            await flushSyncEncryptionLocalState();
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
            mobileSyncCryptoPrimitives,
          ), target.fileSyncLease
            ? () => revalidateMobileFileSyncLease(target.fileSyncLease!)
            : undefined, releaseFence)));
});

export const disableSyncEncryption = async (
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const target = await resolveTransitionTarget(options.appData ?? null);
    if (target.kind === 'local-only') {
        await withTransitionDiagnostics('disable-local-only', options, async () => {
            await runDisableSyncEncryptionLocalOnly(syncEncryptionKeyCache, syncEncryptionLocalState);
            await flushSyncEncryptionLocalState();
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
            mobileSyncCryptoPrimitives,
          ), target.fileSyncLease
            ? () => revalidateMobileFileSyncLease(target.fileSyncLease!)
            : undefined, releaseFence)));
});

export const changeSyncEncryptionPassphrase = async (
    current: string,
    next: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
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
            mobileSyncCryptoPrimitives,
          ), target.fileSyncLease
            ? () => revalidateMobileFileSyncLease(target.fileSyncLease!)
            : undefined, releaseFence)));
});

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
        mobileSyncCryptoPrimitives,
    ), assertLocalFileFenceHeld, releaseLocalFileFence);
};

/** `'no-encrypted-remote'` (#1138): this location holds nothing encrypted, so the no-key state
 *  it was carrying described somewhere else (or a folder since emptied). Core clears the state
 *  back to off; the card tells the user encryption is now off here. */
export const provideSyncEncryptionPassphrase = async (
    passphrase: string,
): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const target = await requireTransitionTarget(null);
    return withTransitionDiagnostics(
      'unlock',
      undefined,
      () => runWithFileTransitionLease(target, (port, releaseFence) => runProvidePassphraseOverRemote(
        passphrase,
        port,
        target.fileSyncLease
          ? () => revalidateMobileFileSyncLease(target.fileSyncLease!)
          : undefined,
        releaseFence,
      )),
      (result) => (result === 'ok' ? 'ok' : result),
    );
});

/** "Not now". Re-affirms the persisted no-key state; automatic and background sync stay
 *  off for this backend until a passphrase actually validates. */
export const declineSyncEncryptionPassphrase = async (): Promise<void> => {
    await loadSyncEncryptionLocalState();
    reaffirmRemoteEncryptionNoKey(syncEncryptionLocalState);
    await flushSyncEncryptionLocalState();
};

export const __syncEncryptionServiceTestUtils = {
  buildTransitionEntries,
  captureTransitionInventory,
  listDropboxAttachmentKeys,
  listWebdavAttachmentKeys,
  createDropboxRemotePort,
  createWebdavRemotePort,
  runProvidePassphraseOverRemote,
  runWithRemoteMutationFence,
};
