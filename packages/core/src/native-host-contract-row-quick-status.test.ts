import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskRevisionOf } from './native-request-receipts';
import type { AppData, Task } from './types';
import type { NativeRowQuickStatusRequest } from './native-host-contract-task-checklist';

const NOW = '2026-11-02T12:00:00.000Z', WRITE = '00000000-0000-4000-8000-000000000901';
const targets = ['inbox', 'next', 'waiting', 'someday', 'reference'] as const;
const sources = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference', 'cancelled'] as const;
type Source = typeof sources[number];
const task = (status: Source, extra: Partial<Task> = {}): Task => ({ id: 'source', title: 'Private source',
    status: status === 'cancelled' ? 'archived' : status, createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a',
    ...(status === 'done' ? { completedAt: NOW } : status === 'cancelled' ? { cancelledAt: NOW, archivedAt: NOW } : {}),
    projectId: 'project', sectionId: 'section', tags: ['#kept'], contexts: ['@kept'], priority: 'urgent',
    description: 'Retain notes', timeSpentMinutes: 17, reminderPolicy: 'inherit', pushCount: 2,
    checklist: [{ id: 'one', title: 'First', isCompleted: true }, { id: 'two', title: 'Second', isCompleted: false }],
    attachments: [{ id: 'link', kind: 'link', title: 'Retain', uri: 'https://example.com', createdAt: NOW }], ...extra });
