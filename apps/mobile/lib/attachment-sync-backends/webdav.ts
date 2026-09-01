import type { AppData, Attachment, SyncKeyMaterial } from '@mindwtr/core';
import {
  applyAttachmentPatches,
  getErrorStatus,
  isSyncRemoteMutationFenceError,
  isWebdavRemoteWriteConflictError,
  isWebdavRateLimitedError,
  normalizeStrongWebdavEtag,
  validateAttachmentForUpload,
  webdavFileExists,
  webdavGetFile,
  webdavHeadFile,
  webdavMakeDirectory,
  webdavPutFileVersioned,
  withRetry,
} from '@mindwtr/core';
import { sanitizeLogMessage } from '../app-log';
import {
  ATTACHMENTS_DIR_NAME,
  buildCloudKey,
  clearWebdavDownloadBackoff,
  collectAttachments,
  computeAttachmentFileHash,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  getAttachmentByteSize,
  getAttachmentsDir,
  getLocalAttachmentPresence,
  getWebdavDownloadBackoff,
  isAttachmentPresenceReconciliationDue,
  isHttpAttachmentUri,
  describeAttachmentUriForLog,
  logAttachmentInfo,
  logAttachmentWarn,
  markAttachmentPresenceReconciled,
  markAttachmentUnrecoverable,
  pruneWebdavDownloadBackoff,
  readAttachmentBytesForUpload,
  reportProgress,
  setWebdavDownloadBackoff,
  statAttachmentFile,
  toArrayBuffer,
  type WebDavConfig,
  validateAttachmentHash,
  WEBDAV_ATTACHMENT_COOLDOWN_MS,
  WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MIN_INTERVAL_MS,
  WEBDAV_ATTACHMENT_RETRY_OPTIONS,
} from '../attachment-sync-utils';
import { assertMobileWebdavConnection, getMobileWebDavRequestOptions } from '../webdav-request-options';
import {
  assertAttachmentSyncNotAborted,
  isAttachmentSyncAbortError,
  installAttachmentDownloadBytes,
  migrateAttachmentsLocallyBeforeSync,
  openAttachmentBytesFromDownload,
  resolveAttachmentDownloadTargetPath,
  runMobileAttachmentLifecycle,
  sealAttachmentBytesForUpload,
  uploadWebdavFileWithFileSystem,
  waitForAttachmentSyncDelay,
} from './common';

// Thrown only for a local file that has become unreadable (e.g. a revoked SAF permission).
// Caught inside `onUpload`'s own catch below so `markAttachmentUnrecoverable`'s mutation is
// tracked via onUpload's return value — mutations from `onUploadError` are NOT seen by the
// shared lifecycle's own `didMutate` tracking, only onUpload/onDownload return values are.
class LocalReadFailure extends Error {
  constructor(public readonly cause: unknown) {
    super('Attachment local file is unreadable');
  }
}

