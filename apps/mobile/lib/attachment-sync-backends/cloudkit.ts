import type { AppData, Attachment, AttachmentSettings } from '@mindwtr/core';
import {
    applyAttachmentPatches,
    buildCloudKitAttachmentKey,
    handleRemoteAttachmentNotFound,
    parseCloudKitAttachmentKey,
    validateAttachmentForUpload,
    withAttachmentSettingsPatch,
} from '@mindwtr/core';
import {
    deleteCloudKitAttachmentAssets,
    fetchCloudKitAttachmentAsset,
    isCloudKitAttachmentNotFoundError,
    saveCloudKitAttachmentAsset,
    type CloudKitAttachmentMetadata,
} from '../cloudkit-sync';
import {
    collectAttachments,
    computeAttachmentFileHash,
    extractExtension,
    getLocalAttachmentPresence,
    getAttachmentByteSize,
    getAttachmentsDir,
    getWebdavDownloadBackoff,
    isContentAttachmentUri,
    logAttachmentWarn,
    markAttachmentPresenceReconciled,
    readAttachmentBytesForUpload,
    readFileAsBytes,
    reportProgress,
    setWebdavDownloadBackoff,
    statAttachmentFile,
    writeBytesSafely,
} from '../attachment-sync-utils';
import {
    assertAttachmentSyncNotAborted,
    createAttachmentDownloadStagePath,
    deleteAttachmentDownloadStageBestEffort,
    installStagedAttachmentDownload,
    isAttachmentSyncAbortError,
    migrateAttachmentsLocallyBeforeSync,
    resolveAttachmentDownloadTargetPath,
    runMobileAttachmentLifecycle,
} from './common';


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
): CloudKitAttachmentMetadata => ({
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

const applyFetchedMetadata = (attachment: Attachment, metadata: CloudKitAttachmentMetadata): void => {


    if (Number.isFinite(metadata.size ?? NaN)) attachment.size = metadata.size;
};


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

export const syncCloudKitAttachments = async (
    appData: AppData,
    signal?: AbortSignal,
    options: { activationProbe?: boolean; phase?: 'prepare' | 'post-merge' } = {},
): Promise<AppData | false> => {
    assertAttachmentSyncNotAborted(signal);
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return false;

    const settingsPatch = await flushPendingCloudKitDeletes(appData, signal);

    const fold = (patches: Map<string, Attachment>): AppData | false => {
        const next = withAttachmentSettingsPatch(applyAttachmentPatches(appData, patches), settingsPatch);
        return next !== appData ? next : false;
    };

    const attachmentsById = collectAttachments(appData);
    if (attachmentsById.size === 0) return fold(new Map());
    const allPatches = await migrateAttachmentsLocallyBeforeSync(attachmentsById, signal);
    const ownerByAttachmentId = collectAttachmentOwners(appData);

    const { patches } = await runMobileAttachmentLifecycle({
        attachmentsById,
        getLocalFilePresence: getLocalAttachmentPresence,
        deferUploads: options.phase === 'prepare',
        allowPendingRemoteRecovery: false,
        getLocalFileStat: (path) => statAttachmentFile(path),
        computeLocalFileHash: (path) => computeAttachmentFileHash(path),
        contentChangePhase: options.phase,
        isFatalError: (error) => isAttachmentSyncAbortError(error, signal),


        hasCloudCopy: (attachment) => Boolean(parseCloudKitAttachmentKey(attachment.cloudKey)),

        policy: { shouldDownload: (attachment) => options.activationProbe === true || !getWebdavDownloadBackoff(attachment.id) },
        onUpload: async (attachment, localPath, snapshot) => {
            const owned = ownerByAttachmentId.get(attachment.id);
            if (!owned) return false;


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
                    logAttachmentWarn(`CloudKit attachment ${attachment.id} is no longer available`, error);

                    if (options.activationProbe !== true) setWebdavDownloadBackoff(attachment.id, { status: 404 });
                    return handleRemoteAttachmentNotFound(attachment, options.activationProbe === true);
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


    if (!options.activationProbe) await markAttachmentPresenceReconciled();
    return fold(allPatches);
};
