import {
    applyAttachmentContentStat,
    bumpAttachmentContentRevision,
    checkAttachmentContentChange,
    isStaleCopyOfRemoteWinner,
    logUninstalledRemoteWinner,
    type LocalFileStat,
} from './attachment-change-detection';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { globalProgressTracker } from './attachment-progress';
import { MAX_DOWNLOAD_BYTES } from './http-utils';
import type { AppData, Attachment, AttachmentSettings } from './types';

type PendingRemoteAttachmentDeleteEntry = NonNullable<AttachmentSettings['pendingRemoteDeletes']>[number];

export const normalizePendingRemoteDeletes = (
    value: unknown,
): PendingRemoteAttachmentDeleteEntry[] => {
    if (!Array.isArray(value)) return [];
    const deduped = new Map<string, PendingRemoteAttachmentDeleteEntry>();
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const cloudKey = typeof item.cloudKey === 'string' ? item.cloudKey.trim() : '';
        if (!cloudKey) continue;
        const next: PendingRemoteAttachmentDeleteEntry = {
            cloudKey,
            title: typeof item.title === 'string' ? item.title : undefined,
            attempts: typeof item.attempts === 'number' && Number.isFinite(item.attempts)
                ? Math.max(0, Math.floor(item.attempts))
                : 0,
            lastErrorAt: typeof item.lastErrorAt === 'string' ? item.lastErrorAt : undefined,
        };
        const existing = deduped.get(cloudKey);
        if (!existing || (next.attempts ?? 0) >= (existing.attempts ?? 0)) {
            deduped.set(cloudKey, next);
        }
    }
    return Array.from(deduped.values());
};


export const validateAttachmentHash = async (attachment: Attachment, bytes: Uint8Array): Promise<void> => {
    const expected = attachment.fileHash;
    if (!isSha256Hex(expected)) return;
    const computed = await computeSha256Hex(bytes);
    if (!computed) {
        throw new Error('Integrity validation unavailable: no SHA-256 implementation');
    }
    if (computed.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('Integrity validation failed');
    }
};


const unhashableStats = new Map<string, string>();

const statMarker = (stat: LocalFileStat): string => `${stat.mtimeMs}:${stat.size}`;


const FILE_SYNC_ENCRYPTED_ARTIFACT_OVERHEAD_BYTES = 70;

export const MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES =
    MAX_DOWNLOAD_BYTES - FILE_SYNC_ENCRYPTED_ARTIFACT_OVERHEAD_BYTES;

export class AttachmentUploadTooLargeError extends Error {
    readonly actualBytes: number;
    readonly limitBytes: number;

    constructor(actualBytes: number, limitBytes: number) {
        super(`Attachment exceeds the ${limitBytes} byte buffered upload limit`);
        this.name = 'AttachmentUploadTooLargeError';
        this.actualBytes = actualBytes;
        this.limitBytes = limitBytes;
    }
}

export class AttachmentUploadSizeUnavailableError extends Error {
    constructor() {
        super('Attachment size is unavailable for bounded buffered upload');
        this.name = 'AttachmentUploadSizeUnavailableError';
    }
}


export class WebdavHostUploadLimitError extends Error {
    constructor() {
        super('WebDAV attachment upload cannot be admitted by this host transport');
        this.name = 'WebdavHostUploadLimitError';
    }
}

export const isWebdavHostUploadLimitError = (error: unknown): error is WebdavHostUploadLimitError => (
    error instanceof WebdavHostUploadLimitError
);


export class CloudHostUploadLimitError extends Error {
    constructor() {
        super('Cloud attachment upload cannot be admitted by this host transport');
        this.name = 'CloudHostUploadLimitError';
    }
}

export const isCloudHostUploadLimitError = (error: unknown): error is CloudHostUploadLimitError => (
    error instanceof CloudHostUploadLimitError
);

export const isAttachmentUploadTooLargeError = (
    error: unknown,
): error is AttachmentUploadTooLargeError => error instanceof AttachmentUploadTooLargeError;

export const isAttachmentUploadAdmissionError = (
    error: unknown,
): error is AttachmentUploadTooLargeError | AttachmentUploadSizeUnavailableError => (
    error instanceof AttachmentUploadTooLargeError
    || error instanceof AttachmentUploadSizeUnavailableError
);

