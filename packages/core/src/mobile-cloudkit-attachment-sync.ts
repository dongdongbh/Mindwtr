import type { AppData, Attachment, AttachmentSettings } from './types';
import { applyAttachmentPatches, collectAttachmentsById as collectAttachments, reportProgress, withAttachmentSettingsPatch } from './attachment-transfer';
import { buildCloudKitAttachmentKey, parseCloudKitAttachmentKey } from './cloudkit-attachments';
import { markAttachmentUnrecoverable, validateAttachmentForUpload } from './attachment-validation';
import { extractExtension } from './attachment-paths';
import { isContentAttachmentUri, type MobileAttachmentFiles } from './mobile-attachment-files';
import { assertAttachmentSyncNotAborted, isAttachmentSyncAbortError, resolveAttachmentDownloadTargetPath,
    type MobileAttachmentCommon } from './mobile-attachment-common';
import type { MobileAttachmentCloudKitPort } from './mobile-attachment-availability';

export type MobileCloudKitAttachmentMetadata = Pick<Attachment,
    'title' | 'mimeType' | 'size' | 'fileHash' | 'updatedAt' | 'deletedAt'> & {
    attachmentId: Attachment['id'];
    ownerType: 'task' | 'project';
    ownerId: string;
};

export type MobileCloudKitAttachmentAssetPort = Omit<MobileAttachmentCloudKitPort, 'fetchAttachmentAsset'> & {
    saveAttachmentAsset(recordName: string, filePath: string, metadata: MobileCloudKitAttachmentMetadata,
        options?: { signal?: AbortSignal }): Promise<unknown>;
    fetchAttachmentAsset(recordName: string, stagedUri: string,
        options?: { signal?: AbortSignal }): Promise<MobileCloudKitAttachmentMetadata>;
    deleteAttachmentAssets(recordNames: string[], options?: { signal?: AbortSignal }): Promise<void>;
};

export type MobileCloudKitAttachmentSyncHost = {
    files: Pick<MobileAttachmentFiles, 'getAttachmentByteSize' | 'getAttachmentsDir' | 'getLocalAttachmentPresence'
        | 'computeAttachmentFileHash' | 'statAttachmentFile' | 'logAttachmentWarn' | 'markAttachmentPresenceReconciled'
        | 'readAttachmentBytesForUpload' | 'readFileAsBytes' | 'writeBytesSafely'
        | 'getWebdavDownloadBackoff' | 'setWebdavDownloadBackoff' | 'clearWebdavDownloadBackoff'>;
    common: Pick<MobileAttachmentCommon, 'createAttachmentDownloadStagePath' | 'deleteAttachmentDownloadStageBestEffort'
        | 'installStagedAttachmentDownload' | 'migrateAttachmentsLocallyBeforeSync' | 'runMobileAttachmentLifecycle'>;
    cloudKit: MobileCloudKitAttachmentAssetPort;
};

