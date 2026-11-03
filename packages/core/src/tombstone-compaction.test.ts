import { describe, expect, it } from 'vitest';
import type { AppData, Task } from './types';
import { compactPurgedTaskForLocalStorage, hasUncompactedPurgedTaskTombstone } from './tombstone-compaction';
import { normalizeTaskForLoad } from './task-status';
import { normalizeTaskForSyncMerge } from './sync-normalization';
import { mergeAppDataWithStats } from './sync';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';
import { mapSqliteTaskRow } from './sqlite-adapter';

const nowIso = '2026-08-04T00:00:00.000Z';

const purgedTask: Task = {
    id: 'task-purged',
    title: 'Sensitive title',
    status: 'done',
    tags: ['a'],
    contexts: [],
    rev: 5,
    revBy: 'device-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    deletedAt: '2026-01-03T00:00:00.000Z',
    purgedAt: '2026-01-03T00:00:00.000Z',
};

describe('purged tombstone compaction is stable across load cycles', () => {


    it('does not flag a loaded compacted tombstone as uncompacted', () => {
        const compacted = compactPurgedTaskForLocalStorage(purgedTask);
        expect(hasUncompactedPurgedTaskTombstone(compacted, true)).toBe(false);
        const loaded = normalizeTaskForLoad(compacted, nowIso);
        expect(loaded.pushCount).toBeUndefined();
        expect(hasUncompactedPurgedTaskTombstone(loaded, true)).toBe(false);

        expect(hasUncompactedPurgedTaskTombstone({ ...compacted, pushCount: 0 }, true)).toBe(false);
    });

    it('keeps rev stable across repeated load -> merge cycles', () => {
        let task = compactPurgedTaskForLocalStorage(purgedTask);
        for (let cycle = 0; cycle < 3; cycle += 1) {
            task = normalizeTaskForSyncMerge(normalizeTaskForLoad(task, nowIso), nowIso, true);
        }
        expect(task.rev).toBe(purgedTask.rev);
        expect(task.revBy).toBe(purgedTask.revBy);
    });

    it('reports tombstoneRepairs in merge stats once, then converges to zero', () => {
        const emptyData: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
        const localData: AppData = { ...emptyData, tasks: [purgedTask] };
        const first = mergeAppDataWithStats(localData, emptyData, { nowIso });
        expect(first.stats.tombstoneRepairs).toBe(1);
        const loadedBack: AppData = {
            ...first.data,
            tasks: first.data.tasks.map((task) => normalizeTaskForLoad(task, nowIso)),
        };
        const second = mergeAppDataWithStats(loadedBack, first.data, { nowIso });
        expect(second.stats.tombstoneRepairs).toBe(0);
    });

    it('still bumps rev once for a genuinely uncompacted tombstone, then converges', () => {
        const first = normalizeTaskForSyncMerge(purgedTask, nowIso, true);
        expect(first.rev).toBe(6);
        expect(first.revBy).toBe('sync-repair');
        expect(first.title).toBe('(deleted)');
        const second = normalizeTaskForSyncMerge(normalizeTaskForLoad(first, nowIso), nowIso, true);
        expect(second.rev).toBe(6);
    });


    it('a compacted tombstone round-trips load -> merge with an identical SQLite row', () => {
        const emptyData: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
        const compacted = compactPurgedTaskForLocalStorage(purgedTask);
        const loaded = normalizeTaskForLoad(compacted, nowIso);
        expect(loaded.pushCount).toBeUndefined();

        const base: AppData = { ...emptyData, tasks: [loaded] };
        const first = mergeAppDataWithStats(base, base, { nowIso });
        const merged = first.data.tasks[0];
        expect(first.stats.tombstoneRepairs).toBe(0);
        expect(JSON.stringify(taskToSqliteRow(merged))).toBe(JSON.stringify(taskToSqliteRow(loaded)));

        const reloaded = normalizeTaskForLoad(merged, nowIso);
        const secondBase: AppData = { ...emptyData, tasks: [reloaded] };
        const second = mergeAppDataWithStats(secondBase, secondBase, { nowIso: '2026-08-10T12:05:00.000Z' });
        expect(JSON.stringify(second.data.tasks[0])).toBe(JSON.stringify(merged));
    });


    it('a tombstone loaded through the SQLite row codec keeps rev stable across merge cycles', () => {
        const emptyData: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
        const sqlRoundTrip = (task: Task): Task => {
            const row = taskToSqliteRow(task);
            const record: Record<string, unknown> = {};
            TASK_SQLITE_COLUMNS.forEach((column, index) => { record[column] = row[index]; });
            return normalizeTaskForLoad(mapSqliteTaskRow(record), nowIso);
        };

        const compacted = compactPurgedTaskForLocalStorage(purgedTask);
        const loaded = sqlRoundTrip(compacted);

        expect(loaded.completedAtBeforeProjectArchive).toBeUndefined();
        expect(hasUncompactedPurgedTaskTombstone(loaded, true)).toBe(false);
        expect(hasUncompactedPurgedTaskTombstone(loaded, false)).toBe(false);


        let persisted = loaded;
        for (const cycleNow of ['2026-08-13T20:00:00.000Z', '2026-08-13T20:01:00.000Z', '2026-08-13T20:02:00.000Z']) {
            const base: AppData = { ...emptyData, tasks: [persisted] };
            const result = mergeAppDataWithStats(base, base, { nowIso: cycleNow });
            expect(result.stats.tombstoneRepairs).toBe(0);
            expect(result.data.tasks[0].rev).toBe(purgedTask.rev);
            persisted = sqlRoundTrip(result.data.tasks[0]);
        }
    });

    it('live tasks still get the pushCount backfill on load', () => {
        const live = normalizeTaskForLoad({
            id: 'live-1',
            title: 'still here',
            status: 'next',
            createdAt: nowIso,
            updatedAt: nowIso,
        } as Task, nowIso);
        expect(live.pushCount).toBe(0);
    });
});
