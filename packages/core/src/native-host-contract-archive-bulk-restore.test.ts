import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { createArchivedTasksRestoreMethods, type NativeArchivedTasksRestoreEnvelope } from './native-host-contract-archive-bulk-restore';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import type { AppData, Project, Section, Task } from './types';
import { deterministicHash128 } from './uuid';

const NOW = '2026-10-02T13:00:00.000Z';
const ARCHIVED = '2026-09-25T12:34:56.789Z';
const UUID = '00000000-0000-4000-8000-000000000180';
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, status: 'archived', createdAt: NOW, updatedAt: ARCHIVED,
    completedAt: ARCHIVED, archivedAt: ARCHIVED, rev: 3, revBy: 'device-a', tags: [], contexts: [],
    ...overrides,
});
const parent = (id: string, overrides: Partial<Project> = {}): Project => ({
    id, title: `Parent ${id}`, status: 'archived', color: '#94a3b8', order: 0, tagIds: [],
    createdAt: NOW, updatedAt: ARCHIVED, completedAt: ARCHIVED, archivedAt: ARCHIVED,
    rev: 2, revBy: 'device-a', ...overrides,
});
const section = (id: string, projectId: string, overrides: Partial<Section> = {}): Section => ({
    id, projectId, title: `Section ${id}`, order: 0, createdAt: NOW, updatedAt: ARCHIVED,
    projectArchivedAt: ARCHIVED, deletedAt: ARCHIVED, rev: 2, revBy: 'device-a', ...overrides,
});
const provenance: Partial<Task> = { projectArchivedAt: ARCHIVED, statusBeforeProjectArchive: 'next',
    completedAtBeforeProjectArchive: undefined, isFocusedTodayBeforeProjectArchive: true };
