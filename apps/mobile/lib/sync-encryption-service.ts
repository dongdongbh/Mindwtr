// The phase-3-facing sync-encryption API for mobile (#1056 phase 2). Every function
// dispatches on the configured backend and then delegates to core's transition
// orchestration (`packages/core/src/sync-encryption.ts`) with a mobile port — the
// ordering, verify-before-delete, and resume semantics all live there, in one place,
// for File Sync, WebDAV and Dropbox alike.
//
// Out of scope by design: CloudKit and self-hosted mindwtr-cloud.

import {
    collectAttachmentsById,
    getBaseSyncUrl,
    reaffirmRemoteEncryptionNoKey,
    runChangeSyncEncryptionPassphraseOverRemote,
    runDisableSyncEncryptionLocalOnly,
    runDisableSyncEncryptionOverRemote,
    runEnableSyncEncryptionLocalOnly,
    runEnableSyncEncryptionOverRemote,
    runProvideSyncEncryptionPassphraseOverRemote,
    runSerializedSyncDocumentOperation,
    SYNC_FILE_NAME,
    webdavDeleteFile,
    webdavGetFile,
    webdavPutFile,
    type AppData,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemotePort,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionProgress,
} from '@mindwtr/core';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    deleteDropboxFile,
    downloadDropboxFile,
    DropboxFileNotFoundError,
    uploadDropboxFile,
} from './dropbox-sync';
import {
    getDropboxClientId,
    loadWebDavConfig,
    runDropboxAuthorized,
} from './attachment-sync-utils';
import { createFileSyncEncryptionRemotePort } from './storage-file-encryption';
import { getMobileWebDavRequestOptions } from './webdav-request-options';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import {
    flushSyncEncryptionLocalState,
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

export type SyncEncryptionProgressCallback = (progress: SyncEncryptionTransitionProgress) => void;

/**
 * The artifact set a transition covers, derived from the local document rather than from
 * a remote directory listing.
 *
 * ponytail: neither WebDAV (PROPFIND) nor Dropbox (files/list_folder) has a listing
 * primitive in core today, and adding two new wire protocols inside a delete-capable
 * code path is a poor trade against deriving the exact set we actually manage. The
 * accepted ceiling: an ORPHANED remote attachment — one no live attachment record points
 * at — is not migrated by enable/disable. Orphans are already the attachment-cleanup
 * pass's job, and leaving one untouched can never lose data. Add real listings here if
 * "old plaintext attachment left behind after enabling" ever becomes a real report.
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
    for (const attachment of collectAttachmentsById(appData).values()) {
        const cloudKey = attachment.cloudKey;
        if (!cloudKey || seen.has(cloudKey)) continue;
        seen.add(cloudKey);
        entries.push({ name: cloudKey, kind: 'attachment' });
    }
    return entries;
};

const createWebdavRemotePort = async (appData: AppData | null): Promise<SyncEncryptionRemotePort> => {
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
    const urlFor = (name: string): string => `${baseSyncUrl}/${name}`;
    return {
        list: async () => buildTransitionEntries(appData),
        read: async (name) => {
            try {
                const data = await webdavGetFile(urlFor(name), requestOptions);
                return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
            } catch {
                // A 404 for an artifact this folder simply does not have is the normal
                // case for half of the derived entry list.
                return null;
            }
        },
        write: async (name, bytes) => {
            await webdavPutFile(urlFor(name), bytes, 'application/octet-stream', requestOptions);
        },
        remove: async (name) => {
            await webdavDeleteFile(urlFor(name), requestOptions).catch(() => undefined);
        },
    };
};

const createDropboxRemotePort = async (appData: AppData | null): Promise<SyncEncryptionRemotePort> => {
    const clientId = await getDropboxClientId();
    if (!clientId) throw new Error('Dropbox is not configured');
    const authorized = <T,>(operation: (accessToken: string) => Promise<T>): Promise<T> =>
        runDropboxAuthorized(clientId, operation);
    return {
        list: async () => buildTransitionEntries(appData),
        read: async (name) => {
            try {
                const data = await authorized((token) => downloadDropboxFile(token, `/${name}`));
                return new Uint8Array(data);
            } catch (error) {
                if (error instanceof DropboxFileNotFoundError) return null;
                throw error;
            }
        },
        write: async (name, bytes) => {
            await authorized((token) => uploadDropboxFile(token, `/${name}`, bytes));
        },
        remove: async (name) => {
            await authorized((token) => deleteDropboxFile(token, `/${name}`)).catch(() => undefined);
        },
    };
};

type BackendTarget =
    | { kind: 'remote'; port: SyncEncryptionRemotePort }
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
        const port = await createFileSyncEncryptionRemotePort(syncPath);
        if (!port) throw new Error('Unable to open the sync folder');
        return { kind: 'remote', port };
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

const requireTransitionPort = async (appData: AppData | null): Promise<SyncEncryptionRemotePort> => {
    const target = await resolveTransitionTarget(appData);
    if (target.kind === 'local-only') {
        throw new Error('SYNC_ENCRYPTION_BACKEND_REQUIRED');
    }
    if (target.kind !== 'remote') {
        throw new Error('Sync encryption is only available for File Sync, WebDAV and Dropbox.');
    }
    return target.port;
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
    const port = await requireTransitionPort(options.appData ?? null);
    await runEnableSyncEncryptionOverRemote(
        passphrase,
        port,
        syncEncryptionKeyCache,
        syncEncryptionLocalState,
        options.onProgress,
        mobileSyncCryptoPrimitives,
    );
    // The port's write is fire-and-forget by shape; the transition is not done until the state
    // that survives a restart has actually landed.
    await flushSyncEncryptionLocalState();
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
    const port = await requireTransitionPort(options.appData ?? null);
    await runDisableSyncEncryptionOverRemote(
        port,
        syncEncryptionKeyCache,
        syncEncryptionLocalState,
        options.onProgress,
        mobileSyncCryptoPrimitives,
    );
    // The port's write is fire-and-forget by shape; the transition is not done until the state
    // that survives a restart has actually landed.
    await flushSyncEncryptionLocalState();
});

export const changeSyncEncryptionPassphrase = async (
    current: string,
    next: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const port = await requireTransitionPort(options.appData ?? null);
    await runChangeSyncEncryptionPassphraseOverRemote(
        current,
        next,
        port,
        syncEncryptionKeyCache,
        syncEncryptionLocalState,
        options.onProgress,
        mobileSyncCryptoPrimitives,
    );
    // The port's write is fire-and-forget by shape; the transition is not done until the state
    // that survives a restart has actually landed.
    await flushSyncEncryptionLocalState();
});

export const provideSyncEncryptionPassphrase = async (
    passphrase: string,
): Promise<'ok' | 'wrong-passphrase'> => runSerializedSyncDocumentOperation(async () => {
    await loadSyncEncryptionLocalState();
    const port = await requireTransitionPort(null);
    const outcome = await runProvideSyncEncryptionPassphraseOverRemote(
        passphrase,
        SYNC_FILE_NAME,
        port,
        syncEncryptionKeyCache,
        syncEncryptionLocalState,
        mobileSyncCryptoPrimitives,
    );
    await flushSyncEncryptionLocalState();
    return outcome;
});

/** "Not now". Re-affirms the persisted no-key state; automatic and background sync stay
 *  off for this backend until a passphrase actually validates. */
export const declineSyncEncryptionPassphrase = async (): Promise<void> => {
    await loadSyncEncryptionLocalState();
    reaffirmRemoteEncryptionNoKey(syncEncryptionLocalState);
    await flushSyncEncryptionLocalState();
};

export const __syncEncryptionServiceTestUtils = { buildTransitionEntries, createDropboxRemotePort, createWebdavRemotePort };
