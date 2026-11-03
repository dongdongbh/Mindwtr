


import type { FileSyncTransitionTestHooks } from '@mindwtr/core';

import { mobileFileSync } from './file-sync-host';

export type {
    FileSyncEncryptionTarget,
    FileSyncRemotePort,
    FileSyncTransitionInventoryPoint,
    FileSyncTransitionMutationPoint,
    FileSyncTransitionTestHooks,
} from '@mindwtr/core';

export const isUnverifiedLengthRead = (bytes: Uint8Array) => mobileFileSync().isUnverifiedLengthRead(bytes);
export const readSyncArtifactBytes = (uri: string) => mobileFileSync().readSyncArtifactBytes(uri);
export const padBytesForNonTruncatingOverwrite = (bytes: Uint8Array, previousLength: number) =>
    mobileFileSync().padBytesForNonTruncatingOverwrite(bytes, previousLength);
export const writeSyncArtifactBytes = (uri: string, bytes: Uint8Array, options?: { createOnly?: boolean }) =>
    mobileFileSync().writeSyncArtifactBytes(uri, bytes, options);
export const deleteSyncArtifact = (uri: string) => mobileFileSync().deleteSyncArtifact(uri);
export const listBlockingRetainedGenerations = (syncFileUri: string) => mobileFileSync().listBlockingRetainedGenerations(syncFileUri);
export const resolveFileSyncEncryptionTarget = (syncFileUri: string) => mobileFileSync().resolveFileSyncEncryptionTarget(syncFileUri);
export const resolveSyncArtifactSiblingUri = (syncFileUri: string, leafName: string, options: { createIfMissing: boolean }) =>
    mobileFileSync().resolveSyncArtifactSiblingUri(syncFileUri, leafName, options);
export const createFileSyncEncryptionRemotePort = (syncFileUri: string, testHooks?: FileSyncTransitionTestHooks) =>
    mobileFileSync().createFileSyncEncryptionRemotePort(syncFileUri, testHooks);

export const __storageFileEncryptionTestUtils = {
    getLeafName: (uri: string) => mobileFileSync().testUtils.getLeafName(uri),
    isSeedBackupDocumentName: (name: string) => mobileFileSync().testUtils.isSeedBackupDocumentName(name),
    isSyncDocumentName: (name: string) => mobileFileSync().testUtils.isSyncDocumentName(name),
};
