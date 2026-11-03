import type { Slicer } from './cooperative';
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


export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;


export const DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS = 30 * 1000;


export const SYNC_REPAIR_REV_BY = 'sync-repair';

export type SyncStep = 'read-local' | 'read-remote' | 'merge' | 'write-local' | 'write-remote';


export const PREPARED_UNCHANGED: unique symbol = Symbol('mindwtr.sync.preparedUnchanged');

export type SyncCycleIO = {
    readLocal: () => Promise<AppData>;
    readRemote: () => Promise<AppData | null | undefined>;
    writeLocal: (data: AppData) => Promise<AppData | void>;
    flushPendingLocalBeforeRetryRead?: () => Promise<void>;
    prepareRemoteWrite?: (data: AppData) => Promise<AppData | void | typeof PREPARED_UNCHANGED>;
    writeRemote: (data: AppData) => Promise<void>;


    isLocalPersistUnchanged?: (data: AppData) => boolean;


    persistSyncStatusOnly?: (data: AppData) => Promise<void>;


    preferIncomingAttachmentCloudKeys?: boolean;

    preferIncomingAttachmentCloudKeyIds?: ReadonlySet<string>;


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

    slicer?: Slicer;
};

export type SyncCycleWriteResult = {
    data: AppData;
    stats: MergeStats;
    status: 'success' | 'conflict';
    clockSkewWarning?: ClockSkewWarning;


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
