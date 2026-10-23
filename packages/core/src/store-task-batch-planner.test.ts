import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as helpers from './store-helpers';
import { reserveTaskContainerProjectOrder } from './task-container-rules';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { planTaskBatchUpdateEffects, prepareTaskBatchUpdatesForStore, prepareTaskUpdatesForStore } from './store-tasks';
import type { AppData, Project, Section, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';

const ids = vi.hoisted(() => ({ count: 0 }));
vi.mock('./uuid', () => ({ generateUUID: () => `batch-followup-${++ids.count}` }));

const CREATED = '2026-09-08T08:00:00.000Z';
const ARCHIVED = '2026-09-09T09:00:00.000Z';
const NOW = '2026-10-02T12:00:00.000Z';
const DEVICE = 'batch-device';
type Update = { id: string; updates: Partial<Task> };
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, status: 'archived', tags: [], contexts: [], pushCount: 0,
    createdAt: CREATED, updatedAt: ARCHIVED, completedAt: ARCHIVED, archivedAt: ARCHIVED,
    rev: 2, revBy: DEVICE, ...overrides,
});
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
    id, title: `Project ${id}`, status: 'archived', order: 0, color: '#123456', tagIds: [],
    createdAt: CREATED, updatedAt: ARCHIVED, archivedAt: ARCHIVED, completedAt: ARCHIVED,
    rev: 2, revBy: DEVICE, ...overrides,
});
const section = (id: string, projectId: string, overrides: Partial<Section> = {}): Section => ({
    id, projectId, title: `Section ${id}`, order: 0, createdAt: CREATED, updatedAt: ARCHIVED,
    deletedAt: ARCHIVED, projectArchivedAt: ARCHIVED, rev: 2, revBy: DEVICE, ...overrides,
});
const provenance: Partial<Task> = {
    projectArchivedAt: ARCHIVED, statusBeforeProjectArchive: 'next',
    completedAtBeforeProjectArchive: CREATED, isFocusedTodayBeforeProjectArchive: true,
};
const clone = <T>(value: T): T => structuredClone(value);
const data = (tasks: Task[], projects: Project[] = [], sections: Section[] = []): AppData => ({
    tasks, projects, sections, areas: [], people: [], settings: { deviceId: DEVICE },
});
const load = (initial: AppData): void => {
    useTaskStore.setState({
        tasks: initial.tasks, projects: initial.projects, sections: initial.sections,
        areas: initial.areas, people: initial.people ?? [], settings: initial.settings,
        _allTasks: initial.tasks, _allProjects: initial.projects, _allSections: initial.sections,
        _allAreas: initial.areas, _allPeople: initial.people ?? [],
        _tasksById: helpers.buildEntityMap(initial.tasks),
        _projectsById: helpers.buildEntityMap(initial.projects),
        _sectionsById: helpers.buildEntityMap(initial.sections),
        _areasById: helpers.buildEntityMap(initial.areas),
        _peopleById: helpers.buildEntityMap(initial.people ?? []),
        persistenceFailure: null, error: null, isLoading: false, lastDataChangeAt: 0,
    });
};

