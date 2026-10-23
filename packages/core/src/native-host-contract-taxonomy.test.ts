import { afterEach, describe, expect, it } from 'vitest';
import { createTaxonomyMethods, type NativeTaxonomyRequest } from './native-host-contract-taxonomy';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';
import { addSavedTaxonomyToken, getSavedTaxonomyTokens } from './taxonomy-catalog';
import { consoleLogger, setLogger, type LogPayload } from './logger';

const AT = '2026-09-30T12:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000096';
const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
    id, title: id, status, tags: ['#OLD', '#New', '#old', '#Keep'],
    contexts: [' @OLD ', '@New', '@old', '@Keep'], rev: 2,
    createdAt: AT, updatedAt: AT, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'archived', color: '#abc', order: 0,
    tagIds: ['#OLD', '#New', '#old', '#Keep'], isFocused: true,
    createdAt: AT, updatedAt: AT, ...extra,
});
const rows = (): AppData => ({
    tasks: (['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'] as const)
        .map((status, index) => task(String(index), status, index === 5
            ? { deletedAt: AT, focusOrder: 9 } : index === 6 ? { purgedAt: AT, focusOrder: 7 } : {})),
    projects: [project('archived'), project('deleted', { deletedAt: AT }),
        project('purged', { purgedAt: AT })],
    sections: [], areas: [], people: [], settings: { deviceId: 'tax-device' },
});

async function open(initial: AppData, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data = structuredClone(initial);
    let saves = 0;
    const adapter = { getData: async () => structuredClone(data), saveData: async (next: AppData) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } };
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave(); saves = 0;
    // The loader cleans display state; the adapter still owns the raw terminal rows.
    data = structuredClone(initial);
    const methods = createTaxonomyMethods({ readiness: () => ({ ok: true, value: null }), t: () => (key) => key,
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'disk unavailable' } }; }
        } });
    return { methods, data: () => data, saves: () => saves,
        changeSaved: (fn: (data: AppData) => AppData) => { data = fn(data); },
        reopen: async () => open(data, fail) };
}

