import { useEffect, useMemo, useState, type ComponentProps, type FormEvent } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTaskStore, type Area, type Project, type Task, type TaskStatus } from '@mindwtr/core';
import { describe, expect, it, vi } from 'vitest';

import { getVisibleProjectIds, ProjectsSidebar } from './ProjectsSidebar';
import { getProjectAreaCollapseKey } from './project-area-collapse';
import { KeybindingProvider } from '../../../contexts/keybinding-context';
import { LanguageProvider } from '../../../contexts/language-context';

const now = '2026-04-02T12:00:00.000Z';
const noAreaId = '__no_area__';
const allTagsId = '__all__';
const noTagsId = '__none__';

const translations: Record<string, string> = {
    'common.cancel': 'Cancel',
    'projects.activeSection': 'Active projects',
    'projects.allTags': 'All tags',
    'projects.areaLabel': 'Area',
    'projects.create': 'Create',
    'projects.deferredSection': 'Deferred projects',
    'projects.duplicate': 'Duplicate',
    'projects.addToFocus': 'Add to focus',
    'projects.maxFocusedProjects': 'Max 5 focused projects',
    'projects.noArea': 'No area',
    'projects.noNextAction': 'No next action',
    'projects.new': 'New project',
    'projects.projectName': 'Project name',
    'projects.removeFromFocus': 'Remove from focus',
    'projects.tagFilter': 'Tag filter',
    'projects.title': 'Projects',
    'status.archived': 'Archived',
    'projects.completed': 'Completed',
    'projects.closed': 'Closed',
    'status.waiting': 'Waiting',
};

const t = (key: string) => translations[key] ?? key;

function buildProject(id: string, title: string, order: number): Project {
    return {
        id,
        title,
        status: 'active',
        color: '#22c55e',
        order,
        tagIds: [],
        createdAt: now,
        updatedAt: now,
    };
}

function buildTask(id: string, title: string, status: TaskStatus, projectId: string): Task {
    return {
        id,
        title,
        status,
        projectId,
        tags: [],
        contexts: [],
        createdAt: now,
        updatedAt: now,
    };
}

type ProjectTaskSummary = { activeTaskCount: number; nextAction?: Task; hasWaitingAction?: boolean };


function buildProjectTaskSummaryById(tasksByProject: Record<string, Task[]>): Map<string, ProjectTaskSummary> {
    const summaries = new Map<string, ProjectTaskSummary>();
    for (const [projectId, tasks] of Object.entries(tasksByProject)) {
        summaries.set(projectId, {
            activeTaskCount: tasks.length,
            nextAction: tasks.find((task) => task.status === 'next'),
            hasWaitingAction: tasks.some((task) => task.status === 'waiting'),
        });
    }
    return summaries;
}

function SidebarHarness() {
    const [projects, setProjects] = useState<Project[]>([
        buildProject('project-alpha', 'Alpha', 0),
        buildProject('project-beta', 'Beta', 1),
    ]);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>('project-alpha');
    const selectedProject = useMemo(
        () => projects.find((project) => project.id === selectedProjectId) ?? null,
        [projects, selectedProjectId]
    );
    const [editTitle, setEditTitle] = useState(selectedProject?.title ?? '');

    useEffect(() => {
        setEditTitle(selectedProject?.title ?? '');
    }, [selectedProject?.id, selectedProject?.title]);

    return (
        <div>
            <label>
                Project title
                <input
                    aria-label="Project title"
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    onBlur={() => {
                        if (!selectedProjectId) return;
                        const nextTitle = editTitle.trim();
                        if (!nextTitle) return;
                        setProjects((current) => current.map((project) => (
                            project.id === selectedProjectId
                                ? { ...project, title: nextTitle, updatedAt: now }
                                : project
                        )));
                    }}
                />
            </label>
            <div data-testid="selected-project-id">{selectedProjectId}</div>
            <ProjectsSidebar
                t={t}
                selectedTag={allTagsId}
                noAreaId={noAreaId}
                allTagsId={allTagsId}
                noTagsId={noTagsId}
                tagOptions={{ list: [], hasNoTags: true }}
                isCreating={false}
                isCreatingProject={false}
                newProjectTitle=""
                newProjectAreaId=""
                areaOptions={[]}
                onStartCreate={vi.fn()}
                onCancelCreate={vi.fn()}
                onCreateProject={vi.fn()}
                onChangeNewProjectTitle={vi.fn()}
                onChangeNewProjectAreaId={vi.fn()}
                onSelectTag={vi.fn()}
                groupedActiveProjects={[[noAreaId, projects]]}
                groupedDeferredProjects={[]}
                groupedArchivedProjects={[]}
                areaById={new Map()}
                collapsedAreas={{}}
                onToggleAreaCollapse={vi.fn()}
                showDeferredProjects={false}
                onToggleDeferredProjects={vi.fn()}
                showArchivedProjects={false}
                onToggleArchivedProjects={vi.fn()}
                selectedProjectId={selectedProjectId}
                onSelectProject={setSelectedProjectId}
                getProjectColor={(project) => project.color}
                projectTaskSummaryById={new Map()}
                projects={projects}
                focusedProjectCount={projects.filter((project) => project.isFocused && !project.deletedAt).length}
                toggleProjectFocus={vi.fn()}
                onDuplicateProject={vi.fn()}
                draggingSection={null}
            />
        </div>
    );
}

