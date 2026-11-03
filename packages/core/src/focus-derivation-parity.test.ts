


import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    buildFocusPools,
    buildFocusTaskSections,
    deriveFocusTaskLists,
    type FocusListContext,
    type FocusPools,
    type FocusTaskLists,
} from './focus-sections';
import {
    frozenBuildFocusPools,
    frozenBuildFocusTaskSections,
    frozenDeriveFocusTaskLists,
} from './__fixtures__/focus-derivation-frozen';
import { applyFilter, createTaskFilterPredicate } from './saved-filters';
import { FOCUS_SORT_OPTIONS } from './task-list-sort-options';
import { isTaskActionable } from './task-status';
import { isTaskFutureStart } from './task-utils';
import type { Project, Section, SortField, Task, TaskPriority, TaskStatus } from './types';


const BASE_ISO = '2026-06-01T09:00:00.000Z';
const SECTIONS_PER_PROJECT = 2;
const CONTEXTS = ['@home', '@work', '@errands', '@calls', '@computer', '@deep-work'];
const TAGS = ['#admin', '#writing', '#health', '#finance', '#planning', '#follow-up'];
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

const syntheticStatus = (index: number): TaskStatus => {
    if (index % 29 === 0) return 'archived';
    if (index % 23 === 0) return 'reference';
    if (index % 11 === 0) return 'done';
    if (index % 7 === 0) return 'waiting';
    if (index % 5 === 0) return 'inbox';
    return 'next';
};

type Store = { tasks: Task[]; projects: Project[]; sections: Section[] };

