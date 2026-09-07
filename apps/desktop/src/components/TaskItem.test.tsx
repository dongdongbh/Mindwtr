import { Profiler } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskItem } from '../components/TaskItem';
import { Area, Project, Section, Task, configureDateFormatting, safeFormatDate, useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';

const mockTask: Task = {
    id: '1',
    title: 'Test Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};
const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

const createDeferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

// The completion dialog now uses the shared date control (#944): a locale-formatted
// date field plus a separate time input, rather than one datetime-local box. jsdom
// reports en-US, so the display order is month/day/year.
const setCompletionDateTime = (dialog: HTMLElement, localIso: string) => {
    const [date, time] = localIso.split('T');
    const [year, month, day] = date.split('-');
    fireEvent.change(within(dialog).getByLabelText('Date'), {
        target: { value: `${month}/${day}/${year}` },
    });
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: time } });
};

describe('TaskItem', () => {
    beforeEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
        useUiStore.setState({
            ...useUiStore.getState(),
            editingTaskId: null,
            expandedTaskIds: {},
        });
    });

    it('renders task title', () => {
        const { getByText } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        expect(getByText('Test Task')).toBeInTheDocument();
    });

    it('shows the task section alongside its project metadata', () => {
        const project: Project = {
            id: 'project-launch',
            title: 'Launch plan',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: mockTask.createdAt,
            updatedAt: mockTask.updatedAt,
        };
        const section: Section = {
            id: 'section-backups',
            projectId: project.id,
            title: 'Regular Backups implemented',
            order: 0,
            createdAt: mockTask.createdAt,
            updatedAt: mockTask.updatedAt,
        };
        const task: Task = {
            ...mockTask,
            id: 'task-hosting-options',
            title: 'Check out options at hosting provider',
            projectId: project.id,
            sectionId: section.id,
        };

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [task],
                _allTasks: [task],
                _tasksById: new Map([[task.id, task]]),
                projects: [project],
                _allProjects: [project],
                _projectsById: new Map([[project.id, project]]),
                sections: [section],
                _allSections: [section],
                _sectionsById: new Map([[section.id, section]]),
            }));
        });

        const { getAllByRole, getAllByText } = render(
            <LanguageProvider>
                <TaskItem task={task} />
            </LanguageProvider>
        );

        expect(getAllByText('Launch plan · Regular Backups implemented')).toHaveLength(2);
        expect(getAllByRole('button', { name: /Launch plan · Regular Backups implemented/ })).toHaveLength(2);
    });

    it('opens the quick action menu after the task details are expanded', async () => {
        const user = userEvent.setup();
        const taskWithDescription: Task = {
            ...mockTask,
            description: 'Expanded task note',
        };
        const { findByRole, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={taskWithDescription} />
            </LanguageProvider>
        );

        await user.click(getByRole('button', { name: /toggle task details/i }));
        expect(await findByRole('button', { name: /more options/i })).toBeInTheDocument();
        await waitFor(() => expect(document.body).toHaveTextContent('Expanded task note'));

        await user.click(getByRole('button', { name: /more options/i }));

        expect(await findByRole('menu', { name: /more options/i })).toBeInTheDocument();
    });

    it('stops being a calendar drag source while details are expanded so text stays selectable', async () => {
        const user = userEvent.setup();
        const taskWithDescription: Task = {
            ...mockTask,
            description: 'Copy me',
        };
        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={taskWithDescription} />
            </LanguageProvider>
        );

        const root = container.querySelector('[data-task-id="1"]') as HTMLElement;
        expect(root.getAttribute('draggable')).toBe('true');

        await user.click(getByRole('button', { name: /toggle task details/i }));
        await waitFor(() => expect(root.getAttribute('draggable')).toBe('false'));

        await user.click(getByRole('button', { name: /toggle task details/i }));
        await waitFor(() => expect(root.getAttribute('draggable')).toBe('true'));
    });

    it('hides the default status selector when the task editor layout hides status', () => {
        act(() => {
            useTaskStore.setState({
                settings: {
                    gtd: {
                        taskEditor: {
                            hidden: ['status'],
                        },
                    },
                },
            });
        });

        const { queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );

        expect(queryByRole('combobox', { name: /task status|task\.aria\.status/i })).toBeNull();
    });

    it('enters edit mode when Edit is clicked', () => {
        const { getAllByRole, getByDisplayValue } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        const editButtons = getAllByRole('button', { name: /edit/i });
        fireEvent.click(editButtons[0]);
        expect(getByDisplayValue('Test Task')).toBeInTheDocument();
    });

    it('opens the editor in a modal when the setting uses pop-up presentation', async () => {
        act(() => {
            useTaskStore.setState({
                settings: {
                    gtd: {
                        taskEditor: {
                            presentation: 'modal',
                        },
                    },
                },
            });
        });

        const { container, getAllByRole, getByRole, getByDisplayValue } = render(
            <div style={{ transform: 'translateY(120px)' }}>
                <LanguageProvider>
                    <TaskItem task={mockTask} />
                </LanguageProvider>
            </div>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });

        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(getByRole('dialog', { name: /edit task/i })).toBeInTheDocument();
        expect(getByDisplayValue('Test Task')).toBeInTheDocument();
    });

    it('focuses the title input when the pop-up editor opens from an external edit request', async () => {
        act(() => {
            useTaskStore.setState({
                settings: {
                    gtd: {
                        taskEditor: {
                            presentation: 'modal',
                        },
                    },
                },
            });
        });

        const { getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );

        await act(async () => {
            useUiStore.getState().setEditingTaskId(mockTask.id);
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });

        const dialog = getByRole('dialog', { name: /edit task/i });
        expect(dialog).toBeInTheDocument();
        expect(getByDisplayValue('Test Task')).toHaveFocus();
    });

    it('shows a delete action while editing inbox tasks', async () => {
        act(() => {
            useTaskStore.setState({
                tasks: [mockTask],
                _allTasks: [mockTask],
            } as never);
        });
        const { getAllByRole, queryByRole, findByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const deleteButton = await findByRole('button', { name: /^delete$/i });

        await act(async () => {
            fireEvent.click(deleteButton);
        });

        // Deleting is immediate (soft delete to Trash with an undo toast);
        // no confirmation dialog appears.
        expect(queryByRole('dialog', { name: /^delete$/i })).not.toBeInTheDocument();
        await waitFor(() => {
            const stored = useTaskStore.getState()._allTasks.find((candidate) => candidate.id === mockTask.id);
            expect(stored?.deletedAt).toBeTruthy();
        });
        // The edit session must close with the task, or the stale
        // editingTaskId keeps global keyboard shortcuts suppressed (#870).
        expect(useUiStore.getState().editingTaskId).toBeNull();
    });

    it('does not show the edit-mode delete action for non-inbox tasks', async () => {
        const nextTask: Task = {
            ...mockTask,
            id: 'next-edit-task',
            status: 'next',
        };
        const { getAllByRole, getByDisplayValue, queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={nextTask} />
            </LanguageProvider>
        );
        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        await waitFor(() => expect(getByDisplayValue('Test Task')).toBeInTheDocument());

        expect(queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    });

    it('marks the task done from the edit title action', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-done-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });
        const { getAllByRole, getByDisplayValue } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        await waitFor(() => expect(getByDisplayValue('Test Task')).toBeInTheDocument());

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: 'Done' })[0]);
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get('editor-done-task');
            expect(updatedTask?.status).toBe('done');
            expect(updatedTask?.completedAt).toBeTruthy();
        });
    });

    it('marks the task done at a chosen time when the edit title action is right-clicked', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-backdated-done-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });
        const { getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        await waitFor(() => expect(getByDisplayValue('Test Task')).toBeInTheDocument());
        fireEvent.change(getByDisplayValue('Test Task'), { target: { value: 'Edited before completion' } });

        fireEvent.contextMenu(getAllByRole('button', { name: 'Done' })[0]);

        const dialog = getByRole('dialog', { name: 'Completion time' });
        const completedAtInput = '2026-07-20T09:30';
        setCompletionDateTime(dialog, completedAtInput);
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get('editor-backdated-done-task');
            expect(updatedTask?.status).toBe('done');
            expect(updatedTask?.completedAt).toBe(new Date(completedAtInput).toISOString());
            expect(updatedTask?.title).toBe('Edited before completion');
        });
    });

    it('logs time spent when completing through the backdated-complete prompt with the gate on', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'time-spent-complete-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
                settings: {
                    features: { pomodoro: true },
                    gtd: { pomodoro: { linkTask: true } },
                },
            }));
        });
        const { getAllByRole, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        fireEvent.contextMenu(getAllByRole('button', { name: 'Done' })[0]);
        const dialog = getByRole('dialog', { name: 'Completion time' });
        setCompletionDateTime(dialog, '2026-07-20T09:30');
        fireEvent.change(within(dialog).getByLabelText('Time Spent'), { target: { value: '45' } });
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get('time-spent-complete-task');
            expect(updatedTask?.status).toBe('done');
            expect(updatedTask?.completedAt).toBe(new Date('2026-07-20T09:30').toISOString());
            expect(updatedTask?.timeSpentMinutes).toBe(45);
        });
    });

    it('does not show the time-spent field or touch timeSpentMinutes when the gate is off', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'time-spent-gate-off-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
                settings: {},
            }));
        });
        const { getAllByRole, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        fireEvent.contextMenu(getAllByRole('button', { name: 'Done' })[0]);
        const dialog = getByRole('dialog', { name: 'Completion time' });
        expect(within(dialog).queryByLabelText('Time Spent')).toBeNull();
        setCompletionDateTime(dialog, '2026-07-20T09:30');
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get('time-spent-gate-off-task');
            expect(updatedTask?.status).toBe('done');
            expect(updatedTask?.timeSpentMinutes).toBeUndefined();
        });
    });

    it('clears timeSpentMinutes when the time-spent field is left blank', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'time-spent-blank-task',
            status: 'next',
            timeSpentMinutes: 30,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
                settings: {
                    features: { pomodoro: true },
                    gtd: { pomodoro: { linkTask: true } },
                },
            }));
        });
        const { getAllByRole, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        fireEvent.contextMenu(getAllByRole('button', { name: 'Done' })[0]);
        const dialog = getByRole('dialog', { name: 'Completion time' });
        const timeSpentInput = within(dialog).getByLabelText('Time Spent') as HTMLInputElement;
        expect(timeSpentInput.value).toBe('30');
        fireEvent.change(timeSpentInput, { target: { value: '' } });
        setCompletionDateTime(dialog, '2026-07-20T09:30');
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get('time-spent-blank-task');
            expect(updatedTask?.status).toBe('done');
            expect(updatedTask?.timeSpentMinutes).toBeUndefined();
        });
    });

    it('never shows the time-spent field when only editing the completion time of an already-done task', async () => {
        const doneTask: Task = {
            ...mockTask,
            id: 'time-spent-edit-mode-task',
            status: 'done',
            completedAt: new Date('2026-07-01T10:00:00.000Z').toISOString(),
            timeSpentMinutes: 20,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [doneTask],
                _allTasks: [doneTask],
                _tasksById: new Map([[doneTask.id, doneTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
                settings: {
                    features: { pomodoro: true },
                    gtd: { pomodoro: { linkTask: true } },
                },
            }));
        });
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem task={doneTask} />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: 'Edit completion time' }));
        const dialog = getByRole('dialog', { name: 'Completion time' });
        expect(within(dialog).queryByLabelText('Time Spent')).toBeNull();
    });

    it('saves an edited completion time on a read-only done row (the Done list), not just opens the prompt', async () => {
        const doneTask: Task = {
            ...mockTask,
            id: 'read-only-completed-at-edit-task',
            status: 'done',
            completedAt: new Date('2026-07-01T10:00:00.000Z').toISOString(),
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [doneTask],
                _allTasks: [doneTask],
                _tasksById: new Map([[doneTask.id, doneTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem task={doneTask} readOnly />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: 'Edit completion time' }));
        const dialog = getByRole('dialog', { name: 'Completion time' });
        fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '09:15' } });
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get(doneTask.id);
            const completedAt = new Date(updatedTask?.completedAt ?? '');
            expect(completedAt.getHours()).toBe(9);
            expect(completedAt.getMinutes()).toBe(15);
        });
    });

    it("stars even an unclarified inbox task for Today's Focus from the editor header", async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-star-task',
            status: 'inbox',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });
        const { getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        await waitFor(() => expect(getByDisplayValue('Test Task')).toBeInTheDocument());

        await act(async () => {
            fireEvent.click(getByRole('button', { name: "Add to today's focus" }));
        });

        // The star is a draft field: nothing is committed until Save, so the
        // row cannot vanish from the list mid-edit.
        expect(useTaskStore.getState()._tasksById.get('editor-star-task')?.isFocusedToday).not.toBe(true);

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: 'Save' })[0]);
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._tasksById.get('editor-star-task');
            expect(updatedTask?.isFocusedToday).toBe(true);
            expect(updatedTask?.status).toBe('next');
        });
    });

    it('applies accepted title suggestions as metadata without keeping the token in the title', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-title-token-task',
            title: 'Email',
            status: 'next',
        };
        const contextSourceTask: Task = {
            ...mockTask,
            id: 'editor-title-context-source',
            title: 'Context source',
            contexts: ['@work'],
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask, contextSourceTask],
                _allTasks: [editableTask, contextSourceTask],
                _tasksById: new Map([
                    [editableTask.id, editableTask],
                    [contextSourceTask.id, contextSourceTask],
                ]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });

        const { findByRole, getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const titleInput = getByDisplayValue('Email') as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Email @wo today' } });
        titleInput.setSelectionRange('Email @wo'.length, 'Email @wo'.length);
        fireEvent.click(titleInput);

        expect(await findByRole('option', { name: '@work' })).toBeInTheDocument();
        await act(async () => {
            fireEvent.keyDown(titleInput, { key: 'Enter' });
        });

        await waitFor(() => expect(titleInput.value).toBe('Email today'));

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'editor-title-token-task');
            expect(updatedTask?.title).toBe('Email today');
            expect(updatedTask?.contexts).toEqual(['@work']);
        });
    });

    it('applies accepted slash date commands as metadata without keeping the command in the title', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-title-slash-date-task',
            title: 'Email',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });

        const { findByRole, getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const titleInput = getByDisplayValue('Email') as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Email /due:2026-05-01 today' } });
        titleInput.setSelectionRange('Email /due:2026-05-01'.length, 'Email /due:2026-05-01'.length);
        fireEvent.click(titleInput);

        expect(await findByRole('option', { name: '/due:2026-05-01' })).toBeInTheDocument();
        await act(async () => {
            fireEvent.keyDown(titleInput, { key: 'Enter' });
        });

        await waitFor(() => expect(titleInput.value).toBe('Email today'));

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'editor-title-slash-date-task');
            expect(updatedTask?.title).toBe('Email today');
            expect(updatedTask?.dueDate).toBe('2026-05-01');
        });
    });

    it('appends accepted slash notes instead of overwriting an existing description', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-title-slash-note-task',
            title: 'Email',
            status: 'next',
            description: 'Existing note',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });

        const { findByRole, getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const titleInput = getByDisplayValue('Email') as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Email /note:Follow up today' } });
        titleInput.setSelectionRange('Email /note:Follow up'.length, 'Email /note:Follow up'.length);
        fireEvent.click(titleInput);

        expect(await findByRole('option', { name: '/note:Follow up' })).toBeInTheDocument();
        await act(async () => {
            fireEvent.keyDown(titleInput, { key: 'Enter' });
        });

        await waitFor(() => expect(titleInput.value).toBe('Email today'));

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'editor-title-slash-note-task');
            expect(updatedTask?.title).toBe('Email today');
            expect(updatedTask?.description).toBe('Existing note\n\nFollow up');
        });
    });

    it('applies an accepted /energy: level as metadata without keeping the command in the title', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-title-slash-energy-task',
            title: 'Email',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });

        const { findByRole, getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const titleInput = getByDisplayValue('Email') as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Email /energy:hi today' } });
        titleInput.setSelectionRange('Email /energy:hi'.length, 'Email /energy:hi'.length);
        fireEvent.click(titleInput);

        expect(await findByRole('option', { name: '/energy:high' })).toBeInTheDocument();
        await act(async () => {
            fireEvent.keyDown(titleInput, { key: 'Enter' });
        });

        await waitFor(() => expect(titleInput.value).toBe('Email today'));

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'editor-title-slash-energy-task');
            expect(updatedTask?.title).toBe('Email today');
            expect(updatedTask?.energyLevel).toBe('high');
        });
    });

    it('resolves an accepted /area: name against the area list without keeping the command in the title', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-title-slash-area-task',
            title: 'Email',
            status: 'next',
        };
        const area = {
            id: 'area-deep-work',
            name: 'Deep Work',
            order: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [],
                _allProjects: [],
                _projectsById: new Map(),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [area],
                _allAreas: [area],
                _areasById: new Map([[area.id, area]]),
            }));
        });

        const { findByRole, getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const titleInput = getByDisplayValue('Email') as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Email /area:Deep Work today' } });
        titleInput.setSelectionRange('Email /area:Deep Work'.length, 'Email /area:Deep Work'.length);
        fireEvent.click(titleInput);

        expect(await findByRole('option', { name: '/area:Deep Work' })).toBeInTheDocument();
        await act(async () => {
            fireEvent.keyDown(titleInput, { key: 'Enter' });
        });

        await waitFor(() => expect(titleInput.value).toBe('Email today'));

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'editor-title-slash-area-task');
            expect(updatedTask?.title).toBe('Email today');
            expect(updatedTask?.areaId).toBe('area-deep-work');
        });
    });

    it('keeps unaccepted quick-add-looking text literal in existing title edits', async () => {
        const editableTask: Task = {
            ...mockTask,
            id: 'editor-title-literal-task',
            title: 'Email',
            status: 'next',
            contexts: [],
            tags: [],
        };
        const project: Project = {
            id: 'project-home',
            title: 'Home',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: editableTask.createdAt,
            updatedAt: editableTask.updatedAt,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [editableTask],
                _allTasks: [editableTask],
                _tasksById: new Map([[editableTask.id, editableTask]]),
                projects: [project],
                _allProjects: [project],
                _projectsById: new Map([[project.id, project]]),
                sections: [],
                _allSections: [],
                _sectionsById: new Map(),
                areas: [],
                _allAreas: [],
                _areasById: new Map(),
            }));
        });

        const { getAllByRole, getByDisplayValue, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={editableTask} />
            </LanguageProvider>
        );

        await act(async () => {
            fireEvent.click(getAllByRole('button', { name: /edit/i })[0]);
        });
        const titleInput = getByDisplayValue('Email') as HTMLInputElement;
        const literalTitle = 'Email @home #note +Home /due:tomorrow';
        fireEvent.change(titleInput, { target: { value: literalTitle } });

        await act(async () => {
            fireEvent.click(getByRole('button', { name: 'Save' }));
        });

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'editor-title-literal-task');
            expect(updatedTask?.title).toBe(literalTitle);
            expect(updatedTask?.contexts).toEqual([]);
            expect(updatedTask?.tags).toEqual([]);
            expect(updatedTask?.projectId).toBeUndefined();
            expect(updatedTask?.dueDate).toBeUndefined();
        });
    });

    it('enters edit mode when task title is double-clicked', () => {
        const { getByRole, getByDisplayValue } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        fireEvent.doubleClick(getByRole('button', { name: /toggle task details/i }));
        expect(getByDisplayValue('Test Task')).toBeInTheDocument();
    });

    it('opens a single editor when the same task renders in multiple rows (Focus grouped by tags)', async () => {
        const multiTagTask: Task = { ...mockTask, tags: ['home', 'errand'] };
        const { getAllByRole, getAllByDisplayValue } = render(
            <LanguageProvider>
                <div>
                    <TaskItem task={multiTagTask} />
                    <TaskItem task={multiTagTask} />
                </div>
            </LanguageProvider>
        );

        const toggles = getAllByRole('button', { name: /toggle task details/i });
        await act(async () => {
            fireEvent.doubleClick(toggles[0]);
        });

        // Only the double-clicked row may run the editor; a second instance
        // would treat clicks inside the first editor as outside clicks and
        // close the whole session.
        expect(getAllByDisplayValue('Test Task')).toHaveLength(1);

        const titleInput = getAllByDisplayValue('Test Task')[0];
        await act(async () => {
            fireEvent.pointerDown(titleInput);
        });
        expect(getAllByDisplayValue('Test Task')).toHaveLength(1);
    });

    it('does not render checkbox when not in selection mode', () => {
        const { queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        expect(queryByRole('checkbox')).toBeNull();
    });

    it('toggles selection when checkbox is clicked in selection mode', () => {
        const onToggleSelect = vi.fn();
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem
                    task={mockTask}
                    selectionMode
                    isMultiSelected={false}
                    onToggleSelect={onToggleSelect}
                />
            </LanguageProvider>
        );
        const checkbox = getByRole('checkbox', { name: /select task/i });
        fireEvent.click(checkbox);
        expect(onToggleSelect).toHaveBeenCalledTimes(1);
    });

    it('shows due date metadata when compact details are enabled', () => {
        configureDateFormatting({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-US' });
        const taskWithDueDate: Task = {
            ...mockTask,
            id: 'task-with-due-date',
            dueDate: '2026-03-20',
        };
        const { getByText } = render(
            <LanguageProvider>
                <TaskItem task={taskWithDueDate} compactMetaEnabled />
            </LanguageProvider>
        );
        expect(getByText(safeFormatDate('2026-03-20', 'P'))).toBeInTheDocument();
    });

    it('opens the task quick actions menu on right-click', async () => {
        const menuTask: Task = {
            ...mockTask,
            id: 'quick-actions-task',
        };
        const { container, getByRole, getByText, queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={menuTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-actions-task"]');
        expect(row).toBeTruthy();
        act(() => {
            fireEvent.contextMenu(row!);
        });

        expect(getByRole('menu', { name: /more options/i })).toBeInTheDocument();
        expect(getByRole('menuitem', { name: /due date/i })).toBeInTheDocument();
        expect(getByRole('menuitem', { name: /review date/i })).toBeInTheDocument();
        expect(getByRole('menuitem', { name: /area/i })).toBeInTheDocument();
        expect(getByRole('menuitem', { name: /contexts/i })).toBeInTheDocument();
        expect(getByRole('menuitem', { name: /duplicate/i })).toBeInTheDocument();
        expect(getByText('Delete')).toBeInTheDocument();

        act(() => {
            // A real press always ends: the menu now swallows the click that
            // dismisses it (so the control underneath is not activated), and it
            // releases that swallower when the gesture completes. A lone
            // mouseDown is not a gesture a browser can produce.
            fireEvent.mouseDown(document.body);
            fireEvent.mouseUp(document.body);
        });
        await waitFor(() => {
            expect(queryByRole('menuitem', { name: /duplicate/i })).toBeNull();
        });
    });

    it('opens the task quick actions menu from the visible affordance button', () => {
        const menuTask: Task = {
            ...mockTask,
            id: 'quick-actions-button-task',
        };
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem task={menuTask} />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: /more options/i }));

        expect(getByRole('menu', { name: /more options/i })).toBeInTheDocument();
        expect(getByRole('menuitem', { name: /duplicate/i })).toBeInTheDocument();
    });

    it('opens duplicated tasks from the quick actions menu', async () => {
        const menuTask: Task = {
            ...mockTask,
            id: 'quick-actions-duplicate-task',
            status: 'waiting',
        };
        act(() => {
            useTaskStore.setState({
                tasks: [menuTask],
                _allTasks: [menuTask],
                _tasksById: new Map([[menuTask.id, menuTask]]),
            });
        });
        const { findByRole, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={menuTask} />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: /more options/i }));
        const duplicateItem = await findByRole('menuitem', { name: /duplicate/i });
        await act(async () => {
            fireEvent.click(duplicateItem);
        });

        const duplicatedTask = useTaskStore.getState()._allTasks.find((task) => task.id !== menuTask.id);
        expect(duplicatedTask).toMatchObject({
            title: 'Test Task',
            status: 'waiting',
        });
        expect(useUiStore.getState().editingTaskId).toBe(duplicatedTask?.id);
        expect(useTaskStore.getState().highlightTaskId).toBe(duplicatedTask?.id);
    });

    it('duplicates a completed task from the row button and reveals the copy in the Inbox', async () => {
        const doneTask: Task = {
            ...mockTask,
            id: 'done-duplicate-task',
            status: 'done',
            completedAt: new Date().toISOString(),
        };
        act(() => {
            useTaskStore.setState({
                tasks: [doneTask],
                _allTasks: [doneTask],
                _tasksById: new Map([[doneTask.id, doneTask]]),
            });
        });
        const onNavigate = vi.fn();
        window.addEventListener('mindwtr:navigate', onNavigate as EventListener);

        try {
            const { getByRole } = render(
                <LanguageProvider>
                    <TaskItem task={doneTask} />
                </LanguageProvider>
            );

            await act(async () => {
                fireEvent.click(getByRole('button', { name: /duplicate task/i }));
            });

            const duplicatedTask = useTaskStore.getState()._allTasks.find((task) => task.id !== doneTask.id);
            expect(duplicatedTask).toMatchObject({
                title: 'Test Task',
                status: 'inbox',
            });
            expect(duplicatedTask?.completedAt).toBeUndefined();
            expect(onNavigate).toHaveBeenCalledWith(
                expect.objectContaining({ detail: { view: 'inbox' } }),
            );
        } finally {
            window.removeEventListener('mindwtr:navigate', onNavigate as EventListener);
        }
    });

    it('keeps the age badge off completed rows, archived as well as done', () => {
        const createdAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        act(() => {
            useTaskStore.setState({
                settings: { appearance: { showTaskAge: true } },
            });
        });

        const renderWithStatus = (status: Task['status'], id: string) => {
            const task: Task = { ...mockTask, id, status, createdAt, completedAt: new Date().toISOString() };
            act(() => {
                useTaskStore.setState({
                    tasks: [task],
                    _allTasks: [task],
                    _tasksById: new Map([[task.id, task]]),
                });
            });
            // Scoped to this render's own container: every render in this test shares
            // document.body, so a screen-level query would find the previous row.
            const { container } = render(
                <LanguageProvider>
                    <TaskItem task={task} />
                </LanguageProvider>
            );
            return container.textContent ?? '';
        };

        // Age is a nudge about work still waiting, so an open task keeps it…
        expect(renderWithStatus('next', 'age-next-task')).toContain('5 days old');
        // …and neither kind of finished task shows it (#968: Archive picked it up when
        // its rows became the shared read-only row).
        expect(renderWithStatus('done', 'age-done-task')).not.toContain('5 days old');
        expect(renderWithStatus('archived', 'age-archived-task')).not.toContain('5 days old');
    });

    it('duplicates a completed task from the quick actions menu too', async () => {
        const doneTask: Task = {
            ...mockTask,
            id: 'done-menu-duplicate-task',
            status: 'done',
            completedAt: new Date().toISOString(),
        };
        act(() => {
            useTaskStore.setState({
                tasks: [doneTask],
                _allTasks: [doneTask],
                _tasksById: new Map([[doneTask.id, doneTask]]),
            });
        });

        const { container, findByRole, queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={doneTask} />
            </LanguageProvider>
        );

        // A completed row carries Duplicate, Restore and Delete as buttons, so it drops
        // the "More options" trigger that would only repeat them; right-click still
        // reaches the menu (#968).
        expect(queryByRole('button', { name: /more options/i })).toBeNull();
        fireEvent.contextMenu(container.querySelector('[data-task-id="done-menu-duplicate-task"]')!);
        const duplicateItem = await findByRole('menuitem', { name: /duplicate/i });
        await act(async () => {
            fireEvent.click(duplicateItem);
        });

        expect(useTaskStore.getState()._allTasks.find((task) => task.id !== doneTask.id)).toMatchObject({
            status: 'inbox',
        });
    });

    it('marks the row while its context menu is open so the menu target is visible (#999)', async () => {
        const nextTask: Task = {
            ...mockTask,
            id: 'context-menu-ring-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [nextTask],
                _allTasks: [nextTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={nextTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="context-menu-ring-task"]');
        expect(row).toBeTruthy();
        // Token check on purpose: the base class list carries focus-within:ring-*
        // variants whose substrings would satisfy a plain toContain.
        const rowClassTokens = () => (row as HTMLElement).className.split(/\s+/);
        expect(rowClassTokens()).not.toContain('ring-primary/40');

        fireEvent.contextMenu(row!);
        expect(getByRole('menu')).toBeTruthy();
        expect(rowClassTokens()).toContain('ring-primary/40');
    });

    it('adds an eligible next action to today focus from the task quick actions menu', async () => {
        const nextTask: Task = {
            ...mockTask,
            id: 'quick-focus-next-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [nextTask],
                _allTasks: [nextTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={nextTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-focus-next-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /add to today's focus/i }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-focus-next-task');
            expect(updatedTask?.isFocusedToday).toBe(true);
            expect(updatedTask?.status).toBe('next');
        });
    });

    it('toggles today focus through the selected-row shortcut action', async () => {
        const nextTask: Task = {
            ...mockTask,
            id: 'shortcut-focus-next-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [nextTask],
                _allTasks: [nextTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container } = render(
            <LanguageProvider>
                <TaskItem task={nextTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="shortcut-focus-next-task"]');
        fireEvent(row!, new CustomEvent('mindwtr:task-row-action', { detail: 'toggle-focus' }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === nextTask.id);
            expect(updatedTask?.isFocusedToday).toBe(true);
        });
    });

    it('starts inline title rename through the selected-row shortcut action', () => {
        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="1"]');
        fireEvent(row!, new CustomEvent('mindwtr:task-row-action', { detail: 'rename-title' }));

        expect(getByRole('textbox', { name: /rename task/i })).toHaveValue('Test Task');
    });

    it('does not add unclarified inbox tasks to today focus from the quick actions menu', () => {
        const inboxTask: Task = {
            ...mockTask,
            id: 'quick-focus-inbox-task',
            status: 'inbox',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [inboxTask],
                _allTasks: [inboxTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={inboxTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-focus-inbox-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        const focusAction = getByRole('menuitem', { name: /add to today's focus/i });

        expect(focusAction).toBeDisabled();
        expect(focusAction).toHaveAttribute('title', 'Clarify this task before adding it to Focus.');
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-focus-inbox-task')?.isFocusedToday)
            .not.toBe(true);
    });

    it('focuses review-due tasks from the quick actions menu without changing their status', async () => {
        const reviewDueTask: Task = {
            ...mockTask,
            id: 'quick-focus-review-task',
            status: 'waiting',
            reviewAt: '2026-01-01T00:00:00.000Z',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [reviewDueTask],
                _allTasks: [reviewDueTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={reviewDueTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-focus-review-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /add to today's focus/i }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-focus-review-task');
            expect(updatedTask?.isFocusedToday).toBe(true);
            expect(updatedTask?.status).toBe('waiting');
        });
    });

    it('updates due date from the task quick actions menu', async () => {
        const quickDueTask: Task = {
            ...mockTask,
            id: 'quick-due-task',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [quickDueTask],
                _allTasks: [quickDueTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByLabelText, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={quickDueTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-due-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /due date/i }));
        fireEvent.change(getByLabelText('Due Date', { selector: 'input' }), { target: { value: '2026-05-01' } });
        fireEvent.click(getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-due-task');
            expect(updatedTask?.dueDate).toBe('2026-05-01');
        });
    });

    it('updates review date from the task quick actions menu', async () => {
        const quickReviewTask: Task = {
            ...mockTask,
            id: 'quick-review-task',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [quickReviewTask],
                _allTasks: [quickReviewTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByLabelText, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={quickReviewTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-review-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /review date/i }));
        fireEvent.change(getByLabelText('Review Date', { selector: 'input' }), { target: { value: '2026-05-03' } });
        fireEvent.click(getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-review-task');
            expect(updatedTask?.reviewAt).toBe('2026-05-03');
        });
    });

    it('updates area from the task quick actions menu', async () => {
        const quickAreaTask: Task = {
            ...mockTask,
            id: 'quick-area-task',
        };
        const workArea: Area = {
            id: 'area-work',
            name: 'Work',
            color: '#3b82f6',
            order: 0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [quickAreaTask],
                _allTasks: [quickAreaTask],
                projects: [],
                _allProjects: [],
                areas: [workArea],
                _allAreas: [workArea],
            }));
        });

        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={quickAreaTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-area-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /area/i }));
        const areaDialog = getByRole('dialog', { name: 'Area' });
        fireEvent.click(within(areaDialog).getByRole('button', { name: 'No Area' }));
        const areaListbox = getByRole('listbox', { name: 'No Area' });
        fireEvent.click(within(areaListbox).getByRole('option', { name: 'Work' }));
        fireEvent.click(within(areaDialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-area-task');
            expect(updatedTask?.areaId).toBe('area-work');
        });
    });

    it('updates contexts from the task quick actions menu', async () => {
        const quickContextTask: Task = {
            ...mockTask,
            id: 'quick-context-task',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [quickContextTask],
                _allTasks: [quickContextTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, getByLabelText, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={quickContextTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-context-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /contexts/i }));
        fireEvent.change(getByLabelText('Contexts', { selector: 'input' }), { target: { value: '@office, @errands' } });
        fireEvent.click(getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'quick-context-task');
            expect(updatedTask?.contexts).toEqual(['@office', '@errands']);
        });
    });

    it('offers full context autocomplete from the task quick actions menu', async () => {
        const quickContextTask: Task = {
            ...mockTask,
            id: 'quick-context-autocomplete-task',
        };
        const contextSourceTasks: Task[] = [
            ['context-alpha', '@alpha', '2026-02-08T00:00:00.000Z'],
            ['context-beta', '@beta', '2026-02-07T00:00:00.000Z'],
            ['context-delta', '@delta', '2026-02-06T00:00:00.000Z'],
            ['context-gamma', '@gamma', '2026-02-05T00:00:00.000Z'],
            ['context-office', '@office', '2026-02-04T00:00:00.000Z'],
            ['context-home', '@home', '2026-02-03T00:00:00.000Z'],
        ].map(([id, context, updatedAt]) => ({
            ...mockTask,
            id,
            contexts: [context],
            updatedAt,
        }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [quickContextTask, ...contextSourceTasks],
                _allTasks: [quickContextTask, ...contextSourceTasks],
                projects: [],
                _allProjects: [],
            }));
        });

        const { container, findByRole, getByLabelText, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={quickContextTask} />
            </LanguageProvider>
        );

        const row = container.querySelector('[data-task-id="quick-context-autocomplete-task"]');
        expect(row).toBeTruthy();
        fireEvent.contextMenu(row!);
        fireEvent.click(getByRole('menuitem', { name: /contexts/i }));
        const input = getByLabelText('Contexts', { selector: 'input' }) as HTMLInputElement;
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: '@ho' } });

        expect(await findByRole('option', { name: '@home' })).toBeInTheDocument();

        fireEvent.keyDown(input, { key: 'Enter' });

        expect(input).toHaveValue('@home');
    });

    it('applies inset ring style when selected to avoid clipped borders', () => {
        const { container } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} isSelected />
            </LanguageProvider>
        );
        const root = container.querySelector('[data-task-id="1"]');
        expect(root).toBeTruthy();
        expect(root?.className).toContain('ring-inset');
    });

    it('shows the selected row treatment while keyboard focus is inside the task card', () => {
        const { container } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        const root = container.querySelector('[data-task-id="1"]');
        expect(root).toBeTruthy();
        expect(root?.className).toContain('focus-within:ring-2');
        expect(root?.className).toContain('focus-within:bg-primary/5');
    });

    it('includes archived in the task status selector', () => {
        const { getByLabelText } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        const statusSelect = getByLabelText(/task status/i) as HTMLSelectElement;
        const archivedOption = Array.from(statusSelect.options).find((option) => option.value === 'archived');
        expect(archivedOption).toBeTruthy();
    });

    it('prompts for assigned to when changing status to waiting', async () => {
        const nextTask: Task = {
            ...mockTask,
            id: 'waiting-select-task',
            status: 'next',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [nextTask],
                _allTasks: [nextTask],
                projects: [],
                _allProjects: [],
            }));
        });

        const { getByLabelText, getByPlaceholderText, getByRole, getByText } = render(
            <LanguageProvider>
                <TaskItem task={nextTask} />
            </LanguageProvider>
        );

        const statusSelect = getByLabelText(/task status/i) as HTMLSelectElement;
        statusSelect.focus();
        expect(statusSelect).toHaveFocus();

        fireEvent.change(statusSelect, { target: { value: 'waiting' } });

        expect(getByText('Who/what are you waiting for?')).toBeInTheDocument();
        expect(statusSelect).not.toHaveFocus();
        fireEvent.change(getByPlaceholderText('Who is this waiting for?'), { target: { value: 'Alex' } });
        fireEvent.click(getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'waiting-select-task');
            expect(updatedTask?.status).toBe('waiting');
            expect(updatedTask?.assignedTo).toBe('Alex');
        });
    });

    it('closes a waiting prompt and rejects its stale confirmation after the project archives', async () => {
        const activeProject: Project = {
            id: 'project-waiting-guard',
            title: 'Waiting guard',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: mockTask.createdAt,
            updatedAt: mockTask.updatedAt,
        };
        const guardedTask: Task = {
            ...mockTask,
            id: 'waiting-guard-task',
            status: 'next',
            projectId: activeProject.id,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [guardedTask],
                _allTasks: [guardedTask],
                _tasksById: new Map([[guardedTask.id, guardedTask]]),
                projects: [activeProject],
                _allProjects: [activeProject],
                _projectsById: new Map([[activeProject.id, activeProject]]),
            }));
        });

        const view = render(
            <LanguageProvider>
                <TaskItem task={guardedTask} project={activeProject} />
            </LanguageProvider>
        );
        fireEvent.change(view.getByLabelText(/task status/i), { target: { value: 'waiting' } });
        fireEvent.change(view.getByPlaceholderText('Who is this waiting for?'), { target: { value: 'Alex' } });
        const staleSave = view.getByRole('button', { name: 'Save' });
        const archivedProject = { ...activeProject, status: 'archived' as const };

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                projects: [archivedProject],
                _allProjects: [archivedProject],
                _projectsById: new Map([[archivedProject.id, archivedProject]]),
            }));
        });
        view.rerender(
            <LanguageProvider>
                <TaskItem task={guardedTask} project={archivedProject} interactionDisabled />
            </LanguageProvider>
        );
        fireEvent.click(staleSave);
        await act(async () => { await Promise.resolve(); });

        expect(view.queryByText('Who/what are you waiting for?')).not.toBeInTheDocument();
        const storedTask = useTaskStore.getState()._tasksById.get(guardedTask.id);
        expect(storedTask?.status).toBe('next');
        expect(storedTask?.assignedTo).toBeUndefined();
    });

    it('rechecks project ownership after the waiting status move resolves', async () => {
        const activeProject: Project = {
            id: 'project-waiting-continuation',
            title: 'Waiting continuation',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: mockTask.createdAt,
            updatedAt: mockTask.updatedAt,
        };
        const guardedTask: Task = {
            ...mockTask,
            id: 'waiting-continuation-task',
            status: 'next',
            projectId: activeProject.id,
        };
        const moved = createDeferred<{ success: boolean }>();
        const moveTask = vi.fn(() => moved.promise);
        const updateTask = vi.fn().mockResolvedValue({ success: true });
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [guardedTask],
                _allTasks: [guardedTask],
                _tasksById: new Map([[guardedTask.id, guardedTask]]),
                projects: [activeProject],
                _allProjects: [activeProject],
                _projectsById: new Map([[activeProject.id, activeProject]]),
                moveTask,
                updateTask,
            }));
        });

        const view = render(
            <LanguageProvider>
                <TaskItem task={guardedTask} project={activeProject} />
            </LanguageProvider>
        );
        fireEvent.change(view.getByLabelText(/task status/i), { target: { value: 'waiting' } });
        fireEvent.change(view.getByPlaceholderText('Who is this waiting for?'), { target: { value: 'Alex' } });
        fireEvent.click(view.getByRole('button', { name: 'Save' }));
        expect(moveTask).toHaveBeenCalledWith(guardedTask.id, 'waiting');

        const archivedProject = { ...activeProject, status: 'archived' as const };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                projects: [archivedProject],
                _allProjects: [archivedProject],
                _projectsById: new Map([[archivedProject.id, archivedProject]]),
            }));
        });
        view.rerender(
            <LanguageProvider>
                <TaskItem task={guardedTask} project={archivedProject} interactionDisabled />
            </LanguageProvider>
        );
        await act(async () => {
            moved.resolve({ success: true });
            await moved.promise;
        });

        expect(updateTask).not.toHaveBeenCalled();
    });

    it('closes a completion-time prompt and rejects its stale confirmation after archive', async () => {
        const activeProject: Project = {
            id: 'project-completion-guard',
            title: 'Completion guard',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: mockTask.createdAt,
            updatedAt: mockTask.updatedAt,
        };
        const guardedTask: Task = {
            ...mockTask,
            id: 'completion-guard-task',
            status: 'next',
            projectId: activeProject.id,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [guardedTask],
                _allTasks: [guardedTask],
                _tasksById: new Map([[guardedTask.id, guardedTask]]),
                projects: [activeProject],
                _allProjects: [activeProject],
                _projectsById: new Map([[activeProject.id, activeProject]]),
            }));
        });
        const view = render(
            <LanguageProvider>
                <TaskItem task={guardedTask} project={activeProject} />
            </LanguageProvider>
        );
        fireEvent.contextMenu(view.getAllByRole('button', { name: 'Done' })[0]);
        const dialog = view.getByRole('dialog', { name: 'Completion time' });
        setCompletionDateTime(dialog, '2026-08-31T09:30');
        const staleSave = within(dialog).getByRole('button', { name: 'Save' });
        const archivedProject = { ...activeProject, status: 'archived' as const };

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                projects: [archivedProject],
                _allProjects: [archivedProject],
                _projectsById: new Map([[archivedProject.id, archivedProject]]),
            }));
        });
        view.rerender(
            <LanguageProvider>
                <TaskItem task={guardedTask} project={archivedProject} interactionDisabled />
            </LanguageProvider>
        );
        fireEvent.click(staleSave);
        await act(async () => { await Promise.resolve(); });

        expect(view.queryByRole('dialog', { name: 'Completion time' })).not.toBeInTheDocument();
        const storedTask = useTaskStore.getState()._tasksById.get(guardedTask.id);
        expect(storedTask?.status).toBe('next');
        expect(storedTask?.completedAt).toBeUndefined();
    });

    it('prompts for a new next action after completing the last next project task', async () => {
        const projectTask: Task = {
            ...mockTask,
            id: 'project-last-next',
            title: 'Finish current step',
            status: 'next',
            projectId: 'project-1',
        };
        const project: Project = {
            id: 'project-1',
            title: 'Launch plan',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: projectTask.createdAt,
            updatedAt: projectTask.updatedAt,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [projectTask],
                _allTasks: [projectTask],
                projects: [project],
                _allProjects: [project],
                sections: [],
                _allSections: [],
                areas: [],
                _allAreas: [],
            }));
        });

        const { getByPlaceholderText, getByRole } = render(
            <LanguageProvider>
                <TaskItem task={projectTask} />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: 'Done' }));

        await waitFor(() => {
            expect(getByRole('dialog', { name: /what's the next action/i })).toBeInTheDocument();
        });
        fireEvent.change(getByPlaceholderText('New next action...'), { target: { value: 'Call Alex' } });
        fireEvent.click(getByRole('button', { name: 'Add next action' }));

        await waitFor(() => {
            const createdTask = useTaskStore.getState()._allTasks.find((task) => task.title === 'Call Alex');
            expect(createdTask).toMatchObject({
                status: 'next',
                projectId: 'project-1',
            });
        });
    });

    it('closes the project next-action prompt and rejects a stale add after archive', async () => {
        const projectTask: Task = {
            ...mockTask,
            id: 'project-next-action-guard-task',
            title: 'Finish guarded step',
            status: 'next',
            projectId: 'project-next-action-guard',
        };
        const activeProject: Project = {
            id: 'project-next-action-guard',
            title: 'Guarded launch',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: projectTask.createdAt,
            updatedAt: projectTask.updatedAt,
        };
        const addTask = vi.fn().mockResolvedValue({ success: true, id: 'should-not-exist' });
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [projectTask],
                _allTasks: [projectTask],
                _tasksById: new Map([[projectTask.id, projectTask]]),
                projects: [activeProject],
                _allProjects: [activeProject],
                _projectsById: new Map([[activeProject.id, activeProject]]),
                sections: [],
                _allSections: [],
                areas: [],
                _allAreas: [],
                addTask,
            }));
        });

        const view = render(
            <LanguageProvider>
                <TaskItem task={projectTask} project={activeProject} />
            </LanguageProvider>
        );
        fireEvent.click(view.getByRole('button', { name: 'Done' }));
        await waitFor(() => {
            expect(view.getByRole('dialog', { name: /what's the next action/i })).toBeInTheDocument();
        });
        fireEvent.change(view.getByPlaceholderText('New next action...'), {
            target: { value: 'Must not be created' },
        });
        const staleAdd = view.getByRole('button', { name: 'Add next action' });

        const archivedProject = { ...activeProject, status: 'archived' as const };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                projects: [],
                _allProjects: [archivedProject],
                _projectsById: new Map([[archivedProject.id, archivedProject]]),
            }));
        });
        expect(view.queryByRole('dialog', { name: /what's the next action/i })).not.toBeInTheDocument();
        fireEvent.click(staleAdd);
        await act(async () => { await Promise.resolve(); });

        expect(addTask).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._allTasks).toHaveLength(1);
    });

    it('can promote an existing project task from the next-action prompt', async () => {
        const projectTask: Task = {
            ...mockTask,
            id: 'project-complete-next',
            title: 'Finish current step',
            status: 'next',
            projectId: 'project-1',
        };
        const candidateTask: Task = {
            ...mockTask,
            id: 'project-candidate',
            title: 'Draft follow-up',
            status: 'someday',
            projectId: 'project-1',
            order: 2,
        };
        const project: Project = {
            id: 'project-1',
            title: 'Launch plan',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: projectTask.createdAt,
            updatedAt: projectTask.updatedAt,
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [projectTask, candidateTask],
                _allTasks: [projectTask, candidateTask],
                projects: [project],
                _allProjects: [project],
                sections: [],
                _allSections: [],
                areas: [],
                _allAreas: [],
            }));
        });

        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem task={projectTask} />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: 'Done' }));

        await waitFor(() => {
            expect(getByRole('button', { name: /draft follow-up/i })).toBeInTheDocument();
        });
        fireEvent.click(getByRole('button', { name: /draft follow-up/i }));

        await waitFor(() => {
            const promotedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'project-candidate');
            expect(promotedTask?.status).toBe('next');
        });
    });

    it('promotes a someday task from the row arrow with a tooltip and an undo toast', async () => {
        const somedayTask: Task = {
            ...mockTask,
            id: 'someday-1',
            title: 'Sharpen the saw',
            status: 'someday',
        };
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [somedayTask],
                _allTasks: [somedayTask],
                projects: [],
                _allProjects: [],
                sections: [],
                _allSections: [],
                areas: [],
                _allAreas: [],
            }));
        });

        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem task={somedayTask} />
            </LanguageProvider>
        );

        const promoteButton = getByRole('button', { name: 'Next' });
        // #1053: the arrow needs a hover tooltip naming the action.
        expect(promoteButton).toHaveAttribute('title', 'Move to Next');

        fireEvent.click(promoteButton);

        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'someday-1')?.status).toBe('next');
        });
        const toasts = useUiStore.getState().toasts;
        const toast = toasts[toasts.length - 1];
        expect(toast?.message).toBe('Sharpen the saw moved to Next');
        expect(toast?.action?.label).toBe('Undo');

        act(() => {
            toast?.action?.onClick();
        });
        await waitFor(() => {
            expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'someday-1')?.status).toBe('someday');
        });
    });

    it('does not show today focus toggle unless a view provides it', () => {
        const { queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        expect(queryByRole('button', { name: /add.*focus/i })).not.toBeInTheDocument();
    });

    it('keeps focus toggle visible when a view requests always-visible mode', () => {
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem
                    task={mockTask}
                    focusToggle={{
                        isFocused: false,
                        canToggle: true,
                        onToggle: vi.fn(),
                        title: 'Add to focus',
                        ariaLabel: 'Add to focus',
                        alwaysVisible: true,
                    }}
                />
            </LanguageProvider>
        );
        const button = getByRole('button', { name: /add.*focus/i });
        expect(button.className).not.toContain('opacity-0');
    });

    it('does not navigate away when adding today focus', () => {
        const onNavigate = vi.fn();
        window.addEventListener('mindwtr:navigate', onNavigate as EventListener);
        try {
            const { getByRole } = render(
                <LanguageProvider>
                    <TaskItem
                        task={mockTask}
                        focusToggle={{
                            isFocused: false,
                            canToggle: true,
                            onToggle: vi.fn(),
                            title: 'Add to focus',
                            ariaLabel: 'Add to focus',
                        }}
                    />
                </LanguageProvider>
            );
            fireEvent.click(getByRole('button', { name: /add.*focus/i }));
            expect(onNavigate).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('mindwtr:navigate', onNavigate as EventListener);
        }
    });

    it('does not show today focus toggle for done tasks', () => {
        const doneTask: Task = {
            ...mockTask,
            id: 'done-task',
            status: 'done',
        };
        const { queryByRole } = render(
            <LanguageProvider>
                <TaskItem task={doneTask} />
            </LanguageProvider>
        );
        expect(queryByRole('button', { name: /focus/i })).toBeNull();
    });

    it('keeps details expanded after remount for the same task id', () => {
        const checklistTask: Task = {
            ...mockTask,
            id: 'checklist-task',
            checklist: [{ id: 'item-1', title: 'Checklist item', isCompleted: false }],
        };
        const firstRender = render(
            <LanguageProvider>
                <TaskItem task={checklistTask} />
            </LanguageProvider>
        );

        fireEvent.click(firstRender.getByRole('button', { name: /toggle task details/i }));
        expect(firstRender.getByText('Checklist item')).toBeInTheDocument();
        firstRender.unmount();

        const updatedTask: Task = {
            ...checklistTask,
            checklist: [{ id: 'item-1', title: 'Checklist item', isCompleted: true }],
            updatedAt: new Date(Date.now() + 1_000).toISOString(),
        };
        const secondRender = render(
            <LanguageProvider>
                <TaskItem task={updatedTask} />
            </LanguageProvider>
        );

        expect(secondRender.getByText('Checklist item')).toBeInTheDocument();
    });

    it('does not rerender for unrelated project updates while not editing', () => {
        const task: Task = {
            ...mockTask,
            id: 'task-with-project',
            projectId: 'project-1',
        };
        const project: Project = {
            id: 'project-1',
            title: 'Primary project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
        const otherProject: Project = {
            id: 'project-2',
            title: 'Other project',
            status: 'active',
            color: '#000000',
            order: 1,
            tagIds: [],
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
        const commits: number[] = [];

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                _allTasks: [task],
                _allProjects: [project, otherProject],
                _allSections: [],
                _allAreas: [],
            }));
        });

        render(
            <LanguageProvider>
                <Profiler id="task-item" onRender={() => commits.push(1)}>
                    <TaskItem task={task} />
                </Profiler>
            </LanguageProvider>
        );

        expect(commits).toHaveLength(1);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                _allProjects: [
                    project,
                    {
                        ...otherProject,
                        title: 'Renamed unrelated project',
                        updatedAt: new Date(Date.parse(otherProject.updatedAt) + 1_000).toISOString(),
                    },
                ],
            }));
        });

        expect(commits).toHaveLength(1);
    });

    it('rerenders when its own project changes', () => {
        const task: Task = {
            ...mockTask,
            id: 'task-project-refresh',
            projectId: 'project-1',
        };
        const project: Project = {
            id: 'project-1',
            title: 'Primary project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
        const commits: number[] = [];

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                _allTasks: [task],
                _allProjects: [project],
                _allSections: [],
                _allAreas: [],
            }));
        });

        render(
            <LanguageProvider>
                <Profiler id="task-item" onRender={() => commits.push(1)}>
                    <TaskItem task={task} />
                </Profiler>
            </LanguageProvider>
        );

        expect(commits).toHaveLength(1);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                _allProjects: [{
                    ...project,
                    title: 'Renamed primary project',
                    updatedAt: new Date(Date.parse(project.updatedAt) + 1_000).toISOString(),
                }],
            }));
        });

        expect(commits.length).toBeGreaterThan(1);
    });
});
