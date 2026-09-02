import type { AppData } from './types';

export interface EntityMergeStats {
    localTotal: number;
    incomingTotal: number;
    mergedTotal: number;
    localOnly: number;
    incomingOnly: number;
    conflicts: number;
    resolvedUsingLocal: number;
    resolvedUsingIncoming: number;
    deletionsWon: number;
    conflictIds: string[];
    maxClockSkewMs: number;
    maxClockSkewDirection?: ClockSkewDirection;
    invalidTimestamps: number;
    timestampAdjustments: number;
    timestampAdjustmentIds: string[];
    futureTimestampClamps: number;
    futureTimestampClampIds: string[];
    conflictReasonCounts?: Partial<Record<ConflictReason, number>>;
    conflictSamples?: MergeConflictSample[];
}

export type ConflictReason = 'revision' | 'deleteState' | 'content';

export interface MergeConflictSample {
    id: string;
    winner: 'local' | 'incoming';
    reasons: ConflictReason[];
    hasRevision: boolean;
    timeDiffMs: number;
    localUpdatedAt: string;
    incomingUpdatedAt: string;
    localDeletedAt?: string;
    incomingDeletedAt?: string;
    localRev: number;
    incomingRev: number;
    localRevBy?: string;
    incomingRevBy?: string;
    localComparableHash: string;
    incomingComparableHash: string;
    diffKeys: string[];
}

export interface MergeStats {
    tasks: EntityMergeStats;
    projects: EntityMergeStats;
    sections: EntityMergeStats;
    areas: EntityMergeStats;
    people?: EntityMergeStats;
    /** Purged tombstones stamped with a compaction rev bump this cycle; must converge to 0 (#766). */
    tombstoneRepairs?: number;
}

export type ClockSkewDirection = 'local-ahead' | 'remote-ahead';

export interface ClockSkewWarning {
    skewMs: number;
    direction: ClockSkewDirection;
}

export interface MergeResult {
    data: AppData;
    stats: MergeStats;
    clockSkewWarning?: ClockSkewWarning;
}

export type SyncHistoryEntry = {
    at: string;
    status: 'success' | 'conflict' | 'error';
    backend?: 'file' | 'webdav' | 'cloud' | 'cloudkit' | 'off';
    type?: 'push' | 'pull' | 'merge';
    conflicts: number;
    conflictIds: string[];
    maxClockSkewMs: number;
    timestampAdjustments: number;
    details?: string;
    error?: string;
};

// Log clock skew warnings if conflicted merges show >5 minutes drift.
export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

// Delete-vs-live conflicts are treated as ambiguous only within a short window;
// outside it, the later user operation wins.
export const DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS = 30 * 1000;

// Reserved revBy marker for deterministic reference repairs. Multiple devices may
// independently stamp this value; equal-repair ties intentionally fall through to
// content-signature convergence.
export const SYNC_REPAIR_REV_BY = 'sync-repair';

export type SyncStep = 'read-local' | 'read-remote' | 'merge' | 'write-local' | 'write-remote';

export type SyncCycleIO = {
    readLocal: () => Promise<AppData>;
    readRemote: () => Promise<AppData | null | undefined>;
    writeLocal: (data: AppData) => Promise<AppData | void>;
    clearPendingRemoteWriteAfterLocalAbort?: (pendingAt: string) => Promise<void>;
    flushPendingLocalBeforeRetryRead?: () => Promise<void>;
    prepareRemoteWrite?: (data: AppData) => Promise<AppData | void>;
    writeRemote: (data: AppData) => Promise<void>;
    /** True when persisting `data` locally would change nothing durable — the
     *  stored document already carries this content and differs only in the
     *  sync bookkeeping this cycle rewrites. The cycle then writes the
     *  bookkeeping through `persistSyncStatusOnly` instead of rewriting the
     *  whole document twice. Omit to keep the unconditional local writes. */
    isLocalPersistUnchanged?: (data: AppData) => boolean;
    /** Persist just this cycle's own sync bookkeeping. Only called when
     *  `isLocalPersistUnchanged` returned true for the same document. */
    persistSyncStatusOnly?: (data: AppData) => Promise<void>;
    /** The remote was just written by a successful candidate probe. For live
     *  attachments present on both sides, its destination-specific cloud key
     *  is authoritative during this one merge; local URI/status still win as
     *  usual so downloaded bytes are not discarded. */
    preferIncomingAttachmentCloudKeys?: boolean;
    /**
     * True only for the local-only upload fast path, where `readRemote` answers
     * "absent" by construction. Merging a document against an absent remote is
     * `normalize(local)`, and every local read is canonical — each storage codec
     * reads a field back in exactly the shape the merge would emit — so that
     * normalize is the identity and the cycle can hand the document straight to
     * the tombstone purge and the validate step.
     *
     * The invariant behind the skip (`pass(readLocal(x)) === readLocal(x)`) is
     * held by the codecs, guarded by `sync-canonical-reads.contract.test.ts` and
     * re-checked at the wire exit in development builds. Never set it for a
     * cycle that actually read a remote document.
     */
    skipEmptyRemoteMerge?: () => boolean;
    historyContext?: {
        backend?: SyncHistoryEntry['backend'];
        type?: SyncHistoryEntry['type'];
        details?: string;
    };
    tombstoneRetentionDays?: number;
    now?: () => string;
    onStep?: (step: SyncStep) => void;
    yieldToUi?: () => Promise<void>;
};

export type SyncCycleWriteResult = {
    data: AppData;
    stats: MergeStats;
    status: 'success' | 'conflict';
    clockSkewWarning?: ClockSkewWarning;
    /** The merge produced nothing new for local storage, so the document write
     *  was skipped and only the sync bookkeeping was persisted. Absent means
     *  the cycle wrote the document as usual. */
    localWriteSkipped?: boolean;
};

export type SyncCycleSkippedResult = {
    data: AppData;
    status: 'skipped';
    skipped: 'pendingRemoteWriteBackoff';
    retryInMs: number;
    message: string;
};

export type SyncCycleResult = SyncCycleWriteResult | SyncCycleSkippedResult;
