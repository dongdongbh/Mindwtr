import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildProjectTaskListModel,
    getProjectDetailTaskListOptions,
    selectProjectTaskListTasks,
    type ProjectTaskListItem,
    type ProjectTaskListModelInput,
} from './project-task-list-model';
import { getProjectSectionsForView, getSequentialProjectTaskCues } from './project-utils';
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
    const cues = scenario.sortBy === 'default'
        ? getSequentialProjectTaskCues(project, projectTasks, getProjectSectionsForView(project, visibleSections, fixture.sections))
        : new Map();
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
    it.each(fixture.scenarios.map((item) => [item.name, item] as const))(
        'matches the frozen list with the #1401 reference-sort correction: %s',
        (name, item) => {
            const { model, cues } = buildLikeMobile(item);
            // Keep the historical fixture intact; #1401 deliberately corrects only
            // the title-sorted Reference pile (Loose reading precedes Style guide).
            const expected = name === 'live-sorted-title'
                ? fixture.mobileSnapshot[name].map((row) => {
                    const item = row as { id?: string };
                    if (item.id === 'live-ref') return { ...item, id: 'loose-ref-tag' };
                    if (item.id === 'loose-ref-tag') return { ...item, id: 'live-ref' };
                    return row;
                })
                : fixture.mobileSnapshot[name];
            expect(shape(model.items, cues)).toEqual(expected);
        },
    );

    it('keeps empty sections as drop targets and hides the Reference pile in reorder mode', () => {
        const { model } = buildLikeMobile(scenario('live-default'), { reorderMode: true });
        const sectionIds = model.items.flatMap((item) => (item.type === 'section' ? [item.id] : []));
        expect(sectionIds).toEqual(['sec-a', 'sec-empty', 'sec-b', 'no-section']);
        expect(model.sections.map(({ id }) => id)).toEqual(['sec-a', 'sec-empty', 'sec-b']);
    });

    it('allocates synthetic IDs around real stored section IDs without changing those IDs', () => {
        const base = buildLikeMobile(scenario('live-default'));
        const project = fixture.projects.find(({ id }) => id === 'p-live')!;
        const collisions = ['no-section', 'project-completed-tasks', 'project-reference-tasks'];
        const sections = collisions.map((id, order): Section => ({ ...visibleSections[0], id, projectId: project.id, order }));
        const real = fixture.tasks.find((row) => row.projectId === project.id && !row.deletedAt)!;
        const loose = { ...real, id: 'collision-loose', sectionId: undefined, status: 'next' as const };
        const done = { ...real, id: 'collision-done', sectionId: undefined, status: 'done' as const };
        const ref = { ...real, id: 'collision-ref', sectionId: undefined, status: 'reference' as const };
        const model = buildLikeMobile(scenario('live-default'), {
            sections, allSections: sections,
            tasks: [{ ...real, id: 'collision-real', sectionId: 'no-section', status: 'next' }, loose, done],
            visibleTasks: [ref], groupCompletedTasksLast: true, completedCollapsed: false,
        }).model;
        expect(base.model.items.length).toBeGreaterThan(0);
        expect(model.sections.map((row) => row.id)).toEqual(collisions);
        expect(model.items.flatMap((item) => item.type === 'section' ? [[item.id, item.synthetic ?? 'real']] : []))
            .toEqual([['no-section', 'real'], ['no-section:1', 'none'],
                ['project-completed-tasks:1', 'completed'], ['project-reference-tasks:1', 'reference']]);
    });

    it.each([
        ['default', ['ref-z', 'ref-a', 'ref-m']],
        ['title', ['ref-a', 'ref-m', 'ref-z']],
        ['due', ['ref-m', 'ref-z', 'ref-a']],
    ] as const)('applies %s sort to direct and tag-matched references without changing stored order', (sortBy, expected) => {
        const base = fixture.tasks.find((task) => task.status === 'reference')!;
        const references: Task[] = [
            { ...base, id: 'ref-z', title: 'Zulu', status: 'reference', projectId: 'p-live', tags: [], order: 1, dueDate: '2026-10-20' },
            { ...base, id: 'ref-a', title: 'Alpha', status: 'reference', projectId: 'p-live', tags: [], order: 2, dueDate: '2026-10-21' },
            { ...base, id: 'ref-m', title: 'Mike', status: 'reference', projectId: 'other', tags: ['shared'], order: 3, dueDate: '2026-10-19' },
        ];
        const visibleTasks = [
            ...references,
            { ...references[0], id: 'excluded', projectId: 'other' },
            { ...references[1], id: 'deleted', deletedAt: '2026-10-18T00:00:00Z' },
        ];
        const before = JSON.stringify(visibleTasks);
        const { model } = buildLikeMobile(scenario('live-default'), {
            project: { id: 'p-live', status: 'active', tagIds: ['shared'] },
            visibleTasks, sortBy,
        });
        const referenceRows = model.items.flatMap((item) => item.type === 'task' && item.task.status === 'reference' ? [item.task.id] : []);
        expect(referenceRows).toEqual(expected);
        expect(JSON.stringify(visibleTasks)).toBe(before);
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
