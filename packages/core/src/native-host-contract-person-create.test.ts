import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonCreateMethods, type NativePersonCreateRequest } from './native-host-contract-person-create';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Person } from './types';
import { PERSON_SQLITE_COLUMNS, personToSqliteRow, personFromSqliteRow } from './person-sync-schema';
import { TASK_SYNC_SCHEMA_FIXTURE } from './task-sync-schema';

const requestId = '00000000-0000-4000-8000-000000000392';
const now = '2026-09-28T15:00:00.000Z';
const request = (overrides: Partial<NativePersonCreateRequest> = {}): NativePersonCreateRequest => ({
    requestId, name: 'Alex Smith', note: '', referenceLink: '', expectedPersonId: requestId, ...overrides,
});
const person = (id: string, overrides: Partial<Person> = {}): Person => ({
    id, name: 'Alex Smith', createdAt: now, updatedAt: now, rev: 2, revBy: 'person-device', ...overrides,
});

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [],
        settings: { deviceId: 'person-device' }, ...structuredClone(initial) };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next);
        saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    saves = 0;
    const methods = createPersonCreateMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'disk unavailable' } }; }
        } });
    return { methods, data: () => data, saves: () => saves };
}
const freeze = (methods: ReturnType<typeof createPersonCreateMethods>, input = request()) => {
    const plan = methods.preparePersonCreate(input);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return structuredClone({ request: input, prepared: plan.value.prepared });
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('prepared native Person create', () => {
    it('creates normalized metadata with frozen UUID/stamps and cold exact replay without another write', async () => {
        const original = await open({ settings: { theme: 'dark' } });
        useTaskStore.setState({ settings: { theme: 'dark' } });
        const input = request({ name: '  Alex   Smith  ', note: '  Lead  ', referenceLink: ' obsidian://Alex ' });
        expect(original.methods.resolvePersonCreateName({ requestId, name: input.name })).toEqual({ ok: true,
            value: { expectedPersonId: requestId, taken: false, normalizedName: 'alex smith', displayName: 'Alex Smith' } });
        const frozen = freeze(original.methods, input);
        expect(original.saves()).toBe(0);
        expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        const cold = await open(original.data());
        useTaskStore.setState({ settings: { theme: 'dark' } });
        expect(cold.methods.validatePreparedPersonCreate(frozen)).toEqual({ ok: true, value: { id: requestId, created: true } });
        expect(await cold.methods.commitPreparedPersonCreate(frozen)).toEqual({ ok: true, value: { id: requestId, created: true } });
        expect(cold.data().people).toEqual([{ ...frozen.prepared.effect.person.after }]);
        expect(cold.data().people?.[0]).toMatchObject({ id: requestId, name: 'Alex Smith', note: 'Lead', referenceLink: 'obsidian://Alex', rev: 1 });
        expect(cold.methods.resolvePersonCreateName({ requestId, name: input.name })).toEqual({ ok: true,
            value: { expectedPersonId: requestId, taken: true, normalizedName: 'alex smith', displayName: 'Alex Smith' } });
        expect(cold.data().settings).toEqual({ theme: 'dark', deviceId: frozen.prepared.deviceIdToInitialize });
        const saved = structuredClone(cold.data());
        const replay = await open(saved);
        const before = replay.saves();
        const loaded = structuredClone(replay.data());
        expect(await replay.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        expect(replay.saves()).toBe(before);
        expect(replay.data()).toEqual(loaded);
    });

    it('live duplicates win over tombstones and ignore note/link with no device initialization or writes', async () => {
        const old = person('deleted', { deletedAt: now });
        const live = person('live', { name: 'ALEX Smith', note: 'Original', referenceLink: 'old://link' });
        const { methods, saves } = await open({ people: [old, live], settings: {} });
        useTaskStore.setState({ settings: {} });
        expect(methods.resolvePersonCreateName({ requestId, name: ' alex   SMITH ' })).toMatchObject({ ok: true,
            value: { expectedPersonId: 'live', taken: true, normalizedName: 'alex smith', displayName: 'ALEX Smith' } });
        const input = request({ expectedPersonId: 'live', name: ' alex   SMITH ', note: 'Replacement', referenceLink: 'new://link' });
        expect(methods.preparePersonCreate(input)).toEqual({ ok: true, value: { kind: 'existing', result: { id: 'live', created: false } } });
        expect(methods.probePersonCreateOutcome(input)).toEqual({ ok: true, value: { id: 'live', created: false } });
        expect(await useTaskStore.getState().addPerson(input.name, { note: input.note, referenceLink: input.referenceLink })).toMatchObject(live);
        expect(saves()).toBe(0);
        expect(useTaskStore.getState().settings).toEqual({});
    });

    it('restores the original ID and omitted metadata at one fresh revision without restoring tasks', async () => {
        const old = person('legacy-person', { createdAt: '2026-09-28T15:00:00Z', deletedAt: now, note: 'Keep', referenceLink: 'old://link', rev: 8 });
        const task = { ...TASK_SYNC_SCHEMA_FIXTURE, id: 'linked', assignedTo: old.name, deletedAt: now };
        const rn = await open({ people: [old], tasks: [task] });
        const input = request({ expectedPersonId: old.id, name: ' alex   SMITH ', note: '  ', referenceLink: ' ' });
        expect(rn.methods.resolvePersonCreateName({ requestId, name: input.name })).toEqual({ ok: true,
            value: { expectedPersonId: old.id, taken: false, normalizedName: 'alex smith', displayName: 'alex SMITH' } });
        const frozen = freeze(rn.methods, input);
        const added = await useTaskStore.getState().addPerson(input.name);
        await flushPendingSave();
        expect(added).toMatchObject({ id: old.id, name: 'alex SMITH', note: 'Keep', referenceLink: 'old://link', rev: 9 });
        expect(added?.deletedAt).toBeUndefined();
        const cold = await open({ people: [old], tasks: [task] });
        const loadedTasks = structuredClone(useTaskStore.getState()._allTasks);
        const loadedSettings = structuredClone(useTaskStore.getState().settings);
        expect(await cold.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true, value: { id: old.id, created: true } });
        expect(cold.data().people?.[0]).toMatchObject({ ...frozen.prepared.effect.person.after, rev: 9 });
        expect(cold.methods.resolvePersonCreateName({ requestId, name: input.name })).toEqual({ ok: true,
            value: { expectedPersonId: old.id, taken: true, normalizedName: 'alex smith', displayName: 'alex SMITH' } });
        expect(cold.data().tasks).toEqual(loadedTasks);
        expect(cold.data().settings).toEqual(loadedSettings);
    });

    it('preserves RN arbitrary initialProps while using the shared normalized addition policy', async () => {
        await open();
        const added = await useTaskStore.getState().addPerson('  Pat   Lee ', { id: 'custom-id', createdAt: now,
            note: ' Note ', referenceLink: ' custom://link ', rev: 99, revBy: 'overridden' });
        expect(added).toMatchObject({ id: 'custom-id', name: 'Pat Lee', createdAt: now, note: 'Note', referenceLink: 'custom://link', rev: 1, revBy: 'person-device' });
    });

    it('re-resolving after rename or replacement exposes the current identity and name without writing', async () => {
        const original = person('original');
        const { methods, saves } = await open({ people: [original] });
        const lookup = { requestId, name: ' alex   SMITH ' };
        const expected = { expectedPersonId: original.id, taken: true, normalizedName: 'alex smith', displayName: original.name };
        expect(methods.resolvePersonCreateName(lookup)).toEqual({ ok: true, value: expected });
        useTaskStore.setState({ _allPeople: [{ ...original, name: 'Renamed' }] });
        expect(methods.resolvePersonCreateName(lookup)).toEqual({ ok: true, value: {
            expectedPersonId: requestId, taken: false, normalizedName: 'alex smith', displayName: 'alex SMITH' } });
        useTaskStore.setState({ _allPeople: [{ ...original, name: 'Renamed' }, person('replacement', { name: 'Alex SMITH' })] });
        expect(methods.resolvePersonCreateName(lookup)).toEqual({ ok: true, value: {
            expectedPersonId: 'replacement', taken: true, normalizedName: 'alex smith', displayName: 'Alex SMITH' } });
        expect(saves()).toBe(0);
    });

    it.each([false, true])('preserves RN restoration ID override semantics when the replacement row exists: %s', async (replacementExists) => {
        const old = person('legacy', { deletedAt: now, note: 'Legacy note', referenceLink: 'legacy://link' });
        const replacement = person('replacement', { name: 'Morgan', note: 'Other note', referenceLink: 'other://link', rev: 9 });
        const rows = replacementExists ? [old, replacement] : [old];
        const { data } = await open({ people: rows });
        const updateAt = '2026-09-30T15:00:00.000Z';
        vi.useFakeTimers();
        vi.setSystemTime(new Date(updateAt));
        await expect(useTaskStore.getState().addPerson(' Alex Smith ', { id: 'replacement', note: ' Restored note ' }))
            .resolves.toBeNull();
        await flushPendingSave();
        const expected = replacementExists ? [old, { ...old, id: 'replacement', name: 'Alex Smith', note: 'Restored note',
            deletedAt: undefined, updatedAt: updateAt, rev: 3, revBy: 'person-device' }] : [old];
        expect(useTaskStore.getState()._allPeople).toEqual(expected);
        expect(data().people).toEqual(expected);
    });

    it('refuses changed resolution and selected tombstone edits without freezing unrelated inventory', async () => {
        const old = person('legacy', { deletedAt: now });
        const { methods, saves } = await open({ people: [old] });
        const input = request({ expectedPersonId: old.id });
        const frozen = freeze(methods, input);
        const before = saves();
        for (const people of [[{ ...old, name: 'Renamed' }], [{ ...old, rev: 3 }], [old, person('new-live')], []]) {
            useTaskStore.setState({ _allPeople: people });
            expect(await methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allPeople: [person('unrelated', { name: 'Other' }), old] });
        expect(await methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        expect(saves()).toBe(before + 1);
        const preparedFresh = request({ name: 'New Name' });
        useTaskStore.setState({ _allPeople: [person('collision', { name: 'New Name' })] });
        expect(methods.preparePersonCreate(preparedFresh)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('refuses fresh UUID collision both before preparation and at commit, never proving by name alone', async () => {
        const { methods, saves } = await open();
        const frozen = freeze(methods);
        const before = saves();
        for (const collision of [person(requestId, { name: 'Other' }), person(requestId, { rev: 1 })]) {
            useTaskStore.setState({ _allPeople: [collision] });
            expect(await methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allPeople: [person(requestId, { name: 'Other' })] });
        expect(methods.preparePersonCreate(request())).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.probePersonCreateOutcome(request())).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
    });

    it('recognizes the exact SQLite-normalized effect, including omitted optional fields, after restart', async () => {
        const { methods } = await open();
        const frozen = freeze(methods);
        expect(await methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        const row = Object.fromEntries(PERSON_SQLITE_COLUMNS.map((column, index) => [column, personToSqliteRow(frozen.prepared.effect.person.after)[index]]));
        const restored = personFromSqliteRow(row);
        const cold = await open({ people: [restored] });
        const before = cold.saves();
        expect(await cold.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        expect(cold.saves()).toBe(before);
    });

    it('retries failed saves with frozen identity/stamps and recreates the host against old and intervening state', async () => {
        const old = person('legacy', { deletedAt: now, rev: 6 });
        let failSave = false;
        const writer = await open({ people: [old] }, () => failSave);
        const frozen = freeze(writer.methods, request({ expectedPersonId: old.id }));
        const beforeWrite = structuredClone(writer.data());
        failSave = true;
        for (let retry = 0; retry < 2; retry++) {
            expect(await writer.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(writer.data()).toEqual(beforeWrite);
            expect(useTaskStore.getState()._allPeople[0]).toEqual(frozen.prepared.effect.person.after);
        }
        failSave = false;
        expect(await writer.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        expect(writer.data().people?.[0]).toEqual(frozen.prepared.effect.person.after);

        const cold = await open(beforeWrite);
        expect(await cold.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        const saved = structuredClone(cold.data());
        for (const people of [saved.people!.map((row) => ({ ...row, name: 'Renamed', rev: 8 })),
            saved.people!.map((row) => ({ ...row, deletedAt: now, rev: 8 })),
            [{ ...old, name: 'Renamed', rev: 7 }, person('replacement')]]) {
            const intervened = await open({ ...saved, people });
            const before = intervened.saves();
            expect(await intervened.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(intervened.saves()).toBe(before);
            expect(intervened.data().people).toEqual(people);
        }
        const replay = await open(saved);
        const count = replay.saves();
        expect(await replay.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        expect(replay.saves()).toBe(count);
        expect(replay.data().people?.[0].updatedAt).toBe(frozen.prepared.updateAt);
    }, 20_000);

    it('a fresh cold journal keeps its UUID after failed persistence and refuses an intervening name collision', async () => {
        let failSave = false;
        const writer = await open({}, () => failSave);
        const frozen = freeze(writer.methods);
        const persistedBefore = structuredClone(writer.data());
        failSave = true;
        expect(await writer.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(writer.data()).toEqual(persistedBefore);
        failSave = false;
        const collision = person('later-person');
        const intervened = await open({ ...persistedBefore, people: [collision] });
        const count = intervened.saves();
        expect(await intervened.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(intervened.saves()).toBe(count);
        expect(intervened.data().people).toEqual([collision]);
        const cold = await open(persistedBefore);
        expect(await cold.methods.commitPreparedPersonCreate(frozen)).toMatchObject({ ok: true });
        expect(cold.data().people).toEqual([frozen.prepared.effect.person.after]);
    }, 20_000);

    it('pure cold validator rejects forged effects, additional keys, malformed UUIDs and bounded text before writes', async () => {
        const { methods, saves } = await open();
        const frozen = freeze(methods);
        const before = saves();
        for (const corrupt of [
            (item: typeof frozen) => { item.prepared.effect.person.after.name = 'Forged'; },
            (item: typeof frozen) => { item.prepared.effect.person.after.note = 'Forged'; },
            (item: typeof frozen) => { item.prepared.effect.person.after.rev = 9; },
            (item: typeof frozen) => { item.prepared.effect.person.before = person('fake'); },
            (item: typeof frozen) => { item.prepared.result.id = 'wrong'; },
            (item: typeof frozen) => { Object.assign(item.prepared.effect, { tasks: [] }); },
            (item: typeof frozen) => { Object.assign(item.request, { extra: true }); },
            (item: typeof frozen) => { item.prepared.updateAt = 'invalid'; },
            (item: typeof frozen) => { item.prepared.deviceIdToInitialize = 'forged'; },
            (item: typeof frozen) => { Object.assign(item.prepared.effect.person.after, { constructor: 'forged' }); },
        ]) {
            const forged = structuredClone(frozen);
            corrupt(forged);
            expect(methods.validatePreparedPersonCreate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await methods.commitPreparedPersonCreate(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const input of [request({ name: ' ' }), request({ name: 'a'.repeat(501) }), request({ note: '漢'.repeat(10_001) }),
            request({ referenceLink: 'a'.repeat(2_001) }), request({ expectedPersonId: '' }), request({ requestId: requestId.toUpperCase().replace('000392', '00039A') }),
            { ...request(), extra: true }]) {
            expect(methods.preparePersonCreate(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const huge = structuredClone(frozen);
        huge.prepared.effect.person.after.note = '漢'.repeat(700_000);
        expect(methods.validatePreparedPersonCreate(huge)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.resolvePersonCreateName({ requestId, name: 'a'.repeat(501) })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
    });
});
