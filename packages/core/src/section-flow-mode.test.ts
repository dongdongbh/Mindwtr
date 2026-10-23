import { describe, expect, it } from 'vitest';
import { buildFocusPools, deriveFocusTaskLists } from './focus-sections';
import { computeTodayFocusTasks } from './focus-widget-selection';
import { getProjectNextActionPromptData, getSequentialProjectTaskCues, planProjectFlowModeChange } from './project-utils';
import { getProjectDetailTaskListOptions, buildProjectTaskListModel } from './project-task-list-model';
import { getDailyReviewBuckets } from './review-utils';
import {
    buildTaskFocusEligibilityContext,
    getCalendarPlanningCandidates,
    getFocusSequentialFirstTaskIds,
    getProjectFlowMode,
    getSequentialFirstTaskIds,
    getTaskFocusEligibility,
    getTaskSequenceKey,
    getTaskSequencing,
    isSequentialChainStatus,
    isTaskSequenceBlocked,
} from './task-utils';
import type { Project, Section, Task } from './types';

// Reporter's example from #1429: one Sequential section and one Parallel section.
const NOW = new Date('2026-10-21T09:00:00');
const AT = '2026-10-01T09:00:00.000Z';

const trip: Project = {
    id: 'trip', title: 'Camping Trip', status: 'active', color: '#6B7280', order: 0, tagIds: [],
    isSequential: false, perSectionFlow: true, createdAt: AT, updatedAt: AT,
};
const book: Section = { id: 'book', projectId: 'trip', title: 'Book campsite', order: 0, isSequential: true, createdAt: AT, updatedAt: AT };
const prep: Section = { id: 'prep', projectId: 'trip', title: 'Prep', order: 1, isSequential: false, createdAt: AT, updatedAt: AT };

const task = (id: string, sectionId: string | undefined, order: number, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', projectId: 'trip', sectionId, order, tags: [], contexts: [],
    createdAt: AT, updatedAt: AT, ...extra,
});

const campingTasks = (): Task[] => [
    task('find-site', 'book', 1),
    task('reserve-site', 'book', 2),
    task('pay-deposit', 'book', 3),
    task('find-tent', 'prep', 1),
    task('buy-food', 'prep', 2),
];

const focusNext = (tasks: Task[], projects: Project[] = [trip], sections: Section[] = [book, prep]) => {
    const pools = buildFocusPools({ tasks, visibleTasks: tasks, projects, criteria: {}, now: NOW });
    return deriveFocusTaskLists(pools, { now: NOW, projects, sections, sortBy: 'default', prioritiesEnabled: false })
        .nextActions.map((item) => item.id).sort();
};

/** The Next list's rule: manual order, waiting holds the slot. */
const nextList = (tasks: Task[], projects: Project[] = [trip], sections: Section[] = [book, prep]) => {
    const sequencing = getTaskSequencing(projects, sections);
    const first = getSequentialFirstTaskIds(
        tasks.filter((item) => isSequentialChainStatus(item.status)),
        sequencing.sequentialProjectIds,
        { sectionScopedProjectIds: sequencing.sectionScopedProjectIds, sequentialSectionKeys: sequencing.sequentialSectionKeys, sections },
    );
    return tasks.filter((item) => item.status === 'next' && !isTaskSequenceBlocked(item, sequencing, first))
        .map((item) => item.id).sort();
};

const EXPECTED = ['buy-food', 'find-site', 'find-tent'];

