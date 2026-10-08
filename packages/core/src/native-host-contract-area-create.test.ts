import { afterEach, describe, expect, it } from 'vitest';
import { createAreaCreateMethods, type NativeAreaCreateRequest } from './native-host-contract-area-create';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area } from './types';
import type { Project, Section, Task } from './types';
import { TASK_SYNC_SCHEMA_FIXTURE } from './task-sync-schema';
import { mergeAppData } from './sync';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import { sameAreaAdditionRow } from './store-projects/area-actions';

const requestId = '00000000-0000-4000-8000-000000000351';
const now = '2026-09-28T15:00:00.000Z';
const request = (overrides: Partial<NativeAreaCreateRequest> = {}): NativeAreaCreateRequest => ({
    requestId, name: 'Work', color: '#3b82f6', expectedAreaId: requestId, ...overrides,
});
const area = (id: string, name: string, overrides: Partial<Area> = {}): Area => ({
    id, name, order: 0, createdAt: now, updatedAt: now, ...overrides,
});
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
    id, title: id, color: '#22c55e', order: 0, status: 'active', tagIds: [],
    createdAt: now, updatedAt: now, ...overrides,
});
const section = (id: string, projectId: string, overrides: Partial<Section> = {}): Section => ({
    id, projectId, title: id, order: 0, createdAt: now, updatedAt: now, ...overrides,
});
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    ...TASK_SYNC_SCHEMA_FIXTURE, id, title: id, createdAt: now, updatedAt: now, ...overrides,
});

// These mutations model a saved sync/other-writer change, rather than a UI-only projection.
let updateSavedData: (() => void) | undefined;
const setSavedState: typeof useTaskStore.setState = (...args) => {
    useTaskStore.setState(...args); updateSavedData?.();
};

