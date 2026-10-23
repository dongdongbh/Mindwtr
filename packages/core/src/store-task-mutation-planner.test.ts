import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEntityMap, buildSaveSnapshot, nextRevision } from './store-helpers';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { planTaskMutations, sanitizeRestoredTaskContainerReferences } from './store-tasks';
import { compactPurgedTaskForLocalStorage } from './tombstone-compaction';
import { mapSqliteTaskRow, TASK_SQLITE_COLUMNS, taskToSqliteRow } from './sqlite-adapter';
import { normalizeTaskForLoad } from './task-status';
import { retainTaxonomyEffects } from './taxonomy-catalog';
import type { AppData, Project, Section, Task } from './types';

const CREATED = '2026-09-01T12:00:00.000Z';
const HISTORY = '2026-09-25T12:34:56.789Z';
const DELETE_AT = '2026-10-02T13:00:00.000Z';
const RESTORE_AT = '2026-10-02T13:05:00.000Z';
const DEVICE = 'mutation-device';
const clone = <T>(input: T): T => structuredClone(input);
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, status: 'archived', tags: ['#retained'], contexts: ['@retained'],
    createdAt: CREATED, updatedAt: HISTORY, completedAt: HISTORY, archivedAt: HISTORY,
    rev: 3, revBy: 'previous-device', pushCount: 0, ...overrides,
});
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
    id, title: `Project ${id}`, status: 'active', color: '#123456', order: 0, tagIds: [],
    createdAt: CREATED, updatedAt: HISTORY, rev: 2, revBy: DEVICE, ...overrides,
});
const section = (id: string, projectId: string, overrides: Partial<Section> = {}): Section => ({
    id, projectId, title: `Section ${id}`, order: 0, createdAt: CREATED, updatedAt: HISTORY,
    rev: 2, revBy: DEVICE, ...overrides,
});
const data = (tasks: Task[]): AppData => ({
    tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: DEVICE, theme: 'dark' },
});
const load = (initial: AppData): void => {
    useTaskStore.setState({
        tasks: initial.tasks, projects: initial.projects, sections: initial.sections,
        areas: initial.areas, people: initial.people ?? [], settings: initial.settings,
        _allTasks: initial.tasks, _allProjects: initial.projects, _allSections: initial.sections,
        _allAreas: initial.areas, _allPeople: initial.people ?? [],
        _tasksById: buildEntityMap(initial.tasks), _projectsById: buildEntityMap(initial.projects),
        _sectionsById: buildEntityMap(initial.sections), _areasById: buildEntityMap(initial.areas),
        _peopleById: buildEntityMap(initial.people ?? []), error: null, persistenceFailure: null,
        isLoading: false, lastDataChangeAt: 0,
    });
};
const snapshot = () => clone(buildSaveSnapshot(useTaskStore.getState()));

// Exact pre-extraction changed-row formula, independent of the new helper.
const legacyRows = <TState>(tasks: readonly Task[], state: TState,
    buildUpdates: (task: Task, context: { now: string; state: TState }) => Partial<Task>, now: string, deviceId = DEVICE): Task[] =>
    tasks.map((source) => compactPurgedTaskForLocalStorage({
        ...source, ...buildUpdates(source, { now, state }),
        updatedAt: now, rev: nextRevision(source.rev), revBy: deviceId,
    }));
const overlay = (initial: AppData, changed: Task[]): AppData => {
    const byId = new Map(changed.map((row) => [row.id, row]));
    // The row-only planner excludes the store writer's independent catalog retention.
    return { ...initial, tasks: initial.tasks.map((row) => byId.get(row.id) ?? row),
        settings: retainTaxonomyEffects(initial.settings, changed.map(after => ({
            before: initial.tasks.find(row => row.id === after.id), after,
        }))) };
};
const restoreContext = (initial: AppData) => ({
    _allProjects: initial.projects, _allSections: initial.sections, _allAreas: initial.areas,
});
const restorePatch = (source: Task, { state }: { state: ReturnType<typeof restoreContext> }): Partial<Task> => ({
    deletedAt: undefined, ...sanitizeRestoredTaskContainerReferences(source, state),
});

