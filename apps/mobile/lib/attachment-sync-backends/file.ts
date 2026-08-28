import type {
  AppData,
  Attachment,
  SyncKeyMaterial,
} from '@mindwtr/core';
import {
  applyAttachmentPatches,
  buildFileSyncGenerationCloudKey,
  computeSha256Hex,
  isSha256Hex,
  isAttachmentUploadAdmissionError,
  MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
  validateAttachmentForUpload,
  validateAttachmentHash,
} from '@mindwtr/core';
import * as FileSystem from '../file-system';
import {
  buildCloudKey,
  attachmentNeedsManagedLocalCopy,
  bytesToBase64,
  collectAttachments,
  createAttachmentLocalMigrationLimiter,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  FILE_BACKEND_VALIDATION_CONFIG,
  getAttachmentByteSize,
  getAttachmentsDir,
  getLocalAttachmentPresence,
  isHttpAttachmentUri,
  logAttachmentWarn,
  getSafLeafName,
  inspectSafDirectoryEntriesByName,
  readFileAsBytes,
  resolveFileSyncDir,
  statAttachmentFile,
  StorageAccessFramework,
  writeBytesSafely,
} from '../attachment-sync-utils';
import {
  abandonFileSyncAttachmentPublication,
  clearFileSyncAttachmentPublicationRecovery,
  claimFileSyncAttachmentPublication,
  completeFileSyncAttachmentPublication,
  hashAttachmentFileGeneration,
  publishImmutableAttachmentFileGeneration,
  recoverFileSyncAttachmentPublications,
  reserveFileSyncAttachmentPublication,
  retainFileSyncAttachmentPublicationForInvalidTarget,
} from '../attachment-file-installer';
import {
  assertAttachmentSyncNotAborted,
  copyAttachmentDownloadToStage,
  deleteAttachmentDownloadStageBestEffort,
  installStagedAttachmentDownload,
  isAttachmentSyncAbortError,
  openAttachmentBytesFromDownload,
  readAttachmentDownloadStageBytes,
  resolveAttachmentDownloadTargetPath,
  runMobileAttachmentLifecycle,
  sealAttachmentBytesForUpload,
} from './common';

