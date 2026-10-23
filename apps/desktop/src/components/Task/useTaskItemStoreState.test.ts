import { beforeEach, describe, expect, it } from 'vitest';
import { collectFocusEligibilityTasks, resolveFocusStarAction, useTaskStore, type Project, type Section, type Task } from '@mindwtr/core';

import { selectTaskItemStoreState } from './useTaskItemStoreState';

const at = '2026-10-01T09:00:00.000Z';
const step = (id: string, sectionId: string, order: number): Task => ({
    id, title: id, status: 'next', projectId: 'trip', sectionId, order, tags: [], contexts: [], createdAt: at, updatedAt: at,
});
const sections: Section[] = [
    { id: 'book', projectId: 'trip', title: 'Book campsite', order: 0, isSequential: true, createdAt: at, updatedAt: at },
    { id: 'gear', projectId: 'trip', title: 'Gear', order: 1, isSequential: true, createdAt: at, updatedAt: at },
];
const tasks = [step('find-site', 'book', 1), step('reserve-site', 'book', 2), step('find-tent', 'gear', 1), step('pack-tent', 'gear', 2)];

const seed = (project: Project) => {
    useTaskStore.setState({
        tasks, _allTasks: tasks, _tasksById: new Map(tasks.map((row) => [row.id, row])),
        projects: [project], _allProjects: [project], _projectsById: new Map([[project.id, project]]),
        sections, _allSections: sections, _sectionsById: new Map(sections.map((row) => [row.id, row])),
        settings: {},
    });
};

/** The same adapter TaskItem's quick-action star uses. */
const canStar = (task: Task) => {
    const selected = selectTaskItemStoreState({ task, isEditing: false, hasQuickActionMenu: true })(useTaskStore.getState());
    return resolveFocusStarAction(task, {
        tasks: collectFocusEligibilityTasks(selected.activeTasksByStatus),
        projects: selected.projectMap,
        sections: selected.sections,
        focusedCount: 0,
        focusTaskLimit: 3,
        sequentialProjectIds: selected.sequentialProjectIds,
        sectionScopedProjectIds: selected.sequentialWithinSectionProjectIds,
        sequentialSectionKeys: selected.sequentialSectionKeys,
    }).canToggle;
};

describe('TaskItem quick-action star', () => {
    const base: Project = { id: 'trip', title: 'Camping Trip', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at };

    beforeEach(() => {
        useTaskStore.setState({ tasks: [], _allTasks: [], projects: [], _allProjects: [], sections: [], _allSections: [] });
    });

    it.each([
        ['Sequential, within sections', { ...base, isSequential: true, sequentialScope: 'section' as const }],
        ['Per section', { ...base, perSectionFlow: true }],
    ])('can star the first step of the second section in %s', (_name, project) => {
        seed(project);
        expect(canStar(tasks[2])).toBe(true);
        expect(canStar(tasks[3])).toBe(false);
        expect(canStar(tasks[0])).toBe(true);
    });
});
