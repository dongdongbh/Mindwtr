import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';

import { undoTaskCompletion } from './undo-task-completion';

const initialTaskState = useTaskStore.getState();
const now = new Date().toISOString();

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const getTask = (id: string): Task | undefined =>
    useTaskStore.getState()._allTasks.find((task) => task.id === id);

describe('undoTaskCompletion', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            _allTasks: [],
            _allProjects: [],
            _allAreas: [],
            settings: {},
            lastDataChangeAt: 0,
        });
    });

    it('restores the Today star along with the status', async () => {
        useTaskStore.setState({
            _allTasks: [makeTask('t1', { isFocusedToday: true })],
        });
        const store = useTaskStore.getState();
        await store.moveTask('t1', 'done');
        expect(getTask('t1')?.status).toBe('done');
        expect(getTask('t1')?.isFocusedToday).toBe(false);

        await undoTaskCompletion('t1', 'next', true);

        expect(getTask('t1')?.status).toBe('next');
        expect(getTask('t1')?.isFocusedToday).toBe(true);
    });

    it('does not add a star the task never had', async () => {
        useTaskStore.setState({
            _allTasks: [makeTask('t2')],
        });
        await useTaskStore.getState().moveTask('t2', 'done');

        await undoTaskCompletion('t2', 'next', false);

        expect(getTask('t2')?.status).toBe('next');
        expect(getTask('t2')?.isFocusedToday ?? false).toBe(false);
    });

    it('removes the generated occurrence when undoing recurring completion', async () => {
        const recurrence = { rule: 'daily', strategy: 'strict' } as const;
        useTaskStore.setState({
            _allTasks: [makeTask('recurring', { recurrence })],
        });
        await useTaskStore.getState().moveTask('recurring', 'done');
        const generated = useTaskStore.getState()._allTasks.find((task) => task.id !== 'recurring');
        expect(generated).toBeTruthy();

        await undoTaskCompletion('recurring', 'next', false, {
            restoreUpdates: { status: 'next', recurrence },
        });

        expect(getTask('recurring')?.status).toBe('next');
        expect(getTask(generated!.id)?.deletedAt).toBeTruthy();
        expect(useTaskStore.getState()._allTasks.filter((task) => !task.deletedAt)).toHaveLength(1);
    });

    it('skips the star when the focus cap has been refilled meanwhile', async () => {
        useTaskStore.setState({
            _allTasks: [
                makeTask('t3', { isFocusedToday: true }),
                makeTask('f1'),
                makeTask('f2'),
                makeTask('f3'),
            ],
            settings: { gtd: { focusTaskLimit: 3 } },
        });
        const store = useTaskStore.getState();
        await store.moveTask('t3', 'done');
        // Cap refills while the undo toast is on screen.
        await store.updateTask('f1', { isFocusedToday: true });
        await store.updateTask('f2', { isFocusedToday: true });
        await store.updateTask('f3', { isFocusedToday: true });

        await undoTaskCompletion('t3', 'next', true);

        expect(getTask('t3')?.status).toBe('next');
        expect(getTask('t3')?.isFocusedToday ?? false).toBe(false);
    });

    it('rejects when restoring the previous status returns a failure', async () => {
        const moveTask = vi.spyOn(useTaskStore.getState(), 'moveTask').mockResolvedValue({
            success: false,
            error: 'Could not restore status',
        });

        try {
            await expect(undoTaskCompletion('t4', 'next', false)).rejects.toThrow('Could not restore status');
        } finally {
            moveTask.mockRestore();
        }
    });

    it('rejects when restoring the Today star returns a failure', async () => {
        useTaskStore.setState({
            _allTasks: [makeTask('t5', { status: 'done' })],
            settings: { gtd: { focusTaskLimit: 3 } },
        });
        const state = useTaskStore.getState();
        const moveTask = vi.spyOn(state, 'moveTask').mockResolvedValue({ success: true });
        const updateTask = vi.spyOn(state, 'updateTask').mockResolvedValue({
            success: false,
            error: 'Could not restore focus',
        });

        try {
            await expect(undoTaskCompletion('t5', 'next', true)).rejects.toThrow('Could not restore focus');
            expect(moveTask).toHaveBeenCalledWith('t5', 'next');
            expect(updateTask).toHaveBeenCalledWith('t5', { isFocusedToday: true });
        } finally {
            moveTask.mockRestore();
            updateTask.mockRestore();
        }
    });
});
