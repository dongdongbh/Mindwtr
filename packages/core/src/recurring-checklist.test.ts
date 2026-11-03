import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNextRecurringTask, normalizeRecurrenceForLoad } from './recurrence';
import { createTaskDraft, taskDraftToChangedUpdatePatch } from './task-draft';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow, taskFromSqliteRow } from './task-sync-schema';
import { normalizeTaskForSyncMerge } from './sync-normalization';
import { normalizeTaskForContentComparison, toComparableSignature } from './sync-signatures';
import { mergeAppData } from './sync';
import { mockAppData } from './sync-test-utils';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { undoTaskCompletion } from './undo-task-completion';
import type { Recurrence, Task } from './types';

const now = '2026-10-18T12:00:00.000Z';
const routine = (recurrence: Recurrence = { rule: 'weekly', preserveChecklistOnRepeat: true }): Task => ({
    id: 'routine', title: 'Routine', status: 'next', tags: [], contexts: [],
    createdAt: now, updatedAt: now, rev: 2, revBy: 'test', recurrence,
    checklist: [{ id: 'a', title: 'First', isCompleted: true }, { id: 'b', title: 'Second', isCompleted: false }],
});
const next = (task: Task) => createNextRecurringTask(task, now, 'next');

describe('recurring checklist progress', () => {
    for (const strategy of ['strict', 'fluid'] as const) {
        for (const rule of ['daily', 'weekly', 'monthly', 'yearly'] as const) {
            for (const schedule of [{}, { startTime: '2026-10-18' }, { dueDate: '2026-10-18' },
                { startTime: '2026-10-17T10:00:00Z', dueDate: '2026-10-18T10:00:00Z' }]) {
                it(`${strategy} ${rule} ${JSON.stringify(schedule)} carries progress across generations`, () => {
                    const task = { ...routine({ rule, strategy, preserveChecklistOnRepeat: true }), ...schedule };
                    const successor = next(task)!;
                    const third = next(successor)!;
                    for (const occurrence of [successor, third]) {
                        expect(occurrence.checklist?.map(item => item.isCompleted)).toEqual([true, false]);
                        expect(occurrence.recurrence).toMatchObject({ preserveChecklistOnRepeat: true });
                        expect(occurrence.status).toBe('next');
                    }
                    expect(new Set([...task.checklist!, ...successor.checklist!, ...third.checklist!].map(item => item.id)).size).toBe(6);
                    successor.checklist![0].isCompleted = false;
                    expect(task.checklist![0].isCompleted).toBe(true);
                    expect(third.checklist![0].isCompleted).toBe(true);
                    task.checklist![1].isCompleted = true;
                    expect(third.checklist![1].isCompleted).toBe(false);
                });
            }
        }
    }
    it('retains default reset, explicit reset and list-mode reset', () => {
        for (const task of [routine({ rule: 'weekly' }), routine({ rule: 'weekly', preserveChecklistOnRepeat: false }),
            { ...routine(), taskMode: 'list' as const }]) {
            expect(next(task)!.checklist?.map(item => item.isCompleted)).toEqual([false, false]);
        }
    });
    it('keeps a fully checked routine open and carries a manual reset forward', () => {
        const task = routine();
        task.checklist![1].isCompleted = true;
        expect(next(task)).toMatchObject({ status: 'next', checklist: [{ isCompleted: true }, { isCompleted: true }] });
        task.checklist!.forEach(item => { item.isCompleted = false; });
        expect(next(task)!.checklist?.map(item => item.isCompleted)).toEqual([false, false]);
    });
    it('respects COUNT and UNTIL', () => {
        expect(next(routine({ rule: 'weekly', count: 1, preserveChecklistOnRepeat: true }))).toBeNull();
        expect(next({ ...routine({ rule: 'weekly', until: '2026-10-18', preserveChecklistOnRepeat: true }), dueDate: '2026-10-18' })).toBeNull();
    });
    it('round trips through JSON, SQLite codecs, normalization, drafts and sync', () => {
        const task = routine();
        const loaded = taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, taskToSqliteRow(task)[index]])));
        const json = JSON.parse(JSON.stringify(loaded)) as Task;
        const normalized = normalizeTaskForSyncMerge(json, now);
        expect(normalized.recurrence).toMatchObject({ preserveChecklistOnRepeat: true });
        expect(normalizeTaskForSyncMerge(normalized, now)).toEqual(normalized);
        const draft = createTaskDraft(normalized);
        expect(draft.preserveChecklistOnRepeat).toBe(true);
        expect(taskDraftToChangedUpdatePatch({ ...draft, title: 'Edited' }, normalized)).not.toHaveProperty('recurrence');
        const patch = taskDraftToChangedUpdatePatch({ ...draft, preserveChecklistOnRepeat: false }, normalized)!;
        expect(patch.recurrence).not.toHaveProperty('preserveChecklistOnRepeat');
        expect(task.checklist![0].isCompleted).toBe(true);
        const signature = (value: Task) => toComparableSignature(normalizeTaskForContentComparison(value));
        expect(signature(normalized)).not.toBe(signature({ ...normalized, recurrence: { rule: 'weekly' } }));
        const data = mockAppData([normalized]);
        const merged = mergeAppData(data, data);
        expect(merged.tasks[0].recurrence).toMatchObject({ preserveChecklistOnRepeat: true });
        expect(mergeAppData(merged, merged)).toEqual(merged);
        const older = { ...data, tasks: [{ ...normalized, rev: 1, updatedAt: '2026-10-17T12:00:00.000Z', recurrence: { rule: 'weekly' as const } }] };
        expect(mergeAppData(data, older).tasks[0].recurrence).toMatchObject({ preserveChecklistOnRepeat: true });
    });
    it('normalizes only boolean values and preserves false', () => {
        for (const value of [true, false]) expect(normalizeRecurrenceForLoad({ rule: 'weekly', preserveChecklistOnRepeat: value }))
            .toMatchObject({ preserveChecklistOnRepeat: value });
        expect(normalizeRecurrenceForLoad({ rule: 'weekly', preserveChecklistOnRepeat: 'true' })).not.toHaveProperty('preserveChecklistOnRepeat');
    });
});


