import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { createNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const NOW = '2026-10-02T13:00:00.000Z';
const ID = 'done-status-task';
const REQUEST_ID = '00000000-0000-4000-8000-000000000177';
const OTHER_ID = '00000000-0000-4000-8000-000000000178';
const STATUSES = ['inbox', 'next', 'waiting', 'someday', 'reference'] as const;
const clone = <T,>(source: T): T => JSON.parse(JSON.stringify(source)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const source = (overrides: Partial<Task> = {}): Task => ({
    id: ID, title: '  Done task  ', status: 'done',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    completedAt: '2026-09-30T12:00:00.000Z', rev: 3, revBy: 'device-a',
    contexts: ['home'], tags: ['tag'], projectId: 'parent', sectionId: 'section',
    description: 'Keep every byte', boardOrder: 7, order: 2, orderNum: 2,
    ...overrides,
});
const parent = (overrides: Partial<Project> = {}): Project => ({
    id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [],
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    rev: 2, revBy: 'device-a', ...overrides,
});
const seed = (task = source(), project = parent()): Partial<AppData> => ({
    tasks: [task, source({ id: 'sibling', title: 'Sibling', status: 'next', completedAt: undefined,
        order: 4, orderNum: 4 })], projects: [project],
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0,
        createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: '00000000-0000-4000-8000-000000000179' },
});
const rows = () => {
    const state = useTaskStore.getState();
    return clone({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, people: state._allPeople, settings: state.settings });
};
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const request = (status: 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'reference' = 'next') => ({ id: ID, requestId: REQUEST_ID, status,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const prepare = async (sqlite: Sqlite, input = request()) => {
    const plan = value(await sqlite.host.prepareDoneTaskStatus(input));
    if (plan.kind !== 'prepared') throw new Error('Expected status preparation');
    return { request: input, prepared: plan.prepared };
};

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
});

describe('Done row status uses the RN status-only update and durable receipts', () => {
    it.each([
        ['ordinary', source()],
        ['recurring', source({ recurrence: { rule: 'daily', strategy: 'strict', seriesId: ID },
            showFutureRecurrence: true, startTime: '2026-09-30', dueDate: '2026-10-01' })],
        ['rich', source({ startTime: '2026-10-04T15:00:00.000Z', dueDate: '2026-10-04T17:00:00.000Z',
            reviewAt: '2026-10-05', relativeStartOffset: { amount: 2, unit: 'hour' }, assignedTo: 'person',
            priority: 'high', energyLevel: 'high', timeEstimate: '30min', timeSpentMinutes: 45,
            isFocusedToday: true, focusOrder: 3, cancelledAt: '2026-09-29T12:00:00.000Z',
            checklist: [{ id: 'check', title: 'Keep step', isCompleted: true },
                { id: 'blank', title: '  ', isCompleted: false }],
            attachments: [{ id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///owned/proof.txt',
                createdAt: NOW, updatedAt: NOW }],
            recurrence: { rule: 'weekly', strategy: 'after-completion', seriesId: ID }, showFutureRecurrence: true })],
    ])('matches actual updateTask whole memory and nine SQL tables for all five targets: %s', async (_name, task) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        for (const status of STATUSES) {
            const rn = await openSqliteHost(seed(task));
            let expected: ReturnType<typeof rows>;
            let expectedRaw: Awaited<ReturnType<typeof raw>>;
            try {
                expect((await useTaskStore.getState().updateTask(ID, { status })).success).toBe(true);
                await flushPendingSave();
                expected = rows();
                expectedRaw = await raw(rn);
            } finally { await rn.close(); }
            const native = await openSqliteHost(seed(task));
            try {
                const command = await prepare(native, request(status));
                expect(value(native.host.validatePreparedDoneTaskStatus(command))).toEqual({ id: ID });
                expect(value(await native.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
                expect(rows()).toEqual(expected);
                expect(await raw(native)).toEqual(expectedRaw);
                expect(rows().tasks.find((row) => row.id === ID)?.title).toBe(task.title);
                expect(rows().tasks.find((row) => row.id === ID)?.checklist).toEqual(expected.tasks.find((row) => row.id === ID)?.checklist);
            } finally { await native.close(); }
        }
    }, 25_000);

    it('returns RN choices and selected Done without a write, after revision and read-only checks', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const displayed = request('done');
            const before = await raw(sqlite);
            const options = value(sqlite.host.getDoneTaskStatusOptions({ id: ID, taskRevision: displayed.taskRevision }));
            expect(options).toMatchObject({ title: 'Change Status', taskId: ID, taskRevision: displayed.taskRevision, status: 'done' });
            expect(options.options.map((option) => [option.status, option.selected])).toEqual([
                ['inbox', false], ['next', false], ['waiting', false], ['someday', false], ['done', true], ['reference', false],
            ]);
            expect(value(await sqlite.host.prepareDoneTaskStatus(displayed))).toEqual({ kind: 'noop', result: { id: ID } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
            await useTaskStore.getState().updateTask(ID, { title: 'Later title' });
            await flushPendingSave();
            expect(await sqlite.host.prepareDoneTaskStatus(displayed)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
        const archived = await openSqliteHost(seed(source(), parent({ status: 'archived', archivedAt: NOW })));
        try {
            expect(await archived.host.prepareDoneTaskStatus(request('done'))).toMatchObject({ ok: false });
            expect(archived.host.getDoneTaskStatusOptions({ id: ID, taskRevision: request().taskRevision })).toMatchObject({ ok: false });
        } finally { await archived.close(); }
    });

    it('refuses invalid inputs, stale/non-Done/deleted/projected rows, and a newly read-only parent', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const displayed = request();
            for (const input of [{ ...displayed, status: 'archived' }, { ...displayed, requestId: 'AAAAAAAA-0000-4000-8000-000000000177' },
                { ...displayed, id: 'x'.repeat(501) }, { ...displayed, taskRevision: 'x'.repeat(201) },
                { ...displayed, extra: true }]) {
                expect(await sqlite.host.prepareDoneTaskStatus(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await sqlite.host.prepareDoneTaskStatus({ ...displayed, taskRevision: 'stale' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.prepareDoneTaskStatus({ ...displayed, id: `${ID}:projected-recurrence` })).toMatchObject({ ok: false });
            const command = await prepare(sqlite, displayed);
            await sqlite.client().run('UPDATE projects SET status = ?, archivedAt = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['archived', NOW, NOW, 'parent']);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
        for (const task of [source({ status: 'next' }), source({ deletedAt: NOW }), source({ purgedAt: NOW })]) {
            const unavailable = await openSqliteHost(seed(task));
            try { expect(await unavailable.host.prepareDoneTaskStatus(request())).toMatchObject({ ok: false }); }
            finally { await unavailable.close(); }
        }
    });

    it('validates forged journals before SQLite and never infers receipt ownership from equal AFTER', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite);
            const mutations = [
                (item: typeof command) => { item.prepared.checklist.witness.source.status = 'next'; },
                (item: typeof command) => { item.prepared.checklist.witness.direct.title = 'Unrequested'; },
                (item: typeof command) => { item.prepared.checklist.effect.tasks[0].after.description = 'Forged'; },
                (item: typeof command) => { item.prepared.result.id = 'different'; },
                (item: typeof command) => { item.request.status = 'reference'; },
            ];
            const before = await raw(sqlite);
            expect(sqlite.host.prepareTaskChecklistSave(command.prepared.checklist.request as never)).toMatchObject({ ok: false });
            expect(sqlite.host.validatePreparedTaskChecklistWrite({ request: command.prepared.checklist.request,
                prepared: command.prepared.checklist })).toMatchObject({ ok: false });
            expect(await sqlite.host.commitPreparedTaskChecklistWrite({ request: command.prepared.checklist.request,
                prepared: command.prepared.checklist })).toMatchObject({ ok: false });
            for (const mutate of mutations) {
                const forged = clone(command);
                mutate(forged);
                expect(sqlite.host.validatePreparedDoneTaskStatus(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedDoneTaskStatus(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
            const alternate = clone(command);
            alternate.request.requestId = OTHER_ID;
            alternate.prepared.request.requestId = OTHER_ID;
            alternate.prepared.checklist.request.requestId = OTHER_ID;
            expect(value(sqlite.host.validatePreparedDoneTaskStatus(alternate))).toEqual({ id: ID });
            value(await sqlite.host.commitPreparedDoneTaskStatus(command));
            await sqlite.restart(undefined, { recoveryLoad: true });
            const saved = await raw(sqlite);
            expect(value(sqlite.host.doneTaskStatusOutcome(alternate))).toBeNull();
            expect(await sqlite.host.commitPreparedDoneTaskStatus(alternate)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(saved);
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1, updatedAt = ? WHERE id = ?', ['Later edit', NOW, ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const later = await raw(sqlite);
            const receipts = await sqlite.receiptIds();
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(later);
            expect(await sqlite.receiptIds()).toEqual(receipts);
        } finally { await sqlite.close(); }
    });

    it('cold retries failed SQLite COMMIT with legacy NULL pushCount and exact original UUID', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', [ID]);
            await sqlite.restart();
            const command = await prepare(sqlite);
            expect(command.prepared.checklist.effect.sourceBefore.pushCount).toBe(0);
            const before = await raw(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(ID)?.pushCount).toBeUndefined();
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toBeNull();
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it.each([
        ['positive pushCount', 'pushCount', 1],
        ['negative pushCount', 'pushCount', -1],
        ['title', 'title', 'Concurrent title'],
        ['revision', 'rev', 4],
        ['recurrence', 'recurrence', JSON.stringify({ rule: 'weekly', strategy: 'strict', seriesId: ID })],
    ])('refuses cold concurrent %s with raw NULL pushCount', async (_name, column, changed) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', [ID]);
            await sqlite.restart();
            const command = await prepare(sqlite);
            expect(command.prepared.checklist.effect.sourceBefore.pushCount).toBe(0);
            await sqlite.client().run(`UPDATE tasks SET ${column} = ? WHERE id = ?`, [changed, ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('cold retries a new preparation over raw Done focusOrder after a failed COMMIT', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            const attachment = { id: 'raw-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: NOW };
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL, attachments = ? WHERE id = ?',
                [JSON.stringify([attachment]), ID]);
            await sqlite.restart();
            expect(useTaskStore.getState()._tasksById.get(ID)?.focusOrder).toBeUndefined();
            expect(await sqlite.sql('SELECT focusOrder, pushCount FROM tasks WHERE id = ?', [ID]))
                .toEqual([{ focusOrder: 2, pushCount: null }]);
            const command = await prepare(sqlite);
            const before = await raw(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
            fault.commits = 0;
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(ID)?.focusOrder).toBe(2);
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('retries the exact failed UUID in the same host while preserving raw siblings', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', [ID]);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['sibling']);
            await sqlite.restart();
            const command = await prepare(sqlite);
            const before = await raw(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toBeNull();
            fault.commits = 0;
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            const after = await raw(sqlite);
            expect((after.tasks as Array<{ id: string }>).find((row) => row.id === 'sibling'))
                .toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'sibling'));
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toEqual({ id: ID });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('does not claim a receipt when the pre-write durable read fails', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { read: false };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (sql, params) => {
            if (fault.read && /FROM tasks/i.test(sql)) throw new Error('injected raw read failure');
            return client.all(sql, params);
        } }));
        try {
            const command = await prepare(sqlite);
            const before = await raw(sqlite);
            fault.read = true;
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false;
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(sqlite.host.doneTaskStatusOutcome(command))).toBeNull();
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(command))).toEqual({ id: ID });
            expect(useTaskStore.getState()._tasksById.get(ID)?.status).toBe('next');
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.read = false; await sqlite.close(); }
    });

    it('refuses a raw focusOrder 2 to 3 edit while normal loaded Done rows look equal', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', [ID]);
            await sqlite.restart();
            const command = await prepare(sqlite);
            await sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', [ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(command))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });


    it('gates uncommitted V1 but retains a saved V1 receipt after later edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite);
            if (command.prepared.version !== 2) throw new Error('Expected V2 preparation');
            const { rawBefore: _rawBefore, ...unbound } = command.prepared;
            const legacy = { request: command.request, prepared: { ...unbound, version: 1 as const } };
            expect(value(sqlite.host.validatePreparedDoneTaskStatus(legacy))).toEqual({ id: ID });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedDoneTaskStatus(legacy))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(value(sqlite.host.doneTaskStatusOutcome(legacy))).toBeNull();
            expect(await sqlite.receiptIds()).toEqual([]);


            const payload = JSON.stringify(['doneTaskStatus', legacy], (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const priorReceipts = createNativeRequestReceipts({ save: async () => { await flushPendingSave(); return { ok: true, value: null }; } });
            expect(value(await priorReceipts.run(REQUEST_ID, payload, async () => {
                expect((await useTaskStore.getState().updateTask(ID, { status: command.request.status })).success).toBe(true);
                return { ok: true, value: { id: ID } };
            }))).toEqual({ id: ID });
            await sqlite.client().run('UPDATE tasks SET focusOrder = 3, title = ?, rev = rev + 1 WHERE id = ?', ['Later edit', ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const later = await raw(sqlite);
            expect(value(sqlite.host.doneTaskStatusOutcome(legacy))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedDoneTaskStatus(legacy))).toEqual({ id: ID });
            expect(await raw(sqlite)).toEqual(later);
        } finally { await sqlite.close(); }
    });

});
