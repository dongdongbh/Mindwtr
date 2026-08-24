import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ComponentProps, RefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import type { Project, Section, Task } from '@mindwtr/core';

import { useUiStore } from '../../../store/ui-store';
import { LanguageProvider } from '../../../contexts/language-context';
import { ProjectWorkspace } from './ProjectWorkspace';

vi.mock('../../TaskItem', () => ({
    TaskItem: ({ task }: { task: Task }) => (
        <div data-task-id={task.id}>
            <button type="button" data-task-view-toggle>{task.title}</button>
        </div>
    ),
}));

// Keeps the sequence cue observable: the real rows pass it to a tinted wrapper.
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
    'projects.sectionEmpty': 'No tasks',
    'projects.sectionNotes': 'Section notes',
    'projects.sectionsLabel': 'Tasks',
    'sort.default': 'Default',
    'sort.label': 'Sort',
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

const renderWorkspace = ({ store = {}, props = {}, layout }: RenderOptions = {}) => {
    storeHolder.current = makeStore(store);
    if (layout) useUiStore.setState({ projectLayouts: { [project.id]: layout } });
    const taskDragEndRef: RefObject<((event: DragEndEvent) => void) | null> = { current: null };
    const utils = render(
        <LanguageProvider>
            <DndContext>
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
            </DndContext>
        </LanguageProvider>
    );
    return { ...utils, taskDragEndRef, store: storeHolder.current as ReturnType<typeof makeStore> };
};

const dragEnd = (activeId: string, overId: string): DragEndEvent => ({
    active: { id: activeId },
    over: { id: overId },
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
        expect(withSections.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
    });

    it('remembers the layout per project as device-local state', () => {
        const { getByRole } = renderWorkspace();

        fireEvent.click(getByRole('button', { name: 'Columns' }));

        expect(useUiStore.getState().projectLayouts).toEqual({ [project.id]: 'columns' });
        expect(window.localStorage.getItem('mindwtr:project-layouts:v1'))
            .toBe(JSON.stringify({ [project.id]: 'columns' }));
        expect(getByRole('button', { name: 'Columns' })).toHaveAttribute('aria-pressed', 'true');
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

        // Empty Shipping section only — the empty No Section column stays hidden
        // outside a drag.
        expect(getAllByText('No tasks')).toHaveLength(1);
        expect(queryByText('No active tasks')).toBeNull();
    });

    // The stacked layout had the same wrong-scope copy before columns existed.
    it('scopes the empty-section copy in the list layout too', () => {
        const { getAllByText, queryByText } = renderWorkspace({
            store: { allTasks: [tasks[0], tasks[1]] },
        });

        // Empty Shipping section only — the empty "No Section" bucket stays
        // hidden outside a drag.
        expect(getAllByText('No tasks')).toHaveLength(1);
        expect(queryByText('No active tasks')).toBeNull();
    });

    it('reorders sections along the column axis with left/right affordances', () => {
        const { getByRole, store } = renderWorkspace({ layout: 'columns' });

        fireEvent.click(getByRole('button', { name: 'Move section left: Shipping' }));

        expect(store.reorderSections).toHaveBeenCalledWith(project.id, [shipping.id, planning.id]);
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
        // The tooltip is plain text: markers would be shown literally there.
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

    // The editor textarea below shows the same text and saves on blur, so a
    // preview left up there would go stale while typing.
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

        fireEvent.click(getAllByRole('button', { name: 'Section notes' })[0]);

        expect(previewTexts(container)).toEqual(['Shipping notes']);
    });
});
