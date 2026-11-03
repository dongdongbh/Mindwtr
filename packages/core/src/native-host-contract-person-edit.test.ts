import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonEditMethods, type NativePersonEditRequest } from './native-host-contract-person-edit';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { personPersistedSnapshot } from './store-projects/people-actions';
import { planManageEditorSave } from './manage-settings-model';
import { nextRevision } from './store-helpers';
import { DEFAULT_AREA_COLOR } from './color-constants';
import { TASK_SYNC_SCHEMA_FIXTURE } from './task-sync-schema';
import { normalizeTaskForLoad } from './task-status';
import type { AppData, Person, Task } from './types';

const requestId = '00000000-0000-4000-8000-000000000394';
const updateAt = '2026-09-30T12:00:00.000Z';
const renameAt = '2026-09-30T12:00:00.010Z';
const person = (overrides: Partial<Person> = {}): Person => ({ id: 'source', name: 'Alex Smith',
    note: 'Keep note', referenceLink: 'obsidian://keep', rev: 5, revBy: 'before-device',
    createdAt: '2026-09-29T15:00:00Z', updatedAt: 'legacy updated stamp', ...overrides });
const request = (expected = person(), overrides: Partial<NativePersonEditRequest> = {}): NativePersonEditRequest => ({
    requestId, personId: expected.id, expected: personPersistedSnapshot(expected), name: expected.name,
    note: expected.note ?? '', referenceLink: expected.referenceLink ?? '', ...overrides,
});
const tasks = (): Task[] => ['live', 'done', 'archived', 'reference', 'purged-only', 'deleted', 'context-only', 'other']
    .map((id, index) => ({ ...structuredClone(TASK_SYNC_SCHEMA_FIXTURE), id,
        status: (['next', 'done', 'archived', 'reference', 'next', 'next', 'next', 'next'] as const)[index],
        assignedTo: index >= 6 ? 'Other' : ' alex   SMITH ', contexts: ['@Alex Smith'],
        ...(index === 4 ? { purgedAt: updateAt, deletedAt: undefined } : {}),
        ...(index === 5 ? { deletedAt: updateAt } : { deletedAt: undefined }),
        rev: 9, revBy: 'before-device', createdAt: 'legacy task creation', updatedAt: 'legacy task update' }));
