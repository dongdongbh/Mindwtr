import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    buildTasksByProjectId,
    buildTrashTimeline,
    getProjectDeadlineBoosts,
    sortFocusNextActions,
    sortTasksBy,
} from './task-utils';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { buildEntityMap, computeTaskDerivedState } from './store-helpers';
import { computeSyncChangeFingerprint } from './sync-helpers';
import type {
    AppData,
    Area,
    Project,
    Section,
    Task,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';

type LargeStoreSize = 1_000 | 10_000 | 50_000;

type LargeStoreFixture = {
    areas: Area[];
    data: AppData;
    projectCount: number;
    projects: Project[];
    sections: Section[];
    selectedProjectId: string;
    targetTaskId: string;
    tasks: Task[];
    tasksById: Map<string, Task>;
};

type BudgetedOperationId =
    | 'projectDetailLookupAndSort'
    | 'taskDerivedState'
    | 'focusDerivation'
    | 'searchFilterSort'
    | 'syncChangeFingerprint';

type BudgetedOperation = {
    id: BudgetedOperationId;
    label: string;
    maxGrowthFrom10kTo50k: number;
    run: (fixture: LargeStoreFixture) => number;
};

const DATASET_SIZES: LargeStoreSize[] = [1_000, 10_000, 50_000];
const BASE_ISO = '2026-06-01T09:00:00.000Z';
const NOW = new Date('2026-06-06T12:00:00.000Z');
const SECTIONS_PER_PROJECT = 2;
const SEARCH_QUERY = 'alpha';

const CONTEXTS = ['@home', '@work', '@errands', '@calls', '@computer', '@deep-work'];
const TAGS = ['#admin', '#writing', '#health', '#finance', '#planning', '#follow-up'];
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVELS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
const TIME_ESTIMATES: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];

const GROWTH_BASELINE_FLOOR_MS = 5;

const LARGE_STORE_PERFORMANCE_BUDGETS_MS: Record<LargeStoreSize, Record<BudgetedOperationId, number>> = {
    1_000: {
        projectDetailLookupAndSort: 25,
        taskDerivedState: 50,
        focusDerivation: 40,
        searchFilterSort: 30,
        syncChangeFingerprint: 20,
    },
    10_000: {
        projectDetailLookupAndSort: 90,
        taskDerivedState: 250,
        focusDerivation: 500,
        searchFilterSort: 130,
        syncChangeFingerprint: 80,
    },
    50_000: {
        projectDetailLookupAndSort: 450,
        taskDerivedState: 1_200,
        focusDerivation: 2_500,
        searchFilterSort: 650,
        syncChangeFingerprint: 350,
    },
};

const STORE_MUTATION_BUDGETS_MS: Record<LargeStoreSize, number> = {
    1_000: 100,
    10_000: 250,
    50_000: 1_000,
};

const STORE_MUTATION_MAX_GROWTH_FROM_10K_TO_50K = 12;
const STORE_MUTATION_ATTEMPTS = 3;

// "Select all -> Move" hands batchUpdateTasks every visible task in one
// synchronous set(), the largest mutation a user can trigger.
const BATCH_MUTATION_BUDGETS_MS: Record<LargeStoreSize, number> = {
    1_000: 75,
    10_000: 250,
    50_000: 2_000,
};

const BATCH_MUTATION_MAX_GROWTH_FROM_10K_TO_50K = 15;
const BATCH_MUTATION_ATTEMPTS = 2;

function createProject(index: number, selectedProjectId: string): Project {
    const id = index === 0 ? selectedProjectId : `project-${index}`;
    return {
        id,
        title: index === 0 ? 'Selected Project' : `Project ${index}`,
        status: index % 19 === 0 ? 'waiting' : index % 23 === 0 ? 'someday' : 'active',
        color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][index % 5],
        order: index,
        tagIds: [TAGS[index % TAGS.length]],
        dueDate: index % 5 === 0 ? `2026-06-${String((index % 6) + 1).padStart(2, '0')}T17:00:00.000Z` : undefined,
        isFocused: index % 13 === 0,
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
    };
}

