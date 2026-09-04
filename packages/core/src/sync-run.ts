import type { AppData, Attachment } from './types';
import type { CloudProvider } from './sync-client-helpers';
import type { SyncBackend } from './sync-service-utils';
import {
    isSyncFileGenerationCorruptError,
    SyncFileLockBusyError,
    SyncFileLockUnavailableError,
} from './sync-service-utils';
import type { FastSyncState } from './sync-fast-sync';
import type { SyncCycleIO, SyncCycleResult, SyncHistoryEntry } from './sync-types';
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
} from './sync-run-ports';
import { SyncRemoteWriteConflict } from './sync-run-ports';
import { LocalSyncAbort, ensureFreshLocalSyncSnapshot, getInMemoryAppDataSnapshot, shouldRunAttachmentCleanup } from './sync-client-helpers';
import { hasFreshAttachmentCleanupWork } from './attachment-cleanup';
import { isAttachmentUploadTooLargeError } from './attachment-transfer';
import { flushPendingSave, useTaskStore } from './store';
import {
    assertNoPendingAttachmentContentReplacements,
    assertNoPendingAttachmentUploads,
    computeSyncChangeFingerprint,
    findPendingAttachmentUploads,
    hasPendingSyncSideEffects,
    isLocalPersistEquivalent,
    toStableSyncJson,
} from './sync-helpers';
import {
    areRemoteSyncDocumentsEqual,
    computeRemoteSyncDocumentFingerprint,
    parseSyncDocument,
    toRemoteSyncDocument,
} from './sync-document';
import { buildHttpRemoteFileFingerprint } from './webdav';
import type { RemoteJsonWriteResult } from './webdav';
import type { CloudJsonWriteResult } from './cloud';
import { normalizeAppData } from './sync-normalization';
import { isWebdavInvalidJsonError } from './retry-utils';
import { isRemoteSyncBackend } from './sync-service-utils';
import { cloneAppData } from './sync-runtime-utils';
import { buildMergeSummaryLog, buildPendingAttachmentUploadLogExtra } from './sync-log-utils';
import { CLOCK_SKEW_THRESHOLD_MS } from './sync-types';
import { appendSyncHistory, mergeAppData, performSyncCycle } from './sync';
import { hasUncompactedPurgedTombstones } from './tombstone-compaction';
import {
    isSyncRemoteMutationFenceError,
    SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS,
    SyncRemoteMutationFenceBusyError,
    SyncRemoteMutationFenceUnavailableError,
    type SyncRemoteMutationFenceLease,
} from './sync-remote-fence';

/**
 * ADR 0014 — the platform-independent sync cycle state machine.
 *
 * Owns the phase sequence both apps used to duplicate: flush → backend setup →
 * unchanged-skip checks → attachment pre-sync → core merge cycle → post-merge
 * attachments → periodic cleanup → fast-sync bookkeeping → refresh, plus the
 * LocalSyncAbort requeue and error/history shaping around it. Transport,
 * platform storage, and UI notification arrive through the ports in
 * `sync-run-ports.ts`. Behavior was transplanted from the desktop `SyncRun`
 * and `MobileSyncRun` implementations; deliberate platform divergences are
 * expressed as `SyncRunPolicy` switches and optional hooks, not re-decided here.
 */

type RemoteWriteResultLike = Partial<RemoteJsonWriteResult & CloudJsonWriteResult>;

/** Normalize a backend transport write result (ETag/Last-Modified headers or an
 *  explicit fingerprint) into the machine's remote-write outcome shape. */
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
    /** `localDataCache.data` is byte-identical to the persisted document, so a
     *  write of content-equal data can be skipped. False whenever the snapshot
     *  was reconciled from the in-memory store, carries attachment pre-sync
     *  patches, or the cycle has written since. */
    localSnapshotMatchesDisk: boolean;
    localDocumentFingerprint: { data: AppData; fingerprint: string } | null;
    fastSyncStateCache: { scope: string; value: FastSyncState | null } | null;
    preSyncedLocalData: AppData | null;
    wroteLocal: boolean;
    remoteDataForCompare: AppData | null;
    readCheckRemoteData: AppData | undefined;
    /** Set by `tryArmLocalOnlyUploadFastPath` once the remote is proven
     *  unchanged since this device's last cycle: the document read is then
     *  answered as "absent" so the merge normalizes local instead. */
    localOnlyUploadFingerprint: string | null;
    lastRemoteWriteFingerprint: string | null;
    lastRemoteWriteMergedServerData: boolean;
    webdavRemoteCorrupted: boolean;
    hadAttachmentWarning: boolean;
    fileAttachmentUploadBlocked: 'too-large' | null;
};

const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Stable digest of every attachment a document carries, keyed by owner id.
 *  The change fingerprint stops at the owner's revision tuple, so this is what
 *  covers the fields attachment merging actually arbitrates — `cloudKey`,
 *  `contentRev`, `fileHash`, `localStatus`, `pendingContentUpload`, the
 *  recorded stats — without naming them one by one (a list that rots the
 *  moment a new attachment field is added). Free for a document with no
 *  attachments, which is most of them. */
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

/**
 * The local document a previous cycle read and then concluded was unchanged,
 * carried into the next cycle so a run of idle cycles reads SQLite, clones the
 * store and stable-serializes the document once instead of every time (#766).
 *
 * The invariant it rests on: every write that changes the local document bumps
 * the store's `lastDataChangeAt` first — the same stamp `readLocalDataForSyncCycle`
 * and `ensureFreshLocalSyncSnapshot` already key on, and the one desktop's
 * local-data-watcher bumps when another process writes the database. Sync
 * status bookkeeping is deliberately exempt from that stamp and is exactly what
 * this snapshot must not be trusted for, which is why only cycles that skipped
 * (and therefore never wrote a document) publish one.
 *
 * ponytail: one retained AppData per process. Drop it to a fingerprint-only
 * cache if the retained copy ever shows up in a memory profile.
 */
