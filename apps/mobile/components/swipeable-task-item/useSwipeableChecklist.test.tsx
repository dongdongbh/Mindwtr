import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStoreCommand, runSyncStoreSave } from '@mindwtr/core';

import { useSwipeableChecklist } from './useSwipeableChecklist';

const { updateTask, storeState } = vi.hoisted(() => ({
    updateTask: vi.fn(),
    storeState: {
        updateTask: vi.fn(),
        tasks: [] as any[],
        _allTasks: [] as any[],
    },
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const { mockCore } = await import('../../test-support/mock-core');
    storeState.updateTask = updateTask;
    return mockCore(importOriginal, () => storeState);
});

type Hook = ReturnType<typeof useSwipeableChecklist>;

function renderChecklistHook(task: any) {
    const captured: { current: Hook | null } = { current: null };
    const Probe = ({ value }: { value: any }) => {
        captured.current = useSwipeableChecklist(value, updateTask as any);
        return null;
    };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
        tree = renderer.create(<Probe value={task} />);
    });
    return { hook: () => captured.current!, tree };
}

describe('useSwipeableChecklist addChecklistItem', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        updateTask.mockResolvedValue({ success: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('appends a trimmed item and flushes it through the pending update', () => {
        const task = {
            id: 'task-1',
            title: 'Groceries',
            status: 'next',
            checklist: [{ id: 'item-1', title: 'Bread', isCompleted: false }],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as any;
        storeState._allTasks = [task];
        const { hook } = renderChecklistHook(task);

        renderer.act(() => {
            hook().addChecklistItem('  Milk  ');
        });

        expect(hook().localChecklist).toEqual([
            { id: 'item-1', title: 'Bread', isCompleted: false },
            expect.objectContaining({ title: 'Milk', isCompleted: false }),
        ]);
        expect(hook().localChecklist![1].id).toBeTruthy();
        expect(updateTask).not.toHaveBeenCalled();

        renderer.act(() => {
            vi.runAllTimers();
        });

        expect(updateTask).toHaveBeenCalledWith('task-1', {
            checklist: [
                { id: 'item-1', title: 'Bread', isCompleted: false },
                expect.objectContaining({ title: 'Milk', isCompleted: false }),
            ],
        });
    });

    it('ignores a whitespace-only title', () => {
        const task = {
            id: 'task-1',
            title: 'Groceries',
            status: 'next',
            checklist: [{ id: 'item-1', title: 'Bread', isCompleted: false }],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as any;
        storeState._allTasks = [task];
        const { hook } = renderChecklistHook(task);

        renderer.act(() => {
            hook().addChecklistItem('   ');
        });
        renderer.act(() => {
            vi.runAllTimers();
        });

        expect(hook().localChecklist).toEqual([{ id: 'item-1', title: 'Bread', isCompleted: false }]);
        expect(updateTask).not.toHaveBeenCalled();
    });

    // The status recomputation lives in flushPendingChecklist, not in the caller:
    // an unchecked item on a finished list-mode task reopens it.
    it('reopens a completed list-mode task when a new item lands on it', () => {
        const task = {
            id: 'task-1',
            title: 'Groceries',
            status: 'done',
            taskMode: 'list',
            checklist: [{ id: 'item-1', title: 'Bread', isCompleted: true }],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as any;
        storeState._allTasks = [task];
        const { hook } = renderChecklistHook(task);

        renderer.act(() => {
            hook().addChecklistItem('Milk');
        });
        renderer.act(() => {
            vi.runAllTimers();
        });

        expect(updateTask).toHaveBeenCalledWith('task-1', {
            checklist: [
                { id: 'item-1', title: 'Bread', isCompleted: true },
                expect.objectContaining({ title: 'Milk', isCompleted: false }),
            ],
            status: 'next',
        });
    });

    it('keeps a Reference list its status when its last item is ticked from the row', () => {
        const task = {
            id: 'task-1',
            title: 'Packing',
            status: 'reference',
            taskMode: 'list',
            checklist: [{ id: 'item-1', title: 'Passport', isCompleted: false }],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as any;
        storeState._allTasks = [task];
        const { hook } = renderChecklistHook(task);

        renderer.act(() => {
            hook().toggleChecklistItem(0);
        });
        renderer.act(() => {
            vi.runAllTimers();
        });

        expect(updateTask).toHaveBeenCalledWith('task-1', {
            checklist: [{ id: 'item-1', title: 'Passport', isCompleted: true }],
        });
    });

    it('ticks the item by id on the list a sync save published while the tick waited behind it', async () => {
        const one = { id: 'item-1', title: 'Bread', isCompleted: false };
        const task = {
            id: 'task-1',
            title: 'Groceries',
            status: 'next',
            checklist: [one],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as any;
        storeState._allTasks = [task];
        // updateTask as the store runs it: a command behind the write gate (store-write-gate.ts).
        updateTask.mockImplementation((id: string, updates: any) => runStoreCommand(async () => {
            storeState._allTasks = storeState._allTasks.map((item) => (item.id === id ? { ...item, ...updates } : item));
            return { success: true };
        }));
        const { hook } = renderChecklistHook(task);
        renderer.act(() => {
            hook().toggleChecklistItem(0);
        });

        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // Another device put an item in front of it: the sync save holds the gate, then publishes [new, item-1].
        const save = runSyncStoreSave(async () => {
            await held;
            storeState._allTasks = [{ ...task, rev: 3, checklist: [{ id: 'item-0', title: 'Milk', isCompleted: false }, one] }];
        });
        renderer.act(() => {
            vi.runAllTimers();
        });
        release();
        await save;
        await runStoreCommand(async () => undefined);

        expect(storeState._allTasks[0].checklist).toEqual([
            { id: 'item-0', title: 'Milk', isCompleted: false },
            { id: 'item-1', title: 'Bread', isCompleted: true },
        ]);
    });

    it('flushes an item added just before unmount', () => {
        const task = {
            id: 'task-1',
            title: 'Groceries',
            status: 'next',
            checklist: [] as any[],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as any;
        storeState._allTasks = [task];
        const { hook, tree } = renderChecklistHook(task);

        renderer.act(() => {
            hook().addChecklistItem('Milk');
        });
        renderer.act(() => {
            tree.unmount();
        });

        expect(updateTask).toHaveBeenCalledWith('task-1', {
            checklist: [expect.objectContaining({ title: 'Milk', isCompleted: false })],
        });
    });
});
