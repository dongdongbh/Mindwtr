import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { createTrashItemsRestoreMethods, trashItemsRestoreEffect, type NativeTrashItemsRestoreEnvelope } from './native-host-contract-trash-bulk-restore';
import { loadNativeRequestReceipts, revisionOf, taskRevisionOf } from './native-request-receipts';
import { buildSaveSnapshot } from './store-helpers';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { restoreTrashItems } from './trash-view-model';
import { createNativeHostContract } from './native-host-contract';
import { AREA_FILTER_NONE, areaFilterSelectionToFilters } from './area-filter';
import type { AppData, Area, Project, Section, Task } from './types';
import * as logger from './logger';

const NOW = '2026-10-09T13:00:00.000Z';
const DELETED = '2026-10-08T12:00:00.000Z';
const INDEPENDENT = '2026-10-07T12:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000501';
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (id: string, overrides: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'next',
    tags: [], contexts: [], createdAt: NOW, updatedAt: DELETED, deletedAt: DELETED,
    rev: 3, revBy: 'device-a', ...overrides });
const project = (id: string, overrides: Partial<Project> = {}): Project => ({ id, title: `Project ${id}`,
    status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: NOW, updatedAt: DELETED,
    deletedAt: DELETED, rev: 2, revBy: 'device-a', ...overrides });
const section = (id: string, overrides: Partial<Section> = {}): Section => ({ id, projectId: 'p', title: id,
    order: 0, createdAt: NOW, updatedAt: DELETED, deletedAt: DELETED, rev: 2, revBy: 'device-a', ...overrides });
const area = (id: string, overrides: Partial<Area> = {}): Area => ({ id, name: id, order: 0,
    createdAt: NOW, updatedAt: NOW, ...overrides });
