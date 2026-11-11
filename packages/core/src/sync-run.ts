import type { AppData, Attachment } from './types';
import type { CloudProvider, PreparedStorePublish } from './sync-client-helpers';
import type { SyncBackend } from './sync-service-utils';
import {
    isSyncFileGenerationCorruptError,
    SyncFileLockBusyError,
    SyncFileLockUnavailableError,
} from './sync-service-utils';
import type { FastSyncState } from './sync-fast-sync';
import { PREPARED_UNCHANGED, type SyncCycleIO, type SyncCycleResult, type SyncHistoryEntry } from './sync-types';
import type {
    SyncBackendIO,
    SyncRemoteWriteOutcome,
    SyncRunErrorContext,
    SyncRunNotifier,
    SyncRunOptions,
    SyncRunPlatformHooks,
    SyncRunAttachmentPhase,
    SyncRunPolicy,
    SyncRunPorts,
    SyncRunResult,
    SyncRunStorage,
    SyncRunStoreBridge,
    ActivationMissingAttachment,
} from './sync-run-ports';
import { SyncRemoteWriteConflict, type SyncFollowUpReason } from './sync-run-ports';
import { parseUnreachableAttachments, pruneUnreachableAttachments, rememberUnreachableAttachments, type UnreachableAttachments } from './unreachable-attachments';
import { LocalSyncAbort, captureInMemoryAppDataSnapshot, ensureFreshLocalSyncSnapshot, getInMemoryAppDataSnapshot, shouldRunAttachmentCleanup } from './sync-client-helpers';
import { hasFreshAttachmentCleanupWork } from './attachment-cleanup';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { createAttachmentTransferAdmission, isAttachmentUploadTooLargeError, isCloudHostUploadLimitError, isWebdavHostUploadLimitError } from './attachment-transfer';
import { isSyncEncryptionPartlyEncryptedError } from './sync-encryption';
import { isHostResponseTooLargeError } from './http-utils';
import { flushPendingSave, useTaskStore } from './store';
import { getStoreListenerCount } from './store-notify-profiler';
import { markArchiveRetentionSyncCompleted } from './store-archive-retention';
import {
    assertNoPendingAttachmentContentReplacements,
    assertNoPendingAttachmentUploads,
    computeSyncChangeFingerprint,
    computeSyncChangeFingerprintPass,
    findPendingAttachmentUploads,
    hasPendingSyncSideEffects,
    isLocalPersistEquivalent,
    fingerprintStableSyncJsonPass,
    sanitizeAppDataForRemote,
    toStableSyncJson,
} from './sync-helpers';
import {
    parseSyncDocument,
    remoteSyncDocumentStableJsonPass,
    toRemoteSyncDocument,
} from './sync-document';
import { buildHttpRemoteFileFingerprint } from './webdav';
import type { RemoteJsonWriteResult } from './webdav';
import type { CloudJsonWriteResult } from './cloud';
import { normalizeAppData } from './sync-normalization';
import { isWebdavInvalidJsonError } from './retry-utils';
import { isRemoteSyncBackend } from './sync-service-utils';
import { cloneAppData, cloneAppDataPass } from './sync-runtime-utils';
import { createSlicer, runSliced, type Slicer } from './cooperative';
import { traceSection, traceSectionAsync } from './perf-trace';
import { runSyncStoreSave } from './store-write-gate';
import type { SqliteReadToken } from './sqlite-adapter';
import { buildMergeSummaryLog, buildPendingAttachmentUploadLogExtra } from './sync-log-utils';
import { CLOCK_SKEW_THRESHOLD_MS } from './sync-types';
import { appendSyncHistory, mergeAppData, performSyncCycle } from './sync';
import { restoreDeviceLocalAiSettings } from './sync-merge-settings';
import { hasUncompactedPurgedTombstones } from './tombstone-compaction';
import {
    isSyncRemoteMutationFenceError,
    SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS,
    SyncRemoteMutationFenceBusyError,
    SyncRemoteMutationFenceUnavailableError,
    type SyncRemoteMutationFenceLease,
} from './sync-remote-fence';


type RemoteWriteResultLike = Partial<RemoteJsonWriteResult & CloudJsonWriteResult>;


export const normalizeRemoteWriteResult = (
    source: 'cloud' | 'webdav',
    result: RemoteWriteResultLike | boolean | null | undefined,
): { fingerprint: string | null; serverMergedRemoteData: boolean } => {
    if (!result || typeof result !== 'object') {
        return { fingerprint: null, serverMergedRemoteData: false };
    }
    const fingerprint = typeof result.fingerprint === 'string' && result.fingerprint.trim()
        ? result.fingerprint
        : buildHttpRemoteFileFingerprint(source, {
            etag: typeof result.etag === 'string' ? result.etag : null,
            lastModified: typeof result.lastModified === 'string' ? result.lastModified : null,
            contentLength: typeof result.contentLength === 'string' ? result.contentLength : null,
        });
    return {
        fingerprint,
        serverMergedRemoteData: result.serverMergedRemoteData === true,
    };
};

type SharedSyncRunState = {
    backend: SyncBackend;
    cloudProvider: CloudProvider;
    step: string;
    fastSyncScope: string | null;
    localSnapshotChangeAt: number;
    localDataCache: { changeAt: number; data: AppData } | null;

    localReadToken: SqliteReadToken | undefined;


    localSnapshotMatchesDisk: boolean;
    localDocumentFingerprint: { data: AppData; fingerprint: string } | null;
    fastSyncStateCache: { scope: string; value: FastSyncState | null } | null;
    preSyncedLocalData: AppData | null;
    wroteLocal: boolean;

    publishedGateWaitsMs: number[];

    publishedCommitMs: number[];
    publishedSwaps: ('prepared' | 'in-gate')[];
    publishedStep: string | null;

    requeueReason: string | null;
    remoteDataForCompare: AppData | null;


    remoteLegacyAttachmentsChanged: boolean;
    readCheckRemoteData: AppData | undefined;


    localOnlyUploadFingerprint: string | null;
    lastRemoteWriteFingerprint: string | null;
    lastRemoteWriteMergedServerData: boolean;
    webdavRemoteCorrupted: boolean;
    hadAttachmentWarning: boolean;
    fileAttachmentUploadBlocked: 'too-large' | null;

    acceptedMissingAttachments: string[];
    keptAttachmentNotFoundLogged: boolean;

    locationScope: string | null;
};

const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;


const computeAttachmentIdentityDigest = (data: AppData): string => {
    const parts: string[] = [];
    const append = (items: readonly { id: string; attachments?: Attachment[] }[] | undefined): void => {
        for (const item of items ?? []) {
            const attachments = item.attachments;
            if (!attachments || attachments.length === 0) continue;
            const ordered = [...attachments].sort((left, right) => (
                left.id < right.id ? -1 : left.id > right.id ? 1 : 0
            ));
            parts.push(`${item.id}:${toStableSyncJson(ordered)}`);
        }
    };
    append(data.tasks);
    append(data.projects);
    return parts.join('\n');
};


let idleCycleSnapshot: { scope: string; changeAt: number; data: AppData; fingerprint: string; token?: SqliteReadToken } | null = null;


const takeIdleCycleSnapshot = (): typeof idleCycleSnapshot => {
    const carried = idleCycleSnapshot;
    idleCycleSnapshot = null;
    return carried;
};


export const clearIdleSyncCycleSnapshot = (): void => {
    idleCycleSnapshot = null;
};

const withoutInheritedPendingRemoteWrite = (data: AppData): AppData => {
    if (
        !data.settings.pendingRemoteWriteAt
        && data.settings.pendingRemoteWriteRetryAt === undefined
        && data.settings.pendingRemoteWriteAttempts === undefined
    ) {
        return data;
    }
    return {
        ...data,
        settings: {
            ...data.settings,
            pendingRemoteWriteAt: undefined,
            pendingRemoteWriteRetryAt: undefined,
            pendingRemoteWriteAttempts: undefined,
        },
    };
};

const withoutInheritedPendingRemoteWriteBackoff = (data: AppData): AppData => {
    if (data.settings.pendingRemoteWriteRetryAt === undefined) return data;
    return {
        ...data,
        settings: {
            ...data.settings,
            pendingRemoteWriteRetryAt: undefined,
        },
    };
};

const visitLiveFileAttachments = (
    data: AppData,
    visit: (attachment: NonNullable<AppData['tasks'][number]['attachments']>[number]) => void,
): number => {
    let count = 0;
    for (const owner of [...data.tasks, ...data.projects]) {
        if (owner.deletedAt) continue;
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind !== 'file' || attachment.deletedAt) continue;
            count += 1;
            visit(attachment);
        }
    }
    return count;
};

const mergedContentMustReplaceCandidateBlob = (
    merged: Attachment,
    candidate: Attachment,
): boolean => {
    const mergedRev = merged.contentRev ?? 0;
    const candidateRev = candidate.contentRev ?? 0;
    if (mergedRev !== candidateRev) return mergedRev > candidateRev;
    if (!merged.fileHash || !candidate.fileHash) return false;
    return merged.fileHash.toLowerCase() !== candidate.fileHash.toLowerCase();
};

const normalizeAttachmentHash = (value?: string): string => value?.trim().toLowerCase() ?? '';


const buildExactLocalActivationFallback = (
    merged: Attachment,
    local: Attachment | undefined,
    candidate: Attachment | undefined,
): Attachment | null => {
    if (!local || !candidate?.cloudKey) return null;
    const localUri = local.uri?.trim();
    const localHash = normalizeAttachmentHash(local.fileHash);
    const mergedHash = normalizeAttachmentHash(merged.fileHash);
    const candidateHash = normalizeAttachmentHash(candidate.fileHash);
    if (
        !localUri
        || local.localStatus === 'missing'
        || !localHash
        || localHash !== mergedHash
        || localHash !== candidateHash
        || (local.contentRev ?? 0) !== (merged.contentRev ?? 0)
        || (local.contentRev ?? 0) !== (candidate.contentRev ?? 0)
    ) {
        return null;
    }
    return {
        ...merged,
        uri: local.uri,
        cloudKey: undefined,
        fileHash: merged.fileHash,
        contentMtimeMs: local.contentMtimeMs,
        contentSize: local.contentSize,
        localStatus: 'available',
        pendingContentUpload: true,
        staleContentHash: undefined,
        deletedAt: undefined,
    };
};

