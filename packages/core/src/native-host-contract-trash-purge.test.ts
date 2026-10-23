import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openSqliteHostBase } from './screen-parity.replay';
import { createTrashItemsPurgeMethods, trashItemsPurgeEffect, trashItemsPurgeScope, type NativeTrashItemsPurgeEnvelope } from './native-host-contract-trash-purge';
import { loadNativeRequestReceipts, revisionOf, taskRevisionOf } from './native-request-receipts';
import { buildSaveSnapshot } from './store-helpers';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { purgeTrashItems } from './trash-view-model';
import { mergeAppDataWithStats } from './sync';
import * as logger from './logger';
import type { AppData, Attachment, Project, Section, Task } from './types';

const NOW = '2026-10-10T13:00:00.000Z', DELETED = '2026-10-09T12:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000506';
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const attachment = (id: string, cloudKey = id): Attachment => ({ id, kind: 'file', title: id,
    uri: `file:///local/${id}`, cloudKey, createdAt: DELETED, updatedAt: DELETED });
const task = (id: string, overrides: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    tags: [], contexts: [], createdAt: DELETED, updatedAt: DELETED, deletedAt: DELETED,
    rev: 3, revBy: 'device-a', ...overrides });
const project = (id: string, overrides: Partial<Project> = {}): Project => ({ id, title: id,
    status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: DELETED, updatedAt: DELETED,
    deletedAt: DELETED, rev: 2, revBy: 'device-a', ...overrides });
const section = (id: string, overrides: Partial<Section> = {}): Section => ({ id, projectId: 'p', title: id,
    order: 0, createdAt: DELETED, updatedAt: DELETED, rev: 2, revBy: 'device-a', ...overrides });