function buildGeneratedStore(taskCount: number): Store {
    const projectCount = Math.max(40, Math.min(500, Math.floor(taskCount / 40)));
    const selectedProjectTaskCount = Math.min(2_000, Math.max(150, Math.floor(taskCount / 4)));
    const projects: Project[] = Array.from({ length: projectCount }, (_, index) => ({
        id: index === 0 ? 'project-selected' : `project-${index}`,
        title: index === 0 ? 'Selected Project' : `Project ${index}`,
        status: index % 19 === 0 ? 'waiting' : index % 23 === 0 ? 'someday' : 'active',
        color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][index % 5],
        order: index,
        tagIds: [TAGS[index % TAGS.length]],
        dueDate: index % 5 === 0 ? `2026-06-${String((index % 6) + 1).padStart(2, '0')}T17:00:00.000Z` : undefined,
        isFocused: index % 13 === 0,


        isSequential: index % 11 === 0 ? true : undefined,
        sequentialScope: index % 22 === 0 ? 'section' : undefined,
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
    }));
    const sections: Section[] = projects.flatMap((project) => (
        Array.from({ length: SECTIONS_PER_PROJECT }, (_, index) => ({
            id: `section-${project.id}-${index}`,
            projectId: project.id,
            title: `Section ${index + 1}`,
            order: index,
            createdAt: BASE_ISO,
            updatedAt: BASE_ISO,
        }))
    ));
    const tasks: Task[] = [];
    for (let index = 0; index < taskCount; index += 1) {
        const projectIndex = index < selectedProjectTaskCount
            ? 0
            : 1 + ((index - selectedProjectTaskCount) % Math.max(1, projectCount - 1));
        const project = projects[projectIndex];
        const section = sections[projectIndex * SECTIONS_PER_PROJECT + (index % SECTIONS_PER_PROJECT)];
        const status = syntheticStatus(index);
        tasks.push({
            id: `task-${index}`,
            title: `Synthetic${index % 17 === 0 ? ' alpha' : ''} task ${index}`,
            status,
            priority: PRIORITIES[index % PRIORITIES.length],


            startTime: index % 37 === 0
                ? (index % 74 === 0
                    ? `2026-06-0${(index % 9) + 1}`
                    : `2026-06-${String((index % 9) + 1).padStart(2, '0')}T08:00:00.000Z`)
                : undefined,
            dueDate: index % 3 === 0
                ? (index % 12 === 0
                    ? `2026-06-${String((index % 12) + 1).padStart(2, '0')}`
                    : `2026-06-${String((index % 12) + 1).padStart(2, '0')}T17:00:00.000Z`)
                : undefined,
            reviewAt: index % 53 === 0 ? `2026-06-${String((index % 9) + 1).padStart(2, '0')}T07:00:00.000Z` : undefined,
            tags: [TAGS[index % TAGS.length], TAGS[(index + 3) % TAGS.length]],
            contexts: [CONTEXTS[index % CONTEXTS.length]],
            projectId: project.id,
            sectionId: section.id,
            areaId: `area-${index % 5}`,
            isFocusedToday: index % 97 === 0,
            focusOrder: index % 97 === 0 ? index % 5 : undefined,
            completedAt: status === 'done' || status === 'archived' ? '2026-06-02T09:00:00.000Z' : undefined,
            deletedAt: index % 503 === 0 ? '2026-06-03T09:00:00.000Z' : undefined,
            order: index,
            orderNum: index,
            createdAt: BASE_ISO,
            updatedAt: `2026-06-${String((index % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
            rev: 1,
            revBy: 'parity',
        });
    }
    return { tasks, projects, sections };
}


function buildEdgeStore(): Store {
    const projects: Project[] = [
        { id: 'p-plain', title: 'Plain', status: 'active', order: 0, createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-seq', title: 'Sequential project scope', status: 'active', order: 1, isSequential: true, createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-seq-sec', title: 'Sequential section scope', status: 'active', order: 2, isSequential: true, sequentialScope: 'section', createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-deferred', title: 'Deferred project', status: 'someday', order: 3, startDate: '2026-12-01', createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-archived', title: 'Archived project', status: 'archived', order: 4, createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-due-today', title: 'Due today', status: 'active', order: 5, dueDate: '2026-06-06', createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-due-overdue', title: 'Overdue project', status: 'active', order: 6, dueDate: '2026-06-01', createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 'p-deleted-seq', title: 'Deleted sequential', status: 'active', order: 7, isSequential: true, deletedAt: '2026-06-02T00:00:00.000Z', createdAt: BASE_ISO, updatedAt: BASE_ISO },
    ] as Project[];
    const sections: Section[] = [
        { id: 's-1', projectId: 'p-seq-sec', title: 'First', order: 0, createdAt: BASE_ISO, updatedAt: BASE_ISO },
        { id: 's-2', projectId: 'p-seq-sec', title: 'Second', order: 1, createdAt: BASE_ISO, updatedAt: BASE_ISO },
    ];

    let n = 0;
    const base = (extra: Partial<Task>): Task => {
        n += 1;
        return {
            id: `edge-${String(n).padStart(3, '0')}`,
            title: `Edge ${n}`,
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: BASE_ISO,
            updatedAt: BASE_ISO,
            ...extra,
        };
    };

    const tasks: Task[] = [

        base({ title: 'due date-only today', dueDate: '2026-06-06' }),
        base({ title: 'due date-only yesterday (overdue)', dueDate: '2026-06-05' }),
        base({ title: 'due date-only tomorrow', dueDate: '2026-06-07' }),
        base({ title: 'due timed one ms before local midnight', dueDate: '2026-06-06T23:59:59.999' }),
        base({ title: 'due timed at local midnight tomorrow', dueDate: '2026-06-07T00:00:00.000' }),
        base({ title: 'due timed at local midnight today', dueDate: '2026-06-06T00:00:00.000' }),
        base({ title: 'due timed UTC evening', dueDate: '2026-06-06T23:00:00.000Z' }),
        base({ title: 'due long past', dueDate: '2019-01-01T09:00:00.000Z' }),
        base({ title: 'due far future', dueDate: '2099-01-01T09:00:00.000Z' }),
        base({ title: 'due invalid', dueDate: '2026-02-30T09:00:00.000Z' }),
        base({ title: 'due nonsense', dueDate: 'not-a-date' }),


        base({ title: 'start date-only today', startTime: '2026-06-06' }),
        base({ title: 'start timed earlier today', startTime: '2026-06-06T08:00:00.000' }),
        base({ title: 'start timed later today', startTime: '2026-06-06T23:00:00.000' }),
        base({ title: 'start timed tomorrow', startTime: '2026-06-07T08:00:00.000' }),
        base({ title: 'start date-only next week', startTime: '2026-06-12' }),
        base({ title: 'start beyond the upcoming window', startTime: '2026-07-30' }),
        base({ title: 'start and due both set', startTime: '2026-06-06T09:00:00.000', dueDate: '2026-06-06T17:00:00.000' }),
        base({ title: 'start after due', startTime: '2026-06-06T18:00:00.000', dueDate: '2026-06-06T09:00:00.000' }),


        base({ title: 'review due yesterday', reviewAt: '2026-06-05T09:00:00.000Z' }),
        base({ title: 'review due exactly now', reviewAt: '2026-06-06T12:00:00.000Z' }),
        base({ title: 'review due tomorrow', reviewAt: '2026-06-07T09:00:00.000Z' }),
        base({ title: 'review due and also due today', reviewAt: '2026-06-05T09:00:00.000Z', dueDate: '2026-06-06' }),
        base({ title: 'review due, waiting status', status: 'waiting', reviewAt: '2026-06-05T09:00:00.000Z' }),


        base({ title: 'starred no order', isFocusedToday: true }),
        base({ title: 'starred order 2', isFocusedToday: true, focusOrder: 2 }),
        base({ title: 'starred order 0', isFocusedToday: true, focusOrder: 0 }),
        base({ title: 'starred order 0 again', isFocusedToday: true, focusOrder: 0 }),
        base({ title: 'starred and deferred to next week', isFocusedToday: true, startTime: '2026-06-12' }),


        base({ title: 'inbox', status: 'inbox' }),
        base({ title: 'waiting', status: 'waiting', assignedTo: 'Sam' }),
        base({ title: 'someday', status: 'someday' }),
        base({ title: 'reference', status: 'reference' }),
        base({ title: 'done', status: 'done', completedAt: '2026-06-05T09:00:00.000Z' }),
        base({ title: 'archived', status: 'archived', completedAt: '2026-06-05T09:00:00.000Z' }),
        base({ title: 'tombstoned', deletedAt: '2026-06-02T09:00:00.000Z' }),
        base({ title: 'tombstoned and purged', deletedAt: '2026-06-02T09:00:00.000Z', purgedAt: '2026-06-03T09:00:00.000Z' }),


        base({ title: 'seq step 1', projectId: 'p-seq', order: 0 }),
        base({ title: 'seq step 2', projectId: 'p-seq', order: 1 }),
        base({ title: 'seq step 3 waiting', projectId: 'p-seq', order: 2, status: 'waiting' }),
        base({ title: 'seq step 4 deferred', projectId: 'p-seq', order: 3, startTime: '2026-06-20' }),

        base({ title: 'seq-sec a1', projectId: 'p-seq-sec', sectionId: 's-1', order: 0 }),
        base({ title: 'seq-sec a2', projectId: 'p-seq-sec', sectionId: 's-1', order: 1 }),
        base({ title: 'seq-sec b1', projectId: 'p-seq-sec', sectionId: 's-2', order: 0 }),
        base({ title: 'seq-sec b2', projectId: 'p-seq-sec', sectionId: 's-2', order: 1 }),
        base({ title: 'seq-sec no section', projectId: 'p-seq-sec', order: 0 }),

        base({ title: 'deleted-seq step 1', projectId: 'p-deleted-seq', order: 0 }),
        base({ title: 'deleted-seq step 2', projectId: 'p-deleted-seq', order: 1 }),


        base({ title: 'in deferred project', projectId: 'p-deferred' }),
        base({ title: 'in archived project', projectId: 'p-archived' }),

        base({ title: 'boost candidate today A', projectId: 'p-due-today', order: 1 }),
        base({ title: 'boost candidate today B', projectId: 'p-due-today', order: 0 }),
        base({ title: 'boost candidate overdue', projectId: 'p-due-overdue', order: 0 }),


        base({ title: 'tie', order: 100, priority: 'high' }),
        base({ title: 'tie', order: 100, priority: 'high' }),
        base({ title: 'tie', order: 100, priority: 'low' }),
        base({ title: 'tie', order: 100 }),
        base({ title: 'tie due today', order: 100, dueDate: '2026-06-06', priority: 'urgent' }),
        base({ title: 'tie due today', order: 100, dueDate: '2026-06-06', priority: 'low' }),
        base({ title: 'tie due today', order: 100, dueDate: '2026-06-06' }),


        base({ title: '中文任务一', order: 100, dueDate: '2026-06-06' }),
        base({ title: '中文任务二', order: 100, dueDate: '2026-06-06' }),
        base({ title: '漢字', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'Éclair', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'eclair', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'Eclair', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'éclair', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'ångström', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'Ångström', order: 100, dueDate: '2026-06-06' }),
        base({ title: '2 apples', order: 100, dueDate: '2026-06-06' }),
        base({ title: '10 apples', order: 100, dueDate: '2026-06-06' }),
        base({ title: '1 apple', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'ЖУРНАЛ', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'журнал', order: 100, dueDate: '2026-06-06' }),
        base({ title: 'مهمة', order: 100, dueDate: '2026-06-06' }),
        base({ title: '', order: 100, dueDate: '2026-06-06' }),


        base({ title: 'no order at all', dueDate: '2026-06-06' }),
        base({ title: 'legacy orderNum only', orderNum: 5, dueDate: '2026-06-06' }),
        base({ title: 'createdAt date-only', createdAt: '2026-06-01', dueDate: '2026-06-06' }),
    ];
    return { tasks, projects, sections };
}


type Snapshot = {
    poolIds: Record<string, string[]>;
    upcoming: Array<{ id: string; appearsAt: number }>;
    listIds: Record<string, string[]>;
    boosts: Array<[string, unknown]>;
    blocked: string[];
    sections: Array<{ key: string; title: string; ids: string[] }>;
};

const ids = (tasks: readonly Task[]) => tasks.map((task) => task.id);

function snapshot(pools: FocusPools, lists: FocusTaskLists, sections: ReturnType<typeof buildFocusTaskSections>): Snapshot {
    return {
        poolIds: {
            focused: ids(pools.focused),
            active: ids(pools.active),
            schedule: ids(pools.schedule),
            base: ids(pools.base),
        },
        upcoming: pools.upcoming.map((entry) => ({ id: entry.task.id, appearsAt: entry.appearsAt.getTime() })),
        listIds: {
            focusedTasks: ids(lists.focusedTasks),
            schedule: ids(lists.schedule),
            reviewDue: ids(lists.reviewDue),
            nextActions: ids(lists.nextActions),
            upcoming: ids(lists.upcoming),
        },
        boosts: [...lists.projectDeadlineBoosts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        blocked: [...lists.sequentialBlockedIds].sort(),
        sections: sections.map((section) => ({ key: section.key, title: section.title, ids: ids(section.items) })),
    };
}


const sectionTasks = (sections: ReturnType<typeof buildFocusTaskSections>): Task[] => (
    sections.flatMap((section) => section.items)
);

const TIMEZONES = ['UTC', 'America/New_York', 'Asia/Kolkata'];
const REFERENCE_TIMES = [
    '2026-06-06T12:00:00.000Z',
    '2026-06-06T03:30:00.000Z',
    '2026-06-06T23:45:00.000Z',
    '2026-03-08T07:30:00.000Z',
];

const generated = buildGeneratedStore(5000);
const edge = buildEdgeStore();
const pristine = JSON.stringify({ g: generated.tasks, e: edge.tasks });
const originalTz = process.env.TZ;

describe('Focus derivation parity with the pre-patch implementation', () => {
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    for (const timeZone of TIMEZONES) {
        describe(`TZ=${timeZone}`, () => {
            beforeAll(() => { process.env.TZ = timeZone; });

            for (const nowIso of REFERENCE_TIMES) {
                for (const sortBy of FOCUS_SORT_OPTIONS) {
                    for (const prioritiesEnabled of [true, false]) {
                        const label = `${nowIso} sortBy=${sortBy} priorities=${prioritiesEnabled ? 'on' : 'off'}`;

                        it(`matches on the hand-written edge store — ${label}`, () => {
                            expectParity(edge, nowIso, sortBy, prioritiesEnabled);
                        });
                    }
                }
            }


            for (const nowIso of REFERENCE_TIMES) {
                it(`matches on the generated 5,000-task store — ${nowIso} default sort`, () => {
                    expectParity(generated, nowIso, 'default', true);
                });
            }
            it('matches on the generated 5,000-task store — every sort option', () => {
                for (const sortBy of FOCUS_SORT_OPTIONS) {
                    expectParity(generated, REFERENCE_TIMES[0], sortBy, sortBy !== 'priority');
                }
            });
        });
    }

    it('leaves both stores byte-identical', () => {
        expect(JSON.stringify({ g: generated.tasks, e: edge.tasks })).toBe(pristine);
    });
});


describe('applyFilter short cut for empty criteria', () => {
    const emptyCriteriaValues = [
        undefined,
        {},

        { contexts: [] },
        { tags: [], statuses: [] },
        { contextMatchMode: 'all', tagMatchMode: 'all' },
        { priority: [], energy: [], areas: [], projects: [] },
        { assignedTo: [], locations: [], timeEstimates: [] },
        { dueDateRange: undefined, startDateRange: undefined, timeEstimateRange: {} },
        { hasDescription: undefined, isStarred: undefined },
    ];

    const realCriteriaValues = [
        { statuses: ['next'] },
        { tags: ['#admin'] },
        { contexts: ['@home'] },
        { isStarred: true },
        { hasDescription: false },
        { priority: ['high'] },
        { projects: ['p-seq'] },
    ];

    for (const store of [{ name: 'edge', value: edge }, { name: 'generated', value: generated }]) {
        for (const [index, criteria] of [...emptyCriteriaValues, ...realCriteriaValues].entries()) {
            it(`${store.name} store, criteria #${index} matches the full predicate`, () => {
                const options = { projects: store.value.projects, now: new Date(REFERENCE_TIMES[0]), tokenMatchMode: 'all' as const };
                const viaFullPath = store.value.tasks.filter(createTaskFilterPredicate(criteria as never, options));
                expect(applyFilter(store.value.tasks, criteria as never, options)).toEqual(viaFullPath);
            });
        }
    }
});