let idleCycleSnapshot: { scope: string; changeAt: number; data: AppData; fingerprint: string } | null = null;

/** Hand the snapshot to the starting run and drop it: only a run that reaches
 *  an unchanged-skip publishes a new one, so any run that writes, errors or
 *  merges leaves the next cycle with nothing to reuse. */
const takeIdleCycleSnapshot = (): typeof idleCycleSnapshot => {
    const carried = idleCycleSnapshot;
    idleCycleSnapshot = null;
    return carried;
};

/** Test seam: a store replaced wholesale (import, restore, sign-out) must not
 *  leave a stale document behind for the next cycle. */
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

/** A candidate winner may still have an identical managed copy on this device.
 *  Hash + content revision are the only cross-backend proof that those local
 *  bytes are safe to publish if the candidate object turns out to be missing. */
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
    /** The key each record carried before the trial cleared it, so a refusal can
     *  still say which sync location the file lives on (#1151). */
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
    const originalCloudKeys = new Map<string, string>();
    const count = visitLiveFileAttachments(candidate, (attachment) => {
        expectedIds.add(attachment.id);
        const candidateAttachment = candidateAttachments.get(attachment.id);
        const localAttachment = localAttachments.get(attachment.id);
        const originalKey = candidateAttachment?.cloudKey || localAttachment?.cloudKey || attachment.cloudKey;
        if (originalKey) originalCloudKeys.set(attachment.id, originalKey);
        // This device holds no bytes for the record (never had it, or already knew
        // the file is missing) and cannot reach it on the previous backend either.
        const noLocalBytes = !localAttachment?.cloudKey
            && (!localAttachment || !localAttachment.uri?.trim() || localAttachment.localStatus === 'missing');
        if (noLocalBytes) noLocalBytesIds.add(attachment.id);
        // ...and the candidate has no blob for it: metadata only, nowhere to fetch from.
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
        // Only a key read from the candidate destination belongs to that
        // destination. A local/previous-backend key is cleared so the adapter
        // creates the missing candidate blob; a candidate key is preserved so
        // stale local bytes can never replace an already-present remote winner.
        // If the merged content identity instead came from the local snapshot,
        // retain that destination key but explicitly require the adapter to
        // replace its older blob before publishing the merged metadata.
        attachment.cloudKey = candidateAttachment?.cloudKey;
        attachment.pendingContentUpload = mustReplaceCandidateBlob ? true : undefined;
        // A candidate-remote winner must be downloaded even when an unrelated
        // local file exists at the merged uri. Clearing only this temporary clone's
        // uri makes successful download the proof and prevents localStatus alone
        // from turning a missing candidate object into a false positive.
        if (candidateAttachment?.cloudKey && !mustReplaceCandidateBlob) {
            attachment.uri = '';
        }
        attachment.localStatus = 'missing';
    });
    return { data: candidate, count, expectedIds, localFallbacks, metadataOnlyIds, noLocalBytesIds, originalCloudKeys };
};

