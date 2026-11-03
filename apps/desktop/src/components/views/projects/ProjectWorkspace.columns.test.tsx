import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { flushPendingSave, getStorageAdapter, setStorageAdapter, useTaskStore, type Project, type Section, type Task } from '@mindwtr/core';

import { useUiStore } from '../../../store/ui-store';
import { LanguageProvider } from '../../../contexts/language-context';
import type { TaskListScope } from '../../../contexts/keybinding-context';
import { ProjectWorkspace } from './ProjectWorkspace';
import { projectsViewCollisionDetection, projectsViewKeyboardCoordinates } from './projects-view-dnd';

vi.mock('../../TaskItem', () => ({
    TaskItem: ({ task }: { task: Task }) => (
        <div data-task-id={task.id}>
            <button type="button" data-task-view-toggle>{task.title}</button>
        </div>
    ),
}));


vi.mock('./SortableRows', () => ({
    SortableProjectTaskRow: (
        { task, sequenceCue, narrow }: { task: Task; sequenceCue?: string; narrow?: boolean },
    ) => (
        <div
            data-task-id={task.id}
            data-sequence-cue={sequenceCue ?? 'none'}
            data-narrow={narrow ? 'true' : 'false'}
        >
            <button type="button" data-task-view-toggle>{task.title}</button>
        </div>
    ),
    DraggableProjectTaskRow: ({ task }: { task: Task }) => (
        <div data-task-id={task.id}>
            <button type="button" data-task-view-toggle>{task.title}</button>
        </div>
    ),
}));

vi.mock('../../PromptModal', () => ({ PromptModal: () => null }));
vi.mock('../../TokenPickerModal', () => ({ TokenPickerModal: () => null }));
vi.mock('./ProjectDetailsHeader', () => ({
    ProjectDetailsHeader: ({ project }: { project: Project }) => <div>{project.title}</div>,
}));
vi.mock('./ProjectDetailsFields', () => ({ ProjectDetailsFields: () => null }));
vi.mock('./ProjectNotesSection', () => ({ ProjectNotesSection: () => null }));

const storeHolder = vi.hoisted(() => ({ current: null as unknown }));
const registerTaskListScope = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/keybinding-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../../contexts/keybinding-context')>(),
    useOptionalKeybindings: () => ({ registerTaskListScope }),
}));
vi.mock('./useProjectWorkspaceStore', () => ({
    useProjectWorkspaceStore: () => storeHolder.current,
}));

const translations: Record<string, string> = {
    'bulk.select': 'Select',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.search': 'Search...',
    'projects.addSection': 'Add section',
    'projects.addTask': 'Add task',
    'projects.layoutColumns': 'Columns',
    'projects.moveSectionLeft': 'Move section left',
    'projects.moveSectionRight': 'Move section right',
    'projects.noActiveTasks': 'No active tasks',
    'projects.noSection': 'No Section',
    'projects.reorderSections': 'Reorder sections',
    'projects.sectionEmpty': 'No tasks',
    'projects.sectionNotes': 'Section notes',
    'projects.sectionsLabel': 'Tasks',
    'taskEdit.moreOptions': 'More options',
    'sort.default': 'Default',
    'sort.label': 'Sort',
    'status.reference': 'Reference',
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

const section = (id: string, title: string, order: number): Section => ({
    id,
    projectId: project.id,
    title,
    order,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

const planning = section('section-a', 'Planning', 0);
const shipping = section('section-b', 'Shipping', 1);

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

const tasks = [
    task('task-1', 'Draft plan', { sectionId: planning.id, order: 0 }),
    task('task-2', 'Review plan', { sectionId: planning.id, order: 1 }),
    task('task-3', 'Cut release', { sectionId: shipping.id, order: 0 }),
    task('task-4', 'Loose end', { order: 0 }),
];

type ProjectWorkspaceProps = ComponentProps<typeof ProjectWorkspace>;

const makeStore = (overrides: Record<string, unknown> = {}) => {
    const allTasks = (overrides.allTasks as Task[] | undefined) ?? tasks;
    return {
        projects: [project],
        sections: [planning, shipping],
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
        restoreTask: vi.fn(),
        batchMoveTasks: vi.fn(),
        batchDeleteTasks: vi.fn(),
        batchUpdateTasks: vi.fn(),
        setHighlightTask: vi.fn(),
        allTokens: [] as string[],
        selectedProjectTasks: allTasks,
        sortedAreas: [],
        areaById: new Map(),
        noAreaId: '__none__',
        ...overrides,
    };
};

type RenderOptions = {
    store?: Record<string, unknown>;
    props?: Partial<ProjectWorkspaceProps>;
    layout?: 'list' | 'columns';
};

function WorkspaceDndContext({ children, onDragEnd }: { children: ReactNode; onDragEnd: (event: DragEndEvent) => void }) {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: projectsViewKeyboardCoordinates }),
    );
    return <DndContext sensors={sensors} collisionDetection={projectsViewCollisionDetection} onDragEnd={onDragEnd}>{children}</DndContext>;
}

