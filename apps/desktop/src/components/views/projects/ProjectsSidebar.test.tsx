import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Area, Project, Task, TaskStatus } from '@mindwtr/core';
import { describe, expect, it, vi } from 'vitest';

import { ProjectsSidebar } from './ProjectsSidebar';
import { getProjectAreaCollapseKey } from './project-area-collapse';

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
    'projects.projectName': 'Project name',
    'projects.removeFromFocus': 'Remove from focus',
    'projects.tagFilter': 'Tag filter',
    'projects.title': 'Projects',
    'status.archived': 'Archived',
    'projects.completed': 'Completed',
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

type ProjectTaskSummary = { activeTaskCount: number; nextAction?: Task };

// Mirrors core's projectTaskSummaryById shape (store-helpers.ts computeTaskDerivedState):
// one open-task count and lowest-order 'next' task per project.
function buildProjectTaskSummaryById(tasksByProject: Record<string, Task[]>): Map<string, ProjectTaskSummary> {
    const summaries = new Map<string, ProjectTaskSummary>();
    for (const [projectId, tasks] of Object.entries(tasksByProject)) {
        summaries.set(projectId, {
            activeTaskCount: tasks.length,
            nextAction: tasks.find((task) => task.status === 'next'),
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
    projectTaskSummaryById: Map<string, ProjectTaskSummary> = new Map()
) {

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
            getProjectColor={(project) => project.color}
            projectTaskSummaryById={projectTaskSummaryById}
            projects={projects}
            focusedProjectCount={projects.filter((project) => project.isFocused && !project.deletedAt).length}
            toggleProjectFocus={vi.fn()}
            onDuplicateProject={vi.fn()}
            draggingSection={null}
        />
    );

    return { onSelectProject };
}

describe('ProjectsSidebar', () => {
    it('keeps project creation visible as an inline field below the filters', () => {
        const onCreateProject = vi.fn((event: FormEvent) => event.preventDefault());
        const onChangeNewProjectTitle = vi.fn();

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
                onCreateProject={onCreateProject}
                onChangeNewProjectTitle={onChangeNewProjectTitle}
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

        const projectName = screen.getByLabelText('Project name');

        expect(projectName).toBeInTheDocument();

        fireEvent.change(projectName, { target: { value: 'New project' } });
        expect(onChangeNewProjectTitle).toHaveBeenCalledWith('New project');
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

    it('only warns focused projects and only displays tasks with next status', () => {
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
        expect(screen.getByText('Focused next task')).toBeInTheDocument();
    });

    it('selects a project on primary mouse down so blur-driven rerenders cannot swallow the switch', () => {
        const { onSelectProject } = renderSidebarWithSpy();

        fireEvent.mouseDown(screen.getByText('Beta'), { button: 0 });

        expect(onSelectProject).toHaveBeenCalledWith('project-beta');
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
        const archivedToggle = screen.getByRole('button', { name: 'Completed' });
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
