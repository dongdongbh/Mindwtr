// The phase-3-facing sync-encryption API for mobile (#1056 phase 2). Every function
// dispatches on the configured backend and then delegates to core's transition
// orchestration (`packages/core/src/sync-encryption.ts`) with a mobile port — the
// ordering, verify-before-delete, and resume semantics all live there, in one place,
// for File Sync, WebDAV and Dropbox alike.
//
// Out of scope by design: CloudKit and self-hosted mindwtr-cloud.

import {
    acquireSyncRemoteMutationFence,
    createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort,
    DEFAULT_TIMEOUT_MS,
    decryptRemoteArtifactOrThrow,
    deriveSyncKeyMaterial,
    fetchWithTimeout,
    getBaseSyncUrl,
    inspectSyncArtifact,
    isSyncRemoteMutationFenceError,
    listDropboxFolderFiles,
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
    type AppData,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemoteInventory,
    type SyncEncryptionRemotePort,
    type SyncEncryptionRemoteRead,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionProgress,
    type SyncEncryptionKeyCachePort,
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
import { createFileSyncEncryptionRemotePort } from './storage-file-encryption';
import {
    acquireMobileFileSyncLease,
    releaseMobileFileSyncLease,
    type MobileFileSyncLease,
} from './sync-file-lock';
import { getMobileWebDavRequestOptions } from './webdav-request-options';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import {
    flushSyncEncryptionLocalState,
    getSyncEncryptionMaterial,
    getMobileSyncEncryptionStatus,
    syncEncryptionKeyCache,
    syncEncryptionLocalState,
    loadSyncEncryptionLocalState,
} from './sync-encryption-state';
import {
    CLOUD_PROVIDER_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
} from './sync-constants';

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
const DAV_NAMESPACE = 'DAV:';
const DAV_PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

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
    if (seenPaths.has(normalizedPath)) throw new Error('WebDAV attachment inventory returned a duplicate href');
    seenPaths.add(normalizedPath);

    const responseStatuses = directDavChildren(response, 'status');
    if (responseStatuses.length > 0) requireSuccessfulDavStatus(response, `response for ${path}`);
    const propstats = directDavChildren(response, 'propstat');
    if (propstats.length === 0) throw new Error(`WebDAV attachment inventory response for ${path} has no DAV:propstat`);
    let resourceType: Element | null = null;
    for (const propstat of propstats) {
      requireSuccessfulDavStatus(propstat, `propstat for ${path}`);
      const props = directDavChildren(propstat, 'prop');
      if (props.length !== 1) throw new Error(`WebDAV attachment inventory properties for ${path} are ambiguous`);
      const resourceTypes = directDavChildren(props[0]!, 'resourcetype');
      if (resourceTypes.length > 1 || (resourceTypes.length === 1 && resourceType)) {
        throw new Error(`WebDAV attachment inventory resource type for ${path} is ambiguous`);
      }
      resourceType = resourceTypes[0] ?? resourceType;
    }
    if (!resourceType) throw new Error(`WebDAV attachment inventory response for ${path} has no DAV:resourcetype`);
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
    if (!leaf || leaf.includes('/')) throw new Error('WebDAV attachment inventory returned a non-child href');
    if (isCollection) continue;
    const key = sanitizeBlobAttachmentKey(`attachments/${leaf}`);
    if (!key) throw new Error('WebDAV attachment inventory returned an invalid attachment name');
    keys.add(key);
  }
  if (!matchedCollection) throw new Error('WebDAV attachment inventory did not identify the requested collection');
  return Array.from(keys).sort();
};

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
  const response = await fetchWithTimeout(
    collectionUrl,
    { method: 'PROPFIND', headers, body: DAV_PROPFIND_BODY, signal: options.signal },
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
    fetcher: typeof fetch = fetch,
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
): Promise<T> => {
  const acquire = (remote as TransitionRemotePort).acquireRemoteMutationFence;
  if (!acquire) {
    const result = await operation(remote, syncEncryptionKeyCache, syncEncryptionLocalState);
    await flushSyncEncryptionLocalState();
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
  const previousState = syncEncryptionLocalState.read();
  const previousKey = await syncEncryptionKeyCache.getKey();
  let localMaterialTouched = false;
  let finalStateWriteAttempted = false;
  let stateBeforeFinalCommit = previousState;
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
    },
    clearKey: async () => {
      await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
      localMaterialTouched = true;
      await syncEncryptionKeyCache.clearKey();
    },
  };
  const guardedLocalState: SyncEncryptionLocalStatePort = {
    read: () => syncEncryptionLocalState.read(),
    write: async (state) => {
      if (state?.incompleteTransition) {
        await assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
      } else {
        stateBeforeFinalCommit = syncEncryptionLocalState.read();
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
        if (previousKey) await syncEncryptionKeyCache.setKey(previousKey);
        else await syncEncryptionKeyCache.clearKey();
        if (finalStateWriteAttempted) await syncEncryptionLocalState.write(stateBeforeFinalCommit);
        await flushSyncEncryptionLocalState();
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
    operation: (port: SyncEncryptionRemotePort) => Promise<T>,
): Promise<T> => {
    if (!target.fileSyncLease) return operation(target.port);
    try {
        return await operation(target.port);
    } finally {
        await releaseMobileFileSyncLease(target.fileSyncLease);
    }
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
        await runEnableSyncEncryptionLocalOnly(
            passphrase,
            syncEncryptionKeyCache,
            syncEncryptionLocalState,
            mobileSyncCryptoPrimitives,
        );
        await flushSyncEncryptionLocalState();
        return;
    }
    if (target.kind !== 'remote') {
        throw new Error('Sync encryption is only available for File Sync, WebDAV and Dropbox.');
    }
    await runWithFileTransitionLease(target, (port) =>
      runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
        runEnableSyncEncryptionOverRemote(
          passphrase,
          guardedRemote,
          keyCache,
          localState,
          options.onProgress,
          mobileSyncCryptoPrimitives,
        )));
});

