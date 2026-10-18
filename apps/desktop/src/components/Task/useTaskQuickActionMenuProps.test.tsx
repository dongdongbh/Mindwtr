import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Area, type Project, type Task } from '@mindwtr/core';

import { logInfo } from '../../lib/app-log';
import { reportError } from '../../lib/report-error';
import { useUiStore } from '../../store/ui-store';
import { TaskQuickActionMenuHost, useTaskQuickActionMenuProps } from './useTaskQuickActionMenuProps';
import { holdSyncSave } from '../../test/hold-sync-save';

const createProjectMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn());

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, createBulkOrganizeProject: createProjectMock };
});

vi.mock('../../contexts/language-context', () => ({
    useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}));

vi.mock('../../lib/app-log', () => ({
    logInfo: logInfoMock,
}));

vi.mock('../../lib/report-error', () => ({
    reportError: vi.fn(),
}));

vi.mock('./useTaskItemProjectContext', () => ({
    useTaskItemProjectContext: () => ({ allContexts: [], popularContextOptions: [] }),
}));

const now = '2026-09-09T00:00:00.000Z';
const task: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
};
const areas: Area[] = [
    { id: 'area-task', name: 'Task area', color: '#2563eb', order: 0, createdAt: now, updatedAt: now },
    { id: 'area-project', name: 'Project area', color: '#2563eb', order: 1, createdAt: now, updatedAt: now },
    { id: 'area-deleted', name: 'Deleted area', color: '#2563eb', order: 2, createdAt: now, updatedAt: now, deletedAt: now },
];
const projects: Project[] = [{
    id: 'project-current',
    title: 'Current',
    status: 'active',
    areaId: 'area-project',
    color: '#2563eb',
    order: 0,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
}];

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

describe('useTaskQuickActionMenuProps project creation', () => {
    beforeEach(() => {
        createProjectMock.mockReset();
        logInfoMock.mockReset();
        logInfoMock.mockResolvedValue(null);
        vi.mocked(reportError).mockReset();
        act(() => {
            useTaskStore.setState({ _allAreas: areas, _allProjects: projects });
            useUiStore.setState({ showToast: vi.fn() });
        });
    });

    afterEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
    });

    it('creates durably in the current project area and records the proving diagnostic', async () => {
        createProjectMock.mockResolvedValue({ ...projects[0], id: 'project-created', title: 'Garden redesign' });
        const { result } = renderHook(() => useTaskQuickActionMenuProps({
            ...task,
            projectId: 'project-current',
            areaId: 'area-task',
        }));

        let createdId: string | null = null;
        await act(async () => {
            createdId = await result.current.onCreateProject('Garden redesign');
        });

        expect(createdId).toBe('project-created');
        expect(createProjectMock).toHaveBeenCalledExactlyOnceWith('Garden redesign', 'area-project');
        expect(logInfo).toHaveBeenCalledExactlyOnceWith('Task menu project creation saved', {
            scope: 'project',
            extra: {
                outcome: 'created',
            },
        });
    });

    it('inherits a task area only when the task is not assigned to a project', async () => {
        createProjectMock.mockResolvedValue({ ...projects[0], id: 'project-created' });
        const { result } = renderHook(() => useTaskQuickActionMenuProps({ ...task, areaId: 'area-task' }));

        await act(async () => {
            await result.current.onCreateProject('Garden redesign');
        });

        expect(createProjectMock).toHaveBeenCalledExactlyOnceWith('Garden redesign', 'area-task');
    });

    it('does not inherit a deleted area from the assigned project', async () => {
        createProjectMock.mockResolvedValue({ ...projects[0], id: 'project-created' });
        act(() => {
            useTaskStore.setState({
                _allProjects: [{ ...projects[0], areaId: 'area-deleted' }],
            });
        });
        const { result } = renderHook(() => useTaskQuickActionMenuProps({
            ...task,
            projectId: 'project-current',
            areaId: 'area-task',
        }));

        await act(async () => {
            await result.current.onCreateProject('Garden redesign');
        });

        expect(createProjectMock).toHaveBeenCalledExactlyOnceWith('Garden redesign', undefined);
    });

    it.each([
        ['null result', null],
        ['rejection', new Error('disk full')],
    ])('returns null, reports failure, and never logs success for a %s', async (_case, failure) => {
        if (failure instanceof Error) createProjectMock.mockRejectedValue(failure);
        else createProjectMock.mockResolvedValue(failure);
        const showToast = vi.fn();
        useUiStore.setState({ showToast });
        const { result } = renderHook(() => useTaskQuickActionMenuProps(task));

        let createdId: string | null = 'not-null';
        await act(async () => {
            createdId = await result.current.onCreateProject('Garden redesign');
        });

        expect(createdId).toBeNull();
        expect(showToast).toHaveBeenCalledExactlyOnceWith('Failed to create project', 'error');
        expect(logInfo).not.toHaveBeenCalled();
        if (failure instanceof Error) {
            expect(reportError).toHaveBeenCalledWith('Failed to create project from task quick actions', failure);
        } else {
            expect(reportError).not.toHaveBeenCalled();
        }
    });

    it('keeps a successful creation successful when the proving diagnostic rejects', async () => {
        const diagnosticError = new Error('log unavailable');
        createProjectMock.mockResolvedValue({ ...projects[0], id: 'project-created' });
        logInfoMock.mockRejectedValue(diagnosticError);
        const { result } = renderHook(() => useTaskQuickActionMenuProps(task));

        let createdId: string | null = null;
        await act(async () => {
            createdId = await result.current.onCreateProject('Garden redesign');
            await Promise.resolve();
        });

        expect(createdId).toBe('project-created');
        expect(reportError).toHaveBeenCalledWith('Failed to log task-menu project creation', diagnosticError);
    });
});

