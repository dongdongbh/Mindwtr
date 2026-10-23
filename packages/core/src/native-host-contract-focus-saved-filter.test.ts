import { afterEach, describe, expect, it } from 'vitest';
import { applyFocusSavedFilter, DEFAULT_FOCUS_CONTROL_STATE } from './focus-controls';
import { createFocusSavedFilterMethods } from './native-host-contract-focus-saved-filter';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { focusSavedFilterToken } from './store-settings';
import type { FocusSavedFilterOperation, FocusSavedFilterRequest, PreparedFocusSavedFilter } from './store-types';
import type { AppData, SavedFilter, Task } from './types';

const stamp = '2026-09-01T12:00:00.000Z';
const uuid = 'e2f841a9-fbee-4d80-84d0-c4de923a12bc';
const task: Task = { id: 'task', title: 'Task', status: 'next', tags: ['#home'], contexts: ['@work'],
    createdAt: stamp, updatedAt: stamp };
const filter = (id = 'focus-filter', extra: Record<string, unknown> = {}): SavedFilter => ({
    id, name: 'Focus', view: 'focus', criteria: { contexts: ['@work'], dueDateRange: { preset: 'today' } },
    createdAt: stamp, updatedAt: stamp, ...extra,
} as SavedFilter);

async function open(filters: SavedFilter[] = [], shouldFail = () => false) {
    resetForTests();
    let stored: AppData = { tasks: [task], projects: [], sections: [], areas: [], people: [],
        settings: { deviceId: 'device', savedFilters: filters } };
    let saves = 0;
    setStorageAdapter({ getData: async () => stored, saveData: async (next) => {
        if (shouldFail()) throw new Error('disk unavailable');
        stored = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createFocusSavedFilterMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision', t: () => (key) => key, formatDate: (value) => value });
    const request = (operation: FocusSavedFilterOperation, controls = DEFAULT_FOCUS_CONTROL_STATE,
        name: string | null = null): FocusSavedFilterRequest => {
        const offered = methods.getFocusSavedFilterOptions({ controls, operation });
        if (!offered.ok) throw new Error(JSON.stringify(offered));
        return { requestId: uuid, controls: offered.value.controls, operation, name,
            expected: offered.value.expected };
    };
    const prepared = (input: FocusSavedFilterRequest): PreparedFocusSavedFilter => {
        const planned = methods.prepareFocusSavedFilter(input);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        return planned.value.prepared;
    };
    return { methods, request, prepared, stored: () => stored, saves: () => saves };
}

afterEach(async () => { await flushPendingSave().catch(() => undefined); resetForTests(); });

describe('prepared Focus saved filter', () => {
    it('uses ordinal-key JSON and rejects malformed raw criteria before a write', async () => {
        expect(focusSavedFilterToken({ z: { b: 1, a: 2 }, a: 3 }))
            .toBe('{"a":3,"z":{"a":2,"b":1}}');
        const malformed = filter('bad', { criteria: { contexts: 7 } });
        const host = await open([malformed]);
        expect(host.methods.getFocusSavedFilterOptions({ controls: DEFAULT_FOCUS_CONTROL_STATE,
            operation: { type: 'delete', id: 'bad' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('saves RN perspectives with only a non-default sort or grouping', async () => {
        for (const grouping of [false, true]) {
            const host = await open();
            if (grouping) useTaskStore.setState((state) => ({ settings: { ...state.settings,
                gtd: { ...state.settings.gtd, focusGroupBy: 'project' } } }));
            const controls = { ...DEFAULT_FOCUS_CONTROL_STATE, sortBy: grouping ? 'default' as const : 'due' as const };
            const request = host.request({ type: 'save' }, controls, 'Perspective');
            const prepared = host.prepared(request);
            expect(prepared.after.criteria).toEqual({});
            expect(prepared.after[grouping ? 'groupBy' : 'sortBy']).toBe(grouping ? 'project' : 'due');
            expect(host.methods.validatePreparedFocusSavedFilter({ request, prepared }))
                .toEqual({ ok: true, value: prepared.result });
            expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
                .toEqual({ ok: true, value: prepared.result });
            expect(host.stored().settings.savedFilters).toEqual([prepared.after]);
        }
    });

    it('saves the RN plan under the request ID, stamps synced settings and replays exactly', async () => {
        const host = await open([filter('sibling', { future: { untouched: true } })]);
        const controls = { ...DEFAULT_FOCUS_CONTROL_STATE,
            filters: { ...DEFAULT_FOCUS_CONTROL_STATE.filters, tokens: ['@work'] } };
        const request = host.request({ type: 'save' }, controls, ' Work ');
        const prepared = host.prepared(request);
        expect(prepared.scope).toMatchObject({ before: null, creation: { canSave: true } });
        expect(prepared.after).toMatchObject({ id: uuid, name: 'Work', criteria: { contexts: ['@work'] } });
        expect(host.methods.validatePreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.stored().settings.savedFilters?.[0]).toEqual(filter('sibling', { future: { untouched: true } }));
        expect(host.stored().settings.savedFilters?.[1]).toEqual(prepared.after);
        expect(host.stored().settings.syncPreferencesUpdatedAt?.savedFilters).toBeTruthy();
        const saves = host.saves();
        useTaskStore.setState((state) => ({ settings: { ...state.settings, gtd: { focusGroupBy: 'project' } } }));
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.saves()).toBe(saves);
    });

    it('saves rolling task dates with retained advanced criteria and reloads the preset', async () => {
        const host = await open();
        const controls = { ...DEFAULT_FOCUS_CONTROL_STATE,
            filters: { ...DEFAULT_FOCUS_CONTROL_STATE.filters, anyDateRange: { preset: 'next_14_days' as const } },
            preservedCriteria: { dueDateRange: { preset: 'today' as const }, statuses: ['next' as const],
                futureCriterion: { preserved: ['opaque'] }, priority: ['none' as const], timeEstimates: ['custom:45'], locations: ['Office', 'Home'] } };
        const request = host.request({ type: 'save' }, controls, 'Fortnight');
        const prepared = host.prepared(request);
        expect(prepared.after.criteria).toEqual({ ...controls.preservedCriteria, anyDateRange: { preset: 'next_14_days' } });
        expect(host.methods.validatePreparedFocusSavedFilter({ request, prepared })).toEqual({ ok: true, value: prepared.result });
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared })).toEqual({ ok: true, value: prepared.result });
        await useTaskStore.getState().fetchData({ throwOnError: true });
        const saved = useTaskStore.getState().settings.savedFilters!.find((entry) => entry.id === uuid)!;
        expect(saved.criteria).toEqual(prepared.after.criteria);
        expect(applyFocusSavedFilter(DEFAULT_FOCUS_CONTROL_STATE, saved).filters.anyDateRange).toEqual({ preset: 'next_14_days' });
    });

    it('rejects a self-consistent cold journal that omits a selected save criterion', async () => {
        const host = await open();
        const controls = { ...DEFAULT_FOCUS_CONTROL_STATE,
            filters: { ...DEFAULT_FOCUS_CONTROL_STATE.filters, tokens: ['@work', '#home'] } };
        const request = host.request({ type: 'save' }, controls, 'Work and home');
        const prepared = host.prepared(request);
        expect(prepared.scope.creation?.currentCriteria).toMatchObject({
            contexts: ['@work'], tags: ['#home'],
        });
        const forged = structuredClone({ request, prepared });
        delete forged.prepared.scope.creation!.currentCriteria.tags;
        forged.request.expected = focusSavedFilterToken(forged.prepared.scope);
        forged.prepared.request.expected = forged.request.expected;
        delete forged.prepared.after.criteria.tags;
        forged.prepared.result.controls = applyFocusSavedFilter(forged.request.controls, forged.prepared.after);
        expect(host.methods.validatePreparedFocusSavedFilter(forged))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const before = structuredClone(useTaskStore.getState().settings);
        expect(await host.methods.commitPreparedFocusSavedFilter(forged))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState().settings).toEqual(before);
    });

    it('deletes one raw target, preserving unknown fields and sibling edits', async () => {
        const target = filter('focus-filter', { future: { detail: 'keep' }, icon: null,
            criteria: { contexts: null, dueDateRange: { preset: 'today' }, futureCriterion: { a: 1 } },
            groupBy: null, deletedAt: null, updatedAt: '2099-01-01T00:00:00.000Z' });
        const host = await open([target, filter('sibling')]);
        const controls = applyFocusSavedFilter(DEFAULT_FOCUS_CONTROL_STATE, target);
        const request = host.request({ type: 'delete', id: target.id }, controls);
        const prepared = host.prepared(request);
        useTaskStore.setState((state) => ({ settings: { ...state.settings,
            savedFilters: state.settings.savedFilters?.map((row) => row.id === 'sibling'
                ? { ...row, name: 'Renamed sibling' } : row), theme: 'dark' } }));
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.stored().settings.savedFilters?.[0]).toEqual(prepared.after);
        expect(Date.parse(prepared.after.updatedAt)).toBeGreaterThan(Date.parse(target.updatedAt));
        expect((prepared.after as SavedFilter & { icon: null }).icon).toBeNull();
        expect((prepared.after.criteria as { contexts: null }).contexts).toBeNull();
        expect(host.stored().settings.savedFilters?.[1].name).toBe('Renamed sibling');
        expect(host.stored().settings.theme).toBe('dark');
        expect((host.stored().settings.savedFilters?.[0] as SavedFilter & { future: unknown }).future)
            .toEqual({ detail: 'keep' });
        expect(prepared.result.controls.savedFilterId).toBeNull();
    });

    it('removes only an offered advanced chip and rejects target rename, deletion, ABA and duplicate IDs', async () => {
        const target = filter('focus-filter', { future: 'keep' });
        const host = await open([target]);
        const controls = applyFocusSavedFilter(DEFAULT_FOCUS_CONTROL_STATE, target);
        const offered = host.methods.getFocusSavedFilterOptions({ controls,
            operation: { type: 'removeCriterion', criterionId: 'dueDateRange' } });
        expect(offered.ok).toBe(true);
        const request = host.request({ type: 'removeCriterion', criterionId: 'dueDateRange' }, controls);
        const prepared = host.prepared(request);
        expect(prepared.after.criteria.dueDateRange).toBeUndefined();
        expect(prepared.after.criteria.contexts).toEqual(['@work']);
        expect((prepared.after as SavedFilter & { future: string }).future).toBe('keep');
        for (const changed of [
            [{ ...target, name: 'renamed' }],
            [],
            [{ ...target, updatedAt: '2026-09-02T12:00:00.000Z' }],
            [target, target],
        ]) {
            useTaskStore.setState((state) => ({ settings: { ...state.settings, savedFilters: changed } }));
            expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
    });

    it('removes an advanced criterion beside a nullable raw criterion without normalizing it', async () => {
        const target = filter('focus-filter', { criteria: { contexts: null,
            dueDateRange: { preset: 'today' }, futureCriterion: { nested: 'keep' } } });
        const host = await open([target]);
        const controls = applyFocusSavedFilter(DEFAULT_FOCUS_CONTROL_STATE, target);
        const request = host.request({ type: 'removeCriterion', criterionId: 'dueDateRange' }, controls);
        const prepared = host.prepared(request);
        expect(prepared.after.criteria).toEqual({ contexts: null, futureCriterion: { nested: 'keep' } });
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(host.stored().settings.savedFilters?.[0].criteria).toEqual(prepared.after.criteria);
    });

    it('rejects forged journals, collisions and unknown outcomes; retries a failed exact journal', async () => {
        let failing = true;
        const target = filter();
        const host = await open([target], () => failing);
        const request = host.request({ type: 'delete', id: target.id });
        const prepared = host.prepared(request);
        const invalid = (change: (value: { request: FocusSavedFilterRequest;
            prepared: PreparedFocusSavedFilter }) => void) => {
            const envelope = structuredClone({ request, prepared }); change(envelope);
            expect(host.methods.validatePreparedFocusSavedFilter(envelope))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        };
        invalid((value) => { value.prepared.after.name = 'forged'; });
        invalid((value) => { value.prepared.result.id = 'forged'; });
        invalid((value) => { value.request.operation = { type: 'save' }; });
        invalid((value) => { value.prepared.scope.before!.updatedAt = 'bad'; });
        invalid((value) => { (value.prepared.after as SavedFilter & { huge: string }).huge = 'x'.repeat(2_000_000); });
        expect(host.methods.probeFocusSavedFilterOutcome(request))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await host.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        const coldBefore = await open([target]);
        expect(await coldBefore.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(focusSavedFilterToken(coldBefore.stored().settings.savedFilters?.[0]))
            .toBe(focusSavedFilterToken(prepared.after));
        const coldAfter = await open([prepared.after]);
        await flushPendingSave();
        useTaskStore.setState((state) => ({ settings: { ...state.settings,
            syncPreferencesUpdatedAt: { savedFilters: '2099-01-01T00:00:00.000Z' } } }));
        const coldSaves = coldAfter.saves();
        expect(await coldAfter.methods.commitPreparedFocusSavedFilter({ request, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(coldAfter.saves()).toBe(coldSaves);

        const collision = await open([filter(uuid)]);
        const controls = { ...DEFAULT_FOCUS_CONTROL_STATE,
            filters: { ...DEFAULT_FOCUS_CONTROL_STATE.filters, tokens: ['@work'] } };
        const saveOptions = collision.methods.getFocusSavedFilterOptions({ controls, operation: { type: 'save' } });
        if (!saveOptions.ok) throw new Error(JSON.stringify(saveOptions));
        expect(collision.methods.prepareFocusSavedFilter({ requestId: uuid, controls: saveOptions.value.controls,
            operation: { type: 'save' }, name: 'Work', expected: saveOptions.value.expected }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});
