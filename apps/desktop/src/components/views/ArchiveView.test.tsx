import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '@mindwtr/core';
import { safeFormatDate, useTaskStore } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { useUiStore } from '../../store/ui-store';
import { ArchiveView } from './ArchiveView';
import { expectScrolledEndGap } from '../../test/list-end-gap';
import { MINDWTR_NAVIGATE_EVENT } from '../../lib/navigation-events';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

const archivedTask: Task = {
    id: 'task-1',
    title: 'Archived task',
    status: 'archived',
    tags: [],
    contexts: [],
    completedAt: '2026-05-12T08:30:00.000Z',
    createdAt: '2026-05-10T08:30:00.000Z',
    updatedAt: '2026-05-12T08:30:00.000Z',
};

const archivedProject: Project = {
    id: 'project-1',
    title: 'Archived project',
    status: 'archived',
    color: '#6B7280',
    order: 0,
    tagIds: [],
    createdAt: '2026-05-01T08:30:00.000Z',
    updatedAt: '2026-05-11T08:30:00.000Z',
};

describe('ArchiveView', () => {
    beforeEach(() => {


        useUiStore.setState(initialUiState, true);
        useTaskStore.setState(initialTaskState, true);
        window.localStorage.removeItem('mindwtr:view:archive:v1');
        useTaskStore.setState({
            tasks: [],
            _allTasks: [archivedTask],
            _tasksById: new Map([[archivedTask.id, archivedTask]]),
            projects: [],
            _allProjects: [],
            settings: {},
        });
    });

    it('ends the list with the shared end gap, not with viewport padding (#977)', () => {
        const { container } = render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        expectScrolledEndGap(container);
    });

    it('shows the archived task completion date and time', () => {
        const completionLabel = safeFormatDate(archivedTask.completedAt, 'Pp');

        const { getByText } = render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        expect(getByText('Archived task')).toBeInTheDocument();
        expect(getByText(`Completed: ${completionLabel}`)).toBeInTheDocument();
    });

    it('labels the active search chip with Search instead of the input placeholder', () => {
        render(<LanguageProvider><ArchiveView /></LanguageProvider>);
        fireEvent.change(screen.getByPlaceholderText('Search archived tasks...'), { target: { value: 'Archived' } });
        expect(screen.getAllByText('Search: Archived').length).toBeGreaterThan(0);
    });

    it('shows a cancelled task as Cancelled without completion styling', () => {
        const cancelledAt = '2026-05-12T09:45:00.000Z';
        const cancelledTask = {
            ...archivedTask,
            title: 'Cancelled task',
            completedAt: undefined,
            cancelledAt,
        };
        useTaskStore.setState({
            _allTasks: [cancelledTask],
            _tasksById: new Map([[cancelledTask.id, cancelledTask]]),
        });

        const { container } = render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        expect(screen.getByText(`Cancelled: ${safeFormatDate(cancelledAt, 'Pp')}`)).toBeInTheDocument();
        expect(screen.queryByText(/^Completed:/)).not.toBeInTheDocument();
        expect(container.querySelector('.task-item-display__title')).not.toHaveClass('line-through');
    });


    it('opens an archived task read-only, without restoring it', () => {
        const taskWithNotes: Task = {
            ...archivedTask,
            description: 'Receipt is in the shared drive',
            checklist: [{ id: 'c1', title: 'Scan receipt', isCompleted: true }],
        };
        useTaskStore.setState({
            _allTasks: [taskWithNotes],
            _tasksById: new Map([[taskWithNotes.id, taskWithNotes]]),
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );


        expect(screen.queryByText('Scan receipt')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Toggle task details: Archived task' }));

        expect(screen.getByText('Receipt is in the shared drive')).toBeInTheDocument();
        expect(screen.getByText('Scan receipt')).toBeInTheDocument();

        expect(useTaskStore.getState()._tasksById.get(taskWithNotes.id)?.status).toBe('archived');
    });

    it('restores an archived task to the Inbox from the row, not to Next', async () => {
        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Restore to Inbox' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._tasksById.get(archivedTask.id)?.status).toBe('inbox');
        });
    });

    it('moves an archived task to Trash instead of purging it', async () => {
        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));

        await waitFor(() => {
            const deletedTask = useTaskStore.getState()._tasksById.get(archivedTask.id);
            expect(deletedTask?.deletedAt).toBeTruthy();
            expect(deletedTask?.purgedAt).toBeUndefined();
        });
    });

    it('bulk restores selected archived tasks to Inbox', async () => {
        const secondArchivedTask: Task = {
            ...archivedTask,
            id: 'task-2',
            title: 'Second archived task',
        };
        useTaskStore.setState({
            _allTasks: [archivedTask, secondArchivedTask],
            _tasksById: new Map([
                [archivedTask.id, archivedTask],
                [secondArchivedTask.id, secondArchivedTask],
            ]),
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        fireEvent.click(screen.getByRole('button', { name: /Select all/i }));
        expect(screen.queryByRole('button', { name: 'Move to Done' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Restore to Inbox' }));

        await waitFor(() => {
            expect(useTaskStore.getState()._tasksById.get(archivedTask.id)?.status).toBe('inbox');
            expect(useTaskStore.getState()._tasksById.get(secondArchivedTask.id)?.status).toBe('inbox');
        });
    });

    it('bulk moves selected archived tasks to Trash', async () => {
        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Select' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select task' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            const deletedTask = useTaskStore.getState()._tasksById.get(archivedTask.id);
            expect(deletedTask?.deletedAt).toBeTruthy();
            expect(deletedTask?.purgedAt).toBeUndefined();
        });
    });

    it('lists archived projects when the Projects segment is selected', () => {
        useTaskStore.setState({
            projects: [archivedProject],
            _allProjects: [archivedProject],
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        expect(screen.queryByText('Archived project')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        expect(screen.getByText('Archived project')).toBeInTheDocument();
    });

    it('distinguishes cancelled projects in the Archive project segment', () => {
        const cancelledAt = '2026-05-11T09:00:00.000Z';
        const cancelledProject = { ...archivedProject, cancelledAt };
        useTaskStore.setState({
            projects: [cancelledProject],
            _allProjects: [cancelledProject],
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );
        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

        expect(screen.getByText(`Cancelled: ${safeFormatDate(cancelledAt, 'Pp')}`)).toBeInTheDocument();
        expect(screen.queryByText(/^Completed:/)).not.toBeInTheDocument();
    });

    it('opens an archived project from its title row', () => {
        useTaskStore.setState({
            projects: [archivedProject],
            _allProjects: [archivedProject],
        });
        const onNavigate = vi.fn();
        window.addEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);

        try {
            render(
                <LanguageProvider>
                    <ArchiveView />
                </LanguageProvider>
            );

            fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
            fireEvent.click(screen.getByRole('button', { name: archivedProject.title }));

            expect(useUiStore.getState().projectView.selectedProjectId).toBe(archivedProject.id);
            expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
                detail: { view: 'projects' },
            }));
        } finally {
            window.removeEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);
        }
    });


    it('honours the app-wide area filter for archived tasks and projects', () => {
        const homeTask: Task = { ...archivedTask, id: 'task-2', title: 'Home archived task', areaId: 'area-home' };
        const workTask: Task = { ...archivedTask, id: 'task-3', title: 'Work archived task', areaId: 'area-work' };
        const workProject: Project = { ...archivedProject, id: 'project-2', title: 'Work archived project', areaId: 'area-work' };
        useTaskStore.setState({


            _allAreas: [
                { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
                { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
            _allTasks: [homeTask, workTask],
            _tasksById: new Map([[homeTask.id, homeTask], [workTask.id, workTask]]),
            projects: [archivedProject, workProject],
            _allProjects: [archivedProject, workProject],
            settings: { filters: { excludedAreaIds: ['area-work'] } },
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        expect(screen.getByText('Home archived task')).toBeInTheDocument();
        expect(screen.queryByText('Work archived task')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        expect(screen.getByText('Archived project')).toBeInTheDocument();
        expect(screen.queryByText('Work archived project')).not.toBeInTheDocument();
    });

    it('shows the projects empty state when there are no archived projects', () => {
        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        expect(screen.getByText('No archived projects')).toBeInTheDocument();
    });

    it('restores an archived project via updateProject with active status', async () => {
        useTaskStore.setState({
            projects: [archivedProject],
            _allProjects: [archivedProject],
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        fireEvent.click(screen.getByTitle('Restore project'));

        await waitFor(() => {
            const restored = useTaskStore.getState()._allProjects.find((p) => p.id === archivedProject.id);
            expect(restored?.status).toBe('active');
            expect(restored?.deletedAt).toBeUndefined();
        });
    });

    it('soft-deletes an archived project after confirmation', async () => {
        useTaskStore.setState({
            projects: [archivedProject],
            _allProjects: [archivedProject],
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        fireEvent.click(screen.getByTitle('Delete'));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            const deleted = useTaskStore.getState()._allProjects.find((p) => p.id === archivedProject.id);
            expect(deleted?.deletedAt).toBeTruthy();
            expect(deleted?.purgedAt).toBeUndefined();
        });
    });


    describe('keyboard scope', () => {
        const secondTask: Task = { ...archivedTask, id: 'task-2', title: 'Second archived task' };

        const renderWithKeys = () => {
            useTaskStore.setState({
                _allTasks: [archivedTask, secondTask],
                _tasksById: new Map([
                    [archivedTask.id, archivedTask],
                    [secondTask.id, secondTask],
                ]),
                settings: { keybindingStyle: 'vim' },
            });
            return render(
                <LanguageProvider>
                    <KeybindingProvider currentView="archived" onNavigate={vi.fn()}>
                        <ArchiveView />
                    </KeybindingProvider>
                </LanguageProvider>
            );
        };

        const focusedTaskId = () => (
            document.activeElement instanceof HTMLElement
                ? document.activeElement.closest<HTMLElement>('[data-task-id]')?.dataset.taskId
                : undefined
        );

        it('moves between archived rows with j/k', () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 'j' });
            expect(focusedTaskId()).toBe(secondTask.id);

            fireEvent.keyDown(window, { key: 'k' });
            expect(focusedTaskId()).toBe(archivedTask.id);
        });

        it('opens the completion-time editor with e', () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 'e' });

            expect(screen.getByRole('dialog')).toHaveTextContent('Completion time');
        });

        it('moves the selected task to another status with an s-chord', async () => {
            renderWithKeys();

            fireEvent.keyDown(window, { key: 's' });
            fireEvent.keyDown(window, { key: 'n' });

            await waitFor(() => {
                expect(useTaskStore.getState()._tasksById.get(archivedTask.id)?.status).toBe('next');
            });
        });

        it('does not act on archived tasks while the projects segment is showing', () => {
            renderWithKeys();

            fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
            fireEvent.keyDown(window, { key: 'j' });

            expect(focusedTaskId()).toBeUndefined();
        });
    });

    describe('filter, sort and grouping toolbar', () => {
        const homeTask: Task = {
            ...archivedTask,
            id: 'task-2',
            title: 'Tidy the garage',
            contexts: ['@home'],
            projectId: 'project-9',
            completedAt: '2026-05-14T08:30:00.000Z',
            updatedAt: '2026-05-14T08:30:00.000Z',
        };
        const activeProject: Project = {
            ...archivedProject,
            id: 'project-9',
            title: 'House',
            status: 'active',
        };

        const renderWithBoth = () => {
            useTaskStore.setState({
                _allTasks: [archivedTask, homeTask],
                _tasksById: new Map([
                    [archivedTask.id, archivedTask],
                    [homeTask.id, homeTask],
                ]),
                projects: [activeProject],
                _allProjects: [activeProject],
            });
            return render(
                <LanguageProvider>
                    <ArchiveView />
                </LanguageProvider>
            );
        };

        const rowTitles = () => Array.from(document.querySelectorAll('[data-task-id] .task-item-display__title')).map((el) => el.textContent);

        const pickOption = (selectName: string, optionName: string) => {
            fireEvent.click(screen.getByRole('combobox', { name: selectName }));
            fireEvent.click(screen.getByRole('option', { name: optionName }));
        };

        it('narrows the archive to a context picked in the Filters panel', () => {
            renderWithBoth();

            fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
            fireEvent.click(screen.getByRole('button', { name: 'Contexts & tags' }));


            fireEvent.click(screen.getByRole('button', { name: /^@home/ }));

            expect(screen.getByText('Tidy the garage')).toBeInTheDocument();
            expect(screen.queryByText('Archived task')).not.toBeInTheDocument();
            expect(screen.getByText('1 tasks')).toBeInTheDocument();
        });


        it('offers a token set in another view even when nothing archived matches it', () => {
            useUiStore.setState((state) => ({
                listFilters: { ...state.listFilters, criteria: { contexts: ['@office'] } },
            }));
            renderWithBoth();

            expect(rowTitles()).toEqual([]);

            fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
            fireEvent.click(screen.getByRole('button', { name: 'Contexts & tags' }));


            fireEvent.click(screen.getByRole('button', { name: '@office' }));
            expect(rowTitles()).toHaveLength(2);
            expect(useUiStore.getState().listFilters.criteria.excludedContexts).toEqual(['@office']);

            fireEvent.click(screen.getByRole('button', { name: '@office (Excluded)' }));
            expect(rowTitles()).toHaveLength(2);
            expect(useUiStore.getState().listFilters.criteria).toEqual({});
        });


        it('does not count criteria this view never applies as active filters', () => {
            useUiStore.setState((state) => ({
                listFilters: { ...state.listFilters, criteria: { priority: ['high'] }, open: true },
            }));
            renderWithBoth();

            expect(rowTitles()).toHaveLength(2);
            const summaryRow = screen.getByText('2 tasks').parentElement as HTMLElement;
            expect(within(summaryRow).queryByText(/High/)).toBeNull();

            const remove = screen.getByRole('button', { name: 'Remove filter: High' });
            expect((remove.parentElement as HTMLElement).className).toContain('opacity-60');
            fireEvent.click(remove);
            expect(useUiStore.getState().listFilters.criteria).not.toHaveProperty('priority');
        });

        it('subtracts archived tasks carrying an excluded context (#982)', () => {
            renderWithBoth();

            fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
            fireEvent.click(screen.getByRole('button', { name: 'Contexts & tags' }));
            const chip = () => screen.getByRole('button', { name: /^@home/ });
            fireEvent.click(chip());
            fireEvent.click(chip());

            expect(screen.getByText('Archived task')).toBeInTheDocument();
            expect(screen.queryByText('Tidy the garage')).not.toBeInTheDocument();
        });

        it('defaults to newest completion first and re-sorts by title on request', () => {
            renderWithBoth();
            const sort = screen.getByRole('combobox', { name: 'Sort' });
            const group = screen.getByRole('combobox', { name: 'Group' });

            expect(rowTitles()).toEqual(['Tidy the garage', 'Archived task']);
            expect(sort).toHaveClass('bg-card');
            expect(group).toHaveClass('bg-card');
            expect(screen.queryByRole('button', { name: 'View options' })).not.toBeInTheDocument();

            pickOption('Sort', 'Title');

            expect(rowTitles()).toEqual(['Archived task', 'Tidy the garage']);
            expect(sort).toHaveClass('bg-primary/10');
            expect(group).toHaveClass('bg-card');

            pickOption('Sort', 'Default');
            expect(sort).toHaveClass('bg-card');
        });

        it('groups archived tasks by the chosen axis', () => {
            renderWithBoth();

            expect(screen.queryByRole('button', { name: /House\s*1/i })).not.toBeInTheDocument();

            pickOption('Group', 'Project');

            expect(screen.getByRole('button', { name: /House\s*1/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /No Project\s*1/i })).toBeInTheDocument();
        });

        it('collapses a group and leaves it collapsed on the next visit (#963)', () => {
            const firstRender = renderWithBoth();

            pickOption('Group', 'Project');
            fireEvent.click(screen.getByRole('button', { name: /House\s*1/i }));

            expect(screen.getByRole('button', { name: /House\s*1/i })).toHaveAttribute('aria-expanded', 'false');
            expect(rowTitles()).toEqual(['Archived task']);

            firstRender.unmount();
            renderWithBoth();
            expect(rowTitles()).toEqual(['Archived task']);
        });

        it('leaves a collapsed group out of Select all', async () => {
            renderWithBoth();

            pickOption('Group', 'Project');
            fireEvent.click(screen.getByRole('button', { name: /House\s*1/i }));
            fireEvent.click(screen.getByRole('button', { name: 'Select' }));
            fireEvent.click(screen.getByRole('button', { name: /Select all/i }));
            fireEvent.click(screen.getByRole('button', { name: 'Restore to Inbox' }));


            await waitFor(() => {
                expect(useTaskStore.getState()._tasksById.get(archivedTask.id)?.status).toBe('inbox');
            });
            expect(useTaskStore.getState()._tasksById.get(homeTask.id)?.status).toBe('archived');
        });

        it('virtualizes about 5k grouped tasks without changing the Projects segment', () => {
            const manyArchivedTasks = Array.from({ length: 5_000 }, (_, index): Task => ({
                ...archivedTask,
                id: `task-${index}`,
                title: `Archived task ${index}`,
                projectId: activeProject.id,
            }));
            useTaskStore.setState({
                _allTasks: manyArchivedTasks,
                _tasksById: new Map(manyArchivedTasks.map((task) => [task.id, task])),
                projects: [activeProject, archivedProject],
                _allProjects: [activeProject, archivedProject],
            });
            useUiStore.setState((state) => ({
                listOptions: {
                    ...state.listOptions,
                    archivedGroupBy: 'project',
                },
            }));

            render(
                <LanguageProvider>
                    <ArchiveView />
                </LanguageProvider>
            );

            expect(screen.getByTestId('virtualized-task-list')).toHaveAttribute('data-grouped', 'true');
            expect(document.querySelectorAll('[data-task-id]').length).toBeLessThan(100);

            fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

            expect(screen.getByText('Archived project')).toBeInTheDocument();
            expect(screen.queryByTestId('virtualized-task-list')).not.toBeInTheDocument();
        });

        it('keeps the toolbar out of the Projects segment', () => {
            renderWithBoth();

            fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

            expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
            expect(screen.queryByRole('combobox', { name: 'Group' })).not.toBeInTheDocument();
        });
    });


    describe('revealing a task sent here by global search', () => {
        const homeTask: Task = {
            ...archivedTask,
            id: 'task-2',
            title: 'Tidy the garage',
            contexts: ['@home'],
            projectId: 'project-9',
        };
        const liveTask: Task = {
            ...archivedTask,
            id: 'task-3',
            title: 'Still to do',
            status: 'next',
            completedAt: undefined,
        };
        const activeProject: Project = {
            ...archivedProject,
            id: 'project-9',
            title: 'House',
            status: 'active',
        };

        const renderArchive = (extraTasks: Task[] = []) => {
            const tasks = [archivedTask, homeTask, ...extraTasks];
            useTaskStore.setState({
                _allTasks: tasks,
                _tasksById: new Map(tasks.map((task) => [task.id, task])),
                projects: [activeProject],
                _allProjects: [activeProject],
            });
            return render(
                <LanguageProvider>
                    <ArchiveView />
                </LanguageProvider>
            );
        };

        const rowTitles = () => Array
            .from(document.querySelectorAll('[data-task-id] .task-item-display__title'))
            .map((element) => element.textContent);

        const highlight = (taskId: string) => act(() => {
            useTaskStore.setState({ highlightTaskId: taskId });
        });

        const groupByProject = () => {
            fireEvent.click(screen.getByRole('combobox', { name: 'Group' }));
            fireEvent.click(screen.getByRole('option', { name: 'Project' }));
        };

        it('expands the collapsed group the task sits in', () => {
            renderArchive();
            groupByProject();
            fireEvent.click(screen.getByRole('button', { name: /House\s*1/i }));
            expect(rowTitles()).toEqual(['Archived task']);

            highlight(homeTask.id);

            expect(screen.getByRole('button', { name: /House\s*1/i })).toHaveAttribute('aria-expanded', 'true');
            expect(rowTitles()).toContain('Tidy the garage');
        });

        it('keeps other collapsed groups folded when a highlighted task appears in more than one', () => {
            const dualTagTask: Task = {
                ...archivedTask,
                id: 'dual-tag-task',
                title: 'Dual-tag archive task',
                tags: ['#alpha', '#beta'],
            };
            renderArchive([dualTagTask]);
            fireEvent.click(screen.getByRole('combobox', { name: 'Group' }));
            fireEvent.click(screen.getByRole('option', { name: 'Tags' }));
            const alpha = () => screen.getByRole('button', { name: /#alpha\s*1/i });
            const beta = () => screen.getByRole('button', { name: /#beta\s*1/i });
            fireEvent.click(alpha());
            fireEvent.click(beta());

            highlight(dualTagTask.id);

            expect([alpha(), beta()].filter((group) => group.getAttribute('aria-expanded') === 'true')).toHaveLength(1);
            expect(screen.getAllByText('Dual-tag archive task')).toHaveLength(1);
        });

        it('clears an archive filter that hides the task and says why', () => {
            const showToast = vi.fn();
            useUiStore.setState((state) => ({
                ...state,
                showToast,
                listFilters: { ...state.listFilters, criteria: { contexts: ['@office'] } },
            }));
            renderArchive();
            expect(rowTitles()).toEqual([]);

            highlight(archivedTask.id);

            expect(useUiStore.getState().listFilters.criteria).toEqual({});
            expect(showToast).toHaveBeenCalledWith(
                'Cleared the archive filters so the selected task is visible.',
                'info',
            );
            expect(rowTitles()).toContain('Archived task');
        });

        it('clears the archive search box when it is what hides the task', () => {
            renderArchive();
            fireEvent.change(screen.getByPlaceholderText('Search archived tasks...'), {
                target: { value: 'garage' },
            });
            expect(rowTitles()).toEqual(['Tidy the garage']);

            highlight(archivedTask.id);

            expect(rowTitles()).toContain('Archived task');
        });


        it('ignores a highlight for a task that is not archived', () => {
            const showToast = vi.fn();
            useUiStore.setState((state) => ({
                ...state,
                showToast,
                listFilters: { ...state.listFilters, criteria: { contexts: ['@office'] } },
            }));
            renderArchive([liveTask]);

            highlight(liveTask.id);

            expect(useUiStore.getState().listFilters.criteria).toEqual({ contexts: ['@office'] });
            expect(showToast).not.toHaveBeenCalled();
        });


        it('scrolls the virtualized row into view once and lets the user scroll away', () => {
            const originalRect = Element.prototype.getBoundingClientRect;


            Element.prototype.getBoundingClientRect = function fakeRect() {
                return { height: 120, width: 0, top: 0, left: 0, right: 0, bottom: 120, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
            };
            vi.useFakeTimers();
            try {


                const manyTasks = Array.from({ length: 40 }, (_, index): Task => ({
                    ...archivedTask,
                    id: `bulk-${index}`,
                    title: `Archived task ${index}`,
                    completedAt: new Date(Date.UTC(2026, 4, 12, 8, 30) - index * 60_000).toISOString(),
                }));
                useTaskStore.setState({
                    _allTasks: manyTasks,
                    _tasksById: new Map(manyTasks.map((task) => [task.id, task])),
                });
                const { container } = render(
                    <LanguageProvider>
                        <ArchiveView />
                    </LanguageProvider>
                );

                const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
                expect(scroller).toBeTruthy();


                const scrollTo = vi.fn();
                Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });
                Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
                Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 40 * 120 });

                act(() => {
                    useTaskStore.setState({ highlightTaskId: 'bulk-30' });
                });
                expect(scrollTo).toHaveBeenCalledTimes(1);


                const { top } = scrollTo.mock.calls[0][0] as { top: number };
                expect(top).toBeGreaterThanOrEqual(3_600);
                expect(top).toBeLessThan(3_800);

                scrollTo.mockClear();
                act(() => {
                    fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
                });
                expect(scrollTo).not.toHaveBeenCalled();


                act(() => {
                    vi.advanceTimersByTime(4000);
                });
                expect(useTaskStore.getState().highlightTaskId).toBeNull();
            } finally {
                vi.useRealTimers();
                Element.prototype.getBoundingClientRect = originalRect;
            }
        });

        it('releases the shared highlight once the flash is over', () => {
            vi.useFakeTimers();
            try {
                renderArchive();
                highlight(archivedTask.id);
                expect(useTaskStore.getState().highlightTaskId).toBe(archivedTask.id);

                act(() => {
                    vi.advanceTimersByTime(4000);
                });

                expect(useTaskStore.getState().highlightTaskId).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it('filters archived projects by title search', () => {
        const secondProject: Project = { ...archivedProject, id: 'project-2', title: 'Second archived project' };
        useTaskStore.setState({
            projects: [archivedProject, secondProject],
            _allProjects: [archivedProject, secondProject],
        });

        render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
        fireEvent.change(screen.getByPlaceholderText('Search archived projects...'), {
            target: { value: 'Second' },
        });

        expect(screen.getByText('Second archived project')).toBeInTheDocument();
        expect(screen.queryByText('Archived project')).not.toBeInTheDocument();
    });
});