const seed = (): Partial<AppData> => ({
    tasks: [task('selected', { projectId: 'p', sectionId: 'section', status: 'done', description: 'Private payload',
        attachments: [attachment('task-only'), attachment('selected-shared', 'shared')] }),
    task('live', { projectId: 'p', sectionId: 'section', deletedAt: undefined }),
    task('section-only', { projectId: 'other', sectionId: 'section', deletedAt: undefined }),
    task('deleted-child', { projectId: 'p', sectionId: 'old-section', status: 'waiting' }),
    task('standalone', { description: 'Standalone payload' }),
    task('shared-trash', { attachments: [attachment('retained-shared', 'shared')] }),
    task('unrelated', { deletedAt: undefined })],
    projects: [project('p', { attachments: [attachment('parent-only'), attachment('parent-shared', 'shared')] }),
        project('other', { deletedAt: undefined })],
    sections: [section('section'), section('old-section', { deletedAt: DELETED })], areas: [], people: [],
    settings: { deviceId: 'device-a', analyticsProfileId: ID, theme: 'light', attachments: { pendingRemoteDeletes: [{ cloudKey: 'existing', attempts: 2 }] } },
});
const openSqliteHost: typeof openSqliteHostBase = async (...args) => {
    const sqlite = await openSqliteHostBase(...args);
    // Normal boot sanitizes live links to deleted parents. Stage the actual saved
    // legacy/external links afterward so both RN and prepared paths exercise them.
    const original = new Map((args[0].tasks ?? []).filter((row) => !row.deletedAt).map((row) => [row.id, row]));
    const relink = (row: Task) => original.has(row.id)
        ? { ...row, projectId: original.get(row.id)!.projectId, sectionId: original.get(row.id)!.sectionId } : row;
    const saved = await getStorageAdapter().getData({ rawTasks: true }); saved.tasks = saved.tasks.map(relink);
    await getStorageAdapter().saveData(saved);
    useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map(relink) });
    return sqlite;
};
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const methods = () => createTrashItemsPurgeMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected save failure' } }; }
    return useTaskStore.getState().persistenceFailure ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved save' } }
        : { ok: true, value: null };
} });
const request = (taskIds = ['selected', 'standalone'], projectIds = ['p'], requestId = ID) => ({ requestId, taskIds, projectIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    projectRevisions: Object.fromEntries(projectIds.map((id) => [id, revisionOf(useTaskStore.getState()._projectsById.get(id)!)])),
});
const prepare = async (host = methods(), input = request()): Promise<NativeTrashItemsPurgeEnvelope> => ({ request: input,
    prepared: value(await host.prepareTrashItemsPurge(input)).prepared });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('guarded prepared Trash permanent purge', () => {
    it('wires the prepared command and saved outcome through the activated shared host', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = sqlite.host, input = request(['standalone'], []);
            const command = { request: input, prepared: value(await host.prepareTrashItemsPurge(input)).prepared };
            expect(value(host.validatePreparedTrashItemsPurge(command))).toEqual({ count: 1 });
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 1 });
            expect(value(host.trashItemsPurgeOutcome(command))).toEqual({ count: 1 }); expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { await sqlite.close(); }
    });

    it.each(['task', 'project', 'mixed', 'ordered-mixed'])('matches actual RN %s purge including compacted rows and cleanup settings', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const taskIds = kind === 'project' ? [] : ['selected', 'standalone'], projectIds = kind === 'task' ? [] : ['p'];
        const data = seed();
        if (kind === 'ordered-mixed') {
            data.tasks = data.tasks!.filter((row) => row.id !== 'shared-trash').map((row) => row.id === 'selected'
                ? { ...row, attachments: [attachment('z-task'), attachment('selected-shared', 'shared'), attachment('a-task')] } : row);
            data.projects = data.projects!.map((row) => row.id === 'p'
                ? { ...row, attachments: [attachment('z-parent'), attachment('parent-shared', 'shared'), attachment('a-parent')] } : row);
        }
        const rn = await openSqliteHost(data); let expected: AppData;
        try { await canonical(); await purgeTrashItems(useTaskStore.getState(), { taskIds, projectIds });
            await flushPendingSave(); expected = rows(); } finally { await rn.close(); }
        const sqlite = await openSqliteHost(data);
        try { await canonical(); const host = methods(), before = await raw(sqlite), command = await prepare(host, request(taskIds, projectIds));
            expect(await raw(sqlite)).toEqual(before); expect(value(host.validatePreparedTrashItemsPurge(command))).toEqual({ count: taskIds.length + projectIds.length });
            const publications: number[] = []; const off = useTaskStore.subscribe((next, previous) => {
                if (next._allTasks !== previous._allTasks) publications.push(next._allTasks.filter((row) => Boolean(row.purgedAt)).length);
            });
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: taskIds.length + projectIds.length }); off();
            expect(publications).toHaveLength(1); expect(rows()).toEqual(expected!); expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { await sqlite.close(); }
    });

    it.each(['reference', 'unrelated'])('guards reference authority while permitting unrelated arrivals/settings: %s', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host), data = await getStorageAdapter().getData({ rawTasks: true });
            data.tasks.push(kind === 'reference'
                ? task('new-reference', { deletedAt: undefined, attachments: [attachment('new-file', 'task-only')] }) : task('new-arrival'));
            data.settings.theme = 'dark';
            await getStorageAdapter().saveData(data); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            if (kind === 'reference') {
                expect(await methods().commitPreparedTrashItemsPurge(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } else {
                expect(trashItemsPurgeScope(command.request, await getStorageAdapter().getData({ rawTasks: true }))).toEqual(command.prepared.scope);
                expect(value(await methods().commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
                expect(rows().tasks.find((row) => row.id === 'new-arrival')?.purgedAt).toBeUndefined(); expect(rows().settings.theme).toBe('dark');
            }
        } finally { await sqlite.close(); }
    });

    it.each([['p', 'other'], ['other', 'p']])('matches RN across overlapping project and section links in project order %j', async (...projectIds) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const data = seed();
        data.tasks = data.tasks!.filter((row) => row.id !== 'shared-trash');
        data.projects = data.projects!.map((row) => row.id === 'other'
            ? { ...row, deletedAt: DELETED, attachments: [attachment('other-shared', 'shared'), attachment('other-only')] } : row);
        const rn = await openSqliteHost(data); let expected: AppData;
        try { await canonical(); await purgeTrashItems(useTaskStore.getState(), { taskIds: ['selected'], projectIds });
            await flushPendingSave(); expected = rows(); } finally { await rn.close(); }
        const sqlite = await openSqliteHost(data);
        try { await canonical(); const beforeRevision = useTaskStore.getState()._tasksById.get('section-only')!.rev!;
            const host = methods(), command = await prepare(host, request(['selected'], projectIds));
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 }); expect(rows()).toEqual(expected!);
            expect(rows().tasks.find((row) => row.id === 'section-only')?.rev).toBe(beforeRevision + 1);
        } finally { await sqlite.close(); }
    });

    it.each(['prepare', 'commit'])('refuses a replaced memory snapshot during the awaited durable %s read', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host), before = await raw(sqlite), adapter = getStorageAdapter();
            const read = adapter.getData.bind(adapter);
            let enter!: () => void, release!: () => void;
            const entered = new Promise<void>((resolve) => { enter = resolve; });
            const held = new Promise<void>((resolve) => { release = resolve; });
            vi.spyOn(adapter, 'getData').mockImplementationOnce(async (options) => {
                const snapshot = await read(options); enter(); await held; return snapshot;
            });
            const pending = kind === 'prepare' ? host.prepareTrashItemsPurge(command.request) : host.commitPreparedTrashItemsPurge(command);
            await entered; useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, theme: 'dark' } }); release();
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['active-task', 'deleted-task', 'active-project', 'deleted-project'])(
    'retains remote objects referenced by an unselected %s, including deleted attachments', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const data = seed();
        const attachments = [{ ...attachment('outside', 'task-only'), deletedAt: DELETED }];
        if (kind.endsWith('task')) data.tasks!.push(task('outside', { deletedAt: kind.startsWith('active') ? undefined : DELETED, attachments }));
        else data.projects!.push(project('outside', { deletedAt: kind.startsWith('active') ? undefined : DELETED, attachments }));
        const sqlite = await openSqliteHost(data);
        try { const host = methods(), command = await prepare(host);
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            expect(rows().settings.attachments?.pendingRemoteDeletes).toEqual([{ cloudKey: 'existing', attempts: 2 }, { cloudKey: 'parent-only' }]);
            expect(rows().tasks.find((row) => row.id === 'deleted-child')?.purgedAt).toBeUndefined();
            expect(rows().tasks.find((row) => row.id === 'deleted-child')?.projectId).toBe('p');
            for (const id of ['live', 'section-only']) {
                expect(rows().tasks.find((row) => row.id === id)?.projectId).toBeUndefined();
                expect(rows().tasks.find((row) => row.id === id)?.sectionId).toBeUndefined();
            }
        } finally { await sqlite.close(); }
    });

    it.each(['selected-revision', 'selected-content', 'project-content', 'child-content', 'new-child', 'moved-child',
        'new-section', 'pending-delete', 'device', 'selected-restored'])(
    'atomically refuses changed %s without partial rows, settings or receipt', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const command = await prepare(), data = await getStorageAdapter().getData({ rawTasks: true });
            if (kind === 'selected-revision') data.tasks.find((row) => row.id === 'selected')!.rev!++;
            if (kind === 'selected-content') data.tasks.find((row) => row.id === 'selected')!.description = 'Same revision edit';
            if (kind === 'project-content') data.projects.find((row) => row.id === 'p')!.supportNotes = 'Same revision edit';
            if (kind === 'child-content') data.tasks.find((row) => row.id === 'live')!.description = 'Same revision edit';
            if (kind === 'new-child') data.tasks.push(task('new-child', { projectId: 'p', deletedAt: undefined }));
            if (kind === 'moved-child') data.tasks.find((row) => row.id === 'deleted-child')!.projectId = 'other';
            if (kind === 'new-section') data.sections!.push(section('new-section'));
            if (kind === 'pending-delete') data.settings.attachments!.pendingRemoteDeletes!.push({ cloudKey: 'concurrent', attempts: 1 });
            if (kind === 'device') data.settings.deviceId = 'device-b';
            if (kind === 'selected-restored') delete data.tasks.find((row) => row.id === 'selected')!.deletedAt;
            await getStorageAdapter().saveData(data); await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite), memory = rows();
            expect(await methods().commitPreparedTrashItemsPurge(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(memory); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['child', 'reference'])('recollects saved authority for an internally consistent omitted %s journal', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host);
            if (kind === 'child') command.prepared.scope.tasks = command.prepared.scope.tasks.filter((row) => row.id !== 'live');
            else command.prepared.scope.references = command.prepared.scope.references.filter((row) => row.id !== 'shared-trash');
            command.prepared.effect = clone(trashItemsPurgeEffect(command.prepared)!);
            expect(host.validatePreparedTrashItemsPurge(command).ok).toBe(true);
            const before = await raw(sqlite);
            expect(await host.commitPreparedTrashItemsPurge(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('validates the closed prepared grammar purely and rejects forged effects and bounds before writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let calls = 0;
        const sqlite = await openSqliteHost(seed(), (client) => ({
            run: async (...args) => { calls++; return client.run(...args); },
            exec: async (...args) => { calls++; return client.exec(...args); },
            all: async (...args) => { calls++; return client.all(...args); },
            get: async (...args) => { calls++; return client.get(...args); },
        }));
        try { const host = methods(), command = await prepare(host), before = await raw(sqlite);
            const boundIds = Array.from({ length: 10_000 }, (_, i) => `absent-${i}`), bound = { requestId: ID,
                taskIds: boundIds, taskRevisions: Object.fromEntries(boundIds.map((id) => [id, 'r'])), projectIds: [], projectRevisions: {} };
            expect(await host.prepareTrashItemsPurge(bound)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const invalidRequests = [{ ...command.request, extra: true }, { ...command.request, requestId: ID.toUpperCase().replace('506', 'aBc') },
                { ...command.request, taskIds: ['selected', 'selected'] }, { ...command.request, projectIds: ['p', 'p'] },
                { ...command.request, taskRevisions: {} }, { ...command.request, projectRevisions: { p: 'r', extra: 'r' } },
                { ...command.request, taskIds: [], projectIds: [], taskRevisions: {}, projectRevisions: {} },
                { ...bound, projectIds: ['p'], projectRevisions: { p: 'r' } },
                { ...bound, taskIds: boundIds.map((id) => `${id}${'é'.repeat(200)}`),
                    taskRevisions: Object.fromEntries(boundIds.map((id) => [`${id}${'é'.repeat(200)}`, 'r'])) }];
            for (const input of invalidRequests) expect(await host.prepareTrashItemsPurge(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const mutate: ((row: NativeTrashItemsPurgeEnvelope) => void)[] = [
                (row) => { Object.assign(row, { extra: true }); }, (row) => { Object.assign(row.prepared, { extra: true }); },
                (row) => { row.prepared.result.count++; }, (row) => { row.prepared.updateAt = 'yesterday'; },
                (row) => { row.prepared.deviceIdToInitialize = ID; }, (row) => { row.prepared.scope.tasks.push(row.prepared.scope.tasks[0]); },
                (row) => { row.prepared.effect.tasks[0].after.rev = 99; }, (row) => { row.prepared.effect.projects[0].after.title = 'Forged'; },
                (row) => { row.prepared.effect.pendingRemoteDeletes = []; },
                (row) => { row.prepared.scope.references[0].cloudKeys.push('forged-cloud'); },
                (row) => { Object.assign(row.prepared.scope, { extra: true }); },
                (row) => { row.prepared.scope.tasks[0].description = 'é'.repeat(1_000_000); },
            ];
            const start = calls; expect(value(host.validatePreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            for (const change of mutate) { const invalid = clone(command); change(invalid);
                expect(host.validatePreparedTrashItemsPurge(invalid).ok).toBe(false);
                expect((await host.commitPreparedTrashItemsPurge(invalid)).ok).toBe(false); }
            const cyclic = { ...command, extra: {} }; cyclic.extra = cyclic;
            expect(host.validatePreparedTrashItemsPurge(cyclic).ok).toBe(false);
            expect(host.validatePreparedTrashItemsPurge({ ...command, extra: Infinity }).ok).toBe(false);
            expect(host.validatePreparedTrashItemsPurge({ ...command, extra: new Date() }).ok).toBe(false);
            expect(calls).toBe(start); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            const data = await getStorageAdapter().getData({ rawTasks: true });
            data.tasks.find((row) => row.id === 'live')!.description = 'x'.repeat(1_100_000);
            await getStorageAdapter().saveData(data); await sqlite.restart(undefined, { recoveryLoad: true }); const large = await raw(sqlite);
            expect(await methods().prepareTrashItemsPurge(request([], ['p']))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('fewer') } });
            expect(await raw(sqlite)).toEqual(large);
        } finally { await sqlite.close(); }
    });

    it('preserves exact non-normalized task/project identities and independent namespaces', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const data = seed();
        const ids = ['\ufeffsame', 'é', 'e\u0301', 'p']; data.tasks = ids.map((id) => task(id));
        const sqlite = await openSqliteHost(data);
        try { const host = methods(), command = await prepare(host, request(ids, ['p']));
            expect(command.request.taskIds).toEqual(ids); expect(Object.keys(command.request.taskRevisions)).toEqual(ids);
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 5 });
            expect(rows().tasks.map((row) => row.id)).toEqual(ids); expect(rows().tasks.every((row) => row.purgedAt === NOW)).toBe(true);
            expect(rows().projects.find((row) => row.id === 'p')?.purgedAt).toBe(NOW);
        } finally { await sqlite.close(); }
    });

    it.each(['warm', 'cold'])('owns repeated real SQLite COMMIT failures and exact %s retry', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const diagnostic = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try { const host = methods(), command = await prepare(host);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            const before = await raw(sqlite), unrelated = await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['unrelated']);
            fault.commits = 20;
            expect(await host.commitPreparedTrashItemsPurge(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host.commitPreparedTrashItemsPurge(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(host.trashItemsPurgeOutcome(command))).toBeNull();
            expect(diagnostic.mock.calls.filter(([message]) => message === 'Native Trash purge confirmed')).toEqual([]);
            fault.commits = 0;
            if (kind === 'cold') await sqlite.restart(undefined, { recoveryLoad: true });
            const retry = kind === 'cold' ? methods() : host;
            expect(value(await retry.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            expect(diagnostic).toHaveBeenCalledWith('Native Trash purge confirmed', { scope: 'native-host', category: 'storage',
                context: { releaseCheck: 'v1.3.5/ios-trash-purge', outcome: 'confirmed', count: 3 } });
            diagnostic.mockImplementation(() => { throw new Error('Diagnostic failure'); });
            expect(value(await retry.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            expect(await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['unrelated'])).toEqual(unrelated); expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('returns the exact durable receipt before changed mutable scope and refuses UUID payload reuse', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host);
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            await sqlite.client().run('UPDATE tasks SET rev = rev + 1 WHERE id = ?', ['selected']);
            await sqlite.client().run('UPDATE projects SET title = ? WHERE id = ?', ['Later title', 'p']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite), fresh = methods();
            expect(value(fresh.trashItemsPurgeOutcome(command))).toEqual({ count: 3 });
            expect(value(await fresh.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 }); expect(await raw(sqlite)).toEqual(before);
            const changed = clone(command); changed.request.taskIds.reverse(); changed.prepared.request.taskIds.reverse();
            expect(fresh.validatePreparedTrashItemsPurge(changed).ok).toBe(true);
            expect(fresh.trashItemsPurgeOutcome(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await fresh.commitPreparedTrashItemsPurge(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('does not log a durable confirmation when the purge command is excluded from durable receipts', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { await loadNativeRequestReceipts(sqlite.client(), { durableCommands: [] });
            const diagnostic = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined), host = methods(), command = await prepare(host);
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            expect(await sqlite.receiptIds()).toEqual([]);
            expect(diagnostic.mock.calls.filter(([message]) => message === 'Native Trash purge confirmed')).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['after', 'mixed'])('keeps receiptless %s unproven without repairing or repurging', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const command = await prepare(), data = await getStorageAdapter().getData({ rawTasks: true }), effect = command.prepared.effect;
            const tasks = new Map(effect.tasks.map((pair) => [pair.before.id, pair.after]));
            data.tasks = data.tasks.map((row) => kind === 'after' || row.id === 'selected' ? tasks.get(row.id) ?? row : row);
            if (kind === 'after') { const projects = new Map(effect.projects.map((pair) => [pair.before.id, pair.after]));
                const sections = new Map(effect.sections.map((pair) => [pair.before.id, pair.after]));
                data.projects = data.projects.map((row) => projects.get(row.id) ?? row); data.sections = data.sections!.map((row) => sections.get(row.id) ?? row);
                data.settings.attachments!.pendingRemoteDeletes = effect.pendingRemoteDeletes ?? undefined; }
            await getStorageAdapter().saveData(data); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite), host = methods();
            expect(value(host.trashItemsPurgeOutcome(command))).toBeNull();
            expect(await host.commitPreparedTrashItemsPurge(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('initializes a missing device only with the saved rows and cleanup queue', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const saved = await getStorageAdapter().getData({ rawTasks: true }); delete saved.settings.deviceId;
            await getStorageAdapter().saveData(saved); useTaskStore.setState({ settings: saved.settings });
            const host = methods(), command = await prepare(host), before = await raw(sqlite);
            expect(command.prepared.deviceIdBefore).toBeNull(); expect(command.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined(); expect(await raw(sqlite)).toEqual(before);
            expect(value(await host.commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            expect(rows().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
            expect(rows().tasks.find((row) => row.id === 'selected')?.revBy).toBe(command.prepared.deviceIdToInitialize);
            expect(rows().settings.attachments?.pendingRemoteDeletes).toContainEqual({ cloudKey: 'task-only' });
        } finally { await sqlite.close(); }
    });

    it('retains compacted tombstones across exact replay, two SQLite loads and an older peer merge', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const older = rows(), command = await prepare(); expect(value(await methods().commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
            const selected = await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['selected']);
            const parent = await sqlite.sql('SELECT * FROM projects WHERE id = ?', ['p']);
            for (let i = 0; i < 2; i++) {
                await sqlite.restart(undefined, { recoveryLoad: true });
                expect(value(await methods().commitPreparedTrashItemsPurge(command))).toEqual({ count: 3 });
                expect(await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['selected'])).toEqual(selected);
                expect(await sqlite.sql('SELECT * FROM projects WHERE id = ?', ['p'])).toEqual(parent);
            }
            const merged = mergeAppDataWithStats(rows(), older, { nowIso: NOW });
            expect(merged.data.tasks.find((row) => row.id === 'selected')).toMatchObject({ title: '(deleted)', purgedAt: NOW, rev: 4 });
            expect(merged.data.projects.find((row) => row.id === 'p')).toMatchObject({ title: '(deleted)', purgedAt: NOW, rev: 3 });
            expect(merged.stats.tombstoneRepairs).toBe(0);
        } finally { await sqlite.close(); }
    });
});
