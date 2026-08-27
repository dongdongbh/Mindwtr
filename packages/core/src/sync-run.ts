import type { AppData } from './types';
import type { CloudProvider } from './sync-client-helpers';
import type { SyncBackend } from './sync-service-utils';
import { SyncFileLockBusyError, SyncFileLockUnavailableError } from './sync-service-utils';
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
import { flushPendingSave, useTaskStore } from './store';
import {
    assertNoPendingAttachmentUploads,
    computeSyncChangeFingerprint,
    findPendingAttachmentUploads,
    hasPendingSyncSideEffects,
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
    preSyncedLocalData: AppData | null;
    wroteLocal: boolean;
    remoteDataForCompare: AppData | null;
    readCheckRemoteData: AppData | undefined;
    lastRemoteWriteFingerprint: string | null;
    lastRemoteWriteMergedServerData: boolean;
    webdavRemoteCorrupted: boolean;
    hadAttachmentWarning: boolean;
};

const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

const prepareActivationAttachmentSnapshot = (data: AppData): { data: AppData; count: number } => {
    const candidate = cloneAppData(data);
    const count = visitLiveFileAttachments(candidate, (attachment) => {
        // A candidate adapter must actively rediscover local presence. Leaving
        // the old status intact would let a skipped/capped transfer look like
        // proof that the candidate backend has the blob.
        attachment.localStatus = 'missing';
    });
    return { data: candidate, count };
};

