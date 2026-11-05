import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteHost as openHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskRevisionOf } from './native-request-receipts';
import { readReferenceTasksMoveEnvelope } from './native-host-contract-reference-bulk-status';
import { readTasksMoveEnvelope } from './native-host-contract-reference-bulk-status';
import * as uuid from './uuid';
import type { AppData, Task } from './types';
import type { NativeProjectTasksMoveRequest, NativeProjectTasksMoveStatus } from './native-host-contract-project-bulk-status';
const openSqliteHost: typeof openHost = (fixture, wrap, bindings) => openHost(fixture, wrap, bindings, { rejectConcurrentWrites: true });

const NOW = '2026-11-02T12:00:00.000Z', OLD = '2026-10-12T12:00:00.000Z';
const WRITE = '00000000-0000-4000-8000-000000000941';
const statuses = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'] as const;
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', projectId: 'project', sectionId: 'section',
    createdAt: OLD, updatedAt: OLD, rev: 2, revBy: 'device-a', tags: [], contexts: [], order: 2, orderNum: 2,
    description: 'Retain notes', timeSpentMinutes: 17, reminderPolicy: 'inherit', dueReminderLeadMinutes: 0,
    checklist: [{ id: 'one', title: 'Retain checked', isCompleted: true }], taskMode: 'list',
    attachments: [{ id: 'link', kind: 'link', title: 'Retain link', uri: 'https://example.com', createdAt: OLD }], ...extra });
