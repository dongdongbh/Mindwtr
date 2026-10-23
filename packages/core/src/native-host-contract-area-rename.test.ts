import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAreaRenameMethods, type NativeAreaRenameRequest } from './native-host-contract-area-rename';
import { createAreaCreateMethods } from './native-host-contract-area-create';
import { createAreaDeleteMethods } from './native-host-contract-area-delete';
import { MAX_SYNC_REVISION } from './sync-revision';
import { mergeAppData } from './sync';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Task } from './types';

const NOW = '2026-09-28T15:00:00.000Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000591';
const area = (id: string, name: string, order: number, overrides: Partial<Area> = {}): Area => ({
    id, name, order, color: '#3b82f6', rev: 3, revBy: 'old-device',
    createdAt: NOW, updatedAt: NOW, ...overrides,
});
const project = (id: string, areaId: string, areaTitle: string, overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: ['#keep'],
    areaId, areaTitle, rev: 5, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...overrides,
});
const task = (id: string, areaId: string, overrides: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: ['#keep'], contexts: ['@home'], areaId,
    rev: 7, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...overrides,
});

// These mutations model a saved sync/other-writer change, rather than a UI-only projection.
let updateSavedData: (() => void) | undefined;
const setSavedState: typeof useTaskStore.setState = (...args) => {
    useTaskStore.setState(...args); updateSavedData?.();
};