export const syncFileAttachments = async (
  appData: AppData,
  syncPath: string,
  signal?: AbortSignal,
  options: {
    activationProbe?: boolean;
    phase?: 'prepare' | 'post-merge';
    /** #1056: seal bytes before they land in the sync folder. Null = encryption off. */
    material?: SyncKeyMaterial | null;
  } = {}
): Promise<AppData | false> => {
  class FileSyncGenerationIntegrityError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'FileSyncGenerationIntegrityError';
    }
  }

  assertAttachmentSyncNotAborted(signal);
  const syncDir = await resolveFileSyncDir(syncPath);
  if (!syncDir) return false;

  // The folder lease is already held by the sync cycle. Recover only exact
  // scratch paths durably reserved by this device; never infer ownership by
  // scanning the shared attachments directory.
  if (syncDir.type === 'file') {
    await recoverFileSyncAttachmentPublications(syncDir.attachmentsDirUri);
  }

  assertAttachmentSyncNotAborted(signal);
  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return false;

  const attachmentsById = collectAttachments(appData);
  const computeManagedAttachmentFileHash = async (path: string): Promise<string | null> => {
    try {
      return (await hashAttachmentFileGeneration(path)).sha256;
    } catch (error) {
      logAttachmentWarn('Failed to hash managed attachment file natively', error);
      return null;
    }
  };

  // Memoized across the whole pass: every attachment that needs a SAF lookup this round shares
  // one directory listing rather than re-reading it per attachment.
  let safEntriesByName: Map<string, string> | null = null;
  const refreshSafEntriesByName = async (): Promise<Map<string, string>> => {
    const inventory = await inspectSafDirectoryEntriesByName(syncDir.attachmentsDirUri);
    if (inventory.status === 'unreadable') {
      throw new Error('SAF attachment inventory is unreadable');
    }
    safEntriesByName = inventory.entries;
    return inventory.entries;
  };
  const getSafEntriesByName = async (): Promise<Map<string, string>> => (
    safEntriesByName ?? refreshSafEntriesByName()
  );
  const remoteFilenameFor = (cloudKey: string, attachment: { id: string; title: string }): string =>
    cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;

  // File-backend-specific pre-pass, interleaving two things per attachment (matching this
  // backend's pre-lifecycle shape exactly): the shared local-migration step, then a
  // reconciliation check unique to this backend — unlike the other backends, an already
  // cloudKey'd attachment isn't assumed to still be on the remote, since this backend syncs to a
  // plain folder a user could have edited directly. So every local, existing attachment gets its
  // remote presence checked here regardless of cloudKey state; if missing, clearing cloudKey
  // lets the lifecycle below re-upload it through its normal hasCloudCopy-false path.
  const migrateAttachmentLocally = createAttachmentLocalMigrationLimiter();
  // Both steps write only to a per-attachment working copy, recorded here and put back into
  // `attachmentsById` so the lifecycle below reads the pre-pass's values.
  const allPatches = new Map<string, Attachment>();
  for (const original of attachmentsById.values()) {
    assertAttachmentSyncNotAborted(signal);
    if (original.kind !== 'file' || original.deletedAt) continue;
    const attachment: Attachment = { ...original };
    let patched = false;
    if (attachmentNeedsManagedLocalCopy(attachment)) {
      const sourcePresence = await getLocalAttachmentPresence(attachment.uri || '');
      if (sourcePresence === 'unreadable') {
        attachmentsById.delete(attachment.id);
        continue;
      }
      if (sourcePresence === 'present') {
        const localMigration = await migrateAttachmentLocally(attachment);
        if (localMigration.migrated) patched = true;
        if (localMigration.skipped) {
          attachmentsById.delete(attachment.id);
          continue;
        }
      }
    }

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocal = Boolean(uri) && !isHttp;
    const localPresence = hasLocal
      ? await getLocalAttachmentPresence(uri)
      : 'confirmed-not-found';
    if (localPresence === 'unreadable') {
      attachmentsById.delete(attachment.id);
      continue;
    }
    if (localPresence === 'present' && attachment.pendingContentUpload !== true) {
      const cloudKey = attachment.cloudKey || buildCloudKey(attachment);
      const filename = remoteFilenameFor(cloudKey, attachment);
      const remotePresence = syncDir.type === 'file'
        ? await getLocalAttachmentPresence(`${syncDir.attachmentsDirUri}${filename}`)
        : (await getSafEntriesByName()).has(filename) ? 'present' : 'confirmed-not-found';
      if (remotePresence === 'confirmed-not-found' && attachment.cloudKey !== undefined) {
        attachment.cloudKey = undefined;
        patched = true;
      }
    }

    if (patched) {
      allPatches.set(attachment.id, attachment);
      attachmentsById.set(attachment.id, attachment);
    }
  }

  const { patches } = await runMobileAttachmentLifecycle({
    attachmentsById,
    getLocalFilePresence: getLocalAttachmentPresence,
    deferUploads: options.phase === 'prepare',
    getLocalFileStat: (path) => statAttachmentFile(path),
    computeLocalFileHash: (path) => computeManagedAttachmentFileHash(path),
    maxBufferedUploadBytes: MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
    contentChangePhase: options.phase,
    isFatalError: (error) => (
      isAttachmentSyncAbortError(error, signal)
      || isAttachmentUploadAdmissionError(error)
    ),
    // Normal background sync leaves remote-only files for on-demand fetch. An
    // activation probe is different: its cloned snapshot must prove that every
    // referenced object exists before settings commit. Marking the clone
    // available is only the proof signal consumed by the shared probe; neither
    // localStatus nor this clone is persisted.
    onDownload: async (attachment, expectation) => {
      if (!attachment.cloudKey) return false;
      const filename = remoteFilenameFor(attachment.cloudKey, attachment);
      const remoteUri = syncDir.type === 'file'
        ? `${syncDir.attachmentsDirUri}${filename}`
        : (await getSafEntriesByName()).get(filename) ?? null;
      const remotePresence = syncDir.type === 'saf'
        ? remoteUri ? 'present' : 'confirmed-not-found'
        : remoteUri
          ? await getLocalAttachmentPresence(remoteUri)
          : 'confirmed-not-found';
      if (remotePresence === 'unreadable') {
        throw new Error('Attachment remote presence is unreadable');
      }
      const remoteExists = remotePresence === 'present';
      if (
        (attachment.pendingContentUpload === true || expectation.kind === 'present')
        && remoteUri
        && remoteExists
      ) {
        let stagedPath: string | null = null;
        let installHelperOwnsStage = false;
        try {
          assertAttachmentSyncNotAborted(signal);
          stagedPath = await copyAttachmentDownloadToStage(attachment, attachmentsDir, remoteUri);
          let expectedStagedHash = !options.material && isSha256Hex(attachment.fileHash)
            ? attachment.fileHash.toLowerCase()
            : null;
          let downloadedSize: number | null = null;
          if (!expectedStagedHash) {
            const wireBytes = await readAttachmentDownloadStageBytes(stagedPath);
            const plaintextBytes = await openAttachmentBytesFromDownload(wireBytes, options.material);
            const plaintextHash = await computeSha256Hex(plaintextBytes);
            if (!plaintextHash) throw new Error('Attachment download hash is unavailable');
            await validateAttachmentHash(attachment, plaintextBytes);
            if (plaintextBytes !== wireBytes) {
              await writeBytesSafely(stagedPath, plaintextBytes);
            }
            expectedStagedHash = plaintextHash;
            downloadedSize = plaintextBytes.byteLength;
          } else if (!Number.isFinite(attachment.size ?? NaN)) {
            const stagedInfo = await FileSystem.getInfoAsync(stagedPath);
            downloadedSize = stagedInfo.exists && typeof stagedInfo.size === 'number'
              ? stagedInfo.size
              : null;
          }
          assertAttachmentSyncNotAborted(signal);
          const targetUri = resolveAttachmentDownloadTargetPath(
            attachment,
            `${attachmentsDir}${filename}`,
            expectation,
          );
          installHelperOwnsStage = true;
          const installed = await installStagedAttachmentDownload({
            attachment,
            stagedPath,
            targetPath: targetUri,
            expectation,
            signal,
            expectedStagedHash,
          });
          if (!installed) return false;
          attachment.uri = targetUri;
          attachment.localStatus = 'available';
          if (!Number.isFinite(attachment.size ?? NaN) && downloadedSize != null) {
            attachment.size = downloadedSize;
          }
          return true;
        } catch (error) {
          if (stagedPath && !installHelperOwnsStage) {
            await deleteAttachmentDownloadStageBestEffort(stagedPath);
          }
          throw error;
        }
      }
      if (!options.activationProbe) return false;
      if (!remoteExists) {
        attachment.cloudKey = undefined;
        return true;
      }
      attachment.localStatus = 'available';
      return true;
    },
    onDownloadError: () => {},
    onUpload: async (attachment, localPath, snapshot) => {
      if (!snapshot) throw new Error('Immutable attachment upload snapshot is unavailable');
      const cloudKey = buildFileSyncGenerationCloudKey(attachment, snapshot.fileHash);
      const recordPublishedGeneration = (): void => {
        attachment.cloudKey = cloudKey;
      };
      const filename = remoteFilenameFor(cloudKey, attachment);
      const size = await getAttachmentByteSize(attachment, localPath);
      if (size != null) {
        const validation = await validateAttachmentForUpload(attachment, size, FILE_BACKEND_VALIDATION_CONFIG);
        if (!validation.valid) {
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
          return false;
        }
      }
      const material = options.material ?? null;
      const verifyPublishedGeneration = async (targetUri: string): Promise<void> => {
        const wireBytes = await readFileAsBytes(targetUri);
        try {
          const plaintextBytes = await openAttachmentBytesFromDownload(wireBytes, material);
          const actualHash = await computeSha256Hex(plaintextBytes);
          if (actualHash?.toLowerCase() !== snapshot.fileHash.toLowerCase()) {
            throw new Error('plaintext digest mismatch');
          }
        } catch (error) {
          throw new FileSyncGenerationIntegrityError(
            'File Sync attachment generation failed integrity verification',
            { cause: error },
          );
        }
      };
      const wireBytes = await sealAttachmentBytesForUpload(await readFileAsBytes(localPath), material);
      const wireBase64 = bytesToBase64(wireBytes);
      if (syncDir.type === 'file') {
        const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
        const wireHash = await computeSha256Hex(wireBytes);
        if (!wireHash) throw new Error('File Sync attachment stage could not be hashed');
        const initialPresence = await getLocalAttachmentPresence(targetUri);
        if (initialPresence === 'unreadable') {
          throw new Error('File Sync attachment generation is unreadable');
        }
        if (initialPresence === 'confirmed-not-found') {
          // Manual removal of the corrupt canonical generation is an explicit
          // recovery action; do not keep its bounded collision history latched.
          await clearFileSyncAttachmentPublicationRecovery(targetUri);
        }
        if (initialPresence === 'present') {
          try {
            await verifyPublishedGeneration(targetUri);
            await clearFileSyncAttachmentPublicationRecovery(targetUri);
            recordPublishedGeneration();
            return true;
          } catch (error) {
            if (!(error instanceof FileSyncGenerationIntegrityError)) throw error;
          }
        }

        const reservation = await reserveFileSyncAttachmentPublication(targetUri, wireHash);
        const stagedUri = reservation.stagedPath;
        try {
          assertAttachmentSyncNotAborted(signal);
          await FileSystem.writeAsStringAsync(stagedUri, wireBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          await verifyPublishedGeneration(stagedUri);
          await claimFileSyncAttachmentPublication(reservation);
        } catch (error) {
          await abandonFileSyncAttachmentPublication(reservation).catch(() => undefined);
          throw error;
        }
        try {
          const currentPresence = await getLocalAttachmentPresence(targetUri);
          if (currentPresence === 'unreadable') {
            throw new Error('File Sync attachment generation is unreadable');
          }
          if (currentPresence === 'present') {
            try {
              await verifyPublishedGeneration(targetUri);
              await completeFileSyncAttachmentPublication(reservation);
              recordPublishedGeneration();
              return true;
            } catch (error) {
              if (!(error instanceof FileSyncGenerationIntegrityError)) throw error;
            }
          }

          assertAttachmentSyncNotAborted(signal);
          const publication = await publishImmutableAttachmentFileGeneration(
            stagedUri,
            targetUri,
            wireHash,
          );
          if (publication.status === 'alreadyExists') {
            try {
              await verifyPublishedGeneration(targetUri);
            } catch (error) {
              if (error instanceof FileSyncGenerationIntegrityError) {
                await retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
              }
              throw error;
            }
          }
          try {
            await verifyPublishedGeneration(targetUri);
          } catch (error) {
            if (error instanceof FileSyncGenerationIntegrityError) {
              await retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
            }
            throw error;
          }
          await completeFileSyncAttachmentPublication(reservation);
        } catch (error) {
          // A durable exact-path reservation owns the verified stage. The next
          // locked cycle removes it before retry; corrupt canonical collisions
          // also retain a bounded device-local attempt count.
          throw error;
        }
      } else {
        assertAttachmentSyncNotAborted(signal);
        const safEntries = await getSafEntriesByName();
        let targetUri = safEntries.get(filename) ?? null;
        if (targetUri) {
          await verifyPublishedGeneration(targetUri);
          recordPublishedGeneration();
          return true;
        }
        let invocationOwnedTarget: string | null = null;
        if (!StorageAccessFramework?.createFileAsync || !StorageAccessFramework?.writeAsStringAsync) {
          throw new Error('SAF attachment writes are unavailable');
        }
        try {
          assertAttachmentSyncNotAborted(signal);
          try {
            targetUri = await StorageAccessFramework.createFileAsync(
              syncDir.attachmentsDirUri,
              filename,
              attachment.mimeType || DEFAULT_CONTENT_TYPE
            );
          } catch (createError) {
            const peerTarget = (await refreshSafEntriesByName()).get(filename) ?? null;
            if (peerTarget) {
              await verifyPublishedGeneration(peerTarget);
              recordPublishedGeneration();
              return true;
            }
            throw createError;
          }
          if (!targetUri) throw new Error('SAF attachment target creation failed');
          invocationOwnedTarget = targetUri;
          if (getSafLeafName(targetUri) !== filename) {
            await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
            invocationOwnedTarget = null;
            const peerTarget = (await refreshSafEntriesByName()).get(filename) ?? null;
            if (peerTarget) {
              await verifyPublishedGeneration(peerTarget);
              recordPublishedGeneration();
              return true;
            }
            throw new Error('SAF provider did not create the requested attachment name');
          }
          assertAttachmentSyncNotAborted(signal);
          await StorageAccessFramework.writeAsStringAsync(targetUri, wireBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          await verifyPublishedGeneration(targetUri);
          safEntries.set(filename, targetUri);
          invocationOwnedTarget = null;
        } catch (error) {
          if (invocationOwnedTarget) {
            await FileSystem.deleteAsync(invocationOwnedTarget, { idempotent: true }).catch(() => undefined);
          }
          throw error;
        }
      }
      recordPublishedGeneration();
      // localStatus is already 'available' here: onUpload only runs when the lifecycle's own
      // existsLocally check just passed, which is what set it.
      return true;
    },
    onUploadError: (attachment, error) => {
      logAttachmentWarn(`Failed to copy attachment ${attachment.id} to sync folder`, error);
    },
  });

  for (const patch of patches.values()) allPatches.set(patch.id, patch);
  const nextData = applyAttachmentPatches(appData, allPatches);
  return nextData !== appData ? nextData : false;
};