function createSection(project: Project, index: number): Section {
    return {
        id: `section-${project.id}-${index}`,
        projectId: project.id,
        title: `Section ${index + 1}`,
        order: index,
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
    };
}

function getSyntheticTaskStatus(index: number): TaskStatus {
    if (index % 29 === 0) return 'archived';
    if (index % 23 === 0) return 'reference';
    if (index % 11 === 0) return 'done';
    if (index % 7 === 0) return 'waiting';
    if (index % 5 === 0) return 'inbox';
    return 'next';
}

function createLargeStoreFixture(taskCount: LargeStoreSize): LargeStoreFixture {
    const selectedProjectId = 'project-selected';
    const projectCount = Math.max(40, Math.min(500, Math.floor(taskCount / 40)));
    const selectedProjectTaskCount = Math.min(2_000, Math.max(150, Math.floor(taskCount / 4)));
    const projects = Array.from({ length: projectCount }, (_, index) => createProject(index, selectedProjectId));
    const sections = projects.flatMap((project) => (
        Array.from({ length: SECTIONS_PER_PROJECT }, (_, index) => createSection(project, index))
    ));
    const tasks: Task[] = [];

    for (let index = 0; index < taskCount; index += 1) {
        const projectIndex = index < selectedProjectTaskCount
            ? 0
            : 1 + ((index - selectedProjectTaskCount) % Math.max(1, projectCount - 1));
        const project = projects[projectIndex];
        const section = sections[projectIndex * SECTIONS_PER_PROJECT + (index % SECTIONS_PER_PROJECT)];
        const status = getSyntheticTaskStatus(index);
        const titleToken = index % 17 === 0 ? ` ${SEARCH_QUERY}` : '';

        tasks.push({
            id: `task-${index}`,
            title: `Synthetic${titleToken} task ${index}`,
            status,
            priority: PRIORITIES[index % PRIORITIES.length],
            energyLevel: ENERGY_LEVELS[index % ENERGY_LEVELS.length],
            taskMode: index % 31 === 0 ? 'list' : 'task',
            startTime: index % 37 === 0 ? `2026-06-${String((index % 9) + 1).padStart(2, '0')}T08:00:00.000Z` : undefined,
            dueDate: index % 3 === 0 ? `2026-06-${String((index % 12) + 1).padStart(2, '0')}T17:00:00.000Z` : undefined,
            tags: [
                TAGS[index % TAGS.length],
                TAGS[(index + 3) % TAGS.length],
            ],
            contexts: [CONTEXTS[index % CONTEXTS.length]],
            checklist: index % 41 === 0
                ? [
                    { id: `check-${index}-1`, title: 'First step', isCompleted: index % 2 === 0 },
                    { id: `check-${index}-2`, title: 'Second step', isCompleted: false },
                ]
                : undefined,
            projectId: project.id,
            sectionId: section.id,
            areaId: `area-${index % 5}`,
            isFocusedToday: index % 97 === 0,
            timeEstimate: TIME_ESTIMATES[index % TIME_ESTIMATES.length],
            completedAt: status === 'done' || status === 'archived' ? '2026-06-02T09:00:00.000Z' : undefined,
            deletedAt: index % 503 === 0 ? '2026-06-03T09:00:00.000Z' : undefined,
            order: index,
            orderNum: index,
            createdAt: BASE_ISO,
            updatedAt: `2026-06-${String((index % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
            rev: 1,
            revBy: 'perf-suite',
        });
    }

    const areas: Area[] = Array.from({ length: 5 }, (_, index) => ({
        id: `area-${index}`,
        name: `Area ${index}`,
        order: index,
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
        rev: 1,
        revBy: 'perf-suite',
    }));
    const tasksById = new Map<string, Task>();
    tasks.forEach((task) => {
        tasksById.set(task.id, task);
    });
    const data: AppData = {
        tasks,
        projects,
        sections,
        areas,
        people: [],
        settings: {
            deviceId: 'perf-suite',
            migrations: {
                version: 9999,
                lastAutoArchiveAt: NOW.toISOString(),
                lastTombstoneCleanupAt: NOW.toISOString(),
            },
            gtd: {
                taskEditor: { defaultsVersion: 9999 },
                focusGroupByDefaultsVersion: 1,
            },
        },
    };

    return {
        areas,
        data,
        projectCount,
        projects,
        sections,
        selectedProjectId,
        targetTaskId: tasks[Math.floor(taskCount * 0.73)].id,
        tasks,
        tasksById,
    };
}

function measureBest(operation: () => number, attempts = 3): { durationMs: number; value: number } {
    let bestDurationMs = Number.POSITIVE_INFINITY;
    let bestValue = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const startedAt = performance.now();
        const value = operation();
        const durationMs = performance.now() - startedAt;
        if (durationMs < bestDurationMs) {
            bestDurationMs = durationMs;
            bestValue = value;
        }
    }

    return { durationMs: bestDurationMs, value: bestValue };
}

const PERF_MEASUREMENTS_PATH = '.perf/measurements.json';

type PerfMeasurement = { actualMs: number; budgetMs: number; label: string; size: LargeStoreSize };

const perfMeasurements: PerfMeasurement[] = [];

function expectWithinBudget(label: string, size: LargeStoreSize, actualMs: number, budgetMs: number) {
    perfMeasurements.push({ actualMs, budgetMs, label, size });
    expect(
        actualMs,
        `${label} took ${actualMs.toFixed(2)}ms with ${size.toLocaleString()} tasks; budget is ${budgetMs}ms`,
    ).toBeLessThanOrEqual(budgetMs);
}

const operations: BudgetedOperation[] = [
    {
        id: 'projectDetailLookupAndSort',
        label: 'Project detail lookup and sort',
        maxGrowthFrom10kTo50k: 12,
        run: (fixture) => {
            const tasksByProjectId = buildTasksByProjectId(fixture.tasks);
            const selectedProjectTasks = tasksByProjectId.get(fixture.selectedProjectId) ?? [];
            return sortTasksBy(selectedProjectTasks, 'due').slice(0, 100).length;
        },
    },
    {
        id: 'taskDerivedState',
        label: 'Production task-derived state',
        maxGrowthFrom10kTo50k: 8,
        run: (fixture) => {
            const derived = computeTaskDerivedState(fixture.tasks, fixture.tasksById);
            return derived.tasksById.size + derived.projectTaskSummaryById.size;
        },
    },
    {
        id: 'focusDerivation',
        label: 'Focus derivation',
        maxGrowthFrom10kTo50k: 12,
        run: (fixture) => {
            const projectDeadlineBoosts = getProjectDeadlineBoosts(fixture.tasks, fixture.projects, { now: NOW });
            const candidateTasks = fixture.tasks.filter((task) => !task.deletedAt && task.status === 'next');
            return sortFocusNextActions(candidateTasks, {
                now: NOW,
                projectDeadlineBoosts,
                projects: fixture.projects,
            }).slice(0, 100).length;
        },
    },
    {
        id: 'searchFilterSort',
        label: 'Search/filter/sort derivation',
        maxGrowthFrom10kTo50k: 12,
        run: (fixture) => {
            const filteredTasks = fixture.tasks.filter((task) => (
                !task.deletedAt &&
                task.status !== 'archived' &&
                task.title.toLowerCase().includes(SEARCH_QUERY)
            ));
            return sortTasksBy(filteredTasks, 'updated').slice(0, 100).length;
        },
    },
    {
        id: 'syncChangeFingerprint',
        label: 'Production sync-change fingerprint',
        maxGrowthFrom10kTo50k: 8,
        run: (fixture) => computeSyncChangeFingerprint(fixture.data).length,
    },
];

const describePerf = process.env.MINDWTR_PERF_TEST === '1' ? describe : describe.skip;

describePerf('large-store performance budgets', () => {
    afterAll(() => {
        mkdirSync(dirname(PERF_MEASUREMENTS_PATH), { recursive: true });
        writeFileSync(PERF_MEASUREMENTS_PATH, JSON.stringify(perfMeasurements, null, 2));
    });

    it('builds a 5k-item Trash timeline within budget', () => {
        const fixture = createLargeStoreFixture(10_000);
        const tasks = fixture.tasks.slice(0, 4_750).map((task, index) => ({
            ...task,
            deletedAt: new Date(Date.parse(BASE_ISO) + index * 1_000).toISOString(),
            purgedAt: undefined,
        }));
        const projects = fixture.projects.slice(0, 250).map((project, index) => ({
            ...project,
            deletedAt: new Date(Date.parse(BASE_ISO) + (index + tasks.length) * 1_000).toISOString(),
            purgedAt: undefined,
        }));

        const result = measureBest(() => buildTrashTimeline(tasks, projects).length);

        expect(result.value).toBe(5_000);
        expectWithinBudget('Trash timeline derivation', 10_000, result.durationMs, 100);
    });

    it('keeps generated core hot paths within explicit budgets', () => {
        const measurements = new Map<BudgetedOperationId, Map<LargeStoreSize, number>>();

        DATASET_SIZES.forEach((size) => {
            const fixture = createLargeStoreFixture(size);

            expect(fixture.tasks).toHaveLength(size);
            expect(fixture.projects).toHaveLength(fixture.projectCount);

            operations.forEach((operation) => {
                const result = measureBest(() => operation.run(fixture));
                expect(result.value, `${operation.label} should produce a non-empty result`).toBeGreaterThan(0);
                expectWithinBudget(
                    operation.label,
                    size,
                    result.durationMs,
                    LARGE_STORE_PERFORMANCE_BUDGETS_MS[size][operation.id],
                );

                const operationMeasurements = measurements.get(operation.id) ?? new Map<LargeStoreSize, number>();
                operationMeasurements.set(size, result.durationMs);
                measurements.set(operation.id, operationMeasurements);
            });
        });

        operations.forEach((operation) => {
            const operationMeasurements = measurements.get(operation.id);
            const tenKDuration = operationMeasurements?.get(10_000);
            const fiftyKDuration = operationMeasurements?.get(50_000);
            if (tenKDuration === undefined || fiftyKDuration === undefined) {
                throw new Error(`Missing measurements for ${operation.label}`);
            }

            const growth = fiftyKDuration / Math.max(tenKDuration, GROWTH_BASELINE_FLOOR_MS);
            expect(
                growth,
                `${operation.label} grew ${growth.toFixed(2)}x from 10k to 50k tasks; max allowed is ${operation.maxGrowthFrom10kTo50k}x`,
            ).toBeLessThanOrEqual(operation.maxGrowthFrom10kTo50k);
        });
    }, 30_000);

    it('keeps sync-change fingerprints deterministic and sensitive at every budgeted size', () => {
        DATASET_SIZES.forEach((size) => {
            const fixture = createLargeStoreFixture(size);
            const first = computeSyncChangeFingerprint(fixture.data);
            const second = computeSyncChangeFingerprint(fixture.data);
            const targetIndex = fixture.tasks.findIndex((task) => task.id === fixture.targetTaskId);
            if (targetIndex < 0) throw new Error(`Missing target task ${fixture.targetTaskId}`);
            const changedTasks = fixture.tasks.slice();
            changedTasks[targetIndex] = {
                ...changedTasks[targetIndex],
                rev: (changedTasks[targetIndex].rev ?? 0) + 1,
                updatedAt: '2026-06-06T12:30:00.000Z',
            };

            expect(second, `${size.toLocaleString()}-task aligned data should remain a no-op`).toBe(first);
            expect(computeSyncChangeFingerprint({ ...fixture.data, tasks: changedTasks })).not.toBe(first);
        });
    });

    it('keeps an unchanged 50k-task preloaded refresh subscriber-free and within budget', async () => {
        const fixture = createLargeStoreFixture(50_000);
        resetForTests();
        setStorageAdapter({
            getData: async () => fixture.data,
            saveData: async () => undefined,
        });
        useTaskStore.setState({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
            isLoading: false,
            error: null,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            _tasksById: new Map(),
            _projectsById: new Map(),
            _sectionsById: new Map(),
            _areasById: new Map(),
            _peopleById: new Map(),
            lastDataChangeAt: 0,
        });

        let unsubscribe = () => undefined;
        try {
            await useTaskStore.getState().fetchData({ silent: true });
            await flushPendingSave();
            const loaded = useTaskStore.getState();
            let subscriberCalls = 0;
            unsubscribe = useTaskStore.subscribe(() => {
                subscriberCalls += 1;
            });

            const startedAt = performance.now();
            await loaded.fetchData({
                silent: true,
                preloadedData: {
                    tasks: loaded._allTasks,
                    projects: loaded._allProjects,
                    sections: loaded._allSections,
                    areas: loaded._allAreas,
                    people: loaded._allPeople,
                    settings: loaded.settings,
                },
            });
            const durationMs = performance.now() - startedAt;

            expect(subscriberCalls).toBe(0);
            expect(useTaskStore.getState()).toBe(loaded);
            expectWithinBudget('Unchanged preloaded refresh', 50_000, durationMs, 2_000);
        } finally {
            unsubscribe();
            await flushPendingSave();
            resetForTests();
        }
    });

    it('moves every task through the production batch path within absolute and growth budgets', async () => {
        const measurements = new Map<LargeStoreSize, number>();

        for (const size of DATASET_SIZES) {
            const fixture = createLargeStoreFixture(size);
            const ids = fixture.tasks.map((task) => task.id);
            let bestDurationMs = Number.POSITIVE_INFINITY;

            for (let attempt = 0; attempt < BATCH_MUTATION_ATTEMPTS; attempt += 1) {
                resetForTests();
                setStorageAdapter({
                    getData: async () => fixture.data,
                    saveData: async () => undefined,
                });
                useTaskStore.setState({
                    tasks: fixture.tasks,
                    projects: fixture.projects,
                    sections: fixture.sections,
                    areas: fixture.areas,
                    people: [],
                    settings: fixture.data.settings,
                    isLoading: false,
                    error: null,
                    _allTasks: fixture.tasks,
                    _allProjects: fixture.projects,
                    _allSections: fixture.sections,
                    _allAreas: fixture.areas,
                    _allPeople: [],
                    _tasksById: buildEntityMap(fixture.tasks),
                    _projectsById: buildEntityMap(fixture.projects),
                    _sectionsById: buildEntityMap(fixture.sections),
                    _areasById: buildEntityMap(fixture.areas),
                    _peopleById: new Map(),
                });

                try {
                    const startedAt = performance.now();
                    const result = await useTaskStore.getState().batchMoveTasks(ids, 'next');
                    const durationMs = performance.now() - startedAt;
                    await flushPendingSave();

                    expect(result).toEqual({ success: true });
                    const moved = useTaskStore.getState()._allTasks;
                    expect(moved).toHaveLength(size);
                    expect(moved.every((task) => task.status === 'next')).toBe(true);
                    bestDurationMs = Math.min(bestDurationMs, durationMs);
                } finally {
                    await flushPendingSave();
                    resetForTests();
                }
            }

            expectWithinBudget(
                'Production select-all batch move',
                size,
                bestDurationMs,
                BATCH_MUTATION_BUDGETS_MS[size],
            );
            measurements.set(size, bestDurationMs);
        }

        const tenKDuration = measurements.get(10_000);
        const fiftyKDuration = measurements.get(50_000);
        if (tenKDuration === undefined || fiftyKDuration === undefined) {
            throw new Error('Missing production batch mutation measurements');
        }
        const growth = fiftyKDuration / Math.max(tenKDuration, GROWTH_BASELINE_FLOOR_MS);
        expect(
            growth,
            `Production batch mutation grew ${growth.toFixed(2)}x from 10k to 50k tasks; max allowed is ${BATCH_MUTATION_MAX_GROWTH_FROM_10K_TO_50K}x`,
        ).toBeLessThanOrEqual(BATCH_MUTATION_MAX_GROWTH_FROM_10K_TO_50K);
    }, 180_000);

    it('persists one task through the production incremental path within absolute and growth budgets', async () => {
        const measurements = new Map<LargeStoreSize, number>();

        for (const size of DATASET_SIZES) {
            const fixture = createLargeStoreFixture(size);
            let bestDurationMs = Number.POSITIVE_INFINITY;

            for (let attempt = 0; attempt < STORE_MUTATION_ATTEMPTS; attempt += 1) {
                let saveDataCalls = 0;
                let savedTask: Task | null = null;
                resetForTests();
                setStorageAdapter({
                    getData: async () => fixture.data,
                    saveData: async () => {
                        saveDataCalls += 1;
                    },
                    saveTask: async (task) => {
                        savedTask = task;
                    },
                });
                useTaskStore.setState({
                    tasks: fixture.tasks,
                    projects: fixture.projects,
                    sections: fixture.sections,
                    areas: fixture.areas,
                    people: [],
                    settings: fixture.data.settings,
                    isLoading: false,
                    error: null,
                    _allTasks: fixture.tasks,
                    _allProjects: fixture.projects,
                    _allSections: fixture.sections,
                    _allAreas: fixture.areas,
                    _allPeople: [],
                    _tasksById: buildEntityMap(fixture.tasks),
                    _projectsById: buildEntityMap(fixture.projects),
                    _sectionsById: buildEntityMap(fixture.sections),
                    _areasById: buildEntityMap(fixture.areas),
                    _peopleById: new Map(),
                });

                try {
                    const startedAt = performance.now();
                    const result = await useTaskStore.getState().updateTask(fixture.targetTaskId, {
                        title: `Incrementally persisted task at ${size}`,
                    });
                    const durationMs = performance.now() - startedAt;
                    await flushPendingSave();

                    expect(result).toEqual({ success: true });
                    expect(savedTask).toMatchObject({
                        id: fixture.targetTaskId,
                        title: `Incrementally persisted task at ${size}`,
                    });
                    expect(saveDataCalls).toBe(0);
                    bestDurationMs = Math.min(bestDurationMs, durationMs);
                } finally {
                    await flushPendingSave();
                    resetForTests();
                }
            }

            expectWithinBudget(
                'Production one-task store mutation',
                size,
                bestDurationMs,
                STORE_MUTATION_BUDGETS_MS[size],
            );
            measurements.set(size, bestDurationMs);
        }

        const tenKDuration = measurements.get(10_000);
        const fiftyKDuration = measurements.get(50_000);
        if (tenKDuration === undefined || fiftyKDuration === undefined) {
            throw new Error('Missing production store mutation measurements');
        }
        const growth = fiftyKDuration / Math.max(tenKDuration, GROWTH_BASELINE_FLOOR_MS);
        expect(
            growth,
            `Production store mutation grew ${growth.toFixed(2)}x from 10k to 50k tasks; max allowed is ${STORE_MUTATION_MAX_GROWTH_FROM_10K_TO_50K}x`,
        ).toBeLessThanOrEqual(STORE_MUTATION_MAX_GROWTH_FROM_10K_TO_50K);
    });
});