describe('Per section Flow mode (#1429)', () => {
    it('reads the mode with project-wide Sequential winning', () => {
        expect(getProjectFlowMode(trip)).toBe('perSection');
        expect(getProjectFlowMode({ isSequential: true, perSectionFlow: true })).toBe('sequential');
        expect(getProjectFlowMode({ perSectionFlow: false })).toBe('parallel');
        expect(getProjectFlowMode({})).toBe('parallel');
    });

    it('offers the Sequential section head plus every Parallel task in Focus, Next and eligibility', () => {
        const tasks = campingTasks();
        expect(focusNext(tasks)).toEqual(EXPECTED);
        expect(nextList(tasks)).toEqual(EXPECTED);
        const context = buildTaskFocusEligibilityContext({ tasks, projects: [trip], sections: [book, prep], now: NOW });
        const reasons = Object.fromEntries(tasks.map((item) => [item.id, getTaskFocusEligibility(item, { tasks, ...context, now: NOW }).reason]));
        expect(reasons).toEqual({
            'find-site': 'eligible', 'reserve-site': 'sequential', 'pay-deposit': 'sequential',
            'find-tent': 'eligible', 'buy-food': 'eligible',
        });
        // Callers that pass no precomputed sets derive the same answer from projects + sections.
        expect(getTaskFocusEligibility(tasks[1], { tasks, projects: [trip], sections: [book, prep], now: NOW }).reason).toBe('sequential');
        expect(getCalendarPlanningCandidates(tasks, { projects: [trip], sections: [book, prep], now: NOW }).map((item) => item.id).sort())
            .toEqual(EXPECTED);
    });

    it('marks project cues only inside the Sequential section', () => {
        const cues = getSequentialProjectTaskCues(trip, campingTasks(), [book, prep]);
        expect(Object.fromEntries(cues)).toEqual({ 'find-site': 'available', 'reserve-site': 'later', 'pay-deposit': 'later' });
        expect(getSequentialProjectTaskCues({ ...trip, perSectionFlow: false }, campingTasks(), [book, prep]).size).toBe(0);
    });

    it('feeds the same answer to the Focus widget and daily review', () => {
        const tasks = campingTasks();
        const widget = computeTodayFocusTasks({ activeTasks: tasks, projects: [trip], sections: [book, prep], sortBy: 'default', now: NOW });
        expect(widget.focusTasks.map((item) => item.id).sort()).toEqual(EXPECTED);
        const review = getDailyReviewBuckets(tasks, [trip], { now: NOW, sections: [book, prep] });
        expect(review.focusCandidates.map((item) => item.id).sort()).toEqual(EXPECTED);
    });

    it('lets a waiting or future-start head hold its section while the Parallel section stays open', () => {
        const waiting = campingTasks().map((item) => item.id === 'find-site' ? { ...item, status: 'waiting' as const } : item);
        expect(focusNext(waiting)).toEqual(['buy-food', 'find-tent']);
        expect(nextList(waiting)).toEqual(['buy-food', 'find-tent']);
        const deferred = campingTasks().map((item) => item.id === 'find-site' ? { ...item, startTime: '2026-10-25T09:00:00' } : item);
        expect(focusNext(deferred)).toEqual(['buy-food', 'find-tent']);
    });

    it('never lets a context filter show a later step of a Sequential section', () => {
        const tasks = campingTasks().map((item) => (item.id === 'reserve-site' || item.id === 'find-tent'
            ? { ...item, contexts: ['@phone'] } : item));
        const pools = buildFocusPools({ tasks, visibleTasks: tasks, projects: [trip], criteria: { contexts: ['@phone'] }, now: NOW });
        const lists = deriveFocusTaskLists(pools, { now: NOW, projects: [trip], sections: [book, prep], sortBy: 'default', prioritiesEnabled: false });
        expect(lists.nextActions.map((item) => item.id)).toEqual(['find-tent']);
    });

    it('treats a task with no section, a deleted section, or an unknown section as Parallel', () => {
        const tasks = [
            ...campingTasks(),
            task('loose', undefined, 9),
            task('ghost', 'missing-section', 10),
            task('old', 'gone', 11),
        ];
        const gone: Section = { ...book, id: 'gone', title: 'Gone', deletedAt: AT };
        const sequencing = getTaskSequencing([trip], [book, prep, gone]);
        expect(['loose', 'ghost', 'old'].map((id) => getTaskSequenceKey(tasks.find((item) => item.id === id)!, sequencing)))
            .toEqual([null, null, null]);
        expect(nextList(tasks, [trip], [book, prep, gone])).toEqual([...EXPECTED, 'ghost', 'loose', 'old'].sort());
        // Deleting the Sequential section itself opens its steps.
        expect(nextList(campingTasks(), [trip], [{ ...book, deletedAt: AT }, prep]))
            .toEqual(['buy-food', 'find-site', 'find-tent', 'pay-deposit', 'reserve-site']);
    });

    it('moves a task into a Sequential section as a later step, and back out as Parallel', () => {
        const moved = campingTasks().map((item) => item.id === 'buy-food' ? { ...item, sectionId: 'book', order: 4 } : item);
        expect(nextList(moved)).toEqual(['find-site', 'find-tent']);
        const head = campingTasks().map((item) => item.id === 'find-tent' ? { ...item, sectionId: 'book', order: 0 } : item);
        expect(nextList(head)).toEqual(['buy-food', 'find-tent']);
    });

    it('advances only the completed section, and undo puts it back', () => {
        const done = campingTasks().map((item) => item.id === 'find-site' ? { ...item, status: 'done' as const } : item);
        expect(focusNext(done)).toEqual(['buy-food', 'find-tent', 'reserve-site']);
        const undone = done.map((item) => item.id === 'find-site' ? { ...item, status: 'next' as const } : item);
        expect(focusNext(undone)).toEqual(EXPECTED);
        const prepDone = campingTasks().map((item) => item.id === 'find-tent' ? { ...item, status: 'done' as const } : item);
        expect(focusNext(prepDone)).toEqual(['buy-food', 'find-site']);
    });

    it('creates no dependency from section order', () => {
        const swapped = [{ ...book, order: 5 }, { ...prep, order: 0 }];
        expect(focusNext(campingTasks(), [trip], swapped)).toEqual(EXPECTED);
        expect(nextList(campingTasks(), [trip], swapped)).toEqual(EXPECTED);
    });

    it('keeps the star and due-today exceptions inside a Sequential section', () => {
        const tasks = campingTasks().map((item) => item.id === 'pay-deposit' ? { ...item, dueDate: '2026-10-21' } : item);
        const sequencing = getTaskSequencing([trip], [book, prep]);
        const focusFirst = getFocusSequentialFirstTaskIds(tasks, sequencing.sequentialProjectIds, {
            now: NOW, sectionScopedProjectIds: sequencing.sectionScopedProjectIds,
            sequentialSectionKeys: sequencing.sequentialSectionKeys, sections: [book, prep],
        });
        // Focus lets the due step take its section's slot; the Next list keeps manual order.
        // Parallel tasks are in no sequence, so they never appear as a head.
        expect([...focusFirst]).toEqual(['pay-deposit']);
        expect(focusNext(tasks)).toEqual(['buy-food', 'find-tent']);
        expect(nextList(tasks)).toEqual(EXPECTED);
        const starred = campingTasks().map((item) => item.id === 'reserve-site' ? { ...item, isFocusedToday: true } : item);
        const pools = buildFocusPools({ tasks: starred, visibleTasks: starred, projects: [trip], criteria: {}, now: NOW });
        const lists = deriveFocusTaskLists(pools, { now: NOW, projects: [trip], sections: [book, prep], sortBy: 'default', prioritiesEnabled: false });
        expect(lists.focusedTasks.map((item) => item.id)).toEqual(['reserve-site']);
    });

    it('prompts per section only for a Sequential section left without a next action', () => {
        const tasks = [task('find-site', 'book', 1, { status: 'done' }), task('reserve-site', 'book', 2, { status: 'someday' }),
            task('find-tent', 'prep', 1)];
        const prompt = getProjectNextActionPromptData(tasks[0], tasks, [trip], [book, prep]);
        expect(prompt?.scope).toBe('section');
        expect(prompt?.candidates.map((item) => item.id)).toEqual(['reserve-site']);
        const prepTasks = [task('find-site', 'book', 1), task('find-tent', 'prep', 1, { status: 'done' }), task('buy-food', 'prep', 2, { status: 'someday' })];
        expect(getProjectNextActionPromptData(prepTasks[1], prepTasks, [trip], [book, prep])).toBeNull();
    });

    it('labels sections only in Per section mode and keeps finished steps in place', () => {
        const base = {
            tasks: campingTasks(), visibleTasks: campingTasks(), sections: [book, prep], allSections: [book, prep],
            statusFilter: 'all' as const, criteria: {}, searchQuery: '', sortBy: 'default' as const, projectOrder: true,
            reorderMode: false, groupCompletedTasksLast: false, completedCollapsed: false, t: (key: string) => key,
        };
        const labels = (project: Project) => buildProjectTaskListModel({ ...base, project }).items
            .flatMap((item) => item.type === 'section' ? [item.flowLabel] : []);
        expect(labels(trip)).toEqual(['Sequential', 'Parallel']);
        expect(labels({ ...trip, isSequential: true })).toEqual([undefined, undefined]);
        expect(getProjectDetailTaskListOptions(trip, true).groupCompletedTasksLast).toBe(false);
        expect(getProjectDetailTaskListOptions({ ...trip, perSectionFlow: false }, true).groupCompletedTasksLast).toBe(true);
    });
});