async function request(env: Awaited<ReturnType<typeof open>>, kind: 'context' | 'tag',
    action: 'rename' | 'delete', to: string | null): Promise<NativeTaxonomyRequest> {
    const name = kind === 'tag' ? '#OLD' : ' @OLD ';
    const options = await env.methods.getTaxonomyOptions({ kind, name });
    if (!options.ok) throw new Error(JSON.stringify(options));
    expect(options.value.draft.name).toBe(name);
    expect(options.value.confirmation.message).toContain(name);
    return { requestId: ID, kind, action, name, to, expected: options.value.expected };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('prepared taxonomy', () => {
    it('logs a private saved-taxonomy proof only after the v2 catalogue save succeeds', async () => {
        let failSave = false;
        const env = await open({ ...rows(), tasks: [], projects: [] }, () => failSave);
        const options = await env.methods.getTaxonomyOptions({ kind: 'context', action: 'create', name: '' });
        if (!options.ok) throw new Error(JSON.stringify(options));
        const input: NativeTaxonomyRequest = { requestId: ID, kind: 'context', action: 'create', name: '@PrivateSavedName',
            to: null, expected: options.value.expected };
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            failSave = true;
            expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(logs.filter(log => log.context?.releaseCheck === 'v1.3.7/saved-taxonomy')).toEqual([]);
            failSave = false;
            expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
            const proofs = logs.filter(log => log.context?.releaseCheck === 'v1.3.7/saved-taxonomy');
            expect(proofs).toHaveLength(1);
            expect(proofs[0].force).toBe(true);
            expect(proofs[0].context).toEqual({ releaseCheck: 'v1.3.7/saved-taxonomy', taxonomyKind: 'context', operation: 'create', outcome: 'persisted' });
            expect(JSON.stringify(proofs)).not.toContain('PrivateSavedName');
        } finally { setLogger(consoleLogger); }
    });

    it('durably creates an unused value and cold-replays its complete catalogue receipt', async () => {
        const initial = { ...rows(), tasks: [], projects: [] };
        const env = await open(initial);
        const options = await env.methods.getTaxonomyOptions({ kind: 'context', action: 'create', name: '' });
        if (!options.ok) throw new Error(JSON.stringify(options));
        const input: NativeTaxonomyRequest = { requestId: ID, kind: 'context', action: 'create', name: '@Unused',
            to: null, expected: options.value.expected };
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(envelope.prepared.version).toBe(2);
        const wrongVersion = structuredClone(envelope);
        Reflect.set(wrongVersion.prepared, 'version', '2');
        expect(env.methods.validatePreparedTaxonomy(wrongVersion)).toMatchObject({ ok: false });
        expect(envelope.prepared.effect.tasks).toEqual([]);
        expect(envelope.prepared.effect.catalogue?.before).toBeNull();
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(getSavedTaxonomyTokens(env.data().settings, 'context')).toEqual(['@Unused']);
        const fresh = await env.reopen();
        const savedCount = fresh.saves();
        expect(await fresh.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(fresh.saves()).toBe(savedCount);
    });

    it('rejects stale and forged catalogue effects while allowing unused rename and delete', async () => {
        const initial = { ...rows(), tasks: [], projects: [],
            settings: addSavedTaxonomyToken(rows().settings, 'context', '@Unused', 'tax-device', AT) };
        const env = await open(initial);
        const options = await env.methods.getTaxonomyOptions({ kind: 'context', name: '@Unused' });
        if (!options.ok) throw new Error(JSON.stringify(options));
        const input: NativeTaxonomyRequest = { requestId: ID, kind: 'context', action: 'rename', name: '@Unused',
            to: '@Renamed', expected: options.value.expected };
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        const forged = structuredClone(envelope);
        forged.prepared.effect.catalogue!.after.contexts![0].rev += 1;
        expect(env.methods.validatePreparedTaxonomy(forged)).toMatchObject({ ok: false });
        env.changeSaved((data) => ({ ...data, settings: addSavedTaxonomyToken(data.settings, 'tag', '#Concurrent', 'peer', AT) }));
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.changeSaved(() => initial);
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(getSavedTaxonomyTokens(env.data().settings, 'context')).toEqual(['@Renamed']);
        const current = await env.methods.getTaxonomyOptions({ kind: 'context', name: '@Renamed' });
        if (!current.ok) throw new Error(JSON.stringify(current));
        const deletion: NativeTaxonomyRequest = { ...input, action: 'delete', name: '@Renamed', to: null, expected: current.value.expected };
        const removed = await env.methods.prepareTaxonomy(deletion);
        if (!removed.ok || removed.value.kind !== 'prepared') throw new Error(JSON.stringify(removed));
        expect(await env.methods.commitPreparedTaxonomy({ request: deletion, prepared: removed.value.prepared })).toMatchObject({ ok: true });
        expect(getSavedTaxonomyTokens(env.data().settings, 'context')).toEqual([]);
    });

    it('retains version 1 journal semantics without changing an existing catalogue', async () => {
        const initial = rows();
        initial.settings = addSavedTaxonomyToken(initial.settings, 'context', '@Saved', 'tax-device', AT);
        const env = await open(initial);
        const input = await request(env, 'tag', 'rename', '#New');
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const old = structuredClone({ request: input, prepared: plan.value.prepared });
        old.prepared.version = 1;
        delete old.request.expected.catalogue;
        delete old.prepared.request.expected.catalogue;
        delete old.prepared.scope.catalogue;
        delete old.prepared.effect.catalogue;
        expect(env.methods.validatePreparedTaxonomy(old)).toMatchObject({ ok: true });
        expect(await env.methods.commitPreparedTaxonomy(old)).toMatchObject({ ok: true });
        expect(env.data().settings.taxonomy).toEqual(initial.settings.taxonomy);
    });
    it.each([
        ['context', 'rename', '@New'], ['context', 'delete', null],
        ['tag', 'rename', 'New'], ['tag', 'delete', null],
    ] as const)('applies and cold-replays %s %s from complete raw rows', async (kind, action, to) => {
        const env = await open(rows());
        const input = await request(env, kind, action, to);
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(env.methods.validatePreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(envelope.prepared.scope.tasks).toHaveLength(7);
        expect(envelope.prepared.scope.projects).toHaveLength(kind === 'tag' ? 3 : 0);
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(env.saves()).toBe(1);
        expect(env.data().tasks[5].focusOrder).toBe(9);
        expect(env.data().tasks[6].purgedAt).toBe(AT);
        expect(env.data().projects[0].isFocused).toBe(true);
        const fresh = await env.reopen();
        expect(fresh.methods.validatePreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(await fresh.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(fresh.saves()).toBe(0);
    });

    it('refuses a new or altered carrier even without a revision bump', async () => {
        const env = await open(rows());
        const input = await request(env, 'tag', 'rename', 'New');
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        env.changeSaved((data) => ({ ...data, projects: [...data.projects,
            project('new-carrier', { tagIds: ['#OLD'] })] }));
        expect(await env.methods.commitPreparedTaxonomy({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, projects: data.projects.slice(0, -1),
            tasks: data.tasks.map((row, index) => index === 0 ? { ...row, description: 'changed' } : row) }));
        expect(await env.methods.commitPreparedTaxonomy({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('rejects malformed cold journals and treats no-journal outcomes as unknown', async () => {
        const env = await open(rows());
        const input = await request(env, 'context', 'rename', '@New');
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const valid = { request: input, prepared: plan.value.prepared };
        const forged = structuredClone(valid);
        forged.prepared.effect.tasks[0].after.contexts = ['forged'];
        expect(env.methods.validatePreparedTaxonomy(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const duplicated = structuredClone(valid);
        duplicated.request.expected.tasks.push(duplicated.request.expected.tasks[0]);
        expect(env.methods.validatePreparedTaxonomy(duplicated)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const unknown = { ...valid, prepared: { ...valid.prepared, extra: true } };
        expect(env.methods.validatePreparedTaxonomy(unknown)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.methods.probeTaxonomyOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('keeps the original request and raw effect through a failed same-host retry', async () => {
        let failing = false;
        const env = await open(rows(), () => failing);
        const input = await request(env, 'tag', 'rename', 'New');
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        failing = true;
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(env.data().tasks).toEqual(envelope.prepared.effect.tasks.map(({ after }) => after));
        expect(env.data().tasks[5].focusOrder).toBe(9);
    });

    it('treats exact-after as read-only after another carrier appears', async () => {
        const env = await open(rows());
        const input = await request(env, 'tag', 'delete', null);
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        const saved = env.saves();
        env.changeSaved((data) => ({ ...data, tasks: [...data.tasks,
            task('new-after', 'next', { tags: ['#OLD'] })] }));
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: true });
        expect(env.saves()).toBe(saved);
        expect(env.data().tasks.at(-1)?.tags).toEqual(['#OLD']);
    });

    it.each(['synchronous', 'microtask'])('does not claim a %s foreign failed Task intent', async (timing) => {
        let failing = false;
        const initial = rows();
        initial.tasks.push(task('foreign', 'next', { tags: [], contexts: [], description: 'old' }));
        const env = await open(initial, () => failing);
        const input = await request(env, 'context', 'delete', null);
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        const before = structuredClone(env.data());
        let armed = true;
        let foreign: Promise<unknown> | undefined;
        const unsubscribe = useTaskStore.subscribe((current, previous) => {
            if (!armed || current._allTasks === previous._allTasks) return;
            armed = false;
            const edit = () => { foreign = useTaskStore.getState().updateTask('foreign', { description: 'new' }); };
            if (timing === 'microtask') queueMicrotask(edit); else edit();
        });
        failing = true;
        try {
            expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
        } finally { unsubscribe(); }
        expect(await foreign).toMatchObject({ success: true });
        const failure = useTaskStore.getState().persistenceFailure;
        expect(failure).not.toBeNull();
        expect(useTaskStore.getState()._allTasks.at(-1)?.description).toBe('new');
        failing = false;
        expect(await env.methods.commitPreparedTaxonomy(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        expect(env.data()).toEqual(before);
    }, 15_000);

    it('projects newly observed durable metadata while saving raw focus fields', async () => {
        const env = await open(rows());
        env.changeSaved((data) => ({ ...data, tasks: data.tasks.map((row, index) => index === 5
            ? { ...row, description: 'new durable note', checklist: [{ id: 'check', title: 'new', isCompleted: true }] }
            : row) }));
        const input = await request(env, 'tag', 'rename', 'New');
        const plan = await env.methods.prepareTaxonomy(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(await env.methods.commitPreparedTaxonomy({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(env.data().tasks[5].focusOrder).toBe(9);
        expect(useTaskStore.getState()._allTasks[5]).toMatchObject({ description: 'new durable note',
            checklist: [{ id: 'check', title: 'new', isCompleted: true }] });
        expect(useTaskStore.getState()._allTasks[5].focusOrder).toBeUndefined();
    });
});
