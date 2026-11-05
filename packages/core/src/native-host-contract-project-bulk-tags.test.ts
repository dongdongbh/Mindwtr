import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskRevisionOf, loadNativeRequestReceipts } from './native-request-receipts';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import type { AppData, Task } from './types';
import type { NativeProjectTasksAddTagEnvelope } from './native-host-contract-project-bulk-tag';
import type { NativeProjectTasksRemoveTagEnvelope } from './native-host-contract-project-bulk-remove-tag';
const openSqliteHost: typeof openHost = (fixture, wrap, bindings) => openHost(fixture, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-11-02T12:00:00.000Z', OLD = '2026-10-12T12:00:00.000Z';
const WRITE = '00000000-0000-4000-8000-000000000941';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', projectId: 'project', sectionId: 'section',
    createdAt: OLD, updatedAt: OLD, rev: 2, revBy: 'device-a', tags: ['#old'], contexts: [], order: 2, orderNum: 2,
    description: 'Retain notes', timeSpentMinutes: 17, reminderPolicy: 'inherit', dueReminderLeadMinutes: 0,
    checklist: [{ id: 'one', title: 'Retain checked', isCompleted: true }], taskMode: 'list',
    attachments: [{ id: 'link', kind: 'link', title: 'Retain link', uri: 'https://example.com', createdAt: OLD }], ...extra });
