import type { AppData, AppSettings } from './types';
import type { MergeStats, SyncCycleIO, SyncCycleResult, SyncHistoryEntry } from './sync-types';
import type { FastSyncState } from './sync-fast-sync';
import type { CloudProvider } from './sync-client-helpers';
import type { SyncBackend } from './sync-service-utils';
import type { buildMergeSummaryLog } from './sync-log-utils';
import type { SyncRemoteMutationFenceLease } from './sync-remote-fence';

/**
 * ADR 0014 — shared sync orchestration ports.
 *
 * These contracts codify the union of the desktop `SyncRun` and `MobileSyncRun`
 * method sets at extraction time. They deliberately mirror what exists rather
 * than an idealized design: optional members mark behavior only one platform
 * has today. The core state machine (`sync-run.ts`) owns cycle sequencing,
 * skip/retry/pending-write policy, and conflict-diagnostics shaping; apps own
 * transports, platform storage, and UI notification behind these ports.
 */

export type SyncRunSkipReason = 'offline' | 'requeued' | 'unchanged' | 'pendingRemoteWriteBackoff' | 'remoteFenceBusy' | 'disabled';

export type SyncRunResult = {
    success: boolean;
    stats?: MergeStats;
    error?: string;
    skipped?: SyncRunSkipReason;
    /** True when an attachment phase failed non-fatally during this run
     *  (feeds the desktop consecutive-warning toast policy). */
    hadAttachmentWarning?: boolean;
    /** True when the merge/read cycle succeeded locally but the remote write
     *  failed and was queued for background retry. `success` stays true (the
     *  run itself did not error and auto-retry behavior is unaffected) — this
     *  flag lets manual-sync UI avoid reporting a plain success while the
     *  sidebar still shows `lastSyncStatus: 'error'`. */
    remoteWriteDeferred?: boolean;
    /** A compatible peer currently owns the mutation fence, or this run could
     *  not conditionally remove its own lease. Suppresses plain-success UI. */
    remoteFenceDeferred?: 'busy' | 'cleanup';
    /** Provider-time-derived lower bound before the deferred retry is useful. */
    retryAfterMs?: number;
};

/** Transport metadata from one remote write. Adapters normalize backend-specific
 *  results (ETag/Last-Modified, cloud fingerprints, Dropbox revs) into this. */
export type SyncRemoteWriteOutcome = {
    fingerprint?: string | null;
    /** Self-hosted cloud PUT merged additional server-side data into the stored
     *  document; the machine drops its remote-compare cache and requests a
     *  follow-up cycle to pull the server's contribution. */
    serverMergedRemoteData?: boolean;
} | void;

/** Thrown by `SyncBackendIO.writeRemote` when another writer won the remote
 *  slot (e.g. Dropbox 409 rev conflict). The machine requests a follow-up
 *  cycle and aborts the current one as a requeued skip. */
export class SyncRemoteWriteConflict extends Error {
    constructor(message = 'Remote write conflict: another device wrote between read and write') {
        super(message);
        this.name = 'SyncRemoteWriteConflict';
    }
}

/**
 * Backend transport for the active backend of one sync cycle. Policy that is
 * identical across backends (sanitize-before-write, unchanged-payload skip,
 * corrupted-WebDAV repair, pending-upload assertion, server-merge follow-up)
 * lives in the machine — implementations do transport only.
 */
export interface SyncBackendIO {
    /** Acquire the backend's compatible-client remote mutation lease. Returns
     *  null for backends that do not expose the shared WebDAV/Dropbox fence. */
    acquireRemoteMutationFence?(): Promise<SyncRemoteMutationFenceLease | null>;
    /** Transport read of the remote sync document; null/undefined when missing.
     *  WebDAV implementations should let invalid-JSON errors propagate — the
     *  machine maps them to the treat-as-missing repair-write path. */
    readRemote(): Promise<AppData | null | undefined>;
    /** Transport write of the already-sanitized payload. The optional guard
     * must run immediately before every provider retry that can mutate. */
    writeRemote(
        sanitized: AppData,
        assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>,
    ): Promise<SyncRemoteWriteOutcome>;
    /** True when a transport read recovered from a fallback representation and
     *  the canonical remote must be rewritten even if its content is aligned. */
    requiresRemoteRepair?(): boolean;
    /** Cheap remote fingerprint (HEAD-equivalent) for the fast-check skip.
     *  Null when the remote has no data. Omit when the backend has no cheap
     *  check (file, CloudKit) — the fast-check then falls back to a full cycle. */
    readRemoteFingerprint?(): Promise<string | null>;
    /** Fingerprint already known from transport state without a network call
     *  (Dropbox rev observed earlier in this cycle). Consulted before the last
     *  write fingerprint and the `readRemoteFingerprint` fallback when the
     *  machine records fast-sync state. */
    getCachedRemoteFingerprint?(): string | null;
    /** One mutating attachment pass against this backend (upload pending
     *  files, resolve missing downloads). The same operation serves the
     *  prepare, finalize, and post-merge phases. Return the mutated data,
     *  true (mutated in place), or false/null/undefined (no change).
     *  `helpers.ensureLocalSnapshotFresh` lets long uploads abort when local
     *  data changes mid-pass (mobile's self-hosted cloud backend uses it). */
    syncAttachments?(data: AppData, helpers: SyncRunAttachmentHelpers): Promise<AppData | boolean | null | undefined>;
    /** Remote location for error-log context (never logged with credentials). */
    getSyncUrl?(): string | undefined;
}

