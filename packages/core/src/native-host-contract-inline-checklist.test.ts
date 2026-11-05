import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskRevisionOf } from './native-request-receipts';
import type { AppData, Task } from './types';
import type { NativeInlineChecklistRequest } from './native-host-contract-task-checklist';

const NOW = '2026-11-02T12:00:00.000Z';
const WRITE = '00000000-0000-4000-8000-000000000801';
const source = (extra: Partial<Task> = {}): Task => ({ id: 'source', title: 'Private source', status: 'next',
    createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a', tags: [], contexts: [],
    projectId: 'project', sectionId: 'section', checklist: [
        { id: 'one', title: 'Private first', isCompleted: false }, { id: 'two', title: 'Second', isCompleted: true }], ...extra });
const seed = (extra: Partial<Task> = {}): Partial<AppData> => ({ tasks: [source(extra)],
    projects: [{ id: 'project', title: 'Project', status: 'active', color: '#123456', order: 0,
        tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'project', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', gtd: { focusTaskLimit: 3 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const request = (action: 'setCompleted' | 'append' = 'setCompleted'): NativeInlineChecklistRequest => ({
    id: 'source', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!), requestId: WRITE,
    ...(action === 'append' ? { action, title: '  Café e\u0301 + new  ' } : { action, itemId: 'one', isCompleted: true }) });
const prepare = async (sqlite: Sqlite, input = request()) => {
    const planned = value(await sqlite.host.prepareInlineChecklistWrite(input));
    if (planned.kind !== 'prepared') throw new Error('Expected prepared row edit');
    return { request: input, prepared: planned.prepared };
};
const raw = async (s: Sqlite) => Promise.all(['tasks', 'projects', 'sections', 'settings', 'native_request_receipts'].map(t => s.sql(`SELECT * FROM ${t} ORDER BY rowid`)));
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('inline checklist durable row edits', () => {
    it.each(['setCompleted', 'append'] as const)('persists %s and proves saved outcome after cold later edits', async action => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const s = await openSqliteHost(seed());
        try {
            const before = await raw(s); const envelope = await prepare(s, request(action));
            if (process.env.INLINE_CHECKLIST_EXPORT_DIR) writeFileSync(join(process.env.INLINE_CHECKLIST_EXPORT_DIR, `envelope-${action}.json`), JSON.stringify(envelope, null, 2));
            expect(value(s.host.validatePreparedInlineChecklistWrite(envelope))).toEqual({ id: 'source' });
            expect(value(s.host.inlineChecklistOutcome(envelope))).toBeNull();
            expect(await raw(s)).toEqual(before);
            expect(value(await s.host.commitPreparedInlineChecklistWrite(envelope))).toEqual({ id: 'source' });
            const saved = useTaskStore.getState()._tasksById.get('source')!;
            expect(saved.status).toBe('next');
            if (action === 'append') expect(saved.checklist).toHaveLength(3);
            else expect(saved.checklist![0].isCompleted).toBe(true);
            expect(await s.receiptIds()).toEqual([WRITE]);
            const receipt = await s.sql<{ method: string }>('SELECT method FROM native_request_receipts');
            expect(receipt[0].method).toMatch(/^iosInlineChecklist:/);
            await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Later private title', 'source']);
            await s.restart(undefined, { recoveryLoad: true }); const later = await raw(s);
            expect(value(s.host.inlineChecklistOutcome(envelope))).toEqual({ id: 'source' });
            expect(value(await s.host.commitPreparedInlineChecklistWrite(envelope))).toEqual({ id: 'source' });
            expect(await raw(s)).toEqual(later);
        } finally { await s.close(); }
    });
    it.each([false, true])('matches shared list-mode completion and recurrence: %s', async recurring => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fixture = seed({ taskMode: 'list', ...(recurring ? { dueDate: '2026-11-02', recurrence: { rule: 'daily', strategy: 'strict' } } : {}) });
        const rn = await openSqliteHost(fixture); let expected: unknown;
        try {
            const t = useTaskStore.getState()._tasksById.get('source')!;
            expect((await useTaskStore.getState().updateTask(t.id, { checklist: t.checklist!.map(i => ({ ...i, isCompleted: true })), status: 'done' })).success).toBe(true);
            await flushPendingSave(); expected = await rn.sql('SELECT id,status,completedAt,dueDate,checklist FROM tasks ORDER BY id');
        } finally { await rn.close(); }
        const s = await openSqliteHost(fixture);
        try {
            const envelope = await prepare(s); value(await s.host.commitPreparedInlineChecklistWrite(envelope));
            const actual = await s.sql('SELECT id,status,completedAt,dueDate,checklist FROM tasks ORDER BY id');
            const semantic = (rows: typeof actual) => rows.map(row => ({ ...row, id: row.id === 'source' ? 'source' : 'child',
                checklist: JSON.parse(row.checklist as string).map((item: { id: string; title: string; isCompleted: boolean }) => row.id === 'source' ? item : { title: item.title, isCompleted: item.isCompleted }) }));
            expect(semantic(actual)).toEqual(semantic(expected as typeof actual));
        } finally { await s.close(); }
    });
    it('retains the frozen recurrence clock instead of preparing again on late commit', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const s = await openSqliteHost(seed({ taskMode: 'list', dueDate: '2026-11-02', recurrence: { rule: 'daily', strategy: 'strict' } }));
        try { const e = await prepare(s); const frozen = JSON.stringify(e);
            vi.setSystemTime(new Date('2026-12-02T12:00:00.000Z'));
            value(await s.host.commitPreparedInlineChecklistWrite(e)); expect(JSON.stringify(e)).toBe(frozen);
            const child = useTaskStore.getState()._allTasks.find(task => task.id !== 'source');
            expect(child).toMatchObject({ status: 'next', dueDate: '2026-11-03' });
        } finally { await s.close(); }
    });
    it('appends to a Done list and reopens it through shared policy', async () => {
        const s = await openSqliteHost(seed({ status: 'done', taskMode: 'list', completedAt: NOW,
            checklist: source().checklist!.map(i => ({ ...i, isCompleted: true })) }));
        try { const e = await prepare(s, request('append')); value(await s.host.commitPreparedInlineChecklistWrite(e));
            expect(useTaskStore.getState()._tasksById.get('source')).toMatchObject({ status: 'next' });
        } finally { await s.close(); }
    });
    it('returns unchanged for an already-set item without a write', async () => {
        const s = await openSqliteHost(seed());
        try { const before = await raw(s); expect(value(await s.host.prepareInlineChecklistWrite({ ...request(), action: 'setCompleted', itemId: 'two', isCompleted: true })))
            .toEqual({ kind: 'unchanged', result: { id: 'source' } }); expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['reference', 'deleted', 'purged', 'archivedProject', 'deletedSection', 'empty', 'duplicate'] as const)('refuses unavailable source: %s', async kind => {
        const f = seed(); const t = f.tasks![0];
        if (kind === 'reference') t.status = 'reference';
        if (kind === 'deleted') t.deletedAt = NOW;
        if (kind === 'purged') t.purgedAt = NOW;
        if (kind === 'archivedProject') f.projects![0].status = 'archived';
        if (kind === 'deletedSection') f.sections![0].deletedAt = NOW;
        if (kind === 'empty') t.checklist = [];
        if (kind === 'duplicate') t.checklist![1].id = 'one';
        const s = await openSqliteHost(f);
        try { const before = await raw(s); const input = { id: 'source', taskRevision: taskRevisionOf(t), requestId: WRITE, action: 'append' as const, title: 'new' };
            expect(await s.host.prepareInlineChecklistWrite(input)).toMatchObject({ ok: false }); expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it('refuses stale revision without dropping a concurrent checklist addition', async () => {
        const s = await openSqliteHost(seed());
        try { const input = request(); value(await s.host.prepareInlineChecklistWrite(input));
            const t = useTaskStore.getState()._tasksById.get('source')!;
            await useTaskStore.getState().updateTask(t.id, { checklist: [...t.checklist!, { id: 'concurrent', title: 'Keep', isCompleted: false }] });
            await flushPendingSave(); const before = await raw(s);
            expect(await s.host.prepareInlineChecklistWrite(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['source', 'project', 'section', 'settings'] as const)('rejects unlanded raw same-revision drift: %s', async kind => {
        const s = await openSqliteHost(seed({ taskMode: 'list' }));
        try { const e = await prepare(s);
            if (kind === 'source') await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Drift', 'source']);
            if (kind === 'project') await s.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'project']);
            if (kind === 'section') await s.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
            if (kind === 'settings') { const row = (await s.sql<{ data: string }>('SELECT data FROM settings'))[0]; const data = JSON.parse(row.data); data.deviceId = 'other'; await s.client().run('UPDATE settings SET data=?', [JSON.stringify(data)]); }
            const before = await raw(s); expect(await s.host.commitPreparedInlineChecklistWrite(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it('rejects malformed requests and forged unrelated edits before SQL', async () => {
        const s = await openSqliteHost(seed());
        try { const e = await prepare(s, request('append')); const before = await raw(s);
            for (const input of [{ ...request(), extra: true }, { ...request(), itemId: 'missing' }, { ...request('append'), title: '  ' }, { ...request(), requestId: 'bad' }])
                expect(await s.host.prepareInlineChecklistWrite(input as NativeInlineChecklistRequest)).toMatchObject({ ok: false });
            for (const mutate of [(v: typeof e) => { v.prepared.checklist.request.patch = { title: 'forged' }; },
                (v: typeof e) => { v.prepared.checklist.effect.tasks[0].after.title = 'forged'; },
                (v: typeof e) => { v.prepared.rawBefore.tasks[0].before!.title = 'forged'; },
                (v: typeof e) => { v.prepared.checklist.request.checklist.value[0].title = 'forged'; }]) {
                const forged = structuredClone(e); mutate(forged);
                expect(s.host.validatePreparedInlineChecklistWrite(forged)).toMatchObject({ ok: false });
                expect(await s.host.commitPreparedInlineChecklistWrite(forged)).toMatchObject({ ok: false });
            }
            expect(s.host.validatePreparedTaskChecklistWrite(e as never)).toMatchObject({ ok: false });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it('retains exact append through failed COMMIT and cold replay without duplication', async () => {
        const fault = { commits: 0 }; const s = await openSqliteHost(seed(), c => ({ ...c, run: async (sql, p) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('inline owned COMMIT failure'); }
            return c.run(sql, p);
        } }));
        try { const e = await prepare(s, request('append')); const frozen = JSON.stringify(e); const before = await raw(s);
            await flushPendingSave(); await s.client().all('PRAGMA wal_checkpoint(TRUNCATE)');
            const checkpoint = join(s.dir, 'before.db'); copyFileSync(join(s.dir, 'mindwtr.db'), checkpoint);
            fault.commits = 8; expect(await s.host.commitPreparedInlineChecklistWrite(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(s)).toEqual(before); expect(JSON.stringify(e)).toBe(frozen);
            fault.commits = 0; value(await s.host.commitPreparedInlineChecklistWrite(e));
            await s.restart(checkpoint, { recoveryLoad: true }); expect(await raw(s)).toEqual(before); value(await s.host.commitPreparedInlineChecklistWrite(e));
            expect(useTaskStore.getState()._tasksById.get('source')!.checklist).toHaveLength(3);
            expect(await s.receiptIds()).toEqual([WRITE]);
        } finally { fault.commits = 0; await s.close(); }
    });
});
