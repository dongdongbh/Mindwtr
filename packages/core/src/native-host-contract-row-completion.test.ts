import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskRevisionOf } from './native-request-receipts';
import { undoTaskCompletion } from './undo-task-completion';
import type { AppData, Task } from './types';
import type { NativeTaskCompletionEnvelope } from './native-host-contract-task-checklist';

const NOW = '2026-11-02T12:00:00.000Z', OLD = '2026-10-12T12:00:00.000Z';
const WRITE = '00000000-0000-4000-8000-000000000911', UNDO = '00000000-0000-4000-8000-000000000912';
const NEXT = '00000000-0000-4000-8000-000000000913';
const task = (extra: Partial<Task> = {}): Task => ({ id: 'source', title: 'Private archived task', status: 'archived',
    projectId: 'project', sectionId: 'section', order: 2, orderNum: 2, createdAt: OLD, updatedAt: OLD,
    rev: 2, revBy: 'device-a', completedAt: OLD, archivedAt: OLD, tags: ['#retain'], contexts: ['@retain'],
    description: 'Private notes', priority: 'high', timeEstimate: '30min', timeSpentMinutes: 17,
    dueDate: '2026-11-04', reminderPolicy: 'inherit', dueReminderLeadMinutes: 0,
    checklist: [{ id: 'one', title: 'Private item', isCompleted: true }, { id: 'two', title: 'Other item', isCompleted: false }],
    attachments: [{ id: 'link', kind: 'link', title: 'Private link', uri: 'https://example.com', createdAt: OLD }], ...extra });
