import type { PendingAttachmentUpload } from './sync-helpers';
import type { EntityMergeStats, MergeConflictSample, MergeStats } from './sync-types';

type SanitizeLogValue = (value: string) => string;

const identitySanitizer: SanitizeLogValue = (value) => value;

export const buildPendingAttachmentUploadLogExtra = (
    backend: string,
    phase: string,
    pending: PendingAttachmentUpload[],
    sanitizeLogValue: SanitizeLogValue = identitySanitizer,
): Record<string, string> => {
    const sample = pending.slice(0, 3);
    return {
        backend,
        phase,
        pending: String(pending.length),
        sample: sample.map((item) => `${item.ownerType}:${item.ownerId}:${item.attachmentId}`).join(', '),
        uriSchemes: sample.map((item) => item.uriScheme || 'unknown').join(', '),
        localStatuses: sample.map((item) => item.localStatus || 'unset').join(', '),
        reasons: sample.map((item) => item.reason).join(', '),
        titles: sample.map((item) => sanitizeLogValue(item.title || '')).join(' | '),
    };
};

export type ConflictSampleEntity = 'task' | 'project' | 'section' | 'area' | 'person';

export type EntityConflictSample = MergeConflictSample & { entity: ConflictSampleEntity };

export const listMergeConflictSamples = (stats?: MergeStats | null): EntityConflictSample[] => {
    if (!stats) return [];
    return [
        ...(stats.tasks?.conflictSamples ?? []).map((sample) => ({ entity: 'task' as const, ...sample })),
        ...(stats.projects?.conflictSamples ?? []).map((sample) => ({ entity: 'project' as const, ...sample })),
        ...(stats.sections?.conflictSamples ?? []).map((sample) => ({ entity: 'section' as const, ...sample })),
        ...(stats.areas?.conflictSamples ?? []).map((sample) => ({ entity: 'area' as const, ...sample })),
        ...(stats.people?.conflictSamples ?? []).map((sample) => ({ entity: 'person' as const, ...sample })),
    ];
};

export const buildConflictDiagnosticsLogExtra = (stats: MergeStats): Record<string, string> => {
    const reasonCountsByEntity = Object.fromEntries(
        Object.entries({
            tasks: stats.tasks.conflictReasonCounts ?? {},
            projects: stats.projects.conflictReasonCounts ?? {},
            sections: stats.sections.conflictReasonCounts ?? {},
            areas: stats.areas.conflictReasonCounts ?? {},
            people: stats.people?.conflictReasonCounts ?? {},
        }).filter(([, counts]) => Object.keys(counts).length > 0)
    );
    const conflictSamples = listMergeConflictSamples(stats).slice(0, 6);
    const extra: Record<string, string> = {};
    if (Object.keys(reasonCountsByEntity).length > 0) {
        extra.conflictReasonCounts = JSON.stringify(reasonCountsByEntity);
    }
    if (conflictSamples.length > 0) {
        extra.conflictSamples = JSON.stringify(conflictSamples);
    }
    return extra;
};

const MERGE_STAT_ENTITIES = ['tasks', 'projects', 'sections', 'areas', 'people'] as const;

export type MergeStatsSummary = {
    conflicts: number;
    conflictIds: string[];
    maxClockSkewMs: number;
    timestampAdjustments: number;
    deleteVsLiveConflicts: number;
    futureTimestampClamps: number;
};

const emptyEntityStats: Pick<
    EntityMergeStats,
    'conflicts'
    | 'conflictIds'
    | 'maxClockSkewMs'
    | 'timestampAdjustments'
    | 'futureTimestampClamps'
    | 'conflictReasonCounts'
> = {
    conflicts: 0,
    conflictIds: [],
    maxClockSkewMs: 0,
    timestampAdjustments: 0,
    futureTimestampClamps: 0,
    conflictReasonCounts: {},
};

export const summarizeMergeStats = (stats?: MergeStats | null): MergeStatsSummary => {
    const summary: MergeStatsSummary = {
        conflicts: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        timestampAdjustments: 0,
        deleteVsLiveConflicts: 0,
        futureTimestampClamps: 0,
    };
    if (!stats) return summary;

    for (const entity of MERGE_STAT_ENTITIES) {
        const entityStats = stats[entity] ?? emptyEntityStats;
        summary.conflicts += entityStats.conflicts || 0;
        summary.conflictIds.push(...(entityStats.conflictIds || []));
        summary.maxClockSkewMs = Math.max(summary.maxClockSkewMs, entityStats.maxClockSkewMs || 0);
        summary.timestampAdjustments += entityStats.timestampAdjustments || 0;
        summary.deleteVsLiveConflicts += entityStats.conflictReasonCounts?.deleteState ?? 0;
        summary.futureTimestampClamps += entityStats.futureTimestampClamps || 0;
    }
    return summary;
};

export const buildMergeSummaryLog = (
    stats: MergeStats,
    options: { clockSkewThresholdMs: number; conflictIdLimit?: number }
): { message: string; extra: Record<string, string>; summary: MergeStatsSummary } | null => {
    const summary = summarizeMergeStats(stats);
    if (
        summary.conflicts === 0
        && summary.maxClockSkewMs <= options.clockSkewThresholdMs
        && summary.timestampAdjustments === 0
    ) {
        return null;
    }
    const conflictIds = summary.conflictIds.slice(0, options.conflictIdLimit ?? 6);
    return {
        message: `Sync merge summary: ${summary.conflicts} conflicts, max skew ${Math.round(summary.maxClockSkewMs)}ms, ${summary.timestampAdjustments} timestamp fixes.`,
        extra: {
            conflicts: String(summary.conflicts),
            maxClockSkewMs: String(Math.round(summary.maxClockSkewMs)),
            timestampFixes: String(summary.timestampAdjustments),
            conflictIds: conflictIds.join(','),
            ...buildConflictDiagnosticsLogExtra(stats),
        },
        summary,
    };
};
