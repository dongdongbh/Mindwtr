import { describe, expect, it } from 'vitest';

import { normalizeTaskForSyncMerge } from './sync-normalization';
import { getMergeComparableSignature, normalizeTaskForContentComparison } from './sync-signatures';
import type { Task } from './types';


const EARLY = '2026-07-13T10:00:00.000Z';
const LATE = '2027-03-13T10:00:00.000Z';

const signAt = (task: Task, nowIso: string): string =>
    getMergeComparableSignature(normalizeTaskForSyncMerge(task, nowIso), normalizeTaskForContentComparison);

const asTask = (raw: Record<string, unknown>): Task => raw as unknown as Task;

describe('merge content signature vs the merge clock', () => {
    it('a focused task with a future start has the same content signature before and after that start', () => {
        const task = asTask({
            id: 'clock-focus',
            title: 'Focused with a future start',
            status: 'next',
            isFocusedToday: true,
            focusOrder: 3,
            startTime: '2026-07-20T09:00:00.000Z',
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            rev: 1,
        });

        const beforeStart = signAt(task, EARLY);
        const afterStart = signAt(task, LATE);

        expect(beforeStart).toContain('"isFocusedToday":true');
        expect(beforeStart).not.toContain('"focusOrder"');
        expect(afterStart).toContain('"isFocusedToday":true');
        expect(afterStart).not.toContain('"focusOrder"');
        expect(beforeStart).toEqual(afterStart);
    });

    it('a finished task with no timestamps at all takes completedAt from the merge clock', () => {
        for (const status of ['done', 'archived']) {
            const task = asTask({ id: `clock-${status}`, title: 'No timestamps', status });

            expect(signAt(task, EARLY)).toContain(`"completedAt":"${EARLY}"`);
            expect(signAt(task, LATE)).toContain(`"completedAt":"${LATE}"`);
        }
    });

    it('every other normalization edge case is clock-independent', () => {
        const stable: Record<string, Record<string, unknown>> = {
            'ordinary task': { id: 's1', title: 'Ordinary', status: 'next', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            'missing createdAt/updatedAt': { id: 's2', title: 'No timestamps', status: 'next' },
            'invalid createdAt/updatedAt': { id: 's3', title: 'Bad timestamps', status: 'next', createdAt: 'nope', updatedAt: 'also nope' },
            'purged tombstone': { id: 's4', title: 'Gone', status: 'next', purgedAt: '2026-06-01T00:00:00.000Z', deletedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z', rev: 4 },
            'purged tombstone without timestamps': { id: 's5', title: 'Gone', status: 'next', purgedAt: '2026-06-01T00:00:00.000Z' },
            'legacy status': { id: 's6', title: 'Legacy', status: 'doing', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            'legacy status without timestamps': { id: 's7', title: 'Legacy', status: 'in-progress' },
            'non-finite rev': { id: 's8', title: 'Rev NaN', status: 'next', rev: Number.NaN, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            'padded revBy': { id: 's9', title: 'Padded', status: 'next', revBy: '  device-a  ', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            'done with an updatedAt': { id: 's10', title: 'Done', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
            'focused, start already passed': { id: 's11', title: 'Focus now', status: 'next', isFocusedToday: true, startTime: '2026-07-13T09:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            'focused, no start time': { id: 's12', title: 'Focus', status: 'next', isFocusedToday: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            'unfocused, future start': { id: 's13', title: 'Later', status: 'next', startTime: '2026-07-20T09:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        };

        for (const [name, raw] of Object.entries(stable)) {
            const task = asTask(raw);
            expect(signAt(task, EARLY), name).toEqual(signAt(task, LATE));
        }
    });
});