const seed = (): Partial<AppData> => ({ tasks: [
    task('next', { recurrence: { rule: 'daily', strategy: 'strict' }, startTime: '2026-11-04', dueDate: '2026-11-05' }),
    task('waiting', { status: 'waiting' }), task('inbox', { status: 'inbox' }), task('someday', { status: 'someday' }),
    task('done', { status: 'done', completedAt: OLD }), task('archived', { status: 'archived', completedAt: OLD, archivedAt: OLD }),
    task('cancelled', { status: 'archived', cancelledAt: OLD, archivedAt: OLD }),
    task('reference', { status: 'reference', projectId: 'foreign', sectionId: 'foreign-section', tags: ['#match'] }),
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
const request = (status: NativeProjectTasksMoveStatus = 'waiting', taskIds = selected, scope = params): NativeProjectTasksMoveRequest => ({
    requestId: WRITE, source: 'project', taskIds, taskRevisions: Object.fromEntries(taskIds.map(id => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])), status, params: scope });
const prepare = async (s: Sqlite, input = request()) => ({ request: input, prepared: value(await s.host.prepareProjectTasksMove(input)).prepared });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const ids = () => { let n = 0; return vi.spyOn(uuid, 'generateUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(950 + ++n).padStart(12, '0')}`); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('prepared Project bulk Move', () => {
    it.each(statuses)('matches actual RN mixed selection to %s including already-target, archived/cancelled and linked Reference', async status => {
        clock(); const f = seed(); const rn = await openSqliteHost(f); let expected: unknown;
        try { const allocation = ids(); expect((await useTaskStore.getState().batchMoveTasks(selected, status)).success).toBe(true); await flushPendingSave(); expected = await raw(rn); allocation.mockRestore(); }
        finally { await rn.close(); }
        const s = await openSqliteHost(f);
        try { const allocation = ids(), e = await prepare(s, request(status)), before = await raw(s), used = allocation.mock.calls.length;
            expect(e.prepared.result).toEqual({ count: selected.length, status }); expect(e.prepared.scope.tasks.some(row => row.id === 'unrelated')).toBe(false);
            expect(value(s.host.validatePreparedProjectTasksMove(e))).toEqual(e.prepared.result); expect(await raw(s)).toEqual(before);
            value(await s.host.commitPreparedProjectTasksMove(e)); expect(await raw(s)).toEqual(expected); expect(allocation).toHaveBeenCalledTimes(used);
            expect(await s.receiptIds()).toEqual([WRITE]); allocation.mockRestore();
        } finally { await s.close(); }
    });
    it('prepares and stamps an all-already-target selection exactly like RN instead of filtering it into no-op', async () => {
        clock(); const f = seed(); const rn = await openSqliteHost(f); let expected: unknown;
        try { await useTaskStore.getState().batchMoveTasks(['waiting'], 'waiting'); await flushPendingSave(); expected = await raw(rn); } finally { await rn.close(); }
        const s = await openSqliteHost(f);
        try { const e = await prepare(s, request('waiting', ['waiting'])); expect(e.prepared.result.count).toBe(1);
            expect(e.prepared.effect.tasks.map(row => row.before.id)).toEqual(['waiting']); value(await s.host.commitPreparedProjectTasksMove(e));
            expect(await raw(s)).toEqual(expected); expect(useTaskStore.getState()._tasksById.get('waiting')?.rev).toBe(3);
        } finally { await s.close(); }
    });
    it('preserves Unicode selected identities and text through the real RN batch seam', async () => {
        clock(); const id = 'e\u0301-雪-😀', f = seed(); f.tasks = [task(id, { title: '雪 e\u0301 😀' })];
        const rn = await openSqliteHost(f); let expected: unknown;
        try { await useTaskStore.getState().batchMoveTasks([id], 'reference'); await flushPendingSave(); expected = await raw(rn); } finally { await rn.close(); }
        const s = await openSqliteHost(f);
        try { const e = await prepare(s, request('reference', [id])); value(await s.host.commitPreparedProjectTasksMove(e)); expect(await raw(s)).toEqual(expected); }
        finally { await s.close(); }
    });
    it('uses the actual filtered/collapsed/read-only Project selection and keeps legacy sources closed', async () => {
        clock(); const f = seed(); f.projects![1].status = 'archived'; const s = await openSqliteHost(f);
        try { const before = await raw(s);
            for (const [taskIds, scope] of [[['done'], { ...params, completedCollapsed: true }], [['archived'], { ...params, showCompleted: false }],
                [['next'], { ...params, filters: { tokens: ['#missing'] } }], [['reference'], params], [['unrelated'], params]] as const) {
                const input = request('next', [...taskIds], scope as typeof params);
                expect(await s.host.prepareProjectTasksMove(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            }
            const valid = request('next', ['waiting']); expect(readReferenceTasksMoveEnvelope({ request: valid, prepared: {} })).toBeNull();
            expect(await s.host.prepareInboxTasksMove(valid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await s.host.prepareReferenceTasksMove(valid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it('refuses malformed extra keys, wrong source, unsupported targets and oversized selections', async () => {
        clock(); const s = await openSqliteHost(seed());
        try { const good = request('waiting', ['next']), before = await raw(s);
            for (const input of [{ ...good, extra: true }, { ...good, source: 'inbox' }, { ...good, status: 'archived' },
                { ...good, params: { ...params, filterSheetOpen: true } }, { ...good, params: { ...params, offset: 0 } },
                { ...good, params: { ...params, filters: { projects: ['foreign'] } } }, { ...good, taskIds: Array(10_001).fill('next') },
                { ...good, taskRevisions: { ...good.taskRevisions, extra: 'rev' } }])
                expect(await s.host.prepareProjectTasksMove(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['row', 'project', 'section', 'settings', 'area', 'tag-reference'] as const)('rejects whole selection after same-revision %s dependency drift', async part => {
        clock(); const s = await openSqliteHost(seed());
        try { const e = await prepare(s, request('next', ['waiting', 'reference']));
            if (part === 'row') await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Drift', 'waiting']);
            if (part === 'project') await s.client().run('UPDATE projects SET tagIds=? WHERE id=?', ['[]', 'project']);
            if (part === 'section') await s.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
            if (part === 'settings') await s.client().run("UPDATE settings SET data=json_set(data,'$.features.priorities',json('true')) WHERE id=1");
            if (part === 'area') await s.client().run('UPDATE areas SET name=? WHERE id=?', ['Changed', 'area']);
            if (part === 'tag-reference') await s.client().run('UPDATE tasks SET tags=? WHERE id=?', ['[]', 'reference']);
            const before = await raw(s); expect(await s.host.commitPreparedProjectTasksMove(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
        } finally { await s.close(); }
    });
    it('does not accept an omitted unselected list dependency at the saved authority boundary', async () => {
        clock(); const s = await openSqliteHost(seed());
        try { const e = await prepare(s, request('waiting', ['waiting'])); const forged = structuredClone(e);
            forged.prepared.scope.tasks = forged.prepared.scope.tasks.filter(row => row.id !== 'inbox');
            const before = await raw(s); expect(await s.host.commitPreparedProjectTasksMove(forged)).toMatchObject({ ok: false }); expect(await raw(s)).toEqual(before);
            expect(readTasksMoveEnvelope(e, 'inbox')).toBeNull();
        } finally { await s.close(); }
    });
    it('refuses an unselected Reference newly joining the tag-linked list after preparation', async () => {
        clock(); const f = seed(); f.tasks!.push(task('joining', { status: 'reference', projectId: 'unrelated', sectionId: undefined }));
        const s = await openSqliteHost(f);
        try { const e = await prepare(s, request('next', ['waiting']));
            expect(e.prepared.scope.tasks.some(row => row.id === 'joining')).toBe(false);
            await s.client().run('UPDATE tasks SET tags=? WHERE id=?', ['["#match"]', 'joining']); const before = await raw(s);
            expect(await s.host.commitPreparedProjectTasksMove(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['datetime', 'date-only'] as const)('freezes %s normalization through unlanded and saved cold replay in another zone', async kind => {
        vi.stubEnv('TZ', 'UTC'); clock(); vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z')); const f = seed();
        f.tasks = [task('queued', { status: kind === 'datetime' ? 'reference' : 'next', isFocusedToday: true,
            startTime: kind === 'datetime' ? '2026-11-02T06:00:00.000Z' : '2026-11-03' })];
        const s = await openSqliteHost(f);
        try { const e = await prepare(s, request(kind === 'datetime' ? 'next' : 'waiting', ['queued'])), frozen = JSON.stringify(e);
            vi.stubEnv('TZ', kind === 'datetime' ? 'America/New_York' : 'Asia/Tokyo'); await s.restart(undefined, { recoveryLoad: true });
            expect(value(s.host.validatePreparedProjectTasksMove(e))).toEqual(e.prepared.result); value(await s.host.commitPreparedProjectTasksMove(e));
            const before = await raw(s); await s.restart(undefined, { recoveryLoad: true });
            expect(value(s.host.projectTasksMoveOutcome(e))).toEqual(e.prepared.result); value(await s.host.commitPreparedProjectTasksMove(e));
            expect(await raw(s)).toEqual(before); expect(JSON.stringify(e)).toBe(frozen);
        } finally { await s.close(); }
    });
    it('freezes recurrence UUIDs through two failed saves, WAL-aware cold replay and saved retry after later edits', async () => {
        clock(); const fault = { commits: 0 }, s = await openSqliteHost(seed(), c => ({ ...c, run: async (sql, args) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Project Move failed COMMIT'); } return c.run(sql, args);
        } }));
        try { const allocation = ids(), e = await prepare(s, request('done', ['next', 'reference', 'archived'])); allocation.mockRestore();
            const before = await raw(s), frozen = JSON.stringify(e); await flushPendingSave(); await s.client().all('PRAGMA wal_checkpoint(TRUNCATE)');
            const image = join(s.dir, 'before-project.db'); copyFileSync(join(s.dir, 'mindwtr.db'), image);
            const forbidAllocation = () => vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('UUID reallocated during replay'); });
            let trap = forbidAllocation();
            for (let n = 0; n < 2; n++) { fault.commits = 8; expect(await s.host.commitPreparedProjectTasksMove(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(s)).toEqual(before); }
            fault.commits = 0; value(await s.host.commitPreparedProjectTasksMove(e)); const uninterrupted = await raw(s);
            expect(trap).not.toHaveBeenCalled(); trap.mockRestore();
            await s.restart(image, { recoveryLoad: true }); trap = forbidAllocation(); value(await s.host.commitPreparedProjectTasksMove(e)); expect(await raw(s)).toEqual(uninterrupted);
            expect(trap).not.toHaveBeenCalled(); trap.mockRestore();
            await s.client().run('UPDATE tasks SET description=? WHERE id=?', ['Later edit', 'next']); await s.restart(undefined, { recoveryLoad: true }); trap = forbidAllocation(); const later = await raw(s);
            expect(value(s.host.projectTasksMoveOutcome(e))).toEqual(e.prepared.result); value(await s.host.commitPreparedProjectTasksMove(e));
            expect(await raw(s)).toEqual(later); expect(await s.receiptIds()).toEqual([WRITE]); expect(JSON.stringify(e)).toBe(frozen); expect(trap).not.toHaveBeenCalled();
        } finally { fault.commits = 0; await s.close(); }
    }, 25_000);
});
