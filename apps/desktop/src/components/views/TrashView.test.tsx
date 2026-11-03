import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { TrashView } from './TrashView';

const initialTaskState = useTaskStore.getState();

const recentTask: Task = {
    id: 'recent-task',
    title: 'Recently deleted task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-13T12:00:00.000Z',
    deletedAt: '2026-07-13T12:00:00.000Z',
};

const olderProject: Project = {
    id: 'older-project',
    title: 'Older deleted project',
    status: 'archived',
    color: '#64748b',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    deletedAt: '2026-07-01T12:00:00.000Z',
};

describe('TrashView', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            tasks: [],
            projects: [],
            _allTasks: [recentTask],
            _allProjects: [olderProject],
            _tasksById: new Map([[recentTask.id, recentTask]]),
            settings: {},
        });
    });

    it('shows tasks and projects in one newest-deleted-first timeline', () => {
        const { getByText } = render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );

        const taskTitle = getByText(recentTask.title);
        const projectTitle = getByText(olderProject.title);

        expect(taskTitle.compareDocumentPosition(projectTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('says how long trashed items are kept', () => {
        render(<LanguageProvider><TrashView /></LanguageProvider>);
        expect(screen.getByText('Items in Trash are removed for good after 90 days')).toBeInTheDocument();
    });


    it('honours the app-wide area filter', () => {
        const workTask: Task = { ...recentTask, id: 'work-task', title: 'Work deleted task', areaId: 'area-work' };
        const workProject: Project = { ...olderProject, id: 'work-project', title: 'Work deleted project', areaId: 'area-work' };
        useTaskStore.setState({


            _allAreas: [
                { id: 'area-work', name: 'Work', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            _allTasks: [recentTask, workTask],
            _tasksById: new Map([[recentTask.id, recentTask], [workTask.id, workTask]]),
            _allProjects: [olderProject, workProject],
            settings: { filters: { excludedAreaIds: ['area-work'] } },
        });

        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );

        expect(screen.getByText(recentTask.title)).toBeInTheDocument();
        expect(screen.getByText(olderProject.title)).toBeInTheDocument();
        expect(screen.queryByText('Work deleted task')).not.toBeInTheDocument();
        expect(screen.queryByText('Work deleted project')).not.toBeInTheDocument();
    });


    const renderWithHiddenWorkArea = () => {
        const workTask: Task = { ...recentTask, id: 'work-task', title: 'Work deleted task', areaId: 'area-work' };
        const workProject: Project = { ...olderProject, id: 'work-project', title: 'Work deleted project', areaId: 'area-work' };
        useTaskStore.setState({
            _allAreas: [
                { id: 'area-work', name: 'Work', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            _allTasks: [recentTask, workTask],
            _tasksById: new Map([[recentTask.id, recentTask], [workTask.id, workTask]]),
            _allProjects: [olderProject, workProject],
            settings: { filters: { excludedAreaIds: ['area-work'] } },
        });

        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );
    };

    it('Clear Trash leaves items hidden by the area filter restorable', async () => {
        renderWithHiddenWorkArea();

        fireEvent.click(screen.getByRole('button', { name: 'Clear Trash' }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveTextContent('1');
        expect(dialog).not.toHaveTextContent(/all trashed/i);


        const description = dialog.querySelector('p')!;
        expect(description.textContent).toBe('1 tasks · 1 Projects\nThis action cannot be undone.');
        expect(description.className).toContain('whitespace-pre-line');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Trash' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id)?.purgedAt).toBeTruthy();
            expect(useTaskStore.getState()._allProjects.find((project) => project.id === olderProject.id)?.purgedAt).toBeTruthy();
        });
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'work-task')?.purgedAt).toBeUndefined();
        expect(useTaskStore.getState()._allProjects.find((project) => project.id === 'work-project')?.purgedAt).toBeUndefined();
    });

    it('Clear Trash leaves items hidden by the search box restorable', async () => {
        const otherTask: Task = { ...recentTask, id: 'other-task', title: 'Another deleted task' };
        useTaskStore.setState({
            _allTasks: [recentTask, otherTask],
            _tasksById: new Map([[recentTask.id, recentTask], [otherTask.id, otherTask]]),
            _allProjects: [olderProject],
        });

        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );

        fireEvent.change(screen.getByPlaceholderText('Search trashed tasks...'), { target: { value: 'Recently' } });
        fireEvent.click(screen.getByRole('button', { name: 'Clear Trash' }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).not.toHaveTextContent(/all trashed/i);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Trash' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id)?.purgedAt).toBeTruthy();
        });
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'other-task')?.purgedAt).toBeUndefined();
        expect(useTaskStore.getState()._allProjects.find((project) => project.id === olderProject.id)?.purgedAt).toBeUndefined();
    });

    it('Clear Trash with nothing hidden keeps the "all trashed" wording', async () => {
        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Clear Trash' }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveTextContent('all trashed tasks and projects');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Trash' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id)?.purgedAt).toBeTruthy();
            expect(useTaskStore.getState()._allProjects.find((project) => project.id === olderProject.id)?.purgedAt).toBeTruthy();
        });
    });


    it('purges only the items the dialog was opened for', async () => {
        useTaskStore.setState({
            _allAreas: [
                { id: 'area-work', name: 'Work', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            settings: { filters: { excludedAreaIds: ['area-work'] } },
        });

        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );


        fireEvent.click(screen.getByRole('button', { name: 'Clear Trash' }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveTextContent('all trashed tasks and projects');


        const arrivingTask: Task = { ...recentTask, id: 'arriving-task', title: 'Arriving deleted task', areaId: 'area-work' };
        act(() => {
            useTaskStore.setState({
                _allTasks: [recentTask, arrivingTask],
                _tasksById: new Map([[recentTask.id, recentTask], [arrivingTask.id, arrivingTask]]),
            });
        });

        fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Trash' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id)?.purgedAt).toBeTruthy();
        });
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'arriving-task')?.purgedAt).toBeUndefined();
    });

    it('bulk restores selected trashed tasks and projects', async () => {
        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        fireEvent.click(screen.getByRole('button', { name: /Select all/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id)?.deletedAt).toBeUndefined();
            expect(useTaskStore.getState()._allProjects.find((project) => project.id === olderProject.id)?.deletedAt).toBeUndefined();
        });
    });


    describe('keyboard scope', () => {
        const olderTask: Task = {
            ...recentTask,
            id: 'older-task',
            title: 'Older deleted task',
            deletedAt: '2026-06-20T12:00:00.000Z',
        };

        const renderWithKeys = () => {
            useTaskStore.setState({
                _allTasks: [recentTask, olderTask],
                _tasksById: new Map([
                    [recentTask.id, recentTask],
                    [olderTask.id, olderTask],
                ]),
                settings: { keybindingStyle: 'vim' },
            });
            return render(
                <LanguageProvider>
                    <KeybindingProvider currentView="trash" onNavigate={vi.fn()}>
                        <TrashView />
                    </KeybindingProvider>
                </LanguageProvider>
            );
        };

        const focusedTaskId = () => (
            document.activeElement instanceof HTMLElement
                ? document.activeElement.closest<HTMLElement>('[data-task-id]')?.dataset.taskId
                : undefined
        );

        it('moves between trashed task rows with j/k, skipping project rows', () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 'j' });
            expect(focusedTaskId()).toBe(olderTask.id);

            fireEvent.keyDown(window, { key: 'k' });
            expect(focusedTaskId()).toBe(recentTask.id);
        });

        it('restores the selected task with e', async () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 'e' });

            await waitFor(() => {
                expect(useTaskStore.getState()._tasksById.get(recentTask.id)?.deletedAt).toBeUndefined();
            });
        });


        it('leaves the status chords unbound rather than mutating a deleted task', () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 's' });
            fireEvent.keyDown(window, { key: 'n' });

            const task = useTaskStore.getState()._tasksById.get(recentTask.id);
            expect(task?.status).toBe('inbox');
            expect(task?.deletedAt).toBe(recentTask.deletedAt);
        });

        it('purges the selected task with dd, after confirmation', async () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 'd' });
            fireEvent.keyDown(window, { key: 'd' });

            fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

            await waitFor(() => {
                expect(useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id)?.purgedAt).toBeTruthy();
            });
        });
    });

    it('bulk purges selected trashed items after confirmation', async () => {
        render(
            <LanguageProvider>
                <TrashView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        fireEvent.click(screen.getByRole('checkbox', { name: `Select ${recentTask.title}` }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete Permanently' }));

        await waitFor(() => {
            const purgedTask = useTaskStore.getState()._allTasks.find((task) => task.id === recentTask.id);
            expect(purgedTask?.purgedAt).toBeTruthy();
        });

        expect(useTaskStore.getState()._allProjects.find((project) => project.id === olderProject.id)?.purgedAt).toBeUndefined();
    });
});