describe('task cancellation quick action', () => {
    const cancelledAt = '2026-09-24T12:00:00.000Z';
    const focusedTask = { ...task, isFocusedToday: true, focusOrder: 3, boardOrder: 7 };
    const initialTaskState = useTaskStore.getState();
    const initialUiState = useUiStore.getState();

    afterEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
    });

    it.each([false, true])('shows Archive feedback and undoes a %s recurring task without losing newer edits', async (recurring) => {
        const original: Task = recurring
            ? { ...focusedTask, recurrence: { rule: 'daily', strategy: 'strict' } }
            : focusedTask;
        const showToast = vi.fn();
        const cancelTask = vi.fn(async () => {
            const cancelled = { ...original, status: 'archived' as const, cancelledAt, isFocusedToday: false, focusOrder: undefined, boardOrder: undefined };
            useTaskStore.setState({ _allTasks: [cancelled], _tasksById: new Map([[task.id, cancelled]]) });
            return { success: true };
        });
        const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
            const current = useTaskStore.getState()._tasksById.get(task.id)!;
            const restored = { ...current, ...patch };
            useTaskStore.setState({ _allTasks: [restored], _tasksById: new Map([[task.id, restored]]) });
            return { success: true };
        });
        act(() => {
            useTaskStore.setState({ _allTasks: [original], _tasksById: new Map([[task.id, original]]), cancelTask, updateTask });
            useUiStore.setState({ showToast });
        });
        const { result } = renderHook(() => useTaskQuickActionMenuProps(original));

        await act(async () => {
            await result.current.extraActions?.find((action) => action.id === 'cancel-task')?.onSelect();
        });
        expect(cancelTask).toHaveBeenCalledExactlyOnceWith(task.id);
        expect(showToast).toHaveBeenCalledWith(
            'Task cancelled. You can restore it from Archive.', 'info', 5000,
            expect.objectContaining({ label: 'Undo' }),
        );
        const undo = showToast.mock.calls[0][3].onClick as () => void;
        const newer = { ...useTaskStore.getState()._tasksById.get(task.id)!, title: 'Later edit' };
        act(() => useTaskStore.setState({ _allTasks: [newer], _tasksById: new Map([[task.id, newer]]) }));

        await act(async () => { undo(); await Promise.resolve(); });
        expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, {
            status: 'next', cancelledAt: undefined, completedAt: undefined,
            isFocusedToday: true, focusOrder: 3, boardOrder: 7,
        });
        expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({ title: 'Later edit', status: 'next', isFocusedToday: true });
    });

    it('offers a durable retry after optimistic cancellation fails, then undoes to the original status', async () => {
        const showToast = vi.fn();
        const cancelled = { ...task, status: 'archived' as const, cancelledAt };
        const cancelTask = vi.fn()
            .mockImplementationOnce(async () => {
                useTaskStore.setState({ _allTasks: [cancelled], _tasksById: new Map([[task.id, cancelled]]) });
                return { success: false, error: 'disk full' };
            })
            .mockResolvedValueOnce({ success: true });
        const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
            const restored = { ...useTaskStore.getState()._tasksById.get(task.id)!, ...patch };
            useTaskStore.setState({ _allTasks: [restored], _tasksById: new Map([[task.id, restored]]) });
            return { success: true };
        });
        act(() => {
            useTaskStore.setState({ _allTasks: [task], _tasksById: new Map([[task.id, task]]), cancelTask, updateTask });
            useUiStore.setState({ showToast });
        });
        const { result } = renderHook(() => useTaskQuickActionMenuProps(task));
        await act(async () => {
            await result.current.extraActions?.find((action) => action.id === 'cancel-task')?.onSelect();
        });
        expect(showToast).toHaveBeenCalledExactlyOnceWith('disk full', 'error', 5000, expect.objectContaining({ label: 'Try again' }));
        await act(async () => { showToast.mock.calls[0][3].onClick(); await Promise.resolve(); });
        expect(cancelTask).toHaveBeenCalledTimes(2);
        expect(showToast).toHaveBeenLastCalledWith(
            'Task cancelled. You can restore it from Archive.', 'info', 5000,
            expect.objectContaining({ label: 'Undo' }),
        );
        await act(async () => { showToast.mock.lastCall?.[3].onClick(); await Promise.resolve(); });
        expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'next', cancelledAt: undefined }));
    });
});

describe('useTaskQuickActionMenuProps contexts panel', () => {
    afterEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
    });

    it('merges the saved contexts onto the contexts a sync save published since the panel opened', async () => {
        const opened: Task = { ...task, contexts: ['@a'], rev: 1 };
        act(() => { useTaskStore.setState({ _allTasks: [opened] }); });
        render(<TaskQuickActionMenuHost task={opened} x={0} y={0} onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Contexts…' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'task.aria.contexts' }), { target: { value: '@a, @mine' } });
        // A sync save holds the gate while the user saves, then publishes another device's added context.
        const finish = holdSyncSave(() => useTaskStore.setState({ _allTasks: [{ ...opened, rev: 3, contexts: ['@a', '@remote'] }] }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await act(finish);

        await vi.waitFor(() => expect(useTaskStore.getState()._tasksById.get(task.id)?.contexts).toEqual(['@a', '@remote', '@mine']));
    });
});
