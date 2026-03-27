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
    timestampAdjustments: number;
    timestampAdjustmentIds: string[];
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
}

export interface MergeResult {
    data: AppData;
    stats: MergeStats;
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

// Log clock skew warnings if merges show >5 minutes drift.
export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

export type SyncStep = 'read-local' | 'read-remote' | 'merge' | 'write-local' | 'write-remote';

export type SyncCycleIO = {
    readLocal: () => Promise<AppData>;
    readRemote: () => Promise<AppData | null | undefined>;
    writeLocal: (data: AppData) => Promise<void>;
    writeRemote: (data: AppData) => Promise<void>;
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

export type SyncCycleResult = {
    data: AppData;
    stats: MergeStats;
    status: 'success' | 'conflict';
};
