import { describe, expect, it } from 'vitest';
import { applyRowChecklistEdit } from './task-row-checklist';
import type { Task } from './types';

const task = (fields: Partial<Task> = {}): Task => ({
    id: 't1', title: 'Groceries', status: 'next', tags: [], contexts: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    checklist: [{ id: 'a', title: 'Bread', isCompleted: false }, { id: 'b', title: 'Milk', isCompleted: false }],
    ...fields,
} as Task);

describe('applyRowChecklistEdit (RN useSwipeableChecklist flush, 75f876b63)', () => {
    it('toggles each item by id on the latest checklist, even after the items were reordered', () => {
        const latest = task({ checklist: [{ id: 'b', title: 'Milk', isCompleted: false }, { id: 'a', title: 'Bread', isCompleted: false }] });
        expect(applyRowChecklistEdit(latest, { a: true }, [])).toEqual({
            checklist: [{ id: 'b', title: 'Milk', isCompleted: false }, { id: 'a', title: 'Bread', isCompleted: true }],
        });
    });

    it('appends added items once, and keeps an added item that the latest task already stores', () => {
        const added = [{ id: 'c', title: 'Eggs', isCompleted: false }, { id: 'a', title: 'Bread again', isCompleted: false }];
        expect(applyRowChecklistEdit(task(), {}, added).checklist.map((item) => item.title)).toEqual(['Bread', 'Milk', 'Eggs']);
    });

    it('ignores a tick on an item the latest task no longer has', () => {
        expect(applyRowChecklistEdit(task(), { gone: true }, [])).toEqual({ checklist: task().checklist });
    });

    it('completes a list task when every item is ticked, and reopens it as Next when one is unticked', () => {
        expect(applyRowChecklistEdit(task({ taskMode: 'list' }), { a: true, b: true }, [])).toMatchObject({ status: 'done' });
        const done = task({ taskMode: 'list', status: 'done', checklist: [{ id: 'a', title: 'Bread', isCompleted: true }] });
        expect(applyRowChecklistEdit(done, { a: false }, [])).toMatchObject({ status: 'next' });
    });

    it('never moves a Reference item: its list ticks, its status stays Reference (bc518c30e, #1416)', () => {
        const reference = task({ taskMode: 'list', status: 'reference' });
        expect(applyRowChecklistEdit(reference, { a: true, b: true }, [])).toEqual({
            checklist: [{ id: 'a', title: 'Bread', isCompleted: true }, { id: 'b', title: 'Milk', isCompleted: true }],
        });
    });

    it('leaves an ordinary task\'s status alone when all its items are ticked', () => {
        expect(applyRowChecklistEdit(task(), { a: true, b: true }, [])).not.toHaveProperty('status');
    });
});