export const assertBufferedAttachmentUploadSize = (
    actualBytes: number,
    limitBytes: number,
): void => {
    if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
        throw new AttachmentUploadSizeUnavailableError();
    }
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
        throw new Error('Buffered attachment upload limit is invalid');
    }
    if (actualBytes > limitBytes) {
        throw new AttachmentUploadTooLargeError(actualBytes, limitBytes);
    }
};

export const resetUnhashableAttachmentStatsForTests = (): void => {
    unhashableStats.clear();
};

export const reportProgress = (
    attachmentId: string,
    operation: 'upload' | 'download',
    loaded: number,
    total: number,
    status: 'active' | 'completed' | 'failed',
    error?: string,
) => {
    const percentage = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    globalProgressTracker.updateProgress(attachmentId, {
        operation,
        bytesTransferred: loaded,
        totalBytes: total,
        percentage,
        status,
        error,
    });
};


export const collectAttachmentsById = (appData: AppData): Map<string, Attachment> => {
    const attachmentsById = new Map<string, Attachment>();
    for (const task of appData.tasks) {
        if (task.deletedAt) continue;
        for (const attachment of task.attachments || []) {
            attachmentsById.set(attachment.id, attachment);
        }
    }
    for (const project of appData.projects) {
        if (project.deletedAt) continue;
        for (const attachment of project.attachments || []) {
            attachmentsById.set(attachment.id, attachment);
        }
    }
    return attachmentsById;
};


export type AttachmentUploadSnapshot = {
    sourcePath: string;
    fileHash: string;
    stat: LocalFileStat;
    bytes?: Uint8Array;
    dispose: () => Promise<void>;
};


export type LocalAttachmentPresence = 'present' | 'confirmed-not-found' | 'unreadable';

export type AttachmentTransferDirection = 'upload' | 'download';


export type AttachmentTransferAdmission = {
    has(attachment: Attachment, direction: AttachmentTransferDirection): boolean;
    record(attachment: Attachment, direction: AttachmentTransferDirection): void;
};

const attachmentTransferKey = (attachment: Attachment, direction: AttachmentTransferDirection): string => {
    const hash = attachment.fileHash?.trim().toLowerCase();
    const content = isSha256Hex(hash) ? hash : `${attachment.cloudKey ?? ''}:${attachment.size ?? ''}`;
    return `${attachment.id}|${direction}|${content}`;
};

export const createAttachmentTransferAdmission = (
    onRepeat?: (attachment: Attachment, direction: AttachmentTransferDirection) => void,
): AttachmentTransferAdmission => {
    const started = new Set<string>();
    const repeated = new Set<string>();
    return {
        has: (attachment, direction) => {
            const key = attachmentTransferKey(attachment, direction);
            if (!started.has(key)) return false;

            if (!repeated.has(key)) {
                repeated.add(key);
                onRepeat?.(attachment, direction);
            }
            return true;
        },
        record: (attachment, direction) => { started.add(attachmentTransferKey(attachment, direction)); },
    };
};


export type AttachmentDownloadExpectation =
    | { kind: 'absent' }
    | { kind: 'present'; sha256: string };

export type AttachmentTransferLifecycleOptions = {
    attachmentsById: Map<string, Attachment>;
    getLocalFilePresence: (path: string, attachment: Attachment) => Promise<LocalAttachmentPresence>;
    onUpload: (
        attachment: Attachment,
        localPath: string,
        snapshot?: AttachmentUploadSnapshot,
    ) => Promise<boolean>;
    onUploadError: (attachment: Attachment, error: unknown) => void;
    onDownload: (
        attachment: Attachment,
        expectation: AttachmentDownloadExpectation,
    ) => Promise<boolean>;
    onDownloadError: (attachment: Attachment, error: unknown) => void;
    resolveLocalPath?: (uri: string) => string;


    canUploadFrom?: (localPath: string, attachment: Attachment) => boolean;
    beforeEachAttachment?: () => Promise<void>;


    hasCloudCopy?: (attachment: Attachment) => boolean;


    deferUploads?: boolean;


    allowPendingRemoteRecovery?: boolean;


    policy?: {


        shouldSkip?: (attachment: Attachment) => boolean;

        shouldUpload?: (attachment: Attachment) => boolean;


        shouldDownload?: (attachment: Attachment) => boolean;
    };

    admission?: AttachmentTransferAdmission;


    adoptExistingDownload?: (attachment: Attachment) => Promise<boolean>;


    isFatalError?: (error: unknown) => boolean;


    getLocalFileStat?: (path: string, attachment: Attachment) => Promise<LocalFileStat | null>;


    maxBufferedUploadBytes?: number;


    assertUploadStat?: (stat: LocalFileStat | null) => void;

    computeLocalFileHash?: (path: string, attachment: Attachment) => Promise<string | null>;


    createUploadSnapshot?: (
        path: string,
        attachment: Attachment,
    ) => Promise<AttachmentUploadSnapshot | null>;


    requireUploadSnapshot?: boolean;


    contentChangePhase?: 'prepare' | 'post-merge';


    onLocalEditRace?: (attachment: Attachment) => void;
};