function renderSidebarWithSpy(
    onSelectProject = vi.fn(),
    projects = [
        buildProject('project-alpha', 'Alpha', 0),
        buildProject('project-beta', 'Beta', 1),
    ],
    projectTaskSummaryById: Map<string, ProjectTaskSummary> = new Map(),
    onActivateProject = vi.fn(),
    tagFilter: Partial<Pick<ComponentProps<typeof ProjectsSidebar>, 'selectedTag' | 'tagOptions'>> = {},
) {

    const renderResult = render(
        <ProjectsSidebar
            t={t}
            selectedTag={tagFilter.selectedTag ?? allTagsId}
            noAreaId={noAreaId}
            allTagsId={allTagsId}
            noTagsId={noTagsId}
            tagOptions={tagFilter.tagOptions ?? { list: [], hasNoTags: true }}
            isCreating={false}
            isCreatingProject={false}
            newProjectTitle=""
            newProjectAreaId=""
            areaOptions={[]}
            onStartCreate={vi.fn()}
            onCancelCreate={vi.fn()}
            onCreateProject={vi.fn()}
            onChangeNewProjectTitle={vi.fn()}
            onChangeNewProjectAreaId={vi.fn()}
            onSelectTag={vi.fn()}
            groupedActiveProjects={[[noAreaId, projects]]}
            groupedDeferredProjects={[]}
            groupedArchivedProjects={[]}
            areaById={new Map()}
            collapsedAreas={{}}
            onToggleAreaCollapse={vi.fn()}
            showDeferredProjects={false}
            onToggleDeferredProjects={vi.fn()}
            showArchivedProjects={false}
            onToggleArchivedProjects={vi.fn()}
            selectedProjectId={'project-alpha'}
            onSelectProject={onSelectProject}
            onActivateProject={onActivateProject}
            getProjectColor={(project) => project.color}
            projectTaskSummaryById={projectTaskSummaryById}
            projects={projects}
            focusedProjectCount={projects.filter((project) => project.isFocused && !project.deletedAt).length}
            toggleProjectFocus={vi.fn()}
            onDuplicateProject={vi.fn()}
            draggingSection={null}
        />
    );

    return { ...renderResult, onActivateProject, onSelectProject };
}

function KeyboardSidebarHarness({
    groupedActiveProjects,
    groupedDeferredProjects = [],
    groupedArchivedProjects = [],
    collapsedAreas = {},
    showDeferredProjects = false,
    showArchivedProjects = false,
    initialSelectedProjectId = null,
}: {
    groupedActiveProjects: Array<[string, Project[]]>;
    groupedDeferredProjects?: Array<[string, Project[]]>;
    groupedArchivedProjects?: Array<[string, Project[]]>;
    collapsedAreas?: Record<string, boolean>;
    showDeferredProjects?: boolean;
    showArchivedProjects?: boolean;
    initialSelectedProjectId?: string | null;
}) {
    const [selectedProjectId, setSelectedProjectId] = useState(initialSelectedProjectId);
    const projects = [
        ...groupedActiveProjects.flatMap(([, areaProjects]) => areaProjects),
        ...groupedDeferredProjects.flatMap(([, areaProjects]) => areaProjects),
        ...groupedArchivedProjects.flatMap(([, areaProjects]) => areaProjects),
    ];

    return (
        <LanguageProvider>
            <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
                <button type="button" data-sidebar-item data-view="projects">Projects nav</button>
                <div data-main-content tabIndex={-1}>
                    Main content
                    <div data-testid="selected-project-id">{selectedProjectId ?? 'none'}</div>
                    <ProjectsSidebar
                    t={t}
                    selectedTag={allTagsId}
                    noAreaId={noAreaId}
                    allTagsId={allTagsId}
                    noTagsId={noTagsId}
                    tagOptions={{ list: [], hasNoTags: true }}
                    isCreating={false}
                    isCreatingProject={false}
                    newProjectTitle=""
                    newProjectAreaId=""
                    areaOptions={[]}
                    onStartCreate={vi.fn()}
                    onCancelCreate={vi.fn()}
                    onCreateProject={vi.fn()}
                    onChangeNewProjectTitle={vi.fn()}
                    onChangeNewProjectAreaId={vi.fn()}
                    onSelectTag={vi.fn()}
                    groupedActiveProjects={groupedActiveProjects}
                    groupedDeferredProjects={groupedDeferredProjects}
                    groupedArchivedProjects={groupedArchivedProjects}
                    areaById={new Map()}
                    collapsedAreas={collapsedAreas}
                    onToggleAreaCollapse={vi.fn()}
                    showDeferredProjects={showDeferredProjects}
                    onToggleDeferredProjects={vi.fn()}
                    showArchivedProjects={showArchivedProjects}
                    onToggleArchivedProjects={vi.fn()}
                    selectedProjectId={selectedProjectId}
                    onSelectProject={setSelectedProjectId}
                    getProjectColor={(project) => project.color}
                    projectTaskSummaryById={new Map()}
                    projects={projects}
                    focusedProjectCount={0}
                    toggleProjectFocus={vi.fn()}
                    onDuplicateProject={vi.fn()}
                    draggingSection={null}
                    />
                    <div data-task-id="task-1">
                        <button type="button" data-task-view-toggle>Task workspace</button>
                    </div>
                </div>
            </KeybindingProvider>
        </LanguageProvider>
    );
}