const seed = (): Partial<AppData> => ({
    tasks: [task('b', { projectId: 'p2', sectionId: 's2', ...provenance, cancelledAt: ARCHIVED, completedAt: undefined,
        recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
        attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW, updatedAt: NOW }],
        checklist: [{ id: 'step', title: 'Step', isCompleted: true }], timeSpentMinutes: 45,
        dueDate: '2026-10-04', startTime: '2026-10-03', reviewAt: '2026-10-05',
    }), task('a', { projectId: 'p1', sectionId: 's1', ...provenance }),
    task('sibling', { projectId: 'p1', ...provenance }), task('unrelated')],
    projects: [parent('p1', { isSequential: true }), parent('p2', { cancelledAt: ARCHIVED, completedAt: undefined })],
    sections: [section('s1', 'p1'), section('s2', 'p2')],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, gtd: { autoArchiveDays: 7 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const methods = () => createArchivedTasksRestoreMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); }
    catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected persistence failure' } }; }
    return useTaskStore.getState().persistenceFailure
        ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved persistence failure' } }
        : { ok: true, value: null };
} });
const request = (taskIds = ['a', 'b'], requestId = UUID) => ({ requestId, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])) });
const prepare = async (host = methods(), input = request()) => {
    const plan = value(await host.prepareArchivedTasksRestore(input));
    return { request: input, prepared: plan.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('guarded Archive bulk Restore', () => {
    it('preserves the old exact Archive request/prepared shape and full canonical receipt fingerprint bytes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const command = await prepare(host);
            expect(Object.keys(command.request).sort()).toEqual(['requestId', 'taskIds', 'taskRevisions'].sort());
            expect(Object.keys(command.prepared).sort()).toEqual(['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize',
                'updateAt', 'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result'].sort());
            const payload = JSON.stringify(['archivedTasksRestore', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const fingerprint = `archivedTasksRestore:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
            const result = value(await host.commitPreparedArchivedTasksRestore(command));
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual([
                { request_id: UUID, method: fingerprint, reply: JSON.stringify(result), saved_at: NOW },
            ]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await methods().commitPreparedArchivedTasksRestore(command))).toEqual(result);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual([
                { request_id: UUID, method: fingerprint, reply: JSON.stringify(result), saved_at: NOW },
            ]);
        } finally { await sqlite.close(); }
    });
    it('preserves the old exact five-field Done Move intent/result and independent full receipt fingerprint bytes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost({ tasks: [task('move', { status: 'done', completedAt: NOW, archivedAt: undefined,
            createdAt: NOW, updatedAt: NOW })], projects: [], sections: [], settings: { deviceId: 'device-a', analyticsProfileId: UUID } });
        try {
            const host = methods(); const input = { ...request(['move']), source: 'done' as const, status: 'waiting' as const };
            const plan = value(await host.prepareArchivedTasksRestore(input)); expect(plan.kind).toBe('prepared');
            if (plan.kind !== 'prepared') throw new Error('Existing Done Move always prepares');
            const command = { request: input, prepared: plan.prepared };
            expect(Object.keys(command.request).sort()).toEqual(['requestId', 'taskIds', 'taskRevisions', 'source', 'status'].sort());
            expect(Object.keys(command.prepared).sort()).toEqual(['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize',
                'updateAt', 'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result'].sort());
            expect(command.prepared.result).toEqual({ count: 1, status: 'waiting' });
            const payload = JSON.stringify(['doneTasksMove', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const fingerprint = `doneTasksMove:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 1, status: 'waiting' });
            const expected = [{ request_id: UUID, method: fingerprint, reply: JSON.stringify({ count: 1, status: 'waiting' }), saved_at: NOW }];
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(expected);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await methods().commitPreparedArchivedTasksRestore(command))).toEqual({ count: 1, status: 'waiting' });
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(expected);
        } finally { await sqlite.close(); }
    });
    it.each([['a', 'b'], ['a', 'sibling', 'b']])('matches actual RN batchMoveTasks whole content/all nine tables for selection %j', async (...selected) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed());
        let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            await canonical();
            expect(await useTaskStore.getState().batchMoveTasks(selected, 'inbox')).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed());
        try {
            await canonical();
            const host = methods(); const command = await prepare(host, request(selected));
            expect(value(host.validatePreparedArchivedTasksRestore(command))).toEqual({ count: selected.length, status: 'inbox' });
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: selected.length, status: 'inbox' });
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(await native.receiptIds()).toEqual([UUID]);
            expect(command.prepared.effect.projects.map((pair) => pair.after.id)).toEqual(['p1', 'p2']);
            expect(rows().projects.map((row) => row.rev)).toEqual([3, 3]);
            expect(rows().tasks).toHaveLength(4);
        } finally { await native.close(); }
    });

    it('rejects malformed, duplicate, missing, stale or non-Archive selections without partial mutation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const valid = request(); const before = await raw(sqlite);
            for (const input of [{ ...valid, taskIds: [] }, { ...valid, taskIds: ['a', 'a'] },
                { ...valid, taskIds: ['missing'], taskRevisions: { missing: 'revision' } },
                { ...valid, taskRevisions: { a: 'stale', b: valid.taskRevisions.b } },
                { ...valid, taskRevisions: { ...valid.taskRevisions, extra: 'revision' } }, { ...valid, status: 'inbox' },
                { ...valid, requestId: 'bad' }]) expect(await host.prepareArchivedTasksRestore(input as never)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('purely rejects forged effect, missing sources and unexpected scope membership before SQLite', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const reads = vi.fn(); const writes = vi.fn();
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (sql, params) => { reads(sql); return client.all(sql, params); },
            run: async (sql, params) => { writes(sql); return client.run(sql, params); },
        }));
        try {
            const host = methods(); const command = await prepare(host);
            for (const mutate of [
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks[0].after.description = 'Forged'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.scope.tasks = item.prepared.scope.tasks.filter((row) => row.id !== 'a'); },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.scope.tasks.push(task('unconnected')); },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.projects = []; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.result.count = 1; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.futureBoundary = NOW; },
            ]) {
                const forged = clone(command); mutate(forged); reads.mockClear(); writes.mockClear();
                expect(host.validatePreparedArchivedTasksRestore(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksRestore(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
            }
        } finally { await sqlite.close(); }
    });

    it('guards full raw parent membership and same-revision source/context edits atomically', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        for (const edit of [
            async (sqlite: Sqlite) => sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['a']),
            async (sqlite: Sqlite) => sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']),
            async (sqlite: Sqlite) => sqlite.client().run('UPDATE projects SET title = ? WHERE id = ?', ['Later parent', 'p1']),
            async (sqlite: Sqlite) => sqlite.client().run('UPDATE sections SET description = ? WHERE id = ?', ['Later section', 's1']),
            async (sqlite: Sqlite) => sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']),
            async (sqlite: Sqlite) => sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['sibling']),
        ]) {
            const sqlite = await openSqliteHost(seed());
            try {
                const command = await prepare(); await edit(sqlite);
                await sqlite.restart(undefined, { recoveryLoad: true });
                const before = await raw(sqlite);
                expect(await methods().commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } finally { await sqlite.close(); }
        }
    }, 15_000);

    it('refuses a self-consistent journal that omitted a real parent member, without persisting a partial scope', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const command = await prepare(host);
            command.prepared.scope.tasks = command.prepared.scope.tasks.filter((row) => row.id !== 'sibling');
            command.prepared.effect.tasks = command.prepared.effect.tasks.filter((pair) => pair.before.id !== 'sibling');
            expect(value(host.validatePreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('includes active-parent legacy inferred-container order candidates and matches actual RN exactly', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = seed();
        initial.tasks = [task('a', { projectId: 'p1', sectionId: 's1' }), task('b'), task('sibling', { projectId: 'p1', order: 8, orderNum: 8 })];
        initial.projects = [parent('p1', { status: 'active', completedAt: undefined, archivedAt: undefined })];
        initial.sections = [section('s1', 'p1', { deletedAt: undefined, projectArchivedAt: undefined })];
        const setup = async () => {
            const sqlite = await openSqliteHost(initial); await canonical();
            await sqlite.client().run('UPDATE tasks SET projectId = NULL, orderNum = NULL WHERE id = ?', ['a']);
            await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite;
        };
        const rn = await setup(); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            expect(await useTaskStore.getState().batchMoveTasks(['a', 'b'], 'inbox')).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
            expect(expected.tasks.find((row) => row.id === 'a')?.order).toBe(9);
        } finally { await rn.close(); }
        const native = await setup();
        try {
            const host = methods(); const command = await prepare(host);
            expect(command.prepared.scope.tasks.map((row) => row.id)).toEqual(['a', 'b', 'sibling']);
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
        } finally { await native.close(); }
    });

    it('preserves actual RN invalid retained-section refusal atomically', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = seed(); initial.sections![0].updatedAt = NOW;
        const sqlite = await openSqliteHost(initial);
        try {
            const before = await raw(sqlite);
            expect(await useTaskStore.getState().batchMoveTasks(['a', 'b'], 'inbox'))
                .toEqual({ success: false, error: 'Section not found' });
            expect(await methods().prepareArchivedTasksRestore(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('records the exact legacy raw difference from RN whole-save while fresh loaded full AppData remains equal', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const setup = async () => {
            const sqlite = await openSqliteHost(seed());
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL, attachments = ? WHERE id = ?',
                [JSON.stringify([{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW }]), 'unrelated']);
            await sqlite.restart(); return sqlite;
        };
        const rn = await setup(); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            expect(await useTaskStore.getState().batchMoveTasks(['a', 'b'], 'inbox')).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await setup();
        try {
            const host = methods(); const command = await prepare(host);
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            const actual = await raw(native);
            expect(actual).not.toEqual(expectedRaw!);
            const differences: Array<{ table: string; row: string; field: string; rn: unknown; native: unknown }> = [];
            for (const table of Object.keys(actual)) {
                const left = expectedRaw![table] as Array<Record<string, unknown>>;
                const right = actual[table] as Array<Record<string, unknown>>;
                expect(left).toHaveLength(right.length);
                for (let index = 0; index < left.length; index++) for (const field of Object.keys(left[index])) {
                    if (JSON.stringify(left[index][field]) !== JSON.stringify(right[index][field])) differences.push({
                        table, row: String(left[index].id), field, rn: left[index][field], native: right[index][field],
                    });
                }
            }
            expect(differences).toEqual([
                { table: 'tasks', row: 'unrelated', field: 'pushCount', rn: 0, native: null },
                {
                    table: 'tasks', row: 'unrelated', field: 'attachments',
                    rn: JSON.stringify([{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW, updatedAt: '' }]),
                    native: JSON.stringify([{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW }]),
                },
            ]);
            await native.restart();
            expect(rows()).toEqual(expected!);
            expect(await native.receiptIds()).toEqual([UUID]);
        } finally { await native.close(); }
    });

    it('allows unrelated settings changes only when current RN replan/device yields the same full effect', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare();
            await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()),
                settings: { ...useTaskStore.getState().settings, theme: 'dark', gtd: { autoArchiveDays: 30 } } });
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await methods().commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            expect(useTaskStore.getState().settings.theme).toBe('dark');
            expect(useTaskStore.getState().settings.gtd?.autoArchiveDays).toBe(30);
        } finally { await sqlite.close(); }
        const changedDevice = await openSqliteHost(seed());
        try {
            const command = await prepare();
            await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()),
                settings: { ...useTaskStore.getState().settings, deviceId: 'later-device' } });
            await changedDevice.restart(undefined, { recoveryLoad: true }); const before = await raw(changedDevice);
            expect(await methods().commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(changedDevice)).toEqual(before); expect(await changedDevice.receiptIds()).toEqual([]);
        } finally { await changedDevice.close(); }
    });

    it('keeps exact saved UUID/payload acknowledgment after cold restart and later edits, but refuses unused UUID equal AFTER', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const command = await prepare(host);
            const unused = clone(command); unused.request.requestId = '00000000-0000-4000-8000-000000000181';
            unused.prepared.request.requestId = unused.request.requestId;
            expect(value(host.validatePreparedArchivedTasksRestore(unused))).toEqual({ count: 2, status: 'inbox' });
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            await sqlite.restart(undefined, { recoveryLoad: true }); let fresh = methods();
            const landed = await raw(sqlite);
            expect(value(fresh.archivedTasksRestoreOutcome(unused))).toBeNull();
            expect(await fresh.commitPreparedArchivedTasksRestore(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(landed);
            await sqlite.client().run('UPDATE tasks SET title = ?, status = ?, rev = rev + 1 WHERE id = ?', ['Later row', 'done', 'a']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'p1']);
            await sqlite.restart(undefined, { recoveryLoad: true }); fresh = methods();
            const later = await raw(sqlite);
            const receipt = await sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid');
            expect(value(fresh.archivedTasksRestoreOutcome(command))).toEqual({ count: 2, status: 'inbox' });
            expect(value(await fresh.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            expect(await raw(sqlite)).toEqual(later);
            expect(await sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid')).toEqual(receipt);
            const sameUuidOtherPayload = clone(command); sameUuidOtherPayload.request.taskIds.reverse();
            sameUuidOtherPayload.prepared.request.taskIds.reverse();
            expect(value(fresh.validatePreparedArchivedTasksRestore(sameUuidOtherPayload))).toEqual({ count: 2, status: 'inbox' });
            expect(fresh.archivedTasksRestoreOutcome(sameUuidOtherPayload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await fresh.commitPreparedArchivedTasksRestore(sameUuidOtherPayload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(later);
        } finally { await sqlite.close(); }
    });

    it('survives two failed COMMITs in one host then saves the owned raw overlay without unrelated normalization', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['a']);
            const legacyAttachment = { id: 'untouched-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW };
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL, attachments = ? WHERE id = ?',
                [JSON.stringify([legacyAttachment]), 'unrelated']);
            await sqlite.restart(); const host = methods(); const command = await prepare(host);
            expect(command.prepared.scope.tasks.find((row) => row.id === 'a')?.focusOrder).toBe(2);
            expect(command.prepared.scope.tasks.find((row) => row.id === 'a')?.pushCount).toBeUndefined();
            const before = await raw(sqlite);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10;
                expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
                expect(value(host.archivedTasksRestoreOutcome(command))).toBeNull();
            }
            fault.commits = 0;
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            const after = await raw(sqlite);
            expect((after.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'))
                .toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'));
            expect(await sqlite.receiptIds()).toEqual([UUID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().archivedTasksRestoreOutcome(command))).toEqual({ count: 2, status: 'inbox' });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('cold-recovers an uncommitted raw legacy batch from exactly the captured BEFORE', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            await sqlite.restart(); const command = await prepare(); const before = await raw(sqlite);
            fault.commits = 10;
            expect(await methods().commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            fault.commits = 0; await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get('a')?.focusOrder).toBe(2);
            expect(value(await methods().commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            const after = await raw(sqlite);
            expect((after.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'))
                .toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'));
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('does not reserve a landed receipt for a failed prewrite durable read or an unrelated failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { read: false };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (sql, params) => {
            if (fault.read && sql.includes('FROM tasks')) throw new Error('injected read failure');
            return client.all(sql, params);
        } }));
        try {
            const host = methods(); const command = await prepare(host); const before = await raw(sqlite);
            fault.read = true;
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(host.archivedTasksRestoreOutcome(command))).toBeNull();
            useTaskStore.setState({ persistenceFailure: { message: 'Unrelated failure', failedAt: NOW, retrying: false } });
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            useTaskStore.setState({ persistenceFailure: null });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'inbox' });
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fault.read = false; await sqlite.close(); }
    });

    it('accepts revision dictionaries beyond128 keys and refuses over-budget rich scope before writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = seed(); initial.tasks = Array.from({ length: 140 }, (_, index) => task(`selected-${index}`));
        initial.projects = []; initial.sections = [];
        const sqlite = await openSqliteHost(initial);
        try {
            const host = methods(); const selected = initial.tasks.map((row) => row.id);
            const command = await prepare(host, request(selected));
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 140, status: 'inbox' });
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { await sqlite.close(); }
        const huge = seed(); huge.tasks = [task('a', { description: '界'.repeat(700_000) }), task('b')];
        huge.projects = []; huge.sections = [];
        const bounded = await openSqliteHost(huge);
        try {
            const before = await raw(bounded);
            expect(await methods().prepareArchivedTasksRestore(request())).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(bounded)).toEqual(before); expect(await bounded.receiptIds()).toEqual([]);
        } finally { await bounded.close(); }
    }, 15_000);
});
