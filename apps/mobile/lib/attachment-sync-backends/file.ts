import type { AppData, Attachment, SyncKeyMaterial } from '@mindwtr/core';
import { applyAttachmentPatches, validateAttachmentForUpload, validateAttachmentHash } from '@mindwtr/core';
import * as FileSystem from '../file-system';
import {
  buildCloudKey,
  bytesToBase64,
  collectAttachments,
  computeAttachmentFileHash,
  copyFileSafely,
  createAttachmentLocalMigrationLimiter,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  FILE_BACKEND_VALIDATION_CONFIG,
  fileExists,
  getAttachmentByteSize,
  getAttachmentsDir,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  logAttachmentWarn,
  readSafDirectoryEntriesByName,
  readFileAsBytes,
  resolveFileSyncDir,
  statAttachmentFile,
  StorageAccessFramework,
  writeBytesSafely,
} from '../attachment-sync-utils';
import {
  assertAttachmentSyncNotAborted,
  isAttachmentSyncAbortError,
  openAttachmentBytesFromDownload,
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
  assertAttachmentSyncNotAborted(signal);
  const syncDir = await resolveFileSyncDir(syncPath);
  if (!syncDir) return false;

  assertAttachmentSyncNotAborted(signal);
  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return false;

  const attachmentsById = collectAttachments(appData);

  // Memoized across the whole pass: every attachment that needs a SAF lookup this round shares
  // one directory listing rather than re-reading it per attachment.
  let safEntriesByName: Map<string, string> | null = null;
  const getSafEntriesByName = async (): Promise<Map<string, string>> => {
    if (!safEntriesByName) {
      safEntriesByName = await readSafDirectoryEntriesByName(syncDir.attachmentsDirUri);
    }
    return safEntriesByName;
  };
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
    const localMigration = await migrateAttachmentLocally(attachment);
    if (localMigration.migrated) patched = true;
    if (localMigration.skipped) {
      attachmentsById.delete(attachment.id);
      continue;
    }

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocal = Boolean(uri) && !isHttp;
    if (hasLocal && attachment.pendingContentUpload !== true && (await fileExists(uri))) {
      const cloudKey = attachment.cloudKey || buildCloudKey(attachment);
      const filename = remoteFilenameFor(cloudKey, attachment);
      const remoteExists =
        syncDir.type === 'file'
          ? await fileExists(`${syncDir.attachmentsDirUri}${filename}`)
          : (await getSafEntriesByName()).has(filename);
      if (!remoteExists && attachment.cloudKey !== undefined) {
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
    localFileExists: fileExists,
    deferUploads: options.phase === 'prepare',
    getLocalFileStat: (path) => statAttachmentFile(path),
    computeLocalFileHash: (path) => computeAttachmentFileHash(path),
    contentChangePhase: options.phase,
    isFatalError: (error) => isAttachmentSyncAbortError(error, signal),
    // Normal background sync leaves remote-only files for on-demand fetch. An
    // activation probe is different: its cloned snapshot must prove that every
    // referenced object exists before settings commit. Marking the clone
    // available is only the proof signal consumed by the shared probe; neither
    // localStatus nor this clone is persisted.
    onDownload: async (attachment) => {
      if (!attachment.cloudKey) return false;
      const filename = remoteFilenameFor(attachment.cloudKey, attachment);
      const remoteUri = syncDir.type === 'file'
        ? `${syncDir.attachmentsDirUri}${filename}`
        : (await getSafEntriesByName()).get(filename) ?? null;
      const remoteExists = remoteUri ? await fileExists(remoteUri) : false;
      if (attachment.pendingContentUpload === true && remoteUri && remoteExists) {
        const bytes = await readFileAsBytes(remoteUri)
          .then((value) => openAttachmentBytesFromDownload(value, options.material));
        await validateAttachmentHash(attachment, bytes);
        assertAttachmentSyncNotAborted(signal);
        const targetUri = `${attachmentsDir}${filename}`;
        await writeBytesSafely(targetUri, bytes);
        attachment.uri = targetUri;
        attachment.localStatus = 'available';
        if (!Number.isFinite(attachment.size ?? NaN)) attachment.size = bytes.byteLength;
        return true;
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
    onUpload: async (attachment, localPath) => {
      const cloudKey = buildCloudKey(attachment);
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
      if (syncDir.type === 'file') {
        const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
        if (isContentAttachmentUri(localPath) || material) {
          // `copyFileSafely` would copy the local plaintext straight into the sync
          // folder, so encryption always takes the read-seal-write route.
          const bytes = await sealAttachmentBytesForUpload(await readFileAsBytes(localPath), material);
          assertAttachmentSyncNotAborted(signal);
          await writeBytesSafely(targetUri, bytes);
        } else {
          assertAttachmentSyncNotAborted(signal);
          await copyFileSafely(localPath, targetUri);
        }
      } else {
        const base64 = await readFileAsBytes(localPath)
          .then((bytes) => sealAttachmentBytesForUpload(bytes, material))
          .then(bytesToBase64);
        assertAttachmentSyncNotAborted(signal);
        const safEntries = await getSafEntriesByName();
        let targetUri = safEntries.get(filename) ?? null;
        if (!targetUri && StorageAccessFramework?.createFileAsync) {
          assertAttachmentSyncNotAborted(signal);
          targetUri = await StorageAccessFramework.createFileAsync(
            syncDir.attachmentsDirUri,
            filename,
            attachment.mimeType || DEFAULT_CONTENT_TYPE
          );
          if (targetUri) {
            safEntries.set(filename, targetUri);
          }
        }
        if (targetUri && StorageAccessFramework?.writeAsStringAsync) {
          assertAttachmentSyncNotAborted(signal);
          await StorageAccessFramework.writeAsStringAsync(targetUri, base64, {
            encoding: FileSystem.EncodingType.Base64,
          });
        }
      }
      attachment.cloudKey = cloudKey;
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
