import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const ID = 'reference-next-task';
const UUID = '00000000-0000-4000-8000-000000000187';
const OTHER = '00000000-0000-4000-8000-000000000188';
const clone = <T,>(item: T): T => JSON.parse(JSON.stringify(item)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: '  Reference memo  ', status: 'reference', description: 'Keep every memo byte',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    rev: 3, revBy: 'device-a', tags: ['#first', '#second'], contexts: ['@home'],
    projectId: 'parent', sectionId: 'section', boardOrder: 7, order: 2, orderNum: 2,
    checklist: [{ id: 'repeat', title: 'Keep item', isCompleted: true },
        { id: 'repeat', title: '  ', isCompleted: false }],
    attachments: [{ id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///owned/proof.txt',
        createdAt: NOW, updatedAt: NOW }], ...patch,
});
const project = (patch: Partial<Project> = {}): Project => ({
    id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [],
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    rev: 2, revBy: 'device-a', ...patch,
});
const seed = (source = task(), count = 0, limit = 3): Partial<AppData> => ({
    tasks: [source, ...Array.from({ length: count }, (_, index) => task({ id: `peer-${index}`, title: 'Peer',
        status: 'next', isFocusedToday: true, focusOrder: index, checklist: [], attachments: [] }))],
    projects: [project()], sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0,
        createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: OTHER, gtd: { focusTaskLimit: limit } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, {
    schema: await sqlite.sql(`PRAGMA table_info(${table})`),
    rows: await sqlite.sql(`SELECT rowid AS evidenceRowid, * FROM ${table} ORDER BY rowid`),
}])));
const receipts = async (sqlite: Sqlite) => ({ schema: await sqlite.sql('PRAGMA table_info(native_request_receipts)'),
    rows: await sqlite.sql('SELECT rowid AS evidenceRowid, * FROM native_request_receipts ORDER BY rowid') });
const rows = () => {
    const state = useTaskStore.getState();
    return clone({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, people: state._allPeople, settings: state.settings });
};
const request = () => ({ id: ID, requestId: UUID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!),
    status: 'next' as const, source: 'reference' as const });
const prepare = async (sqlite: Sqlite, input = request()) => {
    const prepared = value(await sqlite.host.prepareDoneTaskStatus(input));
    if (prepared.kind !== 'prepared') throw new Error('Reference Next must prepare a write');
    if (prepared.prepared.kind !== 'referenceNext') throw new Error('Reference Next must use the source-bound V2 kind');
    return { request: input, prepared: prepared.prepared };
};
const editSettings = async (sqlite: Sqlite, change: (settings: AppData['settings']) => void) => {
    const [stored] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id = 1');
    const settings = JSON.parse(stored.data) as AppData['settings']; change(settings);
    await sqlite.client().run('UPDATE settings SET data = ? WHERE id = 1', [JSON.stringify(settings)]);
};

afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Reference leading Next is the source-bound RN status-only update', () => {
    it.each([
        ['ordinary rich memo', task()],
        ['recurring', task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID },
            dueDate: '2026-10-01', showFutureRecurrence: true, timeSpentMinutes: 45 })],
        ['hidden star', task({ isFocusedToday: true, focusOrder: 2, startTime: '2026-10-03' })],
        ['future start', task({ isFocusedToday: true, focusOrder: 2, startTime: '2026-10-05T15:00:00.000Z',
            dueDate: '2026-10-05T17:00:00.000Z' })],
    ])('matches actual RN updateTask full state and all-nine raw schema/rowid/content: %s', async (_name, source) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed(source));
        let expected: ReturnType<typeof rows>; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            expect(await useTaskStore.getState().updateTask(ID, { status: 'next' })).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source));
        try {
            const command = await prepare(native);
            expect(command.prepared).toMatchObject({ version: 2, kind: 'referenceNext', result: { id: ID } });
            expect(value(native.host.validatePreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(value(await native.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(rows().tasks).toHaveLength(1);
            expect(rows().tasks[0].checklist).toEqual(source.checklist);
            expect((await receipts(native)).rows).toHaveLength(1);
        } finally { await native.close(); }
    });

    it('turns a Reference list with every entry ticked into Next, not Done, and keeps the ticks (#1416)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const ticked = [{ id: 'one', title: 'Alien', isCompleted: true }, { id: 'two', title: 'Brazil', isCompleted: true }];
        const source = task({ taskMode: 'list', checklist: ticked });
        const rn = await openSqliteHost(seed(source));
        try {
            expect(await useTaskStore.getState().updateTask(ID, { status: 'next' })).toEqual({ success: true });
            const moved = useTaskStore.getState()._tasksById.get(ID)!;
            expect(moved).toMatchObject({ status: 'next', checklist: ticked });
            expect(moved.completedAt).toBeUndefined();
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source));
        try {
            const command = await prepare(native);
            expect(value(await native.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            const moved = useTaskStore.getState()._tasksById.get(ID)!;
            expect(moved).toMatchObject({ status: 'next', checklist: ticked });
            expect(moved.completedAt).toBeUndefined();
        } finally { await native.close(); }
    });

    it('refuses the RN hidden-star slot fill at the full Focus limit without a write or receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true }), 1, 1));
        try {
            const before = await raw(sqlite); const beforeReceipts = await receipts(sqlite);
            expect(await useTaskStore.getState().updateTask(ID, { status: 'next' })).toMatchObject({ success: false });
            expect(await sqlite.host.prepareDoneTaskStatus(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(beforeReceipts);
        } finally { await sqlite.close(); }
    });

    it('binds indirect Focus count and limit then refuses a newly occupied slot', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true }), 1, 2));
        try {
            const command = await prepare(sqlite);
            expect(command.prepared.checklist.effect.guards).toMatchObject({ focusCount: 1, focusLimit: 2 });
            expect(command.prepared.checklist.effect.guards.focusBoundary).not.toBeNull();
            await useTaskStore.getState().addTask('New occupied slot', { status: 'next', isFocusedToday: true });
            await flushPendingSave();
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rechecks Focus count on the exact same-host failed-save retry and preserves raw siblings', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        let fail = false;
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true }), 1, 3), (client) => ({ ...client,
            run: async (sql, args) => { if (fail && sql === 'COMMIT') throw new Error('injected commit failure'); return client.run(sql, args); } }));
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['peer-0']);
            await sqlite.restart();
            const command = await prepare(sqlite); const encoded = JSON.stringify(command);
            const before = await raw(sqlite);
            fail = true;
            for (let i = 0; i < 2; i++) {
                expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            }
            fail = false;
            await sqlite.client().run('UPDATE tasks SET isFocusedToday = 0 WHERE id = ?', ['peer-0']);
            const concurrent = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(concurrent); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET isFocusedToday = 1 WHERE id = ?', ['peer-0']);
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(JSON.stringify(command)).toBe(encoded);
            expect(await sqlite.sql('SELECT pushCount FROM tasks WHERE id = ?', ['peer-0'])).toEqual([{ pushCount: null }]);
            const saved = await receipts(sqlite);
            expect(saved.rows).toHaveLength(1);
            expect(saved.rows[0]).toMatchObject({ request_id: UUID });
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await receipts(sqlite)).toEqual(saved);
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
        } finally { fail = false; await sqlite.close(); }
    }, 25_000);

    it('refuses malformed source/target and pure forged journals without SQL, including generic checklist laundering', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const calls: string[] = [];
        const sqlite = await openSqliteHost(seed(), (client) => new Proxy(client, { get(target, property) {
            const method = Reflect.get(target, property);
            return typeof method === 'function' ? (...args: unknown[]) => { calls.push(String(args[0])); return method(...args); } : method;
        } }));
        try {
            const displayed = request(); const command = await prepare(sqlite); calls.length = 0;
            for (const input of [{ ...displayed, source: null }, { ...displayed, source: 'done' },
                { ...displayed, source: undefined }, { ...displayed, status: 'done' }, { ...displayed, extra: true }]) {
                expect(await sqlite.host.prepareDoneTaskStatus(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            const forgeries = [
                (item: typeof command) => { item.prepared.version = 1 as never; },
                (item: typeof command) => { item.prepared.kind = 'doneStatus'; },
                (item: typeof command) => { item.prepared.checklist.witness.direct.description = 'Unrequested'; },
                (item: typeof command) => { item.prepared.checklist.effect.tasks[0].after.title = 'Forged'; },
                (item: typeof command) => { item.prepared.checklist.effect.guards.focusCount = 0; },
                (item: typeof command) => { item.prepared.result.id = 'different'; },
            ];
            for (const mutate of forgeries) {
                const forged = clone(command); mutate(forged);
                expect(sqlite.host.validatePreparedDoneTaskStatus(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedDoneTaskStatus(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            const inner = { request: command.prepared.checklist.request, prepared: command.prepared.checklist };
            expect(sqlite.host.prepareTaskChecklistSave(inner.request as never)).toMatchObject({ ok: false });
            expect(sqlite.host.validatePreparedTaskChecklistWrite(inner)).toMatchObject({ ok: false });
            expect(await sqlite.host.commitPreparedTaskChecklistWrite(inner)).toMatchObject({ ok: false });
            expect(calls).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['done', 'next', 'archived', 'deleted', 'purged', 'stale', 'projected'] as const)('refuses the displayed %s source without mutation', async (unavailable) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const source = task(unavailable === 'deleted' ? { deletedAt: NOW } : unavailable === 'purged' ? { purgedAt: NOW }
            : ['done', 'next', 'archived'].includes(unavailable) ? { status: unavailable as Task['status'] } : {});
        const sqlite = await openSqliteHost(seed(source));
        try {
            const before = await raw(sqlite);
            const input = { ...request(), ...(unavailable === 'stale' ? { taskRevision: 'stale' }
                : unavailable === 'projected' ? { id: `${ID}:projected-recurrence` } : {}) };
            expect(await sqlite.host.prepareDoneTaskStatus(input)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['archived', 'deleted', 'purged'] as const)('refuses %s parent at preparation and after a frozen preparation', async (lifecycle) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const displayed = request(); const command = await prepare(sqlite);
            if (lifecycle === 'archived') await sqlite.client().run('UPDATE projects SET status = ?, archivedAt = ? WHERE id = ?', ['archived', NOW, 'parent']);
            else await sqlite.client().run(`UPDATE projects SET ${lifecycle === 'purged' ? 'purgedAt' : 'deletedAt'} = ? WHERE id = ?`, [NOW, 'parent']);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.prepareDoneTaskStatus(displayed)).toMatchObject({ ok: false });
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['limit', 'device', 'section', 'area'] as const)('refuses a relevant %s change after preparation', async (changed) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const source = task({ isFocusedToday: true, projectId: changed === 'area' ? undefined : 'parent',
            sectionId: changed === 'area' ? undefined : 'section', areaId: changed === 'area' ? 'area' : undefined });
        const sqlite = await openSqliteHost(seed(source, 1, 3));
        try {
            const command = await prepare(sqlite);
            if (changed === 'limit') await editSettings(sqlite, (settings) => { settings.gtd = { ...settings.gtd, focusTaskLimit: 2 }; });
            else if (changed === 'device') await editSettings(sqlite, (settings) => { settings.deviceId = 'other-device'; });
            else await sqlite.client().run(`UPDATE ${changed === 'section' ? 'sections' : 'areas'} SET deletedAt = ? WHERE id = ?`, [NOW, changed]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('matches RN settings while preserving unrelated settings and a limit change when conversion fills no slot', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const changeSettings = (settings: AppData['settings']) => {
            settings.theme = 'dark'; settings.gtd = { ...settings.gtd, focusTaskLimit: 1, autoArchiveDays: 1 };
        };
        const rn = await openSqliteHost(seed()); let expectedSettings: ReturnType<typeof rows>['settings'];
        try {
            await editSettings(rn, changeSettings); await rn.restart(undefined, { recoveryLoad: true });
            const before = rows().settings;
            expect(await useTaskStore.getState().updateTask(ID, { status: 'next' })).toEqual({ success: true });
            await flushPendingSave(); expectedSettings = rows().settings;
            // A status-only write leaves every token in use, so RN writes no settings (#828).
            expect(expectedSettings).toEqual(before);
            expect(expectedSettings).toMatchObject({ theme: 'dark', gtd: { focusTaskLimit: 1, autoArchiveDays: 1 } });
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite);
            expect(command.prepared.checklist.effect.guards).toMatchObject({ focusCount: null, focusLimit: null, focusBoundary: null, autoArchiveDays: null });
            await editSettings(sqlite, changeSettings);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(rows().settings).toEqual(expectedSettings!);
        } finally { await sqlite.close(); }
    });

    it('keeps exact saved UUID/payload receipts before later edits, but refuses an unused UUID at equal AFTER', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite); const alternate = clone(command);
            alternate.request.requestId = OTHER; alternate.prepared.request.requestId = OTHER; alternate.prepared.checklist.request.requestId = OTHER;
            expect(value(sqlite.host.validatePreparedDoneTaskStatus(alternate))).toEqual({ id: ID });
            value(await sqlite.host.commitPreparedDoneTaskStatus(command));
            const savedReceipts = await receipts(sqlite);
            expect(savedReceipts.rows[0]).toMatchObject({ request_id: UUID, method: expect.stringMatching(/^referenceTaskNext:/) });
            await sqlite.restart(undefined, { recoveryLoad: true }); const equalAfter = await raw(sqlite);
            expect(value(sqlite.host.doneTaskStatusOutcome(alternate))).toBeNull();
            expect(await sqlite.host.commitPreparedDoneTaskStatus(alternate)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(equalAfter); expect(await receipts(sqlite)).toEqual(savedReceipts);
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?', ['Later source edit', ID]);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'parent']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const later = await raw(sqlite);
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(later); expect(await receipts(sqlite)).toEqual(savedReceipts);
        } finally { await sqlite.close(); }
    });

    it('makes no receipt on a prewrite read failure then writes only on the successful exact retry', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        let fail = false;
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (sql, args) => {
            if (fail && /FROM tasks/i.test(sql)) throw new Error('injected raw read failure'); return client.all(sql, args);
        } }));
        try {
            const command = await prepare(sqlite); const before = await raw(sqlite);
            fail = true; expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fail = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toBeNull();
            value(await sqlite.host.commitPreparedDoneTaskStatus(command)); expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fail = false; await sqlite.close(); }
    });

    it('cold replays the frozen raw source after two COMMIT failures with exact all-nine RN parity and receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = seed(task({ isFocusedToday: true }), 1, 3);
        const legacy = async (sqlite: Sqlite) => {
            const attachment = { id: 'raw-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW };
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL, attachments = ? WHERE id = ?', [JSON.stringify([attachment]), ID]);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['peer-0']); await sqlite.restart();
        };
        const rn = await openSqliteHost(initial); let expected: Awaited<ReturnType<typeof raw>>;
        try { await legacy(rn); expect((await useTaskStore.getState().updateTask(ID, { status: 'next' })).success).toBe(true); await flushPendingSave(); expected = await raw(rn); }
        finally { await rn.close(); }
        let fail = false;
        const sqlite = await openSqliteHost(initial, (client) => ({ ...client, run: async (sql, args) => {
            if (fail && sql === 'COMMIT') throw new Error('injected COMMIT failure'); return client.run(sql, args);
        } }));
        try {
            await legacy(sqlite); const command = await prepare(sqlite); const encoded = JSON.stringify(command);
            const before = await raw(sqlite); fail = true;
            for (let i = 0; i < 2; i++) {
                expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            }
            fail = false; await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(ID)?.pushCount).toBeUndefined();
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toBeNull(); value(await sqlite.host.commitPreparedDoneTaskStatus(command));
            expect(JSON.stringify(command)).toBe(encoded); expect(await raw(sqlite)).toEqual(expected!);
            const saved = await receipts(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await receipts(sqlite)).toEqual(saved); expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
        } finally { fail = false; await sqlite.close(); }
    }, 25_000);

    it('initializes a missing saved device once through failed save and true cold recovery', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let fail = false;
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, args) => {
            if (fail && sql === 'COMMIT') throw new Error('injected COMMIT failure'); return client.run(sql, args);
        } }));
        try {
            await useTaskStore.getState().persistSnapshot(); await flushPendingSave();
            await editSettings(sqlite, (settings) => { delete settings.deviceId; }); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined(); const command = await prepare(sqlite);
            const effect = command.prepared.checklist.effect; expect(effect.deviceIdBefore).toBeNull();
            expect(effect.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/); const before = await raw(sqlite);
            fail = true; expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            fail = false; await sqlite.restart(undefined, { recoveryLoad: true }); value(await sqlite.host.commitPreparedDoneTaskStatus(command));
            expect(useTaskStore.getState().settings.deviceId).toBe(effect.deviceIdToInitialize);
            expect(useTaskStore.getState()._tasksById.get(ID)?.revBy).toBe(effect.deviceIdToInitialize);
            const saved = await receipts(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(useTaskStore.getState().settings.deviceId).toBe(effect.deviceIdToInitialize); expect(await receipts(sqlite)).toEqual(saved);
        } finally { fail = false; await sqlite.close(); }
    }, 25_000);

    it('updates one saved task appearing in multiple filtered tag groups without losing folds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const params = { offset: 0, limit: 100, groupBy: 'tag' as const, filters: { searchQuery: 'Reference memo' } };
            const shown = value(sqlite.host.getReferenceView(params)); const visible = shown.items.filter((item) => item.type === 'task');
            expect(visible).toHaveLength(2); const folded = { ...params, collapsedGroupIds: [visible[1].groupId] };
            expect(value(sqlite.host.getReferenceView(folded)).items.filter((item) => item.type === 'task')).toHaveLength(1);
            const command = await prepare(sqlite, { ...request(), taskRevision: visible[0].row.taskRevision });
            value(await sqlite.host.commitPreparedDoneTaskStatus(command));
            const refreshed = value(sqlite.host.getReferenceView(folded)); expect(refreshed.collapsedGroupIds).toEqual(folded.collapsedGroupIds);
            expect(refreshed.items.filter((item) => item.type === 'task')).toHaveLength(0);
            expect(value(sqlite.host.getReferenceView(params)).items.filter((item) => item.type === 'task')).toHaveLength(0);
            expect(await sqlite.receiptIds()).toEqual([UUID]); expect(rows().tasks.filter((row) => row.id === ID)).toHaveLength(1);
        } finally { await sqlite.close(); }
    });

    it.each([
        ['focusOrder', 2, 3], ['pushCount', 2, 3], ['pushCount', 2, 1],
    ] as const)('refuses an independent raw %s change from %s to %s without borrowing loaded equality', async (field, initial, changed) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true, focusOrder: 2, pushCount: 2 })));
        try {
            await sqlite.client().run(`UPDATE tasks SET ${field} = ? WHERE id = ?`, [initial, ID]);
            await sqlite.restart(); const command = await prepare(sqlite);
            expect(command.prepared.rawBefore[field]).toBe(initial);
            await sqlite.client().run(`UPDATE tasks SET ${field} = ? WHERE id = ?`, [changed, ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rechecks a changed Focus limit on an owned exact retry before saving the raw effect', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); let fail = false;
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true }), 1, 3), (client) => ({ ...client,
            run: async (sql, args) => { if (fail && sql === 'COMMIT') throw new Error('injected COMMIT failure'); return client.run(sql, args); } }));
        try {
            const command = await prepare(sqlite); fail = true;
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fail = false; await editSettings(sqlite, (settings) => { settings.gtd = { ...settings.gtd, focusTaskLimit: 2 }; });
            const conflict = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(conflict); expect(await sqlite.receiptIds()).toEqual([]);
            await editSettings(sqlite, (settings) => { settings.gtd = { ...settings.gtd, focusTaskLimit: 3 }; });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fail = false; await sqlite.close(); }
    });

    it('retains the frozen full-state future boundary across a delayed cold commit', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = seed(task({ isFocusedToday: true }), 1, 1);
        initial.tasks![1].startTime = '2026-10-04';
        const rn = await openSqliteHost(initial); let expected: Awaited<ReturnType<typeof raw>>;
        try { expect(await useTaskStore.getState().updateTask(ID, { status: 'next' })).toEqual({ success: true });
            await flushPendingSave(); expected = await raw(rn); } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            const command = await prepare(sqlite); const guards = command.prepared.checklist.effect.guards;
            expect(guards.focusCount).toBe(0); expect(guards.focusLimit).toBe(1);
            expect(guards.focusBoundary).toBe(command.prepared.checklist.witness.futureBoundary);
            vi.setSystemTime(new Date('2026-10-05T13:00:00.000Z'));
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(expected!); expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { await sqlite.close(); }
    });

    it('cannot use a Done receipt with the same UUID to acknowledge the Reference command', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ status: 'done', completedAt: NOW })));
        try {
            const old = { id: ID, requestId: UUID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!), status: 'next' as const };
            const prepared = value(await sqlite.host.prepareDoneTaskStatus(old));
            if (prepared.kind !== 'prepared') throw new Error('Done outbound fixture must prepare');
            value(await sqlite.host.commitPreparedDoneTaskStatus({ request: old, prepared: prepared.prepared }));
            const originalReceipt = await receipts(sqlite);
            expect(await useTaskStore.getState().updateTask(ID, { status: 'reference' })).toEqual({ success: true });
            await flushPendingSave(); const reference = await prepare(sqlite); const before = await raw(sqlite);
            expect(sqlite.host.doneTaskStatusOutcome(reference)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.commitPreparedDoneTaskStatus(reference)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(originalReceipt);
        } finally { await sqlite.close(); }
    });

    it('refuses a warm displayed witness after an unrevisioned raw edit and prepares only after a fresh normal load', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true })));
        try {
            const displayed = request();
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', [ID]);
            const before = await raw(sqlite);
            expect(await sqlite.host.prepareDoneTaskStatus(displayed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.restart(); const command = await prepare(sqlite);
            expect(command.prepared.rawBefore.focusOrder).toBe(2);
            expect(command.prepared.checklist.witness.source.focusOrder).toBe(2);
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { await sqlite.close(); }
    });

    it('replays a Swift-sorted frozen journal with complete RN content parity and explicit JSON encoding deltas', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = seed(task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, showFutureRecurrence: true }));
        const rn = await openSqliteHost(initial); let expected: Awaited<ReturnType<typeof raw>>; let expectedData: ReturnType<typeof rows>;
        try { expect(await useTaskStore.getState().updateTask(ID, { status: 'next' })).toEqual({ success: true });
            await flushPendingSave(); expected = await raw(rn); expectedData = rows(); } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            const command = JSON.parse(JSON.stringify(await prepare(sqlite), (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item));
            expect(value(sqlite.host.validatePreparedDoneTaskStatus(command))).toEqual({ id: ID });
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            const actual = await raw(sqlite); expect(rows()).toEqual(expectedData!);
            const jsonColumns = new Set(['data', 'tags', 'contexts', 'checklist', 'recurrence', 'attachments', 'tagIds', 'viewSectionIds']);
            const decode = (snapshot: typeof actual) => Object.fromEntries(Object.entries(snapshot).map(([table, entry]) => [table,
                { schema: entry.schema, rows: entry.rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, item]) =>
                    [column, jsonColumns.has(column) && typeof item === 'string' ? JSON.parse(item) : item]))) }]));
            expect(decode(actual)).toEqual(decode(expected!));
            const encodingPaths: string[] = [];
            for (const table of tables) for (let i = 0; i < actual[table].rows.length; i++) {
                for (const [column, item] of Object.entries(actual[table].rows[i])) {
                    const rnItem = expected![table].rows[i][column];
                    if (item === rnItem) continue;
                    expect(table).toBe('tasks'); expect(actual[table].rows[i].id).toBe(ID);
                    expect(['checklist', 'recurrence', 'attachments']).toContain(column);
                    expect(typeof item).toBe('string'); expect(typeof rnItem).toBe('string');
                    expect(JSON.parse(item as string)).toEqual(JSON.parse(rnItem as string));
                    encodingPaths.push(`${table}.${column}`);
                }
            }
            console.info('Task187 sorted journal JSON encoding deltas', JSON.stringify(encodingPaths.sort()));
            const saved = await receipts(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await receipts(sqlite)).toEqual(saved); expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
        } finally { await sqlite.close(); }
    });
});
