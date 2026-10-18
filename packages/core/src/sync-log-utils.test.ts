import { describe, expect, it } from 'vitest';
import { buildMergeSummaryLog, listMergeConflictSamples, summarizeMergeStats } from './sync-log-utils';
import type { EntityMergeStats, MergeConflictSample, MergeStats } from './sync-types';
import { withQuickJsArgumentLimit } from './quickjs-test-utils';

const entityStats = (overrides: Partial<EntityMergeStats> = {}): EntityMergeStats => ({
    localTotal: 0,
    incomingTotal: 0,
    mergedTotal: 0,
    localOnly: 0,
    incomingOnly: 0,
    conflicts: 0,
    resolvedUsingLocal: 0,
    resolvedUsingIncoming: 0,
    deletionsWon: 0,
    conflictIds: [],
    maxClockSkewMs: 0,
    invalidTimestamps: 0,
    timestampAdjustments: 0,
    timestampAdjustmentIds: [],
    futureTimestampClamps: 0,
    futureTimestampClampIds: [],
    conflictReasonCounts: {},
    conflictSamples: [],
    ...overrides,
});

const mergeStats = (overrides: Partial<MergeStats> = {}): MergeStats => ({
    tasks: entityStats(),
    projects: entityStats(),
    sections: entityStats(),
    areas: entityStats(),
    ...overrides,
});

describe('sync log utils', () => {
    it('summarizes 65536 conflict ids, more than a QuickJS call takes arguments', () => {
        const conflictIds = Array.from({ length: 65_536 }, (_, index) => `task-${index}`);
        const summary = withQuickJsArgumentLimit(() => summarizeMergeStats(mergeStats({ tasks: entityStats({ conflictIds }) })));
        expect(summary.conflictIds).toEqual(conflictIds);
    });

    it('summarizes merge stats across all synced entity types', () => {
        const summary = summarizeMergeStats(mergeStats({
            tasks: entityStats({ conflicts: 1, conflictIds: ['task-1'], maxClockSkewMs: 1000, timestampAdjustments: 2 }),
            sections: entityStats({ conflicts: 2, conflictIds: ['section-1'], futureTimestampClamps: 3 }),
            areas: entityStats({ conflictReasonCounts: { deleteState: 4 }, maxClockSkewMs: 5000 }),
        }));

        expect(summary).toEqual({
            conflicts: 3,
            conflictIds: ['task-1', 'section-1'],
            maxClockSkewMs: 5000,
            timestampAdjustments: 2,
            deleteVsLiveConflicts: 4,
            futureTimestampClamps: 3,
        });
    });

    it('builds merge summary logs only when conflicts, skew, or timestamp fixes exist', () => {
        expect(buildMergeSummaryLog(mergeStats(), { clockSkewThresholdMs: 300_000 })).toBeNull();

        const log = buildMergeSummaryLog(mergeStats({
            areas: entityStats({ conflicts: 1, conflictIds: ['area-1'] }),
        }), { clockSkewThresholdMs: 300_000 });

        expect(log?.message).toContain('1 conflicts');
        expect(log?.extra).toMatchObject({
            conflicts: '1',
            conflictIds: 'area-1',
        });
    });

    it('lists conflict samples tagged with their entity type', () => {
        const sample = (id: string): MergeConflictSample => ({
            id,
            winner: 'incoming',
            reasons: ['content'],
            hasRevision: true,
            timeDiffMs: 0,
            localUpdatedAt: '2026-01-01T00:00:00.000Z',
            incomingUpdatedAt: '2026-01-01T00:00:01.000Z',
            localRev: 1,
            incomingRev: 2,
            localComparableHash: 'aaa',
            incomingComparableHash: 'bbb',
            diffKeys: ['title'],
        });

        expect(listMergeConflictSamples(null)).toEqual([]);
        expect(listMergeConflictSamples(mergeStats())).toEqual([]);

        const samples = listMergeConflictSamples(mergeStats({
            tasks: entityStats({ conflictSamples: [sample('task-1')] }),
            areas: entityStats({ conflictSamples: [sample('area-1')] }),
        }));

        expect(samples.map((item) => [item.entity, item.id])).toEqual([
            ['task', 'task-1'],
            ['area', 'area-1'],
        ]);
    });
});