const assertActivationAttachmentsProven = (data: AppData, expectedCount: number): void => {
    let provenCount = 0;
    visitLiveFileAttachments(data, (attachment) => {
        if (!attachment.cloudKey || attachment.localStatus !== 'available') {
            throw new Error(`Candidate attachment proof failed for ${attachment.id}`);
        }
        provenCount += 1;
    });
    if (provenCount !== expectedCount) {
        throw new Error(`Candidate attachment proof incomplete: expected ${expectedCount}, proved ${provenCount}`);
    }
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
    private readonly state: SharedSyncRunState = {
        backend: 'off',
        cloudProvider: 'selfhosted',
        step: 'init',
        fastSyncScope: null,
        localSnapshotChangeAt: 0,
        localDataCache: null,
        preSyncedLocalData: null,
        wroteLocal: false,
        remoteDataForCompare: null,
        readCheckRemoteData: undefined,
        lastRemoteWriteFingerprint: null,
        lastRemoteWriteMergedServerData: false,
        webdavRemoteCorrupted: false,
        hadAttachmentWarning: false,
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
        return result;
    }

    private async runPhases(): Promise<SyncRunResult> {
        this.setStep('flush');
        await this.yieldToUi();
        await this.store.flushPendingSave();
        this.notifier.onDiagnostic?.({ event: 'flush' });
        this.state.localSnapshotChangeAt = this.store.getLastDataChangeAt();

        const setup = await this.hooks.setupCycle({ setStep: (step) => this.setStep(step) });
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
        if (!this.options.activationProbe) {
            skipResult = await this.trySkipUnchangedFastSync();
        }
        if (!this.options.activationProbe && !skipResult && this.policy.enableReadCheckSkip) {
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
        this.remoteMutationFence = lease;
        this.state.readCheckRemoteData = undefined;
        this.state.remoteDataForCompare = null;
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
            assertRemoteMutationFenceHeld: (minRemainingMs?: number) => (
                this.assertRemoteMutationFenceHeld(minRemainingMs)
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
        // tuple (#766). The attachment pre-sync branch must keep merging
        // unconditionally: its patches can change fields the fingerprint does
        // not cover (cloudKey, localStatus).
        let baseData: AppData;
        if (this.state.preSyncedLocalData) {
            baseData = mergeAppData(this.state.preSyncedLocalData, inMemorySnapshot);
        } else {
            const persisted = await this.storage.readPersistedLocal();
            const reconcileStart = Date.now();
            const aligned = computeSyncChangeFingerprint(persisted) === computeSyncChangeFingerprint(inMemorySnapshot);
            baseData = aligned ? persisted : mergeAppData(persisted, inMemorySnapshot);
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
        return data;
    }

    private async persistLocalDataWithTracking(data: AppData): Promise<AppData> {
        await this.assertRemoteMutationFenceHeld();
        const persisted = await this.storage.persistLocal(data) ?? data;
        this.ensureLocalSnapshotFresh(persisted);
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

    private async writeRemoteForCycle(data: AppData): Promise<void> {
        await this.ensureRemoteMutationFence();
        await this.assertRemoteMutationFenceHeld();
        await this.ensureNetwork();
        const state = this.state;
        state.lastRemoteWriteFingerprint = null;
        state.lastRemoteWriteMergedServerData = false;
        const pending = findPendingAttachmentUploads(data);
        if (this.backend === 'cloudkit') {
            // CloudKit keeps local-only file attachments; other backends refuse
            // to publish metadata whose bytes have not been uploaded (P8).
            this.logPendingAttachmentUploads('CloudKit sync has local-only file attachments', 'cloudkit-write', pending);
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
                throw new LocalSyncAbort();
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

        const localFingerprint = computeRemoteSyncDocumentFingerprint(toRemoteSyncDocument(localData));
        const cached = await this.storage.readFastSyncState(scope);
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
        await this.storage.writeFastSyncState({
            scope,
            localFingerprint,
            remoteFingerprint,
            checkedAt: this.nowIso(),
        });
        await this.persistUnchangedSyncStatus();
        this.notifier.logInfo('Sync fast check found no changes', { backend: this.backend });
        return { success: true, skipped: 'unchanged' };
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

        const localDocument = toRemoteSyncDocument(localData);
        const remoteDocument = toRemoteSyncDocument(remoteData);
        if (!areRemoteSyncDocumentsEqual(remoteDocument, localDocument)) return null;

        await this.recordFastSyncState(localData, { allowRemoteFingerprintRead: false });
        await this.persistUnchangedSyncStatus();
        this.state.readCheckRemoteData = undefined;
        this.notifier.logInfo('Sync read check found no changes', { backend: this.backend });
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
        await this.storage.writeFastSyncState({
            scope,
            localFingerprint: computeRemoteSyncDocumentFingerprint(toRemoteSyncDocument(data)),
            remoteFingerprint,
            checkedAt: this.nowIso(),
        });
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
            await this.ensureRemoteMutationFence();
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
            this.state.hadAttachmentWarning = true;
            this.notifier.logWarning('Attachment pre-sync warning', error);
        }
    }

    /** Candidate attachment proof, or the normal final pending-upload pass,
     *  immediately before the merged document is written remotely. */
    private async prepareRemoteWriteData(data: AppData): Promise<AppData> {
        if (this.options.activationProbe) {
            const activationSnapshot = prepareActivationAttachmentSnapshot(data);
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
            const result = await io.syncAttachments(
                activationSnapshot.data,
                this.attachmentHelpers('post-merge'),
            );
            await this.assertRemoteMutationFenceHeld();
            const provenData = result && typeof result === 'object'
                ? result
                : activationSnapshot.data;
            assertActivationAttachmentsProven(provenData, activationSnapshot.count);
            this.ensureLocalSnapshotFresh();
            this.notifier.onDiagnostic?.({
                event: 'attachments-prepare-complete',
                data: provenData,
                extra: { mutated: String(result === true || Boolean(result && typeof result === 'object')) },
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
            prepareRemoteWrite: (data) => this.prepareRemoteWriteData(data),
            writeRemote: async (data) => {
                this.notifier.tracePayload?.('write-remote', data, { backend: this.backend });
                this.ensureLocalSnapshotFresh(data);
                await this.writeRemoteForCycle(data);
            },
            preferIncomingAttachmentCloudKeys:
                this.options.ignorePendingRemoteWriteBackoff === true,
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
        await this.hooks.finalizeSuccess(mergedData, {
            status: syncResult.status,
            wroteLocal: this.state.wroteLocal,
            getLocalSnapshotChangeAt: () => this.state.localSnapshotChangeAt,
            acceptCoveredSnapshot: (expectedData) => this.acceptCoveredLocalSnapshot(expectedData),
        });
        if (mergedData.settings.pendingRemoteWriteRetryAt) {
            return {
                success: true,
                remoteWriteDeferred: true,
                error: mergedData.settings.lastSyncError,
                stats,
            };
        }
        return { success: true, stats };
    }

    private async handleRunError(error: unknown): Promise<SyncRunResult> {
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
        this.notifier.logWarning('Sync failed', error);
        if (this.options.activationProbe) {
            return {
                success: false,
                error: this.hooks.formatErrorMessage(error, this.backend),
                ...(fileSyncLockUnavailable ? { fileSyncLockUnavailable: true } : {}),
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