const renderWorkspace = ({ store = {}, props = {}, layout }: RenderOptions = {}) => {
    storeHolder.current = makeStore(store);
    if (layout) useUiStore.setState({ projectLayouts: { [project.id]: layout } });
    const taskDragEndRef: RefObject<((event: DragEndEvent) => void) | null> = { current: null };
    const utils = render(
        <LanguageProvider>
            <WorkspaceDndContext onDragEnd={(event) => taskDragEndRef.current?.(event)}>
            <ProjectWorkspace
                highlightTaskId={null}
                isAreaCreating={false}
                isCreatingProject={false}
                language="en"
                onDuplicateProject={vi.fn()}
                onManageAreas={vi.fn()}
                onRequestQuickArea={vi.fn()}
                onToggleShowCompletedTasks={vi.fn()}
                requestConfirmation={vi.fn()}
                selectedProjectId={project.id}
                showCompletedTasks={false}
                t={t}
                taskDragEndRef={taskDragEndRef}
                {...props}
            />
            </WorkspaceDndContext>
        </LanguageProvider>
    );
    return { ...utils, taskDragEndRef, store: storeHolder.current as ReturnType<typeof makeStore> };
};

const dragEnd = (activeId: string, overId: string): DragEndEvent => ({
    active: { id: activeId, data: { current: { type: 'task', sortable: true } } },
    over: { id: overId, data: { current: {} } },
} as unknown as DragEndEvent);

const sectionDragEnd = (sectionId: string, overSectionId: string, projectId = project.id): DragEndEvent => ({
    active: { id: `project-section:${sectionId}`, data: { current: { type: 'project-section', projectId, sectionId } } },
    over: { id: `project-section:${overSectionId}`, data: { current: { type: 'project-section', projectId, sectionId: overSectionId } } },
} as unknown as DragEndEvent);

const columnTitles = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-project-section-columns] > div'))
        .map((column) => column.querySelector('.border-b')?.textContent ?? '');

const columnTaskIds = (container: HTMLElement, columnIndex: number) => {
    const column = container.querySelectorAll('[data-project-section-columns] > div')[columnIndex];
    return Array.from(column?.querySelectorAll('[data-task-id]') ?? [])
        .map((row) => row.getAttribute('data-task-id'));
};

