import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Area, type Project, type Task } from '@mindwtr/core';

import { logInfo } from '../../lib/app-log';
import { reportError } from '../../lib/report-error';
import { useUiStore } from '../../store/ui-store';
import { useTaskQuickActionMenuProps } from './useTaskQuickActionMenuProps';

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
                releaseCheck: 'v1.3.0/task-menu-project-create',
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
