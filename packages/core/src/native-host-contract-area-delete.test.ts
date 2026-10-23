import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAreaDeleteMethods, type NativeAreaDeleteRequest } from './native-host-contract-area-delete';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';
import { mergeAppData } from './sync';
import { sameAreaAdditionRow } from './store-projects/area-actions';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';

const now = '2026-09-27T15:00:00.000Z';
const area = (id = 'work', overrides: Partial<Area> = {}): Area => ({
    id, name: 'Work', color: '#3b82f6', order: 0, rev: 3, revBy: 'old-device',
    createdAt: now, updatedAt: now, ...overrides,
});
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, status: 'next', tags: ['#test'], contexts: ['@home'], areaId: 'work',
    description: 'Keep this metadata', dueDate: '2026-10-01',
    checklist: [{ id: `${id}-check`, title: 'Check', isCompleted: true }],
    attachments: [{ id: `${id}-attachment`, kind: 'link', title: 'Source', uri: 'https://example.test/',
        createdAt: now, updatedAt: now }],
    rev: 5, revBy: 'old-device', createdAt: now, updatedAt: now, ...overrides,
});
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: [], areaId: 'work',
    areaTitle: 'Work', rev: 4, revBy: 'old-device', createdAt: now, updatedAt: now, ...overrides,
});