const prepareActivationAttachmentSnapshot = (
    data: AppData,
    candidateRemoteData: AppData | null,
    localData: AppData | null,
): {
    data: AppData;
    count: number;
    expectedIds: Set<string>;
    localFallbacks: Map<string, Attachment>;
    metadataOnlyIds: Set<string>;
    noLocalBytesIds: Set<string>;

    noLocalFileIds: Set<string>;


    originalCloudKeys: Map<string, string>;
} => {
    const candidateAttachments = new Map<string, Attachment>();
    if (candidateRemoteData) {
        visitLiveFileAttachments(candidateRemoteData, (attachment) => {
            candidateAttachments.set(attachment.id, attachment);
        });
    }
    const localAttachments = new Map<string, Attachment>();
    if (localData) {
        visitLiveFileAttachments(localData, (attachment) => {
            localAttachments.set(attachment.id, attachment);
        });
    }
    const candidate = cloneAppData(data);
    const expectedIds = new Set<string>();
    const localFallbacks = new Map<string, Attachment>();
    const metadataOnlyIds = new Set<string>();
    const noLocalBytesIds = new Set<string>();
    const noLocalFileIds = new Set<string>();
    const originalCloudKeys = new Map<string, string>();
    const count = visitLiveFileAttachments(candidate, (attachment) => {
        expectedIds.add(attachment.id);
        const candidateAttachment = candidateAttachments.get(attachment.id);
        const localAttachment = localAttachments.get(attachment.id);
        const originalKey = candidateAttachment?.cloudKey || localAttachment?.cloudKey || attachment.cloudKey;
        if (originalKey) originalCloudKeys.set(attachment.id, originalKey);


        const noLocalFile = !localAttachment || !localAttachment.uri?.trim() || localAttachment.localStatus === 'missing';
        if (noLocalFile) noLocalFileIds.add(attachment.id);
        const noLocalBytes = noLocalFile && !localAttachment?.cloudKey;
        if (noLocalBytes) noLocalBytesIds.add(attachment.id);

        if (noLocalBytes && !candidateAttachment?.cloudKey) metadataOnlyIds.add(attachment.id);
        const mustReplaceCandidateBlob = Boolean(
            candidateAttachment?.cloudKey
            && mergedContentMustReplaceCandidateBlob(attachment, candidateAttachment),
        );
        if (!mustReplaceCandidateBlob) {
            const fallback = buildExactLocalActivationFallback(
                attachment,
                localAttachments.get(attachment.id),
                candidateAttachment,
            );
            if (fallback) localFallbacks.set(attachment.id, fallback);
        }


        attachment.cloudKey = candidateAttachment?.cloudKey;
        attachment.pendingContentUpload = mustReplaceCandidateBlob ? true : undefined;


        if (candidateAttachment?.cloudKey && !mustReplaceCandidateBlob) {
            attachment.uri = '';
        }
        attachment.localStatus = 'missing';
    });
    return { data: candidate, count, expectedIds, localFallbacks, metadataOnlyIds, noLocalBytesIds, noLocalFileIds, originalCloudKeys };
};

const prepareActivationFallbackRetry = (
    data: AppData,
    localFallbacks: ReadonlyMap<string, Attachment>,
    consumedFallbackIds: Set<string> = new Set<string>(),

    includeLiveMissing = false,
): { data: AppData; count: number } => {
    if (localFallbacks.size === 0) return { data, count: 0 };
    const retryData = cloneAppData(data);
    let count = 0;
    for (const owner of [...retryData.tasks, ...retryData.projects]) {
        if (owner.deletedAt) continue;
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind !== 'file') continue;

            const failed = Boolean(attachment.deletedAt)
                || (includeLiveMissing && Boolean(attachment.cloudKey) && attachment.localStatus === 'missing');
            if (!failed) continue;
            if (consumedFallbackIds.has(attachment.id)) continue;
            const fallback = localFallbacks.get(attachment.id);
            if (!fallback) continue;


            Object.assign(attachment, fallback);
            consumedFallbackIds.add(attachment.id);
            count += 1;
        }
    }
    return count > 0 ? { data: retryData, count } : { data, count: 0 };
};

const CLOUDKIT_KEY_PREFIX = 'cloudkit:';
const clipTitle = (value: string | undefined, max = 60): string => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};


export class ActivationAttachmentProofError extends Error {
    constructor(message: string, readonly displayMessage: string) {
        super(message);
        this.name = 'ActivationAttachmentProofError';
    }
}


export class ActivationMissingAttachmentsError extends ActivationAttachmentProofError {
    constructor(readonly attachments: ActivationMissingAttachment[]) {
        const ids = attachments.map((attachment) => attachment.id).join(', ');
        const names = attachments
            .map((attachment) => `"${clipTitle(attachment.title) || attachment.id}"${attachment.ownerTitle ? ` on ${attachment.ownerType} "${clipTitle(attachment.ownerTitle)}"` : ''}`)
            .join(', ');
        const reason = 'the file is on neither this device nor the new sync location';
        super(`Candidate attachment proof failed for ${ids}: ${reason}`, `Candidate attachment proof failed for ${names}: ${reason}`);
        this.name = 'ActivationMissingAttachmentsError';
    }
}


const sameAttachmentOwners = (data: AppData, next: AppData): boolean => {
    const same = <T>(left: T, right: T) => left === right || JSON.stringify(left) === JSON.stringify(right);
    const sameList = <T>(left: T[], right: T[]) => left === right
        || (left.length === right.length && left.every((item, index) => same(item, right[index])));
    return sameList(data.tasks, next.tasks) && sameList(data.projects, next.projects) && same(data.settings, next.settings);
};

const replaceAttachments = (
    data: AppData,
    ids: ReadonlySet<string>,
    replace: (attachment: Attachment) => Attachment,
): AppData => {
    const patchOwner = <T extends { attachments?: Attachment[] }>(owner: T): T => (
        owner.attachments?.some((attachment) => ids.has(attachment.id))
            ? { ...owner, attachments: owner.attachments.map((attachment) => (ids.has(attachment.id) ? replace(attachment) : attachment)) }
            : owner
    );
    return { ...data, tasks: data.tasks.map(patchOwner), projects: data.projects.map(patchOwner) };
};

const describeUnprovenAttachment = (
    ownerType: 'task' | 'project',
    owner: { id?: string; title?: string },
    attachment: Attachment,
    backend: SyncBackend,
    originalCloudKey: string | undefined,
): ActivationAttachmentProofError => {
    const name = clipTitle(attachment.title) || attachment.id;
    const ownerTitle = clipTitle(owner.title);
    const where = ownerTitle ? ` on ${ownerType} "${ownerTitle}"` : '';
    const key = originalCloudKey || attachment.cloudKey || '';
    let reason: string;
    if (key && backend !== 'cloudkit' && key.startsWith(CLOUDKIT_KEY_PREFIX)) {
        reason = 'it was uploaded to iCloud and is not reachable from this sync location; re-add the file on a device that still has it';
    } else if (key && backend === 'cloudkit' && !key.startsWith(CLOUDKIT_KEY_PREFIX)) {
        reason = 'it was uploaded to another sync location and is not reachable from iCloud; re-add the file on a device that still has it';
    } else if (!key) {
        reason = 'no copy of the file exists on this device or at the new sync location';
    } else {
        reason = 'the file could not be fetched from the new sync location';
    }
    return new ActivationAttachmentProofError(
        `Candidate attachment proof failed for ${attachment.id}${owner.id ? ` on ${ownerType} ${owner.id}` : ''}: ${reason}`,
        `Candidate attachment proof failed for ${attachment.id} ("${name}"${where}): ${reason}`,
    );
};

type ActivationAttachmentProof = 'proven' | 'deferred' | 'unproven';

const classifyActivationAttachmentProof = (
    ownerDeleted: boolean,
    attachment: Attachment,
    metadataOnlyIds: ReadonlySet<string>,
    noLocalBytesIds: ReadonlySet<string>,
    backend: SyncBackend,
): ActivationAttachmentProof => {


    if (ownerDeleted || Boolean(attachment.deletedAt)) {
        return noLocalBytesIds.has(attachment.id) ? 'proven' : 'unproven';
    }


    if (
        metadataOnlyIds.has(attachment.id)
        && !attachment.cloudKey
        && attachment.localStatus === 'missing'
        && attachment.pendingContentUpload !== true
    ) {
        return 'proven';
    }
    if (
        backend === 'file'
        && noLocalBytesIds.has(attachment.id)
        && attachment.cloudKey
        && attachment.localStatus === 'missing'
        && attachment.pendingContentUpload !== true
    ) {
        return 'deferred';
    }
    return attachment.cloudKey
        && attachment.localStatus === 'available'
        && attachment.pendingContentUpload !== true
        ? 'proven'
        : 'unproven';
};


const countActivationAttachmentProofs = (
    data: AppData,
    expectedIds: ReadonlySet<string>,
    metadataOnlyIds: ReadonlySet<string>,
    noLocalBytesIds: ReadonlySet<string>,
    backend: SyncBackend,
): number => {
    const proven = new Set<string>();
    for (const owner of [...data.tasks, ...data.projects]) {
        for (const attachment of owner.attachments ?? []) {
            if (
                attachment.kind === 'file'
                && expectedIds.has(attachment.id)
                && classifyActivationAttachmentProof(
                    Boolean(owner.deletedAt),
                    attachment,
                    metadataOnlyIds,
                    noLocalBytesIds,
                    backend,
                ) === 'proven'
            ) {
                proven.add(attachment.id);
            }
        }
    }
    return proven.size;
};

const assertActivationAttachmentsProven = (
    data: AppData,
    expectedIds: ReadonlySet<string>,
    metadataOnlyIds: ReadonlySet<string>,
    noLocalBytesIds: ReadonlySet<string>,
    backend: SyncBackend,
    originalCloudKeys: ReadonlyMap<string, string>,
    noLocalFileIds: ReadonlySet<string>,

    acceptedMissingIds: ReadonlySet<string> | null,
): { deferred: string[]; missing: string[] } => {
    const resolved = new Set<string>();
    const deferred: string[] = [];
    const missing: ActivationMissingAttachment[] = [];
    const owners: Array<['task' | 'project', { id?: string; title?: string; deletedAt?: string; attachments?: Attachment[] }]> = [
        ...data.tasks.map((task) => ['task', task] as ['task', typeof task]),
        ...data.projects.map((project) => ['project', project] as ['project', typeof project]),
    ];
    for (const [ownerType, owner] of owners) {
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind !== 'file') continue;


            if ((owner.deletedAt || attachment.deletedAt) && !expectedIds.has(attachment.id)) {
                continue;
            }
            const proof = classifyActivationAttachmentProof(
                Boolean(owner.deletedAt),
                attachment,
                metadataOnlyIds,
                noLocalBytesIds,
                backend,
            );
            if (proof === 'proven') {
                if (expectedIds.has(attachment.id)) resolved.add(attachment.id);
                continue;
            }


            if (proof === 'deferred') {
                deferred.push(attachment.id);
                if (expectedIds.has(attachment.id)) resolved.add(attachment.id);
                continue;
            }


            if (
                acceptedMissingIds
                && !owner.deletedAt
                && expectedIds.has(attachment.id)
                && noLocalFileIds.has(attachment.id)
                && (Boolean(attachment.deletedAt) || !attachment.cloudKey)
            ) {
                missing.push({
                    id: attachment.id,
                    ownerType,
                    ownerId: owner.id ?? '',
                    title: attachment.title ?? '',
                    ownerTitle: owner.title ?? '',
                });
                resolved.add(attachment.id);
                continue;
            }
            throw describeUnprovenAttachment(ownerType, owner, attachment, backend, originalCloudKeys.get(attachment.id));
        }
    }


    if (resolved.size !== expectedIds.size) {
        throw new Error(`Candidate attachment proof incomplete: expected ${expectedIds.size}, proved ${resolved.size}`);
    }
    if (missing.some((attachment) => !acceptedMissingIds?.has(attachment.id))) {
        throw new ActivationMissingAttachmentsError(missing);
    }
    return { deferred, missing: missing.map((attachment) => attachment.id) };
};

