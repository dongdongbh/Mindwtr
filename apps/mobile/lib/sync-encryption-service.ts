// The phase-3-facing sync-encryption API for mobile (#1056 phase 2). The service itself —
// backend dispatch, the remote ports, the remote mutation fence, the File Sync lease rules
// and the transition diagnostics — lives in core
// (`packages/core/src/sync-encryption-service.ts`) so the native app runs the same code.
// This module binds it to AsyncStorage, the mobile state store, the native crypto, the
// background-safe fetch, xmldom, and File Sync's lock and folder IO.
//
// Out of scope by design: CloudKit and self-hosted mindwtr-cloud.

import {
    createSyncEncryptionService,
    type SyncEncryptionService,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
    type SyncEncryptionTransitionOptions,
} from '@mindwtr/core';
import { DOMParser } from '@xmldom/xmldom';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
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
import { backgroundSafeFetch } from './background-safe-fetch';

export {
    isSyncEncryptionCleanupDeferredError,
    SyncEncryptionCleanupDeferredError,
} from '@mindwtr/core';
export type { SyncEncryptionProgressCallback, SyncEncryptionTransitionOptions } from '@mindwtr/core';

// Created on first use: tests that replace @mindwtr/core as a whole still import this module.
let service: SyncEncryptionService | null = null;
const encryptionService = (): SyncEncryptionService => {
    service ??= createSyncEncryptionService<MobileFileSyncLease>({
        storage: {
            getItem: (key) => AsyncStorage.getItem(key),
            removeItem: (key) => AsyncStorage.removeItem(key),
        },
        state: {
            loadSyncEncryptionLocalState: () => loadSyncEncryptionLocalState(),
            reloadSyncEncryptionLocalStateForRecovery: () => reloadSyncEncryptionLocalStateForRecovery(),
            flushSyncEncryptionLocalState: () => flushSyncEncryptionLocalState(),
            syncEncryptionLocalState,
            syncEncryptionKeyCache,
            getSyncEncryptionMaterial: () => getSyncEncryptionMaterial(),
            getSyncEncryptionStatus: () => getMobileSyncEncryptionStatus(),
            logSyncEncryptionEvent: (event, extra, options) => logSyncEncryptionEvent(event, extra, options),
        },
        crypto: mobileSyncCryptoPrimitives,
        fetch: backgroundSafeFetch,
        parseWebdavXml: (source) => {
            const errors: string[] = [];
            const document = new DOMParser({
                errorHandler: (level, message) => errors.push(`${level}: ${String(message)}`),
            }).parseFromString(source, 'application/xml') as unknown as Document;
            return { document, errors };
        },
        loadWebDavConfig: () => loadWebDavConfig(),
        webDavRequestOptions: (allowInsecureHttp) => getMobileWebDavRequestOptions(allowInsecureHttp),
        getDropboxClientId: () => getDropboxClientId(),
        runDropboxAuthorized: (clientId, operation) => runDropboxAuthorized(clientId, operation),
        fileSync: {
            acquireLease: (syncPath) => acquireMobileFileSyncLease(syncPath),
            openRemotePort: async (syncPath) => {
                const fileTarget = await resolveFileSyncEncryptionTarget(syncPath);
                if (fileTarget?.attachmentsDirUri?.startsWith('file://')) {
                    // Abort before the transition snapshots or mutates any artifact
                    // unless every exact scratch reserved by this device is gone.
                    await recoverFileSyncAttachmentPublications(fileTarget.attachmentsDirUri);
                }
                return createFileSyncEncryptionRemotePort(syncPath);
            },
            revalidateLease: (lease) => revalidateMobileFileSyncLease(lease),
            releaseLease: (lease) => releaseMobileFileSyncLease(lease),
            isLeaseIdentityLostError: (error) => error instanceof SyncFileLockIdentityLostError,
        },
    });
    return service;
};

export const getSyncEncryptionStatus = (): Promise<SyncEncryptionStatus> =>
    encryptionService().getSyncEncryptionStatus();

/** True while no durable sync backend exists — enable/disable then run local-only. */
export const isSyncEncryptionBackendPending = (): Promise<boolean> =>
    encryptionService().isSyncEncryptionBackendPending();

// Every mutating transition runs through the SAME serialized queue a sync cycle's
// `MobileSyncRun.run()` uses (`apps/mobile/lib/sync-service.ts`), so a transition and a sync
// cycle never interleave. See core's sync-encryption-service.ts for the full argument.

export const enableSyncEncryption = (
    passphrase: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().enableSyncEncryption(passphrase, options);

export const disableSyncEncryption = (
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().disableSyncEncryption(options);

export const changeSyncEncryptionPassphrase = (
    current: string,
    next: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().changeSyncEncryptionPassphrase(current, next, options);

/** `'no-encrypted-remote'` (#1138): this location holds nothing encrypted, so the no-key state
 *  it was carrying described somewhere else (or a folder since emptied). Core clears the state
 *  back to off; the card tells the user encryption is now off here. */
export const provideSyncEncryptionPassphrase = (
    passphrase: string,
): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'> =>
    encryptionService().provideSyncEncryptionPassphrase(passphrase);

/** "Abandon setup": drops an unfinished change on this device only (core's abandonSyncEncryptionTransition). */
export const abandonSyncEncryptionTransition = (): Promise<SyncEncryptionTransitionKind | null> =>
    encryptionService().abandonSyncEncryptionTransition();

/** Whether the sync location holds ciphertext beside plaintext (a sample of its attachments; core's probeSyncLocationCiphertext). */
export const probeSyncLocationCiphertext = (
    target?: { webdav?: { url: string; username?: string; password?: string; allowInsecureHttp?: boolean } },
): Promise<'plaintext' | 'encrypted' | 'mixed'> => encryptionService().probeSyncLocationCiphertext(target ?? {});

/** "Check this location again" for a location held as partly encrypted (core's recheckPartlyEncryptedLocation). */
export const recheckPartlyEncryptedLocation = (): Promise<'plaintext' | 'encrypted' | 'mixed'> =>
    encryptionService().recheckPartlyEncryptedLocation();

/** "Not now". Re-affirms the persisted no-key state; automatic and background sync stay
 *  off for this backend until a passphrase actually validates. */
export const declineSyncEncryptionPassphrase = (): Promise<void> =>
    encryptionService().declineSyncEncryptionPassphrase();

type ServiceTestUtils = SyncEncryptionService['__testUtils'];

export const __syncEncryptionServiceTestUtils: ServiceTestUtils = {
    buildTransitionEntries: (...args) => encryptionService().__testUtils.buildTransitionEntries(...args),
    captureTransitionInventory: (...args) => encryptionService().__testUtils.captureTransitionInventory(...args),
    listDropboxAttachmentKeys: (...args) => encryptionService().__testUtils.listDropboxAttachmentKeys(...args),
    listWebdavAttachmentKeys: (...args) => encryptionService().__testUtils.listWebdavAttachmentKeys(...args),
    createDropboxRemotePort: (...args) => encryptionService().__testUtils.createDropboxRemotePort(...args),
    createWebdavRemotePort: (...args) => encryptionService().__testUtils.createWebdavRemotePort(...args),
    runProvidePassphraseOverRemote: (...args) =>
        encryptionService().__testUtils.runProvidePassphraseOverRemote(...args),
    runWithRemoteMutationFence: (...args) => encryptionService().__testUtils.runWithRemoteMutationFence(...args),
};
