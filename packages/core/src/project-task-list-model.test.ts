import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildProjectTaskListModel,
    getProjectDetailTaskListOptions,
    selectProjectTaskListTasks,
    type ProjectTaskListItem,
    type ProjectTaskListModelInput,
} from './project-task-list-model';
import { getSequentialProjectTaskCues } from './project-utils';
import { selectVisibleTasks } from './store-helpers';
import type { Project, Section, Task, TaskSortBy } from './types';

type Scenario = { name: string; projectId: string; showCompletedTasks: boolean; sortBy: TaskSortBy; expandCompleted?: boolean };
const fixture = JSON.parse(
    readFileSync(new URL('./project-task-list-parity.fixtures.json', import.meta.url), 'utf8'),
) as {
    projects: Project[];
    sections: Section[];
    tasks: Task[];
    translations: Record<string, string>;
    scenarios: Scenario[];
    mobileSnapshot: Record<string, unknown[]>;
};
const t = (key: string) => fixture.translations[key] ?? key;
const visibleSections = fixture.sections.filter((section) => !section.deletedAt);

/** The mobile project workspace defaults (ProjectDetailModal -> ProjectTaskList -> TaskList), through core. */
const buildLikeMobile = (scenario: Scenario, overrides: Partial<ProjectTaskListModelInput> = {}) => {
    const project = fixture.projects.find(({ id }) => id === scenario.projectId)!;
    const options = getProjectDetailTaskListOptions(project, scenario.showCompletedTasks);
    const projectTasks = fixture.tasks.filter((task) => task.projectId === project.id && !task.deletedAt);
    const model = buildProjectTaskListModel({
        project: { id: project.id, status: options.readOnly ? 'archived' : 'active', tagIds: project.tagIds },
        tasks: selectProjectTaskListTasks(projectTasks, {
            projectId: project.id,
            statusFilter: 'all',
            includeArchived: options.includeArchived,
            includeDone: options.includeDone,
        }),
        visibleTasks: selectVisibleTasks(fixture.tasks),
        sections: visibleSections,
        allSections: fixture.sections,
        statusFilter: 'all',
        criteria: {},
        searchQuery: '',
        sortBy: scenario.sortBy,
        projectOrder: options.enableProjectReorder,
        reorderMode: false,
        groupCompletedTasksLast: options.groupCompletedTasksLast,
        completedCollapsed: !scenario.expandCompleted,
        t,
        ...overrides,
    });
    const cues = scenario.sortBy === 'default' ? getSequentialProjectTaskCues(project, projectTasks) : new Map();
    return { model, cues };
};

const shape = (items: ProjectTaskListItem[], cues: Map<string, string>) => items.map((item) => (item.type === 'section'
    ? {
        type: 'section', id: item.id, title: item.title, count: item.count,
        muted: item.muted ?? null, collapsible: item.collapsible ?? null, collapsed: item.collapsed ?? null,
    }
    : {
        type: 'task', id: item.task.id,
        reorderSectionId: item.reorderSectionId === undefined ? 'undefined' : item.reorderSectionId,
        sequenceCue: cues.get(item.task.id) ?? null,
    }));

const scenario = (name: string) => fixture.scenarios.find((candidate) => candidate.name === name)!;

describe('project task list model', () => {
    it.each(fixture.scenarios.filter((item) => item.sortBy !== 'default').map((item) => [item.name, item] as const))(
        'matches sorted project views: %s',
        (name, item) => {
            const { model, cues } = buildLikeMobile(item);
            expect(shape(model.items, cues)).toEqual(fixture.mobileSnapshot[name]);
        },
    );

    it('uses shared status order in normal project browsing', () => {
        const { model } = buildLikeMobile(scenario('live-default'));
        expect(model.orderedTasks.map((task) => task.status)).toEqual([
            'next', 'next', 'next', 'next', 'next', 'next', 'next', 'waiting', 'someday',
        ]);
    });

    it('keeps manual order while explicitly reordering', () => {
        const { model } = buildLikeMobile(scenario('live-default'), { reorderMode: true });
        const sectionIds = model.items.flatMap((item) => (item.type === 'section' ? [item.id] : []));
        expect(sectionIds).toEqual(['sec-a', 'sec-empty', 'sec-b', 'no-section']);
        expect(model.sections.map(({ id }) => id)).toEqual(['sec-a', 'sec-empty', 'sec-b']);
    });

    it('applies the search box to the list and the Reference pile alike', () => {
        const { model } = buildLikeMobile(scenario('live-default'), { searchQuery: 'guide' });
        expect(model.items.map((item) => (item.type === 'section' ? `#${item.id}` : item.task.id)))
            .toEqual(['#project-reference-tasks', 'live-ref']);
        expect(model.orderedTasks).toEqual([]);
    });

    it('keeps only the requested status and the caller visibility rule', () => {
        const projectTasks = fixture.tasks.filter((task) => task.projectId === 'p-live');
        const ids = (tasks: Task[]) => tasks.map(({ id }) => id).sort();
        expect(ids(selectProjectTaskListTasks(projectTasks, {
            projectId: 'p-live', statusFilter: 'waiting', includeArchived: true, includeDone: true,
        }))).toEqual(['live-a2']);
        expect(ids(selectProjectTaskListTasks(projectTasks, {
            projectId: 'p-live', statusFilter: 'all', includeArchived: false, includeDone: false,
            isVisible: (task) => task.sectionId !== 'sec-a',
        }))).toEqual(['live-b1', 'live-deleted-sec', 'live-missing', 'live-someday', 'live-tie-x', 'live-tie-y', 'live-u1']);
    });
});