class SharedSyncRunMachine {
    private readonly options: SyncRunOptions;
    private readonly storage: SyncRunStorage;
    private readonly notifier: SyncRunNotifier;
    private readonly store: SyncRunStoreBridge;
    private readonly hooks: SyncRunPlatformHooks;
    private readonly policy: SyncRunPolicy;
    private readonly nowFn: () => Date;
    private readonly cleanupIntervalMs: number;
    private readonly performSyncCycleImpl: (io: SyncCycleIO) => Promise<SyncCycleResult>;
    private io: SyncBackendIO | null = null;
    private remoteMutationFence: SyncRemoteMutationFenceLease | null = null;
    private carriedIdleSnapshot = takeIdleCycleSnapshot();

    private readonly slicer: Slicer | undefined;

    private readonly transferAdmission = createAttachmentTransferAdmission((attachment, direction) => {
        this.notifier.logInfo('Attachment transfer already started this cycle; skipped', {
            attachmentId: attachment.id,
            kind: direction,
            releaseCheck: 'v1.3.7/attachment-download-reuse',
        });
    });

    private readonly slicedCycle: boolean;
    private readonly state: SharedSyncRunState = {
        backend: 'off',
        cloudProvider: 'selfhosted',
        step: 'init',
        fastSyncScope: null,
        localSnapshotChangeAt: 0,
        localDataCache: null,
        localReadToken: undefined,
        localSnapshotMatchesDisk: false,
        localDocumentFingerprint: null,
        fastSyncStateCache: null,
        preSyncedLocalData: null,
        wroteLocal: false,
        publishedGateWaitsMs: [],
        publishedCommitMs: [],
        publishedSwaps: [],
        publishedStep: null,
        requeueReason: null,
        remoteDataForCompare: null,
        remoteLegacyAttachmentsChanged: false,
        readCheckRemoteData: undefined,
        localOnlyUploadFingerprint: null,
        lastRemoteWriteFingerprint: null,
        lastRemoteWriteMergedServerData: false,
        webdavRemoteCorrupted: false,
        hadAttachmentWarning: false,
        fileAttachmentUploadBlocked: null,
        acceptedMissingAttachments: [],
        keptAttachmentNotFoundLogged: false,
        locationScope: null,
    };

    constructor(ports: SyncRunPorts) {
        this.options = ports.options;
        this.storage = ports.storage;
        this.notifier = ports.notifier;
        this.store = ports.store;
        this.hooks = ports.hooks;
        this.policy = ports.policy;
        this.nowFn = ports.now ?? (() => new Date());
        this.cleanupIntervalMs = ports.attachmentCleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
        this.performSyncCycleImpl = ports.performSyncCycle ?? performSyncCycle;
        const sliceYield = ports.notifier.sliceYield?.bind(ports.notifier);
        this.slicer = sliceYield ? createSlicer(sliceYield) : undefined;
        this.slicedCycle = this.slicer !== undefined;
    }


    private staleDatabase(): Error {
        this.requestFollowUp('stale-db');
        return new LocalSyncAbort('stale-db');
    }

    async run(): Promise<SyncRunResult> {
        let result!: SyncRunResult;
        let cleanupRetryAfterMs: number | null = null;
        let cleanupUnconfirmed = false;
        try {
            try {
                result = await this.runPhases();
            } catch (error) {
                if (error instanceof NativeAttachmentCleanupUnconfirmedError) {
                    cleanupUnconfirmed = true;
                    throw error;
                }
                result = await this.handleRunError(error);
            }
        } finally {

            if (!cleanupUnconfirmed) this.logSavesPublished();
            if (!cleanupUnconfirmed) this.logSlices();

            if (!cleanupUnconfirmed) cleanupRetryAfterMs = await this.releaseRemoteMutationFence();
        }
        if (cleanupRetryAfterMs !== null) {
            result.remoteFenceDeferred = 'cleanup';
            result.retryAfterMs = cleanupRetryAfterMs;
        }
        if (this.state.hadAttachmentWarning) {
            result.hadAttachmentWarning = true;
        }
        if (this.state.fileAttachmentUploadBlocked) {
            result.fileAttachmentUploadBlocked = this.state.fileAttachmentUploadBlocked;
        }
        return result;
    }

    private async runPhases(): Promise<SyncRunResult> {
        this.setStep('flush');
        await this.yieldToUi();
        await this.store.flushPendingSave();
        this.notifier.onDiagnostic?.({ event: 'flush' });
        this.state.localSnapshotChangeAt = this.store.getLastDataChangeAt();

        this.setStep('setup');
        const setup = await this.hooks.setupCycle({
            setStep: (step) => this.setStep(step),
            setBackend: (backend) => { this.state.backend = backend; },
        });
        if (setup.kind === 'disabled') {


            return { success: true, skipped: 'disabled' };
        }
        this.state.backend = setup.backend;
        this.state.cloudProvider = setup.cloudProvider ?? 'selfhosted';
        this.state.fastSyncScope = setup.fastSyncScope;
        this.state.locationScope = setup.locationScope ?? null;
        this.io = setup.io;

        if (this.policy.preSyncAttachmentsBeforeFastCheck) {
            await this.runAttachmentPreSyncPhase();
        }
        let skipResult: SyncRunResult | null = null;
        let localOnlyUpload = false;
        if (!this.options.activationProbe) {
            skipResult = await this.trySkipUnchangedFastSync();
            if (!skipResult) {
                localOnlyUpload = await this.tryArmLocalOnlyUploadFastPath();
            }
        }
        if (!this.options.activationProbe && !skipResult && !localOnlyUpload && this.policy.enableReadCheckSkip) {
            skipResult = await this.trySkipUnchangedReadSync();
        }
        let result = skipResult;
        if (!result) {
            if (!this.policy.preSyncAttachmentsBeforeFastCheck) {
                await this.runAttachmentPreSyncPhase();
            }
            result = await this.runMergePhase();
        }

        if (!this.options.activationProbe && (!result.skipped || result.skipped === 'unchanged')) {
            markArchiveRetentionSyncCompleted();
        }
        return result;
    }

    private get backend(): SyncBackend {
        return this.state.backend;
    }

    private requireIo(): SyncBackendIO {
        if (!this.io) {
            throw new Error('Sync backend IO is not initialized');
        }
        return this.io;
    }

    private nowIso(): string {
        return this.nowFn().toISOString();
    }

    private setStep(next: string): void {
        this.state.step = next;
        this.notifier.setStep(next);
    }

    private async yieldToUi(): Promise<void> {
        await this.notifier.yieldToUi?.();
    }

    private async ensureNetwork(): Promise<void> {
        await this.hooks.ensureNetworkStillAvailable?.();
    }