export const syncWebdavAttachments = async (
  appData: AppData,
  webDavConfig: WebDavConfig,
  baseSyncUrl: string,
  signal?: AbortSignal,
  options: {
    activationProbe?: boolean;
    phase?: 'prepare' | 'post-merge';
    /** #1056: seal bytes before upload / open them after download. Null = encryption off. */
    material?: SyncKeyMaterial | null;
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  } = {}
): Promise<AppData | false> => {
  assertAttachmentSyncNotAborted(signal);
  const material = options.material ?? null;
  let lastRequestAt = 0;
  let blockedUntil = 0;
  const waitForSlot = async (): Promise<void> => {
    assertAttachmentSyncNotAborted(signal);
    const now = Date.now();
    if (blockedUntil && now < blockedUntil) {
      throw new Error(`WebDAV rate limited for ${blockedUntil - now}ms`);
    }
    const elapsed = now - lastRequestAt;
    if (elapsed < WEBDAV_ATTACHMENT_MIN_INTERVAL_MS) {
      await waitForAttachmentSyncDelay(WEBDAV_ATTACHMENT_MIN_INTERVAL_MS - elapsed, signal);
    }
    assertAttachmentSyncNotAborted(signal);
    lastRequestAt = Date.now();
  };
  const handleRateLimit = (error: unknown): boolean => {
    if (!isWebdavRateLimitedError(error)) return false;
    blockedUntil = Date.now() + WEBDAV_ATTACHMENT_COOLDOWN_MS;
    logAttachmentWarn('WebDAV rate limited; pausing attachment sync', error);
    return true;
  };

  const attachmentsDirUrl = `${baseSyncUrl}/${ATTACHMENTS_DIR_NAME}`;
  // Stays unconditional and outside the try below: it makes no request, and a refused
  // connection is not a "directory already exists" failure to shrug off — swallowing it
  // let the whole insecure pass continue (SEC-10a).
  assertMobileWebdavConnection(attachmentsDirUrl, webDavConfig.allowInsecureHttp);
  // Only a PUT needs the collection to exist; HEAD and GET do not. This used to run on
  // every pass, which cost one MKCOL per idle cycle for anyone with a synced attachment
  // (audit F3), so it is now deferred to just before the first upload of a pass.
  let attachmentsDirEnsured = false;
  const ensureRemoteAttachmentsDir = async (): Promise<void> => {
    if (attachmentsDirEnsured) return;
    try {
      await options.assertRemoteMutationFenceHeld?.(35_000);
      await webdavMakeDirectory(attachmentsDirUrl, {
        ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
        username: webDavConfig.username,
        password: webDavConfig.password,
        signal,
      });
    } catch (error) {
      if (isAttachmentSyncAbortError(error, signal)) throw error;
      if (isSyncRemoteMutationFenceError(error)) throw error;
      logAttachmentWarn('Failed to ensure WebDAV attachments directory', error);
    }
    // Set only once the call did not throw a fatal error, so a fence loss that aborts
    // this upload does not silently skip the MKCOL for a later retry.
    attachmentsDirEnsured = true;
  };

  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return false;
  const attachmentsById = collectAttachments(appData);

  pruneWebdavDownloadBackoff();
  // See `isAttachmentPresenceReconciliationDue`: an uploaded attachment's key is derived
  // from its id and its bytes never change, so the presence pass below can only ever
  // discover a server-side deletion — worth proving daily, not hourly (audit F3). An
  // activation probe is different: it has to prove the candidate backend holds every object
  // right now, so it always reconciles and never writes the stamp (the stamp names the
  // committed configuration, not the candidate one).
  const reconcilePresence = options.activationProbe || await isAttachmentPresenceReconciliationDue();
  logAttachmentInfo('WebDAV attachment sync start', {
    count: String(attachmentsById.size),
    presence: reconcilePresence ? 'reconcile' : 'skipped',
  });

  // Every pass writes only to per-attachment copies and records them here; the patches are
  // folded into a fresh document at the end. `attachmentsById` is updated alongside so a
  // later pass reads the earlier pass's values.
  const allPatches = await migrateAttachmentsLocallyBeforeSync(attachmentsById, signal);

  let abortedByRateLimit = false;

  // WebDAV alone verifies that an already-uploaded attachment's remote copy is still there — if
  // it was deleted directly on the server, clear cloudKey so the lifecycle below re-uploads it.
  // This runs as its own pass before the lifecycle: it's an async, network-calling,
  // state-mutating check, which doesn't fit the lifecycle's synchronous `hasCloudCopy` predicate
  // (mirrors desktop's shape in apps/desktop/src/lib/sync-attachment-backends.ts).
  // ...but only when `reconcilePresence` above says the proof is due.
  for (const attachment of attachmentsById.values()) {
    if (!reconcilePresence || abortedByRateLimit) break;
    assertAttachmentSyncNotAborted(signal);
    if (attachment.kind !== 'file' || attachment.deletedAt) continue;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocalPath = Boolean(uri) && !isHttp;
    const localPresence = hasLocalPath
      ? await getLocalAttachmentPresence(uri)
      : 'confirmed-not-found';
    if (localPresence === 'unreadable') {
      attachmentsById.delete(attachment.id);
      continue;
    }
    const existsLocally = localPresence === 'present';
    logAttachmentInfo('WebDAV attachment check', {
      id: attachment.id,
      uri: describeAttachmentUriForLog(uri),
      cloud: attachment.cloudKey ? 'set' : 'missing',
      local: hasLocalPath ? 'true' : 'false',
      exists: existsLocally ? 'true' : 'false',
    });

    if (existsLocally) {
      clearWebdavDownloadBackoff(attachment.id);
    }

    if (
      attachment.cloudKey
      && attachment.pendingContentUpload !== true
      && hasLocalPath
      && existsLocally
      && !isHttp
    ) {
      try {
        const remoteExists = await withRetry(async () => {
          await waitForSlot();
          return await webdavFileExists(`${baseSyncUrl}/${attachment.cloudKey}`, {
            ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
            username: webDavConfig.username,
            password: webDavConfig.password,
            signal,
          });
        }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
        logAttachmentInfo('WebDAV attachment remote exists', {
          id: attachment.id,
          exists: remoteExists ? 'true' : 'false',
        });
        if (!remoteExists) {
          const patched: Attachment = { ...attachment, cloudKey: undefined };
          allPatches.set(patched.id, patched);
          attachmentsById.set(patched.id, patched);
          clearWebdavDownloadBackoff(attachment.id);
        }
      } catch (error) {
        if (isAttachmentSyncAbortError(error, signal)) throw error;
        if (handleRateLimit(error)) {
          abortedByRateLimit = true;
          break;
        }
        logAttachmentWarn('WebDAV attachment remote check failed', error);
      }
    }
  }

  if (reconcilePresence && !abortedByRateLimit && !options.activationProbe) {
    await markAttachmentPresenceReconciled();
  }

  // Throttle policy: per-run upload/download caps, plus the same rate-limit abort the pre-pass
  // above already tripped. Passed to the shared lifecycle as optional `policy` hooks.
  let uploadCount = 0;
  let uploadLimitLogged = false;
  let downloadCount = 0;
  let downloadLimitLogged = false;

  const shouldUpload = (): boolean => {
    if (uploadCount >= WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
      if (!uploadLimitLogged) {
        logAttachmentInfo('WebDAV attachment upload limit reached', {
          limit: String(WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
        });
        uploadLimitLogged = true;
      }
      return false;
    }
    uploadCount += 1;
    return true;
  };

  const shouldDownload = (attachment: Attachment): boolean => {
    if (getWebdavDownloadBackoff(attachment.id)) return false;
    if (downloadCount >= WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
      if (!downloadLimitLogged) {
        logAttachmentInfo('WebDAV attachment download limit reached', {
          limit: String(WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
        });
        downloadLimitLogged = true;
      }
      return false;
    }
    downloadCount += 1;
    return true;
  };

  const { patches } = await runMobileAttachmentLifecycle({
    attachmentsById,
    getLocalFilePresence: getLocalAttachmentPresence,
    deferUploads: options.phase === 'prepare',
    getLocalFileStat: (path) => statAttachmentFile(path),
    computeLocalFileHash: (path) => computeAttachmentFileHash(path),
    contentChangePhase: options.phase,
    isFatalError: (error) => (
      isAttachmentSyncAbortError(error, signal)
      || isSyncRemoteMutationFenceError(error)
      || isWebdavRemoteWriteConflictError(error)
    ),
    policy: options.activationProbe
      ? undefined
      : {
          shouldSkip: () => abortedByRateLimit,
          shouldUpload,
          shouldDownload,
        },
    onUpload: async (attachment, localPath) => {
      try {
        await ensureRemoteAttachmentsDir();
        let size = await getAttachmentByteSize(attachment, localPath);
        let fileData: Uint8Array | null = null;
        if (!Number.isFinite(size ?? NaN)) {
          const readResult = await readAttachmentBytesForUpload(localPath);
          if (readResult.readFailed) throw new LocalReadFailure(readResult.error);
          fileData = readResult.data;
          size = fileData.byteLength;
        }
        const validation = await validateAttachmentForUpload(attachment, size);
        if (!validation.valid) {
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
          return false;
        }
        const cloudKey = buildCloudKey(attachment);
        const startedAt = Date.now();
        const uploadBytes = Math.max(0, Number(size ?? 0));
        reportProgress(attachment.id, 'upload', 0, uploadBytes, 'active');
        const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
        const remoteVersion = await withRetry(async () => {
          await waitForSlot();
          return webdavHeadFile(uploadUrl, {
            ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
            username: webDavConfig.username,
            password: webDavConfig.password,
            signal,
          });
        }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
        const expectedEtag = remoteVersion.exists
          ? normalizeStrongWebdavEtag(remoteVersion.etag)
          : null;
        if (remoteVersion.exists && !expectedEtag) {
          throw new Error('WebDAV attachment version is unavailable; refusing an unconditional overwrite');
        }
        logAttachmentInfo('WebDAV attachment upload start', {
          id: attachment.id,
          bytes: String(uploadBytes),
          cloudKey,
        });
        // The FileSystem uploader streams the LOCAL file straight to the server, so it
        // can only ever send plaintext. With encryption on we must go through the
        // read-seal-PUT path below instead.
        const uploadedWithFileSystem = material ? false : await withRetry(
          async () => {
            await waitForSlot();
            await options.assertRemoteMutationFenceHeld?.(35_000);
            return await uploadWebdavFileWithFileSystem(
              uploadUrl,
              localPath,
              attachment.mimeType || DEFAULT_CONTENT_TYPE,
              webDavConfig.username,
              webDavConfig.password,
              webDavConfig.allowInsecureHttp,
              (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
              uploadBytes,
              signal,
              expectedEtag,
            );
          },
          {
            ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
            onRetry: (error, attempt, delayMs) => {
              logAttachmentInfo('Retrying WebDAV attachment upload', {
                id: attachment.id,
                attempt: String(attempt + 1),
                delayMs: String(delayMs),
                error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
              });
            },
          }
        );
        if (!uploadedWithFileSystem) {
          let uploadData = fileData;
          if (!uploadData) {
            const readResult = await readAttachmentBytesForUpload(localPath);
            if (readResult.readFailed) throw new LocalReadFailure(readResult.error);
            uploadData = readResult.data;
          }
          const buffer = toArrayBuffer(await sealAttachmentBytesForUpload(uploadData, material));
          await withRetry(
            async () => {
              await waitForSlot();
              await options.assertRemoteMutationFenceHeld?.(35_000);
              return await webdavPutFileVersioned(uploadUrl, buffer, attachment.mimeType || DEFAULT_CONTENT_TYPE, expectedEtag, {
                ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
                username: webDavConfig.username,
                password: webDavConfig.password,
                signal,
              });
            },
            {
              ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
              onRetry: (error, attempt, delayMs) => {
                logAttachmentInfo('Retrying WebDAV attachment upload', {
                  id: attachment.id,
                  attempt: String(attempt + 1),
                  delayMs: String(delayMs),
                  error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
                });
              },
            }
          );
        }
        attachment.cloudKey = cloudKey;
        if (!Number.isFinite(attachment.size ?? NaN) && Number.isFinite(size ?? NaN)) {
          attachment.size = Number(size);
        }
        // localStatus is already 'available' here: onUpload only runs when the lifecycle's own
        // existsLocally check just passed, which is what set it.
        reportProgress(attachment.id, 'upload', uploadBytes, uploadBytes, 'completed');
        logAttachmentInfo('Attachment uploaded', {
          id: attachment.id,
          bytes: String(uploadBytes),
          ms: String(Date.now() - startedAt),
        });
        return true;
      } catch (error) {
        if (isAttachmentSyncAbortError(error, signal)) throw error;
        if (isSyncRemoteMutationFenceError(error) || isWebdavRemoteWriteConflictError(error)) throw error;
        if (handleRateLimit(error)) {
          abortedByRateLimit = true;
          return false;
        }
        if (error instanceof LocalReadFailure) {
          const mutated = markAttachmentUnrecoverable(attachment);
          logAttachmentWarn(
            `Attachment local file is unreadable; marking unrecoverable (${attachment.id})`,
            error.cause
          );
          return mutated;
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
        return false;
      }
    },
    onUploadError: () => {
      // Every recoverable case (rate limit, unreadable local file, generic failure) is already
      // handled inside onUpload's own catch above and reports its mutation via the return value,
      // so `didMutate` stays accurate. Fatal (abort) errors are rethrown there and never reach
      // here. This only exists because the shared lifecycle's contract requires the callback.
    },
    onDownload: async (attachment, expectation) => {
      if (!attachment.cloudKey) return false;
      const cloudKey = attachment.cloudKey;
      let fileData: ArrayBuffer;
      try {
        fileData = await withRetry(async () => {
          await waitForSlot();
          return await webdavGetFile(`${baseSyncUrl}/${cloudKey}`, {
            ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
            username: webDavConfig.username,
            password: webDavConfig.password,
            signal,
            onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
          });
        }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
      } catch (error) {
        if (isAttachmentSyncAbortError(error, signal)) throw error;
        if (handleRateLimit(error)) {
          abortedByRateLimit = true;
          return false;
        }
        const status = getErrorStatus(error);
        if (status === 404) {
          clearWebdavDownloadBackoff(attachment.id);
          const mutated = markAttachmentUnrecoverable(attachment);
          logAttachmentInfo('Cleared missing WebDAV cloud key after 404', { id: attachment.id });
          return mutated;
        }
        throw error;
      }
      // Decrypt BEFORE hashing and before writing: `fileHash` is plaintext-domain (it
      // lives in the synced document and must stay stable across re-encryptions), and
      // local attachment files are always stored plaintext.
      const bytes = await openAttachmentBytesFromDownload(
        fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer),
        material,
      );
      await validateAttachmentHash(attachment, bytes);
      const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
      const targetUri = resolveAttachmentDownloadTargetPath(
        attachment,
        `${attachmentsDir}${filename}`,
        expectation,
      );
      const installed = await installAttachmentDownloadBytes(
        attachment,
        attachmentsDir,
        targetUri,
        bytes,
        expectation,
        signal,
      );
      if (!installed) return false;
      attachment.uri = targetUri;
      const statusChanged = attachment.localStatus !== 'available';
      if (statusChanged) {
        attachment.localStatus = 'available';
      }
      clearWebdavDownloadBackoff(attachment.id);
      reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      return statusChanged;
    },
    onDownloadError: (attachment, error) => {
      // Rate-limit and 404 are handled inside onDownload's own try/catch above, since only
      // onDownload's return value can signal a mutation back to the lifecycle. Only "other"
      // (retry-exhausted / hash-validation / write) errors reach here.
      setWebdavDownloadBackoff(attachment.id, error);
      reportProgress(
        attachment.id,
        'download',
        0,
        attachment.size ?? 0,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logAttachmentWarn(`Failed to download attachment ${attachment.id}`, error);
    },
  });

  for (const patch of patches.values()) allPatches.set(patch.id, patch);
  const nextData = applyAttachmentPatches(appData, allPatches);
  const didMutate = nextData !== appData;

  if (abortedByRateLimit) {
    logAttachmentWarn('WebDAV attachment sync aborted due to rate limiting');
  }
  logAttachmentInfo('WebDAV attachment sync done', {
    mutated: didMutate ? 'true' : 'false',
  });
  return didMutate ? nextData : false;
};
