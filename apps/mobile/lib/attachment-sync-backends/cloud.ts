import {
  applyAttachmentPatches,
  applyAttachmentContentStat,
  cloudGetFile,
  cloudPutFile,
  computeSha256Hex,
  isAbortError,
  validateAttachmentHash,
  validateAttachmentForUpload,
  type AppData,
  type Attachment,
  type AttachmentDownloadExpectation,
  type LocalFileStat,
} from '@mindwtr/core';
import { logAttachmentWarn, markAttachmentPresenceReconciled } from '../attachment-sync-utils';
import { getMobileCloudRequestOptions } from '../webdav-request-options';
import {
  buildCloudKey,
  canUploadAttachmentFrom,
  collectAttachments,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  getLocalAttachmentPresence,
  isHttpAttachmentUri,
  readAttachmentBytesForUpload,
  reportProgress,
  toArrayBuffer,
  type CloudConfig,
} from '../attachment-sync-utils';
import {
  migrateAttachmentsLocallyBeforeSync,
  checkBespokeAttachmentRemoteWinner,
  createMobileAttachmentUploadSnapshot,
  installAttachmentDownloadBytes,
  prepareBespokeAttachmentContentCandidate,
  refreshBespokeAttachmentDownloadedContentStat,
  uploadCloudFileWithFileSystem,
} from './common';

export type CloudAttachmentSyncOptions = {
  activationProbe?: boolean;
  assertCurrent?: () => void;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  phase?: 'prepare' | 'post-merge';
  signal?: AbortSignal;
};

const CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS = 35_000;

type PendingCloudUploadMutation = {
  attachment: Attachment;
  cloudKey: string;
  fileHash: string;
  stat: LocalFileStat;
  fileSize?: number;
  totalBytes: number;
};

const createAbortError = (): Error => {
  const error = new Error('Attachment upload aborted');
  error.name = 'AbortError';
  return error;
};

const assertNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createAbortError();
};

const isAbortLikeError = (error: unknown, signal?: AbortSignal): boolean => {
  return Boolean(signal?.aborted) || isAbortError(error);
};

