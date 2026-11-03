import type { AppData, AppSettings } from './types';
import type { MergeStats, SyncCycleIO, SyncCycleResult, SyncHistoryEntry } from './sync-types';
import type { FastSyncState } from './sync-fast-sync';
import type { CloudProvider, PreparedStorePublish } from './sync-client-helpers';
import type { CooperativePass } from './cooperative';
import type { SyncBackend } from './sync-service-utils';
import type { buildMergeSummaryLog } from './sync-log-utils';
import type { SyncRemoteMutationFenceLease } from './sync-remote-fence';
import type { SyncCryptoKdfParams, SyncKeyMaterial } from './sync-crypto';
import type { SyncEncryptionRemoteReadLogInput } from './sync-encryption-diagnostics';
import type { AttachmentTransferAdmission } from './attachment-transfer';
import type { SqliteReadToken, SqliteStaleOption } from './sqlite-adapter';


export type SyncEncryptionPosture = {

    material: SyncKeyMaterial | null;

    logRemoteRead(input: SyncEncryptionRemoteReadLogInput): void;

    onRemotePlaintextDiscovered(): void | Promise<void>;

    onRemoteEncryptionDiscovered(discovered: { salt: Uint8Array; params: SyncCryptoKdfParams }): void | Promise<void>;

    onRemoteEncryptionVerified?(material: SyncKeyMaterial): void | Promise<void>;

    noKeyError(): Error;


    onWeakEtagPlaintextRead?(etag: string | null): void;
};

export type SyncRunSkipReason = 'offline' | 'requeued' | 'unchanged' | 'pendingRemoteWriteBackoff' | 'remoteFenceBusy' | 'fileSyncLockBusy' | 'disabled';

export type SyncRunResult = {
    success: boolean;
    stats?: MergeStats;
    error?: string;
    skipped?: SyncRunSkipReason;


    hadAttachmentWarning?: boolean;


    localWriteSkipped?: boolean;


    remoteWriteDeferred?: boolean;


    attachmentWriteDeferred?: boolean;


    fileAttachmentUploadBlocked?: 'too-large';


    remoteFenceDeferred?: 'busy' | 'cleanup';


    fileSyncLockDeferred?: 'busy' | 'cleanup';

    fileSyncLockUnavailable?: boolean;


    fileGenerationCorrupt?: boolean;

    retryAfterMs?: number;


    activationMissingAttachments?: ActivationMissingAttachment[];
};

export type ActivationMissingAttachment = {
    id: string;
    ownerType: 'task' | 'project';
    ownerId: string;

    title: string;
    ownerTitle: string;
};


export type SyncRemoteWriteOutcome = {
    fingerprint?: string | null;


    serverMergedRemoteData?: boolean;
} | void;


export class SyncRemoteWriteConflict extends Error {
    constructor(message = 'Remote write conflict: another device wrote between read and write') {
        super(message);
        this.name = 'SyncRemoteWriteConflict';
    }
}


export interface SyncBackendIO {


    acquireRemoteMutationFence?(): Promise<SyncRemoteMutationFenceLease | null>;


    readRemote(): Promise<AppData | null | undefined>;


    writeRemote(
        sanitized: AppData,
        assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>,
    ): Promise<SyncRemoteWriteOutcome>;


    requiresRemoteRepair?(): boolean;


    readRemoteFingerprint?(): Promise<string | null>;


    getCachedRemoteFingerprint?(): string | null;


    adoptRemoteFingerprintForWrite?(fingerprint: string): boolean;


    syncAttachments?(data: AppData, helpers: SyncRunAttachmentHelpers): Promise<AppData | boolean | null | undefined>;

    getSyncUrl?(): string | undefined;
}

export type SyncStatusUpdates = Partial<Pick<AppSettings,
    'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'lastSyncStats' | 'lastSyncHistory'
>>;


export interface SyncRunStorage {


    readPersistedLocal(options?: SqliteStaleOption): Promise<AppData>;


    persistLocal(data: AppData, options?: { token?: SqliteReadToken } & SqliteStaleOption): Promise<AppData | void>;

    readTokenOf?(data: AppData): SqliteReadToken | undefined;

    afterPersistLocal?(): Promise<void>;


    applyDataToStore?(data: AppData, prepared?: PreparedStorePublish): boolean | void;

    prepareLocalSave?(data: AppData): CooperativePass<void> | undefined;

    prepareStorePublish?(data: AppData): CooperativePass<PreparedStorePublish>;


    persistSyncStatus(updates: SyncStatusUpdates): Promise<void>;
    readFastSyncState(scope: string): Promise<FastSyncState | null>;
    writeFastSyncState(state: FastSyncState): Promise<void>;


    readUnreachableAttachments?(): Promise<string | null>;
    writeUnreachableAttachments?(raw: string): Promise<void>;

    injectExternalCalendars(data: AppData): Promise<AppData>;

    persistExternalCalendars(data: AppData): Promise<void>;
}

export type SyncPayloadTraceEvent =
    | 'read-local'
    | 'read-remote'
    | 'write-local'
    | 'write-remote'
    | 'remote-write-completed'
    | 'remote-write-skipped-unchanged'
    | 'core-result'
    | 'post-attachment';


export type SyncFollowUpReason = 'stale-local' | 'stale-db' | 'remote-conflict' | 'server-contribution'
    | 'remote-fence-busy' | 'remote-fence-release' | 'file-lock-busy';

export type SyncRunDiagnosticEvent = {
    event:
        | 'flush'
        | 'attachments-prepare-complete'
        | 'merge-complete'
        | 'merge-skipped'
        | 'attachment-sync-applied'
        | 'requeued'
        | 'follow-up-requested';
    data?: AppData | null;
    previousData?: AppData | null;
    followUpReason?: SyncFollowUpReason;
    extra?: Record<string, string>;
};