// Frozen pre-extraction RN loop. This stays independent of the new batch helper
// so changing its application order, lazy dedupe or parent transition is caught.
const legacyEffects = (initial: AppData, requests: Update[]) => {
    const prepared = new Map<string, Partial<Task>>();
    for (const request of requests) {
        const source = initial.tasks.find((item) => item.id === request.id)!;
        const result = prepareTaskUpdatesForStore({
            task: source, updates: request.updates, allProjects: initial.projects,
            allSections: initial.sections, allAreas: initial.areas, settings: initial.settings,
            reserveProjectOrder: false,
        });
        if (!result.ok) throw new Error(result.error);
        prepared.set(request.id, result.updates);
    }
    const base = [...initial.tasks];
    const createdTasks: Task[] = [];
    const reactivations: Array<{ task: Task; updates: Partial<Task> }> = [];
    const reserveOrder = helpers.createProjectOrderReserver(base);
    for (let index = 0; index < initial.tasks.length; index += 1) {
        const source = base[index];
        const patch = prepared.get(source.id);
        if (!patch) continue;
        const adjusted = reserveTaskContainerProjectOrder({ task: source, updates: patch, projectOrderReserver: reserveOrder });
        reactivations.push({ task: source, updates: adjusted });
        const effect = helpers.applyTaskUpdates(source, {
            ...adjusted, rev: helpers.nextRevision(source.rev), revBy: DEVICE,
        }, NOW);
        const candidate = helpers.stampNewRecurringFollowUp(effect.nextRecurringTask, DEVICE, helpers.getTaskOrder(source), reserveOrder);
        if (candidate && !helpers.findExistingRecurringFollowUp([...base, ...createdTasks], candidate, source.id)) {
            createdTasks.push(candidate);
        }
        base[index] = effect.updatedTask;
    }
    const result = helpers.applyTaskProjectReactivationTransition(
        reactivations, createdTasks.length ? [...base, ...createdTasks] : base,
        initial.projects, initial.sections, NOW, DEVICE,
    );
    return { ...result, createdTasks };
};

const plan = (initial: AppData, requests: Update[]) => {
    load(initial);
    const prepared = prepareTaskBatchUpdatesForStore({ updatesList: requests, state: useTaskStore.getState() });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.optimisticRetryProjectIds).toEqual([]);
    return planTaskBatchUpdateEffects({
        preparedUpdatesById: prepared.preparedUpdatesById, allTasks: initial.tasks,
        allProjects: initial.projects, allSections: initial.sections, now: NOW, deviceId: DEVICE,
    });
};

