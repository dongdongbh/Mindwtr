import { afterEach, describe, expect, it } from 'vitest';

import { setLogger, type LogPayload } from './logger';
import { runAutoArchive } from './store-load-migrations';
import { mergeAppDataWithStats } from './sync';
import { createMockTask, mockAppData } from './sync-test-utils';
import type { AppData, Task } from './types';

// #1430: two devices auto-archive the same completed task before they exchange changes.
const NOW = '2026-10-21T14:00:00.000Z';
const base: Task = {
    ...createMockTask('synthetic-task', '2026-10-12T22:29:51.174Z'),
    status: 'done',
    completedAt: '2026-10-12T22:29:51.174Z',
    rev: 16,
    revBy: 'origin',
};
const A_AT = '2026-10-20T03:23:06.604Z';
const B_AT = '2026-10-19T23:26:58.634Z';

const archiveOn = (nowIso: string, deviceId: string, task: Task = base): Task =>
    runAutoArchive([task], { gtd: { autoArchiveDays: 7 } }, { nowIso, nowMs: Date.parse(nowIso), deviceId }).allTasks[0];
const merge = (local: Task, incoming: Task) => mergeAppDataWithStats(mockAppData([local]), mockAppData([incoming]), { nowIso: NOW });
const mergedTask = (result: { data: AppData }) => result.data.tasks[0];

const expectConvergedPair = (a: Task, b: Task, archivedAt: string) => {
    const ab = merge(a, b);
    const ba = merge(b, a);
    expect(ab.stats.tasks.conflicts).toBe(0);
    expect(ba.stats.tasks.conflicts).toBe(0);
    expect(mergedTask(ab).archivedAt).toBe(archivedAt);
    expect(mergedTask(ba)).toEqual(mergedTask(ab));
    // Fixed point: a peer holding either input (an old 1.3.6 client included) adopts the result, no ping-pong.
    for (const input of [a, b]) {
        for (const result of [merge(mergedTask(ab), input), merge(input, mergedTask(ab))]) {
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(mergedTask(result)).toEqual(mergedTask(ab));
        }
    }
};

describe('independent archive of the same task (#1430)', () => {
    afterEach(() => setLogger(() => {}));

    it('merges two auto-archived copies without a conflict and keeps the later archive clock', () => {
        const logs: LogPayload[] = [];
        setLogger((entry) => { logs.push(entry); });
        const a = archiveOn(A_AT, 'device-a');
        const b = archiveOn(B_AT, 'device-b');
        expect(a.rev).toBe(17);
        expect(b.rev).toBe(17);

        expectConvergedPair(a, b, A_AT);
        expect(logs.some((entry) => entry.context?.releaseCheck === 'v1.3.7/auto-archive-converge'
            && entry.context?.count === 1)).toBe(true);
    });

    it('keeps the later archive clock even when the other copy wins on updatedAt', () => {
        const a = archiveOn(A_AT, 'device-a');
        const b = { ...archiveOn(B_AT, 'device-b'), updatedAt: '2026-10-20T05:00:00.000Z' };
        expect(mergedTask(merge(a, b)).revBy).toBe('device-b');
        expectConvergedPair(a, b, A_AT);
    });

    it('still reports reopen vs archive as a conflict', () => {
        const a = archiveOn(A_AT, 'device-a');
        const b: Task = { ...base, status: 'next', completedAt: undefined, updatedAt: B_AT, rev: 17, revBy: 'device-b' };
        const result = merge(a, b);
        expect(result.stats.tasks.conflicts).toBe(1);
        expect(mergedTask(result).status).toBe('archived');
    });

    it('still reports edit vs archive as a conflict', () => {
        const a = archiveOn(A_AT, 'device-a');
        const b: Task = { ...base, title: 'Edited', updatedAt: B_AT, rev: 17, revBy: 'device-b' };
        expect(merge(a, b).stats.tasks.conflicts).toBe(1);
    });

    it('still resolves delete vs archive by delete state', () => {
        const a = archiveOn(A_AT, 'device-a');
        const b: Task = { ...base, deletedAt: B_AT, updatedAt: B_AT, rev: 17, revBy: 'device-b' };
        const result = merge(a, b);
        expect(result.stats.tasks.conflicts).toBe(1);
        expect(result.stats.tasks.conflictReasonCounts).toEqual({ deleteState: 1 });
    });

    it('still reports an archive with another changed field as a conflict', () => {
        const a = archiveOn(A_AT, 'device-a');
        const b = { ...archiveOn(B_AT, 'device-b'), title: 'Renamed while archiving' };
        const result = merge(a, b);
        expect(result.stats.tasks.conflicts).toBe(1);
        expect(result.stats.tasks.conflictSamples?.[0]?.diffKeys).toEqual(expect.arrayContaining(['archivedAt', 'title']));
        expect(mergedTask(result).archivedAt).toBe(A_AT);
    });
});