export interface SyncRunNotifier {
    setStep(step: string): void;
    logInfo(message: string, extra?: Record<string, string>): void;
    logWarning(message: string, error?: unknown): void;

    logWarningExtra(message: string, extra: Record<string, string>): void;

    sanitizeLogMessage(message: string): string;


    logSyncError(error: unknown, context: { backend: string; step: string; url?: string }): Promise<string | null | undefined>;


    logMergeSummary(log: NonNullable<ReturnType<typeof buildMergeSummaryLog>>): void;

    tracePayload?(event: SyncPayloadTraceEvent, data: AppData | null | undefined, extra?: Record<string, string>): void;

    onDiagnostic?(event: SyncRunDiagnosticEvent): void;

    yieldToUi?(): Promise<void>;


    sliceYield?(): Promise<void>;
}


export interface SyncRunStoreBridge {
    getLastDataChangeAt(): number;
    getInMemorySnapshot(): AppData;

    captureInMemorySnapshot?(): AppData;

    listenerCount?(): number;
    flushPendingSave(): Promise<void>;
    setUiError(message: string | null): void;
    getSettings(): AppSettings | undefined;
}

export type SyncRunCycleSetup =
    | { kind: 'disabled' }
    | {
        kind: 'ready';
        backend: SyncBackend;
        cloudProvider?: CloudProvider;
        io: SyncBackendIO;

        fastSyncScope: string | null;


        locationScope?: string | null;
    };

export type SyncRunErrorContext = {
    step: string;


    getWroteLocal(): boolean;


    persistPreSyncedData(): Promise<void>;
};

export type SyncRunAttachmentPhase = 'prepare' | 'post-merge';

export type SyncRunAttachmentHelpers = {

    ensureLocalSnapshotFresh(): void;


    assertRemoteMutationFenceHeld?(minRemainingMs?: number): Promise<void>;

    activationProbe: boolean;


    activationContinuation?: boolean;


    onTransferBatchDeferred?: () => void;


    phase?: SyncRunAttachmentPhase;


    transferAdmission?: AttachmentTransferAdmission;
};

export type SyncRunAttachmentCleanupContext = {
    setStep(step: string): void;


    ensureLocalSnapshotFresh(expectedData?: AppData): void;
    ensureNetworkStillAvailable(): Promise<void>;
    assertRemoteMutationFenceHeld(minRemainingMs?: number): Promise<void>;
};

export type SyncRunErrorStatusDetails = {
    at: string;
    message: string;
    step: string;
    history: SyncHistoryEntry[];
    wroteLocal: boolean;
};

export type SyncRunSuccessInfo = {
    status: 'success' | 'conflict';
    wroteLocal: boolean;


    localWriteSkipped?: boolean;


    getLocalSnapshotChangeAt(): number;


    acceptCoveredSnapshot(expectedData: AppData): boolean;
};


export interface SyncRunPlatformHooks {


    setupCycle(context: {
        setStep(step: string): void;
        setBackend(backend: SyncBackend): void;
    }): Promise<SyncRunCycleSetup>;

    requestFollowUp(): void;


    requestFollowUpAfter?(delayMs: number): void;

    requestFileSyncLockBusyFollowUpAfter?(delayMs: number, nextAttempt: number): void;


    ensureNetworkStillAvailable?(): Promise<void> | void;


    acceptCoveredSnapshot?(expectedData: AppData): boolean;

    onStaleSnapshot?(details: { localSnapshotChangeAt: number; currentChangeAt: number; step: string }): void;


    shouldRunAttachmentPhase?(data: AppData, phase: SyncRunAttachmentPhase): Promise<boolean>;


    hasDeferredAttachmentWork?(): boolean;

    onMergePhaseStart?(): void;


    isCycleAborted?(): boolean;

    cleanupAttachmentTempFiles?(): Promise<void>;


    runAttachmentCleanup?(
        data: AppData,
        context: SyncRunAttachmentCleanupContext,
    ): Promise<{ data: AppData; invalidateFastSyncState: boolean } | null>;

    formatErrorMessage(error: unknown, backend: SyncBackend): string;


    handleRunErrorBeforeRequeue?(error: unknown, context: SyncRunErrorContext): Promise<SyncRunResult | null>;


    handleRunErrorAfterRequeue?(error: unknown, context: SyncRunErrorContext): Promise<SyncRunResult | null>;


    finalizeErrorStatus(details: SyncRunErrorStatusDetails): Promise<void>;


    finalizeSuccess(mergedData: AppData, info: SyncRunSuccessInfo): Promise<void> | void;


    onUnchangedSkip?(): void;
}


export type SyncRunPolicy = {


    preSyncAttachmentsBeforeFastCheck: boolean;


    carryIdleCycleSnapshot?: boolean;


    enableReadCheckSkip: boolean;


    postMergeAttachmentErrorPolicy: 'warn' | 'fail';


    attachmentPhasesEnabled: boolean;
};

export type SyncRunOptions = {


    manual?: boolean;


    activationProbe?: boolean;

    fileSyncLockBusyRetryAttempt?: number;


    ignorePendingRemoteWriteBackoff?: boolean;


    acceptMissingAttachmentIds?: readonly string[];
};

export interface SyncRunPorts {
    options: SyncRunOptions;
    storage: SyncRunStorage;
    notifier: SyncRunNotifier;
    store: SyncRunStoreBridge;
    hooks: SyncRunPlatformHooks;
    policy: SyncRunPolicy;

    now?: () => Date;

    attachmentCleanupIntervalMs?: number;


    performSyncCycle?: (io: SyncCycleIO) => Promise<SyncCycleResult>;
};