describe('shared batch task planner', () => {
    beforeEach(() => {
        resetForTests();
        ids.count = 0;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
        setStorageAdapter({ getData: async () => data([]), saveData: async () => undefined });
    });
    afterEach(() => { resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

    it('matches the legacy batch and actual RN whole snapshot for rich cancelled/archive rows across parents', async () => {
        const initial = data([
            task('second', { projectId: 'p2', sectionId: 's2', order: 3, orderNum: 3, ...provenance,
                completedAt: undefined, cancelledAt: ARCHIVED, description: 'Retained note',
                checklist: [{ id: 'check', title: 'Step', isCompleted: true }],
                recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
                dueDate: '2026-10-04', startTime: '2026-10-03', relativeStartOffset: { amount: 1, unit: 'day' },
                timeSpentMinutes: 45, reviewAt: '2026-10-05', tags: ['tag'], contexts: ['context'],
            }),
            task('first', { projectId: 'p1', sectionId: 's1', order: 4, orderNum: 4, ...provenance }),
            task('sibling', { projectId: 'p1', ...provenance }),
            task('deleted-sibling', { projectId: 'p2', deletedAt: ARCHIVED, ...provenance }),
            task('unrelated', { projectId: 'untouched', ...provenance }),
        ], [project('p1'), project('p2', { cancelledAt: ARCHIVED, completedAt: undefined }), project('untouched')], [
            section('s1', 'p1'), section('s2', 'p2'),
            section('edited-section', 'p1', { updatedAt: CREATED }), section('unrelated-section', 'untouched'),
        ]);
        initial.areas = [{ id: 'area', name: 'Area', order: 1, createdAt: CREATED, updatedAt: CREATED }];
        initial.people = [{ id: 'person', name: 'Person', createdAt: CREATED, updatedAt: CREATED }];
        initial.settings = { deviceId: DEVICE, gtd: { autoArchiveDays: 7 }, theme: 'dark' };
        const before = clone(initial);
        const requests: Update[] = [{ id: 'first', updates: { status: 'inbox' } }, { id: 'second', updates: { status: 'inbox' } }];
        const expected = legacyEffects(initial, requests);
        const planned = plan(initial, requests);
        expect(planned).toEqual(expected);
        expect(initial).toEqual(before);
        expect(planned.createdTasks).toEqual([]);
        expect(planned.reactivatedProjectIds).toEqual(['p2', 'p1']);
        expect(planned.tasks.slice(0, 2).map((item) => [item.status, item.completedAt, item.cancelledAt, item.archivedAt]))
            .toEqual([['inbox', undefined, undefined, undefined], ['inbox', undefined, undefined, undefined]]);
        expect(planned.projects.map((item) => [item.status, item.rev])).toEqual([['active', 3], ['active', 3], ['archived', 2]]);
        expect(planned.tasks.find((item) => item.id === 'deleted-sibling')?.projectArchivedAt).toBeUndefined();
        expect(planned.sections.find((item) => item.id === 'edited-section')?.deletedAt).toBe(ARCHIVED);
        load(clone(initial));
        await expect(useTaskStore.getState().batchMoveTasks(requests.map((item) => item.id), 'inbox')).resolves.toEqual({ success: true });
        await flushPendingSave();
        expect(helpers.buildSaveSnapshot(useTaskStore.getState())).toEqual({
            ...initial, tasks: planned.tasks, projects: planned.projects, sections: planned.sections,
            settings: retainTaxonomyEffects(initial.settings, initial.tasks.filter(row => requests.some(request => request.id === row.id))
                .map(before => ({ before, after: planned.tasks.find(row => row.id === before.id)! }))),
        });
    });

    it('reserves sequential destination orders in storage order rather than request order', async () => {
        const initial = data([
            task('storage-first', { projectId: 'old', sectionId: 'old-section', order: 0 }),
            task('storage-second', { projectId: 'old', sectionId: 'old-section', order: 1 }),
            task('existing', { projectId: 'destination', order: 5, orderNum: 5, status: 'next' }),
        ], [project('old'), project('destination', { status: 'active' })], [section('old-section', 'old')]);
        const requests: Update[] = ['storage-second', 'storage-first'].map((id) => ({ id, updates: { status: 'next', projectId: 'destination' } }));
        const planned = plan(initial, requests);
        expect(planned).toEqual(legacyEffects(initial, requests));
        expect(planned.tasks.slice(0, 2).map((item) => [item.id, item.order, item.orderNum, item.sectionId]))
            .toEqual([['storage-first', 6, 6, undefined], ['storage-second', 7, 7, undefined]]);
        load(clone(initial));
        await expect(useTaskStore.getState().batchUpdateTasks(requests)).resolves.toEqual({ success: true });
        expect(helpers.buildSaveSnapshot(useTaskStore.getState())).toEqual({ ...initial, tasks: planned.tasks });
    });

    it.each([
        ['cancellation before duplicate/missing', [{ id: 'missing', updates: { cancelledAt: 'bad' } }, { id: 'missing', updates: {} }], 'Cancellation timestamp must be an ISO datetime with timezone'],
        ['duplicate before missing', [{ id: 'missing', updates: {} }, { id: 'missing', updates: {} }], 'Duplicate task ids in batch update: missing'],
        ['missing before container', [{ id: 'selected', updates: { projectId: 'unknown' } }, { id: 'missing', updates: {} }], 'Tasks not found: missing'],
        ['container atomicity', [{ id: 'selected', updates: { title: 'Changed' } }, { id: 'other', updates: { projectId: 'unknown' } }], 'Project not found'],
    ] as Array<[string, Update[], string]>)('preserves preflight error precedence and no mutations: %s', async (_name, requests, error) => {
        const initial = data([task('selected'), task('other')]);
        load(initial);
        const storage = { getData: async () => clone(initial), saveData: vi.fn(async () => undefined) };
        setStorageAdapter(storage);
        const before = clone(initial);
        expect(prepareTaskBatchUpdatesForStore({ updatesList: requests, state: useTaskStore.getState() })).toEqual({ ok: false, error });
        await expect(useTaskStore.getState().batchUpdateTasks(requests)).resolves.toEqual({ success: false, error });
        expect(helpers.buildSaveSnapshot(useTaskStore.getState())).toEqual(before);
        expect(storage.saveData).not.toHaveBeenCalled();
    });

    it('keeps unchanged optimistic project retries before normalization and revision stamping', async () => {
        const initial = data([task('selected', { status: 'inbox', projectId: 'p', completedAt: undefined, archivedAt: undefined })], [project('p', { status: 'active' })]);
        load(initial);
        useTaskStore.setState({ persistenceFailure: { message: 'Earlier snapshot failed', failedAt: NOW, retrying: false } });
        const requests: Update[] = [{ id: 'selected', updates: { status: 'inbox' } }];
        const prepared = prepareTaskBatchUpdatesForStore({ updatesList: requests, state: useTaskStore.getState() });
        expect(prepared).toEqual({ ok: true, preparedUpdatesById: new Map(), optimisticRetryProjectIds: ['p'] });
        const storage = { getData: async () => clone(initial), saveData: vi.fn(async () => undefined) };
        setStorageAdapter(storage);
        await expect(useTaskStore.getState().batchUpdateTasks(requests)).resolves.toEqual({ success: true });
        expect(storage.saveData).toHaveBeenCalledTimes(1);
        expect(helpers.buildSaveSnapshot(useTaskStore.getState())).toEqual(initial);
    });

    it('retains lazy recurrence candidate dedupe against the partially updated source array', async () => {
        const initial = data([
            task('first', { status: 'next', completedAt: undefined, archivedAt: undefined, recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'same-series' }, dueDate: '2026-10-02', title: 'Series' }),
            task('second', { status: 'next', completedAt: undefined, archivedAt: undefined, recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'same-series' }, dueDate: '2026-10-02', title: 'Series' }),
        ]);
        const requests: Update[] = [{ id: 'second', updates: { status: 'done' } }, { id: 'first', updates: { status: 'done' } }];
        ids.count = 0;
        const expected = legacyEffects(initial, requests);
        ids.count = 0;
        const planned = plan(initial, requests);
        expect(planned).toEqual(expected);
        expect(planned.createdTasks).toHaveLength(1);
        expect(planned.tasks.map((item) => item.id)).toEqual(['first', 'second', 'batch-followup-1']);
        ids.count = 0;
        load(clone(initial));
        await expect(useTaskStore.getState().batchUpdateTasks(requests)).resolves.toEqual({ success: true });
        expect(helpers.buildSaveSnapshot(useTaskStore.getState()).tasks).toEqual(planned.tasks);
    });

    it('never scans or repeatedly copies the 5k task collection for non-recurring Archive restores', () => {
        const initial = data(Array.from({ length: 5_000 }, (_, index) => task(`task-${index}`)));
        const requests: Update[] = initial.tasks.map((item) => ({ id: item.id, updates: { status: 'inbox' } }));
        load(initial);
        const prepared = prepareTaskBatchUpdatesForStore({ updatesList: requests, state: useTaskStore.getState() });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) return;
        const dedupe = vi.spyOn(helpers, 'findExistingRecurringFollowUp');
        const reactivation = vi.spyOn(helpers, 'applyTaskProjectReactivationTransition');
        const originalIterator = Array.prototype[Symbol.iterator];
        let largeArrayIterations = 0;
        Array.prototype[Symbol.iterator] = function (this: unknown[]) {
            if (this.length >= 5_000) largeArrayIterations += this.length;
            return originalIterator.call(this);
        };
        let planned: ReturnType<typeof planTaskBatchUpdateEffects>;
        try {
            planned = planTaskBatchUpdateEffects({
                preparedUpdatesById: prepared.preparedUpdatesById, allTasks: initial.tasks,
                allProjects: [], allSections: [], now: NOW, deviceId: DEVICE,
            });
        } finally { Array.prototype[Symbol.iterator] = originalIterator; }
        expect(planned!.tasks).toHaveLength(5_000);
        expect(planned!.createdTasks).toEqual([]);
        expect(dedupe).not.toHaveBeenCalled();
        expect(reactivation).toHaveBeenCalledTimes(1);
        expect(largeArrayIterations).toBeLessThanOrEqual(5_000 * 4);
        expect(planned!.tasks.every((item) => item.status === 'inbox' && item.rev === 3)).toBe(true);
    });
});
