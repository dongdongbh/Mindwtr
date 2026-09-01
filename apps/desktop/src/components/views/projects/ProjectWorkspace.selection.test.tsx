import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Section, Task } from '@mindwtr/core';

import { useUiStore } from '../../../store/ui-store';
import { DndContext } from '@dnd-kit/core';
import { LanguageProvider } from '../../../contexts/language-context';
import { KeybindingProvider } from '../../../contexts/keybinding-context';
import { selectToolbarOption } from '../../../test/toolbar-select';
import { expectScrolledEndGap } from '../../../test/list-end-gap';
import { ProjectWorkspace } from './ProjectWorkspace';

vi.mock('../../TaskItem', () => ({
    TaskItem: ({
        task,
        selectionMode,
        isMultiSelected,
        onToggleSelect,
        interactionDisabled,
    }: {
        task: Task;
        selectionMode?: boolean;
        isMultiSelected?: boolean;
        onToggleSelect?: (options?: { range?: boolean }) => void;
        interactionDisabled?: boolean;
    }) => (
        <div data-task-id={task.id} data-interaction-disabled={interactionDisabled ? 'true' : 'false'}>
            {selectionMode && (
                <input
                    type="checkbox"
                    aria-label="Select task"
                    checked={Boolean(isMultiSelected)}
                    onClick={(event) => onToggleSelect?.({ range: event.shiftKey })}
                    onChange={() => undefined}
                />
            )}
            <span>{task.title}</span>
        </div>
    ),
}));

vi.mock('./SortableRows', () => ({
    SortableProjectTaskRow: ({ task }: { task: Task }) => (
        <div data-sortable-task-id={task.id} data-task-id={task.id}>
            <span>{task.title}</span>
        </div>
    ),
    DraggableProjectTaskRow: ({ task }: { task: Task }) => (
        <div data-draggable-task-id={task.id} data-task-id={task.id}>
            <span>{task.title}</span>
        </div>
    ),
}));

vi.mock('../../PromptModal', () => ({
    PromptModal: () => null,
}));

vi.mock('../../TokenPickerModal', () => ({
    TokenPickerModal: () => null,
}));

vi.mock('./ProjectDetailsHeader', () => ({
    ProjectDetailsHeader: ({ project }: { project: Project }) => <div>{project.title}</div>,
}));

vi.mock('./ProjectDetailsFields', () => ({
    ProjectDetailsFields: () => null,
}));

vi.mock('./ProjectNotesSection', () => ({
    ProjectNotesSection: () => null,
}));

// The workspace now reads store data/actions through useProjectWorkspaceStore.
// Tests seed that hook instead of passing store slices as props.
const storeHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./useProjectWorkspaceStore', () => ({
    useProjectWorkspaceStore: () => storeHolder.current,
}));

const translations: Record<string, string> = {
    'bulk.addContext': 'Add context',
    'bulk.addTag': 'Add tag',
    'bulk.delete': 'Delete',
    'bulk.exitSelect': 'Exit Select',
    'bulk.moveTo': 'Move to',
    'bulk.organize': 'Bulk organize',
    'bulk.removeContext': 'Remove context',
    'bulk.removeTag': 'Remove tag',
    'bulk.select': 'Select',
    'bulk.selected': 'selected',
    'common.all': 'All',
    'common.cancel': 'Cancel',
    'common.clear': 'Clear',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.save': 'Save',
    'common.search': 'Search...',
    'common.tasks': 'tasks',
    'list.confirmBatchDelete': 'Delete selected tasks?',
    'projects.addSection': 'Add section',
    'projects.addTask': 'Add task',
    'projects.addTaskPlaceholder': 'Add task',
    'projects.areaLabel': 'Area',
    'projects.noActiveTasks': 'No active tasks',
    'projects.sectionsLabel': 'Tasks',
    'sort.default': 'Default',
    'sort.due': 'Due date',
    'sort.start': 'Start date',
    'sort.review': 'Review date',
    'sort.title': 'Title',
    'sort.created': 'Created',
    'sort.created-desc': 'Created (newest)',
    'sort.label': 'Sort',
    'status.done': 'Done',
    'status.inbox': 'Inbox',
    'status.next': 'Next',
    'status.reference': 'Reference',
    'status.someday': 'Someday',
    'status.waiting': 'Waiting',
    'taskEdit.noAreaOption': 'No area',
};