function expectParity(store: Store, nowIso: string, sortBy: SortField, prioritiesEnabled: boolean): void {
    const now = new Date(nowIso);


    const actionable = store.tasks.filter(isTaskActionable).map((task) => (
        task.isFocusedToday && isTaskFutureStart(task, now)
            ? { ...task, isFocusedToday: false }
            : task
    ));
    const poolsInput = {
        tasks: actionable,
        visibleTasks: actionable,
        projects: store.projects,
        criteria: undefined,
        now,
    };
    const ctx: FocusListContext = {
        now,
        projects: store.projects,
        sections: store.sections,
        sortBy,
        prioritiesEnabled,
    };

    const oldPools = frozenBuildFocusPools(poolsInput);
    const oldLists = frozenDeriveFocusTaskLists(oldPools, ctx);
    const oldSections = frozenBuildFocusTaskSections(oldLists, () => undefined);

    const newPools = buildFocusPools(poolsInput);
    const newLists = deriveFocusTaskLists(newPools, ctx);
    const newSections = buildFocusTaskSections(newLists, () => undefined);

    expect(snapshot(newPools, newLists, newSections)).toEqual(snapshot(oldPools, oldLists, oldSections));

    expect(sectionTasks(newSections)).toEqual(sectionTasks(oldSections));

    const oldItems = sectionTasks(oldSections);
    sectionTasks(newSections).forEach((task, index) => { expect(task).toBe(oldItems[index]); });
}