    private async ensureRemoteMutationFence(): Promise<void> {
        if (this.remoteMutationFence) {
            await this.runRemoteMutationFenceOperation(
                'Remote sync mutation fence validation failed',
                () => this.remoteMutationFence!.assertHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS),
            );
            return;
        }
        const acquire = this.requireIo().acquireRemoteMutationFence;
        if (!acquire) return;
        const lease = await this.runRemoteMutationFenceOperation(
            'Remote sync mutation fence acquisition failed',
            acquire,
        );
        if (!lease) return;
        if (lease.reclaimedFrom) {
            const from = lease.reclaimedFrom;
            this.notifier.logWarning(
                'Reclaimed an abandoned remote sync reservation',
                new Error(`${from.ownerId} (${from.purpose}, lease ${from.leaseId}) stopped renewing with ${Math.ceil(from.remainingMs / 1000)}s left`),
            );
        }
        this.remoteMutationFence = lease;
        this.state.readCheckRemoteData = undefined;
        this.state.remoteDataForCompare = null;
        this.state.remoteLegacyAttachmentsChanged = false;
    }

    private async acquireAndAssertRemoteMutationFence(minRemainingMs?: number): Promise<void> {
        await this.ensureRemoteMutationFence();
        await this.assertRemoteMutationFenceHeld(minRemainingMs);
    }

    private async assertRemoteMutationFenceHeld(
        minRemainingMs = SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS,
    ): Promise<void> {
        if (!this.remoteMutationFence) return;
        await this.runRemoteMutationFenceOperation(
            'Remote sync mutation fence validation failed',
            () => this.remoteMutationFence!.assertHeld(minRemainingMs),
        );
    }

    private async runRemoteMutationFenceOperation<T>(message: string, operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (isSyncRemoteMutationFenceError(error)) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new SyncRemoteMutationFenceUnavailableError(`${message}: ${detail}`);
        }
    }

    private async releaseRemoteMutationFence(): Promise<number | null> {
        const lease = this.remoteMutationFence;
        this.remoteMutationFence = null;
        if (!lease) return null;
        try {
            await lease.release();
            return null;
        } catch (error) {


            this.notifier.logWarning('Failed to release remote sync mutation fence', error);
            const retryAfterMs = lease.retryAfterMs();
            this.requestFollowUpAfter(retryAfterMs, 'remote-fence-release');
            return retryAfterMs;
        }
    }

    private notifyFollowUp(reason: SyncFollowUpReason, data?: AppData, previousData?: AppData | null): void {
        try {
            this.notifier.onDiagnostic?.({ event: 'follow-up-requested', followUpReason: reason,
                data, previousData, extra: { step: this.state.step } });
        } catch {                                                    }
    }

    private requestFollowUp(reason: SyncFollowUpReason, data?: AppData, previousData?: AppData | null): void {
        if (this.options.activationProbe) return;
        this.hooks.requestFollowUp();
        this.notifyFollowUp(reason, data, previousData);
    }

    private requestFollowUpAfter(delayMs: number, reason: SyncFollowUpReason): void {
        if (this.options.activationProbe) return;
        if (this.hooks.requestFollowUpAfter) {
            this.hooks.requestFollowUpAfter(delayMs);
            this.notifyFollowUp(reason);
            return;
        }
        this.hooks.requestFollowUp();
        this.notifyFollowUp(reason);
    }

    private attachmentHelpers(
        phase: SyncRunAttachmentPhase,
        onTransferBatchDeferred?: () => void,
        activationContinuation = false,
    ) {
        return {
            ensureLocalSnapshotFresh: () => this.ensureLocalSnapshotFresh(),


            assertRemoteMutationFenceHeld: (minRemainingMs?: number) => (
                this.acquireAndAssertRemoteMutationFence(minRemainingMs)
            ),
            activationProbe: this.options.activationProbe === true,
            ...(activationContinuation ? { activationContinuation: true } : {}),
            onTransferBatchDeferred,
            phase,
            ...(this.options.activationProbe === true ? {} : { transferAdmission: this.transferAdmission }),
        };
    }

    private acceptCoveredLocalSnapshot(expectedData: AppData): boolean {
        if (!this.hooks.acceptCoveredSnapshot) return false;
        const currentChangeAt = this.store.getLastDataChangeAt();
        if (currentChangeAt <= this.state.localSnapshotChangeAt) return true;
        if (!this.hooks.acceptCoveredSnapshot(expectedData)) return false;
        this.state.localSnapshotChangeAt = currentChangeAt;
        return true;
    }

    private ensureLocalSnapshotFresh(expectedData?: AppData): void {
        ensureFreshLocalSyncSnapshot({
            localSnapshotChangeAt: this.state.localSnapshotChangeAt,
            getCurrentChangeAt: () => this.store.getLastDataChangeAt(),
            acceptCoveredSnapshot: expectedData && this.hooks.acceptCoveredSnapshot
                ? () => this.acceptCoveredLocalSnapshot(expectedData)
                : undefined,
            requestFollowUp: () => this.requestFollowUp('stale-local'),
            onStale: this.hooks.onStaleSnapshot
                ? (details) => this.hooks.onStaleSnapshot?.({ ...details, step: this.state.step })
                : undefined,
        });
    }

    private logPendingAttachmentUploads(message: string, phase: string, pending: ReturnType<typeof findPendingAttachmentUploads>): void {
        if (pending.length === 0) return;
        this.notifier.logWarningExtra(
            message,
            buildPendingAttachmentUploadLogExtra(
                this.backend,
                phase,
                pending,
                (value) => this.notifier.sanitizeLogMessage(value),
            ),
        );
    }


    private async readLocalDataForSyncCycle(): Promise<AppData> {
        const currentChangeAt = this.store.getLastDataChangeAt();
        if (this.state.localDataCache && this.state.localDataCache.changeAt === currentChangeAt) {
            this.state.localSnapshotChangeAt = currentChangeAt;
            return this.state.localDataCache.data;
        }
        const carried = this.policy.carryIdleCycleSnapshot ? this.carriedIdleSnapshot : null;
        if (
            carried
            && carried.scope === this.state.fastSyncScope
            && carried.changeAt === currentChangeAt
            && !this.state.preSyncedLocalData
            && !this.options.activationProbe


            && (await this.readFastSyncState(carried.scope))?.localFingerprint === carried.fingerprint
        ) {
            this.state.localSnapshotChangeAt = currentChangeAt;
            this.state.localDataCache = { changeAt: currentChangeAt, data: carried.data };
            this.state.localReadToken = carried.token;
            this.state.localSnapshotMatchesDisk = true;
            this.state.localDocumentFingerprint = { data: carried.data, fingerprint: carried.fingerprint };
            this.notifier.logInfo('Sync local reconcile', {
                reconcile: 'idle-cache',
                durationMs: '0',
                tasks: String(carried.data.tasks.length),
            });
            return carried.data;
        }


        const inMemorySnapshot = this.slicer && this.store.captureInMemorySnapshot
            ? await runSliced('sync:storeSnapshot', cloneAppDataPass(this.store.captureInMemorySnapshot()), this.slicer)
            : traceSection('sync:storeSnapshot', () => this.store.getInMemorySnapshot());


        let baseData: AppData;
        let matchesDisk = false;
        if (this.state.preSyncedLocalData) {
            const preSynced = this.state.preSyncedLocalData;
            const reconcileStart = Date.now();
            const aligned = computeSyncChangeFingerprint(preSynced) === computeSyncChangeFingerprint(inMemorySnapshot)
                && computeAttachmentIdentityDigest(preSynced) === computeAttachmentIdentityDigest(inMemorySnapshot);


            baseData = restoreDeviceLocalAiSettings(
                aligned ? preSynced : mergeAppData(preSynced, inMemorySnapshot),
                inMemorySnapshot,
            );
            this.notifier.logInfo('Sync local reconcile', {
                reconcile: aligned ? 'aligned-skip-presynced' : 'merged-presynced',
                durationMs: String(Date.now() - reconcileStart),
                tasks: String(baseData.tasks.length),
            });
        } else {

            if (this.slicedCycle) await this.store.flushPendingSave();
            const persisted = await traceSectionAsync('sync:readPersisted', () => (this.slicedCycle
                ? this.storage.readPersistedLocal({ onStale: () => this.staleDatabase() })
                : this.storage.readPersistedLocal()));
            if (this.slicedCycle) this.state.localReadToken = this.storage.readTokenOf?.(persisted);
            const reconcileStart = Date.now();
            const slicer = this.slicer;
            const aligned = slicer
                ? await runSliced('sync:reconcileCheck', computeSyncChangeFingerprintPass(persisted), slicer)
                    === await runSliced('sync:reconcileCheck', computeSyncChangeFingerprintPass(inMemorySnapshot), slicer)
                : traceSection('sync:reconcileCheck', () => computeSyncChangeFingerprint(persisted) === computeSyncChangeFingerprint(inMemorySnapshot));
            const reconciled = aligned ? persisted : traceSection('sync:reconcileMerge', () => mergeAppData(persisted, inMemorySnapshot));
            baseData = restoreDeviceLocalAiSettings(reconciled, inMemorySnapshot);


            matchesDisk = aligned && baseData === reconciled;


            this.notifier.logInfo('Sync local reconcile', {
                reconcile: aligned ? 'aligned-skip' : 'merged',
                durationMs: String(Date.now() - reconcileStart),
                tasks: String(baseData.tasks.length),
            });
        }
        const data = this.options.activationProbe
            ? baseData
            : await this.storage.injectExternalCalendars(baseData);


        this.state.localSnapshotChangeAt = currentChangeAt;
        this.state.localDataCache = {
            changeAt: currentChangeAt,
            data,
        };


        this.state.localSnapshotMatchesDisk = matchesDisk && data === baseData;
        return data;
    }


    private async persistLocalDataWithTracking(data: AppData | (() => AppData)): Promise<AppData> {
        if (this.slicedCycle && !this.state.localReadToken) {

            this.notifier.logWarning('Sliced sync save refused: no read token');
            throw new Error('Sliced sync save refused: no read token');
        }
        await this.assertRemoteMutationFenceHeld();


        let prepared: PreparedStorePublish | undefined;
        if (this.slicer && typeof data !== 'function') {
            const rows = this.storage.prepareLocalSave?.(data);
            if (rows) await runSliced('sync:prepareSave', rows, this.slicer);
            if (this.storage.applyDataToStore && this.storage.prepareStorePublish) {
                prepared = await runSliced('sync:preparePublish', this.storage.prepareStorePublish(data), this.slicer);
            }
        }
        return runSyncStoreSave(async (gateWaitMs) => {
            const heldAt = Date.now();

            const { persisted, staleDuringSave } = await traceSectionAsync('sync:commitPublish', async () => {


                await this.store.flushPendingSave();
                const next = typeof data === 'function' ? data() : data;
                this.ensureLocalSnapshotFresh(next);
                const committed = await traceSectionAsync('sync:saveData', () => (this.slicedCycle
                    ? this.storage.persistLocal(next, { token: this.state.localReadToken, onStale: () => this.staleDatabase() })
                    : this.storage.persistLocal(next))) ?? next;

                if (this.slicedCycle) this.state.localReadToken = this.storage.readTokenOf?.(next);


                this.state.localSnapshotMatchesDisk = false;


                let stale: unknown = null;
                try { this.ensureLocalSnapshotFresh(committed); } catch (error) { stale = error; }
                this.publishToStore(committed, gateWaitMs, prepared);
                return { persisted: committed, staleDuringSave: stale };
            });
            if (this.slicedCycle) this.state.publishedCommitMs.push(Date.now() - heldAt);
            this.state.wroteLocal = true;
            if (staleDuringSave) throw staleDuringSave;
            await this.storage.afterPersistLocal?.();
            return persisted;
        });
    }

    private publishToStore(data: AppData, gateWaitMs: number, prepared?: PreparedStorePublish): void {
        if (!this.storage.applyDataToStore) return;
        traceSection('sync:storePublish', () => {
            const swapped = prepared ? this.storage.applyDataToStore!(data, prepared) : this.storage.applyDataToStore!(data);
            if (prepared) this.state.publishedSwaps.push(swapped ? 'prepared' : 'in-gate');
            const currentChangeAt = this.store.getLastDataChangeAt();
            this.state.localSnapshotChangeAt = currentChangeAt;
            this.state.localDataCache = {
                changeAt: currentChangeAt,
                data: normalizeAppData(data),
            };
        });
        if (this.state.publishedStep === null) this.state.publishedStep = this.state.step ?? '-';
        this.state.publishedGateWaitsMs.push(gateWaitMs);
    }


    private logSavesPublished(): void {
        if (this.state.publishedStep === null) return;
        this.notifier.logInfo('Sync save published to the store', {
            backend: this.backend,
            step: this.state.publishedStep,
            gateWaitMs: this.state.publishedGateWaitsMs.join(','),
            releaseCheck: 'v1.3.7/sync-write-gate',
        });
    }


    private logSlices(): void {
        if (!this.slicer) return;
        const { slices, longestMs } = this.slicer.stats();
        this.notifier.logInfo('Sync cycle ran in slices', {
            backend: this.backend,
            slices: String(slices),
            longestSliceMs: String(Math.round(longestMs)),
            gateWaitMs: this.state.publishedGateWaitsMs.join(',') || '-',
            commitPublishMs: this.state.publishedCommitMs.join(',') || '-',
            storePublish: this.state.publishedSwaps.join(',') || '-',
            storeListeners: String(this.store.listenerCount?.() ?? '-'),
            requeue: this.state.requeueReason ?? 'none',
            releaseCheck: 'v1.3.7/native-sync-slices',
        });
    }

    private async persistPreSyncedDataAfterAbort(): Promise<void> {
        const preSynced = this.state.preSyncedLocalData;
        if (!preSynced || this.state.wroteLocal) return;

        await this.persistLocalDataWithTracking(() => {
            this.state.localSnapshotChangeAt = this.store.getLastDataChangeAt();
            const inMemorySnapshot = this.store.getInMemorySnapshot();
            return restoreDeviceLocalAiSettings(mergeAppData(preSynced, inMemorySnapshot), inMemorySnapshot);
        });
    }

    private async readRemoteForCycle(requireMutationFence = false): Promise<AppData | null> {
        if (requireMutationFence) {
            await this.ensureRemoteMutationFence();
        }
        if (this.state.readCheckRemoteData !== undefined) {
            const data = this.state.readCheckRemoteData;
            this.state.readCheckRemoteData = undefined;
            this.state.remoteDataForCompare = data;
            return data;
        }
        if (this.state.localOnlyUploadFingerprint) {


            this.state.remoteDataForCompare = null;
            this.state.remoteLegacyAttachmentsChanged = false;
            return null;
        }
        await this.ensureNetwork();
        try {
            const raw = await this.requireIo().readRemote();


            const parsed = raw == null ? null : traceSection('sync:parseRemote', () => parseSyncDocument(raw, 'remote'));
            this.state.remoteLegacyAttachmentsChanged = parsed?.ok === true
                && parsed.legacyAttachmentsChanged === true;
            if (parsed && !parsed.ok) {
                throw new Error(`Invalid remote sync payload: ${parsed.errors.slice(0, 3).join('; ')}`);
            }
            const data = parsed?.data ?? null;
            if (this.backend === 'webdav') {
                this.state.webdavRemoteCorrupted = false;
            }
            this.state.remoteDataForCompare = data;
            return data;
        } catch (error) {
            if (this.backend === 'webdav' && isWebdavInvalidJsonError(error)) {
                this.state.webdavRemoteCorrupted = true;
                this.state.remoteDataForCompare = null;
                this.state.remoteLegacyAttachmentsChanged = false;
                this.notifier.logWarning('WebDAV remote data.json appears corrupted; treating as missing for repair write', error);
                return null;
            }
            throw error;
        }
    }

    private async readRemoteFingerprint(): Promise<string | null> {
        await this.ensureNetwork();
        const io = this.requireIo();
        if (!io.readRemoteFingerprint) return null;
        return io.readRemoteFingerprint();
    }


    private assertLocalOnlyUploadIsCanonical(data: AppData): void {
        if (!this.state.localOnlyUploadFingerprint) return;


        const isDevelopment = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
        if (!isDevelopment) return;


        const parsedEmpty = parseSyncDocument({}, 'remote');
        const emptyRemote: AppData = parsedEmpty.ok
            ? parsedEmpty.data
            : { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
        const asWritten = toStableSyncJson(toRemoteSyncDocument(data));
        const asMerged = toStableSyncJson(toRemoteSyncDocument(mergeAppData(data, emptyRemote)));
        if (asWritten === asMerged) return;
        const message = 'Sync canonical-read invariant broken: the local-only upload fast path '
            + 'is about to publish a document the normalize pass would still change. A local '
            + 'write path is producing a non-canonical entity; see '
            + 'sync-canonical-reads.contract.test.ts.';
        this.notifier.logWarning(message);
        throw new Error(message);
    }

    private logWithheldSettingsStamps(
        settings: AppData['settings'] | undefined,
        outcome: 'unchanged-fast' | 'unchanged-read' | 'remote-write-skipped' | 'remote-written' | 'remote-written-server-contribution',
    ): void {
        if (!settings) return;
        const uploadedStamps = sanitizeAppDataForRemote({
            tasks: [], projects: [], sections: [], areas: [], people: [], settings,
        }).settings.syncPreferencesUpdatedAt ?? {};
        const withheldStampCount = Object.keys(settings.syncPreferencesUpdatedAt ?? {})
            .filter((group) => !(group in uploadedStamps)).length;
        if (withheldStampCount <= 0) return;
        this.notifier.logInfo('Sync upload withheld opted-out settings stamps', {
            releaseCheck: 'v1.3.9/opted-out-settings-stamps',
            backend: this.backend,
            withheldStampCount: String(withheldStampCount),
            outcome,
        });
    }

    private async writeRemoteForCycle(data: AppData): Promise<void> {
        this.assertLocalOnlyUploadIsCanonical(data);
        await this.ensureRemoteMutationFence();
        await this.assertRemoteMutationFenceHeld();
        await this.ensureNetwork();
        const state = this.state;
        state.lastRemoteWriteFingerprint = null;
        state.lastRemoteWriteMergedServerData = false;
        const pending = findPendingAttachmentUploads(data);
        if (this.backend === 'cloudkit') {


            this.logPendingAttachmentUploads('CloudKit sync has local-only file attachments', 'cloudkit-write', pending);
            assertNoPendingAttachmentContentReplacements(data);
        } else {
            this.logPendingAttachmentUploads('Remote write blocked by pending attachment uploads', 'remote-write', pending);
            assertNoPendingAttachmentUploads(data);
        }
        const remoteDocument = toRemoteSyncDocument(data);
        const previousRemoteData = state.remoteDataForCompare;
        const remoteNeedsTombstoneCompaction = state.remoteDataForCompare
            ? hasUncompactedPurgedTombstones(state.remoteDataForCompare)
            : false;
        if (!this.options.activationProbe
            && previousRemoteData
            && !remoteNeedsTombstoneCompaction
            && !state.remoteLegacyAttachmentsChanged
            && this.requireIo().requiresRemoteRepair?.() !== true

            && (await this.stableDocument(previousRemoteData)).json === (await this.stableDocument(data)).json) {
            if (this.backend !== 'cloudkit') {
                this.notifier.tracePayload?.('remote-write-skipped-unchanged', remoteDocument, { backend: this.backend });
            }
            this.logWithheldSettingsStamps(data.settings, 'remote-write-skipped');
            return;
        }
        if (this.backend === 'webdav' && state.webdavRemoteCorrupted) {
            this.notifier.logInfo('Repairing corrupted WebDAV data.json with current merged data');
        }
        let outcome: SyncRemoteWriteOutcome;
        try {
            await this.assertRemoteMutationFenceHeld(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            outcome = await this.requireIo().writeRemote(
                remoteDocument,
                (minRemainingMs) => this.assertRemoteMutationFenceHeld(minRemainingMs),
            );
        } catch (error) {
            if (error instanceof SyncRemoteWriteConflict) {

                this.requestFollowUp('remote-conflict');
                throw new LocalSyncAbort('remote-write-conflict', error.message);
            }
            throw error;
        }
        await this.assertRemoteMutationFenceHeld();
        const fingerprint = outcome && typeof outcome.fingerprint === 'string' && outcome.fingerprint.trim()
            ? outcome.fingerprint
            : null;
        const serverMergedRemoteData = Boolean(outcome && outcome.serverMergedRemoteData === true);
        state.lastRemoteWriteFingerprint = fingerprint;
        state.lastRemoteWriteMergedServerData = serverMergedRemoteData;
        this.logWithheldSettingsStamps(data.settings, serverMergedRemoteData ? 'remote-written-server-contribution' : 'remote-written');
        if (serverMergedRemoteData) {
            state.remoteDataForCompare = null;
            this.requestFollowUp('server-contribution', data, previousRemoteData);
        } else {
            state.remoteDataForCompare = remoteDocument;
        }
        state.remoteLegacyAttachmentsChanged = false;
        if (this.backend === 'webdav') {
            state.webdavRemoteCorrupted = false;
            this.notifier.tracePayload?.('remote-write-completed', remoteDocument, {
                backend: this.backend,
                remoteFingerprint: fingerprint ?? '',
            });
        }
    }

    private async persistUnchangedSyncStatus(): Promise<void> {
        this.hooks.onUnchangedSkip?.();
        this.store.setUiError(null);
        try {
            await this.storage.persistSyncStatus({
                lastSyncAt: this.nowIso(),
                lastSyncStatus: 'success',
                lastSyncError: undefined,
            });
        } catch (error) {
            this.notifier.logWarning('Failed to persist unchanged sync status', error);
        }
    }

    private hasPendingCycleSideEffects(data: AppData): boolean {
        if (hasPendingSyncSideEffects(data)) return true;
        if (!this.policy.attachmentPhasesEnabled
            || !this.hooks.runAttachmentCleanup
            || !hasFreshAttachmentCleanupWork(data)) return false;
        try {
            this.notifier.logInfo('Sync fast check retained fresh attachment cleanup', {
                releaseCheck: 'v1.3.5/sync-cleanup-fast-check',
                operation: 'attachment-cleanup',
                outcome: 'required',
            });
        } catch {                                                       }
        return true;
    }

    private async trySkipUnchangedFastSync(): Promise<SyncRunResult | null> {


        if (this.options.manual) return null;
        const scope = this.state.fastSyncScope;
        if (!scope) return null;
        this.setStep('fast-check');
        await this.yieldToUi();
        if (this.state.preSyncedLocalData || this.hooks.hasDeferredAttachmentWork?.()) return null;
        const localData = await this.readLocalDataForSyncCycle();
        this.ensureLocalSnapshotFresh();
        if (this.hasPendingCycleSideEffects(localData)) return null;

        const localFingerprint = await this.localDocumentFingerprint(localData);
        const cached = await this.readFastSyncState(scope);
        if (!cached || cached.localFingerprint !== localFingerprint) return null;

        let remoteFingerprint: string | null = null;
        try {
            remoteFingerprint = await this.readRemoteFingerprint();
        } catch (error) {
            this.notifier.logWarning('Sync fast check failed; falling back to full sync', error);
            return null;
        }
        if (!remoteFingerprint || remoteFingerprint !== cached.remoteFingerprint) return null;


        this.ensureLocalSnapshotFresh();
        await this.writeFastSyncState({
            scope,
            localFingerprint,
            remoteFingerprint,
            checkedAt: this.nowIso(),
        });
        await this.persistUnchangedSyncStatus();
        this.publishIdleCycleSnapshot(localData, localFingerprint);
        this.notifier.logInfo('Sync fast check found no changes', { backend: this.backend });
        this.logUnchangedCycleSkips('fast');
        return { success: true, skipped: 'unchanged' };
    }


    private async tryArmLocalOnlyUploadFastPath(): Promise<boolean> {


        if (this.options.manual) return false;

        if (this.options.ignorePendingRemoteWriteBackoff) return false;
        const scope = this.state.fastSyncScope;
        if (!scope) return false;
        const io = this.requireIo();
        if (!io.adoptRemoteFingerprintForWrite || !io.readRemoteFingerprint) return false;
        if (io.requiresRemoteRepair?.() === true) return false;


        if (!this.policy.preSyncAttachmentsBeforeFastCheck) return false;
        this.setStep('fast-check');
        await this.yieldToUi();


        if (this.state.preSyncedLocalData) return false;
        const localData = await this.readLocalDataForSyncCycle();
        this.ensureLocalSnapshotFresh();


        if (this.hasPendingCycleSideEffects(localData)) return false;

        const cached = await this.readFastSyncState(scope);
        if (!cached) return false;


        if (cached.localFingerprint === await this.localDocumentFingerprint(localData)) return false;

        let remoteFingerprint: string | null = null;
        try {
            remoteFingerprint = await this.readRemoteFingerprint();
        } catch (error) {
            this.notifier.logWarning('Sync fast check failed; falling back to full sync', error);
            return false;
        }
        if (!remoteFingerprint || remoteFingerprint !== cached.remoteFingerprint) return false;
        if (!io.adoptRemoteFingerprintForWrite(remoteFingerprint)) return false;


        this.ensureLocalSnapshotFresh();
        this.state.localOnlyUploadFingerprint = remoteFingerprint;
        this.notifier.logInfo('Sync uploading a local-only change without a remote read', {
            backend: this.backend,
        });
        return true;
    }


    private async trySkipUnchangedReadSync(): Promise<SyncRunResult | null> {
        this.setStep('read-check');
        await this.yieldToUi();


        if (this.state.preSyncedLocalData || this.hooks.hasDeferredAttachmentWork?.()) return null;
        const localData = await this.readLocalDataForSyncCycle();
        this.ensureLocalSnapshotFresh();
        if (this.hasPendingCycleSideEffects(localData)) return null;

        const remoteData = await this.readRemoteForCycle();
        this.ensureLocalSnapshotFresh();
        if (!remoteData) return null;
        this.state.readCheckRemoteData = remoteData;
        if (this.state.remoteLegacyAttachmentsChanged) return null;
        if (hasUncompactedPurgedTombstones(remoteData)) return null;


        const localFingerprint = await this.localDocumentFingerprint(localData);
        const remoteFingerprint = await this.documentFingerprint(remoteData);
        if (localFingerprint !== remoteFingerprint) return null;

        await this.recordFastSyncState(localData, { allowRemoteFingerprintRead: false });
        await this.persistUnchangedSyncStatus();
        this.publishIdleCycleSnapshot(localData, localFingerprint);
        this.state.readCheckRemoteData = undefined;
        this.notifier.logInfo('Sync read check found no changes', { backend: this.backend });
        this.logUnchangedCycleSkips('read');
        return { success: true, skipped: 'unchanged' };
    }

    private async recordFastSyncState(
        data: AppData,
        options: { allowRemoteFingerprintRead?: boolean } = {},
    ): Promise<void> {
        const scope = this.state.fastSyncScope;
        if (!scope || this.hasPendingCycleSideEffects(data)) return;
        if (this.store.getLastDataChangeAt() > this.state.localSnapshotChangeAt) return;
        if (this.state.lastRemoteWriteMergedServerData) return;

        let remoteFingerprint = this.io?.getCachedRemoteFingerprint?.() ?? null;
        if (!remoteFingerprint && this.state.lastRemoteWriteFingerprint) {
            remoteFingerprint = this.state.lastRemoteWriteFingerprint;
        }
        if (!remoteFingerprint) {
            if (options.allowRemoteFingerprintRead === false) return;
            try {
                remoteFingerprint = await this.readRemoteFingerprint();
            } catch (error) {
                this.notifier.logWarning('Failed to refresh sync fast-check state', error);
                return;
            }
        }
        if (!remoteFingerprint) return;
        await this.writeFastSyncState({
            scope,
            localFingerprint: await this.localDocumentFingerprint(data),
            remoteFingerprint,
            checkedAt: this.nowIso(),
        });
    }


    private async readFastSyncState(scope: string): Promise<FastSyncState | null> {
        const cached = this.state.fastSyncStateCache;
        if (cached && cached.scope === scope) return cached.value;
        const value = await this.storage.readFastSyncState(scope);
        this.state.fastSyncStateCache = { scope, value };
        return value;
    }

    private async writeFastSyncState(state: FastSyncState): Promise<void> {
        this.state.fastSyncStateCache = { scope: state.scope, value: state };
        await this.storage.writeFastSyncState(state);
    }


    private async localDocumentFingerprint(data: AppData): Promise<string> {
        const cached = this.state.localDocumentFingerprint;
        if (cached && cached.data === data) return cached.fingerprint;
        const fingerprint = await this.documentFingerprint(data);
        this.state.localDocumentFingerprint = { data, fingerprint };
        return fingerprint;
    }


    private readonly stableDocuments = new WeakMap<AppData, { json: string; fingerprint?: string }>();

    private async stableDocument(data: AppData): Promise<{ json: string; fingerprint?: string }> {
        const known = this.stableDocuments.get(data);
        if (known) return known;
        const json = await runSliced('sync:stableJson', remoteSyncDocumentStableJsonPass(data), this.slicer);

        const entry = this.stableDocuments.get(data) ?? { json };
        this.stableDocuments.set(data, entry);
        return entry;
    }

    private async documentFingerprint(data: AppData): Promise<string> {
        const entry = await this.stableDocument(data);
        entry.fingerprint ??= await runSliced('sync:fingerprint', fingerprintStableSyncJsonPass(entry.json), this.slicer);
        return entry.fingerprint;
    }


    private isLocalPersistUnchanged(data: AppData): boolean {
        if (this.options.activationProbe) return false;
        if (!this.state.localSnapshotMatchesDisk) return false;
        const stored = this.state.localDataCache?.data;
        if (!stored) return false;
        return isLocalPersistEquivalent(data, stored);
    }


    private logUnchangedCycleSkips(check: 'fast' | 'read'): void {
        const skippedPasses = ['local-persist', 'store-refresh', 'attachments'];
        if (!this.remoteMutationFence) skippedPasses.push('remote-fence');
        this.notifier.logInfo('Sync cycle changed nothing; passes skipped', {
            releaseCheck: 'v1.2.7/cycle-unchanged-skip',
            backend: this.backend,
            check,
            skipped: skippedPasses.join(','),
        });
        this.logWithheldSettingsStamps(this.store.getSettings(), `unchanged-${check}`);
    }


    private publishIdleCycleSnapshot(data: AppData, fingerprint: string): void {
        const scope = this.state.fastSyncScope;
        if (!this.policy.carryIdleCycleSnapshot) return;
        if (!scope || this.options.activationProbe) return;
        if (!this.state.localSnapshotMatchesDisk || this.state.wroteLocal) return;
        if (this.store.getLastDataChangeAt() !== this.state.localSnapshotChangeAt) return;
        idleCycleSnapshot = {
            scope,
            changeAt: this.state.localSnapshotChangeAt,
            data,
            fingerprint,
            token: this.state.localReadToken,
        };
    }

    private async runAttachmentPreSyncPhase(): Promise<void> {
        if (!this.policy.attachmentPhasesEnabled || this.options.activationProbe) return;
        try {
            const localData = await this.readLocalDataForSyncCycle();
            if (this.hooks.shouldRunAttachmentPhase
                && !(await this.hooks.shouldRunAttachmentPhase(localData, 'prepare'))) {
                return;
            }
            const io = this.requireIo();
            if (!io.syncAttachments) return;
            this.setStep('attachments_prepare');
            await this.yieldToUi();
            if (isRemoteSyncBackend(this.backend)) {
                await this.ensureNetwork();
            }


            const result = await this.syncAttachmentsKeepingUnreachable(localData, this.attachmentHelpers('prepare'));
            await this.assertRemoteMutationFenceHeld();
            const mutated = result === true || (Boolean(result) && typeof result === 'object');
            const mutatedData = result && typeof result === 'object' ? result : localData;
            if (mutated) {


                this.state.preSyncedLocalData = mutatedData;
                this.state.localDataCache = null;
                this.ensureLocalSnapshotFresh();
            }
            this.notifier.onDiagnostic?.({
                event: 'attachments-prepare-complete',
                data: mutatedData,
                extra: { mutated: String(mutated) },
            });
        } catch (error) {
            if (error instanceof LocalSyncAbort) throw error;
            if (isSyncRemoteMutationFenceError(error)) throw error;

            if (isSyncEncryptionPartlyEncryptedError(error)) throw error;
            if (isWebdavHostUploadLimitError(error) || isCloudHostUploadLimitError(error)) throw error;
            if (isHostResponseTooLargeError(error)) throw error;
            if (this.hooks.isCycleAborted?.()) throw error;
            if (isAttachmentUploadTooLargeError(error)) {
                this.state.fileAttachmentUploadBlocked = 'too-large';
                return;
            }
            this.state.hadAttachmentWarning = true;
            this.notifier.logWarning('Attachment pre-sync warning', error);
        }
    }


    private async prepareRemoteWriteData(data: AppData): Promise<AppData | typeof PREPARED_UNCHANGED> {
        if (this.options.activationProbe) {


            if (!this.policy.attachmentPhasesEnabled) return PREPARED_UNCHANGED;
            const activationSnapshot = prepareActivationAttachmentSnapshot(
                data,
                this.state.remoteDataForCompare,
                this.state.localDataCache?.data ?? null,
            );
            if (activationSnapshot.count === 0) return PREPARED_UNCHANGED;
            const io = this.requireIo();
            if (!io.syncAttachments) {
                throw new Error('Candidate backend cannot prove attachments');
            }
            const syncAttachments = io.syncAttachments;
            this.setStep('attachments_finalize');
            await this.yieldToUi();
            if (isRemoteSyncBackend(this.backend)) {
                await this.ensureNetwork();
            }
            await this.ensureRemoteMutationFence();
            let provenData = activationSnapshot.data;
            let result: AppData | boolean | null | undefined;
            let transferCalls = 0;
            let usedBatchContinuation = false;
            let fallbackRetries = 0;
            const consumedFallbackIds = new Set<string>();
            const countProofs = (candidate: AppData) => countActivationAttachmentProofs(
                candidate,
                activationSnapshot.expectedIds,
                activationSnapshot.metadataOnlyIds,
                activationSnapshot.noLocalBytesIds,
                this.backend,
            );
            const runTransferPass = async (candidate: AppData) => {
                const activationContinuation = transferCalls > 0;


                if (transferCalls > 0) {
                    await this.yieldToUi();
                    if (isRemoteSyncBackend(this.backend)) {
                        await this.ensureNetwork();
                    }


                    this.ensureLocalSnapshotFresh();
                    await this.assertRemoteMutationFenceHeld();
                }
                let transferBatchDeferred = false;
                result = await syncAttachments(
                    candidate,
                    this.attachmentHelpers('post-merge', () => {
                        transferBatchDeferred = true;
                    }, activationContinuation),
                );
                transferCalls += 1;
                await this.assertRemoteMutationFenceHeld();
                const nextData = result && typeof result === 'object'
                    ? result
                    : candidate;
                this.ensureLocalSnapshotFresh();
                return { data: nextData, deferred: transferBatchDeferred };
            };


            for (let primaryRounds = 0; primaryRounds < activationSnapshot.count; primaryRounds += 1) {
                const provenBeforeRound = countProofs(provenData);
                const primary = await runTransferPass(provenData);
                provenData = primary.data;

                const fallbackRetry = prepareActivationFallbackRetry(
                    provenData,
                    activationSnapshot.localFallbacks,
                    consumedFallbackIds,
                    !primary.deferred && this.backend === 'file',
                );
                fallbackRetries += fallbackRetry.count;
                if (fallbackRetry.count > 0) {
                    provenData = fallbackRetry.data;
                    let fallbackProven = countProofs(provenData);


                    for (let fallbackBatches = 0; fallbackBatches < fallbackRetry.count; fallbackBatches += 1) {
                        const fallback = await runTransferPass(provenData);
                        provenData = fallback.data;
                        const nextFallbackProven = countProofs(provenData);
                        const madeFallbackProgress = nextFallbackProven > fallbackProven;
                        fallbackProven = nextFallbackProven;
                        if (!fallback.deferred || !madeFallbackProgress) break;
                        usedBatchContinuation = true;
                    }
                }

                const madeRoundProgress = countProofs(provenData) > provenBeforeRound;
                if (!primary.deferred || !madeRoundProgress) break;
                usedBatchContinuation = true;
            }
            const unreachable = await this.readUnreachableAttachments();
            const { deferred: deferredIds, missing: missingIds } = assertActivationAttachmentsProven(
                provenData,
                activationSnapshot.expectedIds,
                activationSnapshot.metadataOnlyIds,
                activationSnapshot.noLocalBytesIds,
                this.backend,
                activationSnapshot.originalCloudKeys,
                activationSnapshot.noLocalFileIds,

                unreachable
                    ? new Set([
                        ...(this.options.acceptMissingAttachmentIds ?? []),
                        ...(unreachable.record[unreachable.scope] ?? []),
                    ])
                    : null,
            );
            if (missingIds.length > 0) {


                const accepted = new Set(missingIds);
                const merged = new Map<string, Attachment>();
                visitLiveFileAttachments(data, (attachment) => {
                    if (accepted.has(attachment.id)) merged.set(attachment.id, attachment);
                });


                const ownContent = new Map<string, Attachment>();
                if (this.state.localDataCache?.data) {
                    visitLiveFileAttachments(this.state.localDataCache.data, (attachment) => {
                        if (accepted.has(attachment.id) && attachment.cloudKey) ownContent.set(attachment.id, attachment);
                    });
                }
                provenData = replaceAttachments(provenData, accepted, (attachment) => {
                    const original = merged.get(attachment.id) ?? attachment;
                    const own = ownContent.get(attachment.id);
                    const content = own ? {
                        cloudKey: own.cloudKey,
                        fileHash: own.fileHash,
                        contentRev: own.contentRev,
                        contentMtimeMs: own.contentMtimeMs,
                        contentSize: own.contentSize,
                        size: own.size,
                        mimeType: own.mimeType,
                    } : {};
                    return { ...original, ...content, localStatus: 'missing', pendingContentUpload: undefined };
                });
                this.state.acceptedMissingAttachments = missingIds;
            }
            if (usedBatchContinuation) {
                this.notifier.logInfo(
                    'Sync activation proved attachments across transfer batches',
                    {
                        backend: this.backend,
                        total: String(activationSnapshot.count),
                        batches: String(transferCalls),
                    },
                );
            }
            if (deferredIds.length > 0) {
                this.notifier.logWarningExtra(
                    'Sync folder activation accepted attachments the folder does not hold yet',
                    {
                        releaseCheck: 'v1.2.8/file-activation-absent-blobs',
                        backend: this.backend,
                        deferred: String(deferredIds.length),
                        ids: deferredIds.slice(0, 5).join(','),
                    },
                );
            }
            this.ensureLocalSnapshotFresh();
            this.notifier.onDiagnostic?.({
                event: 'attachments-prepare-complete',
                data: provenData,
                extra: {
                    mutated: String(result === true || Boolean(result && typeof result === 'object')),
                    fallbackRetries: String(fallbackRetries),
                },
            });
            return provenData;
        }
        const pendingUploads = findPendingAttachmentUploads(data);
        if (pendingUploads.length === 0) return PREPARED_UNCHANGED;
        const io = this.requireIo();
        if (!io.syncAttachments) return PREPARED_UNCHANGED;

        this.setStep('attachments_finalize');
        await this.yieldToUi();
        this.notifier.logInfo('Attachment final sync start', {
            backend: this.backend,
            pending: String(pendingUploads.length),
        });
        if (isRemoteSyncBackend(this.backend)) {
            await this.ensureNetwork();
        }
        await this.ensureRemoteMutationFence();
        const result = await this.syncAttachmentsKeepingUnreachable(data, this.attachmentHelpers('post-merge'));
        await this.assertRemoteMutationFenceHeld();
        const nextData = result && typeof result === 'object' ? result : data;
        const remainingUploads = findPendingAttachmentUploads(nextData);
        this.notifier.logInfo('Attachment final sync done', {
            backend: this.backend,
            pending: String(remainingUploads.length),
        });
        this.logPendingAttachmentUploads(
            'Attachment uploads still pending after final sync',
            'attachments-finalize',
            remainingUploads,
        );
        return nextData;
    }


    private async readUnreachableAttachments(): Promise<{ scope: string; record: UnreachableAttachments } | null> {
        const scope = this.state.locationScope;
        if (!scope || !this.storage.readUnreachableAttachments || !this.storage.writeUnreachableAttachments) return null;
        const record = parseUnreachableAttachments(await this.storage.readUnreachableAttachments());
        rememberUnreachableAttachments(record, this.rememberedScope(scope));
        return { scope, record };
    }

    private async writeUnreachableAttachments(record: UnreachableAttachments, scope: string): Promise<void> {
        await this.storage.writeUnreachableAttachments?.(JSON.stringify(record));
        rememberUnreachableAttachments(record, this.rememberedScope(scope));
    }


    private rememberedScope(scope: string): string | undefined {
        return this.options.activationProbe ? undefined : scope;
    }


    private async recordAcceptedMissingAttachments(): Promise<void> {
        const accepted = this.state.acceptedMissingAttachments;
        if (accepted.length === 0) return;
        const unreachable = await this.readUnreachableAttachments();
        if (!unreachable) throw new Error('Activation accepted missing attachments without a record to keep them');
        const { scope, record } = unreachable;
        await this.writeUnreachableAttachments({
            ...record,
            [scope]: [...new Set([...(record[scope] ?? []), ...accepted])],
        }, scope);
        this.notifier.logInfo('Sync activation continued without attachment files', {
            releaseCheck: 'v1.3.8/activation-continue-without-files',
            backend: this.backend,
            missing: String(accepted.length),
        });
    }


    private async syncAttachmentsKeepingUnreachable(
        data: AppData,
        helpers: ReturnType<SharedSyncRunMachine['attachmentHelpers']>,
    ): Promise<AppData | boolean | null | undefined> {
        const syncAttachments = this.requireIo().syncAttachments!;
        const unreachable = await this.readUnreachableAttachments();
        if (!unreachable || Object.keys(unreachable.record).length === 0) return syncAttachments(data, helpers);
        const { scope, record } = unreachable;
        const ids = new Set(record[scope] ?? []);

        const before = new Map<string, Attachment>();
        visitLiveFileAttachments(data, (attachment) => {
            if (ids.has(attachment.id)) before.set(attachment.id, { ...attachment });
        });
        const result = await syncAttachments(data, helpers);
        const next = result && typeof result === 'object' ? result : result ? data : null;
        let restored = 0;
        if (next && before.size > 0) {
            for (const owner of [...next.tasks, ...next.projects]) {
                if (owner.deletedAt) continue;
                for (const attachment of owner.attachments ?? []) {
                    const original = before.get(attachment.id);
                    if (!original || !attachment.deletedAt) continue;

                    for (const field of Object.keys(attachment) as (keyof Attachment)[]) delete attachment[field];
                    Object.assign(attachment, original);
                    restored += 1;
                }
            }
        }
        const pruned = pruneUnreachableAttachments(record, next ?? data, scope);
        if (pruned !== record) await this.writeUnreachableAttachments(pruned, scope);
        if (restored === 0) return result;

        if (!this.state.keptAttachmentNotFoundLogged) {
            this.state.keptAttachmentNotFoundLogged = true;
            this.notifier.logInfo('Kept attachment not found at this sync location; row left as it is', {
                releaseCheck: 'v1.3.8/kept-attachment-not-found',
                backend: this.backend,
                restored: String(restored),
            });
        }
        return result !== true && sameAttachmentOwners(data, next!) ? false : result;
    }

    private async runPostMergeAttachmentPhase(
        mergedData: AppData,
        markFastSyncStateUnsafe: () => void,
    ): Promise<AppData> {
        if (this.options.activationProbe) return mergedData;
        if (!this.policy.attachmentPhasesEnabled) return mergedData;
        const io = this.requireIo();
        if (!io.syncAttachments) return mergedData;
        if (this.hooks.shouldRunAttachmentPhase
            && !(await this.hooks.shouldRunAttachmentPhase(mergedData, 'post-merge'))) {
            return mergedData;
        }

        this.setStep('attachments');
        await this.yieldToUi();
        let currentData = mergedData;
        try {
            this.ensureLocalSnapshotFresh();
            if (isRemoteSyncBackend(this.backend)) {
                await this.ensureNetwork();
            }
            await this.ensureRemoteMutationFence();


            const result = await this.syncAttachmentsKeepingUnreachable(currentData, this.attachmentHelpers('post-merge'));
            await this.assertRemoteMutationFenceHeld();
            const nextData = result && typeof result === 'object'
                ? result
                : result
                    ? currentData
                    : null;
            this.notifier.onDiagnostic?.({
                event: 'attachment-sync-applied',
                data: nextData ?? currentData,
                extra: { mutated: String(Boolean(nextData)) },
            });
            if (nextData) {
                this.ensureLocalSnapshotFresh();
                currentData = nextData;
                markFastSyncStateUnsafe();
                await this.persistLocalDataWithTracking(currentData);
                await this.yieldToUi();
            }
            return currentData;
        } catch (error) {
            if (error instanceof LocalSyncAbort) throw error;
            if (isSyncRemoteMutationFenceError(error)) throw error;

            if (isSyncEncryptionPartlyEncryptedError(error)) throw error;
            if (isWebdavHostUploadLimitError(error) || isCloudHostUploadLimitError(error)) throw error;
            if (isHostResponseTooLargeError(error)) throw error;
            if (isAttachmentUploadTooLargeError(error)) {
                this.state.fileAttachmentUploadBlocked = 'too-large';
                return currentData;
            }
            if (this.policy.postMergeAttachmentErrorPolicy === 'fail') throw error;
            this.state.hadAttachmentWarning = true;
            this.notifier.logWarning('Attachment sync warning', error);
            return currentData;
        }
    }

    private buildSyncCycleIO(keptAttachmentIds?: ReadonlySet<string>): SyncCycleIO {
        return {
            readLocal: async () => {
                const localData = await this.readLocalDataForSyncCycle();


                const data = this.options.activationProbe
                    ? withoutInheritedPendingRemoteWrite(localData)
                    : this.options.ignorePendingRemoteWriteBackoff
                        ? withoutInheritedPendingRemoteWriteBackoff(localData)
                        : localData;
                this.notifier.tracePayload?.('read-local', data, { backend: this.backend });
                return data;
            },
            readRemote: async () => {
                const data = await this.readRemoteForCycle(true);
                this.notifier.tracePayload?.('read-remote', data, { backend: this.backend });
                return data;
            },
            writeLocal: async (data) => {
                this.notifier.tracePayload?.('write-local', data, {
                    backend: this.backend,
                    step: this.state.step,
                });
                this.ensureLocalSnapshotFresh(data);
                if (this.options.activationProbe) {
                    return data;
                }
                return this.persistLocalDataWithTracking(data);
            },
            flushPendingLocalBeforeRetryRead: () => this.options.activationProbe
                ? Promise.resolve()
                : this.store.flushPendingSave(),
            isLocalPersistUnchanged: (data) => traceSection('sync:unchangedCheck', () => this.isLocalPersistUnchanged(data)),
            persistSyncStatusOnly: async (data) => {
                this.notifier.logInfo('Sync local write skipped; merged document matches stored', {
                    backend: this.backend,
                });
                await this.storage.persistSyncStatus({
                    lastSyncAt: data.settings.lastSyncAt,
                    lastSyncStatus: data.settings.lastSyncStatus,
                    lastSyncError: data.settings.lastSyncError,
                    lastSyncStats: data.settings.lastSyncStats,
                    lastSyncHistory: data.settings.lastSyncHistory,
                });
            },
            prepareRemoteWrite: (data) => this.prepareRemoteWriteData(data),
            writeRemote: async (data) => {
                this.notifier.tracePayload?.('write-remote', data, { backend: this.backend });
                this.ensureLocalSnapshotFresh(data);
                await this.writeRemoteForCycle(data);
            },
            preferIncomingAttachmentCloudKeys:
                this.options.ignorePendingRemoteWriteBackoff === true,
            preferIncomingAttachmentCloudKeyIds: keptAttachmentIds,


            skipEmptyRemoteMerge: () => this.state.localOnlyUploadFingerprint !== null,
            onStep: (next) => this.setStep(next),
            yieldToUi: this.notifier.yieldToUi ? () => this.notifier.yieldToUi!() : undefined,
            slicer: this.slicer,
            historyContext: {
                backend: this.backend,
                type: 'merge',
            },
        };
    }

    private async runMergePhase(): Promise<SyncRunResult> {
        this.hooks.onMergePhaseStart?.();


        const unreachable = this.options.activationProbe ? null : await this.readUnreachableAttachments().catch((error) => {
            this.notifier.logWarning('Kept attachment record could not be read before the merge', error);
            return null;
        });
        const keptIds = unreachable?.record[unreachable.scope];
        const syncResult = await this.performSyncCycleImpl(this.buildSyncCycleIO(keptIds?.length ? new Set(keptIds) : undefined));
        if (syncResult.status === 'skipped') {
            this.notifier.logInfo('Sync skipped while pending remote write backoff is active', {
                backend: this.backend,
                retryInMs: String(Math.ceil(syncResult.retryInMs)),
            });
            this.notifier.onDiagnostic?.({
                event: 'merge-skipped',
                data: syncResult.data,
                extra: { retryInMs: String(Math.ceil(syncResult.retryInMs)) },
            });
            return {
                success: true,
                skipped: 'pendingRemoteWriteBackoff',
                remoteWriteDeferred: true,
                error: syncResult.data.settings.lastSyncError,
            };
        }

        const stats = syncResult.stats;
        let mergedData = syncResult.data;
        this.notifier.onDiagnostic?.({
            event: 'merge-complete',
            data: mergedData,
            extra: {
                status: syncResult.status,

                tombstoneRepairs: String(stats.tombstoneRepairs ?? 0),
            },
        });
        this.notifier.tracePayload?.('core-result', mergedData, {
            backend: this.backend,
            areaStatsLocal: String(stats.areas.localTotal),
            areaStatsIncoming: String(stats.areas.incomingTotal),
            areaStatsMerged: String(stats.areas.mergedTotal),
            areaStatsIncomingOnly: String(stats.areas.incomingOnly),
        });
        const mergeLog = buildMergeSummaryLog(stats, { clockSkewThresholdMs: CLOCK_SKEW_THRESHOLD_MS });
        if (mergeLog) {
            this.notifier.logMergeSummary(mergeLog);
        }

        if (this.options.activationProbe) {
            await this.recordAcceptedMissingAttachments();
            return { success: true, stats };
        }

        let canRecordFastSyncState = true;
        const markFastSyncStateUnsafe = () => {
            canRecordFastSyncState = false;
        };
        this.ensureLocalSnapshotFresh(mergedData);
        await this.storage.persistExternalCalendars(mergedData);

        mergedData = await this.runPostMergeAttachmentPhase(mergedData, markFastSyncStateUnsafe);
        this.notifier.tracePayload?.('post-attachment', mergedData, { backend: this.backend });

        await this.hooks.cleanupAttachmentTempFiles?.();

        if (this.policy.attachmentPhasesEnabled
            && this.hooks.runAttachmentCleanup
            && (
                shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, this.cleanupIntervalMs)


                || hasFreshAttachmentCleanupWork(mergedData)
            )) {
            await this.ensureRemoteMutationFence();
            const cleanupResult = await this.hooks.runAttachmentCleanup(mergedData, {
                setStep: (step) => this.setStep(step),
                ensureLocalSnapshotFresh: (expectedData) => this.ensureLocalSnapshotFresh(expectedData),
                ensureNetworkStillAvailable: () => this.ensureNetwork(),
                assertRemoteMutationFenceHeld: (minRemainingMs?: number) => (
                    this.assertRemoteMutationFenceHeld(minRemainingMs)
                ),
            });
            await this.assertRemoteMutationFenceHeld();


            this.ensureLocalSnapshotFresh(mergedData);
            if (cleanupResult) {
                mergedData = cleanupResult.data;
                if (cleanupResult.invalidateFastSyncState) {
                    markFastSyncStateUnsafe();
                }
                await this.persistLocalDataWithTracking(mergedData);
            }
        }

        if (canRecordFastSyncState) {
            await this.recordFastSyncState(mergedData);
        }

        this.setStep('refresh');
        await this.yieldToUi();
        this.ensureLocalSnapshotFresh(mergedData);
        await this.assertRemoteMutationFenceHeld();
        const localWriteSkipped = syncResult.localWriteSkipped && !this.state.wroteLocal ? true : undefined;
        await this.hooks.finalizeSuccess(mergedData, {
            status: syncResult.status,
            wroteLocal: this.state.wroteLocal,
            localWriteSkipped,
            getLocalSnapshotChangeAt: () => this.state.localSnapshotChangeAt,
            acceptCoveredSnapshot: (expectedData) => this.acceptCoveredLocalSnapshot(expectedData),
        });
        const attachmentWriteDeferred = findPendingAttachmentUploads(mergedData)
            .some((pending) => pending.reason === 'content-replacement');
        if (mergedData.settings.pendingRemoteWriteRetryAt) {
            return {
                success: true,
                remoteWriteDeferred: true,
                attachmentWriteDeferred: attachmentWriteDeferred || undefined,
                fileAttachmentUploadBlocked: this.state.fileAttachmentUploadBlocked ?? undefined,
                error: mergedData.settings.lastSyncError,
                localWriteSkipped,
                stats,
            };
        }
        return {
            success: true,
            attachmentWriteDeferred: attachmentWriteDeferred || undefined,
            fileAttachmentUploadBlocked: this.state.fileAttachmentUploadBlocked ?? undefined,
            localWriteSkipped,
            stats,
        };
    }

    private async handleRunError(error: unknown): Promise<SyncRunResult> {
        if (isAttachmentUploadTooLargeError(error)) {
            return {
                success: !this.options.activationProbe,
                fileAttachmentUploadBlocked: 'too-large',
            };
        }
        if (error instanceof SyncFileLockBusyError) {
            const retryAttempt = this.options.fileSyncLockBusyRetryAttempt ?? 0;
            if (!this.options.activationProbe && retryAttempt < 1) {
                if (this.hooks.requestFileSyncLockBusyFollowUpAfter) {
                    this.hooks.requestFileSyncLockBusyFollowUpAfter(error.retryAfterMs, retryAttempt + 1);
                    this.notifyFollowUp('file-lock-busy');
                }
            }
            return {
                success: true,
                skipped: 'fileSyncLockBusy',
                fileSyncLockDeferred: 'busy',
                retryAfterMs: error.retryAfterMs,
            };
        }
        if (error instanceof SyncRemoteMutationFenceBusyError) {


            this.notifier.logWarning('Remote sync location is reserved; retrying after the lease lapses', error);
            if (!this.options.activationProbe) this.requestFollowUpAfter(error.retryAfterMs, 'remote-fence-busy');
            return {
                success: true,
                skipped: 'remoteFenceBusy',
                remoteFenceDeferred: 'busy',
                retryAfterMs: error.retryAfterMs,
            };
        }
        const errorContext: SyncRunErrorContext = {
            step: this.state.step,
            getWroteLocal: () => this.state.wroteLocal,

            persistPreSyncedData: () => (this.slicedCycle ? Promise.resolve() : this.persistPreSyncedDataAfterAbort()),
        };
        const beforeResult = this.options.activationProbe
            ? null
            : await this.hooks.handleRunErrorBeforeRequeue?.(error, errorContext);
        if (beforeResult) return beforeResult;

        if (error instanceof LocalSyncAbort) {


            if (!this.options.activationProbe && !this.slicedCycle) {
                await this.persistPreSyncedDataAfterAbort();
            }


            this.state.requeueReason = error.reason;
            this.notifier.logInfo('Sync cycle requeued', {
                backend: this.backend,
                step: this.state.step ?? '-',
                reason: error.reason,
                detail: error.detail ?? '-',
                activationProbe: String(this.options.activationProbe === true),
            });
            this.notifier.onDiagnostic?.({
                event: 'requeued',
                extra: {
                    step: this.state.step,
                    wroteLocal: String(this.state.wroteLocal),
                },
            });
            return { success: true, skipped: 'requeued' };
        }

        const afterResult = await this.hooks.handleRunErrorAfterRequeue?.(error, errorContext);
        if (afterResult) return afterResult;

        const fileSyncLockUnavailable = error instanceof SyncFileLockUnavailableError;
        const fileGenerationCorrupt = isSyncFileGenerationCorruptError(error);
        this.notifier.logWarning('Sync failed', error);
        if (this.options.activationProbe) {
            return {
                success: false,

                error: this.hooks.formatErrorMessage(error instanceof ActivationAttachmentProofError ? new Error(error.displayMessage) : error, this.backend),
                ...(error instanceof ActivationMissingAttachmentsError ? { activationMissingAttachments: error.attachments } : {}),
                ...(fileSyncLockUnavailable ? { fileSyncLockUnavailable: true } : {}),
                ...(fileGenerationCorrupt ? { fileGenerationCorrupt: true } : {}),
            };
        }
        const now = this.nowIso();
        const safeMessage = this.hooks.formatErrorMessage(error, this.backend);
        let logHint = '';
        try {
            const logPath = await this.notifier.logSyncError(error, {
                backend: this.backend,
                step: this.state.step,
                url: this.io?.getSyncUrl?.(),
            });
            logHint = logPath ? ` (log: ${logPath})` : '';
        } catch (logError) {
            this.notifier.logWarning('Failed to write sync error log', logError);
        }
        const finalErrorMessage = `${safeMessage}${logHint}`;
        const historyEntry: SyncHistoryEntry = {
            at: now,
            status: 'error',
            backend: this.backend,
            type: 'merge',
            conflicts: 0,
            conflictIds: [],
            maxClockSkewMs: 0,
            timestampAdjustments: 0,
            details: this.state.step,
            error: finalErrorMessage,
        };
        const nextHistory = appendSyncHistory(this.store.getSettings(), historyEntry);
        try {
            await this.hooks.finalizeErrorStatus({
                at: now,
                message: finalErrorMessage,
                step: this.state.step,
                history: nextHistory,
                wroteLocal: this.state.wroteLocal,
            });
        } catch (persistError) {
            this.notifier.logWarning('Failed to persist sync error', persistError);
        }
        return {
            success: false,
            error: finalErrorMessage,
            ...(fileSyncLockUnavailable ? { fileSyncLockUnavailable: true } : {}),
            ...(fileGenerationCorrupt ? { fileGenerationCorrupt: true } : {}),
        };
    }
}

export const runSharedSyncCycle = async (ports: SyncRunPorts): Promise<SyncRunResult> => {
    return new SharedSyncRunMachine(ports).run();
};


export const createDefaultSyncRunStoreBridge = (): SyncRunStoreBridge => ({
    getLastDataChangeAt: () => useTaskStore.getState().lastDataChangeAt,
    getInMemorySnapshot: () => getInMemoryAppDataSnapshot(),
    captureInMemorySnapshot: () => captureInMemoryAppDataSnapshot(),
    listenerCount: () => getStoreListenerCount(),
    flushPendingSave: () => flushPendingSave(),
    setUiError: (message) => useTaskStore.getState().setError(message),
    getSettings: () => useTaskStore.getState().settings,
});