export type SyncStatusUpdates = Partial<Pick<AppSettings,
    'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'lastSyncStats' | 'lastSyncHistory'
>>;

/** Local snapshot + device-local sync bookkeeping. */
export interface SyncRunStorage {
    /** Persisted local snapshot (disk), already merged with any device-local
     *  sync-status cache the platform keeps outside the synced document. */
    readPersistedLocal(): Promise<AppData>;
    /** Durably persist the merged snapshot locally. Implementations must mark
     *  the write as self-written for every watcher the platform runs. */
    persistLocal(data: AppData): Promise<AppData | void>;
    /** Desktop only: apply persisted data to the in-memory store immediately
     *  after each local write (the machine then refreshes its change-tracking
     *  from the store). Mobile refreshes once at cycle end instead. */
    applyDataToStore?(data: AppData): void;
    /** Persist sync status fields to the device-local status cache (and the
     *  in-memory settings), never to the synced document. */
    persistSyncStatus(updates: SyncStatusUpdates): Promise<void>;
    readFastSyncState(scope: string): Promise<FastSyncState | null>;
    writeFastSyncState(state: FastSyncState): Promise<void>;
    /** Inject platform-cached external calendars into a local snapshot before merge. */
    injectExternalCalendars(data: AppData): Promise<AppData>;
    /** Persist merged external calendars back to the platform cache. */
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

/** Phase checkpoints for mobile's elapsed-time/payload-shape diagnostics
 *  (issue #766 log analysis). Desktop leaves `onDiagnostic` unset. */
export type SyncRunDiagnosticEvent = {
    event:
        | 'flush'
        | 'attachments-prepare-complete'
        | 'merge-complete'
        | 'merge-skipped'
        | 'attachment-sync-applied'
        | 'requeued';
    data?: AppData | null;
    extra?: Record<string, string>;
};

/** Steps surface in the sync status UI and in error history entries. */
export interface SyncRunNotifier {
    setStep(step: string): void;
    logInfo(message: string, extra?: Record<string, string>): void;
    logWarning(message: string, error?: unknown): void;
    /** Structured warning with a prebuilt extra map (pending-upload logging). */
    logWarningExtra(message: string, extra: Record<string, string>): void;
    /** Redact credentials/paths before a message enters structured log extras. */
    sanitizeLogMessage(message: string): string;
    /** Persist a structured sync error log; the returned path becomes the
     *  "(log: …)" hint appended to the user-facing error message. */
    logSyncError(error: unknown, context: { backend: string; step: string; url?: string }): Promise<string | null | undefined>;
    /** Merge summary produced by `buildMergeSummaryLog`; platforms decide
     *  whether/where it lands (desktop gates on the Tauri runtime). */
    logMergeSummary(log: NonNullable<ReturnType<typeof buildMergeSummaryLog>>): void;
    /** Desktop payload tracing, active when diagnostics logging is enabled. */
    tracePayload?(event: SyncPayloadTraceEvent, data: AppData | null | undefined, extra?: Record<string, string>): void;
    /** Mobile per-phase diagnostics (elapsed times, payload shape counts). */
    onDiagnostic?(event: SyncRunDiagnosticEvent): void;
    /** Cooperative yield so long phases don't starve the renderer (desktop). */
    yieldToUi?(): Promise<void>;
}

/** In-memory store access. Both apps share the core Zustand store; this is a
 *  port (with a default implementation in core) so tests can run the machine
 *  against fakes without touching the real store. */
export interface SyncRunStoreBridge {
    getLastDataChangeAt(): number;
    getInMemorySnapshot(): AppData;
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
        /** From `buildFastSyncScope`; null disables the fast-check skip. */
        fastSyncScope: string | null;
    };

export type SyncRunErrorContext = {
    step: string;
    /** Live view of whether this cycle persisted local data — it can flip to
     *  true when the hook itself calls `persistPreSyncedData`. */
    getWroteLocal(): boolean;
    /** Persist attachment pre-sync mutations that would otherwise be lost
     *  when the cycle aborts early (reconciled with the in-memory snapshot). */
    persistPreSyncedData(): Promise<void>;
};

export type SyncRunAttachmentPhase = 'prepare' | 'post-merge';

export type SyncRunAttachmentHelpers = {
    /** Abort (requeue) when local data changed mid-pass. */
    ensureLocalSnapshotFresh(): void;
    /** Revalidate/renew the compatible-client lease at the final provider
     *  mutation boundary, after any throttle wait or retry delay. */
    assertRemoteMutationFenceHeld?(minRemainingMs?: number): Promise<void>;
    /** Candidate transports must prove attachment bytes before activation. */
    activationProbe: boolean;
    /**
     * Which attachment phase this call is running (#1057's check-on-touch content
     * change detection is phase-sensitive — see `contentChangePhase` on
     * `AttachmentTransferLifecycleOptions`). `'prepare'` for the pre-merge pass
     * (`runAttachmentPreSyncPhase`); `'post-merge'` for everything after the merge
     * (`runPostMergeAttachmentPhase` and the final pending-upload flush in
     * `prepareRemoteWriteData`, both of which only ever see already-merged data).
     * Optional so existing test call sites that construct this object by hand don't
     * all need updating; a backend that omits it when wiring `contentChangePhase`
     * simply leaves check-on-touch detection off, same as before this field existed.
     */
    phase?: SyncRunAttachmentPhase;
};

export type SyncRunAttachmentCleanupContext = {
    setStep(step: string): void;
    /** Abort (requeue) when local data changed mid-cycle; pass the data this
     *  cycle synced to allow the desktop covered-snapshot acceptance. */
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
    /** The machine's snapshot stamp, for follow-up bookkeeping (desktop clears
     *  a queued run whose changes this cycle already covered). */
    getLocalSnapshotChangeAt(): number;
    /** Desktop: mark the current store state as covered by the synced data;
     *  advances the machine's snapshot stamp when accepted. False when the
     *  platform has no covered-snapshot hook. */
    acceptCoveredSnapshot(expectedData: AppData): boolean;
};

/** Platform-specific behavior the two orchestrators do not share. Every hook
 *  here is a deliberate divergence — see each doc comment for which platform
 *  implements it and why. */
export interface SyncRunPlatformHooks {
    /** Resolve backend config and construct the cycle's BackendIO. Runs after
     *  the flush snapshot. Platform prologue work lives here: desktop creates
     *  the pre-sync data snapshot, registers its offline listener, and runs
     *  CloudKit setup; mobile resolves/normalizes sync paths and runs CloudKit
     *  setup. Return `{ kind: 'disabled' }` for backend "off"/unconfigured. */
    setupCycle(context: { setStep(step: string): void }): Promise<SyncRunCycleSetup>;
    /** Queue a follow-up sync cycle with the current cycle's options. */
    requestFollowUp(): void;
    /** Queue no earlier than a provider-time-derived delay (remote lease
     *  contention/cleanup). Implementations may let an explicit user run win. */
    requestFollowUpAfter?(delayMs: number): void;
    /** Throw when the platform knows the network is gone (remote backends
     *  only; implementations self-gate on their backend). The machine calls
     *  this before remote reads/writes/fingerprints and network-backend
     *  attachment passes. */
    ensureNetworkStillAvailable?(): Promise<void> | void;
    /** Desktop: accept a mid-cycle store change when the current in-memory
     *  payload fingerprint already equals the data this cycle synced. */
    acceptCoveredSnapshot?(expectedData: AppData): boolean;
    /** Observability for snapshot-staleness aborts (mobile logs these). */
    onStaleSnapshot?(details: { localSnapshotChangeAt: number; currentChangeAt: number; step: string }): void;
    /** Mobile: gate attachment phases on real pending work (and flip the
     *  visible sync-activity state). Desktop always runs the phases. */
    shouldRunAttachmentPhase?(data: AppData, phase: SyncRunAttachmentPhase): Promise<boolean>;
    /** Mobile: the merge phase is definitely running — show sync activity. */
    onMergePhaseStart?(): void;
    /** True when the cycle's abort signal fired: attachment pre-sync errors
     *  then propagate instead of degrading to a warning (mobile). */
    isCycleAborted?(): boolean;
    /** Delete stale attachment temp files after the post-merge phase. */
    cleanupAttachmentTempFiles?(): Promise<void>;
    /** Periodic orphaned-attachment cleanup. The machine owns the interval
     *  gate and rechecks freshness before persisting the returned data;
     *  implementations own the scan and must use the context guard immediately
     *  before every destructive local/remote operation. Return null when there
     *  is nothing to persist. */
    runAttachmentCleanup?(
        data: AppData,
        context: SyncRunAttachmentCleanupContext,
    ): Promise<{ data: AppData; invalidateFastSyncState: boolean } | null>;
    /** Platform error-message shaping (mobile adds iOS file-provider hints). */
    formatErrorMessage(error: unknown, backend: SyncBackend): string;
    /** Consulted before the shared LocalSyncAbort requeue handling.
     *  Mobile: classify lifecycle-abort as a benign success + follow-up. */
    handleRunErrorBeforeRequeue?(error: unknown, context: SyncRunErrorContext): Promise<SyncRunResult | null>;
    /** Consulted after the requeue handling for non-abort errors.
     *  Mobile: classify offline failures as a benign offline skip. */
    handleRunErrorAfterRequeue?(error: unknown, context: SyncRunErrorContext): Promise<SyncRunResult | null>;
    /** Persist error status + refresh platform UI state. Desktop sets the
     *  store error and always refetches; mobile refetches only after a local
     *  write and also clears cached stats. The machine has already built the
     *  history entry and logged the structured error. */
    finalizeErrorStatus(details: SyncRunErrorStatusDetails): Promise<void>;
    /** Cycle succeeded with a merge. Desktop applies data to the store and
     *  updates file-watcher bookkeeping; mobile refreshes the store from the
     *  merged payload and emits its completion diagnostic. */
    finalizeSuccess(mergedData: AppData, info: SyncRunSuccessInfo): Promise<void> | void;
    /** Cycle skipped as unchanged. Desktop updates watcher bookkeeping
     *  (last-successful change stamp, pending external change). The machine
     *  has already persisted the success status and cleared the UI error. */
    onUnchangedSkip?(): void;
}

/** Divergences that are policy switches rather than code hooks. */
export type SyncRunPolicy = {
    /** Mobile runs the attachment pre-sync before the fast-check skip;
     *  desktop runs the fast-check first. */
    preSyncAttachmentsBeforeFastCheck: boolean;
    /** Mobile-only second skip: fetch the remote payload and compare when the
     *  fingerprint fast-check cannot decide (also covers manual syncs and the
     *  file backend, which have no fingerprint). */
    enableReadCheckSkip: boolean;
    /** 'warn' (desktop): post-merge attachment failures set the warning flag
     *  and the cycle continues. 'fail' (mobile): they fail the cycle. */
    postMergeAttachmentErrorPolicy: 'warn' | 'fail';
    /** False on the desktop web runtime: no local attachment store, so all
     *  attachment phases and cleanup are skipped. */
    attachmentPhasesEnabled: boolean;
};

export type SyncRunOptions = {
    /** User-initiated sync: never take the fingerprint fast-check skip, so a
     *  stale cached fingerprint can't hide remote data. */
    manual?: boolean;
    /** Validate a candidate sync transport without making the merged snapshot
     *  durable locally. The machine still performs the normal read, merge,
     *  validation, candidate attachment proof, and remote write, but holds
     *  writeLocal and attachment metadata changes in memory and skips
     *  external-calendar, fast-state, follow-up, and finalize side effects.
     *  Settings can commit the candidate only after this succeeds. */
    activationProbe?: boolean;
    /** First durable cycle after activating a candidate transport: retry now
     *  instead of inheriting the previous backend's retry deadline, and adopt
     *  attachment keys from the candidate document just proven on that
     *  destination. The pending-write marker remains so the normal cycle
     *  clears it only after a successful local and remote commit. */
    ignorePendingRemoteWriteBackoff?: boolean;
};

export interface SyncRunPorts {
    options: SyncRunOptions;
    storage: SyncRunStorage;
    notifier: SyncRunNotifier;
    store: SyncRunStoreBridge;
    hooks: SyncRunPlatformHooks;
    policy: SyncRunPolicy;
    /** Injectable clock for deterministic tests; defaults to `Date`. */
    now?: () => Date;
    /** Attachment-cleanup interval override (tests); defaults to 24h. */
    attachmentCleanupIntervalMs?: number;
    /** Injectable merge-cycle implementation (desktop tests substitute it via
     *  their dependency bag); defaults to the core `performSyncCycle`. */
    performSyncCycle?: (io: SyncCycleIO) => Promise<SyncCycleResult>;
};