export type AttachmentTransferResult = {

    changed: boolean;


    patches: Map<string, Attachment>;
};


export const applyAttachmentPatches = (
    appData: AppData,
    patches: Map<string, Attachment>,
): AppData => {
    if (patches.size === 0) return appData;
    let changed = false;
    const patchOwners = <T extends { deletedAt?: string; attachments?: Attachment[] }>(items: T[]): T[] => {
        let itemsChanged = false;
        const next = items.map((owner) => {
            if (owner.deletedAt || !owner.attachments?.some((attachment) => patches.has(attachment.id))) {
                return owner;
            }
            itemsChanged = true;
            return {
                ...owner,
                attachments: owner.attachments.map(
                    (attachment) => patches.get(attachment.id) ?? attachment,
                ),
            };
        });
        if (itemsChanged) changed = true;
        return itemsChanged ? next : items;
    };
    const tasks = patchOwners(appData.tasks);
    const projects = patchOwners(appData.projects);
    return changed ? { ...appData, tasks, projects } : appData;
};


export const withAttachmentSettingsPatch = (
    appData: AppData,
    attachmentSettings: AttachmentSettings | undefined,
): AppData => (
    attachmentSettings === undefined
        ? appData
        : { ...appData, settings: { ...appData.settings, attachments: attachmentSettings } }
);