/** The existing RN CloudKit lifecycle, bound to shared file/install policy and a native asset transport. */
export const createMobileCloudKitAttachmentSync = ({ files, common, cloudKit }: MobileCloudKitAttachmentSyncHost) => {
    const { computeAttachmentFileHash, getLocalAttachmentPresence, getAttachmentByteSize, getAttachmentsDir,
        logAttachmentWarn, markAttachmentPresenceReconciled, readAttachmentBytesForUpload, readFileAsBytes,
        statAttachmentFile, writeBytesSafely, getWebdavDownloadBackoff, setWebdavDownloadBackoff, clearWebdavDownloadBackoff } = files;
    const { createAttachmentDownloadStagePath, deleteAttachmentDownloadStageBestEffort, installStagedAttachmentDownload,
        migrateAttachmentsLocallyBeforeSync, runMobileAttachmentLifecycle } = common;
    const { deleteAttachmentAssets: deleteCloudKitAttachmentAssets, fetchAttachmentAsset: fetchCloudKitAttachmentAsset,
        isAttachmentNotFoundError: isCloudKitAttachmentNotFoundError, saveAttachmentAsset: saveCloudKitAttachmentAsset } = cloudKit;

    /** Which task/project an attachment id belongs to — CloudKit's upload metadata needs the
     *  owner, which the shared lifecycle's per-attachment callbacks don't carry. Deliberately
     *  holds no attachment reference: the attachment values come from the lifecycle's own
     *  working copy, so metadata can never describe a stale pre-patch object. */
    type AttachmentOwner = {
        ownerType: 'task' | 'project';
        ownerId: string;
    };

    const collectAttachmentOwners = (appData: AppData): Map<string, AttachmentOwner> => {
        const owners = new Map<string, AttachmentOwner>();
        for (const task of appData.tasks) {
            if (task.deletedAt) continue;
            for (const attachment of task.attachments ?? []) {
                owners.set(attachment.id, { ownerType: 'task', ownerId: task.id });
            }
        }
        for (const project of appData.projects) {
            if (project.deletedAt) continue;
            for (const attachment of project.attachments ?? []) {
                owners.set(attachment.id, { ownerType: 'project', ownerId: project.id });
            }
        }
        return owners;
    };

    const buildTargetUri = (attachmentsDir: string, attachment: Attachment): string => {
        const ext = extractExtension(attachment.title) || extractExtension(attachment.uri);
        return `${attachmentsDir}${attachment.id}${ext}`;
    };

    // Handles a content:// uri that reached upload despite the general migration pre-pass — e.g. one
    // capped by createAttachmentLocalMigrationLimiter in a PRIOR sync round whose cap has since
    // reset. Preserved verbatim from before this file adopted the shared lifecycle.
    const ensureCloudKitAssetFile = async (
        attachment: Attachment,
        uri: string,
        attachmentsDir: string,
        signal?: AbortSignal,
    ): Promise<{ uri: string; size: number | null; mutated: boolean }> => {
        if (!isContentAttachmentUri(uri)) {
            return {
                uri,
                size: await getAttachmentByteSize(attachment, uri),
                mutated: false,
            };
        }

        assertAttachmentSyncNotAborted(signal);
        const result = await readAttachmentBytesForUpload(uri);
        if (result.readFailed) throw result.error;

        const targetUri = buildTargetUri(attachmentsDir, attachment);
        await writeBytesSafely(targetUri, result.data);
        attachment.uri = targetUri;
        attachment.size = result.data.byteLength;
        attachment.localStatus = 'available';
        return { uri: targetUri, size: result.data.byteLength, mutated: true };
    };

    const buildMetadata = (
        attachment: Attachment,
        owned: AttachmentOwner,
        fileSize: number | null,
    ): MobileCloudKitAttachmentMetadata => ({
        attachmentId: attachment.id,
        ownerType: owned.ownerType,
        ownerId: owned.ownerId,
        title: attachment.title,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(Number.isFinite(fileSize ?? NaN) ? { size: fileSize as number } : {}),
        ...(attachment.fileHash ? { fileHash: attachment.fileHash } : {}),
        updatedAt: attachment.updatedAt,
        ...(attachment.deletedAt ? { deletedAt: attachment.deletedAt } : {}),
    });

    const applyFetchedMetadata = (attachment: Attachment, metadata: MobileCloudKitAttachmentMetadata): void => {
        // The merged sync document owns descriptive metadata. CloudKit asset metadata
        // can lag behind title-only or MIME-only document edits because those edits do
        // not upload a new byte generation. Only the byte-derived size is authoritative
        // after fetching the asset; the installer has already recorded its exact hash.
        if (Number.isFinite(metadata.size ?? NaN)) attachment.size = metadata.size;
    };

    /** The next `settings.attachments` value once the flushed keys are dropped, or `undefined`
     *  when there was nothing to flush. Never writes to the input settings. */
    const flushPendingCloudKitDeletes = async (
        appData: AppData,
        signal?: AbortSignal,
    ): Promise<AttachmentSettings | undefined> => {
        const pendingDeletes = appData.settings.attachments?.pendingRemoteDeletes ?? [];
        const recordNames: string[] = [];
        const remaining = [];

        for (const pending of pendingDeletes) {
            const recordName = parseCloudKitAttachmentKey(pending.cloudKey);
            if (recordName) recordNames.push(recordName);
            else remaining.push(pending);
        }

        if (recordNames.length === 0) return undefined;
        assertAttachmentSyncNotAborted(signal);
        await deleteCloudKitAttachmentAssets(recordNames, { signal });

        return {
            ...(appData.settings.attachments ?? {}),
            pendingRemoteDeletes: remaining.length > 0 ? remaining : undefined,
        };
    };

    const syncCloudKitAttachments = async (
        appData: AppData,
        signal?: AbortSignal,
        options: { activationProbe?: boolean; phase?: 'prepare' | 'post-merge' } = {},
    ): Promise<AppData | false> => {
        assertAttachmentSyncNotAborted(signal);
        const attachmentsDir = await getAttachmentsDir();
        if (!attachmentsDir) return false;

        const settingsPatch = await flushPendingCloudKitDeletes(appData, signal);
        /** Fold both channels (attachment patches + settings) into one fresh document. */
        const fold = (patches: Map<string, Attachment>): AppData | false => {
            const next = withAttachmentSettingsPatch(applyAttachmentPatches(appData, patches), settingsPatch);
            return next !== appData ? next : false;
        };

        const attachmentsById = collectAttachments(appData);
        if (attachmentsById.size === 0) return fold(new Map());
        const allPatches = await migrateAttachmentsLocallyBeforeSync(attachmentsById, signal);
        const ownerByAttachmentId = collectAttachmentOwners(appData);
        if (!options.activationProbe) {
            for (const attachment of attachmentsById.values()) {
                if (attachment.kind !== 'file' || attachment.deletedAt || !attachment.uri || !getWebdavDownloadBackoff(attachment.id)) continue;
                if (!attachment.fileHash) continue;
                const presence = await getLocalAttachmentPresence(attachment.uri);
                assertAttachmentSyncNotAborted(signal);
                if (presence !== 'present') continue;
                const localHash = await computeAttachmentFileHash(attachment.uri);
                assertAttachmentSyncNotAborted(signal);
                if (localHash === attachment.fileHash.trim().toLowerCase()) clearWebdavDownloadBackoff(attachment.id);
            }
        }

        const { patches } = await runMobileAttachmentLifecycle({
            attachmentsById,
            getLocalFilePresence: getLocalAttachmentPresence,
            deferUploads: options.phase === 'prepare',
            allowPendingRemoteRecovery: false,
            policy: { shouldDownload: (attachment) => options.activationProbe === true || !getWebdavDownloadBackoff(attachment.id) },
            getLocalFileStat: (path) => statAttachmentFile(path),
            computeLocalFileHash: (path) => computeAttachmentFileHash(path),
            contentChangePhase: options.phase,
            isFatalError: (error) => isAttachmentSyncAbortError(error, signal),
            // A cloudKey written by a different backend before a provider switch isn't a valid
            // CloudKit record key, so CloudKit must still treat the attachment as needing upload.
            hasCloudCopy: (attachment) => Boolean(parseCloudKitAttachmentKey(attachment.cloudKey)),
            onUpload: async (attachment, localPath, snapshot) => {
                const owned = ownerByAttachmentId.get(attachment.id);
                if (!owned) return false;
                // A local content:// → managed-file migration must survive an upload
                // failure (the bytes ARE in the managed dir), so its mutated flag is
                // reported from the catch too — mirroring the validation-failure
                // branch below.
                let migrated = false;
                try {
                    const assetFile = await ensureCloudKitAssetFile(attachment, localPath, attachmentsDir, signal);
                    migrated = assetFile.mutated;
                    const validation = await validateAttachmentForUpload(attachment, assetFile.size ?? attachment.size);
                    if (!validation.valid) {
                        reportProgress(attachment.id, 'upload', 0, attachment.size ?? 0, 'failed', validation.error);
                        logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
                        return assetFile.mutated;
                    }

                    const totalBytes = Math.max(0, Number(assetFile.size ?? attachment.size ?? 0));
                    reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');
                    await saveCloudKitAttachmentAsset(
                        attachment.id,
                        assetFile.uri,
                        buildMetadata(
                            { ...attachment, fileHash: snapshot?.fileHash ?? attachment.fileHash },
                            owned,
                            assetFile.size,
                        ),
                        { signal },
                    );
                    attachment.cloudKey = buildCloudKitAttachmentKey(attachment.id);
                    // localStatus is already 'available' here: onUpload only runs when the
                    // lifecycle's own existsLocally check just passed, which is what set it.
                    if (Number.isFinite(assetFile.size ?? NaN)) attachment.size = assetFile.size ?? undefined;
                    reportProgress(attachment.id, 'upload', totalBytes, totalBytes, 'completed');
                    return true;
                } catch (error) {
                    if (isAttachmentSyncAbortError(error, signal)) throw error;
                    reportProgress(
                        attachment.id,
                        'upload',
                        0,
                        attachment.size ?? 0,
                        'failed',
                        error instanceof Error ? error.message : String(error),
                    );
                    logAttachmentWarn(`Failed to upload CloudKit attachment ${attachment.id}`, error);
                    return migrated;
                }
            },
            onUploadError: () => {
                // onUpload's own catch above handles everything except the fatal (abort) case,
                // which it rethrows — that never reaches here. Required by the lifecycle's contract.
            },
            onDownload: async (attachment, expectation) => {
                const recordName = parseCloudKitAttachmentKey(attachment.cloudKey);
                if (!recordName) return false;
                let stagedUri: string | null = null;
                let installerOwnsStage = false;
                try {
                    const targetUri = resolveAttachmentDownloadTargetPath(
                        attachment,
                        buildTargetUri(attachmentsDir, attachment),
                        expectation,
                    );
                    stagedUri = createAttachmentDownloadStagePath(attachmentsDir, attachment);
                    reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
                    const metadata = await fetchCloudKitAttachmentAsset(recordName, stagedUri, { signal });
                    // From this point the helper owns cleanup: it removes the stage
                    // only before native installation begins and preserves it after.
                    installerOwnsStage = true;
                    const installed = await installStagedAttachmentDownload({
                        attachment,
                        stagedPath: stagedUri,
                        targetPath: targetUri,
                        expectation,
                        signal,
                    });
                    if (!installed) return false;
                    const bytes = await readFileAsBytes(targetUri);
                    attachment.uri = targetUri;
                    attachment.localStatus = 'available';
                    if (!options.activationProbe) clearWebdavDownloadBackoff(attachment.id);
                    applyFetchedMetadata(attachment, metadata);
                    reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
                    return true;
                } catch (error) {
                    if (stagedUri && !installerOwnsStage) {
                        await deleteAttachmentDownloadStageBestEffort(stagedUri);
                    }
                    if (isAttachmentSyncAbortError(error, signal)) throw error;
                    if (isCloudKitAttachmentNotFoundError(error)) {
                        reportProgress(
                            attachment.id,
                            'download',
                            0,
                            attachment.size ?? 0,
                            'failed',
                            'Attachment is no longer available',
                        );
                        if (options.activationProbe) return markAttachmentUnrecoverable(attachment);
                        setWebdavDownloadBackoff(attachment.id, { status: 404 });
                        logAttachmentWarn(`CloudKit attachment ${attachment.id} not found; row kept`, error, {
                            releaseCheck: 'v1.3.8/attachment-not-found-kept',
                        });
                        return false;
                    }
                    reportProgress(
                        attachment.id,
                        'download',
                        0,
                        attachment.size ?? 0,
                        'failed',
                        error instanceof Error ? error.message : String(error),
                    );
                    logAttachmentWarn(`Failed to download CloudKit attachment ${attachment.id}`, error);
                    return false;
                }
            },
            onDownloadError: () => {},
        });

        for (const patch of patches.values()) allPatches.set(patch.id, patch);
        // A completed pass is this backend's whole reconciliation: it refreshed every
        // attachment's local presence and settled every transfer. Stamping it lets
        // `hasPendingAttachmentSyncWork` keep the steady state quiet until the next one is due
        // (audit F3). Never stamped for an activation probe, whose subject is the candidate
        // configuration rather than the committed one the stamp names.
        if (!options.activationProbe) await markAttachmentPresenceReconciled();
        return fold(allPatches);
    };

    return syncCloudKitAttachments;
};