async function open(initial: Partial<AppData> = {}, fail?: () => boolean, failAfterWrite?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [person()],
        settings: { deviceId: 'person-device' }, ...structuredClone(initial) };
    let saves = 0;
    let readHook: (() => void) | undefined;
    setStorageAdapter({ getData: async () => { readHook?.(); return structuredClone(data); }, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
        if (failAfterWrite?.()) throw new Error('acknowledgment unavailable after write');
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();

    useTaskStore.setState({ _allPeople: structuredClone(initial.people ?? [person()]),
        _allTasks: structuredClone(initial.tasks ?? []) });
    const matureSettings = structuredClone(data.settings);
    data = { ...data, people: structuredClone(initial.people ?? [person()]), tasks: structuredClone(initial.tasks ?? []),
        settings: structuredClone(initial.settings ?? { deviceId: 'person-device' }) };
    saves = 0;
    const methods = createPersonEditMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
        try { await flushPendingSave(); return { ok: true as const, value: null }; }
        catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'disk unavailable' } }; }
    } });
    return { methods, data: () => data, saves: () => saves, matureSettings,
        onRead: (hook: () => void) => { readHook = hook; },
        setData: (next: Partial<AppData>) => { data = { ...data, ...structuredClone(next) }; } };
}
const freeze = async (methods: ReturnType<typeof createPersonEditMethods>, input = request()) => {
    const plan = await methods.preparePersonEdit(input);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return structuredClone({ request: input, prepared: plan.value.prepared });
};
const withTimes = (frozen: Awaited<ReturnType<typeof freeze>>, first = updateAt, second: string | null = renameAt) => {

    expect(frozen.prepared.updateAt).toBe(first);
    expect(frozen.prepared.renameAt).toBe(second);
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('prepared native Person edit', () => {
    it('projects newly observed durable metadata on renamed Tasks while retaining raw terminal focus on disk', async () => {
        const legacy = { ...tasks()[1], createdAt: updateAt, updatedAt: updateAt,
            focusOrder: 9, description: 'Original description' };
        const env = await open({ tasks: [legacy] });
        useTaskStore.setState({ _allTasks: [normalizeTaskForLoad(legacy)] });
        const fresh = { ...legacy, description: 'New durable description',
            checklist: [{ id: 'new-check', title: 'New durable check', isCompleted: true }], rev: (legacy.rev ?? 0) + 1 };
        env.setData({ tasks: [fresh] });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        expect(frozen.prepared.scope.tasks).toEqual([fresh]);
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        const after = frozen.prepared.effect.tasks[0].after;
        expect(env.data().tasks).toEqual([after]); expect(after.focusOrder).toBe(9);
        expect(useTaskStore.getState()._allTasks).toEqual([{ ...normalizeTaskForLoad(fresh),
            assignedTo: after.assignedTo, updatedAt: after.updatedAt, rev: after.rev, revBy: after.revBy }]);
        expect(useTaskStore.getState()._allTasks[0].focusOrder).toBeUndefined();
    });

    it.each(['synchronous', 'microtask'])('cannot own a %s subscriber Task intent coalesced with its failed save', async (timing) => {
        let failing = false;
        const task: Task = { id: 'unrelated', title: 'Task', description: 'Original', status: 'next', tags: [], contexts: [],
            createdAt: updateAt, updatedAt: updateAt, rev: 1, revBy: 'person-device' };
        const env = await open({ tasks: [task] }, () => failing);
        const frozen = await freeze(env.methods, request(person(), { note: 'Metadata change' }));
        const before = structuredClone(env.data()); let armed = true;
        let foreignWrite: Promise<unknown> | undefined;
        const unsubscribe = useTaskStore.subscribe((current, previous) => {
            if (!armed || current._allPeople === previous._allPeople) return;
            armed = false;
            const edit = () => { foreignWrite = useTaskStore.getState().updateTask('unrelated', { description: 'Foreign coalesced intent' }); };
            if (timing === 'microtask') queueMicrotask(edit); else edit();
        });
        failing = true;
        try { expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); }
        finally { unsubscribe(); }
        expect(await foreignWrite).toMatchObject({ success: true }); expect(armed).toBe(false);
        const failed = useTaskStore.getState(); const memory = structuredClone(failed._allTasks);
        const status = getPersistenceStatus();
        expect(failed.persistenceFailure).not.toBeNull(); expect(memory[0].description).toBe('Foreign coalesced intent');
        expect(env.data()).toEqual(before); expect(env.saves()).toBe(0);
        failing = false;
        for (let retry = 0; retry < 2; retry++) {
            expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(useTaskStore.getState()._allTasks).toEqual(memory);
            expect(useTaskStore.getState().persistenceFailure).toBe(failed.persistenceFailure);
            expect(useTaskStore.getState().lastDataChangeAt).toBe(failed.lastDataChangeAt);
            expect(getPersistenceStatus()).toEqual(status);
            expect(env.data()).toEqual(before); expect(env.saves()).toBe(0);
        }
    }, 15_000);

    it('preserves raw archived Project focus on disk and its normal lifecycle projection in memory', async () => {
        const project = { id: 'archived-project', title: 'Archived', status: 'archived' as const, isFocused: true,
            color: '#3b82f6', order: 0, tagIds: [], createdAt: updateAt, updatedAt: updateAt };
        const env = await open({ projects: [project] });
        env.setData({ projects: [project], settings: env.matureSettings });
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        expect(env.saves()).toBe(0); expect(env.data().projects[0].isFocused).toBe(true);
        expect(useTaskStore.getState()._allProjects[0].isFocused).toBe(false);
        const frozen = await freeze(env.methods, request(person(), { note: 'Metadata change' }));
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().projects).toEqual([project]);
        expect(useTaskStore.getState()._allProjects[0].isFocused).toBe(false);
    });

    it('durable-before refuses a foreign failed Task write without losing its memory intent or clearing its failure', async () => {
        let failing = false;
        const task: Task = { id: 'live', title: 'Task', description: 'Original', status: 'next', tags: [], contexts: [],
            createdAt: updateAt, updatedAt: updateAt, rev: 1, revBy: 'person-device' };
        const env = await open({ tasks: [task] }, () => failing);
        const frozen = await freeze(env.methods, request(person(), { note: 'Person metadata change' }));
        const durableBefore = structuredClone(env.data());
        failing = true;
        expect(await useTaskStore.getState().updateTask('live', { description: 'Unrelated unsaved intent' })).toMatchObject({ success: true });
        await expect(flushPendingSave()).rejects.toThrow();
        const failedState = useTaskStore.getState();
        const failedMemory = structuredClone(failedState._allTasks);
        const failure = failedState.persistenceFailure;
        expect(failure).not.toBeNull();
        expect(failedMemory[0].description).toBe('Unrelated unsaved intent');
        expect(env.data()).toEqual(durableBefore);
        const generation = getPersistenceStatus().generation;
        failing = false;
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(durableBefore); expect(env.saves()).toBe(0);
        expect(useTaskStore.getState()._allTasks).toEqual(failedMemory);
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        expect(useTaskStore.getState().lastDataChangeAt).toBe(failedState.lastDataChangeAt);
        expect(getPersistenceStatus().generation).toBe(generation);
    }, 15_000);

    it('successful same-host retry flushes the durable effect without replacing it with normalized memory', async () => {
        let failing = false;
        const legacy = { ...tasks()[1], focusOrder: 9 };
        const env = await open({ tasks: [legacy] }, () => failing);
        useTaskStore.setState({ _allTasks: [normalizeTaskForLoad(legacy)] });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        failing = true;
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().tasks).toEqual(frozen.prepared.effect.tasks.map(({ after }) => after));
        expect(env.data().tasks[0].focusOrder).toBe(9);
        expect(useTaskStore.getState()._allTasks[0].focusOrder).toBeUndefined();
    }, 15_000);

    it('landed-after-throw exact replay settles only its own exhausted failure without writing stale memory or unrelated rows', async () => {
        let failingAfterWrite = false;
        const legacy = { ...tasks()[1], focusOrder: 9 };
        const env = await open({ tasks: [legacy] }, undefined, () => failingAfterWrite);
        useTaskStore.setState({ _allTasks: [normalizeTaskForLoad(legacy)] });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        failingAfterWrite = true;
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const unrelatedPerson = person({ id: 'later-person', name: 'Later Person' });
        const unrelatedTask = { ...tasks()[7], id: 'later-task', description: 'Later edit' };
        env.setData({ people: [...env.data().people!, unrelatedPerson], tasks: [...env.data().tasks, unrelatedTask] });
        const after = structuredClone(env.data()); const writes = env.saves();
        failingAfterWrite = false;
        const otherRequest = { ...frozen.request, requestId: '00000000-0000-4000-8000-000000000395' };
        const otherPrepared = { ...frozen.prepared, request: otherRequest };
        expect(await env.methods.commitPreparedPersonEdit({ request: otherRequest, prepared: otherPrepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(after); expect(env.saves()).toBe(writes);
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data()).toEqual(after); expect(env.saves()).toBe(writes);
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
        useTaskStore.setState({ persistenceFailure: { message: 'Unrelated failure', failedAt: updateAt, retrying: false } });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.saves()).toBe(writes); expect(env.data()).toEqual(after);
        expect(useTaskStore.getState().persistenceFailure?.message).toBe('Unrelated failure');
    }, 15_000);

    it.each(['adapter', 'epoch', 'queue', 'failure'] as const)('exact-after cannot clear an owned failure after %s changes', async (mutation) => {
        let failingAfterWrite = false;
        const env = await open({ tasks: [tasks()[0]] }, undefined, () => failingAfterWrite);
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        failingAfterWrite = true;
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const after = structuredClone(env.data()); const writes = env.saves();
        failingAfterWrite = false;
        const state = useTaskStore.getState();
        if (mutation === 'adapter') setStorageAdapter({ getData: async () => structuredClone(after), saveData: async () => {} });
        if (mutation === 'epoch') useTaskStore.setState({ lastDataChangeAt: state.lastDataChangeAt + 1 });
        if (mutation === 'queue') await state.persistSnapshot();
        if (mutation === 'failure') useTaskStore.setState({ persistenceFailure: { ...state.persistenceFailure! } });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(after); expect(env.saves()).toBe(writes);
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
    }, 15_000);

    it('normal load preserves legacy terminal focus in durable baselines through failed saves and cold original-request replay', async () => {
        let failing = false;

        const stamp = new Date(Date.now() - 86_400_000).toISOString();
        const legacy = ['done', 'archived'].map((status, index) => ({ id: `legacy-${index}`, title: 'Retained task', status,
            assignedTo: person().name, tags: ['#keep'], contexts: ['@keep'], description: 'Keep metadata',
            createdAt: stamp, updatedAt: stamp,
            completedAt: stamp, focusOrder: 9, isFocusedToday: false,
            rev: 9, revBy: 'before-device' } as Task));
        const env = await open({ tasks: legacy }, () => failing);
        env.setData({ settings: env.matureSettings });
        await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
        expect(env.saves()).toBe(0);
        for (const row of useTaskStore.getState()._allTasks) expect(row.focusOrder).toBeUndefined();
        for (const row of env.data().tasks) expect(row.focusOrder).toBe(9);
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee', note: 'Changed' }));
        for (const row of frozen.prepared.scope.tasks) expect(row.focusOrder).toBe(9);
        for (const { after } of frozen.prepared.effect.tasks) expect(after.focusOrder).toBe(9);
        failing = true;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            for (const row of useTaskStore.getState()._allTasks) expect(row.focusOrder).toBeUndefined();
            expect(env.data().tasks).toEqual(legacy);
        }

        failing = false;
        const savedBefore = structuredClone(env.data());
        const cold = await open(savedBefore);
        useTaskStore.setState({ _allTasks: savedBefore.tasks.map((row) => normalizeTaskForLoad(row)) });
        expect(await cold.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true, value: frozen.prepared.result });
        expect(cold.data().tasks).toEqual(frozen.prepared.effect.tasks.map(({ after }) => after));
        for (const row of useTaskStore.getState()._allTasks) expect(row.focusOrder).toBeUndefined();
        const after = structuredClone(cold.data());
        const replay = await open(after);
        useTaskStore.setState({ _allTasks: after.tasks.map((row) => normalizeTaskForLoad(row)) });
        expect(await replay.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(replay.saves()).toBe(0);
        const changed = await open({ ...savedBefore, tasks: savedBefore.tasks.map((row, index) => index ? row : { ...row, focusOrder: 10 }) });
        useTaskStore.setState({ _allTasks: changed.data().tasks.map((row) => normalizeTaskForLoad(row)) });
        expect(await changed.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(changed.saves()).toBe(0); expect(changed.data().tasks[0].focusOrder).toBe(10);
    }, 20_000);

    it.each(['prepare', 'commit'] as const)('%s rejects adapter, Task reference, Person reference, settings or data epoch changes across the read await', async (phase) => {
        for (const mutation of ['adapter', 'tasks', 'people', 'settings', 'epoch']) {
            const env = await open({ tasks: tasks() });
            const input = request(person(), { name: 'Morgan Lee' });
            const frozen = await freeze(env.methods, input);
            env.onRead(() => {
                const state = useTaskStore.getState();
                if (mutation === 'adapter') setStorageAdapter({ getData: async () => env.data(), saveData: async () => {} });
                if (mutation === 'tasks') useTaskStore.setState({ _allTasks: [...state._allTasks] });
                if (mutation === 'people') useTaskStore.setState({ _allPeople: [...state._allPeople] });
                if (mutation === 'settings') useTaskStore.setState({ settings: { ...state.settings, deviceId: 'intervening-device' } });
                if (mutation === 'epoch') useTaskStore.setState({ lastDataChangeAt: state.lastDataChangeAt + 1 });
            });
            const result = phase === 'prepare' ? await env.methods.preparePersonEdit(input) : await env.methods.commitPreparedPersonEdit(frozen);
            expect(result, mutation).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(env.saves(), mutation).toBe(0);
        }
    });

    it('uses fresh durable source, destination and device CAS while preserving unrelated durable rows and settings', async () => {
        const target = person({ id: 'target', name: 'Morgan Lee' });
        for (const mutation of ['source', 'destination', 'device']) {
            const env = await open({ people: [person(), target], tasks: tasks() });
            const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));

            env.onRead(() => env.setData(mutation === 'device' ? { settings: { deviceId: 'new-device' } }
                : { people: env.data().people!.map((row) => row.id === (mutation === 'source' ? 'source' : 'target')
                    ? { ...row, note: 'Intervening durable edit', rev: (row.rev ?? 0) + 1 } : row) }));
            expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(env.saves()).toBe(0);
        }
        const env = await open({ people: [person(), target], tasks: tasks() });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        const unrelatedPerson = person({ id: 'external-person', name: 'External Person' });
        const unrelatedTask = { ...tasks()[7], id: 'external-task', assignedTo: 'External Person', focusOrder: 11 };
        env.onRead(() => env.setData({ people: [person(), target, unrelatedPerson], tasks: [...tasks(), unrelatedTask],
            settings: { deviceId: 'person-device', theme: 'light' } }));
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().people!.find((row) => row.id === unrelatedPerson.id)).toEqual(unrelatedPerson);
        expect(env.data().tasks.find((row) => row.id === unrelatedTask.id)).toEqual(unrelatedTask);
        expect(env.data().settings).toEqual({ deviceId: 'person-device', theme: 'light' });
    });

    it('options/check/cancel and canonical no-op are detached and write nothing without device initialization', async () => {
        const current = person({ note: undefined, referenceLink: undefined });
        const env = await open({ people: [current], settings: {} });
        useTaskStore.setState({ settings: {} });
        const options = env.methods.getPersonEditOptions({ personId: current.id });
        expect(options).toEqual({ ok: true, value: { personId: current.id, expected: personPersistedSnapshot(current),
            draft: { name: current.name, color: DEFAULT_AREA_COLOR, note: '', referenceLink: '' } } });
        if (!options.ok) throw new Error('options failed');
        options.value.expected.name = 'Detached';
        expect(useTaskStore.getState()._allPeople[0].name).toBe(current.name);
        expect(env.methods.checkPersonEdit({ name: '  ' })).toEqual({ ok: true, value: { saveDisabled: true } });
        expect(env.methods.checkPersonEdit({ name: ' Alex Smith ' })).toEqual({ ok: true, value: { saveDisabled: false } });
        expect(await env.methods.preparePersonEdit(request(current))).toEqual({ ok: true,
            value: { kind: 'noop', result: { id: current.id, personId: current.id, name: current.name } } });
        expect(env.saves()).toBe(0); expect(useTaskStore.getState().settings).toEqual({});
    });

    it.each([
        { label: 'metadata', draft: { note: ' Changed ', referenceLink: '' } },
        { label: 'NUL link', draft: { referenceLink: 'invalid\0link' } },
        { label: 'rename', draft: { name: '  Morgan   Lee ' } },
        { label: 'both', draft: { name: 'Morgan Lee', note: 'Changed', referenceLink: ' custom://new ' } },
        { label: 'case-only', draft: { name: 'ALEX SMITH' } },
        { label: 'canonical rename no-op', draft: { name: 'Alex  Smith' } },
        { label: 'metadata with canonical rename no-op', draft: { name: 'Alex  Smith', note: 'Changed' } },
    ])('matches actual RN two-action final rows: $label', async ({ draft }) => {
        const initial = { people: [person()], tasks: tasks() };
        const input = request(person(), draft);
        await open(initial);
        const writes = planManageEditorSave({ type: 'person', ...person() }, { ...input, color: '' }, {})!;
        vi.useFakeTimers();
        for (const write of writes) {
            vi.setSystemTime(new Date(write.kind === 'updatePerson' ? updateAt : renameAt));
            if (write.kind === 'updatePerson') expect(await useTaskStore.getState().updatePerson(write.id, write.updates)).toEqual({ success: true });
            if (write.kind === 'renamePerson') expect(await useTaskStore.getState().renamePerson(write.id, write.name, write.options)).toEqual({ success: true });
        }
        const rn = JSON.parse(JSON.stringify({ people: useTaskStore.getState()._allPeople, tasks: useTaskStore.getState()._allTasks }));
        vi.useRealTimers();
        const native = await open(initial);

        let clock = 0;
        const RealDate = Date;
        class FrozenDate extends RealDate {
            constructor(value?: string | number) { super(value ?? (clock++ === 0 ? updateAt : renameAt)); }
        }
        vi.stubGlobal('Date', FrozenDate);
        const planned = await native.methods.preparePersonEdit(input);
        vi.unstubAllGlobals();
        if (!planned.ok) throw new Error(JSON.stringify(planned));
        if (planned.value.kind === 'noop') {
            expect(rn).toEqual(JSON.parse(JSON.stringify(initial))); expect(native.saves()).toBe(0); return;
        }
        const frozen = { request: input, prepared: planned.value.prepared };
        withTimes(frozen, updateAt, draft.name && draft.name !== 'Alex  Smith' ? ('note' in draft || 'referenceLink' in draft ? renameAt : updateAt) : null);
        expect(native.methods.validatePreparedPersonEdit(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(await native.methods.commitPreparedPersonEdit(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        const expectedRN = rn;

        if (frozen.prepared.renameAt === updateAt) {
            for (const row of [...expectedRN.people, ...expectedRN.tasks]) if (row.updatedAt === renameAt) row.updatedAt = updateAt;
        }
        expect(JSON.parse(JSON.stringify({ people: native.data().people, tasks: native.data().tasks }))).toEqual(expectedRN);
        expect(native.saves()).toBe(1);
    });

    it('metadata-only preserves a raw internal-whitespace name and direct RN omitted/clear/deleted-row behavior', async () => {
        const raw = person({ name: 'Alex  Smith' });
        const env = await open({ people: [raw] });
        const frozen = await freeze(env.methods, request(raw, { note: 'Changed' }));
        expect(frozen.prepared.renameAt).toBeNull(); expect(frozen.prepared.scope.tasks).toEqual([]);
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().people?.[0]).toMatchObject({ name: raw.name, note: 'Changed', rev: 6 });
        await open({ people: [raw] });
        expect(await useTaskStore.getState().updatePerson(raw.id, { note: undefined })).toEqual({ success: true });
        expect(useTaskStore.getState()._allPeople[0]).toMatchObject({ name: raw.name, referenceLink: raw.referenceLink });
        expect(useTaskStore.getState()._allPeople[0].note).toBeUndefined();
        expect(await useTaskStore.getState().renamePerson('missing', 'Name')).toEqual({ success: false, error: 'Person not found' });
        await open({ people: [{ ...raw, deletedAt: updateAt }] });
        expect(await useTaskStore.getState().renamePerson(raw.id, 'Renamed', { updateTasks: false })).toEqual({ success: true });
        expect(useTaskStore.getState()._allPeople[0]).toMatchObject({ name: 'Renamed', deletedAt: updateAt });
    });

    it.each([undefined, '', 'Target note'])('collision preserves target spelling and metadata precedence: %s', async (targetNote) => {
        const source = person();
        const destination = person({ id: 'target', name: 'mORGAN   Lee', note: targetNote,
            referenceLink: undefined, rev: 20 });
        const initial = { people: [destination, source], tasks: tasks() };
        const input = request(source, { name: 'Morgan Lee', note: 'Edited source', referenceLink: 'new://source' });
        const env = await open(initial);
        const frozen = await freeze(env.methods, input);
        expect(frozen.prepared.effect.people).toHaveLength(2);
        expect(frozen.prepared.result).toEqual({ id: source.id, personId: destination.id, name: destination.name });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        const [target, deleted] = env.data().people!;
        expect(target).toMatchObject({ id: destination.id, name: destination.name, createdAt: destination.createdAt,
            note: targetNote ?? 'Edited source', referenceLink: 'new://source', rev: 21 });
        expect(deleted).toMatchObject({ id: source.id, name: source.name, note: 'Edited source', rev: 7,
            deletedAt: frozen.prepared.renameAt });
        const changed = env.data().tasks.filter((row) => !row.deletedAt && row.id !== 'context-only' && row.id !== 'other');
        expect(changed).toHaveLength(5);
        for (const row of changed) expect(row).toMatchObject({ assignedTo: 'Morgan Lee', rev: 10, contexts: ['@Alex Smith'] });
        for (const id of ['deleted', 'context-only', 'other']) expect(env.data().tasks.find((row) => row.id === id))
            .toEqual(initial.tasks.find((row) => row.id === id));
        const finalNative = structuredClone({ people: env.data().people, tasks: env.data().tasks });
        await open(initial);
        const writes = planManageEditorSave({ type: 'person', ...source }, { ...input, color: '' }, {})!;
        vi.useFakeTimers();
        for (const write of writes) {
            vi.setSystemTime(new Date(write.kind === 'updatePerson' ? frozen.prepared.updateAt : frozen.prepared.renameAt!));
            if (write.kind === 'updatePerson') await useTaskStore.getState().updatePerson(write.id, write.updates);
            if (write.kind === 'renamePerson') await useTaskStore.getState().renamePerson(write.id, write.name, write.options);
        }
        expect(JSON.parse(JSON.stringify({ people: useTaskStore.getState()._allPeople, tasks: useTaskStore.getState()._allTasks })))
            .toEqual(finalNative);
        vi.useRealTimers();
    });

    it.each([ [updateAt, updateAt], [renameAt, updateAt] ])('preserves equal/nonmonotonic operation clocks %s -> %s', async (first, second) => {
        const env = await open();
        const RealDate = Date; let count = 0;
        class FrozenDate extends RealDate { constructor(value?: string | number) { super(value ?? (count++ === 0 ? first : second)); } }
        vi.stubGlobal('Date', FrozenDate);
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee', note: 'Changed' }));
        vi.unstubAllGlobals();
        expect(frozen.prepared.updateAt).toBe(first); expect(frozen.prepared.renameAt).toBe(second);
        expect(env.methods.validatePreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().people?.[0]).toMatchObject({ updatedAt: second, rev: 7 });
    });

    it('device initialization is frozen and genuine; a recreated before state applies once and exact after does not write', async () => {
        const env = await open({ settings: { theme: 'dark' } });
        useTaskStore.setState({ settings: { theme: 'dark' } });
        const frozen = await freeze(env.methods, request(person(), { note: 'Changed' }));
        expect(env.saves()).toBe(0); expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        const cold = await open({ settings: { theme: 'light' } });
        useTaskStore.setState({ settings: { theme: 'light' } });
        expect(await cold.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(cold.data().settings).toEqual({ theme: 'light', deviceId: frozen.prepared.deviceIdToInitialize });
        const replay = await open(cold.data());
        expect(await replay.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true }); expect(replay.saves()).toBe(0);
        useTaskStore.setState({ settings: { deviceId: 'different-device' } });
        replay.setData({ settings: { deviceId: 'different-device' } });
        expect(await replay.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false });
    });

    it('ignores tombstoned collisions; stamps already matching case assignment and saturates each RN revision stage', async () => {
        const source = person({ rev: Number.MAX_SAFE_INTEGER });
        const assigned = { ...tasks()[0], assignedTo: 'ALEX SMITH', rev: Number.MAX_SAFE_INTEGER };
        const env = await open({ people: [source, person({ id: 'deleted-target', name: 'ALEX SMITH', deletedAt: updateAt })], tasks: [assigned] });
        const frozen = await freeze(env.methods, request(source, { name: 'ALEX SMITH', note: 'Changed' }));
        expect(frozen.prepared.scope.destination).toBeNull();
        expect(frozen.prepared.effect.people[0].after.rev).toBe(nextRevision(nextRevision(source.rev)));
        expect(frozen.prepared.effect.tasks[0].after.rev).toBe(nextRevision(assigned.rev));
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().people?.[0].deletedAt).toBeUndefined();
    });

    it('accepts large legacy draft values and raw timestamps, canonical optional null omission, with no truncation', async () => {
        const source = person({ name: 'X'.repeat(501), note: 'Y'.repeat(10_001), referenceLink: 'Z'.repeat(2_001) });
        const env = await open({ people: [source] });
        const frozen = await freeze(env.methods, request(source, { note: source.note + ' changed' }));
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().people?.[0]).toMatchObject({ name: source.name, note: source.note + ' changed',
            referenceLink: source.referenceLink, createdAt: source.createdAt });
        useTaskStore.setState({ _allPeople: [{ ...person(), note: null, referenceLink: null, rev: null, revBy: null } as unknown as Person] });
        expect(env.methods.getPersonEditOptions({ personId: 'source' })).toMatchObject({ ok: true,
            value: { expected: { id: 'source' }, draft: { note: '', referenceLink: '' } } });
    });

    it('before CAS refuses new collisions or changed/removed/new matching Tasks but allows unrelated changes and reorder', async () => {
        const initial = { people: [person()], tasks: tasks() };
        const env = await open(initial);
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee', note: 'Changed' }));
        const mutations = [
            () => useTaskStore.setState({ _allPeople: [person({ note: 'Later' })] }),
            () => useTaskStore.setState({ _allPeople: [person(), person({ id: 'collision', name: 'Morgan Lee' })] }),
            () => useTaskStore.setState({ _allTasks: tasks().map((row) => row.id === 'live' ? { ...row, description: 'Changed field' } : row) }),
            () => useTaskStore.setState({ _allTasks: tasks().filter((row) => row.id !== 'live') }),
            () => useTaskStore.setState({ _allTasks: tasks().map((row) => row.id === 'live' ? { ...row, deletedAt: updateAt } : row) }),
            () => useTaskStore.setState({ _allTasks: [...tasks(), { ...tasks()[0], id: 'new-match' }] }),
        ];
        for (const mutate of mutations) {
            useTaskStore.setState({ _allPeople: [person()], _allTasks: tasks() }); mutate();
            const state = useTaskStore.getState(); env.setData({ people: state._allPeople, tasks: state._allTasks });
            expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(env.saves()).toBe(0);
        }
        useTaskStore.setState({ _allPeople: [person(), person({ id: 'unrelated', name: 'Other' })],
            _allTasks: tasks().reverse().map((row) => row.id === 'other' ? { ...row, description: 'Allowed' } : row),
            settings: { deviceId: 'person-device', theme: 'light' } });
        const changed = useTaskStore.getState(); env.setData({ people: changed._allPeople, tasks: changed._allTasks, settings: changed.settings });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(env.data().settings.theme).toBe('light');
        expect(env.data().tasks.find((row) => row.id === 'other')?.description).toBe('Allowed');
    });

    it('destination first-match identity and full snapshot are pinned, while metadata-only ignores collision/Task inventory', async () => {
        const target = person({ id: 'target', name: 'Morgan Lee' });
        const env = await open({ people: [person(), target], tasks: tasks() });
        const frozen = await freeze(env.methods, request(person(), { name: target.name }));
        for (const changed of [person({ id: 'target', name: 'Later' }), { ...target, deletedAt: updateAt }, { ...target, note: 'Later' }]) {
            useTaskStore.setState({ _allPeople: [person(), changed] });
            env.setData({ people: [person(), changed] });
            expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false });
        }
        useTaskStore.setState({ _allPeople: [person(), target] });
        env.setData({ people: [person(), target] });
        const metadata = await freeze(env.methods, request(person(), { note: 'Changed' }));
        useTaskStore.setState({ _allPeople: [person(), { ...target, note: 'Later' }], _allTasks: [] });
        env.setData({ people: [person(), { ...target, note: 'Later' }], tasks: [] });
        expect(await env.methods.commitPreparedPersonEdit(metadata)).toMatchObject({ ok: true });
    });

    it('two failed saves retain the frozen rows/times and recreated exact-after replay writes nothing or sweeps new Tasks', async () => {
        let failing = false;
        const initial = { people: [person()], tasks: tasks() };
        const env = await open(initial, () => failing);
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee', note: 'Changed' }));
        failing = true;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(JSON.parse(JSON.stringify(useTaskStore.getState()._allPeople[0]))).toEqual(frozen.prepared.effect.people[0].after);
        }
        failing = false;
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        const saved = structuredClone(env.data());
        const replay = await open({ ...saved, tasks: [...saved.tasks, { ...tasks()[0], id: 'later-match' }] });
        expect(await replay.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        expect(replay.saves()).toBe(0);
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'later-match')?.assignedTo).toBe(' alex   SMITH ');
        for (const changed of [{ ...saved.people![0], name: 'Later' }, { ...person(), note: 'Changed' }]) {
            const stale = await open({ ...saved, people: [changed] });
            expect(await stale.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(stale.saves()).toBe(0);
        }
    }, 20_000);

    it('live CAS supplies unseen Task membership and first collision order checks that pure cold replan cannot prove', async () => {
        const target = person({ id: 'first-target', name: 'Morgan Lee' });
        const second = { ...target, id: 'second-target' };
        const env = await open({ people: [person(), target, second], tasks: tasks() });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        useTaskStore.setState({ _allPeople: [person(), second, target] });
        env.setData({ people: [person(), second, target] });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false });
        useTaskStore.setState({ _allPeople: [person(), target, second] });
        env.setData({ people: [person(), target, second] });
        const omitted = structuredClone(frozen);
        const removedId = omitted.prepared.scope.tasks.pop()!.id;
        omitted.prepared.effect.tasks = omitted.prepared.effect.tasks.filter(({ before }) => before.id !== removedId);
        expect(env.methods.validatePreparedPersonEdit(omitted)).toMatchObject({ ok: true });
        expect(await env.methods.commitPreparedPersonEdit(omitted)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('partial after mixture conflicts; conservative no-journal probe is always unknown and read-only', async () => {
        const env = await open({ people: [person()], tasks: tasks() });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee' }));
        useTaskStore.setState({ _allPeople: [frozen.prepared.effect.people[0].after], _allTasks: tasks() });
        env.setData({ people: [frozen.prepared.effect.people[0].after], tasks: tasks() });
        expect(await env.methods.commitPreparedPersonEdit(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.methods.probePersonEditOutcome(frozen.request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.methods.probePersonEditOutcome({ ...frozen.request, requestId: 'invalid' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('forged cold authority, malformed, unknown, prototype and oversized requests refuse before any write', async () => {
        const env = await open({ people: [person()], tasks: tasks() });
        const frozen = await freeze(env.methods, request(person(), { name: 'Morgan Lee', note: 'Changed' }));
        const corruptions = [
            (row: typeof frozen) => { row.prepared.effect.tasks[0].after.contexts = ['changed']; },
            (row: typeof frozen) => { row.prepared.effect.people[0].after.rev = 100; },
            (row: typeof frozen) => { row.prepared.result.name = 'wrong'; },
            (row: typeof frozen) => { row.prepared.renameAt = null; },
            (row: typeof frozen) => { row.prepared.scope.tasks.push(row.prepared.scope.tasks[0]); },
            (row: typeof frozen) => { row.prepared.scope.tasks.push(tasks()[6]); },
            (row: typeof frozen) => { row.prepared.effect.tasks.pop(); },
            (row: typeof frozen) => { row.request.requestId = 'different'; },
            (row: typeof frozen) => { row.prepared.deviceIdToInitialize = requestId; },
            (row: typeof frozen) => { (row.prepared as unknown as Record<string, unknown>).extra = true; },
        ];
        const cold = createPersonEditMethods({ readiness: () => { throw new Error('cold validator touched readiness'); }, save: async () => { throw new Error('cold validator touched save'); } });
        expect(cold.validatePreparedPersonEdit(frozen)).toMatchObject({ ok: true });
        for (const corrupt of corruptions) {
            const changed = structuredClone(frozen); corrupt(changed);
            expect(cold.validatePreparedPersonEdit(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.methods.commitPreparedPersonEdit(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const input of [ { ...request(), extra: true }, { ...request(), name: 10 }, { ...request(), expected: { ...person(), note: null } },
            { ...request(), expected: { ...person(), rev: NaN } }, Object.assign(Object.create({ inherited: true }), request()),
            { ...request(), note: '汉'.repeat(700_000) } ]) {
            expect(await env.methods.preparePersonEdit(input as NativePersonEditRequest)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await env.methods.preparePersonEdit(request(person(), { name: '  ' }))).toMatchObject({ ok: false });
        expect(env.saves()).toBe(0);
        for (const current of [[], [{ ...person(), deletedAt: updateAt }]]) {
            useTaskStore.setState({ _allPeople: current });
            expect(env.methods.getPersonEditOptions({ personId: 'source' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await env.methods.preparePersonEdit(request(person(), { note: 'Changed' }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
    });
});