const t = (key: string) => translations[key] ?? key;

const project: Project = {
    id: 'project-1',
    title: 'Launch',
    color: '#3b82f6',
    order: 0,
    status: 'active',
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

const projectSection: Section = {
    id: 'section-1',
    projectId: project.id,
    title: 'Planning',
    order: 0,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

const task = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title,
    status: 'next',
    projectId: project.id,
    tags: [],
    contexts: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
});

type ProjectWorkspaceProps = ComponentProps<typeof ProjectWorkspace>;

const defaultProps: ProjectWorkspaceProps = {
    highlightTaskId: null,
    isAreaCreating: false,
    isCreatingProject: false,
    language: 'en',
    onDuplicateProject: vi.fn(),
    onManageAreas: vi.fn(),
    onRequestQuickArea: vi.fn(),
    onToggleShowCompletedTasks: vi.fn(),
    requestConfirmation: vi.fn(),
    selectedProjectId: project.id,
    showCompletedTasks: false,
    t,
    taskDragEndRef: { current: null },
};

// Store keys the workspace now reads through useProjectWorkspaceStore; render
// helpers route these overrides to the seeded store instead of to props.
const STORE_OVERRIDE_KEYS = new Set([
    'projects', 'sections', 'areas', 'allTasks', 'undoNotificationsEnabled',
    'addSection', 'updateSection', 'deleteSection', 'reorderSections', 'reorderProjectTasks',
    'updateProject', 'deleteProject', 'restoreProject', 'updateTask',
    'batchMoveTasks', 'batchDeleteTasks', 'batchUpdateTasks', 'setHighlightTask',
    'allTokens', 'selectedProjectTasks', 'sortedAreas', 'areaById', 'noAreaId',
]);

const makeStore = (overrides: Record<string, unknown> = {}) => {
    const allTasks = (overrides.allTasks as Task[] | undefined) ?? [];
    return {
        projects: [project],
        sections: [],
        areas: [],
        allTasks,
        undoNotificationsEnabled: true,
        addSection: vi.fn(),
        updateSection: vi.fn(),
        deleteSection: vi.fn(),
        reorderSections: vi.fn(),
        reorderProjectTasks: vi.fn(),
        updateProject: vi.fn(),
        deleteProject: vi.fn(),
        restoreProject: vi.fn(),
        updateTask: vi.fn(),
        batchMoveTasks: vi.fn(),
        batchDeleteTasks: vi.fn(),
        batchUpdateTasks: vi.fn(),
        setHighlightTask: vi.fn(),
        allTokens: [] as string[],
        // Mirrors getDerivedState().tasksByProjectId in prod: the project's tasks.
        selectedProjectTasks: allTasks,
        sortedAreas: [],
        areaById: new Map(),
        noAreaId: '__none__',
        ...overrides,
    };
};

const seedStore = (overrides: Record<string, unknown> = {}) => {
    storeHolder.current = makeStore(overrides);
};

const splitOverrides = (overrides: Record<string, unknown>) => {
    const store: Record<string, unknown> = {};
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(overrides)) {
        if (key === 'selectedProject') {
            // The workspace derives selectedProject from projects + selectedProjectId.
            store.projects = [value];
            continue;
        }
        if (STORE_OVERRIDE_KEYS.has(key)) store[key] = value;
        else props[key] = value;
    }
    return { store, props };
};

const renderWorkspace = (overrides: Record<string, unknown> = {}) => {
    const { store, props } = splitOverrides(overrides);
    seedStore(store);
    return render(
        <LanguageProvider>
            <DndContext>
                <ProjectWorkspace
                    {...defaultProps}
                    {...(props as Partial<ProjectWorkspaceProps>)}
                />
            </DndContext>
        </LanguageProvider>
    );
};

const renderWorkspaceWithKeybindings = (overrides: Record<string, unknown> = {}) => {
    const { store, props } = splitOverrides(overrides);
    seedStore(store);
    return render(
        <LanguageProvider>
            <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                <DndContext>
                    <ProjectWorkspace
                        {...defaultProps}
                        {...(props as Partial<ProjectWorkspaceProps>)}
                    />
                </DndContext>
            </KeybindingProvider>
        </LanguageProvider>
    );
};

