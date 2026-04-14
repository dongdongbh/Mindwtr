import { Profiler } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { TaskItem } from '../components/TaskItem';
import { Project, Task, configureDateFormatting, safeFormatDate, useTaskStore } from '@mindwtr/core';
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

    it('enters edit mode when task title is double-clicked', () => {
        const { getByRole, getByDisplayValue } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        fireEvent.doubleClick(getByRole('button', { name: /toggle task details/i }));
        expect(getByDisplayValue('Test Task')).toBeInTheDocument();
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

    it('shows quick NEXT to WAITING action and opens due-date picker prompt', () => {
        const nextTask: Task = {
            ...mockTask,
            id: 'next-task',
            status: 'next',
        };
        const { getByRole, getByText, container } = render(
            <LanguageProvider>
                <TaskItem task={nextTask} />
            </LanguageProvider>
        );
        const waitingButton = getByRole('button', { name: /move to waiting and set due date/i });
        fireEvent.click(waitingButton);
        expect(getByText('Set follow-up / review date')).toBeInTheDocument();
        expect(container.querySelector('input[type="date"]')).toBeTruthy();
        expect(getByRole('button', { name: /skip/i })).toBeInTheDocument();
    });

    it('shows today focus toggle outside focus view for active tasks', () => {
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItem task={mockTask} />
            </LanguageProvider>
        );
        const button = getByRole('button', { name: /add.*focus/i });
        expect(button).toBeInTheDocument();
        expect(button.className).toContain('opacity-0');
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
                    <TaskItem task={mockTask} />
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
                tasks: [task],
                _allTasks: [task],
                projects: [project, otherProject],
                sections: [],
                areas: [],
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
                projects: [
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
                tasks: [task],
                _allTasks: [task],
                projects: [project],
                sections: [],
                areas: [],
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
                projects: [{
                    ...project,
                    title: 'Renamed primary project',
                    updatedAt: new Date(Date.parse(project.updatedAt) + 1_000).toISOString(),
                }],
            }));
        });

        expect(commits.length).toBeGreaterThan(1);
    });
});