describe('recurring checklist store actions', () => {
    beforeEach(() => {
        resetForTests();
        setStorageAdapter({ getData: async () => mockAppData(), saveData: async () => undefined });
        useTaskStore.setState({ _allTasks: [], tasks: [], _tasksById: new Map(), _allProjects: [], projects: [],
            _allSections: [], sections: [], _allAreas: [], areas: [], settings: {}, isLoading: false, error: null });
        vi.useFakeTimers();
        vi.setSystemTime(new Date(now));
    });
    afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

    it('copies the latest checklist when checking and immediately completing, and supports undo', async () => {
        const task = await useTaskStore.getState().addTask('Routine', routine());
        const store = useTaskStore.getState();
        const check = store.updateTask(task.id, { checklist: routine().checklist!.map(item => ({ ...item, isCompleted: true })) });
        const complete = store.updateTask(task.id, { status: 'done' });
        expect((await check).success).toBe(true);
        expect((await complete).success).toBe(true);
        const successor = useTaskStore.getState().tasks.find(row => row.id !== task.id)!;
        expect(successor.checklist?.map(item => item.isCompleted)).toEqual([true, true]);
        await undoTaskCompletion(task.id, 'next', false);
        const restored = useTaskStore.getState().tasks.find(row => row.id === task.id)!;
        expect(restored.status).toBe('next');
        expect(useTaskStore.getState().tasks.some(row => row.id === successor.id)).toBe(false);
        expect(restored.recurrence).toMatchObject({ preserveChecklistOnRepeat: true });
        expect(restored.checklist?.map(item => item.isCompleted)).toEqual([true, true]);
    });
    it('skip carries progress and manual reset changes only the current occurrence', async () => {
        const task = await useTaskStore.getState().addTask('Routine', { ...routine(), dueDate: '2026-10-18' });
        expect((await useTaskStore.getState().skipRecurringTaskOccurrence(task.id)).success).toBe(true);
        const successor = useTaskStore.getState().tasks.find(row => row.id !== task.id && row.status !== 'archived')!;
        expect(successor.checklist?.map(item => item.isCompleted)).toEqual([true, false]);
        expect((await useTaskStore.getState().resetTaskChecklist(successor.id)).success).toBe(true);
        expect(useTaskStore.getState()._tasksById.get(task.id)?.checklist?.[0].isCompleted).toBe(true);
        expect((await useTaskStore.getState().updateTask(successor.id, { status: 'done' })).success).toBe(true);
        const third = useTaskStore.getState().tasks.find(row => row.id !== task.id && row.id !== successor.id)!;
        expect(third.checklist?.map(item => item.isCompleted)).toEqual([false, false]);
    });
});