describe('shared task mutation row planner', () => {
    beforeEach(() => {
        resetForTests(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(DELETE_AT));
        setStorageAdapter({ getData: async () => data([]), saveData: async () => undefined });
    });
    afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

    it('matches the exact old formula, forwards frozen narrow context, and preserves stamping/compaction precedence', () => {
        const selected = [task('rich'), task('purge', { description: 'Discard on purge',
            attachments: [{ id: 'file', kind: 'file', title: 'Keep cleanup metadata', uri: '/fixture/file', createdAt: CREATED, updatedAt: CREATED }],
        })];
        const before = clone(selected); const context = { frozen: 'context' };
        const buildUpdates = vi.fn((source: Task, passed: { now: string; state: typeof context }): Partial<Task> => {
            expect(passed.state).toBe(context); expect(passed.now).toBe(DELETE_AT);
            return { description: context.frozen, ...(source.id === 'purge' ? { purgedAt: DELETE_AT } : {}),
                updatedAt: CREATED, rev: 500, revBy: 'caller-cannot-override-stamps' };
        });
        const planned = planTaskMutations({ tasks: selected, state: context, buildUpdates, now: DELETE_AT, deviceId: DEVICE });
        expect(planned).toEqual(legacyRows(selected, context, buildUpdates, DELETE_AT));
        expect(selected).toEqual(before); expect(context).toEqual({ frozen: 'context' });
        expect(planned[0]).toEqual({ ...selected[0], description: 'context', updatedAt: DELETE_AT, rev: 4, revBy: DEVICE });
        expect(planned[1]).toEqual({ id: 'purge', title: '(deleted)', status: 'inbox', tags: [], contexts: [],
            rev: 4, revBy: DEVICE, createdAt: DELETE_AT, updatedAt: DELETE_AT, deletedAt: DELETE_AT, purgedAt: DELETE_AT,
            attachments: [{ id: 'file', kind: 'file', title: '', uri: '/fixture/file', createdAt: CREATED, updatedAt: CREATED }] });
    });

    it('matches actual RN bulk Delete full AppData for archived/cancelled/normal/recurring/rich rows in storage order', async () => {
        const initial = data([
            task('cancelled', { cancelledAt: HISTORY, completedAt: undefined }),
            task('normal', { status: 'next', completedAt: undefined, archivedAt: undefined }),
            task('rich', { projectId: 'archived-parent', sectionId: 'archived-section',
                recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
                showFutureRecurrence: true, description: 'Retained full note',
                attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: CREATED, updatedAt: CREATED }],
                checklist: [{ id: 'step', title: 'Keep', isCompleted: true }], timeSpentMinutes: 45,
                dueDate: '2026-10-04', startTime: '2026-10-03', relativeStartOffset: { amount: 1, unit: 'day' },
                reviewAt: '2026-10-05', priority: 'high', assignedTo: 'person',
                projectArchivedAt: HISTORY, statusBeforeProjectArchive: 'waiting',
                completedAtBeforeProjectArchive: CREATED, isFocusedTodayBeforeProjectArchive: true,
            }), task('unselected'),
        ]);
        initial.projects = [project('archived-parent', { status: 'archived', archivedAt: HISTORY, completedAt: HISTORY })];
        initial.sections = [section('archived-section', 'archived-parent', { deletedAt: HISTORY, projectArchivedAt: HISTORY })];
        initial.areas = [{ id: 'area', name: 'Area', order: 0, createdAt: CREATED, updatedAt: CREATED }];
        initial.people = [{ id: 'person', name: 'Person', createdAt: CREATED, updatedAt: CREATED }];
        load(initial); const state = useTaskStore.getState(); const before = clone(initial);
        const ids = ['rich', 'normal', 'cancelled', 'rich']; const idSet = new Set(ids);
        const selected = initial.tasks.filter((row) => idSet.has(row.id));
        const buildUpdates = (_source: Task, { now }: { now: string; state: typeof state }) => ({ deletedAt: now });
        const planned = planTaskMutations({ tasks: selected, state, buildUpdates, now: DELETE_AT, deviceId: DEVICE });
        expect(planned).toEqual(legacyRows(selected, state, buildUpdates, DELETE_AT));
        expect(planned.map((row) => row.id)).toEqual(['cancelled', 'normal', 'rich']);
        const saves: AppData[] = [];
        setStorageAdapter({ getData: async () => clone(initial), saveData: async (saved) => { saves.push(clone(saved)); } });
        expect(await useTaskStore.getState().batchDeleteTasks(ids)).toEqual({ success: true }); await flushPendingSave();
        expect(snapshot()).toEqual(overlay(initial, planned)); expect(saves).toEqual([overlay(initial, planned)]);
        expect(initial).toEqual(before); expect(snapshot().tasks).toHaveLength(4);
        expect(snapshot().tasks.map((row) => row.status)).toEqual(initial.tasks.map((row) => row.status));
        expect(snapshot().projects).toEqual(initial.projects); expect(snapshot().sections).toEqual(initial.sections);
        expect(useTaskStore.getState().lastDataChangeAt).toBe(Date.parse(DELETE_AT));
    });

    it.each([
        [[], { success: true }],
        [['missing', 'live', 'missing'], { success: false, error: 'Tasks not found: missing' }],
        [['live', 'deleted'], { success: false, error: 'Tasks not found: deleted' }],
        [['purged', 'live'], { success: false, error: 'Tasks not found: purged' }],
    ])('preserves bulk Delete empty/missing/tombstone atomicity for %j', async (ids, expected) => {
        const initial = data([task('live'), task('deleted', { deletedAt: HISTORY }), task('purged', { deletedAt: HISTORY, purgedAt: HISTORY })]);
        load(initial); const saved = vi.fn(async () => undefined);
        setStorageAdapter({ getData: async () => clone(initial), saveData: saved });
        const before = snapshot(); expect(await useTaskStore.getState().batchDeleteTasks(ids as string[])).toEqual(expected);
        expect(snapshot()).toEqual(before); expect(saved).not.toHaveBeenCalled();
        expect(useTaskStore.getState().lastDataChangeAt).toBe(0);
    });

    it('matches coordinated restoreTasks and RN Promise.all restoreTask Undo using current shared containers', async () => {
        const initial = data([
            task('archived', { projectId: 'archived-parent', sectionId: 'archive-section', deletedAt: DELETE_AT }),
            task('cancelled', { cancelledAt: HISTORY, completedAt: undefined, deletedAt: DELETE_AT, areaId: 'area' }),
            task('recurring', { deletedAt: DELETE_AT, recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: 'recurring' } }),
            task('unselected'),
        ]);
        initial.projects = [project('archived-parent', { status: 'archived', archivedAt: HISTORY })];
        initial.sections = [section('archive-section', 'archived-parent', { deletedAt: HISTORY, projectArchivedAt: HISTORY })];
        initial.areas = [{ id: 'area', name: 'Area', order: 0, createdAt: CREATED, updatedAt: CREATED }];
        vi.setSystemTime(new Date(RESTORE_AT)); load(initial);
        const selected = initial.tasks.filter((row) => row.deletedAt);
        const context = restoreContext(initial);
        const planned = planTaskMutations({ tasks: selected, state: context, buildUpdates: restorePatch, now: RESTORE_AT, deviceId: DEVICE });
        expect(planned).toEqual(legacyRows(selected, context, restorePatch, RESTORE_AT));
        const expected = overlay(initial, planned);
        let saved: AppData | undefined;
        setStorageAdapter({ getData: async () => clone(initial), saveData: async (next) => { saved = clone(next); } });
        const ids = ['recurring', 'cancelled', 'archived'];
        expect(await useTaskStore.getState().restoreTasks(ids)).toEqual({ success: true }); await flushPendingSave();
        expect(snapshot()).toEqual(expected); expect(saved).toEqual(expected);
        expect(snapshot().projects[0].status).toBe('archived'); expect(snapshot().sections[0].deletedAt).toBe(HISTORY);
        load(clone(initial));
        saved = undefined;
        expect(await Promise.all(ids.map((id) => useTaskStore.getState().restoreTask(id))))
            .toEqual(ids.map(() => ({ success: true }))); await flushPendingSave();
        expect(snapshot()).toEqual(expected); expect(saved).toEqual(expected);
        expect(snapshot().tasks).toHaveLength(4); expect(snapshot().tasks[0].sectionId).toBeUndefined();
    });

    it('retains current restoreTasks skip rules and restoreTask live-row/purged behavior', async () => {
        const initial = data([task('deleted', { deletedAt: DELETE_AT }), task('live'), task('purged', { deletedAt: DELETE_AT, purgedAt: DELETE_AT })]);
        load(initial); const before = snapshot(); vi.setSystemTime(new Date(RESTORE_AT));
        expect(await useTaskStore.getState().restoreTasks(['missing', 'live', 'purged', 'deleted', 'deleted'])).toEqual({ success: true });
        expect(useTaskStore.getState()._tasksById.get('deleted')?.rev).toBe(4);
        expect(useTaskStore.getState()._tasksById.get('live')).toEqual(before.tasks[1]);
        expect(useTaskStore.getState()._tasksById.get('purged')).toEqual(before.tasks[2]);
        expect(await useTaskStore.getState().restoreTasks(['missing', 'live', 'purged'])).toEqual({ success: false, error: 'Tasks not found' });
        expect(await useTaskStore.getState().restoreTask('purged')).toEqual({ success: false, error: 'Task not found' });
        expect(await useTaskStore.getState().restoreTask('missing')).toEqual({ success: false, error: 'Task not found' });
        expect(await useTaskStore.getState().restoreTask('live')).toEqual({ success: true });
        expect(useTaskStore.getState()._tasksById.get('live')?.rev).toBe(4);
    });

    it('matches shared restore container rules for live/archived/missing/deleted/purged parents, sections and Areas', async () => {
        const cases: Array<[string, Partial<Task>, [string | undefined, string | undefined, string | undefined]]> = [
            ['active', { projectId: 'active', sectionId: 'active-section', areaId: 'area' }, ['active', 'active-section', undefined]],
            ['archived', { projectId: 'archived', sectionId: 'archived-live-section' }, ['archived', 'archived-live-section', undefined]],
            ['archived section', { projectId: 'archived', sectionId: 'archived-deleted-section' }, ['archived', undefined, undefined]],
            ['missing', { projectId: 'missing', sectionId: 'missing-section', areaId: 'area' }, [undefined, undefined, 'area']],
            ['deleted', { projectId: 'deleted', sectionId: 'deleted-parent-section', areaId: 'area' }, [undefined, undefined, 'area']],
            ['purged', { projectId: 'purged', areaId: 'deleted-area' }, [undefined, undefined, undefined]],
            ['infer', { projectId: 'missing', sectionId: 'active-section', areaId: 'area' }, ['active', 'active-section', undefined]],
            ['mismatched', { projectId: 'active', sectionId: 'archived-live-section' }, ['active', undefined, undefined]],
            ['deleted section', { projectId: 'active', sectionId: 'deleted-section' }, ['active', undefined, undefined]],
            ['missing area', { areaId: 'missing-area' }, [undefined, undefined, undefined]],
        ];
        const initial = data(cases.map(([id, fields]) => task(id, { ...fields, deletedAt: DELETE_AT })));
        initial.projects = [project('active'), project('archived', { status: 'archived', archivedAt: HISTORY }),
            project('deleted', { deletedAt: HISTORY }), project('purged', { deletedAt: HISTORY, purgedAt: HISTORY })];
        initial.sections = [section('active-section', 'active'), section('archived-live-section', 'archived'),
            section('archived-deleted-section', 'archived', { deletedAt: HISTORY, projectArchivedAt: HISTORY }),
            section('deleted-parent-section', 'deleted'), section('deleted-section', 'active', { deletedAt: HISTORY })];
        initial.areas = [{ id: 'area', name: 'Area', order: 0, createdAt: CREATED, updatedAt: CREATED },
            { id: 'deleted-area', name: 'Deleted', order: 1, createdAt: CREATED, updatedAt: CREATED, deletedAt: HISTORY }];
        load(initial); vi.setSystemTime(new Date(RESTORE_AT));
        const planned = planTaskMutations({ tasks: initial.tasks, state: restoreContext(initial), buildUpdates: restorePatch, now: RESTORE_AT, deviceId: DEVICE });
        expect(planned.map((row) => [row.projectId, row.sectionId, row.areaId])).toEqual(cases.map((row) => row[2]));
        expect(await useTaskStore.getState().restoreTasks(cases.map(([id]) => id))).toEqual({ success: true }); await flushPendingSave();
        expect(snapshot()).toEqual(overlay(initial, planned));
        expect(snapshot().projects).toEqual(initial.projects); expect(snapshot().sections).toEqual(initial.sections);
    });

    it('preserves device initialization and no-match behavior outside the pure formula', async () => {
        const initial = data([task('selected')]); initial.settings = { theme: 'dark' }; load(initial);
        const empty = planTaskMutations({ tasks: [], state: {}, buildUpdates: () => ({ deletedAt: DELETE_AT }), now: DELETE_AT, deviceId: DEVICE });
        expect(empty).toEqual([]); expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        expect(await useTaskStore.getState().batchDeleteTasks([])).toEqual({ success: true });
        expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        expect(await useTaskStore.getState().batchDeleteTasks(['selected'])).toEqual({ success: true });
        const current = useTaskStore.getState(); expect(current.settings.deviceId).toBeTruthy();
        expect(current._tasksById.get('selected')?.revBy).toBe(current.settings.deviceId);
        expect(current.settings.theme).toBe('dark');
    });

    it('leaves raw legacy fields to the caller projection rather than normalizing them inside the row formula', () => {
        const raw = task('legacy', { focusOrder: 2, pushCount: undefined,
            attachments: [{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: CREATED }] });
        const buildUpdates = () => ({ deletedAt: DELETE_AT });
        const rawAfter = planTaskMutations({ tasks: [raw], state: {}, buildUpdates, now: DELETE_AT, deviceId: DEVICE })[0];
        expect(rawAfter).toEqual({ ...raw, deletedAt: DELETE_AT, updatedAt: DELETE_AT, rev: 4, revBy: DEVICE });
        const values = taskToSqliteRow(raw);
        const loaded = normalizeTaskForLoad(mapSqliteTaskRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((name, index) => [name, values[index]]))), DELETE_AT);
        const loadedAfter = planTaskMutations({ tasks: [loaded], state: {}, buildUpdates, now: DELETE_AT, deviceId: DEVICE })[0];
        expect(loadedAfter.focusOrder).toBeUndefined(); expect(loadedAfter.pushCount).toBe(0);
        expect(loadedAfter.attachments?.[0].updatedAt).toBe('');
        expect(rawAfter).not.toEqual(loadedAfter); // Distinct raw and normal-load inputs, no field waiver.
        expect(raw.focusOrder).toBe(2); expect(raw.attachments?.[0].updatedAt).toBeUndefined();
    });

    it('plans 5k changed rows once without scanning/copying a collection per source', () => {
        let idReads = 0;
        const selected = Array.from({ length: 5_000 }, (_, index) => {
            const source = task(`task-${index}`);
            Object.defineProperty(source, 'id', { enumerable: true, get: () => { idReads++; return `task-${index}`; } });
            return source;
        });
        const buildUpdates = vi.fn((_source: Task, { now }: { now: string; state: Record<string, never> }) => ({ deletedAt: now }));
        const iterator = Array.prototype[Symbol.iterator]; let largeIterations = 0;
        Array.prototype[Symbol.iterator] = function (this: unknown[]) {
            if (this.length >= 5_000) largeIterations += this.length;
            return iterator.call(this);
        };
        let planned: Task[];
        try { planned = planTaskMutations({ tasks: selected, state: {}, buildUpdates, now: DELETE_AT, deviceId: DEVICE }); }
        finally { Array.prototype[Symbol.iterator] = iterator; }
        expect(buildUpdates).toHaveBeenCalledTimes(5_000); expect(idReads).toBeLessThanOrEqual(5_000 * 2);
        expect(largeIterations).toBeLessThanOrEqual(5_000 * 2); expect(planned!).toHaveLength(5_000);
        expect(planned![0].id).toBe('task-0'); expect(planned![4_999].id).toBe('task-4999');
    });
});