const seed = (selectedStamp = DELETED): Partial<AppData> => ({
    tasks: [task('selected', { projectId: 'p', sectionId: 'matching', deletedAt: selectedStamp,
        status: 'done', completedAt: INDEPENDENT, description: 'Retain content', dueDate: '2026-10-11' }),
    task('cascade', { projectId: 'p', sectionId: 'matching', status: 'reference' }),
    task('independent', { projectId: 'p', sectionId: 'independent', deletedAt: INDEPENDENT, status: 'waiting' }),
    task('purged', { projectId: 'p', purgedAt: DELETED }),
    task('detached', { deletedAt: undefined, status: 'someday' }),
    task('standalone', { areaId: 'gone', status: 'archived', archivedAt: INDEPENDENT }),
    task('unrelated', { deletedAt: undefined })],
    projects: [project('p', { areaId: 'area', areaTitle: 'Frozen title' }), project('other', { deletedAt: undefined })],
    sections: [section('matching'), section('independent', { deletedAt: INDEPENDENT }), section('live', { deletedAt: undefined })],
    areas: [area('area'), area('gone', { deletedAt: DELETED })],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: ID, gtd: { autoArchiveDays: 90 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const missingReferences = async (sqlite: Sqlite) => {
    await sqlite.client().run('PRAGMA foreign_keys = OFF');
    await sqlite.client().run('UPDATE tasks SET sectionId = ?, areaId = ? WHERE id = ?', ['absent-section', 'absent-area', 'section-only']);
    await sqlite.client().run('PRAGMA foreign_keys = ON');
    useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'section-only'
        ? { ...row, sectionId: 'absent-section', areaId: 'absent-area' } : row) });
};
const methods = () => createTrashItemsRestoreMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected save failure' } }; }
    return useTaskStore.getState().persistenceFailure ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved save' } }
        : { ok: true, value: null };
} });
const request = (taskIds = ['selected', 'standalone'], projectIds = ['p'], requestId = ID) => ({ requestId, taskIds, projectIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    projectRevisions: Object.fromEntries(projectIds.map((id) => [id, revisionOf(useTaskStore.getState()._projectsById.get(id)!)])),
});
const prepare = async (host = methods(), input = request()): Promise<NativeTrashItemsRestoreEnvelope> => ({ request: input,
    prepared: value(await host.prepareTrashItemsRestore(input)).prepared });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('guarded mixed Trash bulk Restore', () => {
    it.each([1, 2] as const)('cold-replays the v%s bulk restore color policy after Area deletion', async (version) => {
        const selected = seed();
        selected.projects![0].color = '#3b82f6';
        const sqlite = await openSqliteHost(selected);
        try {
            await useTaskStore.getState().deleteArea('area');
            await flushPendingSave();
            const frozen = clone(await prepare(methods(), request([], ['p'])));
            expect(frozen.prepared.version).toBe(2);
            frozen.prepared.version = version;
            if (version === 1) {
                for (const pair of frozen.prepared.effect.projects) pair.after.color = pair.before.color;
            }
            expect(value(methods().validatePreparedTrashItemsRestore(frozen))).toEqual({ count: 1 });
            expect(value(await methods().commitPreparedTrashItemsRestore(frozen))).toEqual({ count: 1 });
            const restored = useTaskStore.getState()._projectsById.get('p')!;
            expect(restored.areaId).toBeUndefined();
            expect(restored.color).toBe(version === 1 ? '#3b82f6' : '#94a3b8');
            // Restart the same file, including its private durable request receipt.
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(value(await methods().commitPreparedTrashItemsRestore(frozen))).toEqual({ count: 1 });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each([DELETED, INDEPENDENT])('matches actual RN task-first rows and preserves selected detachment for stamp %s', async (stamp) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed(stamp)); let expected: AppData;
        try { await canonical(); await restoreTrashItems(useTaskStore.getState(), { taskIds: ['selected', 'standalone'], projectIds: ['p'] });
            await flushPendingSave(); expected = rows(); } finally { await rn.close(); }
        const native = await openSqliteHost(seed(stamp));
        try {
            await canonical(); const host = methods(), before = await raw(native), command = await prepare(host);
            expect(await raw(native)).toEqual(before); expect(await native.receiptIds()).toEqual([]);
            expect(value(host.validatePreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            const publications: number[] = []; const off = useTaskStore.subscribe((next, previous) => {
                if (next._allTasks !== previous._allTasks) publications.push(next._allTasks.filter((row) => !row.deletedAt).length);
            });
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 }); off();
            expect(publications).toHaveLength(1); expect(rows()).toEqual(expected!);
            expect(rows().tasks.find((row) => row.id === 'selected')).toMatchObject({ rev: 4, status: 'done' });
            expect(rows().tasks.find((row) => row.id === 'selected')?.projectId).toBeUndefined();
            expect(rows().tasks.find((row) => row.id === 'purged')?.purgedAt).toBe(DELETED);
            expect(await native.receiptIds()).toEqual([ID]);
        } finally { await native.close(); }
    });

    it.each(['live', 'deleted', 'missing'])('matches RN section-parent and Area sanitation with %s context', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(); data.tasks!.push(task('section-only', { sectionId: kind === 'missing' ? undefined : 'context', areaId: 'area' }));
        data.projects!.push(project('parent', { deletedAt: kind === 'live' ? undefined : DELETED }));
        if (kind !== 'missing') data.sections!.push(section('context', { projectId: 'parent', deletedAt: undefined }));
        if (kind === 'deleted') data.areas![0].deletedAt = DELETED;
        const ids = ['section-only', 'standalone']; const rn = await openSqliteHost(data); let expected: AppData;
        try { await canonical(); if (kind === 'missing') await missingReferences(rn);
            await restoreTrashItems(useTaskStore.getState(), { taskIds: ids, projectIds: ['p'] });
            await flushPendingSave(); expected = rows(); } finally { await rn.close(); }
        const native = await openSqliteHost(data);
        try { await canonical(); if (kind === 'missing') await missingReferences(native);
            const host = methods(), command = await prepare(host, request(ids));
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 }); expect(rows()).toEqual(expected!);
        } finally { await native.close(); }
    });

    it.each(['task', 'project'])('supports %s-only selections and pure preparation', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const before = rows(), disk = await raw(sqlite), host = methods();
            const command = await prepare(host, request(kind === 'task' ? ['standalone'] : [], kind === 'project' ? ['p'] : []));
            expect(rows()).toEqual(before); expect(await raw(sqlite)).toEqual(disk);
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 1 });
        } finally { await sqlite.close(); }
    });

    it.each(['same-revision-edit', 'new-child', 'moved-child', 'new-section', 'missing-selected', 'redelete', 'purge', 'missing-container', 'appearing-container'])(
    'refuses %s for the whole scope without late partial writes', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            if (kind === 'appearing-container') {
                await sqlite.client().run('PRAGMA foreign_keys = OFF');
                await sqlite.client().run('UPDATE tasks SET areaId = ? WHERE id = ?', ['appeared', 'standalone']);
                await sqlite.client().run('PRAGMA foreign_keys = ON');
                useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'standalone' ? { ...row, areaId: 'appeared' } : row) });
            }
            const host = methods(), command = await prepare(host);
            const data = await getStorageAdapter().getData({ rawTasks: true });
            if (kind === 'same-revision-edit') data.tasks.find((row) => row.id === 'cascade')!.description = 'External edit';
            if (kind === 'new-child') data.tasks.push(task('new', { projectId: 'p' }));
            if (kind === 'moved-child') data.tasks.find((row) => row.id === 'independent')!.projectId = 'other';
            if (kind === 'new-section') data.sections!.push(section('new-section'));
            if (kind === 'missing-selected') data.tasks = data.tasks.filter((row) => row.id !== 'selected');
            if (kind === 'redelete') data.tasks.find((row) => row.id === 'selected')!.deletedAt = INDEPENDENT;
            if (kind === 'purge') data.projects.find((row) => row.id === 'p')!.purgedAt = NOW;
            if (kind === 'appearing-container') data.areas!.push(area('appeared'));
            data.tasks.find((row) => row.id === 'unrelated')!.description = 'Unrelated edit';
            await getStorageAdapter().saveData(data);
            if (kind === 'missing-container') {
                await sqlite.client().run('PRAGMA foreign_keys = OFF');
                await sqlite.client().run('DELETE FROM areas WHERE id = ?', ['area']);
                await sqlite.client().run('PRAGMA foreign_keys = ON');
            }
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('recollects real saved membership rather than trusting an internally closed omitted-child journal', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host);
            command.prepared.scope.tasks = command.prepared.scope.tasks.filter((row) => row.id !== 'cascade');
            command.prepared.effect = clone(trashItemsRestoreEffect(command.prepared)!);
            expect(host.validatePreparedTrashItemsRestore(command).ok).toBe(true); const before = await raw(sqlite);
            expect(await host.commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('rejects malformed request, effect, device, time, result, duplicates and oversized cascades before writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host), before = await raw(sqlite);
            const invalidRequests = [{ ...command.request, extra: true }, { ...command.request, taskIds: ['selected', 'selected'] },
                { ...command.request, taskRevisions: {} }, { ...command.request, projectRevisions: { p: 'stale' } },
                { ...command.request, taskIds: [], projectIds: [], taskRevisions: {}, projectRevisions: {} },
                { ...command.request, taskIds: Array.from({ length: 10001 }, (_, i) => `t${i}`), projectIds: [], projectRevisions: {},
                    taskRevisions: Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`t${i}`, 'r'])) }];
            for (const input of invalidRequests) expect((await host.prepareTrashItemsRestore(input)).ok).toBe(false);
            const mutations: ((row: NativeTrashItemsRestoreEnvelope) => void)[] = [
                (row) => { Object.assign(row, { extra: true }); }, (row) => { Object.assign(row.prepared, { extra: true }); },
                (row) => { row.prepared.result.count++; }, (row) => { row.prepared.deviceIdBefore = 'wrong'; },
                (row) => { row.prepared.updateAt = 'yesterday'; }, (row) => { row.prepared.effect.tasks[0].after.rev = 99; },
                (row) => { row.prepared.scope.tasks.push(row.prepared.scope.tasks[0]); },
                (row) => { row.prepared.effect.projects[0].after.title = 'Forged'; },
                (row) => { row.prepared.scope.tasks[0].description = 'é'.repeat(1_000_000); },
            ];
            for (const mutate of mutations) { const invalid = clone(command); mutate(invalid);
                expect(host.validatePreparedTrashItemsRestore(invalid).ok).toBe(false); expect((await host.commitPreparedTrashItemsRestore(invalid)).ok).toBe(false); }
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            const data = await getStorageAdapter().getData({ rawTasks: true }); data.tasks.push(task('large', { projectId: 'p', description: 'x'.repeat(1_100_000) }));
            await getStorageAdapter().saveData(data); await sqlite.restart(undefined, { recoveryLoad: true }); const largeBefore = await raw(sqlite);
            expect(await methods().prepareTrashItemsRestore(request([], ['p']))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('fewer') } });
            expect(await raw(sqlite)).toEqual(largeBefore);
        } finally { await sqlite.close(); }
    });

    it('preserves unrelated raw rows/settings and exact durable receipt after cold restart and later edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const host = methods(), command = await prepare(host);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            const data = await getStorageAdapter().getData({ rawTasks: true }); data.settings = { ...data.settings, theme: 'dark' };
            await getStorageAdapter().saveData(data); const unrelated = await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['unrelated']);
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            expect(await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['unrelated'])).toEqual(unrelated);
            expect(useTaskStore.getState().settings.theme).toBe('dark');
            await sqlite.client().run('UPDATE tasks SET description = ?, rev = rev + 1 WHERE id = ?', ['Later edit', 'selected']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'p']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const fresh = methods(), before = await raw(sqlite);
            expect(value(fresh.trashItemsRestoreOutcome(command))).toEqual({ count: 3 });
            expect(value(await fresh.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 }); expect(await raw(sqlite)).toEqual(before);
            const changed = clone(command); changed.request.taskIds.reverse(); changed.prepared.request.taskIds.reverse();
            expect(fresh.trashItemsRestoreOutcome(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });

    it.each(['after', 'mixed'])('refuses unused UUID with %s rows; no partial repair or inferred receipt', async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const command = await prepare(), data = await getStorageAdapter().getData({ rawTasks: true });
            const effect = command.prepared.effect; const taskAfter = new Map(effect.tasks.map((pair) => [pair.before.id, pair.after]));
            data.tasks = data.tasks.map((row) => kind === 'after' || row.id === 'selected' ? taskAfter.get(row.id) ?? row : row);
            if (kind === 'after') { const p = new Map(effect.projects.map((pair) => [pair.before.id, pair.after]));
                const s = new Map(effect.sections.map((pair) => [pair.before.id, pair.after]));
                data.projects = data.projects.map((row) => p.get(row.id) ?? row); data.sections = data.sections!.map((row) => s.get(row.id) ?? row); }
            await getStorageAdapter().saveData(data); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite), fresh = methods();
            expect(value(fresh.trashItemsRestoreOutcome(command))).toBeNull();
            expect(await fresh.commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('retries two failed COMMITs using the owned raw BEFORE without touching legacy unrelated rows', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const diagnostic = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try { const host = methods(), command = await prepare(host);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            const unrelated = await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['unrelated']); fault.commits = 20;
            expect(await host.commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host.commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(diagnostic.mock.calls.filter(([message]) => message === 'Native Trash bulk Restore confirmed')).toEqual([]);
            fault.commits = 0; expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            expect(diagnostic).toHaveBeenCalledWith('Native Trash bulk Restore confirmed', {
                scope: 'native-host', category: 'storage',
                context: { releaseCheck: 'v1.3.5/ios-trash-bulk-restore', outcome: 'confirmed', count: 3 },
            });
            diagnostic.mockImplementation(() => { throw new Error('Injected diagnostic failure'); });
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            expect(await sqlite.sql('SELECT * FROM tasks WHERE id = ?', ['unrelated'])).toEqual(unrelated); expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('does not claim durable receipt confirmation when this command is excluded', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            await loadNativeRequestReceipts(sqlite.client(), { durableCommands: [] });
            const diagnostic = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
            const host = methods(), command = await prepare(host);
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            expect(await sqlite.receiptIds()).toEqual([]);
            expect(diagnostic.mock.calls.filter(([message]) => message === 'Native Trash bulk Restore confirmed')).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('cold exact BEFORE applies once and disappeared receipt does not turn AFTER into proof', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const command = await prepare(); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await methods().commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            await sqlite.client().run('DELETE FROM native_request_receipts'); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(methods().trashItemsRestoreOutcome(command))).toBeNull();
            expect(await methods().commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('admits the count boundary grammar but rejects overflow and changed device before writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const taskIds = Array.from({ length: 10_000 }, (_, i) => `absent-${i}`);
            const bound = { requestId: ID, taskIds, projectIds: [], projectRevisions: {},
                taskRevisions: Object.fromEntries(taskIds.map((id) => [id, 'r'])) };
            expect(await host.prepareTrashItemsRestore(bound)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host.prepareTrashItemsRestore({ ...bound, projectIds: ['p'], projectRevisions: { p: 'r' } }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const command = await prepare(host), data = await getStorageAdapter().getData({ rawTasks: true });
            data.settings.deviceId = 'later-device'; await getStorageAdapter().saveData(data);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().commitPreparedTrashItemsRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('initializes a missing device only at the guarded durable batch', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const data = seed(); delete data.settings!.deviceId;
        const sqlite = await openSqliteHost(data);
        try {
            // Boot may initialize its own policy device; stage a genuinely missing saved/current device.
            const saved = await getStorageAdapter().getData({ rawTasks: true }); delete saved.settings.deviceId;
            await getStorageAdapter().saveData(saved); useTaskStore.setState({ settings: saved.settings });
            const host = methods(), command = await prepare(host);
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            expect(command.prepared.deviceIdBefore).toBeNull(); expect(command.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            expect(value(await host.commitPreparedTrashItemsRestore(command))).toEqual({ count: 3 });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
        } finally { await sqlite.close(); }
    });

    it('returns full filtered readonly selection beyond the loaded window with optional replay tokens and exact stale revision', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(); data.tasks = Array.from({ length: 138 }, (_, i) => task(`t${i}`, { areaId: 'area' }));
        const sqlite = await openSqliteHost(data);
        try { const host = createNativeHostContract({ replayTokens: 'optional' });
            value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
            value(await host.activate({ writeSafetyReady: true, recoveryLoad: true }));
            const view = value(host.getTrashView({ offset: 0, limit: 50, selected: { taskIds: ['t137', 'gone'], projectIds: ['p'] } }));
            const before = await raw(sqlite), selection = value(host.getTrashSelection({ revision: view.revision }));
            expect(view.items).toHaveLength(50); expect(selection.taskIds).toHaveLength(138); expect(selection.projectIds).toEqual(['p']);
            expect(Object.keys(selection.taskRevisions)).toHaveLength(138); expect(Object.keys(selection.projectRevisions)).toEqual(['p']);
            expect(view.selected.taskIds).toEqual(['t137']); expect(await raw(sqlite)).toEqual(before);
            useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, filters: areaFilterSelectionToFilters({ included: [AREA_FILTER_NONE], excluded: [] }) }, lastDataChangeAt: Date.now() + 1 });
            expect(host.getTrashSelection({ revision: view.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const narrowed = value(host.getTrashView({ offset: 0, limit: 50 }));
            const filtered = value(host.getTrashSelection({ revision: narrowed.revision })); expect(filtered.taskIds).toEqual([]);
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
});