// These mutations model a saved sync/other-writer change, rather than a UI-only projection.
let updateSavedData: (() => void) | undefined;
const setSavedState: typeof useTaskStore.setState = (...args) => {
    useTaskStore.setState(...args); updateSavedData?.();
};

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [area()], people: [],
        settings: { deviceId: 'area-device' }, ...initial };
    let saves = 0;
    let bootstrapping = true;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (!bootstrapping && fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
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
    const methods = createAreaDeleteMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision',
        sortedAreas: () => [...useTaskStore.getState()._allAreas].filter((row) => !row.deletedAt)
            .sort((a, b) => a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name)),
    });
    const request = (): NativeAreaDeleteRequest => {
        const options = methods.getAreaDeleteOptions();
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const selected = options.value.areas.find((row) => row.id === 'work')!;
        const { id: _id, projectCount: _count, canDelete: _canDelete, ...expected } = selected;
        return { requestId: '03f9120c-cf05-4711-9b1e-7fcbeb055382', areaId: selected.id, expected };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Area delete', () => {
    it.each([1, 2] as const)('cold-retries and receipts the frozen v%s Project detach color policy', async (version) => {
        const first = await open({ projects: [project('inherited')] });
        const input = { ...first.request(), detachProjects: true as const };
        const plan = await first.methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.version).toBe(2);
        const prepared = structuredClone(plan.value.prepared);
        prepared.version = version;
        if (version === 1) {
            // Historical v1 detached the relationship but retained the compatibility color.
            for (const pair of prepared.effect.projects!) pair.after.color = pair.before.color;
        }
        const frozen = JSON.parse(JSON.stringify({ request: input, prepared }));
        const snapshot = structuredClone(first.data());
        let failed = true;
        const cold = await open(snapshot, () => failed);
        expect(cold.methods.validatePreparedAreaDelete(frozen)).toMatchObject({ ok: true });
        expect(await cold.methods.commitPreparedAreaDelete(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(cold.data().projects[0].areaId).toBe('work');
        failed = false;
        expect(await cold.methods.commitPreparedAreaDelete(frozen)).toMatchObject({ ok: true });
        expect(cold.data().projects[0].areaId).toBeUndefined();
        expect(cold.data().projects[0].color).toBe(version === 1 ? '#3b82f6' : '#94a3b8');
        const receipt = await open(structuredClone(cold.data()));
        expect(await receipt.methods.commitPreparedAreaDelete(frozen)).toMatchObject({ ok: true });
        expect(receipt.saves()).toBe(0);
    });

    it('accepts a Foundation-style sorted-key journal for a rich linked Task', async () => {
        const first = task('linked');
        const linked = { ...first, attachments: [first.attachments![0],
            { ...first.attachments![0], id: 'second-attachment' }] };
        const attachmentIndex = TASK_SQLITE_COLUMNS.indexOf('attachments');
        const attachmentText = taskToSqliteRow(linked)[attachmentIndex];
        const { methods, request, data, saves } = await open({ tasks: [linked] });
        const input = request();
        const plan = await methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)])) : value;
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(sameAreaAdditionRow.task(linked, sortKeys(linked) as Task)).toBe(true);
        expect(sameAreaAdditionRow.task(linked, { ...linked,
            attachments: [...linked.attachments].reverse() })).toBe(false);
        expect(sameAreaAdditionRow.task(linked, { ...linked,
            attachments: [{ ...linked.attachments[0], uri: 'https://changed.test/' }, linked.attachments[1]] }))
            .toBe(false);
        expect(methods.validatePreparedAreaDelete(frozen)).toMatchObject({ ok: true });
        expect(await methods.commitPreparedAreaDelete(frozen))
            .toMatchObject({ ok: true, value: { areaId: 'work' } });
        expect(data().tasks[0].areaId).toBeUndefined();
        expect(taskToSqliteRow(data().tasks[0])[attachmentIndex]).toBe(attachmentText);
        const count = saves();
        setSavedState((state) => ({ _allTasks: [...state._allTasks, task('new')] }));
        expect(await methods.commitPreparedAreaDelete(frozen)).toMatchObject({ ok: true,
            value: { areaId: 'work' } });
        expect(saves()).toBe(count);
    });

    it('counts all live Project statuses but excludes tombstones, matching RN manager policy', async () => {
        const { methods, request, saves } = await open({ projects: [
            project('archived', { status: 'archived' }), project('deferred', { status: 'someday' }),
            project('deleted', { deletedAt: now }),
        ] });
        expect(methods.getAreaDeleteOptions()).toMatchObject({ ok: true, value: {
            areas: [{ id: 'work', projectCount: 2, canDelete: false }] } });
        expect(await methods.prepareAreaDelete(request())).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('Settings mode detaches live Projects and direct Tasks, then replays the exact frozen result after reload', async () => {
        const live = project('live', { notes: 'Keep project metadata' });
        const deleted = project('deleted', { deletedAt: now });
        const linked = task('linked');
        const trashed = task('trashed', { deletedAt: now });
        const unrelated = project('other', { areaId: 'other', areaTitle: 'Other' });
        const first = await open({ areas: [area(), area('other', { name: 'Other', order: 1 })],
            projects: [live, deleted, unrelated],
            tasks: [linked, trashed, task('other', { areaId: 'other' })] });
        const legacy = first.request();
        expect(await first.methods.prepareAreaDelete(legacy)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const request = { ...legacy, detachProjects: true as const };
        const plan = await first.methods.prepareAreaDelete(request);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.scope.liveProjects).toEqual([live]);
        expect(plan.value.prepared.effect.projects).toHaveLength(1);
        const envelope = { request, prepared: plan.value.prepared };
        expect(Object.hasOwn(envelope.prepared.effect, 'projects')).toBe(true);
        expect(first.methods.validatePreparedAreaDelete(envelope)).toMatchObject({ ok: true });
        expect(await first.methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: true });
        const saved = structuredClone(first.data());
        expect(saved.areas[0]).toEqual(plan.value.prepared.effect.area.after);
        expect(saved.projects[0]).toEqual(plan.value.prepared.effect.projects![0].after);
        expect(saved.projects[1]).toEqual(deleted);
        expect(saved.projects[2]).toEqual(unrelated);
        expect(saved.tasks.slice(0, 2)).toEqual(plan.value.prepared.effect.tasks.map((row) => row.after));
        expect(saved.tasks[2].areaId).toBe('other');
        const second = await open(saved);
        const before = second.saves();
        expect(await second.methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(before);
        setSavedState({ _allProjects: useTaskStore.getState()._allProjects.map((row) => row.id === 'live'
            ? { ...row, title: 'Later edit', rev: (row.rev ?? 0) + 1 } : row) });
        expect(await second.methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('Settings mode rejects changed membership and forged mode/effects before persistence', async () => {
        const live = project('live');
        const linked = task('linked');
        const { methods, request: getRequest, saves } = await open({ projects: [live], tasks: [linked] });
        const request = { ...getRequest(), detachProjects: true as const };
        const plan = await methods.prepareAreaDelete(request);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        const envelope = { request, prepared: plan.value.prepared };
        for (const bad of [
            { ...request, detachProjects: false },
            { ...request, detachProjects: 'true' },
            { ...request, extra: true },
        ]) expect(await methods.prepareAreaDelete(bad as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const forged = structuredClone(envelope);
        forged.prepared.effect.projects![0].after.title = 'Forged';
        expect(methods.validatePreparedAreaDelete(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const omitted = structuredClone(envelope);
        delete omitted.prepared.effect.projects;
        expect(methods.validatePreparedAreaDelete(omitted)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.validatePreparedAreaDelete({ ...envelope, request: getRequest() }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const projects of [[{ ...live, title: 'Edited' }], [live, project('added')]]) {
            setSavedState({ _allProjects: projects });
            expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
        }
        setSavedState({ _allProjects: [live], _allTasks: [linked, task('added')] });
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allTasks: [{ ...linked, title: 'Edited' }] });
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('keeps empty Settings project effects distinct from legacy envelopes', async () => {
        const { methods, request: getRequest } = await open({ tasks: [task('linked')] });
        const legacy = await methods.prepareAreaDelete(getRequest());
        const manageRequest = { ...getRequest(), detachProjects: true as const };
        const manage = await methods.prepareAreaDelete(manageRequest);
        if (!legacy.ok || !manage.ok) throw new Error('Area delete preparation failed');
        expect(Object.hasOwn(legacy.value.prepared.effect, 'projects')).toBe(false);
        expect(manage.value.prepared.effect.projects).toEqual([]);
        const forged = structuredClone(legacy.value.prepared);
        forged.effect.projects = [];
        expect(methods.validatePreparedAreaDelete({ request: getRequest(), prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.validatePreparedAreaDelete({ request: manageRequest, prepared: legacy.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.validatePreparedAreaDelete({ request: getRequest(), prepared: manage.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('detaches direct and trashed Tasks, preserving rich metadata and unrelated rows', async () => {
        const linked = task('linked');
        const trashed = task('trashed', { deletedAt: now });
        const nested = task('nested', { areaId: undefined, projectId: 'deleted', sectionId: 'section' });
        const deleted = project('deleted', { deletedAt: now });
        const section: Section = { id: 'section', projectId: 'deleted', title: 'Section', order: 0,
            createdAt: now, updatedAt: now };
        const { methods, request, data } = await open({ tasks: [linked, trashed, nested],
            projects: [deleted], sections: [section] });
        const nestedBefore = useTaskStore.getState()._allTasks.find((row) => row.id === 'nested');
        const sectionBefore = useTaskStore.getState()._allSections.find((row) => row.id === 'section');
        const input = request();
        const plan = await methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.scope.tasks.map((row) => row.id)).toEqual(['linked', 'trashed']);
        expect(plan.value.prepared.scope.liveProjects).toEqual([]);
        expect(await methods.commitPreparedAreaDelete({ request: input, prepared: plan.value.prepared }))
            .toEqual({ ok: true, value: { areaId: 'work' } });
        expect(data().areas[0].deletedAt).toBeDefined();
        expect(data().projects[0]).toEqual(deleted);
        expect(data().tasks.map((row) => row.id)).toEqual(['linked', 'trashed', 'nested']);
        for (const { before, after } of plan.value.prepared.effect.tasks) {
            const persisted = data().tasks.find((row) => row.id === before.id)!;
            expect(persisted).toEqual(after);
            expect(persisted).toMatchObject({ title: before.title, tags: before.tags,
                contexts: before.contexts, checklist: before.checklist, attachments: before.attachments,
                dueDate: before.dueDate });
            expect(persisted.deletedAt).toBe(before.deletedAt);
        }
        expect(data().tasks[2]).toEqual(nestedBefore);
        expect(data().sections.find((row) => row.id === 'section')).toEqual(sectionBefore);
        const canonical = mergeAppData(data(), data(), { nowIso: now });
        expect(mergeAppData(canonical, data(), { nowIso: now })).toEqual(canonical);
    });

    it('keeps direct deleteArea broad for a linked live Project', async () => {
        const { data } = await open({ projects: [project('active')], tasks: [task('direct')] });
        expect((await useTaskStore.getState().deleteArea('work')).success).toBe(true);
        await flushPendingSave();
        expect(data().projects[0].areaId).toBeUndefined();
        expect(data().projects[0].areaTitle).toBeUndefined();
        expect(data().tasks[0].areaId).toBeUndefined();
        expect(data().areas[0].deletedAt).toBeDefined();
    });

    it('refuses changed linked Task membership, Task content, and new live Project before first apply', async () => {
        const original = task('linked');
        const { methods, request, saves } = await open({ tasks: [original] });
        const input = request();
        const plan = await methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        setSavedState({ _allTasks: [original, task('new')] });
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allTasks: [task('linked', { title: 'Changed' })] });
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        setSavedState({ _allTasks: [original], _allProjects: [project('new')] });
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('retries failed persistence exactly, then receipts before changed membership guards', async () => {
        let failed = false;
        const { methods, request, data, saves } = await open({ tasks: [task('linked')] }, () => failed);
        const input = request();
        const plan = await methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        failed = true;
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(data().areas[0].deletedAt).toBeUndefined();
        failed = false;
        expect(await methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: true });
        expect(data().tasks.find((row) => row.id === 'linked')?.updatedAt)
            .toBe(plan.value.prepared.updateAt);
        const saved = structuredClone(data());
        const second = await open(saved);
        await flushPendingSave();
        const before = second.saves();
        expect(sameAreaAdditionRow.area(useTaskStore.getState()._allAreas.find((row) => row.id === 'work')!,
            plan.value.prepared.effect.area.after)).toBe(true);
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'linked'))
            .toEqual(plan.value.prepared.effect.tasks[0].after);
        expect(sameAreaAdditionRow.task(useTaskStore.getState()._allTasks.find((row) => row.id === 'linked')!,
            plan.value.prepared.effect.tasks[0].after)).toBe(true);
        setSavedState({ _allTasks: [...useTaskStore.getState()._allTasks, task('new')],
            _allProjects: [project('new')] });
        expect(await second.methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(before);
        setSavedState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'linked'
            ? { ...row, title: 'Later edit', rev: (row.rev ?? 0) + 1 } : row) });
        expect(await second.methods.commitPreparedAreaDelete(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(second.saves()).toBe(before);
        expect(saves()).toBeGreaterThan(0);
    });

    it('applies a cold prepared request with a missing device ID only once', async () => {
        const first = await open({ tasks: [task('linked')], settings: {} });
        setSavedState({ settings: {} });
        const input = first.request();
        const plan = await first.methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(plan.value.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f]{8}-/);
        const snapshot = structuredClone(first.data());
        const second = await open(snapshot);
        await flushPendingSave();
        setSavedState({ settings: {} });
        expect(await second.methods.commitPreparedAreaDelete({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true, value: { areaId: 'work' } });
        expect(second.data().settings.deviceId).toBe(plan.value.prepared.deviceIdToInitialize);
        expect(second.data().tasks[0].areaId).toBeUndefined();
        expect(second.data().areas[0].deletedAt).toBe(plan.value.prepared.updateAt);
    });

    it('rejects forged/incomplete/oversized payloads and probes nil pending without a write', async () => {
        const { methods, request, saves } = await open({ tasks: [task('linked')] });
        const input = request();
        const plan = await methods.prepareAreaDelete(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        const forged = structuredClone(envelope);
        forged.prepared.scope.liveProjects = [project('active')];
        expect(methods.validatePreparedAreaDelete(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const incomplete = structuredClone(envelope);
        (incomplete.prepared.scope.tasks[0] as Partial<Task>).tags = undefined;
        expect(methods.validatePreparedAreaDelete(incomplete)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const changed = structuredClone(envelope);
        changed.prepared.effect.tasks[0].after.title = 'Forged';
        expect(methods.validatePreparedAreaDelete(changed)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(await methods.prepareAreaDelete({ ...input, areaId: 'x'.repeat(2_000_001) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeAreaDeleteOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });
});
