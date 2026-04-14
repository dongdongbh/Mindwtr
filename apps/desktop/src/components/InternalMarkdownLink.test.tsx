import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { Project, Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { MINDWTR_NAVIGATE_EVENT } from '../lib/navigation-events';
import { useUiStore } from '../store/ui-store';
import { InternalMarkdownLink } from './InternalMarkdownLink';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

describe('InternalMarkdownLink', () => {
    beforeEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
    });

    it('restores deleted task links and navigates to the live task view', async () => {
        const deletedTask: Task = {
            id: 'task-1',
            title: 'Deleted task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z',
            deletedAt: '2026-04-13T01:00:00.000Z',
        };
        const restoredTask: Task = {
            ...deletedTask,
            deletedAt: undefined,
        };
        const restoreTask = vi.fn(async () => {
            act(() => {
                useTaskStore.setState((state) => ({
                    ...state,
                    tasks: [restoredTask],
                    _allTasks: [restoredTask],
                }));
            });
            return { success: true, id: restoredTask.id };
        });
        const onNavigate = vi.fn();
        window.addEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [],
                _allTasks: [deletedTask],
                projects: [],
                _allProjects: [],
                restoreTask,
            }));
        });

        try {
            const { getByRole, getByText } = render(
                <LanguageProvider>
                    <InternalMarkdownLink href="mindwtr://task/task-1">Deleted task</InternalMarkdownLink>
                </LanguageProvider>
            );

            expect(getByText('(deleted task)')).toBeInTheDocument();
            fireEvent.click(getByRole('button', { name: /restore/i }));

            await waitFor(() => {
                expect(restoreTask).toHaveBeenCalledWith('task-1');
                expect(onNavigate).toHaveBeenCalled();
            });
        } finally {
            window.removeEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);
        }
    });

    it('restores deleted project links and opens the projects view', async () => {
        const deletedProject: Project = {
            id: 'project-1',
            title: 'Deleted project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: '2026-04-13T00:00:00.000Z',
            updatedAt: '2026-04-13T00:00:00.000Z',
            deletedAt: '2026-04-13T01:00:00.000Z',
        };
        const restoredProject: Project = {
            ...deletedProject,
            deletedAt: undefined,
        };
        const restoreProject = vi.fn(async () => {
            act(() => {
                useTaskStore.setState((state) => ({
                    ...state,
                    projects: [restoredProject],
                    _allProjects: [restoredProject],
                }));
            });
            return { success: true, id: restoredProject.id };
        });
        const onNavigate = vi.fn();
        window.addEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                projects: [],
                _allProjects: [deletedProject],
                restoreProject,
            }));
        });

        try {
            const { getByRole, getByText } = render(
                <LanguageProvider>
                    <InternalMarkdownLink href="mindwtr://project/project-1">Deleted project</InternalMarkdownLink>
                </LanguageProvider>
            );

            expect(getByText('(deleted project)')).toBeInTheDocument();
            fireEvent.click(getByRole('button', { name: /restore/i }));

            await waitFor(() => {
                expect(restoreProject).toHaveBeenCalledWith('project-1');
                expect(onNavigate).toHaveBeenCalled();
                expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-1');
            });
        } finally {
            window.removeEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);
        }
    });
});