describe('planProjectFlowModeChange (#1429)', () => {
    const later: Section = { ...prep, id: 'later', title: 'Later', isSequential: undefined };
    const fresh: Section = { ...prep, id: 'fresh', title: 'Fresh', isSequential: undefined };

    it('starts unset sections Sequential when leaving "Sequential, within sections"', () => {
        const within = { ...trip, isSequential: true, perSectionFlow: undefined, sequentialScope: 'section' as const };
        expect(planProjectFlowModeChange(within, [book, prep, later, fresh, { ...fresh, id: 'gone', deletedAt: AT }], 'perSection')).toEqual({
            project: { isSequential: false, perSectionFlow: true },
            sections: [{ id: 'later', isSequential: true }, { id: 'fresh', isSequential: true }],
        });
    });

    it('stamps unset sections Parallel from Parallel or "Sequential, across sections"', () => {
        const parallel = { ...trip, perSectionFlow: undefined };
        expect(planProjectFlowModeChange(parallel, [book, later], 'perSection')?.sections).toEqual([{ id: 'later', isSequential: false }]);
        const across = { ...trip, isSequential: true, perSectionFlow: undefined, sequentialScope: 'project' as const };
        expect(planProjectFlowModeChange(across, [book, later], 'perSection')?.sections).toEqual([{ id: 'later', isSequential: false }]);
    });

    it('keeps a Parallel section Parallel after a trip through "Sequential, within sections"', () => {
        const apply = (rows: Section[], plan: ReturnType<typeof planProjectFlowModeChange>) => rows.map((row) => {
            const choice = plan?.sections.find((entry) => entry.id === row.id);
            return choice ? { ...row, isSequential: choice.isSequential } : row;
        });
        const parallel = { ...trip, perSectionFlow: undefined };
        let rows = apply([later], planProjectFlowModeChange(parallel, [later], 'perSection'));
        const within = { ...trip, isSequential: true, perSectionFlow: false, sequentialScope: 'section' as const };
        rows = apply(rows, planProjectFlowModeChange(within, rows, 'perSection'));
        expect(rows[0].isSequential).toBe(false);
    });

    it('writes an explicit off when leaving Per section and never touches stored choices', () => {
        expect(planProjectFlowModeChange(trip, [book, prep], 'sequential'))
            .toEqual({ project: { isSequential: true, perSectionFlow: false }, sections: [] });
        expect(planProjectFlowModeChange(trip, [book, prep], 'parallel'))
            .toEqual({ project: { isSequential: false, perSectionFlow: false }, sections: [] });
        expect(planProjectFlowModeChange(trip, [book, prep], 'perSection')).toBeNull();
        // A project that never used Per section keeps the field absent.
        expect(planProjectFlowModeChange({ ...trip, perSectionFlow: undefined }, [], 'sequential'))
            .toEqual({ project: { isSequential: true }, sections: [] });
    });
});