export const syncCloudAttachments = async (
  appData: AppData,
  cloudConfig: CloudConfig,
  baseSyncUrl: string,
  options: CloudAttachmentSyncOptions = {}
): Promise<AppData | false> => {
  const attachmentsDir = await getAttachmentsDir();

  const attachmentsById = collectAttachments(appData);
  // This backend runs its own loop rather than the shared lifecycle, so it does the same
  // bookkeeping by hand: write to a per-attachment working copy, record it here, and put it
  // back into `attachmentsById`. The patches are folded into a fresh document at the end.
  const allPatches = await migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal);
  const recordPatch = (attachment: Attachment): void => {
    allPatches.set(attachment.id, attachment);
    attachmentsById.set(attachment.id, attachment);
  };

  const pendingUploadMutations: PendingCloudUploadMutation[] = [];
  const cloudRequestOptions = getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp);

  for (const original of attachmentsById.values()) {
    if (original.kind !== 'file') continue;
    if (original.deletedAt) continue;

    const attachment: Attachment = { ...original };

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocalPath = Boolean(uri) && !isHttp;
    const localPresence = hasLocalPath
      ? await getLocalAttachmentPresence(uri)
      : 'confirmed-not-found';
    if (localPresence === 'unreadable') continue;
    const existsLocally = localPresence === 'present';
    // This provider cannot bind its recovery GET and replacement PUT to one
    // remote generation. Preserve the pending identity until local bytes return
    // (or a later merge supersedes it) instead of risking a stale overwrite.
    if (
      options.phase !== 'prepare'
      && attachment.pendingContentUpload === true
      && !existsLocally
    ) continue;
    const nextStatus = getAttachmentLocalStatus(uri, localPresence);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      recordPatch(attachment);
    }

    const mayUploadLocalFile = hasLocalPath
      && existsLocally
      && !isHttp
      && canUploadAttachmentFrom(uri);
    if (
      options.phase === 'prepare'
      && (attachment.cloudKey || attachment.pendingContentUpload === true)
      && mayUploadLocalFile
    ) {
      if (await prepareBespokeAttachmentContentCandidate(attachment, uri)) {
        recordPatch(attachment);
      }
    }

    let remoteWinnerExpectation: AttachmentDownloadExpectation | undefined;
    if (
      !options.activationProbe
      && options.phase === 'post-merge'
      && attachment.cloudKey
      && mayUploadLocalFile
      && attachment.pendingContentUpload !== true
    ) {
      const contentCheck = await checkBespokeAttachmentRemoteWinner(attachment, uri);
      if (contentCheck.metadataChanged) recordPatch(attachment);
      if (contentCheck.kind === 'local-edit-race') {
        logAttachmentWarn(`Skipped remote attachment replacement after a local edit race (${attachment.id})`);
      } else if (contentCheck.kind === 'download') {
        remoteWinnerExpectation = contentCheck.expectation;
      }
    }

    if (
      options.activationProbe
      && options.phase !== 'prepare'
      && attachment.cloudKey
      && !existsLocally
      && !isHttp
      && attachmentsDir
    ) {
      try {
        assertNotAborted(options.signal);
        reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
        const data = await cloudGetFile(
          `${baseSyncUrl}/${attachment.cloudKey}`,
          options.signal
            ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
            : { ...cloudRequestOptions, token: cloudConfig.token },
        );
        const bytes = new Uint8Array(data);
        await validateAttachmentHash(attachment, bytes);
        const fileHash = await computeSha256Hex(bytes);
        if (!fileHash) throw new Error('Attachment download hash is unavailable');
        const filename = attachment.cloudKey.split('/').pop()
          || `${attachment.id}${extractExtension(attachment.title)}`;
        const targetUri = `${attachmentsDir}${filename}`;
        assertNotAborted(options.signal);
        const installed = await installAttachmentDownloadBytes(
          attachment,
          attachmentsDir,
          targetUri,
          bytes,
          { kind: 'absent' },
          options.signal,
        );
        if (!installed) {
          reportProgress(
            attachment.id,
            'download',
            0,
            attachment.size ?? 0,
            'failed',
            'Local attachment changed during download',
          );
          logAttachmentWarn(`Skipped candidate attachment download after a native conflict (${attachment.id})`);
          continue;
        }
        attachment.uri = targetUri;
        attachment.fileHash = attachment.fileHash || fileHash;
        attachment.localStatus = 'available';
        recordPatch(attachment);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      } catch (error) {
        if (isAbortLikeError(error, options.signal)) throw error;
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        logAttachmentWarn(`Failed to prove candidate attachment ${attachment.id}`, error);
      }
      continue;
    }

    // Self-hosted Cloud deliberately keeps missing remote attachments on-demand.
    // A stale file that is already present is different: merged metadata selected
    // the remote generation, so converge it through the same native present-CAS
    // installer used by the shared lifecycle rather than uploading stale bytes.
    if (remoteWinnerExpectation && attachmentsDir && attachment.cloudKey) {
      try {
        assertNotAborted(options.signal);
        reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
        const data = await cloudGetFile(
          `${baseSyncUrl}/${attachment.cloudKey}`,
          options.signal
            ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
            : { ...cloudRequestOptions, token: cloudConfig.token },
        );
        const bytes = new Uint8Array(data);
        await validateAttachmentHash(attachment, bytes);
        assertNotAborted(options.signal);
        const installed = await installAttachmentDownloadBytes(
          attachment,
          attachmentsDir,
          uri,
          bytes,
          remoteWinnerExpectation,
          options.signal,
        );
        if (!installed) {
          logAttachmentWarn(`Skipped remote attachment replacement after a native conflict (${attachment.id})`);
          continue;
        }
        attachment.localStatus = 'available';
        await refreshBespokeAttachmentDownloadedContentStat(attachment, uri);
        recordPatch(attachment);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      } catch (error) {
        if (isAbortLikeError(error, options.signal)) throw error;
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        logAttachmentWarn(`Failed to download remote attachment winner ${attachment.id}`, error);
      }
      continue;
    }

    // SEC-07: same containment the shared lifecycle applies via `canUploadFrom`.
    if (
      options.phase !== 'prepare'
      && (!attachment.cloudKey || attachment.pendingContentUpload === true)
      && mayUploadLocalFile
    ) {
      let shouldPropagateError = false;
      let snapshot: Awaited<ReturnType<typeof createMobileAttachmentUploadSnapshot>> = null;
      try {
        assertNotAborted(options.signal);
        try {
          options.assertCurrent?.();
        } catch (error) {
          shouldPropagateError = true;
          throw error;
        }
        snapshot = await createMobileAttachmentUploadSnapshot(uri, attachment);
        if (!snapshot) continue;
        if (
          attachment.pendingContentUpload === true
          && snapshot.fileHash !== attachment.fileHash?.trim().toLowerCase()
        ) {
          continue;
        }
        const fileSize = snapshot.stat.size;

        const validation = await validateAttachmentForUpload(attachment, fileSize);
        if (!validation.valid) {
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
          continue;
        }
        const totalBytes = Math.max(0, Number(fileSize ?? 0));
        reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');
        const cloudKey = buildCloudKey(attachment);
        const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
        try {
          await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
        } catch (error) {
          shouldPropagateError = true;
          throw error;
        }
        const uploadedWithFileSystem = await uploadCloudFileWithFileSystem(
          uploadUrl,
          snapshot.sourcePath,
          attachment.mimeType || DEFAULT_CONTENT_TYPE,
          cloudConfig.token,
          (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
          totalBytes,
          options.signal
        );
        if (!uploadedWithFileSystem) {
          assertNotAborted(options.signal);
          const readResult = await readAttachmentBytesForUpload(snapshot.sourcePath);
          if (readResult.readFailed) throw readResult.error;
          const uploadBytes = readResult.data;
          const buffer = toArrayBuffer(uploadBytes);
          try {
            await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }
          await cloudPutFile(
            uploadUrl,
            buffer,
            attachment.mimeType || DEFAULT_CONTENT_TYPE,
            options.signal
              ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
              : { ...cloudRequestOptions, token: cloudConfig.token }
          );
        }
        try {
          options.assertCurrent?.();
        } catch (error) {
          shouldPropagateError = true;
          throw error;
        }
        pendingUploadMutations.push({
          attachment,
          cloudKey,
          fileHash: snapshot.fileHash,
          stat: snapshot.stat,
          fileSize: Number.isFinite(fileSize ?? NaN) ? Number(fileSize) : undefined,
          totalBytes,
        });
      } catch (error) {
        if (shouldPropagateError || isAbortLikeError(error, options.signal)) {
          // The deterministic target may have existed before this attempt. Leaving
          // an unreferenced successful PUT for orphan cleanup is safe; deleting it
          // here could erase another device's winning blob.
          throw error;
        }
        reportProgress(
          attachment.id,
          'upload',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        logAttachmentWarn(`Failed to upload attachment ${attachment.id}`, error);
      } finally {
        if (snapshot) {
          await snapshot.dispose().catch((error) => {
            logAttachmentWarn(`Failed to clean up attachment upload snapshot ${attachment.id}`, error);
          });
        }
      }
    }
  }

  for (const pending of pendingUploadMutations) {
    pending.attachment.cloudKey = pending.cloudKey;
    pending.attachment.pendingContentUpload = undefined;
    applyAttachmentContentStat(pending.attachment, pending.stat, pending.fileHash);
    if (!Number.isFinite(pending.attachment.size ?? NaN) && Number.isFinite(pending.fileSize ?? NaN)) {
      pending.attachment.size = Number(pending.fileSize);
    }
    pending.attachment.localStatus = 'available';
    recordPatch(pending.attachment);
    reportProgress(pending.attachment.id, 'upload', pending.totalBytes, pending.totalBytes, 'completed');
  }

  // A completed pass is this backend's whole reconciliation: it refreshed every
  // attachment's local presence and settled every transfer. Stamping it lets
  // `hasPendingAttachmentSyncWork` keep the steady state quiet until the next one is due
  // (audit F3). Never stamped for an activation probe, whose subject is the candidate
  // configuration rather than the committed one the stamp names.
  if (!options.activationProbe) await markAttachmentPresenceReconciled();

  const nextData = applyAttachmentPatches(appData, allPatches);
  return nextData !== appData ? nextData : false;
};