export const disableSyncEncryption = async (
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const target = await resolveTransitionTarget(options.appData ?? null);
    if (target.kind === 'local-only') {
        await runDisableSyncEncryptionLocalOnly(syncEncryptionKeyCache, syncEncryptionLocalState);
        await flushSyncEncryptionLocalState();
        return;
    }
    if (target.kind !== 'remote') {
        throw new Error('Sync encryption is only available for File Sync, WebDAV and Dropbox.');
    }
    await runWithFileTransitionLease(target, (port) =>
      runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
        runDisableSyncEncryptionOverRemote(
          guardedRemote,
          keyCache,
          localState,
          options.onProgress,
          mobileSyncCryptoPrimitives,
        )));
});

export const changeSyncEncryptionPassphrase = async (
    current: string,
    next: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const target = await requireTransitionTarget(options.appData ?? null);
    await runWithFileTransitionLease(target, (port) =>
      runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
        runChangeSyncEncryptionPassphraseOverRemote(
          current,
          next,
          guardedRemote,
          keyCache,
          localState,
          options.onProgress,
          mobileSyncCryptoPrimitives,
        )));
});

const runProvidePassphraseOverRemote = async (
  passphrase: string,
  port: SyncEncryptionRemotePort,
): Promise<'ok' | 'wrong-passphrase'> => {
  return runWithRemoteMutationFence(port, (guardedRemote, keyCache, localState) =>
    runProvideSyncEncryptionPassphraseOverRemote(
        passphrase,
        SYNC_FILE_NAME,
        guardedRemote,
        keyCache,
        localState,
        mobileSyncCryptoPrimitives,
    ));
};

export const provideSyncEncryptionPassphrase = async (
    passphrase: string,
): Promise<'ok' | 'wrong-passphrase'> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const target = await requireTransitionTarget(null);
    return runWithFileTransitionLease(target, (port) => runProvidePassphraseOverRemote(passphrase, port));
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
  parseWebdavAttachmentKeys,
  createDropboxRemotePort,
  createWebdavRemotePort,
  runProvidePassphraseOverRemote,
  runWithRemoteMutationFence,
};