const seed = (status: Source = 'next', extra: Partial<Task> = {}): Partial<AppData> => ({ tasks: [task(status, extra)],
    projects: [{ id: 'project', title: 'Project', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'project', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: WRITE, gtd: { focusTaskLimit: 3 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const request = (status: NativeRowQuickStatusRequest['status'] = 'waiting'): NativeRowQuickStatusRequest => ({
    id: 'source', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!), requestId: WRITE, status });
const raw = async (s: Sqlite) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'].map(async table => [table, await s.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const prepare = async (s: Sqlite, r = request()) => {
    const plan = value(await s.host.prepareRowQuickStatusWrite(r));
    if (plan.kind !== 'prepared') throw new Error('Expected a changed status');
    return { request: r, prepared: plan.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('raw RN row quick status', () => {
    it.each(sources.flatMap(source => targets.map(target => ({ source, target }))))('matches RN $source → $target including rich saved metadata', async ({ source, target }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed(source);
        const rn = await openSqliteHost(fixture); let expected: Awaited<ReturnType<typeof raw>>;
        try { if (source === target) expected = await raw(rn);
            else { expect((await useTaskStore.getState().updateTask('source', { status: target })).success).toBe(true); await flushPendingSave(); expected = await raw(rn); }
        } finally { await rn.close(); }
        const s = await openSqliteHost(fixture);
        try { const r = request(target), before = await raw(s); const plan = value(await s.host.prepareRowQuickStatusWrite(r));
            if (source === target) { expect(plan).toEqual({ kind: 'unchanged', result: { id: 'source' } }); expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]); }
            else { expect(plan.kind).toBe('prepared'); if (plan.kind !== 'prepared') throw new Error('Missing prepared status');
                const e = { request: r, prepared: plan.prepared };
                if (process.env.ROW_QUICK_STATUS_EXPORT_DIR && source === 'cancelled' && target === 'next') writeFileSync(join(process.env.ROW_QUICK_STATUS_EXPORT_DIR, 'envelope-cancelled-next.json'), JSON.stringify(e, null, 2));
                expect(value(s.host.validatePreparedRowQuickStatusWrite(e))).toEqual({ id: 'source' }); expect(await raw(s)).toEqual(before);
                value(await s.host.commitPreparedRowQuickStatusWrite(e)); expect(await raw(s)).toEqual(expected!); expect(await s.receiptIds()).toEqual([WRITE]);
            }
        } finally { await s.close(); }
    });
    it.each(['done', 'cancelled'] as const)('reopens an all-checked recurring list from %s without recomputing its checkbox status or making a child', async source => {
        const fixture = seed(source, { taskMode: 'list', recurrence: { rule: 'daily', strategy: 'strict' }, dueDate: '2026-11-02',
            checklist: [{ id: 'one', title: 'Keep checked', isCompleted: true }] });
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const rn = await openSqliteHost(fixture); let expected: unknown;
        try { await useTaskStore.getState().updateTask('source', { status: 'next' }); await flushPendingSave(); expected = await raw(rn); } finally { await rn.close(); }
        const s = await openSqliteHost(fixture);
        try { const e = await prepare(s, request('next')); value(await s.host.commitPreparedRowQuickStatusWrite(e)); expect(await raw(s)).toEqual(expected);
            expect(useTaskStore.getState()._allTasks).toHaveLength(1); expect(useTaskStore.getState()._tasksById.get('source')).toMatchObject({ status: 'next', checklist: [{ isCompleted: true }] });
        } finally { await s.close(); }
    });
    it.each(['done', 'reference', 'cancelled'] as const)('matches actual RN Focus-cap admission from hidden-star %s including future starts', async source => {
        for (const future of [false, true]) {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
            const f = seed(source, { isFocusedToday: true, ...(future ? { startTime: '2026-11-03' } : {}) });
            f.tasks!.push(...[1, 2, 3].map(i => ({ ...task('next'), id: `focus-${i}`, isFocusedToday: true })));
            const rn = await openSqliteHost(f); let success: boolean; let expected: unknown;
            try { const result = await useTaskStore.getState().updateTask('source', { status: 'next' }); success = result.success; await flushPendingSave(); expected = await raw(rn); } finally { await rn.close(); }
            const s = await openSqliteHost(f);
            try { const planned = await s.host.prepareRowQuickStatusWrite(request('next'));
                if (!success!) expect(planned).toMatchObject({ ok: false });
                else { const plan = value(planned); if (plan.kind !== 'prepared') throw new Error('Expected status change'); value(await s.host.commitPreparedRowQuickStatusWrite({ request: plan.prepared.request, prepared: plan.prepared })); }
                expect(await raw(s)).toEqual(expected);
            } finally { await s.close(); }
        }
    });
    it.each(['unlanded', 'saved'].flatMap(stage => ['datetime', 'date-only'].map(kind => ({ stage, kind }))))('keeps the frozen Focus boundary across timezone changes for $stage $kind exact replay', async ({ stage, kind }) => {
        const at = kind === 'datetime' ? '2026-11-02T02:00:00.000Z' : NOW;
        vi.stubEnv('TZ', 'UTC'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
        const s = await openSqliteHost(seed(kind === 'datetime' ? 'reference' : 'next', { createdAt: at, updatedAt: at,
            isFocusedToday: true, startTime: kind === 'datetime' ? '2026-11-02T06:00:00.000Z' : '2026-11-03' }));
        try {
            const e = await prepare(s, request(kind === 'datetime' ? 'next' : 'waiting')), frozen = JSON.stringify(e);
            expect(e.prepared.effect.guards.focusCount).toBe(kind === 'datetime' ? 0 : null);
            expect(value(s.host.validatePreparedRowQuickStatusWrite(e))).toEqual({ id: 'source' });
            if (stage === 'saved') value(await s.host.commitPreparedRowQuickStatusWrite(e));
            const before = await raw(s);
            vi.stubEnv('TZ', kind === 'datetime' ? 'America/New_York' : 'Asia/Tokyo');
            expect(value(s.host.validatePreparedRowQuickStatusWrite(e))).toEqual({ id: 'source' });
            expect(value(s.host.rowQuickStatusOutcome(e))).toEqual(stage === 'saved' ? { id: 'source' } : null);
            value(await s.host.commitPreparedRowQuickStatusWrite(e));
            expect(value(s.host.rowQuickStatusOutcome(e))).toEqual({ id: 'source' });
            expect(JSON.stringify(e)).toBe(frozen); expect(await s.receiptIds()).toEqual([WRITE]);
            if (stage === 'saved') expect(await raw(s)).toEqual(before);
            expect(useTaskStore.getState()._tasksById.get('source')).toMatchObject(kind === 'datetime'
                ? { status: 'next', isFocusedToday: true } : { status: 'waiting', isFocusedToday: false });
        } finally { await s.close(); }
    });
    it('reads six options/current selection without writing and seals the new read shape', async () => {
        const s = await openSqliteHost(seed('reference'));
        try { const before = await raw(s); const r = request(); const options = value(await s.host.getRowQuickStatusOptions({ id: r.id, taskRevision: r.taskRevision }));
            expect(Object.keys(options).sort()).toEqual(['options', 'status', 'taskId', 'taskRevision', 'title']);
            expect(options.status).toBe('reference'); expect(options.options.map(o => o.status)).toEqual(['inbox', 'next', 'waiting', 'someday', 'done', 'reference']);
            expect(options.options.filter(o => o.selected).map(o => o.status)).toEqual(['reference']); expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['source', 'project', 'section', 'settings'] as const)('refuses unlanded same-revision raw drift in %s', async part => {
        const s = await openSqliteHost(seed('reference', { isFocusedToday: true }));
        try { const e = await prepare(s, request('next'));
            if (part === 'source') await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Drift', 'source']);
            if (part === 'project') await s.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'project']);
            if (part === 'section') await s.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
            if (part === 'settings') { const row = (await s.sql<{ data: string }>('SELECT data FROM settings'))[0]; const data = JSON.parse(row.data); data.gtd.focusTaskLimit = 2;
                await s.client().run('UPDATE settings SET data=?', [JSON.stringify(data)]); }
            const before = await raw(s); expect(await s.host.commitPreparedRowQuickStatusWrite(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it('rejects target Done, malformed requests, stale reads and forged non-status changes', async () => {
        const s = await openSqliteHost(seed());
        try { const e = await prepare(s), before = await raw(s);
            for (const input of [{ ...request(), status: 'done' }, { ...request(), source: 'reference' }, { ...request(), taskRevision: 'stale' }, { ...request(), requestId: 'bad' }])
                expect(await s.host.prepareRowQuickStatusWrite(input as NativeRowQuickStatusRequest)).toMatchObject({ ok: false });
            expect(await s.host.getRowQuickStatusOptions({ id: 'source', taskRevision: 'stale' })).toMatchObject({ ok: false });
            for (const mutate of [(x: typeof e) => { x.prepared.witness.direct.title = 'forged'; }, (x: typeof e) => { x.prepared.effect.tasks[0].after.title = 'forged'; },
                (x: typeof e) => { x.prepared.rawBefore.tasks[0].before!.title = 'forged'; }, (x: typeof e) => { x.prepared.request.status = 'reference'; }]) {
                const forged = structuredClone(e); mutate(forged); expect(s.host.validatePreparedRowQuickStatusWrite(forged)).toMatchObject({ ok: false }); expect(await s.host.commitPreparedRowQuickStatusWrite(forged)).toMatchObject({ ok: false });
            }
            expect(s.host.validatePreparedTaskChecklistWrite(e as never)).toMatchObject({ ok: false });
            expect(s.host.validatePreparedInlineChecklistWrite(e as never)).toMatchObject({ ok: false });
            expect(s.host.validatePreparedDoneTaskStatus(e as never)).toMatchObject({ ok: false });
            expect(s.host.validatePreparedReferenceProjectNextAction(e as never)).toMatchObject({ ok: false });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['deleted', 'purged', 'parent', 'section'] as const)('refuses unavailable source %s before writes', async why => {
        const f = seed(); if (why === 'deleted') f.tasks![0].deletedAt = NOW; if (why === 'purged') f.tasks![0].purgedAt = NOW;
        if (why === 'parent') f.projects![0].status = 'archived'; if (why === 'section') f.sections![0].deletedAt = NOW;
        const s = await openSqliteHost(f);
        try { const before = await raw(s); expect(await s.host.prepareRowQuickStatusWrite({ id: 'source', taskRevision: taskRevisionOf(f.tasks![0]), requestId: WRITE, status: 'waiting' })).toMatchObject({ ok: false }); expect(await raw(s)).toEqual(before); } finally { await s.close(); }
    });
    it('retains failed status effect across WAL-aware cold replay and acknowledges after later edits', async () => {
        const fault = { commits: 0 }; const s = await openSqliteHost(seed('cancelled'), c => ({ ...c, run: async (sql, p) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('row quick status COMMIT failure'); } return c.run(sql, p);
        } }));
        try { const e = await prepare(s, request('next')); const frozen = JSON.stringify(e); const before = await raw(s);
            await flushPendingSave(); await s.client().all('PRAGMA wal_checkpoint(TRUNCATE)'); const image = join(s.dir, 'before.db'); copyFileSync(join(s.dir, 'mindwtr.db'), image);
            fault.commits = 8; expect(await s.host.commitPreparedRowQuickStatusWrite(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(s)).toEqual(before);
            fault.commits = 0; value(await s.host.commitPreparedRowQuickStatusWrite(e)); await s.restart(image, { recoveryLoad: true }); expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
            value(await s.host.commitPreparedRowQuickStatusWrite(e)); expect(JSON.stringify(e)).toBe(frozen); expect(await s.receiptIds()).toEqual([WRITE]);
            await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Later', 'source']); await s.restart(undefined, { recoveryLoad: true }); const later = await raw(s);
            expect(value(s.host.rowQuickStatusOutcome(e))).toEqual({ id: 'source' }); value(await s.host.commitPreparedRowQuickStatusWrite(e)); expect(await raw(s)).toEqual(later);
        } finally { fault.commits = 0; await s.close(); }
    });
});