async function open(initial: Partial<AppData>, fail?: () => boolean) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [],
        settings: { deviceId: 'area-device' }, ...initial };
    let saves = 0;
    let bootstrapping = true;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (!bootstrapping && fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next);
        saves += 1;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    bootstrapping = false; saves = 0;
    updateSavedData = () => {
        const state = useTaskStore.getState();
        data = { ...data, tasks: structuredClone(state._allTasks), projects: structuredClone(state._allProjects),
            sections: structuredClone(state._allSections), areas: structuredClone(state._allAreas),
            people: structuredClone(state._allPeople), settings: structuredClone(state.settings) };
    };
    const methods = createAreaRenameMethods({
        readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        },
    });
    const request = (areaId: string, name: string,
        overrides: Partial<NativeAreaRenameRequest> = {}): NativeAreaRenameRequest => {
        const current = useTaskStore.getState()._allAreas.find((row) => row.id === areaId)!;
        return { requestId: REQUEST_ID, areaId, name,
            expected: { id: current.id, name: current.name, color: current.color ?? null,
                order: current.order, rev: current.rev ?? null, revBy: current.revBy ?? null,
                updatedAt: current.updatedAt }, ...overrides };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Area rename', () => {
    it.each([1, 2] as const)('cold-retries and receipts the frozen v%s colorless collision policy', async (version) => {
        const source = area('source', 'Work', 0);
        const destination = area('destination', 'Home', 1, { color: undefined });
        const first = await open({ areas: [source, destination],
            projects: [project('inherited', source.id, source.name)] });
        const input = first.request(source.id, 'Home');
        const plan = await first.methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.version).toBe(2);
        const prepared = structuredClone(plan.value.prepared);
        prepared.version = version;
        if (version === 1) {
            // Historical v1 retained the source compatibility color for a colorless destination.
            for (const pair of prepared.effect.projects) pair.after.color = pair.before.color;
        }
        const frozen = JSON.parse(JSON.stringify({ request: input, prepared }));
        let failed = true;
        const cold = await open(structuredClone(first.data()), () => failed);
        expect(cold.methods.validatePreparedAreaRename(frozen)).toMatchObject({ ok: true });
        expect(await cold.methods.commitPreparedAreaRename(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(cold.data().projects[0].areaId).toBe(source.id);
        failed = false;
        expect(await cold.methods.commitPreparedAreaRename(frozen)).toMatchObject({ ok: true });
        expect(cold.data().projects[0].areaId).toBe(destination.id);
        expect(cold.data().projects[0].color).toBe(version === 1 ? '#3b82f6' : '#94a3b8');
        const receipt = await open(structuredClone(cold.data()));
        expect(await receipt.methods.commitPreparedAreaRename(frozen)).toMatchObject({ ok: true });
        expect(receipt.saves()).toBe(0);
    });

    it('uses the Manage opening draft for blank, unchanged custom color, and default gray no-ops', async () => {
        const custom = await open({ areas: [area('custom', 'Work', 0, { color: '#123456' })], settings: {} });
        setSavedState({ settings: {} });
        for (const name of [' ', 'Work']) {
            expect(await custom.methods.prepareAreaRename(custom.request('custom', name, { manageColor: '#123456' })))
                .toEqual({ ok: true, value: { kind: 'noop',
                    result: { id: 'custom', areaId: 'custom', name: 'Work' } } });
        }
        expect(custom.saves()).toBe(0);
        expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        const gray = await open({ areas: [area('gray', 'Gray', 0, { color: undefined })] });
        expect(await gray.methods.prepareAreaRename(gray.request('gray', 'Gray', { manageColor: '#94a3b8' })))
            .toMatchObject({ ok: true, value: { kind: 'noop' } });
    });

    it('atomically applies a color-only Manage edit with the RN Project repair', async () => {
        const source = area('source', 'Work', 0, { color: '#123456' });
        const linked = project('linked', source.id, 'stale', { color: '#123456', deletedAt: NOW });
        const { methods, request, data } = await open({ areas: [source], projects: [linked] });
        const input = request(source.id, 'Work', { manageColor: '#10b981' });
        const plan = await methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        expect(prepared.result).toEqual({ id: source.id, areaId: source.id, name: source.name });
        expect(prepared.effect.areas).toHaveLength(1);
        expect(prepared.effect.projects[0].after).toMatchObject({ areaTitle: 'Work', color: '#10b981', deletedAt: NOW });
        expect(prepared.effect.tasks).toEqual([]);
        expect(methods.validatePreparedAreaRename({ request: input, prepared })).toMatchObject({ ok: true });
        expect(await methods.commitPreparedAreaRename({ request: input, prepared })).toMatchObject({ ok: true });
        expect(data().areas[0].name).toBe('Work');
        expect(data().projects[0].color).toBe('#10b981');
    });

    it('follows the RN trimmed-name policy when an opening name contains whitespace', async () => {
        const source = area('source', ' Work ', 0);
        const { methods, request } = await open({ areas: [source] });
        const input = request(source.id, source.name, { manageColor: source.color });
        const plan = await methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.result.name).toBe('Work');
        expect(plan.value.prepared.effect.areas[0].after.name).toBe('Work');
    });

    it('merges a combined Manage edit with one prepared effect and rejects forged mode or effect', async () => {
        const source = area('source', 'Work', 0);
        const destination = area('destination', 'Home', 1, { color: '#22c55e' });
        const deleted = project('deleted', source.id, source.name, { deletedAt: NOW });
        const stale = project('stale', destination.id, 'Old', { color: '#22c55e' });
        const direct = task('direct', source.id, { deletedAt: NOW });
        const { methods, request, data } = await open({ areas: [source, destination], projects: [deleted, stale], tasks: [direct] });
        const input = request(source.id, 'Home', { manageColor: '#ef4444' });
        const plan = await methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const prepared = plan.value.prepared;
        expect(prepared.result.areaId).toBe(destination.id);
        expect(prepared.effect.areas).toHaveLength(2);
        expect(prepared.effect.projects.map(({ after }) => [after.id, after.color, after.areaTitle]))
            .toEqual([['deleted', '#ef4444', 'Home'], ['stale', '#22c55e', 'Home']]);
        expect(prepared.effect.tasks[0].after).toMatchObject({ areaId: destination.id, deletedAt: NOW });
        expect(methods.validatePreparedAreaRename({ request: { ...input, manageColor: undefined }, prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const forged = structuredClone(prepared);
        forged.effect.projects[0].after.color = '#3b82f6';
        expect(methods.validatePreparedAreaRename({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await methods.commitPreparedAreaRename({ request: input, prepared })).toMatchObject({ ok: true });
        expect(data().areas.find((row) => row.id === destination.id)?.color).toBe('#ef4444');
        expect(data().projects.find((row) => row.id === deleted.id)?.deletedAt).toBe(NOW);
    });

    it('requires a palette or unchanged opening custom color and replays only the complete Manage receipt', async () => {
        const source = area('source', 'Work', 0, { color: '#123456' });
        const linked = project('linked', source.id, source.name);
        const { methods, request, saves } = await open({ areas: [source], projects: [linked] });
        expect(await methods.prepareAreaRename(request(source.id, 'Work', { manageColor: '#654321' })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await methods.prepareAreaRename(request(source.id, 'Work', { manageColor: null as never })))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const input = request(source.id, 'Work', { manageColor: '#10b981' });
        const plan = await methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        setSavedState({ _allProjects: [...useTaskStore.getState()._allProjects,
            project('new-link', source.id, source.name)] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allProjects: [linked] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: true });
        const saved = saves();
        setSavedState({ _allAreas: [...useTaskStore.getState()._allAreas, area('other', 'Other', 1)] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: true });
        expect(saves()).toBe(saved);
        setSavedState({ _allProjects: useTaskStore.getState()._allProjects.map((row) => row.id === linked.id
            ? { ...row, title: 'changed', rev: 7 } : row) });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('returns blank and exact-spelling no-ops without initializing a device or saving', async () => {
        const { methods, request, saves } = await open({ areas: [area('source', 'Work', 0)], settings: {} });
        setSavedState({ settings: {} });
        expect(await methods.prepareAreaRename(request('source', '   '))).toEqual({ ok: true, value: {
            kind: 'noop', result: { id: 'source', areaId: 'source', name: 'Work' },
        } });
        expect(await methods.prepareAreaRename(request('source', ' Work '))).toEqual({ ok: true, value: {
            kind: 'noop', result: { id: 'source', areaId: 'source', name: 'Work' },
        } });
        expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        expect(saves()).toBe(0);
    });

    it('freezes and atomically persists the RN merge effect with all witnesses and raw fields', async () => {
        const source = area('source', 'Work', 0, { icon: 'briefcase' });
        const destination = area('destination', 'Home', 1, { color: '#22c55e', icon: 'house' });
        const duplicate = area('duplicate', ' home ', 2, { color: '#ef4444' });
        const tombstone = area('old', 'HOME', 3, { deletedAt: NOW });
        const sourceLive = project('source-live', source.id, source.name, { supportNotes: 'keep' });
        const sourceDeleted = project('source-deleted', source.id, source.name, { deletedAt: NOW });
        const destinationStale = project('destination-stale', destination.id, 'old', { attachments: [] });
        const destinationExact = project('destination-exact', destination.id, 'HOME');
        const direct = task('direct', source.id, { description: 'keep', checklist: [{ id: 'c', title: 'keep', isCompleted: false }] });
        const deleted = task('deleted', source.id, { deletedAt: NOW });
        const dual = task('dual', source.id, { projectId: sourceLive.id });
        const unrelatedTask = task('other-task', duplicate.id);
        const { methods, request, data } = await open({ areas: [source, destination, duplicate, tombstone],
            projects: [sourceLive, sourceDeleted, destinationStale, destinationExact],
            tasks: [direct, deleted, dual, unrelatedTask] });
        // A mixed-version store can still contain duplicate live names even though
        // a fresh load currently normalizes them; rename resolves the first raw row.
        setSavedState({ _allAreas: [source, destination, duplicate, tombstone],
            _allTasks: [direct, deleted, dual, unrelatedTask] });
        const input = request(source.id, ' HOME ');
        const preparation = await methods.prepareAreaRename(input);
        if (!preparation.ok || preparation.value.kind !== 'prepared') throw new Error(JSON.stringify(preparation));
        const prepared = preparation.value.prepared;

        expect(prepared.result).toEqual({ id: source.id, areaId: destination.id, name: 'HOME' });
        expect(prepared.scope.areas.map((row) => row.id)).toEqual([source.id, destination.id, duplicate.id]);
        expect(prepared.scope.projects.map((row) => row.id)).toEqual([
            sourceLive.id, sourceDeleted.id, destinationStale.id, destinationExact.id,
        ]);
        expect(prepared.scope.tasks.map((row) => row.id)).toEqual([direct.id, deleted.id, dual.id]);
        expect(prepared.effect.areas.map((pair) => pair.before.id)).toEqual([source.id, destination.id]);
        expect(prepared.effect.projects.map((pair) => pair.before.id)).toEqual([
            sourceLive.id, sourceDeleted.id, destinationStale.id,
        ]);
        expect(prepared.effect.tasks.map((pair) => pair.before.id)).toEqual([direct.id, deleted.id, dual.id]);
        expect(methods.validatePreparedAreaRename({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(await methods.commitPreparedAreaRename({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });

        expect(data().areas.find((row) => row.id === source.id)?.deletedAt).toBe(prepared.updateAt);
        expect(data().areas.find((row) => row.id === destination.id)).toMatchObject({
            name: 'HOME', color: destination.color, icon: destination.icon, order: destination.order,
        });
        expect(data().projects.find((row) => row.id === sourceDeleted.id)?.deletedAt).toBe(NOW);
        expect(data().projects.find((row) => row.id === destinationExact.id)).toEqual(destinationExact);
        expect(data().tasks.find((row) => row.id === dual.id)?.areaId).toBeUndefined();
        expect(data().tasks.find((row) => row.id === unrelatedTask.id)).toEqual(unrelatedTask);
        const aligned = mergeAppData(data(), data(), { nowIso: prepared.updateAt });
        expect(mergeAppData(aligned, data(), { nowIso: prepared.updateAt })).toEqual(aligned);
    });

    it('keeps composed and decomposed Unicode distinct and renames case-only spelling', async () => {
        const source = area('source', 'Cafe', 0);
        const decomposed = area('decomposed', 'Cafe\u0301', 1);
        const { methods, request } = await open({ areas: [source, decomposed],
            projects: [project('linked', source.id, source.name)] });
        const composed = request(source.id, '\ufeffCaf\u00e9\ufeff');
        const plan = await methods.prepareAreaRename(composed);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.request.name).toBe('\ufeffCaf\u00e9\ufeff');
        expect(plan.value.prepared.result.name).toBe('Caf\u00e9');
        expect(plan.value.prepared.result.areaId).toBe(source.id);
        expect(plan.value.prepared.effect.projects[0].after.areaTitle).toBe('Caf\u00e9');

        const fresh = await open({ areas: [area('source', 'Work', 0)] });
        const caseOnly = fresh.request('source', 'work');
        const casePlan = await fresh.methods.prepareAreaRename(caseOnly);
        if (!casePlan.ok || casePlan.value.kind !== 'prepared') throw new Error(JSON.stringify(casePlan));
        expect(casePlan.value.prepared.result).toEqual({ id: 'source', areaId: 'source', name: 'work' });

        const deletedMatch = await open({ areas: [area('source', 'Work', 0),
            area('deleted', 'Home', 1, { deletedAt: NOW })] });
        const tombstoneOnly = await deletedMatch.methods.prepareAreaRename(deletedMatch.request('source', 'Home'));
        if (!tombstoneOnly.ok || tombstoneOnly.value.kind !== 'prepared') throw new Error(JSON.stringify(tombstoneOnly));
        expect(tombstoneOnly.value.prepared.result.areaId).toBe('source');
    });

    it('refuses changed inventory or linked membership, but accepts the full receipt before mutable guards', async () => {
        const source = area('source', 'Work', 0);
        const destination = area('destination', 'Home', 1);
        const linked = project('linked', source.id, source.name);
        const { methods, request, saves } = await open({ areas: [source, destination], projects: [linked] });
        const input = request(source.id, destination.name);
        const plan = await methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        setSavedState({ _allProjects: [...useTaskStore.getState()._allProjects,
            project('new-link', source.id, source.name)] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allProjects: [linked], _allTasks: [task('new-task', source.id)] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allTasks: [], _allProjects: [{ ...linked, title: 'changed', rev: 6 }] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allProjects: [linked] });
        setSavedState({ _allProjects: [linked], _allAreas: [source,
            area('new-first', 'Home', -1), destination] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allAreas: [source, destination] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: true });
        const saved = saves();
        setSavedState({ _allAreas: [...useTaskStore.getState()._allAreas,
            area('later', 'Later', 9)], _allProjects: [...useTaskStore.getState()._allProjects,
            project('later-project', 'later', 'Later')] });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: true });
        expect(saves()).toBe(saved);
        const partial = useTaskStore.getState()._allProjects.map((row) => row.id === linked.id
            ? { ...row, title: 'later edit', rev: (row.rev ?? 0) + 1 } : row);
        setSavedState({ _allProjects: partial });
        expect(await methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('retries one failed durable effect and recognizes the cold receipt', async () => {
        let failed = false;
        const source = area('source', 'Work', 0);
        const first = await open({ areas: [source], projects: [project('linked', source.id, source.name)],
            settings: {} }, () => failed);
        setSavedState({ settings: {} });
        const input = first.request(source.id, 'Office');
        const plan = await first.methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(plan.value.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f]{8}-/);
        const envelope = { request: input, prepared: plan.value.prepared };
        failed = true;
        expect(await first.methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.data().areas[0].name).toBe('Work');
        failed = false;
        expect(await first.methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: true });
        expect(first.data().areas[0].name).toBe('Office');
        const saved = structuredClone(first.data());
        const second = await open(saved);
        await flushPendingSave();
        const before = second.saves();
        expect(second.methods.validatePreparedAreaRename(envelope)).toMatchObject({ ok: true });
        expect(await second.methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(before);
        setSavedState({ settings: { ...useTaskStore.getState().settings, deviceId: 'different' } });
        expect(await second.methods.commitPreparedAreaRename(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('rejects stale, forged, capped, oversized, and unknown outcome requests without writing', async () => {
        const source = area('source', 'Work', 0);
        const { methods, request } = await open({ areas: [source],
            projects: [project('linked', source.id, source.name)] });
        const input = request(source.id, 'Office');
        expect(await methods.prepareAreaRename({ ...input, expected: { ...input.expected, id: 'other' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await methods.prepareAreaRename({ ...input, expected: { ...input.expected, rev: 2 } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const plan = await methods.prepareAreaRename(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const forged = structuredClone(plan.value.prepared);
        forged.effect.areas[0].after.name = 'forged';
        expect(methods.validatePreparedAreaRename({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const missing = structuredClone(plan.value.prepared);
        missing.effect.areas = [];
        expect(methods.validatePreparedAreaRename({ request: input, prepared: missing }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const extra = structuredClone(plan.value.prepared);
        extra.effect.areas.push(structuredClone(extra.effect.areas[0]));
        expect(methods.validatePreparedAreaRename({ request: input, prepared: extra }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const wrongResult = structuredClone(plan.value.prepared);
        wrongResult.result.name = 'wrong';
        expect(methods.validatePreparedAreaRename({ request: input, prepared: wrongResult }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeAreaRenameOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(await methods.prepareAreaRename(request(source.id, 'x'.repeat(10_001))))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const capped = await open({ areas: [area('capped', 'Capped', 0, { rev: MAX_SYNC_REVISION })] });
        expect(await capped.methods.prepareAreaRename(capped.request('capped', 'Renamed')))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const oversized = await open({ areas: [area('large', 'Large', 0)] });
        setSavedState({ _allProjects: Array.from({ length: 8 }, (_, index) =>
            project(`large-${index}`, 'large', 'Large', { title: 'x'.repeat(100_000) })) });
        expect(await oversized.methods.prepareAreaRename(oversized.request('large', 'Larger')))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        const deletedSource = await open({ areas: [area('deleted-source', 'Gone', 0, { deletedAt: NOW })] });
        expect(await deletedSource.methods.prepareAreaRename(deletedSource.request('deleted-source', 'Back')))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});

// Actual normal-load/recovery boundaries shared by the three concrete Area commands.
type RecoveryMode = 'rename' | 'merge' | 'delete' | 'restore' | 'fresh';
async function openAreaRecovery(mode: RecoveryMode) {
    await flushPendingSave(); resetForTests();
    const stamp = new Date().toISOString();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'area-device' } };
    let failing = false, landedError = false, writes = 0;
    let onRead: (() => void) | undefined;
    const adapter = { getData: async () => { onRead?.(); return structuredClone(data); }, saveData: async (next: AppData) => {
        if (failing) throw new Error('disk unavailable');
        data = structuredClone(next); writes++;
        if (landedError) throw new Error('acknowledgment unavailable');
    } };
    const clear = () => useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 });
    setStorageAdapter(adapter); clear();
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    const source = area('source', 'Work', 0, { createdAt: stamp, updatedAt: stamp,
        ...(mode === 'restore' ? { deletedAt: stamp } : {}) });
    const terminal = task('terminal', mode === 'fresh' ? '' : source.id, { status: 'done', completedAt: stamp,
        createdAt: stamp, updatedAt: stamp, focusOrder: 9, isFocusedToday: false,
        description: 'Keep metadata', ...(mode === 'restore' ? { deletedAt: stamp } : {}) });
    const unrelated = task('unrelated', '', { description: 'Original', createdAt: stamp, updatedAt: stamp });
    data = { ...data, areas: mode === 'fresh' ? [] : [source,
        ...(mode === 'merge' ? [area('destination', 'Home', 1, { createdAt: stamp, updatedAt: stamp })] : [])],
        tasks: [terminal, unrelated], projects: [project('archived-projection', '', '', {
            status: 'archived', isFocused: true, createdAt: stamp, updatedAt: stamp })] };
    writes = 0;
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    expect(writes).toBe(0); expect(data.tasks[0].focusOrder).toBe(9);
    expect(useTaskStore.getState()._allTasks[0].focusOrder).toBeUndefined();
    expect(data.projects[0].isFocused).toBe(true);
    expect(useTaskStore.getState()._allProjects[0].isFocused).toBe(false);
    const deps = { readiness: () => ({ ok: true as const, value: null }), save: async () => {
        try { await flushPendingSave(); return { ok: true as const, value: null }; }
        catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'save unavailable' } }; }
    }, revision: () => 'revision', sortedAreas: () => useTaskStore.getState()._allAreas.filter((row) => !row.deletedAt) };
    const methods = () => ({ ...createAreaRenameMethods(deps), ...createAreaCreateMethods(deps), ...createAreaDeleteMethods(deps) });
    let current = methods();
    const expected = { name: source.name, color: source.color!, order: source.order, rev: source.rev!, revBy: source.revBy!, updatedAt: stamp };
    const createRequest = { requestId: REQUEST_ID, name: 'Work', color: '#3b82f6', expectedAreaId: mode === 'fresh' ? REQUEST_ID : source.id };
    const deleteRequest = { requestId: REQUEST_ID, areaId: source.id, expected };
    const renameRequest = { requestId: REQUEST_ID, areaId: source.id, name: mode === 'merge' ? 'Home' : 'Office', expected: { id: source.id, ...expected } };
    const prepare = async () => {
        const plan = mode === 'delete' ? await current.prepareAreaDelete(deleteRequest)
            : mode === 'restore' || mode === 'fresh' ? await current.prepareAreaCreate(createRequest)
            : await current.prepareAreaRename(renameRequest);
        if (!plan.ok || !('prepared' in plan.value)) throw new Error(JSON.stringify(plan));
        return structuredClone({ request: mode === 'delete' ? deleteRequest : mode === 'restore' || mode === 'fresh' ? createRequest : renameRequest,
            prepared: plan.value.prepared });
    };
    const commit = (frozen: Awaited<ReturnType<typeof prepare>>) => mode === 'delete'
        ? current.commitPreparedAreaDelete(frozen as Parameters<typeof current.commitPreparedAreaDelete>[0])
        : mode === 'restore' || mode === 'fresh' ? current.commitPreparedAreaCreate(frozen as Parameters<typeof current.commitPreparedAreaCreate>[0])
        : current.commitPreparedAreaRename(frozen as Parameters<typeof current.commitPreparedAreaRename>[0]);
    return { prepare, commit, adapter, data: () => data, writes: () => writes,
        fail: (value: boolean) => { failing = value; }, landedError: (value: boolean) => { landedError = value; },
        changeData: (patch: Partial<AppData>) => { data = { ...data, ...structuredClone(patch) }; },
        onRead: (hook: (() => void) | undefined) => { onRead = hook; },
        recreate: async (before: AppData) => {
            await flushPendingSave(); resetForTests(); data = structuredClone(before); writes = 0;
            setStorageAdapter({ ...adapter }); clear();
            await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
            current = methods();
        },
    };
}
const recoveryModes: RecoveryMode[] = ['rename', 'merge', 'delete', 'restore', 'fresh'];

describe('Area durable recovery baselines', () => {
    it.each(recoveryModes.flatMap((mode) => ['synchronous', 'microtask'].map((timing) => ({ mode, timing }))))
    ('$mode cannot own a $timing subscriber Task intent coalesced with its failed save', async ({ mode, timing }) => {
        const env = await openAreaRecovery(mode); const frozen = await env.prepare();
        const before = structuredClone(env.data()); let armed = true;
        let foreignWrite: Promise<unknown> | undefined;
        const unsubscribe = useTaskStore.subscribe((current, previous) => {
            if (!armed || current._allAreas === previous._allAreas) return;
            armed = false;
            const edit = () => { foreignWrite = useTaskStore.getState().updateTask('unrelated', { description: 'Foreign coalesced intent' }); };
            if (timing === 'microtask') queueMicrotask(edit); else edit();
        });
        env.fail(true);
        try { expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); }
        finally { unsubscribe(); }
        expect(await foreignWrite).toMatchObject({ success: true });
        expect(armed).toBe(false);
        const failed = useTaskStore.getState(); const memory = structuredClone(failed._allTasks);
        const status = getPersistenceStatus();
        expect(failed.persistenceFailure).not.toBeNull();
        expect(memory.find((row) => row.id === 'unrelated')?.description).toBe('Foreign coalesced intent');
        expect(env.data()).toEqual(before); expect(env.writes()).toBe(0);
        env.fail(false);
        for (let retry = 0; retry < 2; retry++) {
            expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(useTaskStore.getState()._allTasks).toEqual(memory);
            expect(useTaskStore.getState().persistenceFailure).toBe(failed.persistenceFailure);
            expect(useTaskStore.getState().lastDataChangeAt).toBe(failed.lastDataChangeAt);
            expect(getPersistenceStatus()).toEqual(status);
            expect(env.data()).toEqual(before); expect(env.writes()).toBe(0);
        }
    }, 15_000);

    it.each(['merge', 'delete', 'restore'] as RecoveryMode[])('%s projects newly observed durable metadata without reintroducing terminal focus', async (mode) => {
        const env = await openAreaRecovery(mode);
        const terminal = env.data().tasks[0];
        const fresh = { ...terminal, description: 'New durable description',
            checklist: [{ id: 'new-check', title: 'New durable check', isCompleted: true }], rev: (terminal.rev ?? 0) + 1 };
        env.changeData({ tasks: [fresh, ...env.data().tasks.slice(1)] });
        expect(useTaskStore.getState()._allTasks[0].description).toBe('Keep metadata');
        const frozen = await env.prepare();
        expect(frozen.prepared.scope.tasks[0]).toEqual(fresh);
        expect(await env.commit(frozen)).toMatchObject({ ok: true });
        const memory = useTaskStore.getState()._allTasks.find((row) => row.id === fresh.id)!;
        expect(memory.description).toBe(fresh.description); expect(memory.checklist).toEqual(fresh.checklist);
        expect(memory.focusOrder).toBeUndefined();
        expect(env.data().tasks[0].description).toBe(fresh.description);
        expect(env.data().tasks[0].checklist).toEqual(fresh.checklist); expect(env.data().tasks[0].focusOrder).toBe(9);
    });

    it.each(recoveryModes)('%s retains raw terminal fields through failed/same-host/cold replay and preserves unrelated durable rows', async (mode) => {
        const env = await openAreaRecovery(mode);
        const frozen = await env.prepare(); const original = structuredClone(frozen);
        if (mode !== 'fresh') {
            expect(frozen.prepared.scope.tasks[0].focusOrder).toBe(9);
            for (const { after } of frozen.prepared.effect.tasks) expect(after.focusOrder).toBe(9);
        }
        const before = structuredClone(env.data());
        env.fail(true);
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(env.data()).toEqual(before); expect(frozen).toEqual(original);
            expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'terminal')?.focusOrder).toBeUndefined();
        }
        env.fail(false);
        expect(await env.commit(frozen)).toMatchObject({ ok: true });
        expect(env.data().tasks[0].focusOrder).toBe(9);
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'terminal')?.focusOrder).toBeUndefined();
        expect(env.data().projects[0].isFocused).toBe(true);
        expect(useTaskStore.getState()._allProjects[0].isFocused).toBe(false);
        const success = structuredClone(env.data());
        await env.recreate(before);
        const later = task('later', '', { description: 'Durable later edit' });
        env.changeData({ tasks: [...before.tasks, later], people: [{ id: 'later-person', name: 'Later', createdAt: NOW, updatedAt: NOW }],
            settings: { ...before.settings, theme: 'light' } });
        expect(await env.commit(frozen)).toMatchObject({ ok: true });
        expect(env.data().tasks).toEqual([...success.tasks, later]);
        expect(env.data().people?.[0].id).toBe('later-person'); expect(env.data().settings.theme).toBe('light');
        const applied = structuredClone(env.data()); const writes = env.writes();
        env.changeData({ tasks: [...applied.tasks, task('new-link', 'source')] });
        const replayBefore = structuredClone(env.data());
        expect(await env.commit(frozen)).toMatchObject({ ok: true });
        expect(env.data()).toEqual(replayBefore); expect(env.writes()).toBe(writes);
        if (mode !== 'fresh') {
            await env.recreate(before);
            env.changeData({ tasks: before.tasks.map((row) => row.id === 'terminal' ? { ...row, focusOrder: 10 } : row) });
            const changed = structuredClone(env.data());
            expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(env.data()).toEqual(changed); expect(env.writes()).toBe(0);
        }
    }, 20_000);

    it.each(recoveryModes)('%s refuses foreign failed Task intent before any write, retaining failure and generation', async (mode) => {
        const env = await openAreaRecovery(mode); const frozen = await env.prepare();
        const before = structuredClone(env.data());
        env.fail(true);
        expect(await useTaskStore.getState().updateTask('unrelated', { description: 'Unsaved intent' })).toMatchObject({ success: true });
        await expect(flushPendingSave()).rejects.toThrow();
        const state = useTaskStore.getState(); const memory = structuredClone(state._allTasks);
        expect(state.persistenceFailure).not.toBeNull(); expect(memory.find((row) => row.id === 'unrelated')?.description).toBe('Unsaved intent');
        const status = getPersistenceStatus(); env.fail(false);
        expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(before); expect(env.writes()).toBe(0);
        expect(useTaskStore.getState()._allTasks).toEqual(memory);
        expect(useTaskStore.getState().persistenceFailure).toBe(state.persistenceFailure);
        expect(useTaskStore.getState().lastDataChangeAt).toBe(state.lastDataChangeAt);
        expect(getPersistenceStatus()).toEqual(status);
    }, 15_000);

    it.each(recoveryModes)('%s settles only its own landed-after-error without writing stale memory', async (mode) => {
        const env = await openAreaRecovery(mode); const frozen = await env.prepare();
        env.landedError(true);
        expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.landedError(false);
        env.changeData({ tasks: [...env.data().tasks, task('later', '', { description: 'External edit' })],
            settings: { ...env.data().settings, theme: 'light' } });
        const before = structuredClone(env.data()); const writes = env.writes();
        const other = structuredClone(frozen); other.request.requestId = '00000000-0000-4000-8000-000000000592';
        other.prepared.request.requestId = other.request.requestId;
        // Fresh creation requires ID==UUID, so a different valid frozen payload is supplied by a second preparation below in ownership guards.
        if (mode !== 'fresh') expect(await env.commit(other)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(await env.commit(frozen)).toMatchObject({ ok: true });
        expect(env.data()).toEqual(before); expect(env.writes()).toBe(writes);
        expect(env.data().tasks[0].focusOrder).toBe(9); expect(useTaskStore.getState().persistenceFailure).toBeNull();
        useTaskStore.setState({ persistenceFailure: { message: 'Foreign failure', failedAt: NOW, retrying: false } });
        expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(before); expect(env.writes()).toBe(writes);
    }, 15_000);

    it.each(recoveryModes)('%s fences adapter, all collection references, settings and epoch across prepare/commit awaits', async (mode) => {
        for (const phase of ['prepare', 'commit']) for (const mutation of ['adapter', 'tasks', 'areas', 'projects', 'sections', 'people', 'settings', 'epoch']) {
            const env = await openAreaRecovery(mode); const frozen = await env.prepare(); const before = structuredClone(env.data());
            env.onRead(() => {
                const state = useTaskStore.getState();
                if (mutation === 'adapter') setStorageAdapter({ getData: async () => structuredClone(before), saveData: async () => {} });
                else if (mutation === 'epoch') useTaskStore.setState({ lastDataChangeAt: state.lastDataChangeAt + 1 });
                else if (mutation === 'settings') useTaskStore.setState({ settings: { ...state.settings } });
                else {
                    const key = `_all${mutation[0].toUpperCase()}${mutation.slice(1)}` as '_allTasks' | '_allAreas' | '_allProjects' | '_allSections' | '_allPeople';
                    useTaskStore.setState({ [key]: [...state[key]] });
                }
            });
            if (phase === 'prepare') await expect(env.prepare()).rejects.toThrow('STALE_REVISION');
            else expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(env.data()).toEqual(before); expect(env.writes()).toBe(0); env.onRead(undefined);
        }
    });

    it.each(['adapter', 'epoch', 'queue', 'failure'] as const)('landed Area failure cannot be cleared after %s changes', async (mutation) => {
        const env = await openAreaRecovery('merge'); const frozen = await env.prepare();
        env.landedError(true);
        expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        env.landedError(false);
        const before = structuredClone(env.data()); const writes = env.writes(); const state = useTaskStore.getState();
        if (mutation === 'adapter') setStorageAdapter({ getData: async () => structuredClone(before), saveData: async () => {} });
        if (mutation === 'epoch') useTaskStore.setState({ lastDataChangeAt: state.lastDataChangeAt + 1 });
        if (mutation === 'queue') await state.persistSnapshot();
        if (mutation === 'failure') useTaskStore.setState({ persistenceFailure: { ...state.persistenceFailure! } });
        expect(await env.commit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(before); expect(env.writes()).toBe(writes);
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
    }, 15_000);
});