const seed = (): Partial<AppData> => ({ tasks: [
    task('next', { recurrence: { rule: 'daily', strategy: 'strict' }, startTime: '2026-11-04', dueDate: '2026-11-05' }),
    task('waiting', { status: 'waiting' }), task('inbox', { status: 'inbox' }), task('someday', { status: 'someday' }),
    task('done', { status: 'done', completedAt: OLD }), task('archived', { status: 'archived', completedAt: OLD, archivedAt: OLD }),
    task('cancelled', { status: 'archived', cancelledAt: OLD, archivedAt: OLD }),
    task('reference', { status: 'reference', projectId: 'foreign', sectionId: 'foreign-section', tags: ['#match', '#old'] }),
    task('unrelated', { projectId: 'unrelated', sectionId: undefined }),
], projects: ['project', 'foreign', 'unrelated'].map(id => ({ id, title: id, status: 'active', tagIds: id === 'project' ? ['#match'] : [],
    createdAt: OLD, updatedAt: OLD, rev: 1, revBy: 'device-a', order: 0, color: '#94a3b8' })),
sections: [{ id: 'section', title: 'Section', projectId: 'project', order: 0, createdAt: OLD, updatedAt: OLD },
    { id: 'foreign-section', title: 'Foreign', projectId: 'foreign', order: 0, createdAt: OLD, updatedAt: OLD }],
areas: [{ id: 'area', name: 'Area', order: 0, createdAt: OLD, updatedAt: OLD }],
settings: { deviceId: 'device-a', analyticsProfileId: WRITE, gtd: { autoArchiveDays: 0 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const params = { projectId: 'project', showCompleted: true, completedCollapsed: false, filters: {} };
const selected = ['next', 'waiting', 'inbox', 'someday', 'done', 'archived', 'cancelled', 'reference'];
const raw = async (s: Sqlite) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'].map(async table => [table, await s.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));

const base = (taskIds = selected, scope = params) => ({ requestId: WRITE, source: 'project' as const, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map(id => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])), params: scope });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

for (const operation of ['add', 'remove'] as const) {
    const input = (taskIds = selected, scope = params) => operation === 'add' ? { ...base(taskIds, scope), tag: ' new café ' }
        : { ...base(taskIds, scope), tags: ['#old'] };
    const prepare = async (s: Sqlite, request = input()) => {
        const result = value(operation === 'add' ? await s.host.prepareProjectTasksAddTag(request as Parameters<typeof s.host.prepareProjectTasksAddTag>[0])
            : await s.host.prepareProjectTasksRemoveTag(request as Parameters<typeof s.host.prepareProjectTasksRemoveTag>[0]));
        if (result.kind !== 'prepared') throw new Error('Expected changed tags');
        return { request, prepared: result.prepared };
    };
    type Envelope = Awaited<ReturnType<typeof prepare>>;
    const commit = (s: Sqlite, e: Envelope) => operation === 'add' ? s.host.commitPreparedProjectTasksAddTag(e as NativeProjectTasksAddTagEnvelope)
        : s.host.commitPreparedProjectTasksRemoveTag(e as NativeProjectTasksRemoveTagEnvelope);
    const outcome = (s: Sqlite, e: Envelope) => operation === 'add' ? s.host.projectTasksAddTagOutcome(e as NativeProjectTasksAddTagEnvelope)
        : s.host.projectTasksRemoveTagOutcome(e as NativeProjectTasksRemoveTagEnvelope);
    describe(`Project bulk ${operation} tag`, () => {
        it('matches actual RN token builder and nine SQL domains for mixed Project rows and linked References', async () => {
            clock(); const f = seed(), rn = await openSqliteHost(f); let expected: unknown;
            try { const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', operation === 'add' ? 'new café' : ['#old'], operation);
                expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expected = await raw(rn); }
            finally { await rn.close(); }
            const s = await openSqliteHost(f);
            try { const e = await prepare(s), before = await raw(s); expect(e.prepared.result).toEqual({ count: selected.length, changed: true });
                expect(await raw(s)).toEqual(before); expect(value(await commit(s, e))).toEqual(e.prepared.result); expect(await raw(s)).toEqual(expected);
                expect(await s.receiptIds()).toEqual([WRITE]); }
            finally { await s.close(); }
        });
        it('refuses unavailable durable ownership at preparation and after an already prepared envelope', async () => {
            clock(); const s = await openSqliteHost(seed());
            try { const e = await prepare(s); await loadNativeRequestReceipts(s.client(), { durableCommands: ['projectTasksMove'] });
                const before = await raw(s), request = input();
                expect(operation === 'add' ? await s.host.prepareProjectTasksAddTag(request as never) : await s.host.prepareProjectTasksRemoveTag(request as never))
                    .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await commit(s, e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(outcome(s, e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]); }
            finally { await s.close(); }
        });
        it('keeps no-op free of writes and receipts but still validates Project membership', async () => {
            clock(); const s = await openSqliteHost(seed());
            try { const before = await raw(s);
                const noop = operation === 'add' ? await s.host.prepareProjectTasksAddTag({ ...base(), tag: ' ' })
                    : await s.host.prepareProjectTasksRemoveTag({ ...base(), tags: ['#missing'] });
                expect(value(noop)).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
                const invalid = operation === 'add' ? await s.host.prepareProjectTasksAddTag({ ...base(['unrelated']), tag: ' ' })
                    : await s.host.prepareProjectTasksRemoveTag({ ...base(['unrelated']), tags: ['#missing'] });
                expect(invalid).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]); }
            finally { await s.close(); }
        });
        it('rejects exact-source spoofing, extra scope, stale revisions and read-only foreign References', async () => {
            clock(); const f = seed(); f.projects![1].status = 'archived'; const s = await openSqliteHost(f);
            try { const before = await raw(s), good = input(['waiting']);
                for (const bad of [{ ...good, source: 'inbox' }, { ...good, extra: true }, { ...good, params: { ...params, offset: 0 } },
                    { ...good, params: { ...params, filterSheetOpen: true } }, { ...good, taskRevisions: {} }]) {
                    const result = operation === 'add' ? await s.host.prepareProjectTasksAddTag(bad as never) : await s.host.prepareProjectTasksRemoveTag(bad as never);
                    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                }
                const bad = input(['reference']); expect(operation === 'add' ? await s.host.prepareProjectTasksAddTag(bad as never)
                    : await s.host.prepareProjectTasksRemoveTag(bad as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(operation === 'add' ? await s.host.prepareInboxTasksAddTag(good as never) : await s.host.prepareInboxTasksRemoveTag(good as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await raw(s)).toEqual(before); }
            finally { await s.close(); }
        });
        it('refuses saved Project membership drift before writing any selected row', async () => {
            clock(); const s = await openSqliteHost(seed());
            try { const e = await prepare(s); await s.client().run('UPDATE projects SET tagIds=? WHERE id=?', ['[]', 'project']); const before = await raw(s);
                expect(await commit(s, e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]); }
            finally { await s.close(); }
        });
        it('replays a failed save cold and confirms the saved receipt without overwriting later edits', async () => {
            clock(); let fail = false; const s = await openSqliteHost(seed(), c => ({ ...c, run: async (sql, args) => {
                if (fail && sql === 'COMMIT') throw new Error('Project tags failed commit'); return c.run(sql, args);
            } }));
            try { const e = await prepare(s), frozen = JSON.stringify(e), before = await raw(s); fail = true;
                expect(await commit(s, e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(s)).toEqual(before);
                fail = false; await s.restart(undefined, { recoveryLoad: true }); expect(value(await commit(s, e))).toEqual(e.prepared.result);
                await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['later edit', 'waiting']);
                await s.restart(undefined, { recoveryLoad: true }); const saved = await raw(s);
                expect(value(outcome(s, e))).toEqual(e.prepared.result); expect(value(await commit(s, e))).toEqual(e.prepared.result);
                expect(await raw(s)).toEqual(saved); expect(JSON.stringify(e)).toBe(frozen); expect(await s.receiptIds()).toEqual([WRITE]); }
            finally { fail = false; await s.close(); }
        });
        it('freezes timezone-sensitive normalization through unlanded cold retry', async () => {
            vi.stubEnv('TZ', 'UTC'); clock(); vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z'));
            const f = seed(); f.tasks = [task('queued', { status: 'reference', isFocusedToday: true, startTime: '2026-11-02T06:00:00.000Z' })];
            const s = await openSqliteHost(f);
            try { const e = await prepare(s, input(['queued'])); vi.stubEnv('TZ', 'America/New_York'); await s.restart(undefined, { recoveryLoad: true });
                expect(value(await commit(s, e))).toEqual(e.prepared.result); const saved = await raw(s);
                await s.restart(undefined, { recoveryLoad: true }); expect(value(outcome(s, e))).toEqual(e.prepared.result); expect(await raw(s)).toEqual(saved); }
            finally { await s.close(); }
        });
    });
}

it('Project Move also refuses receipt ownership lost after preparation', async () => {
    clock(); const s = await openSqliteHost(seed());
    try { const request = { ...base(['waiting']), status: 'next' as const };
        const e = { request, prepared: value(await s.host.prepareProjectTasksMove(request)).prepared };
        await loadNativeRequestReceipts(s.client(), { durableCommands: ['projectTasksAddTag'] }); const before = await raw(s);
        expect(await s.host.commitPreparedProjectTasksMove(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(s.host.projectTasksMoveOutcome(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]); }
    finally { await s.close(); }
});