describe('ProjectWorkspace sections-as-columns (#1019)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUiStore.setState({ editingTaskId: null, projectLayouts: {} });
        window.localStorage.clear();
    });

    it('offers the layout toggle only on a project that has sections', () => {
        const withoutSections = renderWorkspace({ store: { sections: [], allTasks: [tasks[3]] } });
        expect(withoutSections.queryByRole('button', { name: 'Columns' })).toBeNull();
        withoutSections.unmount();

        const withSections = renderWorkspace();
        fireEvent.click(withSections.getByRole('button', { name: 'More options: Tasks' }));
        expect(withSections.getByRole('menuitemcheckbox', { name: 'Columns' })).toBeInTheDocument();
    });

    it('remembers the layout per project as device-local state', () => {
        const { getByRole } = renderWorkspace();

        fireEvent.click(getByRole('button', { name: 'More options: Tasks' }));
        fireEvent.click(getByRole('menuitemcheckbox', { name: 'Columns' }));

        expect(useUiStore.getState().projectLayouts).toEqual({ [project.id]: 'columns' });
        expect(window.localStorage.getItem('mindwtr:project-layouts:v1'))
            .toBe(JSON.stringify({ [project.id]: 'columns' }));
        fireEvent.click(getByRole('button', { name: 'More options: Tasks' }));
        expect(getByRole('menuitemcheckbox', { name: 'Columns' })).toHaveAttribute('aria-checked', 'true');
    });

    it('renders sections in order with the unsectioned bucket last, each column holding its own tasks', () => {
        const { container } = renderWorkspace({ layout: 'columns' });

        expect(columnTitles(container).map((title) => title.replace(/\d+$/, '')))
            .toEqual(['Planning', 'Shipping', 'No Section']);
        expect(columnTaskIds(container, 0)).toEqual(['task-1', 'task-2']);
        expect(columnTaskIds(container, 1)).toEqual(['task-3']);
        expect(columnTaskIds(container, 2)).toEqual(['task-4']);
    });

    it('hides the No Section column while every task belongs to a section', () => {
        const { container } = renderWorkspace({
            layout: 'columns',
            store: { allTasks: tasks.slice(0, 3) },
        });

        expect(columnTitles(container).map((title) => title.replace(/\d+$/, '')))
            .toEqual(['Planning', 'Shipping']);
    });

    it('reorders within a column through the section-scoped store call', () => {
        const { container, taskDragEndRef, store } = renderWorkspace({ layout: 'columns' });
        expect(container.querySelector('[data-project-section-columns]')).not.toBeNull();

        taskDragEndRef.current?.(dragEnd('task-2', 'task-1'));

        expect(store.reorderProjectTasks).toHaveBeenCalledWith(
            project.id,
            ['task-2', 'task-1'],
            planning.id,
            'task-2',
        );
    });

    it('moves a task across columns with the same section move the stacked layout makes', async () => {
        const { container, taskDragEndRef, store } = renderWorkspace({ layout: 'columns' });
        expect(container.querySelector('[data-project-section-columns]')).not.toBeNull();

        taskDragEndRef.current?.(dragEnd('task-1', 'task-3'));

        await waitFor(() => {
            expect(store.updateTask).toHaveBeenCalledWith('task-1', { sectionId: shipping.id });
        });
        expect(store.reorderProjectTasks).toHaveBeenCalledWith(project.id, ['task-2'], planning.id);
        expect(store.reorderProjectTasks).toHaveBeenCalledWith(
            project.id,
            ['task-1', 'task-3'],
            shipping.id,
            'task-1',
        );
    });

    it('clears the section when a task is dropped on the unsectioned column', async () => {
        const { container, taskDragEndRef, store } = renderWorkspace({ layout: 'columns' });
        expect(container.querySelector('[data-project-section-columns]')).not.toBeNull();

        taskDragEndRef.current?.(dragEnd('task-1', 'section:none'));

        await waitFor(() => {
            expect(store.updateTask).toHaveBeenCalledWith('task-1', { sectionId: undefined });
        });
    });

    it('keeps the sequential cues section-scoped in columns mode', () => {
        const sequentialProject: Project = { ...project, isSequential: true, sequentialScope: 'section' };
        const { container } = renderWorkspace({
            layout: 'columns',
            store: { projects: [sequentialProject] },
        });

        const cueOf = (taskId: string) => container
            .querySelector(`[data-project-section-columns] [data-task-id="${taskId}"]`)
            ?.getAttribute('data-sequence-cue');

        expect(cueOf('task-1')).toBe('available');
        expect(cueOf('task-2')).toBe('later');
        expect(cueOf('task-3')).toBe('available');
    });

    it('hands DOM focus to a highlighted row rendered inside a column (#1014)', async () => {
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        HTMLElement.prototype.scrollIntoView = vi.fn();
        try {
            const { container } = renderWorkspace({
                layout: 'columns',
                props: { highlightTaskId: 'task-3' },
            });

            await waitFor(() => {
                const row = container.querySelector('[data-project-section-columns] [data-task-id="task-3"]');
                expect(row).not.toBeNull();
                expect(document.activeElement).toBe(row?.querySelector('[data-task-view-toggle]'));
            });
        } finally {
            HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('tells column rows they are narrow, so the actions strip stops starving the title', () => {
        const { container } = renderWorkspace({ layout: 'columns' });

        const narrowFlags = Array.from(container.querySelectorAll('[data-project-section-columns] [data-task-id]'))
            .map((row) => row.getAttribute('data-narrow'));
        expect(narrowFlags).toEqual(['true', 'true', 'true', 'true']);
    });

    it('leaves list-layout rows at full width', () => {
        const { container } = renderWorkspace();

        expect(container.querySelector('[data-task-id]')?.getAttribute('data-narrow')).toBe('false');
    });

    it('scopes the empty-column copy to the section, not the project', () => {
        const { getAllByText, queryByText } = renderWorkspace({
            layout: 'columns',
            store: { allTasks: [tasks[0], tasks[1]] },
        });


        expect(getAllByText('No tasks')).toHaveLength(1);
        expect(queryByText('No active tasks')).toBeNull();
    });


    it('scopes the empty-section copy in the list layout too', () => {
        const { getAllByText, queryByText } = renderWorkspace({
            store: { allTasks: [tasks[0], tasks[1]] },
        });


        expect(getAllByText('No tasks')).toHaveLength(1);
        expect(queryByText('No active tasks')).toBeNull();
    });

    it('reorders sections along the column axis with left/right affordances', () => {
        const { getByRole, store } = renderWorkspace({ layout: 'columns' });

        fireEvent.click(getByRole('button', { name: 'More options: Shipping' }));
        fireEvent.click(getByRole('menuitem', { name: 'Move section left: Shipping' }));

        expect(store.reorderSections).toHaveBeenCalledWith(project.id, [shipping.id, planning.id]);
    });

    it.each(['list', 'columns'] as const)('drags section headers in %s without moving their tasks', (layout) => {
        const { getByRole, taskDragEndRef, store } = renderWorkspace({ layout });
        expect(getByRole('button', { name: 'Reorder sections: Shipping' })).toBeInTheDocument();

        taskDragEndRef.current?.(sectionDragEnd(shipping.id, planning.id));

        expect(store.reorderSections).toHaveBeenCalledWith(project.id, [shipping.id, planning.id]);
        expect(store.reorderProjectTasks).not.toHaveBeenCalled();
        expect(store.updateTask).not.toHaveBeenCalled();
    });

    it('reorders a header using the real keyboard drag sensor', async () => {
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const top = this.querySelector('button[aria-label="Reorder sections: Shipping"]') ? 100 : 0;
            return { top, bottom: top + 30, left: 0, right: 300, width: 300, height: 30, x: 0, y: top, toJSON: () => ({}) };
        });
        try {
            const { getByRole, store } = renderWorkspace({ store: { allTasks: tasks.slice(0, 3) } });
            const handle = getByRole('button', { name: 'Reorder sections: Shipping' });
            handle.focus();
            fireEvent.keyDown(handle, { code: 'Space' });
            await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'));
            fireEvent.keyDown(document, { code: 'ArrowUp' });
            fireEvent.keyDown(document, { code: 'Space' });
            await waitFor(() => expect(store.reorderSections).toHaveBeenCalledWith(project.id, [shipping.id, planning.id]));
        } finally {
            measure.mockRestore();
        }
    });

    it('reorders sections while tasks use a non-manual sort', () => {
        const { taskDragEndRef, store } = renderWorkspace({ store: { projects: [{ ...project, taskSortBy: 'title' }] } });
        taskDragEndRef.current?.(sectionDragEnd(shipping.id, planning.id));
        expect(store.reorderSections).toHaveBeenCalledWith(project.id, [shipping.id, planning.id]);
    });

    it('rejects cross-project and non-section drops', () => {
        const { taskDragEndRef, store } = renderWorkspace();
        taskDragEndRef.current?.(sectionDragEnd(shipping.id, planning.id, 'other-project'));
        const onTask = sectionDragEnd(shipping.id, planning.id);
        onTask.over = dragEnd('task-1', 'task-2').over;
        taskDragEndRef.current?.(onTask);
        taskDragEndRef.current?.(sectionDragEnd(shipping.id, shipping.id));
        expect(store.reorderSections).not.toHaveBeenCalled();
        expect(store.updateTask).not.toHaveBeenCalled();
    });

    it.each(['archived', 'creating', 'task editor'] as const)('disables section dragging while %s', (condition) => {
        if (condition === 'task editor') useUiStore.setState({ editingTaskId: 'task-1' });
        const { queryByRole, taskDragEndRef, store } = renderWorkspace({
            store: condition === 'archived' ? { projects: [{ ...project, status: 'archived' }] } : {},
            props: { isCreatingProject: condition === 'creating' },
        });
        expect(queryByRole('button', { name: 'Reorder sections: Shipping' })).toBeNull();
        taskDragEndRef.current?.(sectionDragEnd(shipping.id, planning.id));
        expect(store.reorderSections).not.toHaveBeenCalled();
    });

    it('disables section dragging while a section title draft is open', () => {
        const { getByRole, queryByRole, taskDragEndRef, store } = renderWorkspace();
        fireEvent.click(getByRole('button', { name: 'More options: Planning' }));
        fireEvent.click(getByRole('menuitem', { name: 'Edit' }));
        expect(queryByRole('button', { name: 'Reorder sections: Shipping' })).toBeNull();
        taskDragEndRef.current?.(sectionDragEnd(shipping.id, planning.id));
        expect(store.reorderSections).not.toHaveBeenCalled();
    });

    it('persists a header drag through the existing section reorder command using fresh section order', async () => {
        const initialState = useTaskStore.getState();
        const previousAdapter = getStorageAdapter();
        const newest = section('section-c', 'Newest section', 2);
        const saved: Parameters<ReturnType<typeof getStorageAdapter>['saveData']>[0][] = [];
        setStorageAdapter({
            getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData: async (data) => { saved.push(data); },
        });
        try {
            const { taskDragEndRef } = renderWorkspace({ store: { reorderSections: initialState.reorderSections } });

            useTaskStore.setState({
                projects: [project], _allProjects: [project], sections: [planning, shipping, newest],
                _allSections: [planning, shipping, newest], _allTasks: tasks, tasks,
                _sectionsById: new Map([planning, shipping, newest].map((row) => [row.id, row])),
                _projectsById: new Map([[project.id, project]]),
                _tasksById: new Map(tasks.map((row) => [row.id, row])),
                settings: { deviceId: 'sections-test' },
            });
            await act(async () => {
                taskDragEndRef.current?.(sectionDragEnd(shipping.id, planning.id));
                await flushPendingSave();
            });
            expect(saved.length).toBeGreaterThan(0);
            const persisted = saved[saved.length - 1];
            expect([...(persisted.sections ?? [])].sort((a, b) => a.order - b.order).map((row) => row.id))
                .toEqual([shipping.id, planning.id, newest.id]);
            expect(persisted.tasks).toEqual(tasks);
        } finally {
            await flushPendingSave();
            setStorageAdapter(previousAdapter);
            useTaskStore.setState(initialState, true);
        }
    });

    it('opens quick add directly inside the chosen section', () => {
        const onQuickAdd = vi.fn();
        window.addEventListener('mindwtr:quick-add', onQuickAdd);
        try {
            const { getAllByRole } = renderWorkspace();
            fireEvent.click(getAllByRole('button', { name: 'Add task' })[0]);
            expect(onQuickAdd.mock.calls[0][0].detail.initialProps)
                .toEqual({ projectId: project.id, status: 'next', sectionId: planning.id });
        } finally {
            window.removeEventListener('mindwtr:quick-add', onQuickAdd);
        }
    });

    it('dismisses a section overflow with Escape and restores focus to its trigger', () => {
        const { getByRole, queryByRole } = renderWorkspace({ layout: 'columns' });
        const trigger = getByRole('button', { name: 'More options: Planning' });

        fireEvent.click(trigger);
        const firstAction = getByRole('menuitem', { name: 'Move section right: Planning' });
        expect(firstAction).toHaveFocus();

        fireEvent.keyDown(firstAction, { key: 'Escape' });
        expect(queryByRole('menuitem', { name: 'Move section right: Planning' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});

describe('ProjectWorkspace reference sections', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUiStore.setState({ editingTaskId: null, projectLayouts: {} });
        window.localStorage.clear();
    });

    const references = [
        task('ref-loose', 'Loose reference', { status: 'reference', order: 0 }),
        task('ref-shipping', 'Shipping reference', { status: 'reference', sectionId: shipping.id, order: 1 }),
        task('ref-planning-2', 'Second planning reference', { status: 'reference', sectionId: planning.id, order: 3 }),
        task('ref-planning-1', 'First planning reference', { status: 'reference', sectionId: planning.id, order: 2 }),
        task('ref-missing', 'Missing section reference', { status: 'reference', sectionId: 'missing', order: 4 }),
        task('ref-foreign', 'Linked reference', {
            status: 'reference', projectId: 'other-project', sectionId: planning.id, tags: ['#launch'], order: 5,
        }),
        task('ref-deleted-section', 'Deleted section reference', { status: 'reference', sectionId: 'deleted', order: 6 }),
        task('ref-unrelated', 'Unrelated reference', { status: 'reference', projectId: 'other-project', order: 6 }),
    ];
    const referenceStore = {
        projects: [{ ...project, tagIds: ['#launch'] }],
        sections: [
            shipping, section('empty', 'Empty', 2), planning,
            { ...section('deleted', 'Deleted', 3), deletedAt: '2026-05-13T00:00:00.000Z' },
        ],
        allTasks: [...tasks, ...references],
    };
    const referenceArea = (container: HTMLElement) =>
        container.querySelector<HTMLElement>('[data-project-reference-tasks]')!;
    const rowIds = (element: HTMLElement) => Array.from(element.querySelectorAll('[data-task-id]'))
        .map((row) => row.getAttribute('data-task-id'));
    const expectedReferenceOrder = [
        'ref-planning-1', 'ref-planning-2', 'ref-shipping', 'ref-loose', 'ref-missing', 'ref-foreign', 'ref-deleted-section',
    ];

    it.each(['list', 'columns'] as const)('groups references separately in section order in %s layout', (layout) => {
        const { container } = renderWorkspace({ store: referenceStore, layout });
        const area = referenceArea(container);

        expect(within(area).getAllByRole('heading').map((heading) => heading.textContent))
            .toEqual(['Planning2', 'Shipping1', 'No Section4']);
        expect(rowIds(area)).toEqual(expectedReferenceOrder);
        expect(rowIds(container)).toEqual([...tasks.map((item) => item.id), ...expectedReferenceOrder]);
        expect(within(area).queryByText('Empty')).toBeNull();
        expect(within(area).queryByText('Deleted')).toBeNull();
        expect(within(area).queryByText('Unrelated reference')).toBeNull();
    });

    it('walks grouped references in rendered order after actionable tasks', () => {
        const { container } = renderWorkspace({ store: referenceStore });
        const scope = registerTaskListScope.mock.calls[registerTaskListScope.mock.calls.length - 1]?.[0] as TaskListScope;
        act(() => scope.selectFirst());
        for (const id of [...tasks.map((item) => item.id), ...expectedReferenceOrder]) {
            expect(document.activeElement?.closest('[data-task-id]')).toHaveAttribute('data-task-id', id);
            act(() => scope.selectNext());
        }
        expect(rowIds(referenceArea(container))).toEqual(expectedReferenceOrder);
    });

    it('filters references before grouping and hides newly empty groups', () => {
        const { container, getByRole } = renderWorkspace({ store: referenceStore });
        fireEvent.change(getByRole('textbox', { name: 'Search...' }), { target: { value: 'Shipping reference' } });

        const area = referenceArea(container);
        expect(within(area).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Shipping1']);
        expect(rowIds(area)).toEqual(['ref-shipping']);
    });

    it('keeps references flat when the project has no sections', () => {
        const { container } = renderWorkspace({ store: { ...referenceStore, sections: [] } });
        const area = referenceArea(container);

        expect(within(area).queryByRole('heading')).toBeNull();
        expect(within(area).queryByText('No Section')).toBeNull();
        expect(rowIds(area)).toEqual([
            'ref-loose', 'ref-shipping', 'ref-planning-1', 'ref-planning-2', 'ref-missing', 'ref-foreign', 'ref-deleted-section',
        ]);
    });
});

describe('ProjectWorkspace section notes preview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUiStore.setState({ editingTaskId: null, projectLayouts: {} });
        window.localStorage.clear();
    });

    const withNotes = (description?: string): Section[] => [
        { ...planning, description },
        shipping,
    ];

    const previewTexts = (container: HTMLElement) =>
        Array.from(container.querySelectorAll('[data-section-notes-preview]'))
            .map((node) => node.textContent);

    it('shows the first notes line under the section header, markdown markers stripped', () => {
        const { container } = renderWorkspace({
            store: { sections: withNotes('# Kickoff **scope**\n\nSecond line') },
        });

        expect(previewTexts(container)).toEqual(['Kickoff scope']);
    });

    it('strips markdown from the tooltip and ellipsises what it cut', () => {
        const longNotes = `**Bold** [label](https://example.com) ${'x'.repeat(400)}`;
        const { container } = renderWorkspace({ store: { sections: withNotes(longNotes) } });

        const title = container.querySelector('[data-section-notes-preview]')?.getAttribute('title') ?? '';

        expect(title).not.toContain('**');
        expect(title).not.toContain('](');
        expect(title.startsWith('Bold label ')).toBe(true);
        expect(title.endsWith('…')).toBe(true);
    });

    it('shows the preview in the columns layout too', () => {
        const { container } = renderWorkspace({
            layout: 'columns',
            store: { sections: withNotes('Natural planning: purpose first') },
        });

        const columns = container.querySelectorAll('[data-project-section-columns] > div');
        expect(columns[0].querySelector('[data-section-notes-preview]')?.textContent)
            .toBe('Natural planning: purpose first');
        expect(columns[1].querySelector('[data-section-notes-preview]')).toBeNull();
    });

    it('renders nothing for empty or whitespace-only notes', () => {
        const { container } = renderWorkspace({ store: { sections: withNotes('   \n  ') } });
        expect(previewTexts(container)).toEqual([]);

        const { container: undefinedNotes } = renderWorkspace({ store: { sections: withNotes() } });
        expect(previewTexts(undefinedNotes)).toEqual([]);
    });


    it('hides that section\'s preview while its notes editor is open', () => {
        const { container, getAllByRole } = renderWorkspace({
            store: {
                sections: [
                    { ...planning, description: 'Planning notes' },
                    { ...shipping, description: 'Shipping notes' },
                ],
            },
        });

        expect(previewTexts(container)).toEqual(['Planning notes', 'Shipping notes']);

        fireEvent.click(getAllByRole('button', { name: 'More options: Planning' })[0]);
        fireEvent.click(getAllByRole('menuitem', { name: 'Section notes' })[0]);

        expect(previewTexts(container)).toEqual(['Shipping notes']);
    });
});
