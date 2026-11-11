


import {
    createStorageSyncEncryptionLocation,
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
    restoreAfterFenceLoss,
} from './sync-encryption-state';
import { backgroundSafeFetch } from './background-safe-fetch';
import { flushPendingSave } from '@mindwtr/core';

export {
    isSyncEncryptionCleanupDeferredError,
    SyncEncryptionCleanupDeferredError,
} from '@mindwtr/core';
export type { SyncEncryptionProgressCallback, SyncEncryptionTransitionOptions } from '@mindwtr/core';


let service: SyncEncryptionService | null = null;
const encryptionService = (): SyncEncryptionService => {
    service ??= createSyncEncryptionService<MobileFileSyncLease>({
        readTrustedLocalData: async () => {
            await flushPendingSave();
            const { readTrustedLocalDataForEncryptionUpgrade } = await import('./storage-adapter');
            return readTrustedLocalDataForEncryptionUpgrade();
        },
        location: createStorageSyncEncryptionLocation({
            getItem: (key) => AsyncStorage.getItem(key),
            removeItem: (key) => AsyncStorage.removeItem(key),
        }),
        state: {
            loadSyncEncryptionLocalState: () => loadSyncEncryptionLocalState(),
            restoreAfterFenceLoss: (before, attempted) => restoreAfterFenceLoss(before, attempted),
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


export const isSyncEncryptionBackendPending = (): Promise<boolean> =>
    encryptionService().isSyncEncryptionBackendPending();


export const enableSyncEncryption = (
    passphrase: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().enableSyncEncryption(passphrase, options);

export const disableSyncEncryption = (
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().disableSyncEncryption(options);

export const upgradeSyncEncryption = (
    passphrase: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().upgradeSyncEncryption(passphrase, options);

export const changeSyncEncryptionPassphrase = (
    current: string,
    next: string,
    options: SyncEncryptionTransitionOptions = {},
): Promise<void> => encryptionService().changeSyncEncryptionPassphrase(current, next, options);


export const provideSyncEncryptionPassphrase = (
    passphrase: string,
): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'> =>
    encryptionService().provideSyncEncryptionPassphrase(passphrase);


export const abandonSyncEncryptionTransition = (): Promise<SyncEncryptionTransitionKind | null> =>
    encryptionService().abandonSyncEncryptionTransition();


export const probeSyncLocationCiphertext = (
    target?: Parameters<SyncEncryptionService['probeSyncLocationCiphertext']>[0],
): Promise<'plaintext' | 'encrypted' | 'mixed'> => encryptionService().probeSyncLocationCiphertext(target ?? {});


export const recheckPartlyEncryptedLocation = (): Promise<'plaintext' | 'encrypted' | 'mixed'> =>
    encryptionService().recheckPartlyEncryptedLocation();


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