async function open(initial: Partial<AppData> = {}, fail?: () => boolean, recoveryLoad = false) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [],
        settings: { deviceId: 'area-device' }, ...initial };
    let saves = 0;
    let bootstrapping = true;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (!bootstrapping && fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next);
        saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad });
    await flushPendingSave();
    bootstrapping = false; saves = 0;
    updateSavedData = () => {
        const state = useTaskStore.getState();
        data = { ...data, tasks: structuredClone(state._allTasks), projects: structuredClone(state._allProjects),
            sections: structuredClone(state._allSections), areas: structuredClone(state._allAreas),
            people: structuredClone(state._allPeople), settings: structuredClone(state.settings) };
    };
    const methods = createAreaCreateMethods({
        readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        },
        revision: () => 'revision',
        sortedAreas: () => useTaskStore.getState()._allAreas.filter((item) => !item.deletedAt),
    });
    return { methods, data: () => data, saves: () => saves };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('prepared native Area create', () => {
    it('accepts the Manage default gray for a fresh Area and replays the exact journal after reload', async () => {
        const { methods, data } = await open();
        const options = methods.getAreaCreateOptions();
        expect(options).toMatchObject({ ok: true, value: { defaultColor: '#3b82f6' } });
        if (!options.ok) throw new Error('options failed');
        expect(options.value.colors).toHaveLength(12);
        expect(options.value.colors).not.toContain('#94a3b8');

        const input = request({ color: '#94a3b8' });
        const plan = await methods.prepareAreaCreate(input);
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: {
            kind: 'fresh', effect: { area: { after: { id: requestId, color: '#94a3b8' } } },
        } } });
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(methods.validatePreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        const cold = await open(data());
        expect(cold.methods.validatePreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(await cold.methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true,
            value: { id: requestId, created: true } });
        const saved = structuredClone(cold.data());
        expect(saved.areas).toHaveLength(1);
        const replay = await open(saved);
        const before = replay.saves();
        expect(await replay.methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(replay.saves()).toBe(before);
        expect(replay.data()).toEqual(saved);
    });

    it('accepts gray for an exact restored ID and descendants, but rejects arbitrary colors', async () => {
        const old = area('area-work', 'Work', { deletedAt: now, color: '#ef4444', rev: 2 });
        const child = project('linked', { areaId: old.id, deletedAt: now, rev: 2 });
        const { methods, data } = await open({ areas: [old], projects: [child] });
        const input = request({ color: '#94a3b8', expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.kind).toBe('restored');
        expect(plan.value.prepared.effect.area.after).toMatchObject({ id: old.id, color: '#94a3b8' });
        expect(plan.value.prepared.effect.projects[0].after).toMatchObject({ id: child.id,
            color: '#94a3b8' });
        expect(plan.value.prepared.effect.projects[0].after.deletedAt).toBeUndefined();
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(methods.validatePreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        const cold = await open(data());
        expect(cold.methods.validatePreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(await cold.methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true,
            value: { id: old.id, created: true } });
        const saved = structuredClone(cold.data());
        const replay = await open(saved);
        const before = replay.saves();
        expect(await replay.methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(replay.saves()).toBe(before);
        expect(replay.data()).toEqual(saved);

        const custom = request({ color: '#123456', expectedAreaId: old.id });
        expect(await replay.methods.prepareAreaCreate(custom)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(replay.methods.probeAreaCreateOutcome(custom)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(replay.methods.validatePreparedAreaCreate({ request: custom, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await replay.methods.commitPreparedAreaCreate({ request: custom, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(replay.saves()).toBe(before);
    });

    it('resolves the name and publishes a fresh canonical Area with an exact replay receipt', async () => {
        const { methods, data, saves } = await open({ areas: [area('old', 'Old', { order: 1.5, deletedAt: now })] });
        expect(methods.getAreaCreateOptions()).toMatchObject({ ok: true, value: {
            defaultColor: '#3b82f6', areas: [],
        } });
        expect(methods.resolveAreaCreateName({ requestId, name: ' Work ' })).toMatchObject({
            ok: true, value: { expectedAreaId: requestId, taken: false },
        });
        const prepared = await methods.prepareAreaCreate(request({ name: ' Work ' }));
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: {
            kind: 'fresh', effect: { area: { after: { id: requestId, name: 'Work', order: 2.5, rev: 1 } } },
        } } });
        if (!prepared.ok || prepared.value.kind !== 'prepared') return;
        const input = { request: request({ name: ' Work ' }), prepared: prepared.value.prepared };
        expect(methods.validatePreparedAreaCreate(input)).toMatchObject({ ok: true, value: { id: requestId, created: true } });
        expect(await methods.commitPreparedAreaCreate(input)).toMatchObject({ ok: true, value: { id: requestId, created: true } });
        expect(data().areas).toHaveLength(2);
        const count = saves();
        expect(await methods.commitPreparedAreaCreate(input)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
    });

    it('returns a live duplicate without recoloring or saving, and probes a changed color read-only', async () => {
        const existing = area('area-work', 'Work', { color: '#22c55e', rev: 3 });
        const { methods, saves } = await open({ areas: [existing] });
        expect(methods.resolveAreaCreateName({ requestId, name: ' work ' })).toMatchObject({
            ok: true, value: { expectedAreaId: existing.id, taken: true },
        });
        const input = request({ name: ' work ', expectedAreaId: existing.id });
        const before = saves();
        expect(await methods.prepareAreaCreate(input)).toEqual({ ok: true, value: { kind: 'existing',
            result: { id: existing.id, created: false } } });
        setSavedState({ _allAreas: [{ ...existing, name: 'WORK', color: '#ef4444', rev: 4 }] });
        expect(methods.probeAreaCreateOutcome(input)).toEqual({ ok: true,
            value: { id: existing.id, created: false } });
        expect(saves()).toBe(before);
    });

    it('restores the old ID, legacy descendants, and deleted linked project repaint as one effect', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { color: '#22c55e', rev: 4, deletedAt });
        const restoredProject = project('linked', { areaId: old.id, areaTitle: undefined, deletedAt, rev: 2 });
        const independentlyDeleted = project('other-deletion', { areaId: old.id, areaTitle: 'Work',
            deletedAt: '2026-09-26T12:00:00.000Z', rev: 7 });
        const restoredSection = section('planning', restoredProject.id, { deletedAt, rev: 3 });
        // Not purged: the schema fixture's purgedAt (2026-07-14) would let the tombstone purge drop them on load once 90 days pass.
        const direct = task('direct', { areaId: old.id, projectId: undefined, sectionId: undefined, deletedAt, purgedAt: undefined, rev: 5 });
        const linked = task('project-task', { projectId: restoredProject.id, sectionId: restoredSection.id,
            deletedAt, purgedAt: undefined, rev: 6 });
        const unrelated = project('unrelated', { rev: 9 });
        const { methods, data } = await open({ areas: [old], projects: [restoredProject, independentlyDeleted, unrelated],
            sections: [restoredSection], tasks: [direct, linked] });
        const input = request({ name: ' work ', expectedAreaId: old.id, color: '#ef4444' });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') return;
        expect(plan.value.prepared.kind).toBe('restored');
        expect(plan.value.prepared.effect.area.after).toMatchObject({ id: old.id,
            name: 'work', color: '#ef4444', rev: 6 });
        expect(plan.value.prepared.effect.projects.map((entry) => [entry.after.id, entry.after.rev, entry.after.color]))
            .toEqual([[restoredProject.id, 4, '#ef4444'], [independentlyDeleted.id, 8, '#ef4444']]);
        expect(plan.value.prepared.effect.projects[0].after.deletedAt).toBeUndefined();
        expect(plan.value.prepared.effect.sections.map((entry) => [entry.after.id, entry.after.rev]))
            .toEqual([[restoredSection.id, 4]]);
        expect(plan.value.prepared.effect.tasks.map((entry) => [entry.after.id, entry.after.rev]))
            .toEqual([[direct.id, 6], [linked.id, 7]]);
        expect(plan.value.prepared.effect.tasks[1].after.sectionId).toBe(restoredSection.id);
        expect(plan.value.prepared.effect.tasks.every((entry) => !entry.after.deletedAt)).toBe(true);
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true,
            value: { id: old.id, created: true } });
        expect(data().areas).toHaveLength(1);
        expect(data().projects.find((row) => row.id === unrelated.id)).toEqual(unrelated);
        const merged = mergeAppData(data(), data(), { nowIso: now });
        expect(mergeAppData(merged, data(), { nowIso: now })).toEqual(merged);
        const savedSnapshot = structuredClone(data());
        const reloaded = await open(savedSnapshot, undefined, true);
        expect(reloaded.data()).toEqual(savedSnapshot);
        expect(reloaded.data().areas[0].id).toBe(old.id);
        expect(useTaskStore.getState()._allTasks.filter((row) => row.id === direct.id || row.id === linked.id)
            .every((row) => !row.deletedAt)).toBe(true);
    });

    it('matches RN addArea final restored identity, color, and revisions', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt, rev: 3, color: '#22c55e' });
        const child = project('linked', { areaId: old.id, deletedAt, rev: 4 });
        const { methods } = await open({ areas: [old], projects: [child] });
        const plan = await methods.prepareAreaCreate(request({ expectedAreaId: old.id, name: ' work ', color: '#ef4444' }));
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const rn = await useTaskStore.getState().addArea(' work ', { color: '#ef4444' });
        expect(rn).toMatchObject({ id: plan.value.prepared.effect.area.after.id,
            name: plan.value.prepared.effect.area.after.name,
            color: plan.value.prepared.effect.area.after.color,
            rev: plan.value.prepared.effect.area.after.rev });
        const nativeChild = plan.value.prepared.effect.projects[0].after;
        expect(useTaskStore.getState()._allProjects[0]).toMatchObject({ id: nativeChild.id,
            areaTitle: nativeChild.areaTitle, color: nativeChild.color, rev: nativeChild.rev });
    });

    it('accepts full after-set receipt before changed guards and rejects a partial descendant replay', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt, rev: 2 });
        const child = project('linked', { areaId: old.id, deletedAt, rev: 2 });
        const { methods, saves } = await open({ areas: [old], projects: [child] });
        const input = request({ expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        const count = saves();
        setSavedState((state) => ({ settings: { ...state.settings, deviceId: 'changed-device' },
            _allAreas: [...state._allAreas, area('new-high-order', 'Other', { order: 42 })] }));
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
        setSavedState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === child.id
            ? { ...row, color: '#000000' } : row) }));
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('applies the frozen restore when persisted row values have only changed key order', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt });
        const child = project('linked', { areaId: old.id, deletedAt });
        const { methods, data } = await open({ areas: [old], projects: [child] });
        const input = request({ expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        setSavedState((state) => ({ _allProjects: state._allProjects.map((row) =>
            Object.fromEntries(Object.entries(row).reverse()) as Project) }));
        expect(await methods.commitPreparedAreaCreate({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { id: old.id, created: true } });
        expect(data().areas[0].deletedAt).toBeUndefined();
        expect(data().projects[0].deletedAt).toBeUndefined();
    });

    it('accepts a Foundation-style sorted-key restore with Project attachments without rewriting their SQL text', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt });
        const attachment = {
            id: 'attachment', kind: 'link', title: 'Source', uri: 'https://example.test/',
            createdAt: now, updatedAt: now,
        } as const;
        const child = project('linked', { areaId: old.id, deletedAt,
            attachments: [attachment, { ...attachment, id: 'second-attachment' }] });
        const attachmentIndex = PROJECT_SQLITE_COLUMNS.indexOf('attachments');
        const attachmentText = projectToSqliteRow(child)[attachmentIndex];
        const { methods, data, saves } = await open({ areas: [old], projects: [child] });
        const input = request({ expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)])) : value;
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(sameAreaAdditionRow.project(child, sortKeys(child) as Project)).toBe(true);
        expect(sameAreaAdditionRow.project(child, { ...child,
            attachments: [...child.attachments!].reverse() })).toBe(false);
        expect(sameAreaAdditionRow.project(child, { ...child,
            attachments: [{ ...attachment, uri: 'https://changed.test/' }, child.attachments![1]] }))
            .toBe(false);
        expect(methods.validatePreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true,
            value: { id: old.id, created: true } });
        expect(projectToSqliteRow(data().projects[0])[attachmentIndex]).toBe(attachmentText);
        const count = saves();
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true,
            value: { id: old.id, created: true } });
        expect(saves()).toBe(count);
    });

    it('requires the initialized device ID in the full after-state receipt', async () => {
        const { methods, saves } = await open();
        setSavedState((state) => ({ settings: { ...state.settings, deviceId: undefined } }));
        const input = request();
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        const initialized = plan.value.prepared.deviceIdToInitialize;
        expect(initialized).toBeTruthy();
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        const count = saves();
        for (const deviceId of [undefined, 'different-device']) {
            setSavedState((state) => ({ settings: { ...state.settings, deviceId } }));
            expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(saves()).toBe(count);
        }
        setSavedState((state) => ({ settings: { ...state.settings, deviceId: initialized! } }));
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
    });

    it('refuses stale target and newly matching descendant before first apply without writing', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt });
        const { methods, saves } = await open({ areas: [old] });
        const input = request({ expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const before = saves();
        setSavedState({ _allProjects: [project('new-child', { areaId: old.id, deletedAt })] });
        expect(await methods.commitPreparedAreaCreate({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        setSavedState({ _allProjects: [], _allAreas: [{ ...old, name: 'Renamed' }] });
        expect(await methods.commitPreparedAreaCreate({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
    });

    it('refuses a name resolution, order, device, or occupied UUID change before first fresh apply', async () => {
        for (const change of ['name', 'order', 'device', 'id'] as const) {
            const { methods, saves } = await open();
            const input = request();
            const resolved = methods.resolveAreaCreateName({ requestId, name: input.name });
            expect(resolved).toMatchObject({ ok: true, value: { expectedAreaId: requestId } });
            if (change === 'name') {
                setSavedState({ _allAreas: [area('other-id', 'Work', { deletedAt: now })] });
                expect(await methods.prepareAreaCreate(input)).toMatchObject({ ok: false,
                    error: { code: 'STALE_REVISION' } });
                continue;
            }
            const plan = await methods.prepareAreaCreate(input);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
            if (change === 'order') setSavedState({ _allAreas: [area('new-order', 'Other', { order: 2.5 })] });
            if (change === 'device') setSavedState((state) => ({ settings: { ...state.settings, deviceId: 'another' } }));
            if (change === 'id') setSavedState({ _allAreas: [area(requestId, 'Other')] });
            const before = saves();
            expect(await methods.commitPreparedAreaCreate({ request: input, prepared: plan.value.prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(saves()).toBe(before);
        }
    });

    it('never restores, recreates, or overwrites after nil-pending probe sees deletion, purge, rename, or displacement', async () => {
        const old = area('area-work', 'Work');
        const { methods, saves } = await open({ areas: [old] });
        const input = request({ expectedAreaId: old.id });
        const before = saves();
        for (const areas of [
            [{ ...old, deletedAt: now }], [], [{ ...old, name: 'Renamed' }],
            [{ ...old, name: 'Renamed' }, area('other', 'Work')],
        ]) {
            setSavedState({ _allAreas: areas });
            expect(methods.probeAreaCreateOutcome(input)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(before);
    });

    it('retries failed atomic persistence with the identical frozen restore and no second revision', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt, rev: 2 });
        const child = project('linked', { areaId: old.id, deletedAt, rev: 2 });
        let failSave = false;
        const { methods, data } = await open({ areas: [old], projects: [child] }, () => failSave);
        const input = request({ expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        const before = structuredClone(data());
        failSave = true;
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(data()).toEqual(before);
        expect(useTaskStore.getState()._allAreas[0].rev).toBe(4);
        failSave = false;
        expect(await methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(data().areas[0].rev).toBe(4);
        expect(data().projects[0].rev).toBe(4);
        const cold = await open(data());
        const count = cold.saves();
        expect(await cold.methods.commitPreparedAreaCreate(frozen)).toMatchObject({ ok: true });
        expect(cold.saves()).toBe(count);
    });

    it('rejects forged result, color, descendant, order, and oversized UTF-8 effect before mutation', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt });
        const child = project('linked', { areaId: old.id, deletedAt });
        const { methods, saves } = await open({ areas: [old], projects: [child] });
        const input = request({ expectedAreaId: old.id });
        const plan = await methods.prepareAreaCreate(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const before = saves();
        const corruptions = [
            (item: typeof plan.value.prepared) => { item.result.id = 'wrong'; },
            (item: typeof plan.value.prepared) => { item.effect.area.after.color = '#000000'; },
            (item: typeof plan.value.prepared) => { item.effect.projects[0].after.color = '#000000'; },
            (item: typeof plan.value.prepared) => { item.effect.projects.pop(); },
            (item: typeof plan.value.prepared) => { item.orderMax = Number.POSITIVE_INFINITY; },
            (item: typeof plan.value.prepared) => { item.scope.projects[0].title = '漢'.repeat(700_000); },
        ];
        for (const corrupt of corruptions) {
            const prepared = structuredClone(plan.value.prepared);
            corrupt(prepared);
            expect(methods.validatePreparedAreaCreate({ request: input, prepared })).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await methods.commitPreparedAreaCreate({ request: input, prepared })).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(saves()).toBe(before);
    });

    it('refuses an oversized legacy restore before the first write', async () => {
        const deletedAt = '2026-09-27T12:00:00.000Z';
        const old = area('area-work', 'Work', { deletedAt });
        const children = Array.from({ length: 16 }, (_, index) => project(`linked-${index}`, {
            areaId: old.id, deletedAt, supportNotes: '漢'.repeat(50_000),
        }));
        const { methods, saves } = await open({ areas: [old], projects: children });
        const input = request({ expectedAreaId: old.id });
        const before = saves();
        expect(await methods.prepareAreaCreate(input)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
        expect(useTaskStore.getState()._allAreas[0].deletedAt).toBe(deletedAt);
    });
});