const defaultResolveLocalPath = (uri: string): string => {
    if (!/^file:\/\//i.test(uri)) return uri;
    try {
        const parsed = new URL(uri);
        let path = decodeURIComponent(parsed.pathname);
        if (/^\/[A-Za-z]:\//.test(path)) {
            path = path.slice(1);
        }
        return path;
    } catch {
        return uri.replace(/^file:\/\//i, '');
    }
};


export async function runAttachmentTransferLifecycle(
    options: AttachmentTransferLifecycleOptions,
): Promise<AttachmentTransferResult> {
    const patches = new Map<string, Attachment>();
    const hasCloudCopy = options.hasCloudCopy ?? ((attachment: Attachment) => Boolean(attachment.cloudKey));
    const resolveLocalPath = options.resolveLocalPath ?? defaultResolveLocalPath;
    const assertUploadStatAllowed = (stat: LocalFileStat | null): void => {
        options.assertUploadStat?.(stat);
        if (!stat || options.maxBufferedUploadBytes === undefined) return;
        assertBufferedAttachmentUploadSize(stat.size, options.maxBufferedUploadBytes);
    };


    const refreshContentStat = async (
        attachment: Attachment,
        path: string,
        verifyDownloadedGeneration = false,
    ): Promise<void> => {
        if (!options.getLocalFileStat) return;
        const stat = await options.getLocalFileStat(path, attachment).catch(() => null);
        if (!stat) return;

        const expectedHash = attachment.fileHash?.trim().toLowerCase();
        if (
            verifyDownloadedGeneration
            && options.computeLocalFileHash
            && isSha256Hex(expectedHash)
        ) {
            const hash = await options.computeLocalFileHash(path, attachment).catch(() => null);
            const finalStat = await options.getLocalFileStat(path, attachment).catch(() => null);
            if (
                hash?.trim().toLowerCase() !== expectedHash
                || !finalStat
                || finalStat.mtimeMs !== stat.mtimeMs
                || finalStat.size !== stat.size
            ) {


                options.onLocalEditRace?.(attachment);
                return;
            }
            applyAttachmentContentStat(attachment, finalStat, expectedHash);
            return;
        }

        applyAttachmentContentStat(attachment, stat);
    };

    const attemptUpload = async (
        attachment: Attachment,
        localPath: string,
        expectedHash?: string,
    ): Promise<boolean> => {
        if (options.getLocalFileStat) {
            const uploadStat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
            assertUploadStatAllowed(uploadStat);
        }
        const snapshot = options.createUploadSnapshot
            ? await options.createUploadSnapshot(localPath, attachment)
            : null;
        if (!snapshot) {
            if (options.requireUploadSnapshot) return false;
            return await options.onUpload(attachment, localPath);
        }

        try {
            options.assertUploadStat?.(snapshot.stat);
            const snapshotHash = snapshot.fileHash.trim().toLowerCase();
            const normalizedExpectedHash = expectedHash?.trim().toLowerCase();
            if (!isSha256Hex(snapshotHash)
                || (expectedHash !== undefined
                    && (!isSha256Hex(normalizedExpectedHash) || snapshotHash !== normalizedExpectedHash))) {
                options.onLocalEditRace?.(attachment);
                return false;
            }
            if (!await options.onUpload(attachment, snapshot.sourcePath, snapshot)) return false;
            applyAttachmentContentStat(attachment, snapshot.stat, snapshotHash);
            return true;
        } finally {
            try {
                await snapshot.dispose();
            } catch (error) {


                options.onUploadError(attachment, error);
            }
        }
    };


    const provePendingUploadIdentity = async (
        attachment: Attachment,
        localPath: string,
    ): Promise<boolean> => {
        if (!options.createUploadSnapshot) return false;
        if (options.getLocalFileStat) {
            const candidateStat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
            assertUploadStatAllowed(candidateStat);
        }
        const snapshot = await options.createUploadSnapshot(localPath, attachment);
        if (!snapshot) return false;
        try {
            const snapshotHash = snapshot.fileHash.trim().toLowerCase();
            if (!isSha256Hex(snapshotHash)) {
                options.onLocalEditRace?.(attachment);
                return false;
            }
            assertUploadStatAllowed(snapshot.stat);
            applyAttachmentContentStat(attachment, snapshot.stat, snapshotHash);
            return true;
        } finally {
            try {
                await snapshot.dispose();
            } catch (error) {
                options.onUploadError(attachment, error);
            }
        }
    };

    const admit = (
        attachment: Attachment,
        direction: AttachmentTransferDirection,
        budget: ((attachment: Attachment) => boolean) | undefined,
    ): boolean => {
        if (options.admission?.has(attachment, direction)) return false;
        if (budget && !budget(attachment)) return false;
        options.admission?.record(attachment, direction);
        return true;
    };
    const admitUpload = (attachment: Attachment) => admit(attachment, 'upload', options.policy?.shouldUpload);
    const admitDownload = (attachment: Attachment) => admit(attachment, 'download', options.policy?.shouldDownload);

    for (const original of options.attachmentsById.values()) {
        await options.beforeEachAttachment?.();
        if (original.kind !== 'file') continue;
        if (original.deletedAt) continue;
        if (options.policy?.shouldSkip?.(original)) continue;


        const attachment: Attachment = { ...original };
        let itemMutated = false;
        let uploadedThisPass = false;

        const rawUri = attachment.uri ? resolveLocalPath(attachment.uri) : '';
        const isHttp = /^https?:\/\//i.test(rawUri);
        const localPath = isHttp ? '' : rawUri;
        const hasLocalPath = Boolean(localPath);
        const localPresence = hasLocalPath
            ? await options.getLocalFilePresence(localPath, attachment).catch(() => 'unreadable' as const)
            : 'confirmed-not-found';


        if (localPresence === 'unreadable') continue;

        const existsLocally = localPresence === 'present';

        const hasPendingContentUpload = attachment.pendingContentUpload === true;
        if (
            hasPendingContentUpload
            && !options.deferUploads
            && !existsLocally
            && options.allowPendingRemoteRecovery === false
        ) {
            continue;
        }

        const nextStatus: Attachment['localStatus'] = existsLocally ? 'available' : 'missing';
        if (attachment.localStatus !== nextStatus) {
            attachment.localStatus = nextStatus;
            itemMutated = true;
        }


        const mayReadForSync = existsLocally && (options.canUploadFrom?.(localPath, attachment) ?? true);

        if (
            hasPendingContentUpload
            && options.deferUploads
            && mayReadForSync
            && !isSha256Hex(attachment.fileHash)
        ) {
            try {
                if (await provePendingUploadIdentity(attachment, localPath)) {
                    itemMutated = true;
                }
            } catch (error) {
                if (options.isFatalError?.(error)) throw error;
                options.onUploadError(attachment, error);
            }
        }


        if (hasPendingContentUpload && !options.deferUploads) {
            const expectedPendingHash = attachment.fileHash?.trim().toLowerCase();
            if (!isSha256Hex(expectedPendingHash)) {
                options.onLocalEditRace?.(attachment);
                if (itemMutated) patches.set(attachment.id, attachment);
                continue;
            }


            if (
                !existsLocally
                && admitDownload(attachment)
            ) {


                const expectedCloudKey = attachment.cloudKey;
                const expectedFileHash = expectedPendingHash;
                const recovered: Attachment = { ...attachment };
                try {
                    const downloaded = await options.onDownload(recovered, { kind: 'absent' });
                    if (
                        downloaded
                        && recovered.cloudKey === expectedCloudKey
                        && recovered.fileHash?.trim().toLowerCase() === expectedFileHash
                        && recovered.localStatus === 'available'
                    ) {
                        recovered.pendingContentUpload = undefined;
                        const freshPath = recovered.uri ? resolveLocalPath(recovered.uri) : '';
                        if (freshPath) await refreshContentStat(recovered, freshPath, true);
                        Object.assign(attachment, recovered);
                        itemMutated = true;
                    }
                } catch (error) {
                    if (options.isFatalError?.(error)) throw error;
                    options.onDownloadError(attachment, error);
                }
            } else if (mayReadForSync && options.createUploadSnapshot) {
                if (admitUpload(attachment)) {
                    try {
                        if (await attemptUpload(attachment, localPath, expectedPendingHash)) {
                            attachment.pendingContentUpload = undefined;
                            itemMutated = true;
                        }
                    } catch (error) {
                        if (options.isFatalError?.(error)) throw error;
                        options.onUploadError(attachment, error);
                    }
                }
            } else if (mayReadForSync && options.getLocalFileStat) {
                const stat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
                if (stat) {
                    const check = await checkAttachmentContentChange(
                        attachment,
                        stat,
                        () => options.computeLocalFileHash
                            ? options.computeLocalFileHash(localPath, attachment)
                            : Promise.resolve(null),
                    );
                    if (check.changed) {
                        options.onLocalEditRace?.(attachment);
                    } else {
                        if (
                            check.stat.mtimeMs !== attachment.contentMtimeMs
                            || check.stat.size !== attachment.contentSize
                        ) {
                            applyAttachmentContentStat(attachment, check.stat, check.hash);
                            itemMutated = true;
                        }
                        if (admitUpload(attachment)) {
                            try {
                                if (await attemptUpload(attachment, localPath, expectedPendingHash)) {
                                    attachment.pendingContentUpload = undefined;
                                    itemMutated = true;
                                    if (!options.createUploadSnapshot) {
                                        await refreshContentStat(attachment, localPath);
                                    }
                                }
                            } catch (error) {
                                if (options.isFatalError?.(error)) throw error;
                                options.onUploadError(attachment, error);
                            }
                        }
                    }
                }
            }


            if (itemMutated) patches.set(attachment.id, attachment);
            continue;
        }

        if (!hasCloudCopy(attachment) && mayReadForSync && !options.deferUploads) {
            if (admitUpload(attachment)) {
                try {
                    if (await attemptUpload(attachment, localPath)) {
                        attachment.pendingContentUpload = undefined;
                        itemMutated = true;
                        uploadedThisPass = true;
                        if (!options.createUploadSnapshot && !attachment.fileHash && options.computeLocalFileHash) {
                            const hash = await options.computeLocalFileHash(localPath, attachment).catch(() => null);
                            if (hash) attachment.fileHash = hash;
                        }
                        if (!options.createUploadSnapshot) {
                            await refreshContentStat(attachment, localPath);
                        }
                    }
                } catch (error) {
                    if (options.isFatalError?.(error)) throw error;
                    options.onUploadError(attachment, error);
                }
            }
        }


        if (uploadedThisPass) {
            patches.set(attachment.id, attachment);
            continue;
        }

        let adopted = false;
        if (hasCloudCopy(attachment) && !existsLocally && !hasPendingContentUpload && options.adoptExistingDownload) {
            try {
                adopted = await options.adoptExistingDownload(attachment);
            } catch (error) {
                if (options.isFatalError?.(error)) throw error;
            }
            if (adopted) {
                itemMutated = true;

                attachment.staleContentHash = undefined;
                const freshPath = attachment.uri ? resolveLocalPath(attachment.uri) : '';
                if (freshPath) await refreshContentStat(attachment, freshPath, true);
            }
        }
        if (hasCloudCopy(attachment) && !existsLocally && !hasPendingContentUpload && !adopted) {
            if (admitDownload(attachment)) {
                try {
                    if (await options.onDownload(attachment, { kind: 'absent' })) {
                        itemMutated = true;

                        attachment.staleContentHash = undefined;


                        const freshPath = attachment.uri ? resolveLocalPath(attachment.uri) : localPath;
                        if (freshPath) await refreshContentStat(attachment, freshPath, true);
                    }
                } catch (error) {
                    if (options.isFatalError?.(error)) throw error;
                    options.onDownloadError(attachment, error);
                }
            }
        }


        if (hasCloudCopy(attachment) && mayReadForSync && options.getLocalFileStat && options.contentChangePhase) {
            const stat = await options.getLocalFileStat(localPath, attachment).catch(() => null);


            if (!stat || !options.assertUploadStat) assertUploadStatAllowed(stat);
            if (stat) {
                const check = await checkAttachmentContentChange(
                    attachment,
                    stat,
                    () => {
                        if (options.assertUploadStat) assertUploadStatAllowed(stat);
                        if (unhashableStats.get(attachment.id) === statMarker(stat)) return Promise.resolve(null);
                        return options.computeLocalFileHash ? options.computeLocalFileHash(localPath, attachment) : Promise.resolve(null);
                    },
                );
                if (check.hash) unhashableStats.delete(attachment.id);
                if (!check.changed) {
                    if (check.stat.mtimeMs !== attachment.contentMtimeMs || check.stat.size !== attachment.contentSize) {
                        applyAttachmentContentStat(attachment, check.stat, check.hash);
                        itemMutated = true;
                    }
                } else if (!check.hash) {


                    unhashableStats.set(attachment.id, statMarker(check.stat));
                } else if (!attachment.fileHash && options.contentChangePhase === 'post-merge') {


                    applyAttachmentContentStat(attachment, check.stat, check.hash);
                    itemMutated = true;
                } else if (options.contentChangePhase === 'prepare' && isStaleCopyOfRemoteWinner(attachment, check.hash)) {


                    logUninstalledRemoteWinner(attachment);
                } else if (options.contentChangePhase === 'prepare') {


                    if (options.deferUploads) {
                        applyAttachmentContentStat(attachment, check.stat, check.hash);
                        attachment.contentRev = bumpAttachmentContentRevision(attachment);
                        attachment.pendingContentUpload = true;
                        itemMutated = true;
                    } else if (admitUpload(attachment)) {
                        try {
                            if (await attemptUpload(attachment, localPath, check.hash ?? undefined)) {
                                if (!options.createUploadSnapshot) {
                                    applyAttachmentContentStat(attachment, check.stat, check.hash);
                                }
                                attachment.contentRev = bumpAttachmentContentRevision(attachment);
                                itemMutated = true;
                            }
                        } catch (error) {
                            if (options.isFatalError?.(error)) throw error;
                            options.onUploadError(attachment, error);
                        }
                    }
                } else {


                    const restat = await options.getLocalFileStat(localPath, attachment).catch(() => null);
                    const stillMatchesDetectedState = restat
                        && restat.mtimeMs === check.stat.mtimeMs
                        && restat.size === check.stat.size;
                    if (!stillMatchesDetectedState) {
                        options.onLocalEditRace?.(attachment);
                    } else if (admitDownload(attachment)) {
                        try {
                            if (await options.onDownload(attachment, {
                                kind: 'present',
                                sha256: check.hash,
                            })) {
                                itemMutated = true;
                                attachment.staleContentHash = undefined;
                                const freshPath = attachment.uri ? resolveLocalPath(attachment.uri) : localPath;
                                if (freshPath) await refreshContentStat(attachment, freshPath, true);
                            }
                        } catch (error) {
                            if (options.isFatalError?.(error)) throw error;
                            options.onDownloadError(attachment, error);
                        }
                    }
                }
            }
        }

        if (itemMutated) {
            patches.set(attachment.id, attachment);
        }
    }

    return { changed: patches.size > 0, patches };
}
