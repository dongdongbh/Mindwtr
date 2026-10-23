import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInboxTasksMoveMethods, type NativeInboxTasksMoveEnvelope } from './native-host-contract-inbox-bulk-status';
import { join } from 'node:path';
import { openScratchSqlite, openSqliteHost as openHost } from './screen-parity.replay';
const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
import { NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import { getBulkMoveStatusOptions } from './task-list-bulk-actions';
import * as uuid from './uuid';
import * as logger from './logger';
import { readReferenceBatchSelectionRequest } from './native-host-contract-reference-bulk-status';
import { deterministicHash128 } from './uuid';
import type { AppData, Task, TaskStatus } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000193';
const DEVICE = 'inbox-move-device';
const ORIGINAL_TZ = process.env.TZ;
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'inbox',
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
const methods = () => createInboxTasksMoveMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
    return useTaskStore.getState().persistenceFailure
        ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
} });
const request = (status: TaskStatus = 'next', taskIds = ['a', 'b'], requestId = REQUEST_ID, params = {}) => ({ requestId, source: 'inbox' as const,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    status: status as 'next' | 'waiting' | 'someday' | 'done' | 'reference', params });
const prepare = async (host = methods(), input = request()): Promise<NativeInboxTasksMoveEnvelope> =>
    ({ request: input, prepared: value(await host.prepareInboxTasksMove(input)).prepared });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const ids = () => {
    let index = 0;
    return vi.spyOn(uuid, 'generateUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(900 + ++index).padStart(12, '0')}`);
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

describe('guarded Inbox bulk Move status', () => {
    it('requires the exact Inbox source, five destinations and closed non-paged params', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(); const before = await raw(sqlite); const host = methods();
            const { source: _source, ...sourceAbsent } = input;
            for (const invalid of [sourceAbsent, { ...input, source: 'reference' }, { ...input, source: 'done' },
                ...['inbox', 'archived', 'unknown'].map(status => ({ ...input, status })),
                ...[{ includeArchivedProjects: false }, { includeArchivedProjects: true }, { offset: 0 }, { limit: 100 },
                    { selectAll: true }, { filterEdit: { type: 'clear' } }, { unexpected: true }].map(params => ({ ...input, params })),
                { ...input, taskRevisions: { a: input.taskRevisions.a } }])
                expect(await host.prepareInboxTasksMove(invalid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(readReferenceBatchSelectionRequest(input)).toBeNull();
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('binds an unselected Inbox metadata-visibility witness and refuses its same-revision drift', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('witness')], settings: { deviceId: DEVICE } });
        try {
            const input = request('next', ['a'], REQUEST_ID, { filters: { energyLevels: ['high'] } });
            const page = value(sqlite.host.getInboxView({ offset: 0, limit: 100, ...input.params }));
            expect(page.items.some(item => item.type === 'task' && item.row.id === 'a')).toBe(true);
            const command = await prepare(methods(), input);
            await sqlite.client().run('UPDATE tasks SET energyLevel = ? WHERE id = ?', ['high', 'witness']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(sqlite.host.getInboxView({ offset: 0, limit: 100, ...input.params })).items.some(item => item.type === 'task' && item.row.id === 'a')).toBe(false);
            expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('binds the real Inbox priority-visibility feature setting', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('witness', { priority: 'high' })],
            settings: { deviceId: DEVICE, features: { priorities: false } } });
        try {
            const input = request('waiting', ['a'], REQUEST_ID, { filters: { priorities: ['high'] } });
            const command = await prepare(methods(), input);
            expect(command.prepared.scope.settings.features?.priorities).toBe(false);
            await sqlite.client().run("UPDATE settings SET data=json_set(data,'$.features.priorities',json('true')) WHERE id=1");
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('ignores global area selection and uses the actual public contract beyond the first100 rows', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: Array.from({ length: 210 }, (_, i) => task('row-' + String(i + 1).padStart(3, '0'), { areaId: 'other' })),
            areas: ['selected', 'other'].map(id => ({ id, name: id, order: 0, createdAt: BEFORE, updatedAt: BEFORE })),
            settings: { deviceId: DEVICE, filters: { areaId: 'selected' }, taskSortBy: 'title' } });
        try {
            const first = value(sqlite.host.getInboxView({ offset: 0, limit: 100 }));
            expect(first.items.some(item => item.type === 'task' && item.row.id === 'row-200')).toBe(false);
            const later = value(sqlite.host.getInboxView({ offset: 100, limit: 100, revision: first.revision }));
            expect(later.items.some(item => item.type === 'task' && item.row.id === 'row-200')).toBe(true);
            const input = request('someday', ['row-200']);
            const command = { request: input, prepared: value(await sqlite.host.prepareInboxTasksMove(input)).prepared };
            expect(command.prepared.scope.settings).not.toHaveProperty('filters');
            await sqlite.client().run("UPDATE settings SET data=json_set(data,'$.filters.areaId','other') WHERE id=1");
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await sqlite.host.commitPreparedInboxTasksMove(command))).toEqual({ count: 1, status: 'someday' });
            expect(useTaskStore.getState()._tasksById.get('row-200')?.status).toBe('someday');
            expect(useTaskStore.getState().settings.filters).toEqual({ areaId: 'other' });
        } finally { await sqlite.close(); }
    });

    it('retains normal startup promotion and refuses a past-scheduled row as an Inbox source', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('scheduled', { dueDate: '2026-10-01' })], settings: { deviceId: DEVICE } });
        try {
            await flushPendingSave();
            expect(useTaskStore.getState()._tasksById.get('scheduled')?.status).toBe('next');
            const before = await raw(sqlite);
            expect(await methods().prepareInboxTasksMove(request('done', ['scheduled']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('preserves the shared legacy section-only project inference and unchanged parent effect', async () => {
        clock(); const initial = seed(); initial.tasks = [task('a', { sectionId: 's1' }), task('sibling', { status: 'next', projectId: 'p1' })];
        const command = await parity(initial, ['a'], 'next');
        expect(command.prepared.effect.tasks.find(row => row.before.id === 'a')?.after.projectId).toBe('p1');
        expect(command.prepared.effect.projects).toEqual([]); expect(command.prepared.scope.sections.map(row => row.id)).toEqual(['s1']);
    });

    it('matches RN full Reference clears while preserving rich attachments and checklist fields', async () => {
        clock(); const command = await parity({ tasks: [task('rich', {
            startTime: '2026-10-04', dueDate: '2026-10-05', relativeStartOffset: { amount: -1, unit: 'day' }, reviewAt: '2026-10-06',
            recurrence: { rule: 'daily' }, priority: 'urgent', timeEstimate: '30min', suppressMindwtrReminders: true,
            repeatReminderMinutes: 15, showFutureRecurrence: true, isFocusedToday: true, focusOrder: 7, boardOrder: 3, pushCount: 4,
            attachments: [{ id: 'file', kind: 'file', title: 'Rich attachment', uri: '/fixtures/rich', cloudKey: 'fixture-object', pendingContentUpload: true, createdAt: BEFORE, updatedAt: BEFORE }],
            checklist: [{ id: 'step', title: 'Step', isCompleted: true }], description: 'Retained description',
        })], settings: { deviceId: DEVICE } }, ['rich'], 'reference');
        const after = command.prepared.effect.tasks[0].after;
        for (const field of ['startTime', 'dueDate', 'relativeStartOffset', 'reviewAt', 'recurrence', 'priority', 'timeEstimate',
            'repeatReminderMinutes', 'showFutureRecurrence', 'focusOrder', 'boardOrder'] as const)
            expect(after[field]).toBeUndefined();
        expect(after).toMatchObject({ status: 'reference', pushCount: 0, isFocusedToday: false, suppressMindwtrReminders: false, description: 'Retained description' });
        expect(after.attachments?.[0]).toMatchObject({ cloudKey: 'fixture-object', pendingContentUpload: true });
        expect(after.checklist).toEqual([{ id: 'step', title: 'Step', isCompleted: true }]);
    });

    it('refuses an oversized unselected Inbox dependency instead of silently dropping its scope', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('witness', { description: '界'.repeat(700_000) })], settings: { deviceId: DEVICE } });
        try {
            const before = await raw(sqlite);
            expect(await methods().prepareInboxTasksMove(request('next', ['a']))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('keeps both family envelopes closed and refuses another family receipt with the same UUID', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('ref', { status: 'reference' })], settings: { deviceId: DEVICE } });
        try {
            const input = request('waiting', ['a']); const command = await prepare(methods(), input);
            const refInput = { requestId: REQUEST_ID, taskIds: ['ref'], taskRevisions: { ref: taskRevisionOf(useTaskStore.getState()._tasksById.get('ref')!) }, status: 'waiting' as const, params: {} };
            const refCommand = { request: refInput, prepared: value(await sqlite.host.prepareReferenceTasksMove(refInput)).prepared };
            expect(sqlite.host.validatePreparedReferenceTasksMove(command as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(methods().validatePreparedInboxTasksMove(refCommand as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            value(await sqlite.host.commitPreparedReferenceTasksMove(refCommand)); const before = await raw(sqlite);
            expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(methods().inboxTasksMoveOutcome(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });

    it('logs only a content-free durable Inbox confirmation and cannot invalidate its ACK', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('b')], settings: { deviceId: DEVICE } });
        try {
            const log = vi.spyOn(logger, 'logInfo'); const host = methods(); const command = await prepare(host, request('next', ['a']));
            expect(log.mock.calls.filter(([message]) => message === 'Native Inbox bulk status confirmed')).toEqual([]);
            value(await host.commitPreparedInboxTasksMove(command));
            expect(log.mock.calls.filter(([message]) => message === 'Native Inbox bulk status confirmed')).toEqual([
                ['Native Inbox bulk status confirmed', { scope: 'native-host', category: 'storage', context: {
                    releaseCheck: 'v1.3.5/ios-inbox-bulk-status', count: 1, status: 'next', outcome: 'moved' } }],
            ]);
            log.mockImplementation(message => { if (message === 'Native Inbox bulk status confirmed') throw new Error('Diagnostic sink unavailable'); });
            const nextId = '00000000-0000-4000-8000-000000000194';
            const second = await prepare(host, request('waiting', ['b'], nextId));
            expect(value(await host.commitPreparedInboxTasksMove(second))).toEqual({ count: 1, status: 'waiting' });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID, nextId]);
        } finally { await sqlite.close(); }
    });

    it.each(getBulkMoveStatusOptions('inbox'))('matches actual RN batchMoveTasks complete AppData and nine SQLite domains for %s', async (status) => {
        clock(); const rn = await openSqliteHost(seed()); let expected; let expectedRaw; let before;
        try {
            await canonical(); before = await raw(rn); const generated = ids();
            expect(await useTaskStore.getState().batchMoveTasks(['a', 'b'], status)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); generated.mockRestore();
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); expect(await raw(sqlite)).toEqual(before);
            expect(new Date().toISOString()).toBe(NOW);
            ids(); const host = methods(); const command = await prepare(host, request(status));
            expect(command.prepared.scope.tasks.map((row) => row.id)).toEqual(['b', 'a', 'sibling', 'history', 'unrelated']);
            expect(value(host.validatePreparedInboxTasksMove(command))).toEqual({ count: 2, status });
            expect(value(await host.commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status });
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
        const fixture = clone(initial);
        fixture.settings = { ...fixture.settings, analyticsProfileId: fixture.settings?.analyticsProfileId ?? REQUEST_ID };
        const rn = await openSqliteHost(fixture); let expected; let expectedRaw; let before;
        const preparedAt = new Date().toISOString();
        try {
            await canonical(); before = await raw(rn);
            for (const source of fixture.tasks ?? []) if (source.attachments?.length)
                expect(rows().tasks.find(row => row.id === source.id)).toMatchObject({ attachments: source.attachments });
            const generated = ids();
            expect(await useTaskStore.getState().batchMoveTasks(selected, status)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); generated.mockRestore();
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(fixture);
        try {
            await canonical(); expect(await raw(sqlite)).toEqual(before);
            expect(new Date().toISOString()).toBe(preparedAt);
            ids(); const host = methods(); const command = await prepare(host, request(status, selected));
            if (status === 'done') expect(command.prepared.effect.createdTasks.every(row => row.status === 'inbox')).toBe(true);
            value(await host.commitPreparedInboxTasksMove(command));
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
        { label: 'UNTIL stops', recurrence: { rule: 'daily' as const, strategy, until: '2026-09-30' }, dates: { dueDate: '2026-10-01' } },
        { label: 'UNTIL advances', recurrence: { rule: 'weekly' as const, strategy, until: '2026-11-01', byDay: ['MO', 'WE'] as const }, dates: { dueDate: '2026-10-01' } },
    ].map((scenario) => ({ ...scenario, strategy })));
    it.each(matrix)('matches shared RN recurrence $strategy $label', async ({ recurrence, dates }) => {
        clock(); vi.setSystemTime(new Date('2026-08-01T13:00:00.000Z')); await parity({ tasks: [task('source', { createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', recurrence: clone(recurrence) as Task['recurrence'], ...dates,
            description: 'Rich', checklist: [{ id: 'step', title: 'Checklist', isCompleted: true }],
            attachments: [{ id: 'file', kind: 'file', title: 'Attachment', uri: '/fixtures/attachment', cloudKey: 'fixture-object',
                createdAt: BEFORE, updatedAt: BEFORE, pendingContentUpload: true }] })], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } }, ['source']);
    });

    it('allocates complete deterministic source-order sequences for multiple sources and deduplicated projectless candidates', async () => {
        clock(); vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z')); const initial = { tasks: [task('first', { title: 'Same source', recurrence: { rule: 'daily', seriesId: 'shared-series' }, dueDate: '2026-10-03',
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
        clock(); vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z')); const initial = seed(); initial.tasks = [task('a', { recurrence: { rule: 'daily', seriesId: 'series' }, dueDate: '2026-10-03' }),
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
                fault.commits = 10; expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(value(host.inboxTasksMoveOutcome(command))).toBeNull();
            }
            fault.commits = 0; vi.restoreAllMocks();
            vi.setSystemTime(new Date('2028-03-15T23:15:00.000Z'));
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated a UUID'); });
            expect(value(await host.commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status: 'done' });
            vi.restoreAllMocks();
            const children = rows().tasks.filter((row) => command.prepared.effect.createdTasks.some((child) => child.id === row.id));
            expect(children).toEqual(command.prepared.effect.createdTasks);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().inboxTasksMoveOutcome(command))).toEqual({ count: 2, status: 'done' });
            const payload = JSON.stringify(['inboxTasksMove', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const method = `inboxTasksMove:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
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
            fault.commits = 10; expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); fault.commits = 0;
            vi.restoreAllMocks();
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated a UUID or device'); });
            value(await host.commitPreparedInboxTasksMove(command)); vi.restoreAllMocks();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
            expect(value(methods().inboxTasksMoveOutcome(command))).toEqual({ count: 2, status: 'done' });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('gives cold own ACK precedence after rename/delete/restore, refuses unused equal target UUID and changed UUID payload', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const command = await prepare(host, request('waiting')); const unused = clone(command);
            unused.request.requestId = '00000000-0000-4000-8000-000000000194'; unused.prepared.request.requestId = unused.request.requestId;
            value(await host.commitPreparedInboxTasksMove(command)); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().inboxTasksMoveOutcome(unused))).toBeNull();
            expect(await methods().commitPreparedInboxTasksMove(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            await useTaskStore.getState().batchDeleteTasks(['a']); await flushPendingSave(); await useTaskStore.getState().restoreTask('a'); await flushPendingSave();
            await sqlite.client().run('UPDATE tasks SET title = ?, status = ?, rev = rev + 1 WHERE id = ?', ['Later task', 'reference', 'a']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'p1']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            const receipt = await sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY request_id');
            expect(value(methods().inboxTasksMoveOutcome(command))).toEqual({ count: 2, status: 'waiting' });
            expect(value(await methods().commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status: 'waiting' });
            const changed = clone(command); changed.request.taskIds.reverse(); changed.prepared.request.taskIds.reverse(); changed.prepared.recurrenceProjections.reverse();
            expect(value(methods().validatePreparedInboxTasksMove(changed))).toEqual({ count: 2, status: 'waiting' });
            expect(await methods().commitPreparedInboxTasksMove(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY request_id')).toEqual(receipt);
        } finally { await sqlite.close(); }
    });

    it('rejects stale selected/dependent rows, membership, filter settings and generated ID collisions before any write', async () => {
        clock(); const edits: Array<(sqlite: Sqlite, command: NativeInboxTasksMoveEnvelope) => Promise<unknown>> = [
            (sqlite) => sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later task', 'a']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['sibling']),
            (sqlite) => sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Later parent', 'p1']),
            (sqlite) => sqlite.client().run('UPDATE sections SET title = ? WHERE id = ?', ['Later section', 's1']),
            (sqlite) => sqlite.client().run("UPDATE settings SET data = json_set(data, '$.features.priorities', json('false')) WHERE id = 1"),
            (sqlite) => sqlite.client().run("UPDATE settings SET data = json_set(data, '$.deviceId', 'later-device') WHERE id = 1"),
            (sqlite, command) => sqlite.client().run('UPDATE tasks SET id = ? WHERE id = ?', [command.prepared.allocatedIds[0], 'unrelated']),
        ];
        for (const edit of edits) {
            const sqlite = await openSqliteHost(seed());
            try {
                const command = await prepare(methods(), request('done')); await edit(sqlite, command);
                await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
                expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
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
                expect(await host.commitPreparedInboxTasksMove(command), label).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                const after = await raw(sqlite); expect(await sqlite.receiptIds()).toEqual([]);
                expect((after.tasks as { rows: Array<{ id: string; status: string }> }).rows.filter((row) => ['a', 'b'].includes(row.id)).every((row) => row.status === 'inbox')).toBe(true);
                await sqlite.restart(undefined, { recoveryLoad: true });
                if (label === 'settings') {
                    value(await methods().commitPreparedInboxTasksMove(command));
                    const final = await raw(sqlite);
                    expect((final.tasks as { rows: Array<{ id: string }> }).rows.find((row) => row.id === 'unrelated')).toEqual((after.tasks as { rows: Array<{ id: string }> }).rows.find((row) => row.id === 'unrelated'));
                    expect(final.settings).toEqual(after.settings);
                } else {
                    expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
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
            const committing = memory.commitPreparedInboxTasksMove(command.prepared, read.authority);
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
        try { const before = await raw(sqlite); expect(await methods().prepareInboxTasksMove(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('binds exact UTF8 NFD/NFC and protected task IDs while rejecting protected request property injection', async () => {
        clock(); const selected = ['é', 'e\u0301', 'constructor', '__proto__', 'prototype'];
        const sqlite = await openSqliteHost({ tasks: selected.map((id) => task(id)), settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try {
            const host = methods(); const command = await prepare(host, request('next', selected));
            expect(value(await host.commitPreparedInboxTasksMove(command))).toEqual({ count: selected.length, status: 'next' });
            const forged = JSON.parse(JSON.stringify({ ...command.request, requestId: '00000000-0000-4000-8000-000000000195' }).replace('"params":{}', '"params":{"__proto__":{}}'));
            expect(await host.prepareInboxTasksMove(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });

    it('refuses filtered, folded, missing, stale, deleted, purged, projected and archived-project read-only selection as a whole', async () => {
        clock(); const initial = seed();
        const purged = task('purged', { deletedAt: BEFORE, purgedAt: BEFORE });
        const projected = task('a:projected-recurrence');
        initial.tasks!.push(task('deleted', { deletedAt: BEFORE }), purged, projected);
        const sqlite = await openSqliteHost(initial);
        try {
            const host = methods(); const input = request(); const before = await raw(sqlite);
            for (const invalid of [{ ...input, status: 'inbox' }, { ...input, status: 'archived' }, { ...input, status: 'bad' },
                { ...input, taskIds: [] }, { ...input, taskIds: ['a', 'a'] }, { ...input, requestId: 'bad' },
                { ...input, taskIds: ['missing'], taskRevisions: { missing: 'revision' } }, request('next', ['deleted']),
                ...[purged, projected].map(row => ({ ...input, taskIds: [row.id], taskRevisions: { [row.id]: taskRevisionOf(row) } })),
                { ...input, taskRevisions: { ...input.taskRevisions, a: 'stale' } },
                { ...input, taskRevisions: { ...input.taskRevisions, extra: 'revision' } },
                { ...input, params: { filterEdit: { type: 'clear' } } },
                { ...input, params: { filters: { searchQuery: 'not present' } } },
                { ...input, params: { groupBy: 'project', collapsedGroupIds: ['project:p1'] } }])
                expect(await host.prepareInboxTasksMove(invalid as never)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            for (const lifecycle of ['archive', 'cancel', 'delete'] as const) {
                await sqlite.client().run('UPDATE projects SET status = ?, cancelledAt = ?, deletedAt = ? WHERE id = ?',
                    [lifecycle === 'delete' ? 'active' : 'archived', lifecycle === 'cancel' ? NOW : null, lifecycle === 'delete' ? NOW : null, 'p1']);
                await sqlite.restart(undefined, { recoveryLoad: true }); const stable = await raw(sqlite);
                expect(await methods().prepareInboxTasksMove(request('next', ['a'], REQUEST_ID, {})))
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
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.effect.tasks[0].after.description = 'Forged'; },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.allocatedIds[0] = '00000000-0000-4000-8000-000000000900'; },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.allocatedIds.push('00000000-0000-4000-8000-000000000999'); },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.recurrenceProjections[1].projection!.candidate.dueDate = '2040-01-01'; },
                (item: NativeInboxTasksMoveEnvelope) => { Object.assign(item.prepared.recurrenceProjections[1].projection!, { extra: true }); },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.recurrenceProjections[1].projection!.sourceAnchorDays.dueDate = 32; },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.recurrenceProjections[1].projection!.candidate.dueDate = 'invalid'; },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.result.count = 3; },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.futureBoundary = NOW; },
                (item: NativeInboxTasksMoveEnvelope) => { item.prepared.scope.tasks.push(task('extra', { status: 'reference' })); },
            ]) {
                const invalid = clone(command); mutate(invalid); calls.mockClear();
                expect(host.validatePreparedInboxTasksMove(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedInboxTasksMove(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(calls).not.toHaveBeenCalled();
            }
            let deep: unknown = 'end'; for (let index = 0; index < 25; index++) deep = { nested: deep };
            calls.mockClear(); expect(await host.prepareInboxTasksMove({ ...command.request, params: deep } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
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
        try { await useTaskStore.getState().batchMoveTasks(['a', 'b'], 'next'); await flushPendingSave(); expected = rows(); } finally { await rn.close(); }
        const sqlite = await setup();
        try {
            const host = methods(); const command = await prepare(host); const before = await raw(sqlite);
            expect(Object.hasOwn(command.prepared.scope.tasks.find((row) => row.id === 'a')!, 'tags')).toBe(false);
            expect(Object.hasOwn(command.prepared.scope.projects.find((row) => row.id === 'p2')!, 'tagIds')).toBe(false);
            expect(Object.hasOwn(command.prepared.scope.projects.find((row) => row.id === 'p2')!.attachments![0], 'updatedAt')).toBe(false);
            value(await host.commitPreparedInboxTasksMove(command)); const after = await raw(sqlite);
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
                expect(await methods().prepareInboxTasksMove(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
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
            expect(await host.prepareInboxTasksMove(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.reads = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.reads = false; await sqlite.close(); }
    });

    it('preserves an unrelated invalid FK during an RN incremental save but refuses it as native preparation authority', async () => {
        clock(); vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z')); const setup = async () => {
            const sqlite = await openSqliteHost({ tasks: [task('source', { title: 'Shared source', recurrence: { rule: 'daily', seriesId: 'projectless' }, dueDate: '2026-10-03' }),
                task('empty-peer', { title: 'Shared source', recurrence: { rule: 'daily', seriesId: 'projectless' }, dueDate: '2026-10-04' }),
                task('null-peer', { title: 'Other peer' })], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
            await canonical(); await sqlite.client().run('PRAGMA foreign_keys = OFF');
            await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'empty-peer']);
            await sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['null-peer']);
            await sqlite.client().run('PRAGMA foreign_keys = ON'); await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite;
        };
        const rn = await setup(); let expected;
        try { const peerBefore = await rn.client().get('SELECT * FROM tasks WHERE id = ?', ['empty-peer']);
            const generated = ids(); expect(await useTaskStore.getState().batchMoveTasks(['source'], 'done')).toEqual({ success: true });
            expected = rows(); expect(generated).toHaveBeenCalledTimes(1); expect(expected.tasks).toHaveLength(3);
            expect(expected.tasks.find((row) => row.id === 'source')?.status).toBe('done');
            await expect(flushPendingSave()).resolves.toBeUndefined();
            expect(useTaskStore.getState().persistenceFailure).toBeNull();
            expect(await rn.client().get('SELECT * FROM tasks WHERE id = ?', ['empty-peer'])).toEqual(peerBefore);
            expect(await rn.client().get('SELECT status FROM tasks WHERE id = ?', ['source'])).toEqual({ status: 'done' });
            expect(await rn.client().all('PRAGMA foreign_key_check')).toHaveLength(1); generated.mockRestore();
        } finally { resetForTests(); await rn.close(); }
        const sqlite = await setup();
        try {
            const generated = ids(); const host = methods(); const before = await raw(sqlite);
            expect(await host.prepareInboxTasksMove(request('done', ['source']))).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
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
            expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['unrelated']); await sqlite.restart(undefined, { recoveryLoad: true });
            value(await methods().commitPreparedInboxTasksMove(command)); await corrupt(); const after = await raw(sqlite);
            expect(value(methods().inboxTasksMoveOutcome(command))).toEqual({ count: 2, status: 'next' });
            expect(value(await methods().commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status: 'next' });
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
            expect(await host.prepareInboxTasksMove(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.probe = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.probe = false; await sqlite.close(); }
    });

    it('cold replays frozen recurrence and UNTIL across actual New York to Tokyo timezone and clock changes', async () => {
        process.env.TZ = 'America/New_York'; clock(); vi.setSystemTime(new Date('2026-03-05T17:00:00.000Z'));
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
            expect(value(await methods().commitPreparedInboxTasksMove(command))).toEqual({ count: 1, status: 'done' });
            expect(rows().tasks.find((row) => row.id === command.prepared.effect.createdTasks[0].id)).toEqual(command.prepared.effect.createdTasks[0]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().inboxTasksMoveOutcome(command))).toEqual({ count: 1, status: 'done' });
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
            expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); fault.commits = 0;
            vi.setSystemTime(new Date('2026-10-03T14:00:00.000Z'));
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            expect(value(await host.commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status: 'next' });
            expect((await raw(sqlite)).areas).toEqual(before.areas);
            vi.setSystemTime(new Date('2027-10-03T15:00:00.000Z')); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().inboxTasksMoveOutcome(command))).toEqual({ count: 2, status: 'next' });
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
            expect(await methods().commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('never adopts an unrelated later failed save generation as ownership of the original envelope', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected failure'); } return client.run(sql, params); },
        }));
        try {
            const host = methods(); const command = await prepare(host, request('done')); fault.commits = 10;
            expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const before = await raw(sqlite);
            await useTaskStore.getState().updateTask('unrelated', { description: 'Later unrelated writer' });
            fault.commits = 10; await expect(flushPendingSave()).rejects.toThrow('Injected failure');
            expect(await host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
    }, 30_000);

    it('accepts 140 exact revisions, but refuses byte-oversized selected scope and preparation ID collision', async () => {
        clock(); const selected = Array.from({ length: 140 }, (_, index) => task(`selected-${index}`));
        const sqlite = await openSqliteHost({ tasks: selected, settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try { const host = methods(); value(await host.commitPreparedInboxTasksMove(await prepare(host, request('waiting', selected.map((row) => row.id))))); }
        finally { await sqlite.close(); }
        const huge = await openSqliteHost({ tasks: [task('a', { description: '界'.repeat(700_000) })], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try { const before = await raw(huge); expect(await methods().prepareInboxTasksMove(request('next', ['a'])))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(huge)).toEqual(before); expect(await huge.receiptIds()).toEqual([]);
        } finally { await huge.close(); }
        const collision = await openSqliteHost({ tasks: [task('a', { recurrence: { rule: 'daily' } }), task('00000000-0000-4000-8000-000000000901')], settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } });
        try { ids(); const before = await raw(collision); expect(await methods().prepareInboxTasksMove(request('done', ['a'])))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(await raw(collision)).toEqual(before);
        } finally { await collision.close(); }
    }, 30_000);

});