const prepareActivationFallbackRetry = (
    data: AppData,
    localFallbacks: ReadonlyMap<string, Attachment>,
): { data: AppData; count: number } => {
    if (localFallbacks.size === 0) return { data, count: 0 };
    const retryData = cloneAppData(data);
    let count = 0;
    for (const owner of [...retryData.tasks, ...retryData.projects]) {
        if (owner.deletedAt) continue;
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind !== 'file' || !attachment.deletedAt) continue;
            const fallback = localFallbacks.get(attachment.id);
            if (!fallback) continue;
            // The adapter exposes both remote 404 and local-read failure as an
            // untyped tombstone. Restore only the pre-proven local identity and
            // give the adapter one bounded upload attempt; final proof below
            // rejects any tombstone that survives this retry.
            Object.assign(attachment, fallback);
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

/** The refusal names the file and its owner, and says why (#1151): a UUID alone
 *  sent a reporter to curl and jq against /v1/data to find the task. */
const describeUnprovenAttachment = (
    ownerType: 'task' | 'project',
    owner: { title?: string },
    attachment: Attachment,
    backend: SyncBackend,
    originalCloudKey: string | undefined,
): string => {
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
    return `Candidate attachment proof failed for ${attachment.id} ("${name}"${where}): ${reason}`;
};

const assertActivationAttachmentsProven = (
    data: AppData,
    expectedIds: ReadonlySet<string>,
    metadataOnlyIds: ReadonlySet<string>,
    noLocalBytesIds: ReadonlySet<string>,
    backend: SyncBackend,
    originalCloudKeys: ReadonlyMap<string, string>,
): string[] => {
    const resolved = new Set<string>();
    const deferred: string[] = [];
    const owners: Array<['task' | 'project', { title?: string; deletedAt?: string; attachments?: Attachment[] }]> = [
        ...data.tasks.map((task) => ['task', task] as ['task', typeof task]),
        ...data.projects.map((project) => ['project', project] as ['project', typeof project]),
    ];
    for (const [ownerType, owner] of owners) {
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind !== 'file') continue;
            if (owner.deletedAt || attachment.deletedAt) {
                if (expectedIds.has(attachment.id)) {
                    // Adapters expose a terminal remote 404 and a local-read failure
                    // as the same untyped tombstone. Without local bytes there is
                    // nothing to misread, so the tombstone can only be the remote
                    // outcome every established device converges to (#1119). With
                    // local bytes involved it stays a refusal (the exact-copy retry
                    // above already had its one attempt).
                    if (!noLocalBytesIds.has(attachment.id)) {
                        throw new Error(describeUnprovenAttachment(ownerType, owner, attachment, backend, originalCloudKeys.get(attachment.id)));
                    }
                    resolved.add(attachment.id);
                }
                continue;
            }
            // Metadata-only record that the trial could not turn into bytes either:
            // nothing this device does can prove it, and the switch cannot strand it
            // further. sanitizeAppDataForRemote tombstones exactly this shape at every
            // write, so activation reaches the same outcome an established device
            // would instead of refusing forever.
            if (
                metadataOnlyIds.has(attachment.id)
                && !attachment.cloudKey
                && attachment.localStatus === 'missing'
                && attachment.pendingContentUpload !== true
            ) {
                if (expectedIds.has(attachment.id)) resolved.add(attachment.id);
                continue;
            }
            // File Sync: a blob the folder does not hold yet is not a verdict. A
            // replicator (Syncthing, a mounted drive) can deliver it after the
            // switch, and this device holds no bytes that waiting could lose. Keep
            // the key, leave the record missing for a later cycle to download,
            // instead of refusing the folder forever (a fresh desktop joining a
            // folder whose attachments/ had not arrived, 2026-09-04 feedback).
            if (
                backend === 'file'
                && noLocalBytesIds.has(attachment.id)
                && attachment.cloudKey
                && attachment.localStatus === 'missing'
                && attachment.pendingContentUpload !== true
            ) {
                deferred.push(attachment.id);
                if (expectedIds.has(attachment.id)) resolved.add(attachment.id);
                continue;
            }
            if (
                !attachment.cloudKey
                || attachment.localStatus !== 'available'
                || attachment.pendingContentUpload === true
            ) {
                throw new Error(describeUnprovenAttachment(ownerType, owner, attachment, backend, originalCloudKeys.get(attachment.id)));
            }
            if (expectedIds.has(attachment.id)) resolved.add(attachment.id);
        }
    }
    // An expected attachment that vanished without a tombstone is a silent drop
    // and still refuses the activation.
    if (resolved.size !== expectedIds.size) {
        throw new Error(`Candidate attachment proof incomplete: expected ${expectedIds.size}, proved ${resolved.size}`);
    }
    return deferred;
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
    private readonly state: SharedSyncRunState = {
        backend: 'off',
        cloudProvider: 'selfhosted',
        step: 'init',
        fastSyncScope: null,
        localSnapshotChangeAt: 0,
        localDataCache: null,
        localSnapshotMatchesDisk: false,
        localDocumentFingerprint: null,
        fastSyncStateCache: null,
        preSyncedLocalData: null,
        wroteLocal: false,
        remoteDataForCompare: null,
        readCheckRemoteData: undefined,
        localOnlyUploadFingerprint: null,
        lastRemoteWriteFingerprint: null,
        lastRemoteWriteMergedServerData: false,
        webdavRemoteCorrupted: false,
        hadAttachmentWarning: false,
        fileAttachmentUploadBlocked: null,
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
    }

    async run(): Promise<SyncRunResult> {
        let result!: SyncRunResult;
        let cleanupRetryAfterMs: number | null = null;
        try {
            try {
                result = await this.runPhases();
            } catch (error) {
                result = await this.handleRunError(error);
            }
        } finally {
            cleanupRetryAfterMs = await this.releaseRemoteMutationFence();
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
            // Callers must be able to tell "nothing to do, sync is off" from a
            // completed sync — a manual "Sync now" with sync off must not toast
            // "Sync completed" (#1001).
            return { success: true, skipped: 'disabled' };
        }
        this.state.backend = setup.backend;
        this.state.cloudProvider = setup.cloudProvider ?? 'selfhosted';
        this.state.fastSyncScope = setup.fastSyncScope;
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
        if (skipResult) {
            return skipResult;
        }
        if (!this.policy.preSyncAttachmentsBeforeFastCheck) {
            await this.runAttachmentPreSyncPhase();
        }
        return this.runMergePhase();
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

    /** Lazily acquire only when a run is about to enter a mutation-capable
     *  path. A read-check performed before acquisition is advisory only: once
     *  the fence is held, discard it and take the authoritative read again. */
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
            // Release is conditional, so an error can never justify deleting
            // whatever generation is now present. A crashed lease is bounded
            // by its server-time expiry; request a later retry and surface the
            // delayed availability without rewriting an otherwise valid run.
            this.notifier.logWarning('Failed to release remote sync mutation fence', error);
            const retryAfterMs = lease.retryAfterMs();
            this.requestFollowUpAfter(retryAfterMs);
            return retryAfterMs;
        }
    }

    private requestFollowUp(): void {
        if (this.options.activationProbe) return;
        this.hooks.requestFollowUp();
    }

    private requestFollowUpAfter(delayMs: number): void {
        if (this.options.activationProbe) return;
        if (this.hooks.requestFollowUpAfter) {
            this.hooks.requestFollowUpAfter(delayMs);
            return;
        }
        this.hooks.requestFollowUp();
    }

    private attachmentHelpers(phase: SyncRunAttachmentPhase) {
        return {
            ensureLocalSnapshotFresh: () => this.ensureLocalSnapshotFresh(),
            // Acquire-on-first-use, not acquire-on-entry. Every attachment
            // backend calls this immediately before each remote mutation, so
            // the fence is still held before anything is written; a pass that
            // turns out to have nothing to upload or delete — the steady state
            // for anyone who owns an attachment — now issues no fence PUT and
            // no fence DELETE at all.
            assertRemoteMutationFenceHeld: (minRemainingMs?: number) => (
                this.acquireAndAssertRemoteMutationFence(minRemainingMs)
            ),
            activationProbe: this.options.activationProbe === true,
            phase,
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
            requestFollowUp: () => this.requestFollowUp(),
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

    /** Local snapshot for this cycle: persisted data (or the attachment
     *  pre-sync result) reconciled with the in-memory store, calendars
     *  injected, cached until the store's change stamp moves. */
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
            // Proof that the carried document describes THIS location's disk and
            // not some other store that happened to share a scope and a change
            // stamp: the cycle that published it wrote the same fingerprint into
            // the durable fast-sync record that lives beside the data.
            && (await this.readFastSyncState(carried.scope))?.localFingerprint === carried.fingerprint
        ) {
            this.state.localSnapshotChangeAt = currentChangeAt;
            this.state.localDataCache = { changeAt: currentChangeAt, data: carried.data };
            this.state.localSnapshotMatchesDisk = true;
            this.state.localDocumentFingerprint = { data: carried.data, fingerprint: carried.fingerprint };
            this.notifier.logInfo('Sync local reconcile', {
                reconcile: 'idle-cache',
                durationMs: '0',
                tasks: String(carried.data.tasks.length),
            });
            return carried.data;
        }
        const inMemorySnapshot = this.store.getInMemorySnapshot();
        // The persisted-vs-in-memory reconcile is a full-library merge — the
        // single most expensive step of an idle cycle at whale scale — and after
        // the flush at cycle start the two sides are almost always identical.
        // When the change fingerprint (per-entity id|rev|revBy|updatedAt|
        // deletedAt|purgedAt + sanitized settings) matches, use the persisted
        // side directly, NOT the in-memory snapshot: persisted is the previous
        // cycle's merge output, so its byte shape matches the recorded
        // fast-sync localFingerprint — the raw store snapshot has no such
        // guarantee on platforms without applyDataToStore, and handing it back
        // would make the fast-check miss forever. Content diverging at
        // identical revision metadata is deferred to the next changed cycle,
        // the same trust reconcileEntityCollection already places in this
        // tuple (#766). The attachment pre-sync branch cannot use the change
        // fingerprint alone: its patches change fields that tuple does not
        // cover (cloudKey, localStatus, contentRev), so it pairs the
        // fingerprint with a digest of every attachment on both sides and
        // merges whenever either differs.
        let baseData: AppData;
        let matchesDisk = false;
        if (this.state.preSyncedLocalData) {
            const preSynced = this.state.preSyncedLocalData;
            const reconcileStart = Date.now();
            const aligned = computeSyncChangeFingerprint(preSynced) === computeSyncChangeFingerprint(inMemorySnapshot)
                && computeAttachmentIdentityDigest(preSynced) === computeAttachmentIdentityDigest(inMemorySnapshot);
            // The pre-synced side carries this cycle's attachment patches, so it
            // is the side that must survive — exactly as `persisted` is below.
            baseData = aligned ? preSynced : mergeAppData(preSynced, inMemorySnapshot);
            this.notifier.logInfo('Sync local reconcile', {
                reconcile: aligned ? 'aligned-skip-presynced' : 'merged-presynced',
                durationMs: String(Date.now() - reconcileStart),
                tasks: String(baseData.tasks.length),
            });
        } else {
            const persisted = await this.storage.readPersistedLocal();
            const reconcileStart = Date.now();
            const aligned = computeSyncChangeFingerprint(persisted) === computeSyncChangeFingerprint(inMemorySnapshot);
            baseData = aligned ? persisted : mergeAppData(persisted, inMemorySnapshot);
            matchesDisk = aligned;
            // One line per cycle so a diagnostics log shows whether whale-scale
            // cycles take the cheap aligned path and what a miss costs (#766).
            this.notifier.logInfo('Sync local reconcile', {
                reconcile: aligned ? 'aligned-skip' : 'merged',
                durationMs: String(Date.now() - reconcileStart),
                tasks: String(baseData.tasks.length),
            });
        }
        const data = this.options.activationProbe
            ? baseData
            : await this.storage.injectExternalCalendars(baseData);
        // Stamp with currentChangeAt (captured above, before readPersistedLocal/
        // injectExternalCalendars yielded) rather than re-reading the change
        // stamp now: a write landing during those awaits must never be marked
        // as already covered by `data`, or a later local edit racing the very
        // first read of a sync cycle is silently dropped instead of requeued (#910).
        this.state.localSnapshotChangeAt = currentChangeAt;
        this.state.localDataCache = {
            changeAt: currentChangeAt,
            data,
        };
        // Only the untouched persisted document is a valid baseline for the
        // unchanged-local-write guard: a reconciled or calendar-injected
        // snapshot holds content the disk does not.
        this.state.localSnapshotMatchesDisk = matchesDisk && data === baseData;
        return data;
    }

    private async persistLocalDataWithTracking(data: AppData): Promise<AppData> {
        await this.assertRemoteMutationFenceHeld();
        const persisted = await this.storage.persistLocal(data) ?? data;
        this.ensureLocalSnapshotFresh(persisted);
        // Disk has moved past the snapshot this cycle read, so it is no longer
        // a baseline for the unchanged-write guard.
        this.state.localSnapshotMatchesDisk = false;
        if (this.storage.applyDataToStore) {
            this.storage.applyDataToStore(persisted);
            const currentChangeAt = this.store.getLastDataChangeAt();
            this.state.localSnapshotChangeAt = currentChangeAt;
            this.state.localDataCache = {
                changeAt: currentChangeAt,
                data: normalizeAppData(persisted),
            };
        }
        this.state.wroteLocal = true;
        return persisted;
    }

    private async persistPreSyncedDataAfterAbort(): Promise<void> {
        if (!this.state.preSyncedLocalData || this.state.wroteLocal) return;
        this.state.localSnapshotChangeAt = this.store.getLastDataChangeAt();
        const inMemorySnapshot = this.store.getInMemorySnapshot();
        const reconciledData = mergeAppData(this.state.preSyncedLocalData, inMemorySnapshot);
        await this.persistLocalDataWithTracking(reconciledData);
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
            // The remote is proven identical to the document this device last
            // synced, and local already holds it. Answering "absent" makes the
            // merge phase a normalize-only pass over local; `remoteDataForCompare`
            // stays null so the write's unchanged-guard cannot skip the upload
            // this cycle exists for. See `tryArmLocalOnlyUploadFastPath`.
            this.state.remoteDataForCompare = null;
            return null;
        }
        await this.ensureNetwork();
        try {
            const raw = await this.requireIo().readRemote();
            // A genuinely absent remote stays merge-neutral. Every document
            // otherwise enters through the shared validation/normalization
            // seam before code that assumes all AppData arrays are present.
            const parsed = raw == null ? null : parseSyncDocument(raw, 'remote');
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

    /**
     * Development-only backstop for the local-only upload fast path, at the one
     * place the document leaves for the wire. The fast path skips the
     * empty-remote merge on the strength of one invariant — every local read is
     * canonical, so `mergeAppData(local, {})` is the identity — and this is
     * where a write path that broke it gets caught, before the non-canonical
     * bytes reach a remote. Production pays nothing: the check costs two full
     * serializations of the document.
     */
    private assertLocalOnlyUploadIsCanonical(data: AppData): void {
        if (!this.state.localOnlyUploadFingerprint) return;
        // Same predicate the store's write contract uses (store.ts).
        if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'development') return;
        // The same empty document the real cycle merges against (sync.ts parses
        // an absent remote through parseSyncDocument), so the comparison is
        // byte-exact against what production does.
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
            // CloudKit keeps local-only file attachments; other backends refuse
            // to publish metadata whose bytes have not been uploaded (P8). A
            // replacement for an existing blob is different: publishing its new
            // hash/revision before the bytes land would expose stale content.
            this.logPendingAttachmentUploads('CloudKit sync has local-only file attachments', 'cloudkit-write', pending);
            assertNoPendingAttachmentContentReplacements(data);
        } else {
            this.logPendingAttachmentUploads('Remote write blocked by pending attachment uploads', 'remote-write', pending);
            assertNoPendingAttachmentUploads(data);
        }
        const remoteDocument = toRemoteSyncDocument(data);
        const previousRemoteDocument = state.remoteDataForCompare
            ? toRemoteSyncDocument(state.remoteDataForCompare)
            : null;
        const remoteNeedsTombstoneCompaction = state.remoteDataForCompare
            ? hasUncompactedPurgedTombstones(state.remoteDataForCompare)
            : false;
        if (!this.options.activationProbe
            && previousRemoteDocument
            && !remoteNeedsTombstoneCompaction
            && this.requireIo().requiresRemoteRepair?.() !== true
            && areRemoteSyncDocumentsEqual(previousRemoteDocument, remoteDocument)) {
            if (this.backend !== 'cloudkit') {
                this.notifier.tracePayload?.('remote-write-skipped-unchanged', remoteDocument, { backend: this.backend });
            }
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
                // Another device wrote between readRemote and writeRemote; retry next cycle.
                this.requestFollowUp();
                throw new LocalSyncAbort('remote-write-conflict');
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
        if (serverMergedRemoteData) {
            state.remoteDataForCompare = null;
            this.requestFollowUp();
        } else {
            state.remoteDataForCompare = remoteDocument;
        }
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

    private async trySkipUnchangedFastSync(): Promise<SyncRunResult | null> {
        // User-initiated sync: never trust the cached fingerprint pair, so a
        // stale cached fingerprint can't hide remote data.
        if (this.options.manual) return null;
        const scope = this.state.fastSyncScope;
        if (!scope) return null;
        this.setStep('fast-check');
        await this.yieldToUi();
        if (this.state.preSyncedLocalData) return null;
        const localData = await this.readLocalDataForSyncCycle();
        this.ensureLocalSnapshotFresh();
        if (hasPendingSyncSideEffects(localData)) return null;

        const localFingerprint = this.localDocumentFingerprint(localData);
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

        // A local edit landing during the fingerprint round trip must not be
        // recorded as "synced, nothing changed"; abort and requeue instead.
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

    /**
     * Local-only change: the document read, the decrypt and the two-sided merge
     * are all skippable when the remote is still byte-for-byte the document
     * this device last synced.
     *
     * The recorded remote fingerprint proves exactly that, and the local
     * document already incorporates that remote, so `merge(local, remote)`
     * degenerates to `normalize(local)` — which is what the merge phase runs
     * anyway when the remote is absent. Arming this therefore changes one
     * thing only: `readRemoteForCycle` answers "no remote document" without a
     * network read. Every downstream guarantee (normalization, tombstone
     * compaction, clock-skew clamping, validation, the pending-remote-write
     * marker, the conditional write, the fast-sync bookkeeping) is the
     * unmodified merge phase. Measured at 7000 tasks: the merge drops from
     * 943 ms to 219 ms and a 3.9 MiB download plus its decrypt and parse go
     * away, and the remote bytes are byte-identical to what a full cycle would
     * have written (`sync-run.test.ts`, "local-only upload fast path").
     *
     * Refuses unless the swap is still a compare-and-swap: the write must go
     * out under the very fingerprint this method just read
     * (`adoptRemoteFingerprintForWrite`, false for weak/absent validators, for
     * WebDAV's legacy-plaintext compatibility mode, and for every backend with
     * no conditional-write primitive). A precondition failure at write time is
     * the ordinary `SyncRemoteWriteConflict` → requeue, and the next cycle
     * sees a moved fingerprint and runs in full.
     *
     * HARD DEPENDENCY: `mergeAppData(local, {})` equals `mergeAppData(local,
     * remote-as-recorded)` only because every local write moves an entity
     * forward (store writes bump `rev` and stamp `updatedAt`; a backup restore
     * stamps forward too). Unlike a full merge, this path has no arbitration
     * fallback: a write path that changed an entity without bumping its
     * revision would be published here where a full cycle would have let the
     * recorded remote win. Any new write producer must keep that convention.
     *
     * SECOND HARD DEPENDENCY: arming this also skips `mergeAppData(local, {})`
     * itself (`io.skipEmptyRemoteMerge`; the tombstone purge and the validate
     * step still run). That is sound only because readLocal output is canonical:
     * `pass(readLocal(x)) === readLocal(x)`. Every storage codec must read a
     * field back in exactly the shape the merge would emit — `showFutureRecurrence`
     * is `true` or absent, never `false`; every other synced boolean is explicit
     * — and every creation path must write that same shape. The invariant is
     * guarded by `sync-canonical-reads.contract.test.ts` and re-checked at the
     * wire exit by `assertLocalOnlyUploadIsCanonical` in development builds.
     */
    private async tryArmLocalOnlyUploadFastPath(): Promise<boolean> {
        // Same rule as the fast check: a user-initiated sync always reads, so a
        // stale local record can never hide remote data behind a "Sync now".
        if (this.options.manual) return false;
        // A candidate transport has to prove its own read before it may write.
        if (this.options.ignorePendingRemoteWriteBackoff) return false;
        const scope = this.state.fastSyncScope;
        if (!scope) return false;
        const io = this.requireIo();
        if (!io.adoptRemoteFingerprintForWrite || !io.readRemoteFingerprint) return false;
        if (io.requiresRemoteRepair?.() === true) return false;
        // The `preSyncedLocalData` gate below only sees attachment pre-sync
        // patches when that phase runs BEFORE this step. A platform that runs
        // it afterwards must take the full cycle, or a later attachment patch
        // would ride a write that skipped the read.
        if (!this.policy.preSyncAttachmentsBeforeFastCheck) return false;
        this.setStep('fast-check');
        await this.yieldToUi();
        // Attachment pre-sync patches (both platforms run it before this point)
        // mean the cycle is not local-document-only; let it read.
        if (this.state.preSyncedLocalData) return false;
        const localData = await this.readLocalDataForSyncCycle();
        this.ensureLocalSnapshotFresh();
        // Pending remote write marker, pending attachment uploads, pending
        // remote deletes: all need the full cycle's read.
        if (hasPendingSyncSideEffects(localData)) return false;

        const cached = await this.readFastSyncState(scope);
        if (!cached) return false;
        // Nothing changed locally either — that is the fast check's business,
        // and it has already had its turn.
        if (cached.localFingerprint === this.localDocumentFingerprint(localData)) return false;

        let remoteFingerprint: string | null = null;
        try {
            remoteFingerprint = await this.readRemoteFingerprint();
        } catch (error) {
            this.notifier.logWarning('Sync fast check failed; falling back to full sync', error);
            return false;
        }
        if (!remoteFingerprint || remoteFingerprint !== cached.remoteFingerprint) return false;
        if (!io.adoptRemoteFingerprintForWrite(remoteFingerprint)) return false;

        // Same abort-and-requeue as the fast check above: a local edit that
        // landed during the fingerprint round trip leaves this cycle holding a
        // stale snapshot, and the next cycle re-reads. (The merge phase would
        // re-read too, but nothing here is worth racing over.)
        this.ensureLocalSnapshotFresh();
        this.state.localOnlyUploadFingerprint = remoteFingerprint;
        this.notifier.logInfo('Sync uploading a local-only change without a remote read', {
            backend: this.backend,
        });
        return true;
    }

    /** Mobile-only second skip: fetch the remote payload and compare directly.
     *  Also covers manual syncs and backends without a cheap fingerprint; a
     *  non-matching remote is cached and consumed by the merge phase's read. */
    private async trySkipUnchangedReadSync(): Promise<SyncRunResult | null> {
        this.setStep('read-check');
        await this.yieldToUi();
        if (this.state.preSyncedLocalData) return null;
        const localData = await this.readLocalDataForSyncCycle();
        this.ensureLocalSnapshotFresh();
        if (hasPendingSyncSideEffects(localData)) return null;

        const remoteData = await this.readRemoteForCycle();
        this.ensureLocalSnapshotFresh();
        if (!remoteData) return null;
        this.state.readCheckRemoteData = remoteData;
        if (hasUncompactedPurgedTombstones(remoteData)) return null;

        // Fingerprints, not two stable-serialized documents: the same digest
        // the fast check above already compares, and the same one the remote
        // write records. Comparing documents here serialized both sides in
        // full to reach the identical verdict.
        const localFingerprint = this.localDocumentFingerprint(localData);
        const remoteFingerprint = computeRemoteSyncDocumentFingerprint(toRemoteSyncDocument(remoteData));
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
        if (!scope || hasPendingSyncSideEffects(data)) return;
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
            localFingerprint: this.localDocumentFingerprint(data),
            remoteFingerprint,
            checkedAt: this.nowIso(),
        });
    }

    /** Read once per cycle: the carried idle snapshot validates against it,
     *  and the fast check then asks for the same record. */
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

    /** Sanitized-document fingerprint of a local snapshot, memoized on the
     *  snapshot's identity: the fast check, the read check and the fast-sync
     *  bookkeeping all ask for the same one within a cycle. */
    private localDocumentFingerprint(data: AppData): string {
        const cached = this.state.localDocumentFingerprint;
        if (cached && cached.data === data) return cached.fingerprint;
        const fingerprint = computeRemoteSyncDocumentFingerprint(toRemoteSyncDocument(data));
        this.state.localDocumentFingerprint = { data, fingerprint };
        return fingerprint;
    }

    /** Mirror of the remote write's `remote-write-skipped-unchanged` guard:
     *  the merged document carries nothing the persisted one does not, so both
     *  document writes of the merge phase would rewrite the same bytes. Only
     *  the untouched persisted snapshot is a valid baseline, and a candidate
     *  probe never writes locally at all. */
    private isLocalPersistUnchanged(data: AppData): boolean {
        if (this.options.activationProbe) return false;
        if (!this.state.localSnapshotMatchesDisk) return false;
        const stored = this.state.localDataCache?.data;
        if (!stored) return false;
        return isLocalPersistEquivalent(data, stored);
    }

    /** #1001 proof line: both unchanged returns leave the cycle before the merge
     *  phase, so the local document write, the post-sync store refresh and the
     *  attachment passes never run. The remote mutation fence is reported from
     *  state rather than assumed: an attachment pass earlier in the cycle can
     *  already have taken one. The skipped full local read has its own line
     *  (`Sync local reconcile` with `reconcile: 'idle-cache'`). */
    private logUnchangedCycleSkips(check: 'fast' | 'read'): void {
        const skippedPasses = ['local-persist', 'store-refresh', 'attachments'];
        if (!this.remoteMutationFence) skippedPasses.push('remote-fence');
        this.notifier.logInfo('Sync cycle changed nothing; passes skipped', {
            releaseCheck: 'v1.2.7/cycle-unchanged-skip',
            backend: this.backend,
            check,
            skipped: skippedPasses.join(','),
        });
    }

    /** Carry an unchanged local snapshot to the next cycle. Only reached from
     *  a skip: nothing was written, so the store stamp still describes it. */
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
            // No eager fence acquisition: the helpers passed below take it on
            // the first mutation, so an idle pre-sync pass issues no PUT/DELETE.
            const result = await io.syncAttachments(localData, this.attachmentHelpers('prepare'));
            await this.assertRemoteMutationFenceHeld();
            const mutated = result === true || (Boolean(result) && typeof result === 'object');
            const mutatedData = result && typeof result === 'object' ? result : localData;
            if (mutated) {
                // Capture pre-sync attachment mutations before stale-snapshot
                // checks so they can be persisted when the cycle aborts early.
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
            if (this.hooks.isCycleAborted?.()) throw error;
            if (isAttachmentUploadTooLargeError(error)) {
                this.state.fileAttachmentUploadBlocked = 'too-large';
                return;
            }
            this.state.hadAttachmentWarning = true;
            this.notifier.logWarning('Attachment pre-sync warning', error);
        }
    }

    /** Candidate attachment proof, or the normal final pending-upload pass,
     *  immediately before the merged document is written remotely. */
    private async prepareRemoteWriteData(data: AppData): Promise<AppData> {
        if (this.options.activationProbe) {
            // A device with no attachment storage (the web app) can never
            // download or upload a file, so it has nothing to prove: the
            // records stay unavailable here exactly as every later cycle keeps
            // them. Demanding proof refused every setup against a location
            // that held attachments (#1119).
            if (!this.policy.attachmentPhasesEnabled) return data;
            const activationSnapshot = prepareActivationAttachmentSnapshot(
                data,
                this.state.remoteDataForCompare,
                this.state.localDataCache?.data ?? null,
            );
            if (activationSnapshot.count === 0) return data;
            const io = this.requireIo();
            if (!io.syncAttachments) {
                throw new Error('Candidate backend cannot prove attachments');
            }
            this.setStep('attachments_finalize');
            await this.yieldToUi();
            if (isRemoteSyncBackend(this.backend)) {
                await this.ensureNetwork();
            }
            await this.ensureRemoteMutationFence();
            let result = await io.syncAttachments(
                activationSnapshot.data,
                this.attachmentHelpers('post-merge'),
            );
            await this.assertRemoteMutationFenceHeld();
            let provenData = result && typeof result === 'object'
                ? result
                : activationSnapshot.data;
            this.ensureLocalSnapshotFresh();
            const fallbackRetry = prepareActivationFallbackRetry(
                provenData,
                activationSnapshot.localFallbacks,
            );
            if (fallbackRetry.count > 0) {
                result = await io.syncAttachments(
                    fallbackRetry.data,
                    this.attachmentHelpers('post-merge'),
                );
                await this.assertRemoteMutationFenceHeld();
                provenData = result && typeof result === 'object'
                    ? result
                    : fallbackRetry.data;
            }
            const deferredIds = assertActivationAttachmentsProven(
                provenData,
                activationSnapshot.expectedIds,
                activationSnapshot.metadataOnlyIds,
                activationSnapshot.noLocalBytesIds,
                this.backend,
                activationSnapshot.originalCloudKeys,
            );
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
                    fallbackRetries: String(fallbackRetry.count),
                },
            });
            return provenData;
        }
        const pendingUploads = findPendingAttachmentUploads(data);
        if (pendingUploads.length === 0) return data;
        const io = this.requireIo();
        if (!io.syncAttachments) return data;

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
        const result = await io.syncAttachments(data, this.attachmentHelpers('post-merge'));
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
            // No defensive clone: the attachment backends are pure (they return a folded
            // document instead of writing to this one), so cloning a whole library here was
            // dead weight that also invalidated the storage layer's identity-keyed row cache
            // for every unchanged row (#766).
            const result = await io.syncAttachments(currentData, this.attachmentHelpers('post-merge'));
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

    private buildSyncCycleIO(): SyncCycleIO {
        return {
            readLocal: async () => {
                const localData = await this.readLocalDataForSyncCycle();
                // Retry metadata belongs to the currently proven transport.
                // A candidate transport must perform its own read/write proof
                // even while the old backend is waiting in backoff. This copy
                // is in-memory only; the durable old-backend retry state stays
                // intact unless and until settings activate the candidate.
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
            clearPendingRemoteWriteAfterLocalAbort: async (pendingAt) => {
                if (this.options.activationProbe) return;
                const current = this.store.getInMemorySnapshot();
                if (current.settings.pendingRemoteWriteAt && current.settings.pendingRemoteWriteAt !== pendingAt) return;
                await this.persistLocalDataWithTracking({
                    ...current,
                    settings: {
                        ...current.settings,
                        pendingRemoteWriteAt: undefined,
                        pendingRemoteWriteRetryAt: undefined,
                        pendingRemoteWriteAttempts: undefined,
                    },
                });
            },
            flushPendingLocalBeforeRetryRead: () => this.options.activationProbe
                ? Promise.resolve()
                : this.store.flushPendingSave(),
            isLocalPersistUnchanged: (data) => this.isLocalPersistUnchanged(data),
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
            // Read lazily: the fast path arms before the merge phase builds this
            // object, but nothing here should depend on that ordering.
            skipEmptyRemoteMerge: () => this.state.localOnlyUploadFingerprint !== null,
            onStep: (next) => this.setStep(next),
            yieldToUi: this.notifier.yieldToUi ? () => this.notifier.yieldToUi!() : undefined,
            historyContext: {
                backend: this.backend,
                type: 'merge',
            },
        };
    }

    private async runMergePhase(): Promise<SyncRunResult> {
        this.hooks.onMergePhaseStart?.();
        const syncResult = await this.performSyncCycleImpl(this.buildSyncCycleIO());
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
                // Steady nonzero across cycles = tombstone rev-bump loop (#766).
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
                // Removing an attachment must not leave its files sitting in the
                // local and sync folders until the daily pass (#1064).
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
            // Cleanup may resolve credentials, remote targets, and provider IO
            // before returning. Recheck the pre-cleanup snapshot here so a
            // local edit made anywhere in that window is requeued instead of
            // being overwritten by the returned full-data snapshot.
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
            // Attributable in the log: a holder with seconds left is a dead lease
            // (a live one renews every ttl/3), not a device actively syncing.
            this.notifier.logWarning('Remote sync location is reserved; retrying after the lease lapses', error);
            if (!this.options.activationProbe) this.requestFollowUpAfter(error.retryAfterMs);
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
            persistPreSyncedData: () => this.persistPreSyncedDataAfterAbort(),
        };
        const beforeResult = this.options.activationProbe
            ? null
            : await this.hooks.handleRunErrorBeforeRequeue?.(error, errorContext);
        if (beforeResult) return beforeResult;

        if (error instanceof LocalSyncAbort) {
            // A normal cycle must retain local attachment bookkeeping that was
            // completed before a requeue. Candidate probes operate on a clone,
            // though: none of that destination-specific metadata is durable
            // until the configuration has activated and a normal sync runs.
            if (!this.options.activationProbe) {
                await this.persistPreSyncedDataAfterAbort();
            }
            // Desktop has no onDiagnostic sink, so a requeued cycle used to leave
            // no trace at all; an activation probe that keeps requeuing (a store
            // write landing mid-probe on every attempt) then reads as "the switch
            // never saves" with nothing in the log to say why.
            this.notifier.logInfo('Sync cycle requeued', {
                backend: this.backend,
                step: this.state.step ?? '-',
                reason: error.reason,
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
                error: this.hooks.formatErrorMessage(error, this.backend),
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

/** Store bridge over the shared core Zustand store — what both apps use
 *  outside tests. Kept as a factory so tests can substitute fakes and the
 *  desktop test-dependency bag can wrap individual members. */
export const createDefaultSyncRunStoreBridge = (): SyncRunStoreBridge => ({
    getLastDataChangeAt: () => useTaskStore.getState().lastDataChangeAt,
    getInMemorySnapshot: () => getInMemoryAppDataSnapshot(),
    flushPendingSave: () => flushPendingSave(),
    setUiError: (message) => useTaskStore.getState().setError(message),
    getSettings: () => useTaskStore.getState().settings,
});