const seed = (extra: Partial<Task> = {}): Partial<AppData> => ({ tasks: [task(extra)],
    projects: [{ id: 'project', title: 'Project', status: 'active', order: 0, color: '#94a3b8', tagIds: [],
        createdAt: OLD, updatedAt: OLD, rev: 1, revBy: 'device-a' }],
    sections: [{ id: 'section', title: 'Section', projectId: 'project', order: 0, createdAt: OLD, updatedAt: OLD }],
    settings: { deviceId: 'device-a', analyticsProfileId: WRITE, gtd: { autoArchiveDays: 0, focusTaskLimit: 3 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (s: Sqlite) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'].map(async table => [table, await s.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const request = () => ({ id: 'source', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!), requestId: WRITE, source: 'row' as const });
const prepare = async (s: Sqlite) => {
    const input = request(); return { request: input, prepared: value(await s.host.prepareTaskCompletion(input)).prepared };
};
const prepareUndo = async (s: Sqlite, completion: NativeTaskCompletionEnvelope) => {
    const input = { requestId: UNDO, completionRequestId: WRITE };
    return { request: input, prepared: value(await s.host.prepareTaskCompletionUndo({ request: input, completion })).prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('archived shared-row completion', () => {
    it.each(['archived', 'cancelled'].flatMap(source => [false, true].flatMap(list => [false, true].map(recurring => ({ source, list, recurring })))))('matches actual RN completion and Undo for $source list=$list recurring=$recurring', async ({ source, list, recurring }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fixture = seed({ ...(source === 'cancelled' ? { cancelledAt: OLD, completedAt: undefined } : {}),
            ...(list ? { taskMode: 'list', checklist: [{ id: 'one', title: 'Retain checked', isCompleted: true }] } : {}),
            ...(recurring ? { recurrence: { rule: 'daily', strategy: 'after-completion' } } : {}) });
        const rn = await openSqliteHost(fixture); let completed: unknown, undone: unknown;
        try {
            expect((await useTaskStore.getState().updateTask('source', { status: 'done' })).success).toBe(true);
            await flushPendingSave(); completed = await raw(rn);
            await useTaskStore.getState().updateTask('source', { description: 'Later note' }); await flushPendingSave();
            vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
            await undoTaskCompletion('source', 'archived', false); await flushPendingSave(); undone = await raw(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const s = await openSqliteHost(fixture);
        try {
            const e = await prepare(s), before = await raw(s);
            expect(e.prepared).toMatchObject({ version: 2, kind: 'rowComplete' });
            expect(Object.keys(e.prepared).sort()).toEqual(['checklist', 'kind', 'notice', 'rawBefore', 'request', 'result', 'version']);
            expect(value(s.host.validatePreparedTaskCompletion(e))).toEqual(e.prepared.result); expect(await raw(s)).toEqual(before);
            value(await s.host.commitPreparedTaskCompletion(e)); expect(await raw(s)).toEqual(completed);
            expect(useTaskStore.getState()._allTasks).toHaveLength(1);
            expect(useTaskStore.getState()._tasksById.get('source')).toMatchObject({ status: 'done', completedAt: source === 'cancelled' ? NOW : OLD });
            if (process.env.ROW_COMPLETION_EXPORT_DIR && source === 'cancelled' && list && recurring)
                writeFileSync(join(process.env.ROW_COMPLETION_EXPORT_DIR, 'row-completion.json'), JSON.stringify(e, null, 2));
            await useTaskStore.getState().updateTask('source', { description: 'Later note' }); await flushPendingSave();
            vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
            const u = await prepareUndo(s, e);
            expect(u.prepared).toMatchObject({ version: 2, kind: 'rowCompleteUndo' });
            expect(value(s.host.validatePreparedTaskCompletionUndo(u))).toEqual({ id: 'source' });
            value(await s.host.commitPreparedTaskCompletionUndo(u)); expect(await raw(s)).toEqual(undone);
            const after = useTaskStore.getState()._tasksById.get('source')!;
            expect(after).toMatchObject({ status: 'archived', description: 'Later note' }); expect(after.cancelledAt).toBeUndefined();
            expect(await s.receiptIds()).toEqual([WRITE, UNDO]);
        } finally { await s.close(); }
    });
    it('keeps legacy archived completion fallback and no recurrence child', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const s = await openSqliteHost(seed({ completedAt: undefined, recurrence: { rule: 'daily' } }));
        try { const e = await prepare(s); value(await s.host.commitPreparedTaskCompletion(e));
            expect(useTaskStore.getState()._allTasks).toHaveLength(1);
            expect(e.prepared.result.completion.completedAt).toBe(OLD);
        } finally { await s.close(); }
    });
    it.each(['inbox', 'next', 'waiting', 'someday', 'done', 'reference'] as const)('refuses source=row from %s without broadening existing routes', async status => {
        const s = await openSqliteHost(seed({ status }));
        try { const before = await raw(s); expect(await s.host.prepareTaskCompletion(request())).toMatchObject({ ok: false }); expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]); }
        finally { await s.close(); }
    });
    it('rejects malformed, stale and forged source/kind/timestamp proofs', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const s = await openSqliteHost(seed());
        try { const e = await prepare(s), before = await raw(s);
            for (const input of [{ ...request(), extra: true }, { ...request(), requestId: 'bad' }, { ...request(), taskRevision: 'old' }]) expect(await s.host.prepareTaskCompletion(input)).toMatchObject({ ok: false });
            for (const mutate of [(x: typeof e) => { x.request.source = 'board' as never; }, (x: typeof e) => { x.prepared.kind = 'boardComplete'; },
                (x: typeof e) => { x.prepared.result.completion.completedAt = NOW; }, (x: typeof e) => { x.prepared.checklist.witness.direct.title = 'forged'; }]) {
                const forged = structuredClone(e); mutate(forged); expect(s.host.validatePreparedTaskCompletion(forged)).toMatchObject({ ok: false }); expect(await s.host.commitPreparedTaskCompletion(forged)).toMatchObject({ ok: false });
            }
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
    it.each(['deleted', 'purged', 'archived-project', 'deleted-section', 'missing-project', 'mismatched-section'] as const)('refuses unavailable %s sources without writes', async reason => {
        const fixture = seed();
        if (reason === 'deleted') fixture.tasks![0].deletedAt = OLD;
        if (reason === 'purged') fixture.tasks![0].purgedAt = OLD;
        if (reason === 'archived-project') fixture.projects![0].status = 'archived';
        if (reason === 'deleted-section') fixture.sections![0].deletedAt = OLD;
        if (reason === 'mismatched-section') fixture.projects!.push({ ...fixture.projects![0], id: 'other-project' });
        const s = await openSqliteHost(fixture);
        try {
            if (reason === 'missing-project') {
                await s.client().run('PRAGMA foreign_keys=OFF');
                try { await s.client().run('UPDATE tasks SET projectId=? WHERE id=?', ['missing', 'source']); }
                finally { await s.client().run('PRAGMA foreign_keys=ON'); }
            }
            if (reason === 'mismatched-section') await s.client().run('UPDATE sections SET projectId=? WHERE id=?', ['other-project', 'section']);
            const before = await raw(s); expect(await s.host.prepareTaskCompletion({ id: 'source', taskRevision: taskRevisionOf(fixture.tasks![0]), requestId: WRITE, source: 'row' })).toMatchObject({ ok: false });
            expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
        } finally { await s.close(); }
    });
    it('preserves unrelated raw legacy JSON and settings while applying only the owned source', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed({ tags: [], contexts: [] });
        fixture.tasks!.push(task({ id: 'legacy', status: 'reference', completedAt: undefined, archivedAt: undefined,
            projectId: undefined, sectionId: undefined, tags: [], contexts: [] }));
        const s = await openSqliteHost(fixture);
        try {
            await s.client().run('UPDATE tasks SET pushCount=NULL,attachments=?,checklist=NULL WHERE id=?',
                ['[{"id":"legacy-link","kind":"link","uri":"https://example.com","createdAt":"2026-10-12T12:00:00.000Z","unrecognized":"retain"}]', 'legacy']);
            const setting = (await s.sql<{ data: string }>('SELECT data FROM settings'))[0];
            await s.client().run('UPDATE settings SET data=?', [JSON.stringify(JSON.parse(setting.data), null, 2)]);
            await s.restart(undefined, { recoveryLoad: true }); const e = await prepare(s);
            const sibling = await s.sql('SELECT * FROM tasks WHERE id=?', ['legacy']), settings = await s.sql('SELECT * FROM settings');
            value(await s.host.commitPreparedTaskCompletion(e));
            expect(await s.sql('SELECT * FROM tasks WHERE id=?', ['legacy'])).toEqual(sibling); expect(await s.sql('SELECT * FROM settings')).toEqual(settings);
        } finally { await s.close(); }
    });
    it.each(['complete', 'undo'] as const)('refuses raw row, project and Section drift before %s atomically', async operation => {
        for (const changed of ['row', 'project', 'section']) {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const s = await openSqliteHost(seed());
            try { const e = await prepare(s); if (operation === 'undo') value(await s.host.commitPreparedTaskCompletion(e));
                const u = operation === 'undo' ? await prepareUndo(s, e) : null;
                if (changed === 'row') await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Drift', 'source']);
                if (changed === 'project') await s.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'project']);
                if (changed === 'section') await s.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
                const before = await raw(s), receipts = await s.receiptIds();
                expect(await (u ? s.host.commitPreparedTaskCompletionUndo(u) : s.host.commitPreparedTaskCompletion(e))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual(receipts);
            } finally { await s.close(); }
        }
    });
    it.each(['complete', 'undo'] as const)('keeps %s immutable through two failed saves, cold replay and later saved edits', async operation => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const s = await openSqliteHost(seed({ cancelledAt: OLD, completedAt: undefined }), c => ({ ...c, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Row completion failed COMMIT'); } return c.run(sql, params);
        } }));
        try { const e = await prepare(s); if (operation === 'undo') value(await s.host.commitPreparedTaskCompletion(e));
            const u = operation === 'undo' ? await prepareUndo(s, e) : null;
            const commit = () => u ? s.host.commitPreparedTaskCompletionUndo(u) : s.host.commitPreparedTaskCompletion(e);
            const outcome = () => u ? s.host.taskCompletionUndoOutcome(u) : s.host.taskCompletionOutcome(e);
            const frozen = JSON.stringify(u ?? e), before = await raw(s), beforeReceipts = await s.receiptIds();
            await flushPendingSave(); await s.client().all('PRAGMA wal_checkpoint(TRUNCATE)'); const image = join(s.dir, 'before-row.db'); copyFileSync(join(s.dir, 'mindwtr.db'), image);
            for (let attempt = 0; attempt < 2; attempt++) { fault.commits = 8; expect(await commit()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual(beforeReceipts); }
            fault.commits = 0; value(await commit()); const uninterrupted = await raw(s);
            await s.restart(image, { recoveryLoad: true }); expect(value(outcome())).toBeNull(); value(await commit()); expect(await raw(s)).toEqual(uninterrupted);
            await s.client().run('UPDATE tasks SET title=? WHERE id=?', ['Later raw edit', 'source']); await s.restart(undefined, { recoveryLoad: true }); const later = await raw(s);
            expect(value(outcome())).not.toBeNull(); value(await commit()); expect(await raw(s)).toEqual(later); expect(JSON.stringify(u ?? e)).toBe(frozen);
        } finally { fault.commits = 0; await s.close(); }
    }, 20_000);
    it('uses its exact durable receipt for the existing next-action offer and rejects an undone origin', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fixture = seed();
        fixture.tasks!.push(task({ id: 'candidate', status: 'waiting', completedAt: undefined, archivedAt: undefined, order: 3, orderNum: 3 }));
        const s = await openSqliteHost(fixture);
        try { const e = await prepare(s), origin = { kind: 'completion' as const, envelope: e };
            expect(await s.host.getReferenceProjectNextActionOptions({ origin, params: { offset: 0, revision: null } })).toMatchObject({ ok: false });
            value(await s.host.commitPreparedTaskCompletion(e));
            const options = value(await s.host.getReferenceProjectNextActionOptions({ origin, params: { offset: 0, revision: null } }));
            expect(options?.candidates.items.map(row => row.id)).toEqual(['candidate']); if (!options) throw new Error('Missing row next-action offer');
            const input = { requestId: NEXT, origin: options.origin, promptRevision: options.promptRevision, action: 'choose' as const,
                candidateId: 'candidate', candidateRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('candidate')!) };
            const p = value(await s.host.prepareReferenceProjectNextAction({ request: input, origin })).prepared;
            expect(p.version).toBe(2); value(await s.host.commitPreparedReferenceProjectNextAction({ request: input, prepared: p }));
            expect(useTaskStore.getState()._tasksById.get('candidate')?.status).toBe('next');
            const u = await prepareUndo(s, e); value(await s.host.commitPreparedTaskCompletionUndo(u));
            expect(value(await s.host.getReferenceProjectNextActionOptions({ origin, params: { offset: 0, revision: null } }))).toBeNull();
        } finally { await s.close(); }
    });
    it('does not authorize Undo or next-action creation after losing the original durable receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const s = await openSqliteHost(seed());
        try { const e = await prepare(s); value(await s.host.commitPreparedTaskCompletion(e)); await s.client().run('DELETE FROM native_request_receipts');
            await s.restart(undefined, { recoveryLoad: true }); const before = await raw(s);
            expect(await s.host.prepareTaskCompletionUndo({ request: { requestId: UNDO, completionRequestId: WRITE }, completion: e })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await s.host.getReferenceProjectNextActionOptions({ origin: { kind: 'completion', envelope: e }, params: { offset: 0, revision: null } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before);
        } finally { await s.close(); }
    });
});


describe('row completion Undo durable origin', () => {
    it.each(['prepare', 'commit'] as const)('refuses receipt loss in the same host before %s', async phase => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const s = await openSqliteHost(seed());
        try {
            const e = await prepare(s); value(await s.host.commitPreparedTaskCompletion(e));
            const u = phase === 'commit' ? await prepareUndo(s, e) : null;
            await s.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [WRITE]);
            const before = await raw(s);
            const result = u ? await s.host.commitPreparedTaskCompletionUndo(u)
                : await s.host.prepareTaskCompletionUndo({ request: { requestId: UNDO, completionRequestId: WRITE }, completion: e });
            expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
        } finally { await s.close(); }
    });
    it.each(['before-read', 'after-read'] as const)('keeps queued saves fenced when origin disappears %s', async loss => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { active: false, reads: 0, removed: false };
        const s = await openSqliteHost(seed(), c => ({ ...c, all: async <T>(sql: string, params?: unknown[]) => {
            const remove = fault.active && sql === 'SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id = ?'
                && params?.[0] === WRITE && ++fault.reads === 2;
            if (remove && loss === 'before-read') await c.run('DELETE FROM native_request_receipts WHERE request_id=?', [WRITE]);
            const rows = await c.all<T>(sql, params);
            if (remove && loss === 'after-read') await c.run('DELETE FROM native_request_receipts WHERE request_id=?', [WRITE]);
            if (remove) fault.removed = true;
            return rows;
        } }));
        try {
            const e = await prepare(s); value(await s.host.commitPreparedTaskCompletion(e));
            const u = await prepareUndo(s, e), before = await raw(s); fault.active = true;
            expect(await s.host.commitPreparedTaskCompletionUndo(u)).toMatchObject({ ok: false });
            expect(fault.removed).toBe(true); expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
            try { await flushPendingSave(); }
            catch (error) { expect(String(error)).toContain('receipt'); }
            expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
        } finally { fault.active = false; await s.close(); }
    }, 20_000);
    it('refuses lost origin on the exact retry after a failed Undo save', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const s = await openSqliteHost(seed(), c => ({ ...c, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Row Undo receipt test failed COMMIT'); }
            return c.run(sql, params);
        } }));
        try {
            const e = await prepare(s); value(await s.host.commitPreparedTaskCompletion(e));
            const u = await prepareUndo(s, e); fault.commits = 8;
            expect(await s.host.commitPreparedTaskCompletionUndo(u)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.commits = 0; await s.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [WRITE]);
            const before = await raw(s);
            expect(await s.host.commitPreparedTaskCompletionUndo(u)).toMatchObject({ ok: false });
            expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
            try { await flushPendingSave(); }
            catch (error) { expect(String(error)).toContain('receipt'); }
            expect(await raw(s)).toEqual(before); expect(await s.receiptIds()).toEqual([]);
        } finally { fault.commits = 0; await s.close(); }
    }, 20_000);
    it('preserves a historical recurrence child that this completion did not create', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fixture = seed({ recurrence: { rule: 'daily', seriesId: 'source' } });
        fixture.tasks!.push(task({ id: 'prior-child', status: 'next', completedAt: undefined, archivedAt: undefined,
            startTime: '2026-11-05T12:00:00.000Z', recurrence: { rule: 'daily', seriesId: 'source' } }));
        const s = await openSqliteHost(fixture);
        try {
            const before = await s.sql("SELECT * FROM tasks WHERE id='prior-child'");
            const e = await prepare(s); value(await s.host.commitPreparedTaskCompletion(e));
            const u = await prepareUndo(s, e); value(await s.host.commitPreparedTaskCompletionUndo(u));
            expect(await s.sql("SELECT * FROM tasks WHERE id='prior-child'")).toEqual(before);
        } finally { await s.close(); }
    });
});
