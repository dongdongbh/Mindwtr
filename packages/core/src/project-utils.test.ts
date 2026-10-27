import { describe, it, expect } from 'vitest';
import {
    filterProjectsBySelectedArea,
    filterProjectsNeedingNextAction,
    getSequentialProjectTaskCues,
    getProjectNextActionCandidates,
    getProjectNextActionPromptData,
    getProjectChoiceState,
    groupProjectsForPicker,
    getProjectSectionsForView,
    getProjectsByArea,
    getProjectsByTag,
    isTaskInActiveProject,
    isTaskInCalendarHistoryProject,
    isSelectableProjectForTaskAssignment,
    projectHasNextAction,
    shouldPromptForProjectNextAction,
} from './project-utils';
import { archiveSectionForProjectArchive } from './store-helpers';
import { getFocusSequentialFirstTaskIds, getSequentialFirstTaskIds, isSequentialChainStatus } from './task-utils';
import type { Project, Section, Task } from './types';

describe('project-utils', () => {
    const projects: Project[] = [
        { id: 'p1', title: 'Alpha', status: 'active', tagIds: ['t1'], areaId: 'a1', createdAt: '', updatedAt: '' },
        { id: 'p2', title: 'Beta', status: 'active', tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
        { id: 'p3', title: 'Gamma', status: 'someday', tagIds: ['t1'], areaId: 'a2', createdAt: '', updatedAt: '' },
        { id: 'p4', title: 'Delta', status: 'active', tagIds: ['t2'], createdAt: '', updatedAt: '' },
        { id: 'p5', title: 'Hidden', status: 'active', tagIds: [], areaId: 'a1', deletedAt: '2026-03-07T00:00:00.000Z', createdAt: '', updatedAt: '' },
    ];

    const tasks: Task[] = [
        { id: 't1', title: 'Next action', status: 'next', projectId: 'p1', tags: [], contexts: [], createdAt: '', updatedAt: '' },
        { id: 't2', title: 'Waiting action', status: 'waiting', projectId: 'p2', tags: [], contexts: [], createdAt: '', updatedAt: '' },
    ];

    it('uses project-archive section tombstones only for archived history', () => {
        const activeProject = projects[0];
        const archivedProject = { ...activeProject, status: 'archived' as const };
        const section: Section = {
            id: 'section-history',
            projectId: activeProject.id,
            title: 'Historical planning',
            description: 'Decisions made before archive',
            order: 2,
            createdAt: '2026-08-30T10:00:00.000Z',
            updatedAt: '2026-08-30T10:00:00.000Z',
        };
        const archivedSection = archiveSectionForProjectArchive(
            section,
            '2026-08-31T10:00:00.000Z',
            'device-a',
        );
        const previouslyDeleted: Section = {
            ...section,
            id: 'section-deleted-before-archive',
            title: 'Discarded outline',
            deletedAt: '2026-08-29T10:00:00.000Z',
            updatedAt: '2026-08-29T10:00:00.000Z',
        };

        expect(getProjectSectionsForView(activeProject, [section], [archivedSection, previouslyDeleted]))
            .toEqual([section]);
        expect(getProjectSectionsForView(archivedProject, [], [archivedSection, previouslyDeleted]))
            .toEqual([archivedSection]);
        expect(archivedSection).toMatchObject({
            deletedAt: '2026-08-31T10:00:00.000Z',
            deletedAtBeforeProjectArchive: undefined,
            projectArchivedAt: '2026-08-31T10:00:00.000Z',
            title: 'Historical planning',
            description: 'Decisions made before archive',
        });
    });

    it('detects projects with next actions', () => {
        expect(projectHasNextAction(projects[0], tasks)).toBe(true);
        expect(projectHasNextAction(projects[1], tasks)).toBe(false);
    });

    it('filters projects needing next actions', () => {
        const needing = filterProjectsNeedingNextAction(projects, tasks);
        expect(needing.map((p) => p.id)).toEqual(['p2', 'p4']);
    });

    it('prompts for a project next action after completing the last next task', () => {
        const completedTask: Task = {
            id: 'done-next',
            title: 'Finished step',
            status: 'done',
            projectId: 'p2',
            tags: [],
            contexts: [],
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
        };
        const projectTasks: Task[] = [
            completedTask,
            {
                id: 'candidate-later',
                title: 'Later step',
                status: 'someday',
                projectId: 'p2',
                order: 2,
                tags: [],
                contexts: [],
                createdAt: '2026-05-03T00:00:00.000Z',
                updatedAt: '2026-05-03T00:00:00.000Z',
            },
            {
                id: 'candidate-now',
                title: 'Draft outline',
                status: 'inbox',
                projectId: 'p2',
                order: 1,
                tags: [],
                contexts: [],
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
            {
                id: 'closed-reference',
                title: 'Project note',
                status: 'reference',
                projectId: 'p2',
                tags: [],
                contexts: [],
                createdAt: '2026-05-04T00:00:00.000Z',
                updatedAt: '2026-05-04T00:00:00.000Z',
            },
        ];

        const promptData = getProjectNextActionPromptData(completedTask, projectTasks, projects);

        expect(shouldPromptForProjectNextAction(completedTask, projectTasks, projects)).toBe(true);
        expect(promptData?.project.id).toBe('p2');
        expect(promptData?.candidates.map((task) => task.id)).toEqual(['candidate-now', 'candidate-later']);
        expect(getProjectNextActionCandidates('p2', projectTasks, 'done-next').map((task) => task.id))
            .toEqual(['candidate-now', 'candidate-later']);
    });

    it('does not prompt when another next action remains in the project', () => {
        const completedTask: Task = {
            id: 'done-next',
            title: 'Finished step',
            status: 'done',
            projectId: 'p1',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };

        expect(getProjectNextActionPromptData(completedTask, [completedTask, ...tasks], projects)).toBeNull();
    });

    it('prompts for a stalled section in a section-scoped sequential project (#911)', () => {
        const sectionProject: Project = { ...projects[0], id: 'seq', isSequential: true, sequentialScope: 'section' };
        const completedTask: Task = {
            id: 'done-a', title: 'Finish section A', status: 'done', projectId: 'seq', sectionId: 's-a',
            tags: [], contexts: [], createdAt: '', updatedAt: '',
        };
        const projectTasks: Task[] = [
            completedTask,
            { id: 'b-next', title: 'B live', status: 'next', projectId: 'seq', sectionId: 's-b', tags: [], contexts: [], createdAt: '', updatedAt: '' },
            { id: 'a-someday', title: 'A later', status: 'someday', projectId: 'seq', sectionId: 's-a', order: 1, tags: [], contexts: [], createdAt: '', updatedAt: '' },
            { id: 'b-inbox', title: 'B other', status: 'inbox', projectId: 'seq', sectionId: 's-b', tags: [], contexts: [], createdAt: '', updatedAt: '' },
        ];

        const promptData = getProjectNextActionPromptData(completedTask, projectTasks, [sectionProject]);

        expect(promptData?.scope).toBe('section');
        expect(promptData?.project.id).toBe('seq');
        expect(promptData?.candidates.map((task) => task.id)).toEqual(['a-someday']);
    });

    it('does not prompt for a section while it still has a next action, nor without section-scoped sequencing', () => {
        const completedTask: Task = {
            id: 'done-a', title: 'Finish step', status: 'done', projectId: 'seq', sectionId: 's-a',
            tags: [], contexts: [], createdAt: '', updatedAt: '',
        };
        const projectTasks: Task[] = [
            completedTask,
            { id: 'a-next', title: 'A live', status: 'next', projectId: 'seq', sectionId: 's-a', tags: [], contexts: [], createdAt: '', updatedAt: '' },
            { id: 'b-next', title: 'B live', status: 'next', projectId: 'seq', sectionId: 's-b', tags: [], contexts: [], createdAt: '', updatedAt: '' },
        ];
        const sectionProject: Project = { ...projects[0], id: 'seq', isSequential: true, sequentialScope: 'section' };
        expect(getProjectNextActionPromptData(completedTask, projectTasks, [sectionProject])).toBeNull();

        // Section stalls but the project is parallel, or sequential over the whole project: no prompt.
        const stalledTasks = projectTasks.filter((task) => task.id !== 'a-next');
        const parallelProject: Project = { ...projects[0], id: 'seq' };
        const projectScoped: Project = { ...projects[0], id: 'seq', isSequential: true, sequentialScope: 'project' };
        expect(getProjectNextActionPromptData(completedTask, stalledTasks, [parallelProject])).toBeNull();
        expect(getProjectNextActionPromptData(completedTask, stalledTasks, [projectScoped])).toBeNull();
    });

    it('treats unsectioned tasks as their own group for section-stall prompts', () => {
        const sectionProject: Project = { ...projects[0], id: 'seq', isSequential: true, sequentialScope: 'section' };
        const completedTask: Task = {
            id: 'done-loose', title: 'Loose step', status: 'done', projectId: 'seq',
            tags: [], contexts: [], createdAt: '', updatedAt: '',
        };
        const projectTasks: Task[] = [
            completedTask,
            { id: 'b-next', title: 'B live', status: 'next', projectId: 'seq', sectionId: 's-b', tags: [], contexts: [], createdAt: '', updatedAt: '' },
            { id: 'loose-inbox', title: 'Loose later', status: 'inbox', projectId: 'seq', tags: [], contexts: [], createdAt: '', updatedAt: '' },
        ];

        const promptData = getProjectNextActionPromptData(completedTask, projectTasks, [sectionProject]);
        expect(promptData?.scope).toBe('section');
        expect(promptData?.candidates.map((task) => task.id)).toEqual(['loose-inbox']);
    });

    it('marks one available next task in a sequential project', () => {
        const project: Project = { ...projects[0], isSequential: true, sequentialScope: 'project' };
        const projectTasks: Task[] = [
            { ...tasks[0], id: 'first-next', projectId: project.id, order: 1 },
            { ...tasks[0], id: 'second-next', projectId: project.id, order: 2 },
            { ...tasks[0], id: 'waiting-step', projectId: project.id, status: 'waiting', order: 3 },
        ];

        const cues = getSequentialProjectTaskCues(project, projectTasks, []);

        expect(cues.get('first-next')).toBe('available');
        expect(cues.get('second-next')).toBe('later');
        expect(cues.has('waiting-step')).toBe(false);
    });

    it('marks one available next task per section for section-scoped sequential projects', () => {
        const project: Project = { ...projects[0], isSequential: true, sequentialScope: 'section' };
        const projectTasks: Task[] = [
            { ...tasks[0], id: 'section-a-first', projectId: project.id, sectionId: 'a', order: 1 },
            { ...tasks[0], id: 'section-a-later', projectId: project.id, sectionId: 'a', order: 2 },
            { ...tasks[0], id: 'section-b-first', projectId: project.id, sectionId: 'b', order: 3 },
            { ...tasks[0], id: 'unsectioned-first', projectId: project.id, sectionId: 'missing', order: 4 },
            { ...tasks[0], id: 'unsectioned-later', projectId: project.id, order: 5 },
        ];

        const sections: Section[] = [
            { id: 'a', projectId: project.id, title: 'A', order: 0, createdAt: '', updatedAt: '' },
            { id: 'b', projectId: project.id, title: 'B', order: 1, createdAt: '', updatedAt: '' },
        ];
        const cues = getSequentialProjectTaskCues(project, projectTasks, sections);

        expect(cues.get('section-a-first')).toBe('available');
        expect(cues.get('section-a-later')).toBe('later');
        expect(cues.get('section-b-first')).toBe('available');
        expect(cues.get('unsectioned-first')).toBe('available');
        expect(cues.get('unsectioned-later')).toBe('later');
    });

    it('does not mark tasks in parallel projects', () => {
        const project: Project = { ...projects[0], isSequential: false };

        expect(getSequentialProjectTaskCues(project, tasks, []).size).toBe(0);
    });

    describe('sequence cue follows the sequence, not the caller list order', () => {
        const project: Project = { ...projects[0], isSequential: true, sequentialScope: 'project' };
        const step = (id: string, fields: Partial<Task>): Task => ({
            id, title: id, status: 'next', projectId: project.id, tags: [], contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z', ...fields,
        });
        const sections: Section[] = [
            { id: 'setup', projectId: project.id, title: 'Set up', order: 0, createdAt: '', updatedAt: '' },
            { id: 'final', projectId: project.id, title: 'Final', order: 1, createdAt: '', updatedAt: '' },
        ];
        const cueEntries = (cues: Map<string, string>) => [...cues.entries()].sort(([a], [b]) => a.localeCompare(b));

        it('gives the same cues for the same tasks in two different orders', () => {
            const storeOrder = [step('b', { order: 2 }), step('a', { order: 1 }), step('c', { order: 3 })];
            const displayOrder = [storeOrder[1], storeOrder[0], storeOrder[2]];

            const fromStore = getSequentialProjectTaskCues(project, storeOrder, sections);
            const fromDisplay = getSequentialProjectTaskCues(project, displayOrder, sections);

            expect(cueEntries(fromStore)).toEqual(cueEntries(fromDisplay));
            expect(fromStore.get('a')).toBe('available');
            expect(fromStore.get('b')).toBe('later');
        });

        it('moves the available cue when a manual reorder changes order', () => {
            const before = [step('a', { order: 1 }), step('b', { order: 2 })];
            const after = [step('a', { order: 3 }), step('b', { order: 2 })];

            expect(getSequentialProjectTaskCues(project, before, sections).get('a')).toBe('available');
            const cues = getSequentialProjectTaskCues(project, after, sections);
            expect(cues.get('a')).toBe('later');
            expect(cues.get('b')).toBe('available');
        });

        it('lets an earlier waiting task hold the slot, as Focus and Next do', () => {
            const projectTasks = [
                step('later-next', { order: 2 }),
                step('waiting-first', { status: 'waiting', order: 1 }),
            ];

            const cues = getSequentialProjectTaskCues(project, projectTasks, sections);

            expect(cues.get('later-next')).toBe('later');
            expect(cues.has('waiting-first')).toBe(false);
        });

        it('ranks sections before task order across sections', () => {
            const projectTasks = [
                step('final-first-order', { sectionId: 'final', order: 0 }),
                step('setup-task', { sectionId: 'setup', order: 10 }),
            ];

            const cues = getSequentialProjectTaskCues(project, projectTasks, sections);

            expect(cues.get('setup-task')).toBe('available');
            expect(cues.get('final-first-order')).toBe('later');
        });

        it('marks one available task per section by order when scope is section', () => {
            const sectionProject: Project = { ...project, sequentialScope: 'section' };
            const projectTasks = [
                step('setup-second', { sectionId: 'setup', order: 2 }),
                step('final-second', { sectionId: 'final', order: 4 }),
                step('setup-first', { sectionId: 'setup', order: 1 }),
                step('final-waiting', { sectionId: 'final', status: 'waiting', order: 3 }),
            ];

            const cues = getSequentialProjectTaskCues(sectionProject, projectTasks, sections);

            expect(cues.get('setup-first')).toBe('available');
            expect(cues.get('setup-second')).toBe('later');
            expect(cues.get('final-second')).toBe('later');
        });

        it('marks as available exactly the task the Next list picks (getSequentialFirstTaskIds)', () => {
            const projectTasks = [
                step('inbox-early', { status: 'inbox', order: 0 }),
                step('z-next', { sectionId: 'final', order: 1 }),
                step('m-next', { sectionId: 'setup', order: 5 }),
                step('done-early', { status: 'done', sectionId: 'setup', order: 0 }),
                step('y-next', { sectionId: 'setup', order: 7 }),
            ];
            const firstTaskIds = getSequentialFirstTaskIds(
                projectTasks.filter((task) => isSequentialChainStatus(task.status)),
                new Set([project.id]),
                { sections },
            );

            const cues = getSequentialProjectTaskCues(project, [...projectTasks].reverse(), sections);
            const available = [...cues].filter(([, cue]) => cue === 'available').map(([id]) => id);

            expect(available).toEqual([...firstTaskIds]);
            expect(available).toEqual(['m-next']);
        });

        it('keeps a due-today Next task behind Waiting "later" although Focus shows it by its own slot rule', () => {
            const now = new Date('2026-04-05T12:00:00.000Z');
            const projectTasks = [
                step('waiting-first', { status: 'waiting', order: 1 }),
                step('due-next', { order: 2, dueDate: '2026-04-05' }),
            ];

            const cues = getSequentialProjectTaskCues(project, projectTasks, sections);
            const focusFirstTaskIds = getFocusSequentialFirstTaskIds(projectTasks, new Set([project.id]), { now, sections });

            expect(cues.get('due-next')).toBe('later');
            expect([...focusFirstTaskIds]).toEqual(['due-next']);
        });
    });

    it('does not prompt for inactive projects or incomplete tasks', () => {
        const somedayTask: Task = {
            id: 'someday-task',
            title: 'Queued step',
            status: 'done',
            projectId: 'p3',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };
        const activeIncompleteTask: Task = {
            id: 'active-incomplete',
            title: 'Still open',
            status: 'next',
            projectId: 'p2',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };

        expect(shouldPromptForProjectNextAction(somedayTask, [somedayTask], projects)).toBe(false);
        expect(shouldPromptForProjectNextAction(activeIncompleteTask, [activeIncompleteTask], projects)).toBe(false);
    });

    it('filters projects by area', () => {
        const areaProjects = getProjectsByArea(projects, 'a1');
        expect(areaProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('filters project picker choices by selected area', () => {
        const pickerProjects: Project[] = [
            ...projects,
            { id: 'p6', title: 'Archived', status: 'archived', tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
            { id: 'p7', title: 'Completed', status: 'completed' as Project['status'], tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
        ];
        expect(filterProjectsBySelectedArea(pickerProjects).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(filterProjectsBySelectedArea(pickerProjects, 'a1').map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('derives assignable Container project choices for browse, search, exact match, and creation', () => {
        const archivedExact: Project = {
            id: 'archived-exact', title: 'Old Home', status: 'archived', tagIds: [], areaId: 'a2', createdAt: '', updatedAt: '',
        };
        const completed: Project = {
            id: 'completed', title: 'Completed Home', status: 'completed' as Project['status'], tagIds: [], areaId: 'a2', createdAt: '', updatedAt: '',
        };
        const allProjects = [...projects, archivedExact, completed];

        const browse = getProjectChoiceState(projects.filter((project) => project.areaId === 'a1'), '', allProjects);
        expect(browse.filteredProjects.map((project) => project.id)).toEqual(['p1', 'p2']);
        expect(browse.exactMatch).toBeUndefined();
        expect(browse.canCreate).toBe(false);

        const search = getProjectChoiceState(projects.filter((project) => project.areaId === 'a1'), ' gam ', allProjects);
        expect(search.filteredProjects.map((project) => project.id)).toEqual(['p3']);
        expect(search.exactMatch).toBeUndefined();
        expect(search.canCreate).toBe(true);

        const exact = getProjectChoiceState([], ' gamma ', allProjects);
        expect(exact.exactMatch?.id).toBe('p3');
        expect(exact.canCreate).toBe(false);

        const archived = getProjectChoiceState([], 'old home', allProjects);
        expect(archived.filteredProjects).toEqual([]);
        expect(archived.exactMatch).toBeUndefined();
        expect(archived.canCreate).toBe(true);
    });

    it('groups picker projects into active, then Someday / Waiting, keeping each group in its given order (#1467)', () => {
        const row = (id: string, status: Project['status']) => ({ id, status });
        const grouped = groupProjectsForPicker([row('s1', 'someday'), row('a1', 'active'), row('w1', 'waiting'), row('a2', 'active'), row('s2', 'someday')]);
        expect(grouped.active.map((project) => project.id)).toEqual(['a1', 'a2']);
        expect(grouped.deferred.map((project) => project.id)).toEqual(['s1', 'w1', 's2']);
        expect(groupProjectsForPicker([])).toEqual({ active: [], deferred: [] });
    });

    it('marks archived and legacy completed projects as unavailable for task assignment', () => {
        const archivedProject: Project = { id: 'p6', title: 'Archived', status: 'archived', tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' };
        const completedProject: Project = { id: 'p7', title: 'Completed', status: 'completed' as Project['status'], tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' };
        expect(isSelectableProjectForTaskAssignment(projects[0])).toBe(true);
        expect(isSelectableProjectForTaskAssignment(projects[2])).toBe(true);
        expect(isSelectableProjectForTaskAssignment(projects[4])).toBe(false);
        expect(isSelectableProjectForTaskAssignment(archivedProject)).toBe(false);
        expect(isSelectableProjectForTaskAssignment(completedProject)).toBe(false);
    });

    it('recognizes whether a task belongs to an active project surface', () => {
        const projectMap = new Map(projects.map((project) => [project.id, project]));
        const noProjectTask: Task = { id: 'no-project', title: 'Loose task', status: 'next', tags: [], contexts: [], createdAt: '', updatedAt: '' };
        const activeProjectTask: Task = { ...noProjectTask, id: 'active-project', projectId: 'p1' };
        const somedayProjectTask: Task = { ...noProjectTask, id: 'someday-project', projectId: 'p3' };
        const deletedProjectTask: Task = { ...noProjectTask, id: 'deleted-project', projectId: 'p5' };
        const missingProjectTask: Task = { ...noProjectTask, id: 'missing-project', projectId: 'missing' };

        expect(isTaskInActiveProject(noProjectTask, projectMap)).toBe(true);
        expect(isTaskInActiveProject(activeProjectTask, projectMap)).toBe(true);
        expect(isTaskInActiveProject(somedayProjectTask, projectMap)).toBe(false);
        expect(isTaskInActiveProject(deletedProjectTask, projectMap)).toBe(false);
        expect(isTaskInActiveProject(missingProjectTask, projectMap)).toBe(true);
    });

    it('includes archived projects only for the calendar history surface', () => {
        const archivedProject: Project = {
            id: 'p6',
            title: 'Archived',
            status: 'archived',
            tagIds: [],
            createdAt: '',
            updatedAt: '',
        };
        const projectMap = new Map([...projects, archivedProject].map((project) => [project.id, project]));
        const looseTask: Task = {
            id: 'loose',
            title: 'Loose task',
            status: 'done',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };

        expect(isTaskInCalendarHistoryProject(looseTask, projectMap)).toBe(true);
        expect(isTaskInCalendarHistoryProject({ ...looseTask, projectId: 'p1' }, projectMap)).toBe(true);
        expect(isTaskInCalendarHistoryProject({ ...looseTask, projectId: 'p6' }, projectMap)).toBe(true);
        expect(isTaskInCalendarHistoryProject({ ...looseTask, projectId: 'p3' }, projectMap)).toBe(false);
        expect(isTaskInCalendarHistoryProject({ ...looseTask, projectId: 'p5' }, projectMap)).toBe(false);
        expect(isTaskInCalendarHistoryProject({ ...looseTask, projectId: 'missing' }, projectMap)).toBe(true);
    });

    it('filters projects by tag', () => {
        const tagged = getProjectsByTag(projects, 't1');
        expect(tagged.map((p) => p.id)).toEqual(['p1', 'p3']);
    });
});
