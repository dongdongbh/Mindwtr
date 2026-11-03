import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { taskStoreState } = vi.hoisted(() => ({
    taskStoreState: {
        _allTasks: [] as Array<Record<string, unknown>>,
        setHighlightTask: vi.fn(),
    },
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@mindwtr/core')>()),
    useTaskStore: { getState: () => taskStoreState },
}));

import { useUiStore } from '../store/ui-store';
import { followCreatedTaskAfterEdit, resolveViewForTask } from './created-task-follow';
import { subscribeNavigateEvent } from './navigation-events';

describe('followCreatedTaskAfterEdit (#1243)', () => {
    const navigated: string[] = [];
    let unsubscribeNavigate = () => undefined as void;

    beforeEach(() => {
        navigated.length = 0;
        taskStoreState._allTasks = [{ id: 'task-1', status: 'inbox' }];
        taskStoreState.setHighlightTask.mockClear();
        useUiStore.setState({ editingTaskId: 'task-1' });
        unsubscribeNavigate = subscribeNavigateEvent(({ view }) => {
            navigated.push(view);
        });
    });

    afterEach(() => {
        unsubscribeNavigate();
    });

    it('maps a task to its list by project first, then status', () => {
        expect(resolveViewForTask({ status: 'next', projectId: 'p1' })).toBe('projects');
        expect(resolveViewForTask({ status: 'waiting' })).toBe('waiting');
        expect(resolveViewForTask({ status: 'inbox' })).toBe('inbox');
        expect(resolveViewForTask({ status: 'archived' })).toBe('archived');

        expect(resolveViewForTask({ status: 'next', startTime: '2999-01-01' })).toBe('review');
        expect(resolveViewForTask({ status: 'next', startTime: '2999-01-01', projectId: 'p1' })).toBe('projects');
    });

    it('follows a deferred next action to Review, where it is shown', () => {
        followCreatedTaskAfterEdit('task-1', 'inbox');
        taskStoreState._allTasks = [{ id: 'task-1', status: 'next', startTime: '2999-01-01' }];

        useUiStore.setState({ editingTaskId: null });

        expect(navigated).toEqual(['review']);
    });

    it('follows the task to its new list once the editor closes', () => {
        followCreatedTaskAfterEdit('task-1', 'inbox');
        taskStoreState._allTasks = [{ id: 'task-1', status: 'next' }];

        useUiStore.setState({ editingTaskId: null });

        expect(navigated).toEqual(['next']);
        expect(taskStoreState.setHighlightTask).toHaveBeenCalledWith('task-1');
    });

    it('selects the project when the edit filed the task under one', () => {
        followCreatedTaskAfterEdit('task-1', 'inbox');
        taskStoreState._allTasks = [{ id: 'task-1', status: 'next', projectId: 'project-9' }];

        useUiStore.setState({ editingTaskId: null });

        expect(navigated).toEqual(['projects']);
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-9');
    });

    it('stays put when the task kept its list, was deleted, or the edit was cancelled', () => {
        followCreatedTaskAfterEdit('task-1', 'inbox');
        useUiStore.setState({ editingTaskId: null });
        expect(navigated).toEqual([]);

        useUiStore.setState({ editingTaskId: 'task-1' });
        followCreatedTaskAfterEdit('task-1', 'inbox');
        taskStoreState._allTasks = [{ id: 'task-1', status: 'next', deletedAt: '2026-09-18T00:00:00.000Z' }];
        useUiStore.setState({ editingTaskId: null });
        expect(navigated).toEqual([]);
    });

    it('only reacts to its own editing session', () => {
        followCreatedTaskAfterEdit('task-1', 'inbox');
        taskStoreState._allTasks = [{ id: 'task-1', status: 'next' }];

        useUiStore.setState({ editingTaskId: 'task-2' });
        useUiStore.setState({ editingTaskId: null });


        expect(navigated).toEqual(['next']);
    });
});