describe('ProjectWorkspace Select mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedStore();
        useUiStore.setState({ editingTaskId: null });
    });

    it('ends the project scroller with the shared end gap, not with viewport padding (#977)', () => {
        const { container } = renderWorkspace();
        expectScrolledEndGap(container);
    });

    it('keeps archived-project task rows out of edit, selection, and drag paths', () => {
        const archivedProject = { ...project, status: 'archived' as const };
        const archivedTask = task('archived-task', 'Historical task', { status: 'archived' });
        const taskDragEndRef = { current: null as ProjectWorkspaceProps['taskDragEndRef']['current'] };
        const updateTask = vi.fn();
        const reorderProjectTasks = vi.fn();

        const { container, queryByRole } = renderWorkspace({
            selectedProject: archivedProject,
            allTasks: [archivedTask],
            selectedProjectTasks: [archivedTask],
            sections: [projectSection],
            taskDragEndRef,
            updateTask,
            reorderProjectTasks,
        });

        expect(queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: 'Add task' })).not.toBeInTheDocument();
        expect(container.querySelector('[data-task-id="archived-task"]'))
            .toHaveAttribute('data-interaction-disabled', 'true');
        expect(container.querySelector('[data-sortable-task-id]')).not.toBeInTheDocument();
        expect(container.querySelector('[data-draggable-task-id]')).not.toBeInTheDocument();

        act(() => {
            taskDragEndRef.current?.({
                active: { id: archivedTask.id },
                over: { id: archivedTask.id },
            } as never);
        });
        expect(updateTask).not.toHaveBeenCalled();
        expect(reorderProjectTasks).not.toHaveBeenCalled();
    });

    it('opens global quick add with the selected project defaults', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        const { getByRole } = renderWorkspace();

        fireEvent.click(getByRole('button', { name: 'Add task' }));

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        const event = quickAddListener.mock.calls[0]?.[0] as CustomEvent;
        expect(event.detail).toEqual({
            initialProps: {
                projectId: project.id,
                status: 'next',
            },
        });
        expect(useUiStore.getState().editingTaskId).toBeNull();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('opens quick add with the selected project from the app-scoped add-task shortcut (#978)', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        renderWorkspaceWithKeybindings();

        fireEvent.keyDown(window, { key: 'a' });

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        expect((quickAddListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
            initialProps: {
                projectId: project.id,
                status: 'next',
            },
        });
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('opens global quick add with section defaults from section add buttons', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        const { getAllByRole } = renderWorkspace({
            sections: [projectSection],
        });

        fireEvent.click(getAllByRole('button', { name: 'Add task' })[1]);

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        const event = quickAddListener.mock.calls[0]?.[0] as CustomEvent;
        expect(event.detail).toEqual({
            initialProps: {
                projectId: project.id,
                sectionId: projectSection.id,
                status: 'next',
            },
        });
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('renders a newly created save-and-edit task outside the initial virtualized project rows', () => {
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        const scrollIntoView = vi.fn();
        const existingTasks = Array.from({ length: 130 }, (_, index) => {
            const timestamp = new Date(Date.UTC(2026, 4, 12, 0, 0, 0) + index * 60_000).toISOString();
            return task(`task-${index}`, `Task ${index}`, {
                createdAt: timestamp,
                updatedAt: timestamp,
            });
        });
        const createdTask = task('task-created', 'New project task', {
            createdAt: '2026-05-12T03:00:00.000Z',
            updatedAt: '2026-05-12T03:00:00.000Z',
        });
        const tasks = [...existingTasks, createdTask];
        act(() => {
            useUiStore.setState({ editingTaskId: createdTask.id });
        });
        HTMLElement.prototype.scrollIntoView = scrollIntoView;

        try {
            const { container, getByText } = renderWorkspace({
                allTasks: tasks,
                highlightTaskId: createdTask.id,
            });

            expect(container.querySelector('[data-virtualized-task-list="true"]')).toBeInTheDocument();
            expect(container.querySelector('[data-index="130"]')).toBeInTheDocument();
            expect(getByText('New project task')).toBeInTheDocument();
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
        } finally {
            HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('sorts completed project tasks by most recent completion first', () => {
        const { container, getByRole } = renderWorkspace({
            showCompletedTasks: true,
            allTasks: [
                task('done-old', 'Old finish', {
                    status: 'done',
                    completedAt: '2026-05-12T09:00:00.000Z',
                    updatedAt: '2026-05-12T09:00:00.000Z',
                }),
                task('done-newest', 'Newest finish', {
                    status: 'done',
                    completedAt: '2026-05-12T11:00:00.000Z',
                    updatedAt: '2026-05-12T11:00:00.000Z',
                }),
                task('done-middle', 'Middle finish', {
                    status: 'done',
                    completedAt: '2026-05-12T10:00:00.000Z',
                    updatedAt: '2026-05-12T10:00:00.000Z',
                }),
            ],
        });

        fireEvent.click(getByRole('button', { name: /Done/ }));

        expect(Array.from(container.querySelectorAll('[data-task-id]')).map((row) => row.getAttribute('data-task-id'))).toEqual([
            'done-newest',
            'done-middle',
            'done-old',
        ]);
    });

    it('keeps completed tasks in sequence for sequential projects', () => {
        const { container } = renderWorkspace({
            selectedProject: { ...project, isSequential: true },
            showCompletedTasks: true,
            allTasks: [
                task('first', 'First', { order: 0 }),
                task('finished', 'Finished', { status: 'done', order: 1 }),
                task('last', 'Last', { order: 2 }),
            ],
        });

        expect(container.querySelector('[data-project-completed-toggle]')).not.toBeInTheDocument();
        expect(Array.from(container.querySelectorAll('[data-task-id]')).map((row) => row.getAttribute('data-task-id'))).toEqual([
            'first',
            'finished',
            'last',
        ]);
    });

    it('restores project scroll after expanding completed tasks and entering selection mode', () => {
        const { container, getByRole } = renderWorkspace({
            showCompletedTasks: true,
            allTasks: [
                task('active-1', 'Active task'),
                task('done-1', 'Finished one', {
                    status: 'done',
                    completedAt: '2026-05-12T10:00:00.000Z',
                }),
                task('done-2', 'Finished two', {
                    status: 'done',
                    completedAt: '2026-05-12T11:00:00.000Z',
                }),
            ],
        });
        const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement;
        expect(scrollContainer).toBeTruthy();

        scrollContainer.scrollTop = 420;
        fireEvent.click(getByRole('button', { name: /Done/ }));

        expect(scrollContainer.scrollTop).toBe(420);

        scrollContainer.scrollTop = 360;
        fireEvent.click(getByRole('button', { name: 'Select' }));

        expect(scrollContainer.scrollTop).toBe(360);
    });

    it('keeps the first visible project task anchored when Select expands the toolbar', () => {
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const getRect = (top: number, bottom: number) => ({
            top,
            bottom,
            left: 0,
            right: 320,
            width: 320,
            height: bottom - top,
            x: 0,
            y: top,
            toJSON: () => ({}),
        } as DOMRect);

        try {
            const { container, getByRole } = renderWorkspace({
                allTasks: [
                    task('task-1', 'Earlier task'),
                    task('task-2', 'Visible task'),
                ],
            });
            const scrollContainer = container.querySelector('[data-project-scroll-container]') as HTMLDivElement;
            expect(scrollContainer).toBeTruthy();

            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getMockRect(this: HTMLElement) {
                const element = this as HTMLElement;
                if (element === scrollContainer) return getRect(0, 600);
                if (element.getAttribute('data-task-id') === 'task-1') return getRect(-120, -80);
                if (element.getAttribute('data-task-id') === 'task-2') {
                    const selectModeActive = document.body.textContent?.includes('Exit Select') ?? false;
                    return getRect(selectModeActive ? 160 : 120, selectModeActive ? 200 : 160);
                }
                return originalGetBoundingClientRect.call(element);
            });

            scrollContainer.scrollTop = 360;
            fireEvent.click(getByRole('button', { name: 'Select' }));

            expect(scrollContainer.scrollTop).toBe(400);
        } finally {
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('shows bulk organize and area assignment for selected project tasks', () => {
        const area = {
            id: 'area-1',
            name: 'Work',
            color: '#2563eb',
            order: 0,
            createdAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
        };
        const projectTask = task('task-1', 'Move me');
        const { getByRole } = renderWorkspace({
            allTasks: [projectTask],
            areas: [area],
            sortedAreas: [area],
            selectedProjectTasks: [projectTask],
        });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('checkbox', { name: 'Select task' }));

        expect(getByRole('button', { name: 'Bulk organize' })).toBeInTheDocument();
        expect(getByRole('combobox', { name: 'Area' })).toBeInTheDocument();
    });

    it('offers the project\'s sections in the bulk organize dialog (#1122)', () => {
        const projectTask = task('task-1', 'Move me');
        const { getByRole } = renderWorkspace({
            allTasks: [projectTask],
            selectedProjectTasks: [projectTask],
            sections: [projectSection],
        });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('checkbox', { name: 'Select task' }));
        fireEvent.click(getByRole('button', { name: 'Bulk organize' }));

        const sectionSelect = getByRole('combobox', { name: 'Project section' });
        expect(sectionSelect).toBeInTheDocument();
        expect(getByRole('option', { name: projectSection.title })).toBeInTheDocument();
    });

    it('retries scrolling to a highlighted project task after navigation', async () => {
        vi.useFakeTimers();
        const highlightedTask = task('task-1', 'Highlighted task');
        const scrollIntoView = vi.fn();
        // The row is "not mounted yet" until the flag flips: both the scroll
        // retry and the focus retry (#1014) query for it, so the mock is
        // state-based rather than call-count-based.
        let rowMounted = false;
        const fakeRow = {
            scrollIntoView,
            querySelector: () => null,
            matches: () => false,
        } as unknown as Element;
        const originalQuerySelector = document.querySelector.bind(document);
        const querySelectorSpy = vi.spyOn(document, 'querySelector').mockImplementation((selector) => {
            if (selector === '[data-task-id="task-1"]') {
                return rowMounted ? fakeRow : null;
            }
            return originalQuerySelector(selector);
        });

        try {
            renderWorkspace({
                allTasks: [highlightedTask],
                highlightTaskId: highlightedTask.id,
            });

            expect(scrollIntoView).not.toHaveBeenCalled();

            rowMounted = true;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(50);
            });

            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
        } finally {
            querySelectorSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it('selects all visible project tasks and clears the selection', () => {
        const allTasks = [
            task('task-1', 'First task'),
            task('task-2', 'Second task'),
        ];
        const { getAllByRole, getByRole } = renderWorkspace({ allTasks });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        expect(getByRole('button', { name: 'Select All' })).toBeEnabled();
        expect(getByRole('button', { name: 'Clear' })).toBeDisabled();

        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true]);
        expect(getByRole('button', { name: 'Select All' })).toBeDisabled();
        expect(getByRole('button', { name: 'Clear' })).toBeEnabled();

        fireEvent.click(getByRole('button', { name: 'Clear' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([false, false]);
    });

    it('selects a contiguous project task range with shift-click', () => {
        const allTasks = [
            task('task-1', 'First task'),
            task('task-2', 'Second task'),
            task('task-3', 'Third task'),
        ];
        const { getAllByRole, getByRole } = renderWorkspace({ allTasks });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        const checkboxes = getAllByRole('checkbox', { name: 'Select task' });

        fireEvent.click(checkboxes[0]);
        fireEvent.click(checkboxes[2], { shiftKey: true });

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true, true]);
    });

    it('bulk deletes selected project tasks after confirmation', async () => {
        const batchDeleteTasks = vi.fn();
        const requestConfirmation = vi.fn().mockResolvedValue(true);
        const allTasks = [
            task('task-1', 'First task'),
            task('task-2', 'Second task'),
        ];
        const { getByRole } = renderWorkspace({
            allTasks,
            batchDeleteTasks,
            requestConfirmation,
        });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));
        fireEvent.click(getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(requestConfirmation).toHaveBeenCalled();
            expect(batchDeleteTasks).toHaveBeenCalledWith(['task-1', 'task-2']);
        });
    });

    it('bounds mounted rows for large project task lists', async () => {
        const allTasks = Array.from({ length: 200 }, (_, index) => (
            task(`task-${index}`, `Task ${index}`)
        ));
        const { container } = renderWorkspace({ allTasks });

        await waitFor(() => {
            const virtualList = container.querySelector('[data-virtualized-task-list="true"]');
            expect(virtualList).not.toBeNull();

            const mountedRows = container.querySelectorAll('[data-virtualized-task-list="true"] [data-index]');
            expect(mountedRows.length).toBeGreaterThan(0);
            expect(mountedRows.length).toBeLessThan(80);
        });
    });


    it('clears project search from an inline clear button and refocuses the field', () => {
        const { getByLabelText, getByPlaceholderText, queryByLabelText } = renderWorkspace();
        const input = getByPlaceholderText('Search...') as HTMLInputElement;

        expect(queryByLabelText('Clear search')).toBeNull();

        fireEvent.change(input, { target: { value: 'first' } });
        const clearButton = getByLabelText('Clear search');
        fireEvent.click(clearButton);

        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(queryByLabelText('Clear search')).toBeNull();
    });

    it('keeps select grouped with project task controls instead of the search row', () => {
        const { container, getByRole } = renderWorkspace();
        const selectButton = getByRole('button', { name: 'Select' });
        const searchRow = container.querySelector('[data-project-search-row]');
        const toolbar = container.querySelector('[data-project-task-toolbar]');

        expect(searchRow).not.toBeNull();
        expect(toolbar).not.toBeNull();
        expect(searchRow).not.toContainElement(selectButton);
        expect(toolbar).toContainElement(selectButton);
    });

    it('condenses the project task toolbar while scrolled down and expands at the top', () => {
        const allTasks = Array.from({ length: 120 }, (_, index) => task(`task-${index}`, `Task ${index}`));
        const { container } = renderWorkspace({ allTasks });
        const scrollContainer = container.querySelector('[data-project-scroll-container]') as HTMLDivElement;
        const toolbar = container.querySelector('[data-project-task-toolbar]');

        expect(scrollContainer).toBeTruthy();
        expect(toolbar).toHaveAttribute('data-compact', 'false');

        scrollContainer.scrollTop = 140;
        fireEvent.scroll(scrollContainer);
        expect(toolbar).toHaveAttribute('data-compact', 'true');

        scrollContainer.scrollTop = 64;
        fireEvent.scroll(scrollContainer);
        expect(toolbar).toHaveAttribute('data-compact', 'true');

        scrollContainer.scrollTop = 0;
        fireEvent.scroll(scrollContainer);
        expect(toolbar).toHaveAttribute('data-compact', 'false');
    });

    const sortSampleTasks = () => [
        task('task-no-due', 'No due', { createdAt: '2026-05-01T00:00:00.000Z', order: 0 }),
        task('task-later', 'Later due', { createdAt: '2026-05-02T00:00:00.000Z', dueDate: '2026-07-01', order: 1 }),
        task('task-soon', 'Soon due', { createdAt: '2026-05-03T00:00:00.000Z', dueDate: '2026-06-01', order: 2 }),
    ];

    it('persists the chosen project sort via updateProject', () => {
        const updateProject = vi.fn();
        renderWorkspace({ allTasks: sortSampleTasks(), updateProject });

        selectToolbarOption('Sort', 'Due date');

        expect(updateProject).toHaveBeenCalledWith('project-1', { taskSortBy: 'due' });
    });

    it('falls back to the default manual order when the project has no persisted sort', () => {
        const { container } = renderWorkspace({ allTasks: sortSampleTasks() });
        const taskTitles = () => Array.from(container.querySelectorAll('[data-task-id] span')).map((item) => item.textContent);

        expect(taskTitles()).toEqual(['No due', 'Later due', 'Soon due']);
    });

    it('renders the project task list in the project\'s persisted sort order', () => {
        const { container } = renderWorkspace({
            allTasks: sortSampleTasks(),
            selectedProject: { ...project, taskSortBy: 'due' },
        });
        const taskTitles = () => Array.from(container.querySelectorAll('[data-task-id] span')).map((item) => item.textContent);

        expect(taskTitles()).toEqual(['Soon due', 'Later due', 'No due']);
    });
});
