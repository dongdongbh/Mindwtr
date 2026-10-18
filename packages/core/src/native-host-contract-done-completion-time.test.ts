import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import type { AppData, Project, Task } from './types';

const NOW = '2026-10-02T13:00:00.000Z';
const INITIAL = '2026-10-01T12:34:56.789Z';
const ID = 'done-completion-task';
const REQUEST_ID = '00000000-0000-4000-8000-000000000178';
const clone = <T,>(data: T): T => JSON.parse(JSON.stringify(data)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const source = (overrides: Partial<Task> = {}): Task => ({ id: ID, title: '  Keep completion  ', status: 'done',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
    completedAt: INITIAL, rev: 3, revBy: 'device-a', contexts: ['home'], tags: ['tag'],
    projectId: 'parent', sectionId: 'section', description: 'Keep every byte', order: 2, orderNum: 2,
    ...overrides });
const parent = (overrides: Partial<Project> = {}): Project => ({ id: 'parent', title: 'Parent', status: 'active',
    color: '#94a3b8', order: 0, tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a', ...overrides });
const seed = (task = source(), autoArchiveDays = 0, project = parent()): Partial<AppData> => ({
    tasks: [task, source({ id: 'sibling', title: 'Sibling', status: 'next', completedAt: undefined, order: 4, orderNum: 4 })],
    projects: [project], sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: '00000000-0000-4000-8000-000000000179', gtd: { autoArchiveDays } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => { await getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState())); };
const request = (completedAt = INITIAL) => ({ id: ID, requestId: REQUEST_ID, completedAt,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const prepare = async (sqlite: Sqlite, input = request()) => {
    const plan = value(await sqlite.host.prepareDoneTaskCompletedAt(input));
    if (plan.kind !== 'prepared') throw new Error('Expected completion time preparation');
    return { request: input, prepared: plan.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Done row completion time uses RN completedAt-only update and guarded receipts', () => {
    it('proves RN same instant is a real write and preserves seconds/milliseconds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const before = await raw(sqlite);
            const task = useTaskStore.getState()._tasksById.get(ID)!;
            expect((await useTaskStore.getState().updateTask(ID, { completedAt: INITIAL })).success).toBe(true);
            await flushPendingSave();
            const after = useTaskStore.getState()._tasksById.get(ID)!;
            expect(after.completedAt).toBe(INITIAL);
            expect(after.rev).toBe((task.rev ?? 0) + 1);
            expect(after.updatedAt).toBe(NOW);
            expect(await raw(sqlite)).not.toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('prepares the exact same instant rather than silently skipping RN metadata write', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite);
            expect(command.prepared.version).toBe(2);
            expect(command.prepared.kind).toBe('doneCompletedAt');
            expect(command.prepared.checklist.witness.direct).toEqual({ completedAt: INITIAL });
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
            expect(useTaskStore.getState()._tasksById.get(ID)?.completedAt).toBe(INITIAL);
            expect(useTaskStore.getState()._tasksById.get(ID)?.rev).toBe(4);
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });

    it.each([
        ['ordinary', source()],
        ['recurring', source({ recurrence: { rule: 'daily', strategy: 'strict', seriesId: ID }, showFutureRecurrence: true })],
        ['rich', source({ startTime: '2026-10-04T15:00:00.000Z', dueDate: '2026-10-04T17:00:00.000Z',
            relativeStartOffset: { amount: 2, unit: 'hour' }, reviewAt: '2026-10-05',
            assignedTo: 'person', priority: 'high', energyLevel: 'high', timeEstimate: '30min', timeSpentMinutes: 45,
            checklist: [{ id: 'step', title: '  Keep step  ', isCompleted: true }],
            attachments: [{ id: 'attachment', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW, updatedAt: NOW }],
            recurrence: { rule: 'weekly', strategy: 'after-completion', seriesId: ID }, showFutureRecurrence: true })],
    ])('matches real RN whole content and all nine canonical SQL tables: %s', async (_name, task) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        for (const [completedAt, days, expectedStatus] of [
            [INITIAL, 0, 'done'], ['2026-10-02T12:59:59.123Z', 0, 'done'], ['2001-01-01T00:00:00.001Z', 0, 'done'],
            ['2037-07-01T17:45:32.456Z', 7, 'done'], ['2026-09-25T12:59:59.999Z', 7, 'archived'],
            ['2026-09-25T13:00:00.000Z', 7, 'done'], ['2026-09-25T13:00:00.001Z', 7, 'done'],
        ] as const) {
            const rn = await openSqliteHost(seed(task, days));
            let expected: ReturnType<typeof rows>;
            let expectedRaw: Awaited<ReturnType<typeof raw>>;
            try {
                await canonical();
                expect((await useTaskStore.getState().updateTask(ID, { completedAt })).success).toBe(true);
                await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
                expect(expected.tasks.find((row) => row.id === ID)?.status).toBe(expectedStatus);
            } finally { await rn.close(); }
            const native = await openSqliteHost(seed(task, days));
            try {
                await canonical();
                const command = await prepare(native, request(completedAt));
                expect(value(native.host.validatePreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
                expect(value(await native.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
                expect(rows()).toEqual(expected); expect(await raw(native)).toEqual(expectedRaw);
                expect(rows().tasks).toHaveLength(2);
                expect(rows().tasks.find((row) => row.id === ID)?.timeSpentMinutes).toBe(task.timeSpentMinutes);
            } finally { await native.close(); }
        }
    }, 35_000);

    it('uses shared initial precision, missing/invalid fallback and no-write options', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        for (const [completedAt, expected] of [[INITIAL, INITIAL], [undefined, source().updatedAt], ['invalid prior value', null],
            ['+020000-01-01T00:00:00.123Z', '+020000-01-01T00:00:00.123Z'],
            ['-000001-01-01T00:00:00.123Z', '-000001-01-01T00:00:00.123Z']] as const) {
            const sqlite = await openSqliteHost(seed(source({ completedAt })));
            try {
                const displayed = request();
                const before = await raw(sqlite);
                expect(value(sqlite.host.getDoneTaskCompletedAtOptions({ id: ID, taskRevision: displayed.taskRevision })))
                    .toEqual({ title: 'Completion time', saveLabel: 'Save', cancelLabel: 'Cancel', taskId: ID,
                        taskRevision: displayed.taskRevision, initialValue: expected,
                        initialEpochMilliseconds: expected === null ? null : new Date(expected).getTime() });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
                const selected = expected?.startsWith('+') || expected?.startsWith('-')
                    ? expected : '2030-01-01T01:02:03.456Z';
                const command = await prepare(sqlite, request(selected));
                expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
                expect(useTaskStore.getState()._tasksById.get(ID)?.completedAt).toBe(selected);
            } finally { await sqlite.close(); }
        }
    });

    // Four full SQLite host boots (RN and native, two instants): about 2 s alone, past the 5 s default under gate load.
    it('matches RN when an ordinary completion changes to an extended-year instant', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        for (const completedAt of ['+020000-01-01T00:00:00.123Z', '-000001-01-01T00:00:00.123Z']) {
            const rn = await openSqliteHost(seed());
            let expected: ReturnType<typeof rows>;
            let expectedRaw: Awaited<ReturnType<typeof raw>>;
            try {
                await canonical();
                expect((await useTaskStore.getState().updateTask(ID, { completedAt })).success).toBe(true);
                await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
            } finally { await rn.close(); }
            const native = await openSqliteHost(seed());
            try {
                await canonical();
                const command = await prepare(native, request(completedAt));
                expect(value(native.host.validatePreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
                expect(value(await native.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
                expect(rows()).toEqual(expected); expect(await raw(native)).toEqual(expectedRaw);
                expect(useTaskStore.getState()._tasksById.get(ID)?.completedAt).toBe(completedAt);
                expect(await native.receiptIds()).toEqual([REQUEST_ID]);
            } finally { await native.close(); }
        }
    }, 20_000);

    it('rejects changed auto-archive settings before commit without rows or receipts', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite, request('2001-01-01T00:00:00.000Z'));
            const data = (await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id = 1'))[0].data;
            await sqlite.client().run('UPDATE settings SET data = ? WHERE id = 1',
                [JSON.stringify({ ...JSON.parse(data), gtd: { autoArchiveDays: 7 } })]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('refuses invalid, stale, read-only, non-Done, deleted and projected inputs', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const displayed = request(); const before = await raw(sqlite);
            for (const input of [{ ...displayed, completedAt: '' }, { ...displayed, completedAt: '2026-10-01' },
                { ...displayed, completedAt: '2026-10-01T12:34:56Z' }, { ...displayed, completedAt: '2026-10-01T12:34:56.789+00:00' },
                { ...displayed, completedAt: 'invalid' }, { ...displayed, requestId: 'not-uuid' }, { ...displayed, timeSpentMinutes: 20 },
                { ...displayed, status: 'done' }, { ...displayed, taskRevision: 'x'.repeat(201) }, { ...displayed, id: 'x'.repeat(501) }]) {
                expect(await sqlite.host.prepareDoneTaskCompletedAt(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await sqlite.host.prepareDoneTaskCompletedAt({ ...displayed, taskRevision: 'stale' }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.prepareDoneTaskCompletedAt({ ...displayed, id: `${ID}:projected-recurrence` })).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
        for (const task of [source({ status: 'next' }), source({ deletedAt: NOW }), source({ purgedAt: NOW })]) {
            const unavailable = await openSqliteHost(seed(task));
            try { expect(await unavailable.host.prepareDoneTaskCompletedAt(request())).toMatchObject({ ok: false }); }
            finally { await unavailable.close(); }
        }
        const readonly = await openSqliteHost(seed(source(), 0, parent({ status: 'archived', archivedAt: NOW })));
        try {
            expect(readonly.host.getDoneTaskCompletedAtOptions({ id: ID, taskRevision: request().taskRevision })).toMatchObject({ ok: false });
            expect(await readonly.host.prepareDoneTaskCompletedAt(request())).toMatchObject({ ok: false });
        } finally { await readonly.close(); }
    });


    it('rejects forged/cross-kind journals and cannot acknowledge an unused UUID from equal AFTER', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite);
            const before = await raw(sqlite);
            for (const mutate of [
                (item: typeof command) => { item.prepared.kind = 'doneStatus' as never; },
                (item: typeof command) => { item.prepared.checklist.witness.direct.timeSpentMinutes = 10; },
                (item: typeof command) => { item.prepared.checklist.effect.tasks[0].after.description = 'Forged'; },
                (item: typeof command) => { item.prepared.rawBefore.completedAt = NOW; },
                (item: typeof command) => { item.request.completedAt = NOW; },
                (item: typeof command) => { item.prepared.result.id = 'different'; },
            ]) {
                const forged = clone(command); mutate(forged);
                expect(sqlite.host.validatePreparedDoneTaskCompletedAt(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(sqlite.host.validatePreparedDoneTaskStatus(command as never)).toMatchObject({ ok: false });
            expect(sqlite.host.doneTaskStatusOutcome(command as never)).toMatchObject({ ok: false });
            expect(sqlite.host.prepareTaskChecklistSave(command.prepared.checklist.request as never)).toMatchObject({ ok: false });
            expect(sqlite.host.validatePreparedTaskChecklistWrite({ request: command.prepared.checklist.request, prepared: command.prepared.checklist })).toMatchObject({ ok: false });
            expect(await sqlite.host.commitPreparedTaskChecklistWrite({ request: command.prepared.checklist.request, prepared: command.prepared.checklist })).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            const alternate = clone(command);
            for (const owner of [alternate.request, alternate.prepared.request, alternate.prepared.checklist.request])
                owner.requestId = '00000000-0000-4000-8000-000000000180';
            expect(value(sqlite.host.validatePreparedDoneTaskCompletedAt(alternate))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
            await sqlite.restart(undefined, { recoveryLoad: true });
            const saved = await raw(sqlite);
            expect(value(sqlite.host.doneTaskCompletedAtOutcome(alternate))).toBeNull();
            expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(alternate)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(saved);
            const nextTime = clone(command);
            nextTime.request.completedAt = NOW; nextTime.prepared.request.completedAt = NOW;
            expect(sqlite.host.doneTaskCompletedAtOutcome(nextTime)).toMatchObject({ ok: false });
            await sqlite.client().run('UPDATE tasks SET title = ?, completedAt = ?, rev = rev + 1 WHERE id = ?', ['Later edit', NOW, ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const later = await raw(sqlite);
            const receipts = await sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid');
            expect(value(sqlite.host.doneTaskCompletedAtOutcome(command))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(later);
            expect(await sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
        } finally { await sqlite.close(); }
    });

    it('keeps Status and completion-time UUID/payload ownership distinct', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const completed = await prepare(sqlite);
            const statusRequest = { id: ID, taskRevision: request().taskRevision, requestId: REQUEST_ID, status: 'next' as const };
            const planned = value(await sqlite.host.prepareDoneTaskStatus(statusRequest));
            if (planned.kind !== 'prepared') throw new Error('Expected status plan');
            const status = { request: statusRequest, prepared: planned.prepared };
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(completed))).toEqual({ id: ID });
            expect(sqlite.host.doneTaskStatusOutcome(status)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.commitPreparedDoneTaskStatus(status)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const before = await raw(sqlite);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(sqlite.host.doneTaskStatusOutcome(status)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('retries two failed COMMITs in the same host then cold-recovers the exact raw legacy source', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            const attachment = { id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW };
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL, attachments = ? WHERE id = ?', [JSON.stringify([attachment]), ID]);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['sibling']);
            await sqlite.restart();
            const command = await prepare(sqlite, request('2030-01-01T01:02:03.456Z'));
            expect(command.prepared.rawBefore.focusOrder).toBe(2);
            expect(command.prepared.rawBefore.pushCount).toBeUndefined();
            expect(command.prepared.rawBefore.attachments?.[0].updatedAt).toBe('');
            expect(command.prepared.checklist.witness.source.focusOrder).toBeUndefined();
            const before = await raw(sqlite);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10;
                expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
                expect(value(sqlite.host.doneTaskCompletedAtOutcome(command))).toBeNull();
            }
            fault.commits = 0;
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(ID)?.focusOrder).toBe(2);
            expect(useTaskStore.getState()._tasksById.get(ID)?.pushCount).toBeUndefined();
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
            const after = await raw(sqlite);
            expect((after.tasks as Array<{ id: string }>).find((row) => row.id === 'sibling'))
                .toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'sibling'));
            expect(value(sqlite.host.doneTaskCompletedAtOutcome(command))).toEqual({ id: ID });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('saves an owned same-host retry without normalizing untouched raw siblings', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['sibling']);
            await sqlite.restart();
            const command = await prepare(sqlite);
            const before = await raw(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.commits = 0;
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
            const after = await raw(sqlite);
            expect((after.tasks as Array<{ id: string }>).find((row) => row.id === 'sibling'))
                .toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'sibling'));
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('refuses raw focusOrder 2 to 3 edit at the same revision', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', [ID]);
            await sqlite.restart(); const command = await prepare(sqlite);
            await sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', [ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('does not mint landed receipt ownership from a pre-write raw read failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { read: false };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (sql, params) => {
            if (fault.read && /FROM tasks/i.test(sql)) throw new Error('injected read failure');
            return client.all(sql, params);
        } }));
        try {
            const command = await prepare(sqlite); const before = await raw(sqlite);
            fault.read = true;
            expect(await sqlite.host.commitPreparedDoneTaskCompletedAt(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(sqlite.host.doneTaskCompletedAtOutcome(command))).toBeNull();
            expect(value(await sqlite.host.commitPreparedDoneTaskCompletedAt(command))).toEqual({ id: ID });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.read = false; await sqlite.close(); }
    });

});
