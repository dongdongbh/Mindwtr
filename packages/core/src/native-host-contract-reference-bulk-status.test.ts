import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReferenceTasksMoveMethods, type NativeReferenceTasksMoveEnvelope } from './native-host-contract-reference-bulk-status';
import { join } from 'node:path';
import { openScratchSqlite, openSqliteHost as openHost } from './screen-parity.replay';
const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
import { NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import { getBulkMoveStatusOptions } from './task-list-bulk-actions';
import * as uuid from './uuid';
import { deterministicHash128 } from './uuid';
import type { AppData, Task, TaskStatus } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000193';
const DEVICE = 'reference-move-device';
const ORIGINAL_TZ = process.env.TZ;
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'reference',
    createdAt: BEFORE, updatedAt: BEFORE, tags: [], contexts: [], rev: 3, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({ tasks: [task('b', { projectId: 'p2', sectionId: 's2', description: 'Rich fixture',
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }],
    checklist: [{ id: 'step', title: 'Step', isCompleted: true }], timeSpentMinutes: 45,
    dueDate: '2026-10-05', startTime: '2026-10-04', reviewAt: '2026-10-06', focusOrder: 9 }),
    task('a', { projectId: 'p1', sectionId: 's1' }),
    task('sibling', { status: 'next', projectId: 'p1', order: 8, orderNum: 8 }),
    task('history', { status: 'done', projectId: 'p1', deletedAt: BEFORE }), task('unrelated')],
    projects: ['p1', 'p2'].map((id) => ({ id, title: `Parent ${id}`, status: 'active', color: '#94a3b8', order: 0,
        tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 2, revBy: DEVICE })),
    sections: ['s1', 's2'].map((id, index) => ({ id, projectId: `p${index + 1}`, title: `Section ${id}`, order: 0,
        createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE })),
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: BEFORE, updatedAt: BEFORE }],
    people: [{ id: 'person', name: 'Person', createdAt: BEFORE, updatedAt: BEFORE }],
    settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID, gtd: { autoArchiveDays: 7 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, {
    columns: await sqlite.sql(`PRAGMA table_info(${table})`), indexes: await sqlite.sql(`PRAGMA index_list(${table})`),
    foreignKeys: await sqlite.sql(`PRAGMA foreign_key_list(${table})`),
    definitions: await sqlite.sql('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name', [table]),
    rows: await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`),
}])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const methods = () => createReferenceTasksMoveMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
    return useTaskStore.getState().persistenceFailure
        ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
} });
const request = (status: TaskStatus = 'inbox', taskIds = ['a', 'b'], requestId = REQUEST_ID, params = {}) => ({ requestId,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    status: status as 'inbox' | 'next' | 'waiting' | 'someday' | 'done', params });
const prepare = async (host = methods(), input = request()): Promise<NativeReferenceTasksMoveEnvelope> =>
    ({ request: input, prepared: value(await host.prepareReferenceTasksMove(input)).prepared });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const ids = () => {
    let index = 0;
    return vi.spyOn(uuid, 'generateUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(900 + ++index).padStart(12, '0')}`);
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

describe('guarded Reference bulk Move status', () => {
    it.each(getBulkMoveStatusOptions('reference'))('matches actual RN batchMoveTasks complete AppData and nine SQLite domains for %s', async (status) => {
        clock(); const rn = await openSqliteHost(seed()); let expected; let expectedRaw;
        try {
            await canonical(); const generated = ids();
            expect(await useTaskStore.getState().batchMoveTasks(['a', 'b'], status)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); generated.mockRestore();
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); ids(); const host = methods(); const command = await prepare(host, request(status));
            expect(command.prepared.scope.tasks.map((row) => row.id)).toEqual(['b', 'a', 'sibling', 'history']);
            expect(value(host.validatePreparedReferenceTasksMove(command))).toEqual({ count: 2, status });
            expect(value(await host.commitPreparedReferenceTasksMove(command))).toEqual({ count: 2, status });
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
            if (status === 'next') {
                const future = rows().tasks.find((row) => row.id === 'b')!;
                expect(future.status).toBe('next'); // Actual RN keeps Next, clears the star and retains this hidden order.
                expect(future.isFocusedToday).toBe(false); expect(future.focusOrder).toBe(9);
            }
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    const parity = async (initial: Partial<AppData>, selected: string[], status: TaskStatus = 'done') => {
        const rn = await openSqliteHost(initial); let expected; let expectedRaw;
        try {
            await canonical(); const generated = ids();
            expect(await useTaskStore.getState().batchMoveTasks(selected, status)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); generated.mockRestore();
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); ids(); const host = methods(); const command = await prepare(host, request(status, selected));
            value(await host.commitPreparedReferenceTasksMove(command));
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
            return clone(command);
        } finally { await sqlite.close(); vi.restoreAllMocks(); }
    };

    const matrix = (['strict', 'fluid'] as const).flatMap((strategy) => [
        { label: 'daily neither', recurrence: { rule: 'daily' as const, strategy }, dates: {} },
        { label: 'daily start', recurrence: { rule: 'daily' as const, strategy }, dates: { startTime: '2026-10-01' } },
        { label: 'weekly due BYDAY', recurrence: { rule: 'weekly' as const, strategy, byDay: ['MO', 'WE'] as const }, dates: { dueDate: '2026-10-01' } },
        { label: 'monthly both day', recurrence: { rule: 'monthly' as const, strategy, byMonthDay: [31] }, dates: { startTime: '2026-08-30', dueDate: '2026-08-31' } },
        { label: 'monthly nth weekday', recurrence: { rule: 'monthly' as const, strategy, byDay: ['-1FR' as const] }, dates: { dueDate: '2026-09-25' } },
        { label: 'yearly datetime', recurrence: { rule: 'yearly' as const, strategy }, dates: { startTime: '2026-10-01T10:00:00.000Z', dueDate: '2026-10-02T10:00:00.000Z' } },
        { label: 'COUNT stops', recurrence: { rule: 'daily' as const, strategy, count: 2, completedOccurrences: 1 }, dates: { dueDate: '2026-10-01' } },
        { label: 'COUNT advances', recurrence: { rule: 'daily' as const, strategy, count: 4, completedOccurrences: 1 }, dates: { dueDate: '2026-10-01' } },
        { label: 'UNTIL stops', recurrence: { rule: 'daily' as const, strategy, until: '2026-10-02' }, dates: { dueDate: '2026-10-01' } },
        { label: 'UNTIL advances', recurrence: { rule: 'weekly' as const, strategy, until: '2026-11-01', byDay: ['MO', 'WE'] as const }, dates: { dueDate: '2026-10-01' } },
    ].map((scenario) => ({ ...scenario, strategy })));
    it.each(matrix)('matches shared RN recurrence $strategy $label', async ({ recurrence, dates }) => {
        clock(); await parity({ tasks: [task('source', { recurrence: clone(recurrence) as Task['recurrence'], ...dates,
            description: 'Rich', checklist: [{ id: 'step', title: 'Checklist', isCompleted: true }],
            attachments: [{ id: 'file', kind: 'file', title: 'Attachment', uri: '/fixtures/attachment', cloudKey: 'fixture-object',
                createdAt: BEFORE, updatedAt: BEFORE, pendingContentUpload: true }] })], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } }, ['source']);
    });

    it('allocates complete deterministic source-order sequences for multiple sources and deduplicated projectless candidates', async () => {
        clock(); const initial = { tasks: [task('first', { title: 'Same source', recurrence: { rule: 'daily', seriesId: 'shared-series' }, dueDate: '2026-10-03',
            checklist: [{ id: 'step', title: 'Step', isCompleted: true }] }),
            task('second', { title: 'Same source', recurrence: { rule: 'daily', seriesId: 'shared-series' }, dueDate: '2026-10-03' }),
            task('other-series', { recurrence: { rule: 'weekly', seriesId: 'other-series', byDay: ['MO'] }, dueDate: '2026-10-03' }),
            task('peer', { title: 'Same source', recurrence: { rule: 'daily', seriesId: 'shared-series' }, dueDate: '2026-10-04' }),
            task('unrelated-peer')], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } } as Partial<AppData>;
        const command = await parity(initial, ['other-series', 'second', 'first']);
        expect(command.prepared.scope.tasks.map((row) => row.id)).toEqual(initial.tasks!.map((row) => row.id));
        expect(command.prepared.allocatedIds).toHaveLength(4); // first checklist + first candidate + second candidate + independent candidate
        expect(command.prepared.effect.createdTasks).toHaveLength(1);
        expect(command.prepared.effect.createdTasks[0].recurrence?.seriesId).toBe('other-series');
    });

    it('retains a created candidate when a preexisting same-series peer belongs to a different normalized project', async () => {
        clock(); const initial = seed(); initial.tasks = [task('a', { recurrence: { rule: 'daily', seriesId: 'series' }, dueDate: '2026-10-03' }),
            task('b', { projectId: 'p1', recurrence: { rule: 'daily', seriesId: 'series' }, dueDate: '2026-10-04' })];
        const command = await parity(initial, ['a']); expect(command.prepared.effect.createdTasks).toHaveLength(1);
    });

    it.each(['same-host', 'cold'] as const)('retries exact frozen recurrence IDs after two COMMIT failures through %s host', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected COMMIT failure'); } return client.run(sql, params); },
        }));
        try {
            await canonical(); ids(); let host = methods(); const command = clone(await prepare(host, request('done'))); const before = await raw(sqlite);
            expect(command.prepared.allocatedIds.length).toBeGreaterThan(0);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(value(host.referenceTasksMoveOutcome(command))).toBeNull();
            }
            fault.commits = 0; vi.restoreAllMocks();
            vi.setSystemTime(new Date('2028-03-15T23:15:00.000Z'));
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated a UUID'); });
            expect(value(await host.commitPreparedReferenceTasksMove(command))).toEqual({ count: 2, status: 'done' });
            vi.restoreAllMocks();
            const children = rows().tasks.filter((row) => command.prepared.effect.createdTasks.some((child) => child.id === row.id));
            expect(children).toEqual(command.prepared.effect.createdTasks);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().referenceTasksMoveOutcome(command))).toEqual({ count: 2, status: 'done' });
            const payload = JSON.stringify(['referenceTasksMove', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const method = `referenceTasksMove:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
            expect(await sqlite.sql('SELECT request_id,method,reply FROM native_request_receipts ORDER BY request_id')).toEqual([
                { request_id: REQUEST_ID, method, reply: JSON.stringify({ count: 2, status: 'done' }) }]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it.each(['same-host', 'cold'] as const)('freezes missing device adoption and recurring children through failed save and %s retry', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected failure'); } return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); ids(); let host = methods();
            const command = clone(await prepare(host, request('done'))); const before = await raw(sqlite);
            expect(command.prepared.deviceIdBefore).toBeNull(); expect(command.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            expect(command.prepared.effect.tasks.every((pair) => pair.after.revBy === command.prepared.deviceIdToInitialize)).toBe(true);
            expect(command.prepared.effect.createdTasks.every((row) => row.revBy === command.prepared.deviceIdToInitialize)).toBe(true);
            fault.commits = 10; expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); fault.commits = 0;
            vi.restoreAllMocks();
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated a UUID or device'); });
            value(await host.commitPreparedReferenceTasksMove(command)); vi.restoreAllMocks();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
            expect(value(methods().referenceTasksMoveOutcome(command))).toEqual({ count: 2, status: 'done' });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('gives cold own ACK precedence after rename/delete/restore, refuses unused equal target UUID and changed UUID payload', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const command = await prepare(host, request('waiting')); const unused = clone(command);
            unused.request.requestId = '00000000-0000-4000-8000-000000000194'; unused.prepared.request.requestId = unused.request.requestId;
            value(await host.commitPreparedReferenceTasksMove(command)); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().referenceTasksMoveOutcome(unused))).toBeNull();
            expect(await methods().commitPreparedReferenceTasksMove(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            await useTaskStore.getState().batchDeleteTasks(['a']); await flushPendingSave(); await useTaskStore.getState().restoreTask('a'); await flushPendingSave();
            await sqlite.client().run('UPDATE tasks SET title = ?, status = ?, rev = rev + 1 WHERE id = ?', ['Later task', 'reference', 'a']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'p1']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            const receipt = await sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY request_id');
            expect(value(methods().referenceTasksMoveOutcome(command))).toEqual({ count: 2, status: 'waiting' });
            expect(value(await methods().commitPreparedReferenceTasksMove(command))).toEqual({ count: 2, status: 'waiting' });
            const changed = clone(command); changed.request.taskIds.reverse(); changed.prepared.request.taskIds.reverse(); changed.prepared.recurrenceProjections.reverse();
            expect(value(methods().validatePreparedReferenceTasksMove(changed))).toEqual({ count: 2, status: 'waiting' });
            expect(await methods().commitPreparedReferenceTasksMove(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY request_id')).toEqual(receipt);
        } finally { await sqlite.close(); }
    });

    it('rejects stale selected/dependent rows, membership, filter settings and generated ID collisions before any write', async () => {
        clock(); const edits: Array<(sqlite: Sqlite, command: NativeReferenceTasksMoveEnvelope) => Promise<unknown>> = [
            (sqlite) => sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later task', 'a']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['sibling']),
            (sqlite) => sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Later parent', 'p1']),
            (sqlite) => sqlite.client().run('UPDATE sections SET title = ? WHERE id = ?', ['Later section', 's1']),
            (sqlite) => sqlite.client().run("UPDATE settings SET data = json_set(data, '$.filters', json('{\"areaId\":\"area\"}')) WHERE id = 1"),
            (sqlite) => sqlite.client().run("UPDATE settings SET data = json_set(data, '$.deviceId', 'later-device') WHERE id = 1"),
            (sqlite, command) => sqlite.client().run('UPDATE tasks SET id = ? WHERE id = ?', [command.prepared.allocatedIds[0], 'unrelated']),
        ];
        for (const edit of edits) {
            const sqlite = await openSqliteHost(seed());
            try {
                const command = await prepare(methods(), request('done')); await edit(sqlite, command);
                await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
                expect(await methods().commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } finally { await sqlite.close(); }
        }
    }, 30_000);

    it('uses the actual production BEGIN epoch fence for real second-connection writes after the final raw read', async () => {
        clock(); const mutations = [
            ['selected same rev', 'UPDATE tasks SET description = ? WHERE id = ?', ['Concurrent task', 'a']],
            ['new duplicate membership', 'UPDATE tasks SET projectId = ?, recurrence = ?, dueDate = ? WHERE id = ?', ['p2', JSON.stringify({ rule: 'daily', seriesId: 'series' }), '2026-10-06', 'unrelated']],
            ['settings', "UPDATE settings SET data = json_set(data, '$.theme', 'dark') WHERE id = 1", []],
            ['unrelated row', 'UPDATE tasks SET description = ? WHERE id = ?', ['Concurrent unrelated', 'unrelated']],
        ] as const;
        for (const [label, query, params] of mutations) {
            const race: { ready: boolean; mutate?: () => Promise<void> } = { ready: false };
            const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, args) => {
                if (sql === 'BEGIN IMMEDIATE' && race.ready) { race.ready = false; await race.mutate!(); }
                return client.run(sql, args);
            } }));
            const other = openScratchSqlite(join(sqlite.dir, 'mindwtr.db'));
            try {
                const host = methods(); const command = await prepare(host, request('done'));
                race.mutate = async () => { await other.client.run(query, [...params]); }; race.ready = true;
                expect(await host.commitPreparedReferenceTasksMove(command), label).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                const after = await raw(sqlite); expect(await sqlite.receiptIds()).toEqual([]);
                expect((after.tasks as { rows: Array<{ id: string; status: string }> }).rows.filter((row) => ['a', 'b'].includes(row.id)).every((row) => row.status === 'reference')).toBe(true);
                await sqlite.restart(undefined, { recoveryLoad: true });
                if (label === 'unrelated row' || label === 'settings') {
                    value(await methods().commitPreparedReferenceTasksMove(command));
                    const final = await raw(sqlite);
                    expect((final.tasks as { rows: Array<{ id: string }> }).rows.find((row) => row.id === 'unrelated')).toEqual((after.tasks as { rows: Array<{ id: string }> }).rows.find((row) => row.id === 'unrelated'));
                    expect(final.settings).toEqual(after.settings);
                } else {
                    expect(await methods().commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                    expect(await raw(sqlite)).toEqual(after);
                }
            } finally { other.close(); await sqlite.close(); }
        }
    }, 30_000);

    it('refuses an adapter switch during deferred module loading without changing memory or durable data', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        const adapter = getStorageAdapter();
        try {
            await canonical(); const command = await prepare();
            const read = value(await readAreaDurableData(false, true));
            const before = await raw(sqlite); const memory = useTaskStore.getState();
            const replacement = new NativeReceiptSqliteAdapter(sqlite.client(), { rejectConcurrentWrites: true });
            const committing = memory.commitPreparedReferenceTasksMove(command.prepared, read.authority);
            // The commit has yielded at import(), with no store or database changes.
            setStorageAdapter(replacement);
            expect(useTaskStore.getState()).toBe(memory);
            expect(await committing).toMatchObject({ success: false, reason: 'conflict' });
            await flushPendingSave();
            expect(useTaskStore.getState()).toBe(memory);
            expect(read.authority.saveBoundary).toBeUndefined();
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { setStorageAdapter(adapter); await flushPendingSave(); await sqlite.close(); }
    });

    it('fails closed on an unsupported unguarded SQLite adapter without changing old helper defaults', async () => {
        clock(); const sqlite = await openHost(seed());
        try { const before = await raw(sqlite); expect(await methods().prepareReferenceTasksMove(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('binds exact UTF8 NFD/NFC and protected task IDs while rejecting protected request property injection', async () => {
        clock(); const selected = ['é', 'e\u0301', 'constructor', '__proto__', 'prototype'];
        const sqlite = await openSqliteHost({ tasks: selected.map((id) => task(id)), settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try {
            const host = methods(); const command = await prepare(host, request('inbox', selected));
            expect(value(await host.commitPreparedReferenceTasksMove(command))).toEqual({ count: selected.length, status: 'inbox' });
            const forged = JSON.parse(JSON.stringify({ ...command.request, requestId: '00000000-0000-4000-8000-000000000195' }).replace('"params":{}', '"params":{"__proto__":{}}'));
            expect(await host.prepareReferenceTasksMove(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });

    it('refuses filtered, folded, missing, stale, deleted and archived-project read-only selection as a whole', async () => {
        clock(); const initial = seed(); initial.tasks!.push(task('deleted', { deletedAt: BEFORE }));
        const sqlite = await openSqliteHost(initial);
        try {
            const host = methods(); const input = request(); const before = await raw(sqlite);
            for (const invalid of [{ ...input, status: 'reference' }, { ...input, status: 'archived' }, { ...input, status: 'bad' },
                { ...input, taskIds: [] }, { ...input, taskIds: ['a', 'a'] }, { ...input, requestId: 'bad' },
                { ...input, taskIds: ['missing'], taskRevisions: { missing: 'revision' } }, request('next', ['deleted']),
                { ...input, taskRevisions: { ...input.taskRevisions, a: 'stale' } },
                { ...input, taskRevisions: { ...input.taskRevisions, extra: 'revision' } },
                { ...input, params: { filterEdit: { type: 'clear' } } },
                { ...input, params: { filters: { searchQuery: 'not present' } } },
                { ...input, params: { groupBy: 'project', collapsedGroupIds: ['project:p1'] } }])
                expect(await host.prepareReferenceTasksMove(invalid as never)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            for (const lifecycle of ['archive', 'cancel', 'delete'] as const) {
                await sqlite.client().run('UPDATE projects SET status = ?, cancelledAt = ?, deletedAt = ? WHERE id = ?',
                    [lifecycle === 'delete' ? 'active' : 'archived', lifecycle === 'cancel' ? NOW : null, lifecycle === 'delete' ? NOW : null, 'p1']);
                await sqlite.restart(undefined, { recoveryLoad: true }); const stable = await raw(sqlite);
                expect(await methods().prepareReferenceTasksMove(request('next', ['a'], REQUEST_ID, { includeArchivedProjects: true })))
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(stable);
            }
        } finally { await sqlite.close(); }
    });

    it('rejects altered effect, allocation, projection, result, time and deep/oversized envelopes before any SQL', async () => {
        clock(); const calls = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (sql, params) => { calls(sql); return client.all(sql, params); }, run: async (sql, params) => { calls(sql); return client.run(sql, params); },
            get: async (sql, params) => { calls(sql); return client.get(sql, params); }, exec: async (sql) => { calls(sql); return client.exec(sql); },
        }));
        try {
            const host = methods(); const command = await prepare(host, request('done'));
            for (const mutate of [
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.effect.tasks[0].after.description = 'Forged'; },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.allocatedIds[0] = '00000000-0000-4000-8000-000000000900'; },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.allocatedIds.push('00000000-0000-4000-8000-000000000999'); },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.recurrenceProjections[1].projection!.candidate.dueDate = '2040-01-01'; },
                (item: NativeReferenceTasksMoveEnvelope) => { Object.assign(item.prepared.recurrenceProjections[1].projection!, { extra: true }); },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.recurrenceProjections[1].projection!.sourceAnchorDays.dueDate = 32; },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.recurrenceProjections[1].projection!.candidate.dueDate = 'invalid'; },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.result.count = 3; },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.futureBoundary = NOW; },
                (item: NativeReferenceTasksMoveEnvelope) => { item.prepared.scope.tasks.push(task('extra')); },
            ]) {
                const invalid = clone(command); mutate(invalid); calls.mockClear();
                expect(host.validatePreparedReferenceTasksMove(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedReferenceTasksMove(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(calls).not.toHaveBeenCalled();
            }
            let deep: unknown = 'end'; for (let index = 0; index < 25; index++) deep = { nested: deep };
            calls.mockClear(); expect(await host.prepareReferenceTasksMove({ ...command.request, params: deep } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(calls).not.toHaveBeenCalled();
        } finally { await sqlite.close(); }
    });

    it('preserves unrelated raw NULL and legacy JSON member absence while matching actual RN selected output', async () => {
        clock(); const setup = async () => {
            const sqlite = await openSqliteHost(seed()); await canonical();
            await sqlite.client().run('UPDATE tasks SET tags = NULL, contexts = NULL, projectId = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            await sqlite.client().run('UPDATE projects SET tagIds = NULL, attachments = ? WHERE id = ?', [JSON.stringify([{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE }]), 'p2']);
            await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite;
        };
        const rn = await setup(); let expected;
        try { await useTaskStore.getState().batchMoveTasks(['a', 'b'], 'inbox'); await flushPendingSave(); expected = rows(); } finally { await rn.close(); }
        const sqlite = await setup();
        try {
            const host = methods(); const command = await prepare(host); const before = await raw(sqlite);
            expect(Object.hasOwn(command.prepared.scope.tasks.find((row) => row.id === 'a')!, 'tags')).toBe(false);
            expect(Object.hasOwn(command.prepared.scope.projects.find((row) => row.id === 'p2')!, 'tagIds')).toBe(false);
            expect(Object.hasOwn(command.prepared.scope.projects.find((row) => row.id === 'p2')!.attachments![0], 'updatedAt')).toBe(false);
            value(await host.commitPreparedReferenceTasksMove(command)); const after = await raw(sqlite);
            expect((after.tasks as { rows: Array<{ id: string }> }).rows.find((row) => row.id === 'unrelated')).toEqual((before.tasks as { rows: Array<{ id: string }> }).rows.find((row) => row.id === 'unrelated'));
            expect(after.projects).toEqual(before.projects); await sqlite.restart(undefined, { recoveryLoad: true }); expect(rows()).toEqual(expected);
        } finally { await sqlite.close(); }
    });

    it('fails malformed or unreadable raw authority closed without writes or receipts', async () => {
        clock(); for (const sql of ['UPDATE tasks SET recurrence = \'broken-json\' WHERE id = \'b\'',
            'UPDATE projects SET attachments = \'broken-json\' WHERE id = \'p1\'', 'UPDATE settings SET data = \'broken-json\' WHERE id = 1']) {
            const sqlite = await openSqliteHost(seed());
            try {
                const input = request();
                if (sql.includes('UPDATE tasks')) await sqlite.client().run('DROP TRIGGER tasks_validate_update');
                if (sql.includes('UPDATE projects')) await sqlite.client().run('DROP TRIGGER projects_validate_update');
                await sqlite.client().run(sql); const before = await raw(sqlite);
                expect(await methods().prepareReferenceTasksMove(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } finally { await sqlite.close(); }
        }
    });

    it('fails an actual durable read exception closed during prepare and commit without receipt or domain writes', async () => {
        clock(); const fault = { reads: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (sql, params) => { if (fault.reads && /\bFROM tasks\b/.test(sql)) throw new Error('Injected read failure'); return client.all(sql, params); },
        }));
        try {
            const host = methods(); const input = request(); const command = await prepare(host, input); const before = await raw(sqlite);
            fault.reads = true;
            expect(await host.prepareReferenceTasksMove(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.reads = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.reads = false; await sqlite.close(); }
    });

    it('records actual RN invalid-FK failure and refuses invalid empty-project peer authority before preparing a native journal', async () => {
        // React Native's adapter (no concurrent-write guard) rewrites every row on its first save, so the invalid peer fails it.
        // The guarded native adapter compares with its full read and writes only what changed; its own refusal is checked below.
        clock(); const setup = async (open: typeof openHost = openSqliteHost) => {
            const sqlite = await open({ tasks: [task('source', { title: 'Shared source', recurrence: { rule: 'daily', seriesId: 'projectless' }, dueDate: '2026-10-03' }),
                task('empty-peer', { title: 'Shared source', recurrence: { rule: 'daily', seriesId: 'projectless' }, dueDate: '2026-10-04' }),
                task('null-peer', { title: 'Other peer' })], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
            await canonical(); await sqlite.client().run('PRAGMA foreign_keys = OFF');
            await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'empty-peer']);
            await sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['null-peer']);
            await sqlite.client().run('PRAGMA foreign_keys = ON'); await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite;
        };
        const rn = await setup(openHost); let expected;
        try { const generated = ids(); expect(await useTaskStore.getState().batchMoveTasks(['source'], 'done')).toEqual({ success: true });
            expected = rows(); expect(generated).toHaveBeenCalledTimes(1); expect(expected.tasks).toHaveLength(3);
            expect(expected.tasks.find((row) => row.id === 'source')?.status).toBe('done');
            await expect(flushPendingSave()).rejects.toThrow('FOREIGN KEY constraint failed');
            expect(useTaskStore.getState().persistenceFailure).not.toBeNull(); generated.mockRestore();
        } finally { resetForTests(); await rn.close(); }
        const sqlite = await setup();
        try {
            const generated = ids(); const host = methods(); const before = await raw(sqlite);
            expect(await host.prepareReferenceTasksMove(request('done', ['source']))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(generated).not.toHaveBeenCalled(); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    }, 30_000);

    it('refuses a later invalid FK before applying an unacknowledged envelope, but gives its own cold ACK precedence', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        const corrupt = async () => {
            await sqlite.client().run('PRAGMA foreign_keys = OFF');
            await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'unrelated']);
            await sqlite.client().run('PRAGMA foreign_keys = ON'); await sqlite.restart(undefined, { recoveryLoad: true });
        };
        try {
            const command = clone(await prepare()); await corrupt(); const before = await raw(sqlite);
            expect(await methods().commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['unrelated']); await sqlite.restart(undefined, { recoveryLoad: true });
            value(await methods().commitPreparedReferenceTasksMove(command)); await corrupt(); const after = await raw(sqlite);
            expect(value(methods().referenceTasksMoveOutcome(command))).toEqual({ count: 2, status: 'inbox' });
            expect(value(await methods().commitPreparedReferenceTasksMove(command))).toEqual({ count: 2, status: 'inbox' });
            expect(await raw(sqlite)).toEqual(after); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    }, 30_000);

    it('fails a foreign-key authority probe exception closed before prepare or commit writes', async () => {
        clock(); const fault = { probe: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            get: async (sql, params) => { if (fault.probe && sql.includes('pragma_foreign_key_check')) throw new Error('Injected probe failure'); return client.get(sql, params); },
        }));
        try {
            const host = methods(); const input = request(); const command = await prepare(host, input); const before = await raw(sqlite);
            fault.probe = true;
            expect(await host.prepareReferenceTasksMove(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.probe = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.probe = false; await sqlite.close(); }
    });

    it('cold replays frozen recurrence and UNTIL across actual New York to Tokyo timezone and clock changes', async () => {
        process.env.TZ = 'America/New_York'; clock(); vi.setSystemTime(new Date('2026-03-07T17:00:00.000Z'));
        expect(new Date('2026-03-07T17:00:00.000Z').getTimezoneOffset()).toBe(300);
        const initial: Partial<AppData> = { tasks: [task('source', { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict', until: '2026-03-15T20:00:00.000Z' },
            startTime: '2026-03-06T15:00:00.000Z', dueDate: '2026-03-07T15:00:00.000Z', relativeStartOffset: { amount: -1, unit: 'day' } })],
            settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } };
        const sqlite = await openSqliteHost(initial);
        try {
            const command = clone(await prepare(methods(), request('done', ['source'])));
            expect(command.prepared.recurrenceProjections[0].projection?.candidate.dueDate).toBe('2026-03-08T14:00:00.000Z');
            process.env.TZ = 'Asia/Tokyo'; vi.setSystemTime(new Date('2028-03-15T23:15:00.000Z'));
            expect(new Date('2026-03-07T17:00:00.000Z').getTimezoneOffset()).toBe(-540);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await methods().commitPreparedReferenceTasksMove(command))).toEqual({ count: 1, status: 'done' });
            expect(rows().tasks.find((row) => row.id === command.prepared.effect.createdTasks[0].id)).toEqual(command.prepared.effect.createdTasks[0]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().referenceTasksMoveOutcome(command))).toEqual({ count: 1, status: 'done' });
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('retries the original envelope with untouched blank legacy Area timestamps through %s recovery', async (recovery) => {
        clock(); const initial = seed(); initial.projects![0].areaId = 'area';
        const fault = { commits: 0 }; const sqlite = await openSqliteHost(initial, (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected failure'); } return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run("UPDATE areas SET createdAt = '', updatedAt = '', color = '', icon = NULL, rev = NULL, revBy = '', orderNum = 17 WHERE id = ?", ['area']);
            await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const command = clone(await prepare(host));
            expect(command.prepared.scope.areas.map((row) => row.id)).toEqual(['area']);
            const before = await raw(sqlite); fault.commits = 10;
            expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); fault.commits = 0;
            vi.setSystemTime(new Date('2026-10-03T14:00:00.000Z'));
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            expect(value(await host.commitPreparedReferenceTasksMove(command))).toEqual({ count: 2, status: 'inbox' });
            expect((await raw(sqlite)).areas).toEqual(before.areas);
            vi.setSystemTime(new Date('2027-10-03T15:00:00.000Z')); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().referenceTasksMoveOutcome(command))).toEqual({ count: 2, status: 'inbox' });
            expect((await raw(sqlite)).areas).toEqual(before.areas); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('rejects a real legacy Area timestamp edit while preserving every durable cell and no receipt', async () => {
        clock(); const initial = seed(); initial.projects![0].areaId = 'area'; const sqlite = await openSqliteHost(initial);
        try {
            await sqlite.client().run("UPDATE areas SET createdAt = '', updatedAt = '' WHERE id = ?", ['area']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const command = clone(await prepare());
            expect(command.prepared.scope.areas.map((row) => row.id)).toEqual(['area']);
            await sqlite.client().run('UPDATE areas SET createdAt = ?, updatedAt = ? WHERE id = ?', [NOW, NOW, 'area']);
            vi.setSystemTime(new Date('2026-10-03T14:00:00.000Z')); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('never adopts an unrelated later failed save generation as ownership of the original envelope', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected failure'); } return client.run(sql, params); },
        }));
        try {
            const host = methods(); const command = await prepare(host, request('done')); fault.commits = 10;
            expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const before = await raw(sqlite);
            await useTaskStore.getState().updateTask('unrelated', { description: 'Later unrelated writer' });
            fault.commits = 10; await expect(flushPendingSave()).rejects.toThrow('Injected failure');
            expect(await host.commitPreparedReferenceTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
    }, 30_000);

    it('accepts 140 exact revisions, but refuses byte-oversized selected scope and preparation ID collision', async () => {
        clock(); const selected = Array.from({ length: 140 }, (_, index) => task(`selected-${index}`));
        const sqlite = await openSqliteHost({ tasks: selected, settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try { const host = methods(); value(await host.commitPreparedReferenceTasksMove(await prepare(host, request('waiting', selected.map((row) => row.id))))); }
        finally { await sqlite.close(); }
        const huge = await openSqliteHost({ tasks: [task('a', { description: '界'.repeat(700_000) })], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try { const before = await raw(huge); expect(await methods().prepareReferenceTasksMove(request('inbox', ['a'])))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(huge)).toEqual(before); expect(await huge.receiptIds()).toEqual([]);
        } finally { await huge.close(); }
        const collision = await openSqliteHost({ tasks: [task('a', { recurrence: { rule: 'daily' } }), task('00000000-0000-4000-8000-000000000901')], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try { ids(); const before = await raw(collision); expect(await methods().prepareReferenceTasksMove(request('done', ['a'])))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(await raw(collision)).toEqual(before);
        } finally { await collision.close(); }
    }, 30_000);

});