function RemovableKeyboardSidebarHarness() {
    const alpha = useMemo(() => buildProject('project-alpha', 'Alpha', 0), []);
    const beta = useMemo(() => buildProject('project-beta', 'Beta', 1), []);
    const [projects, setProjects] = useState([alpha, beta]);
    return (
        <>
            <button type="button" onClick={() => setProjects([alpha])}>Remove Beta</button>
            <KeyboardSidebarHarness
                groupedActiveProjects={[[noAreaId, projects]]}
                initialSelectedProjectId="project-beta"
            />
        </>
    );
}

describe('ProjectsSidebar', () => {
    it('keeps the native tag filter quiet while making an active tag clear', () => {
        const firstRender = renderSidebarWithSpy();
        const allTagsFilter = screen.getByRole('combobox', { name: 'Tag filter' });

        expect(allTagsFilter).toHaveClass(
            'appearance-none',
            'bg-transparent',
            'border-border/50',
            'text-muted-foreground',
            'focus-visible:ring-2',
            'focus-visible:ring-primary/40',
        );
        expect(allTagsFilter.closest('[data-project-tag-filter-shell]')).toHaveClass('relative', 'flex-1');

        firstRender.unmount();
        renderSidebarWithSpy(
            vi.fn(),
            undefined,
            undefined,
            vi.fn(),
            { selectedTag: 'admin', tagOptions: { list: ['admin'], hasNoTags: false } },
        );

        expect(screen.getByRole('combobox', { name: 'Tag filter' })).toHaveClass('text-foreground');
    });

    it('reveals focused project creation, submits on Enter, and preserves a cancelled draft', async () => {
        const onCreateProject = vi.fn((event: FormEvent) => event.preventDefault());
        function CreationHarness() {
            const [isCreating, setIsCreating] = useState(false);
            const [draft, setDraft] = useState('');
            return (
                <ProjectsSidebar
                    t={t}
                    selectedTag={allTagsId}
                    noAreaId={noAreaId}
                    allTagsId={allTagsId}
                    noTagsId={noTagsId}
                    tagOptions={{ list: [], hasNoTags: true }}
                    isCreating={isCreating}
                    isCreatingProject={false}
                    newProjectTitle={draft}
                    newProjectAreaId=""
                    areaOptions={[]}
                    onStartCreate={() => setIsCreating(true)}
                    onCancelCreate={() => setIsCreating(false)}
                    onCreateProject={onCreateProject}
                    onChangeNewProjectTitle={setDraft}
                    onChangeNewProjectAreaId={vi.fn()}
                    onSelectTag={vi.fn()}
                    groupedActiveProjects={[[noAreaId, [buildProject('project-alpha', 'Alpha', 0)]]]}
                    groupedDeferredProjects={[]}
                    groupedArchivedProjects={[]}
                    areaById={new Map()}
                    collapsedAreas={{}}
                    onToggleAreaCollapse={vi.fn()}
                    showDeferredProjects={false}
                    onToggleDeferredProjects={vi.fn()}
                    showArchivedProjects={false}
                    onToggleArchivedProjects={vi.fn()}
                    selectedProjectId={null}
                    onSelectProject={vi.fn()}
                    getProjectColor={(project) => project.color}
                    projectTaskSummaryById={new Map()}
                    projects={[buildProject('project-alpha', 'Alpha', 0)]}
                    focusedProjectCount={0}
                    toggleProjectFocus={vi.fn()}
                    onDuplicateProject={vi.fn()}
                    draggingSection={null}
                />
            );
        }

        render(<CreationHarness />);
        expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();

        const createButton = screen.getByRole('button', { name: 'New project' });
        expect(document.querySelector('[data-projects-sidebar-header]')).toContainElement(createButton);
        expect(createButton).not.toHaveClass('w-full');
        fireEvent.click(createButton);
        const projectName = screen.getByLabelText('Project name');
        await waitFor(() => expect(projectName).toHaveFocus());
        fireEvent.change(projectName, { target: { value: 'Preserved draft' } });
        fireEvent.keyDown(projectName, { key: 'Escape' });
        expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'New project' }));
        const restoredProjectName = screen.getByLabelText('Project name');
        expect(restoredProjectName).toHaveValue('Preserved draft');
        fireEvent.keyDown(restoredProjectName, { key: 'Enter' });
        expect(onCreateProject).toHaveBeenCalledTimes(1);
    });

    it('lets the user pick an area while creating a project', () => {
        const onChangeNewProjectAreaId = vi.fn();
        const areas: Area[] = [
            { id: 'area-work', name: 'Work', order: 0, createdAt: now, updatedAt: now },
            { id: 'area-home', name: 'Home', order: 1, createdAt: now, updatedAt: now },
        ];

        render(
            <ProjectsSidebar
                t={t}
                selectedTag={allTagsId}
                noAreaId={noAreaId}
                allTagsId={allTagsId}
                noTagsId={noTagsId}
                tagOptions={{ list: [], hasNoTags: true }}
                isCreating={true}
                isCreatingProject={false}
                newProjectTitle=""
                newProjectAreaId=""
                areaOptions={areas}
                onStartCreate={vi.fn()}
                onCancelCreate={vi.fn()}
                onCreateProject={vi.fn((event: FormEvent) => event.preventDefault())}
                onChangeNewProjectTitle={vi.fn()}
                onChangeNewProjectAreaId={onChangeNewProjectAreaId}
                onSelectTag={vi.fn()}
                groupedActiveProjects={[]}
                groupedDeferredProjects={[]}
                groupedArchivedProjects={[]}
                areaById={new Map(areas.map((area) => [area.id, area]))}
                collapsedAreas={{}}
                onToggleAreaCollapse={vi.fn()}
                showDeferredProjects={false}
                onToggleDeferredProjects={vi.fn()}
                showArchivedProjects={false}
                onToggleArchivedProjects={vi.fn()}
                selectedProjectId={null}
                onSelectProject={vi.fn()}
                getProjectColor={(project) => project.color}
                projectTaskSummaryById={new Map()}
                projects={[]}
                focusedProjectCount={0}
                toggleProjectFocus={vi.fn()}
                onDuplicateProject={vi.fn()}
                draggingSection={null}
            />
        );

        const areaSelect = screen.getByLabelText('Area');
        expect(areaSelect).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'No area' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument();

        fireEvent.change(areaSelect, { target: { value: 'area-home' } });
        expect(onChangeNewProjectAreaId).toHaveBeenCalledWith('area-home');
    });

    it('hides the area picker while creating when no areas exist', () => {
        renderSidebarWithSpy();

        expect(screen.queryByLabelText('Area')).not.toBeInTheDocument();
    });

    it('keeps no-next warnings but removes task previews from compact project rows', () => {
        const focusedWithoutNext = { ...buildProject('focused-inbox', 'Focused inbox', 0), isFocused: true };
        const unfocusedWithoutNext = buildProject('unfocused-inbox', 'Unfocused inbox', 1);
        const focusedWithNext = { ...buildProject('focused-next', 'Focused next', 2), isFocused: true };

        renderSidebarWithSpy(
            vi.fn(),
            [focusedWithoutNext, unfocusedWithoutNext, focusedWithNext],
            buildProjectTaskSummaryById({
                'focused-inbox': [buildTask('inbox-focused', 'Focused inbox task', 'inbox', 'focused-inbox')],
                'unfocused-inbox': [buildTask('inbox-unfocused', 'Unfocused inbox task', 'inbox', 'unfocused-inbox')],
                'focused-next': [buildTask('next-focused', 'Focused next task', 'next', 'focused-next')],
            })
        );

        expect(screen.getAllByText('No next action')).toHaveLength(1);
        expect(screen.queryByText('Focused inbox task')).not.toBeInTheDocument();
        expect(screen.queryByText('Unfocused inbox task')).not.toBeInTheDocument();
        expect(screen.queryByText('Focused next task')).not.toBeInTheDocument();
    });

    it('warns for an empty focused project but not a waiting-only one (#1307)', () => {
        const empty = { ...buildProject('empty', 'Empty', 0), isFocused: true };
        const waiting = { ...buildProject('waiting', 'Waiting project', 1), isFocused: true };
        renderSidebarWithSpy(vi.fn(), [empty, waiting], buildProjectTaskSummaryById({
            waiting: [buildTask('waiting-task', 'Waiting task', 'waiting', 'waiting')],
        }));
        expect(screen.getAllByText('No next action')).toHaveLength(1);
        expect(screen.getByText('No next action').closest('[data-project-id]')).toHaveAttribute('data-project-id', 'empty');
    });

    it('reveals idle row controls on hover or focus while keeping focused stars visible', () => {
        const focused = { ...buildProject('focused', 'Focused', 0), isFocused: true };
        const idle = buildProject('idle', 'Idle', 1);
        renderSidebarWithSpy(vi.fn(), [focused, idle]);

        const dragControl = screen.getAllByTitle('Drag')[0].parentElement;
        const idleStar = screen.getByLabelText('Add to focus');
        const focusedStar = screen.getByLabelText('Remove from focus');

        expect(dragControl).toHaveClass('absolute', 'opacity-0', 'group-hover:opacity-100', 'group-focus-within:opacity-100', '[@media(hover:none)]:opacity-100');
        expect(idleStar).toHaveClass('opacity-0', 'group-hover:opacity-100', 'group-focus-within:opacity-100', '[@media(hover:none)]:opacity-100');
        expect(focusedStar).not.toHaveClass('opacity-0');
    });

    it('aligns every project row on the same leading icon slot without a focused-row tint', () => {
        const active = { ...buildProject('active', 'Active', 0), isFocused: true };
        const deferred = { ...buildProject('deferred', 'Deferred', 1), status: 'waiting' as const };
        const archived = { ...buildProject('archived', 'Archived', 2), status: 'archived' as const };

        render(
            <ProjectsSidebar
                t={t}
                selectedTag={allTagsId}
                noAreaId={noAreaId}
                allTagsId={allTagsId}
                noTagsId={noTagsId}
                tagOptions={{ list: [], hasNoTags: false }}
                isCreating={false}
                isCreatingProject={false}
                newProjectTitle=""
                newProjectAreaId=""
                areaOptions={[]}
                onStartCreate={vi.fn()}
                onCancelCreate={vi.fn()}
                onCreateProject={vi.fn()}
                onChangeNewProjectTitle={vi.fn()}
                onChangeNewProjectAreaId={vi.fn()}
                onSelectTag={vi.fn()}
                groupedActiveProjects={[[noAreaId, [active]]]}
                groupedDeferredProjects={[[noAreaId, [deferred]]]}
                groupedArchivedProjects={[[noAreaId, [archived]]]}
                areaById={new Map()}
                collapsedAreas={{}}
                onToggleAreaCollapse={vi.fn()}
                showDeferredProjects
                onToggleDeferredProjects={vi.fn()}
                showArchivedProjects
                onToggleArchivedProjects={vi.fn()}
                selectedProjectId={null}
                onSelectProject={vi.fn()}
                getProjectColor={(project) => project.color}
                projectTaskSummaryById={new Map()}
                projects={[active, deferred, archived]}
                focusedProjectCount={1}
                toggleProjectFocus={vi.fn()}
                onDuplicateProject={vi.fn()}
                draggingSection={null}
            />,
        );

        const leadingSlots = ['active', 'deferred', 'archived'].map((id) => (
            document.querySelector(`[data-project-id="${id}"] [data-project-leading-icon]`)
        ));
        leadingSlots.forEach((slot) => expect(slot).toHaveClass('h-8', 'w-8', 'flex-none'));
        expect(document.querySelector('[data-project-id="active"]')).not.toHaveClass('bg-warning/10');
    });

    it('selects a project on primary mouse down so blur-driven rerenders cannot swallow the switch', () => {
        const { onActivateProject, onSelectProject } = renderSidebarWithSpy();

        fireEvent.mouseDown(screen.getByText('Beta'), { button: 0 });

        expect(onSelectProject).toHaveBeenCalledWith('project-beta');
        expect(onActivateProject).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('Beta'));
        expect(onActivateProject).toHaveBeenCalledWith('project-beta');
    });

    it('does not select a project when clicking its drag handle', () => {
        const { onSelectProject } = renderSidebarWithSpy();

        fireEvent.click(screen.getAllByTitle('Drag')[0]);

        expect(onSelectProject).not.toHaveBeenCalled();
    });

    it('does not select a project when pressing its focus toggle', () => {
        const { onSelectProject } = renderSidebarWithSpy();

        fireEvent.mouseDown(screen.getAllByLabelText('Add to focus')[0], { button: 0 });

        expect(onSelectProject).not.toHaveBeenCalled();
    });

    it('keeps project rows in the Tab order and activates them with Enter or Space', async () => {
        const user = userEvent.setup();
        const { onActivateProject, onSelectProject } = renderSidebarWithSpy();
        const areaToggle = screen.getByRole('button', { name: 'No area' });
        const alphaRow = document.querySelector('[data-project-id="project-alpha"]') as HTMLElement;
        const betaRow = document.querySelector('[data-project-id="project-beta"]') as HTMLElement;

        areaToggle.focus();
        await user.tab();
        expect(document.activeElement).toBe(alphaRow);

        onSelectProject.mockClear();
        fireEvent.keyDown(alphaRow, { key: 'Enter' });
        expect(onSelectProject).toHaveBeenCalledWith('project-alpha');
        expect(onActivateProject).toHaveBeenCalledWith('project-alpha');

        betaRow.focus();
        onSelectProject.mockClear();
        onActivateProject.mockClear();
        fireEvent.keyDown(betaRow, { key: ' ' });
        expect(onSelectProject).toHaveBeenCalledWith('project-beta');
        expect(onActivateProject).toHaveBeenCalledWith('project-beta');
    });

    it('moves selection and focus through real project rows, then enters the task workspace', () => {
        useTaskStore.setState((state) => ({
            settings: { ...state.settings, keybindingStyle: 'vim' },
        }));
        const alpha = buildProject('project-alpha', 'Alpha', 0);
        const beta = buildProject('project-beta', 'Beta', 1);
        render(
            <KeyboardSidebarHarness
                groupedActiveProjects={[[noAreaId, [alpha, beta]]]}
                initialSelectedProjectId="project-beta"
            />
        );

        const main = document.querySelector('[data-main-content]') as HTMLElement;
        const alphaRow = document.querySelector('[data-project-id="project-alpha"]') as HTMLElement;
        const betaRow = document.querySelector('[data-project-id="project-beta"]') as HTMLElement;
        main.focus();
        fireEvent.keyDown(window, { key: 'l' });
        expect(document.activeElement).toBe(betaRow);

        fireEvent.keyDown(window, { key: 'ArrowUp' });
        expect(document.activeElement).toBe(alphaRow);
        expect(screen.getByTestId('selected-project-id')).toHaveTextContent('project-alpha');

        fireEvent.keyDown(window, { key: 'j' });
        expect(document.activeElement).toBe(betaRow);
        fireEvent.keyDown(window, { key: 'k' });
        expect(document.activeElement).toBe(alphaRow);

        fireEvent.keyDown(window, { key: 'h' });
        expect(document.activeElement).toBe(document.querySelector('[data-sidebar-item]'));
        fireEvent.keyDown(window, { key: 'l' });
        expect(document.activeElement).toBe(alphaRow);

        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(document.querySelector('[data-task-view-toggle]'));
    });

    it('enters the first expanded visible project and ignores collapsed or hidden sections', () => {
        useTaskStore.setState((state) => ({
            settings: { ...state.settings, keybindingStyle: 'vim' },
        }));
        const activeHidden = buildProject('active-hidden', 'Active hidden', 0);
        const activeVisible = buildProject('active-visible', 'Active visible', 1);
        const deferredHidden = { ...buildProject('deferred-hidden', 'Deferred hidden', 2), status: 'waiting' as const };
        render(
            <KeyboardSidebarHarness
                groupedActiveProjects={[
                    ['area-collapsed', [activeHidden]],
                    ['area-visible', [activeVisible]],
                ]}
                groupedDeferredProjects={[[noAreaId, [deferredHidden]]]}
                collapsedAreas={{ [getProjectAreaCollapseKey('active', 'area-collapsed')]: true }}
                initialSelectedProjectId="active-hidden"
            />
        );

        const main = document.querySelector('[data-main-content]') as HTMLElement;
        main.focus();
        fireEvent.keyDown(window, { key: 'ArrowRight' });

        expect(document.activeElement).toBe(document.querySelector('[data-project-id="active-visible"]'));
        expect(screen.getByTestId('selected-project-id')).toHaveTextContent('active-visible');
        expect(document.querySelector('[data-project-id="active-hidden"]')).toBeNull();
        expect(document.querySelector('[data-project-id="deferred-hidden"]')).toBeNull();
    });

    it('keeps neutral main-content focus when the visible project list is empty', () => {
        useTaskStore.setState((state) => ({
            settings: { ...state.settings, keybindingStyle: 'vim' },
        }));
        render(<KeyboardSidebarHarness groupedActiveProjects={[]} />);

        const main = document.querySelector('[data-main-content]') as HTMLElement;
        main.focus();
        fireEvent.keyDown(window, { key: 'ArrowRight' });

        expect(document.activeElement).toBe(main);
        expect(screen.getByTestId('selected-project-id')).toHaveTextContent('none');
    });

    it('keeps project focus on a sensible visible fallback when the focused row is removed', async () => {
        useTaskStore.setState((state) => ({
            settings: { ...state.settings, keybindingStyle: 'vim' },
        }));
        render(<RemovableKeyboardSidebarHarness />);

        const main = document.querySelector('[data-main-content]') as HTMLElement;
        main.focus();
        fireEvent.keyDown(window, { key: 'l' });
        expect(document.activeElement).toBe(document.querySelector('[data-project-id="project-beta"]'));

        fireEvent.click(screen.getByRole('button', { name: 'Remove Beta' }));

        await waitFor(() => {
            expect(document.activeElement).toBe(document.querySelector('[data-project-id="project-alpha"]'));
            expect(screen.getByTestId('selected-project-id')).toHaveTextContent('project-alpha');
        });
    });

    it('derives navigation order only from expanded, visible project groups', () => {
        const activeHidden = buildProject('active-hidden', 'Active hidden', 0);
        const activeVisible = buildProject('active-visible', 'Active visible', 1);
        const deferredHidden = { ...buildProject('deferred-hidden', 'Deferred hidden', 2), status: 'waiting' as const };
        const archivedVisible = { ...buildProject('archived-visible', 'Archived visible', 3), status: 'archived' as const };

        expect(getVisibleProjectIds({
            groupedActiveProjects: [
                ['area-collapsed', [activeHidden]],
                ['area-visible', [activeVisible]],
            ],
            groupedDeferredProjects: [[noAreaId, [deferredHidden]]],
            groupedArchivedProjects: [[noAreaId, [archivedVisible]]],
            collapsedAreas: { [getProjectAreaCollapseKey('active', 'area-collapsed')]: true },
            showDeferredProjects: false,
            showArchivedProjects: true,
        })).toEqual(['active-visible', 'archived-visible']);
    });

    it('returns an empty navigation order when filters leave no visible project rows', () => {
        expect(getVisibleProjectIds({
            groupedActiveProjects: [],
            groupedDeferredProjects: [],
            groupedArchivedProjects: [],
            collapsedAreas: {},
            showDeferredProjects: false,
            showArchivedProjects: false,
        })).toEqual([]);
    });

    it('exposes the full project title as a hover tooltip for truncated rows', () => {
        const longTitle = 'An unusually long project title that needs more room in the sidebar';

        render(
            <ProjectsSidebar
                t={t}
                selectedTag={allTagsId}
                noAreaId={noAreaId}
                allTagsId={allTagsId}
                noTagsId={noTagsId}
                tagOptions={{ list: [], hasNoTags: true }}
                isCreating={false}
                isCreatingProject={false}
                newProjectTitle=""
                newProjectAreaId=""
                areaOptions={[]}
                onStartCreate={vi.fn()}
                onCancelCreate={vi.fn()}
                onCreateProject={vi.fn()}
                onChangeNewProjectTitle={vi.fn()}
                onChangeNewProjectAreaId={vi.fn()}
                onSelectTag={vi.fn()}
                groupedActiveProjects={[[noAreaId, [buildProject('project-long', longTitle, 0)]]]}
                groupedDeferredProjects={[]}
                groupedArchivedProjects={[]}
                areaById={new Map()}
                collapsedAreas={{}}
                onToggleAreaCollapse={vi.fn()}
                showDeferredProjects={false}
                onToggleDeferredProjects={vi.fn()}
                showArchivedProjects={false}
                onToggleArchivedProjects={vi.fn()}
                selectedProjectId={null}
                onSelectProject={vi.fn()}
                getProjectColor={(project) => project.color}
                projectTaskSummaryById={new Map()}
                projects={[buildProject('project-long', longTitle, 0)]}
                focusedProjectCount={0}
                toggleProjectFocus={vi.fn()}
                onDuplicateProject={vi.fn()}
                draggingSection={null}
            />
        );

        expect(screen.getByText(longTitle)).toHaveAttribute('title', longTitle);
    });

    it('switches projects with one click while the current title input blurs and rerenders', async () => {
        const user = userEvent.setup();

        render(<SidebarHarness />);

        const titleInput = screen.getByLabelText('Project title');
        await user.clear(titleInput);
        await user.type(titleInput, 'Alpha updated');
        await user.click(screen.getByText('Beta'));

        await waitFor(() => {
            expect(screen.getByTestId('selected-project-id')).toHaveTextContent('project-beta');
        });

        expect(screen.getByText('Alpha updated')).toBeInTheDocument();
    });

    it('renders archived projects in a separate archived section', () => {
        const waitingProject = { ...buildProject('project-waiting', 'Waiting Project', 0), status: 'waiting' as const };
        const archivedProject = { ...buildProject('project-archived', 'Archived Project', 1), status: 'archived' as const };

        render(
            <ProjectsSidebar
                t={t}
                selectedTag={allTagsId}
                noAreaId={noAreaId}
                allTagsId={allTagsId}
                noTagsId={noTagsId}
                tagOptions={{ list: [], hasNoTags: true }}
                isCreating={false}
                isCreatingProject={false}
                newProjectTitle=""
                newProjectAreaId=""
                areaOptions={[]}
                onStartCreate={vi.fn()}
                onCancelCreate={vi.fn()}
                onCreateProject={vi.fn()}
                onChangeNewProjectTitle={vi.fn()}
                onChangeNewProjectAreaId={vi.fn()}
                onSelectTag={vi.fn()}
                groupedActiveProjects={[]}
                groupedDeferredProjects={[[noAreaId, [waitingProject]]]}
                groupedArchivedProjects={[[noAreaId, [archivedProject]]]}
                areaById={new Map()}
                collapsedAreas={{}}
                onToggleAreaCollapse={vi.fn()}
                showDeferredProjects={true}
                onToggleDeferredProjects={vi.fn()}
                showArchivedProjects={true}
                onToggleArchivedProjects={vi.fn()}
                selectedProjectId={null}
                onSelectProject={vi.fn()}
                getProjectColor={(project) => project.color}
                projectTaskSummaryById={new Map()}
                projects={[waitingProject, archivedProject]}
                focusedProjectCount={0}
                toggleProjectFocus={vi.fn()}
                onDuplicateProject={vi.fn()}
                draggingSection={null}
            />
        );

        const deferredToggle = screen.getByRole('button', { name: 'Deferred projects' });
        const deferredSection = deferredToggle.parentElement;
        const archivedToggle = screen.getByRole('button', { name: 'Closed' });
        const archivedSection = archivedToggle.parentElement;

        expect(deferredSection).not.toBeNull();
        expect(archivedSection).not.toBeNull();
        expect(deferredSection).not.toBe(archivedSection);
        expect(deferredSection).toHaveTextContent('Waiting Project');
        expect(deferredSection).not.toHaveTextContent('Archived Project');
        expect(archivedSection).toHaveTextContent('Archived Project');
    });

    it('collapses matching areas independently across project sections', () => {
        const areaId = 'area-1';
        const activeProject = { ...buildProject('project-active', 'Active Project', 0), areaId };
        const waitingProject = { ...buildProject('project-waiting', 'Waiting Project', 1), areaId, status: 'waiting' as const };

        render(
            <ProjectsSidebar
                t={t}
                selectedTag={allTagsId}
                noAreaId={noAreaId}
                allTagsId={allTagsId}
                noTagsId={noTagsId}
                tagOptions={{ list: [], hasNoTags: true }}
                isCreating={false}
                isCreatingProject={false}
                newProjectTitle=""
                newProjectAreaId=""
                areaOptions={[]}
                onStartCreate={vi.fn()}
                onCancelCreate={vi.fn()}
                onCreateProject={vi.fn()}
                onChangeNewProjectTitle={vi.fn()}
                onChangeNewProjectAreaId={vi.fn()}
                onSelectTag={vi.fn()}
                groupedActiveProjects={[[areaId, [activeProject]]]}
                groupedDeferredProjects={[[areaId, [waitingProject]]]}
                groupedArchivedProjects={[]}
                areaById={new Map([[areaId, { id: areaId, name: 'Test area', color: '#3b82f6', order: 0, createdAt: now, updatedAt: now }]])}
                collapsedAreas={{ [getProjectAreaCollapseKey('active', areaId)]: true }}
                onToggleAreaCollapse={vi.fn()}
                showDeferredProjects={true}
                onToggleDeferredProjects={vi.fn()}
                showArchivedProjects={false}
                onToggleArchivedProjects={vi.fn()}
                selectedProjectId={null}
                onSelectProject={vi.fn()}
                getProjectColor={(project) => project.color}
                projectTaskSummaryById={new Map()}
                projects={[activeProject, waitingProject]}
                focusedProjectCount={0}
                toggleProjectFocus={vi.fn()}
                onDuplicateProject={vi.fn()}
                draggingSection={null}
            />
        );

        expect(screen.queryByText('Active Project')).not.toBeInTheDocument();
        expect(screen.getByText('Waiting Project')).toBeInTheDocument();
    });
});
