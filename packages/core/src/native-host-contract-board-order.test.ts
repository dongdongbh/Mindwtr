import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { openSqliteHost, value } from './screen-parity.replay';
import { createNativeHostContract } from './native-host-contract';
import { boardOrderToken, type NativeBoardOrderEnvelope, type NativeBoardOrderRequest } from './native-host-contract-board-order';
import { flushPendingSave, resetForTests, useTaskStore, setStorageAdapter, getStorageAdapter } from './store';
import { taskRevisionOf } from './native-request-receipts';
import type { AppData, Task } from './types';
import type { BoardStatus } from './board-view-model';
import { noopStorage } from './storage';
import * as orderingActions from './store-projects/ordering-actions';
import { samePreparedBoardOrderBefore } from './store-tasks';
const NOW = '2026-10-14T12:00:00.000Z';
const UUID = '00000000-0000-4000-8000-000000000733';
const task = (id: string, boardOrder?: number, patch: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    boardOrder, tags: [], contexts: [], createdAt: NOW, updatedAt: NOW, rev: 4, revBy: 'device-a', ...patch });
const seed = (tasks = [task('a', 0), task('b', 1024), task('c', 2048)]): Partial<AppData> => ({ tasks, projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, gtd: { autoArchiveDays: 0 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const open = (data = seed(), wrap?: Parameters<typeof openSqliteHost>[1]) => openSqliteHost(data, wrap, {}, { rejectConcurrentWrites: true });
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'settings', 'native_request_receipts', 'tasks_fts']
    .map(async table => [table, await sqlite.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const request = (sqlite: Sqlite, id = 'b', afterId: string | null = null, status: BoardStatus = 'next', filters?: object): NativeBoardOrderRequest => {
    const view = value(sqlite.host.getBoardView({ limit: 1, ...(filters ? { filters } : {}) }));
    const column = view.columns.find(c => c.status === status)!;
    return { requestId: UUID, action: { type: 'orderCard', taskId: id, status, afterId, filters: view.filters,
        taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!), expectedOrder: column.order!.expectedOrder! } };
};
const prepare = (sqlite: Sqlite, r = request(sqlite)): NativeBoardOrderEnvelope => {
    const result = value(sqlite.host.prepareBoardAction(r));
    if (result.kind !== 'prepared' || !('scope' in result.prepared)) throw new Error('Expected Board order preparation');
    return { request: r, prepared: result.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('strict prepared Board same-column ordering', () => {
    const variants: Array<{ name: string; orders: Array<number | undefined>; afterId: string | null; id: string }> = [
        { name: 'first sparse', orders: [0, 1024, 2048], id: 'b', afterId: null },
        { name: 'last sparse', orders: [0, 1024, 2048], id: 'b', afterId: 'c' },
        { name: 'middle rebalance', orders: [0, 1, 2], id: 'c', afterId: 'a' },
        { name: 'equal legacy', orders: [0, 0, 0], id: 'c', afterId: 'a' },
        { name: 'missing legacy', orders: [undefined, undefined, undefined], id: 'c', afterId: 'a' },
    ];
    it.each((['inbox', 'next', 'waiting', 'someday', 'done'] as const).flatMap(status => variants.map(v => ({ ...v, status }))))
    ('matches every actual persisted RN task cell for $status / $name', async ({ orders, afterId, id, status }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(['a', 'b', 'c'].map((id, index) => task(id, orders[index], { status, description: 'é😀 keep',
            recurrence: { rule: 'daily', strategy: 'strict' }, order: 17, orderNum: 17,
            checklist: [{ id: `${id}-check`, title: 'Preserve', isCompleted: false }] })));
        const rn = await open(data); let expected: unknown;
        try {
            const ids = ['a', 'b', 'c'].filter(row => row !== id); ids.splice(afterId === null ? 0 : ids.indexOf(afterId) + 1, 0, id);
            await useTaskStore.getState().reorderBoardTasks(status, ids, id); await flushPendingSave(); expected = (await raw(rn)).tasks;
        } finally { await rn.close(); }
        const native = await open(data);
        try {
            const before = await raw(native); const e = prepare(native, request(native, id, afterId, status));
            expect(value(native.host.validatePreparedBoardAction(e))).toEqual(e.prepared.result);
            expect(value(await native.host.boardOrderOutcome(e))).toBeNull();
            expect(value(await native.host.commitPreparedBoardAction(e))).toEqual(e.prepared.result);
            const after = await raw(native); expect(after.tasks).toEqual(expected);
            for (const table of ['projects', 'sections', 'areas', 'settings', 'tasks_fts']) expect(after[table]).toEqual(before[table]);
            expect(await native.sql("SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'keep'")).toHaveLength(3);
            expect(value(await native.host.boardOrderOutcome(e))).toEqual(e.prepared.result);
            await native.restart(); expect((await raw(native)).tasks).toEqual(expected);
        } finally { await native.close(); }
    });
    it('derives complete off-page neighbor intents and preserves hidden relative placement', async () => {
        const sqlite = await open(seed([task('a', 0, { tags: ['#shown'] }), task('hidden', 100), task('b', 1024, { tags: ['#shown'] }), task('c', 2048, { tags: ['#shown'] })]));
        try {
            const view = value(sqlite.host.getBoardView({ limit: 1, filters: { tokens: ['#shown'] } })); const column = view.columns.find(c => c.status === 'next')!;
            expect(column.count).toBe(3); expect(column.cards[0].orderActions).toEqual({ up: null, down: { afterId: 'b' } });
            const page = value(sqlite.host.getBoardList({ filters: view.filters, list: 'cards', status: 'next', offset: 1, limit: 1, revision: view.revision }));
            expect(page.items[0]).toMatchObject({ row: { id: 'b' }, orderActions: { up: { afterId: null }, down: { afterId: 'c' } } });
            const e = prepare(sqlite, request(sqlite, 'b', null, 'next', view.filters));
            expect(e.prepared.scope.shownIds).toEqual(['a', 'b', 'c']); expect(e.prepared.scope.columnTasks.map(t => t.id)).toEqual(['a', 'hidden', 'b', 'c']);
            value(await sqlite.host.commitPreparedBoardAction(e));
            const reread = value(sqlite.host.getBoardView({ limit: 100 })); expect(reread.columns.find(c => c.status === 'next')!.cards.map(c => c.row.id)).toEqual(['b', 'a', 'hidden', 'c']);
        } finally { await sqlite.close(); }
    });
    it('preserves the original case of a canonical UUID through the typed receipt', async () => {
        const sqlite = await open(); try {
            const r = request(sqlite); r.requestId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
            const e = prepare(sqlite, r); expect(e.prepared.request.requestId).toBe(r.requestId);
            value(await sqlite.host.commitPreparedBoardAction(e)); expect(await sqlite.receiptIds()).toContain(r.requestId);
        } finally { await sqlite.close(); }
    });
    it('keeps admitted same-position passive and rejects stale/malformed requests', async () => {
        const sqlite = await open(); try {
            const before = await raw(sqlite); const r = request(sqlite, 'a', null);
            expect(value(sqlite.host.prepareBoardAction(r))).toEqual({ kind: 'noop', result: { changed: false, open: null } });
            expect(await raw(sqlite)).toEqual(before);
            expect(sqlite.host.prepareBoardAction({ ...r, action: { ...r.action, expectedOrder: `boardOrder:${'0'.repeat(64)}` } })).toMatchObject({ ok: false });
            expect(sqlite.host.prepareBoardAction({ ...r, action: { ...r.action, afterId: 'a' } })).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('validates the frozen entire effect without reading mutable state', async () => {
        const sqlite = await open(seed([task('a', 0), task('b', 1), task('c', 2)])); try {
            const e = prepare(sqlite, request(sqlite, 'c', 'a')); expect(e.prepared.effect.tasks.length).toBeGreaterThan(1);
            const cold = createNativeHostContract(); const spy = vi.spyOn(useTaskStore, 'getState').mockImplementation(() => { throw new Error('Mutable state read'); });
            try {
                expect(value(cold.validatePreparedBoardAction(e))).toEqual(e.prepared.result);
                for (const mutate of [(x: NativeBoardOrderEnvelope) => { x.prepared.effect.tasks.pop(); },
                    (x: NativeBoardOrderEnvelope) => { x.prepared.effect.tasks[0].after.title = 'forged'; },
                    (x: NativeBoardOrderEnvelope) => { x.prepared.scope.columnTasks.push(x.prepared.scope.columnTasks[0]); },
                    (x: NativeBoardOrderEnvelope) => { x.prepared.effect.tasks[0].after.rev = 900; },
                    (x: NativeBoardOrderEnvelope) => { x.request.requestId = UUID.replace('733', '734'); }]) {
                    const forged = structuredClone(e); mutate(forged); expect(cold.validatePreparedBoardAction(forged)).toMatchObject({ ok: false });
                }
            } finally { spy.mockRestore(); }
        } finally { await sqlite.close(); }
    });
    it.each(['note', 'hidden-order', 'arrival', 'device'] as const)('refuses a durable scoped $0 change atomically', async change => {
        const sqlite = await open(); try {
            const e = prepare(sqlite);
            if (change === 'note') await sqlite.client().run('UPDATE tasks SET description=? WHERE id=?', ['later note', 'c']);
            else if (change === 'hidden-order') await sqlite.client().run('UPDATE tasks SET boardOrder=? WHERE id=?', [2000, 'c']);
            else if (change === 'arrival') await sqlite.client().run('UPDATE tasks SET status=? WHERE id=?', ['waiting', 'c']);
            else await sqlite.client().run("UPDATE settings SET data=json_set(data, '$.deviceId', ?) WHERE id=1", ['new-device']);
            const before = await raw(sqlite); expect(await sqlite.host.commitPreparedBoardAction(e)).toMatchObject({ ok: false }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('refuses a rebalance with a changed readonly hidden row rather than omitting its effect', async () => {
        const data = seed([task('a', 0), task('hidden', 1, { projectId: 'archive' }), task('b', 2), task('c', 3)]);
        data.projects = [{ id: 'archive', title: 'Archive', status: 'active', color: '#777', order: 0, tagIds: [], createdAt: NOW, updatedAt: NOW }];
        const sqlite = await open(data); try {
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'archive']);
            useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map(row => ({ ...row, status: 'archived' as const })) });
            const before = await raw(sqlite); expect(sqlite.host.prepareBoardAction(request(sqlite, 'c', 'a'))).toMatchObject({ ok: false }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('retries failed COMMIT exactly, replays the receipt before later edits, and retains missing terminal proof', async () => {
        const fault = { count: 0 }; const sqlite = await open(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.count > 0) { fault.count--; throw new Error('Injected order COMMIT failure'); } return client.run(sql, params);
        } }));
        try {
            const e = prepare(sqlite); const before = await raw(sqlite); fault.count = 10;
            expect(await sqlite.host.commitPreparedBoardAction(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(sqlite)).toEqual(before);
            fault.count = 0; expect(value(await sqlite.host.commitPreparedBoardAction(e))).toEqual(e.prepared.result); expect(value(await sqlite.host.boardOrderOutcome(e))).toEqual(e.prepared.result);
            await sqlite.client().run('UPDATE tasks SET title=? WHERE id=?', ['Later', e.prepared.effect.tasks[0].after.id]);
            await sqlite.restart(); const later = await raw(sqlite);
            expect(value(await sqlite.host.commitPreparedBoardAction(e))).toEqual(e.prepared.result); expect(await raw(sqlite)).toEqual(later);
            expect(value(await sqlite.host.boardOrderOutcome(e))).toBeNull();
        } finally { fault.count = 0; resetForTests(); await sqlite.close(); }
    });
    it('admits a bounded read token but refuses an oversized full effect without writes', async () => {
        const sqlite = await open(seed(['a', 'b', 'c'].map(id => task(id, 0, { description: 'x'.repeat(350000) }))));
        try {
            const view = value(sqlite.host.getBoardView({ limit: 1 })); expect(view.columns.find(c => c.status === 'next')!.order?.available).toBe(true);
            const before = await raw(sqlite); expect(sqlite.host.prepareBoardAction(request(sqlite, 'c', 'a'))).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('leaves a large unfiltered column browsable with only ordering disabled', async () => {
        const sqlite = await open(seed([task('a', 0), ...Array.from({ length: 24 }, (_, i) => task(`offpage-${i}`, i * 1024 + 1024, { description: 'é'.repeat(50000) }))]));
        try {
            const before = await raw(sqlite); const view = value(sqlite.host.getBoardView({ limit: 1 })); const column = view.columns.find(c => c.status === 'next')!;
            expect(column.count).toBe(25); expect(column.order).toMatchObject({ available: false, expectedOrder: null });
            expect(column.cards).toHaveLength(1); expect(column.cards[0].orderActions).toBeUndefined(); expect(column.cards[0].moveAllowed).toBe(true); expect(column.cards[0].completeAllowed).toBe(true);
            expect(value(sqlite.host.getBoardList({ list: 'cards', status: 'next', offset: 1, limit: 1, revision: view.revision, filters: view.filters })).total).toBe(25);
            const r = request(sqlite, 'a'); r.action.expectedOrder = `boardOrder:${'a'.repeat(64)}`;
            expect(sqlite.host.prepareBoardAction(r)).toMatchObject({ ok: false }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('binds live direct/inferred containers and preserves unrelated durable rows', async () => {
        const data = seed([task('a', 0, { sectionId: 'section', areaId: 'area' }), task('b', 1024, { sectionId: 'section' }), task('unrelated', 0, { status: 'waiting' })]);
        data.projects = [{ id: 'parent', title: 'Parent', status: 'active', color: '#777', order: 0, tagIds: [], createdAt: NOW, updatedAt: NOW }];
        data.sections = [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }];
        data.areas = [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }];
        const sqlite = await open(data); try {
            const e = prepare(sqlite); await sqlite.client().run('UPDATE tasks SET title=? WHERE id=?', ['Unrelated later', 'unrelated']);
            expect(value(await sqlite.host.commitPreparedBoardAction(e))).toEqual(e.prepared.result);
            expect((await sqlite.sql<{ title: string }>('SELECT title FROM tasks WHERE id=?', ['unrelated']))[0].title).toBe('Unrelated later');
        } finally { await sqlite.close(); }
    });
    it.each([false, true])('rejects full/mixed after rows without the exact operation receipt (mixed=%s)', async mixed => {
        const sqlite = await open(seed([task('a', 0), task('b', 1), task('c', 2)])); try {
            const e = prepare(sqlite, request(sqlite, 'c', 'a')); value(await sqlite.host.commitPreparedBoardAction(e));
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [UUID]);
            if (mixed) { const row = e.prepared.effect.tasks[0].before;
                await sqlite.client().run('UPDATE tasks SET boardOrder=?,rev=?,revBy=?,updatedAt=? WHERE id=?', [row.boardOrder ?? null, row.rev ?? null, row.revBy ?? null, row.updatedAt, row.id]); }
            await sqlite.restart();
            const before = await raw(sqlite); expect(value(await sqlite.host.boardOrderOutcome(e))).toBeNull();
            expect(await sqlite.host.commitPreparedBoardAction(e)).toMatchObject({ ok: false }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('binds a host constructed before the real adapter only after activation', async () => {
        setStorageAdapter(noopStorage); const early = createNativeHostContract({ replayTokens: 'required' });
        const sqlite = await open(); try {
            value(await early.setLanguage({ storedLanguage: 'en', systemLocale: null })); value(await early.activate({ writeSafetyReady: true }));
            const e = prepare(sqlite); expect(value(await early.commitPreparedBoardAction(e))).toEqual(e.prepared.result);
            const save = vi.spyOn(getStorageAdapter(), 'saveData'); const retry = vi.spyOn(useTaskStore.getState(), 'retryPersistence');
            expect(value(await early.boardOrderOutcome(e))).toEqual(e.prepared.result); expect(save).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
        } finally { await sqlite.close(); }
    });
    it('does not invoke the RN effect planner during a large Board read or paging', async () => {
        // The revision carries the minute; a slow 5,000-task read must not cross one between its two calls.
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await open(seed(Array.from({ length: 5000 }, (_, i) => task(`large-${i}`, i * 1024))));
        try {
            const plan = vi.spyOn(orderingActions, 'boardTaskOrderUpdates'); const before = await raw(sqlite);
            const view = value(sqlite.host.getBoardView({ limit: 2 })); const column = view.columns.find(c => c.status === 'next')!;
            expect(column.count).toBe(5000); expect(column.cards).toHaveLength(2);
            expect(value(sqlite.host.getBoardList({ list: 'cards', status: 'next', offset: 4998, limit: 2, revision: view.revision, filters: view.filters })).items).toHaveLength(2);
            expect(plan).not.toHaveBeenCalled(); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    }, 20000);
    it('rechecks current due membership at atomic admission while preserving frozen stamps', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await open(seed([task('a', 0, { dueDate: '2026-10-14' }), task('b', 1024, { dueDate: '2026-10-14' })]));
        try {
            const e = prepare(sqlite, request(sqlite, 'b', null, 'next', { duePreset: 'today' }));
            vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
            const before = await raw(sqlite); expect(await sqlite.host.commitPreparedBoardAction(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    const legacyForms = [
        { column: 'recurrence', raw: '"daily"' }, { column: 'timeSpentMinutes', raw: 0 },
        { column: 'rev', raw: null }, { column: 'pushCount', raw: null },
    ] as const;
    it.each(legacyForms.flatMap(form => [true, false].map(affected => ({ ...form, affected }))))
    ('accepts supported raw BEFORE $column (affected=$affected), matching RN changed cells and preserving untouched raw rows', async ({ column, raw: legacy, affected }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const id = affected ? 'b' : 'c';
        const setup = async () => { const sqlite = await open(); await sqlite.client().run(`UPDATE tasks SET ${column}=? WHERE id=?`, [legacy, id]); await sqlite.restart(); return sqlite; };
        const rn = await setup(); let expected: unknown;
        try {
            await useTaskStore.getState().reorderBoardTasks('next', ['b', 'a'], 'b'); await flushPendingSave();
            expected = await rn.sql('SELECT * FROM tasks WHERE id=?', ['b']);
        } finally { await rn.close(); }
        const native = await setup(); try {
            const before = await native.sql('SELECT * FROM tasks WHERE id=?', ['c']); const e = prepare(native);
            expect(value(await native.host.commitPreparedBoardAction(e))).toEqual(e.prepared.result);
            expect(await native.sql('SELECT * FROM tasks WHERE id=?', ['b'])).toEqual(expected);
            expect(await native.sql('SELECT * FROM tasks WHERE id=?', ['c'])).toEqual(before);
            expect(value(await native.host.boardOrderOutcome(e))).toEqual(e.prepared.result);
        } finally { await native.close(); }
    });
    it.each(['warm', 'cold'] as const)('retries the same normalized BEFORE after failed COMMIT (%s)', async mode => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { count: 0 }; const sqlite = await open(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.count > 0) { fault.count--; throw new Error('Injected legacy order COMMIT failure'); } return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET recurrence=?,timeSpentMinutes=0,rev=NULL,pushCount=NULL WHERE id=?', ['"daily"', 'b']); await sqlite.restart();
            const e = prepare(sqlite); const before = await raw(sqlite); fault.count = 10;
            expect(await sqlite.host.commitPreparedBoardAction(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(sqlite)).toEqual(before);
            fault.count = 0; if (mode === 'cold') { resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true }); }
            expect(value(await sqlite.host.commitPreparedBoardAction(e))).toEqual(e.prepared.result);
            expect(value(await sqlite.host.boardOrderOutcome(e))).toEqual(e.prepared.result);
        } finally { fault.count = 0; resetForTests(); await sqlite.close(); }
    });
    it('does not normalize invalid values or the frozen side of BEFORE comparison', () => {
        const before = task('b', 1024, { recurrence: { rule: 'daily' }, timeSpentMinutes: undefined, rev: 0, pushCount: 0, order: 17, orderNum: 17 });
        expect(samePreparedBoardOrderBefore({ ...before, recurrence: 'daily', rev: undefined, timeSpentMinutes: 0, pushCount: undefined }, before)).toBe(true);
        for (const patch of [{ timeSpentMinutes: -1 }, { timeSpentMinutes: 0.1 }, { timeSpentMinutes: 100001 }, { rev: -1 }, { rev: 0.1 },
            { recurrence: 'DAILY' }, { recurrence: { rule: 'daily', unknown: 'field' } }, { orderNum: 18 }, { description: 'changed' }]) {
            expect(samePreparedBoardOrderBefore({ ...before, ...patch } as Task, before)).toBe(false);
        }
        expect(samePreparedBoardOrderBefore(before, { ...before, orderNum: 18 })).toBe(false);
    });
    it('refuses non-equivalent raw hidden-row repairs atomically after preparation', async () => {
        const sqlite = await open(); try {
            const e = prepare(sqlite);
            for (const [field, changed, restore] of [['timeSpentMinutes', 0.1, null], ['timeSpentMinutes', -1, null],
                ['timeSpentMinutes', 100001, null], ['rev', -1, 4], ['recurrence', '"DAILY"', null]] as const) {
                await sqlite.client().run(`UPDATE tasks SET ${field}=? WHERE id=?`, [changed, 'c']);
                const before = await raw(sqlite); expect(await sqlite.host.commitPreparedBoardAction(e)).toMatchObject({ ok: false });
                expect(await raw(sqlite)).toEqual(before); await sqlite.client().run(`UPDATE tasks SET ${field}=? WHERE id=?`, [restore, 'c']);
            }
        } finally { await sqlite.close(); }
    });
    it.each(['recurrence', 'timeSpentMinutes'] as const)('keeps durable AFTER proof exact after a later equivalent $0 rewrite', async field => {
        const sqlite = await open(seed([task('a', 0), task('b', 1024, { recurrence: { rule: 'daily' } }), task('c', 2048)]));
        try {
            const e = prepare(sqlite); value(await sqlite.host.commitPreparedBoardAction(e));
            await sqlite.client().run(`UPDATE tasks SET ${field}=? WHERE id=?`, [field === 'recurrence' ? '"daily"' : 0, 'b']);
            const before = await raw(sqlite); expect(value(await sqlite.host.boardOrderOutcome(e))).toBeNull(); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('uses the exact portable complete-scope UTF16 SHA256 token and binds off-page metadata', async () => {
        const sqlite = await open(seed([task('a', 0), task('b', 1024), task('c', 2048, { description: 'é😀' })]));
        try {
            const e = prepare(sqlite); const content = ['boardOrder', { status: e.request.action.status, filters: e.request.action.filters, ...e.prepared.scope }];
            const json = JSON.stringify(content, (_name, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : part);
            const bytes = new Uint8Array(json.length * 2); for (let i = 0; i < json.length; i++) { bytes[i * 2] = json.charCodeAt(i) >>> 8; bytes[i * 2 + 1] = json.charCodeAt(i) & 255; }
            const token = `boardOrder:${Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('')}`;
            expect(e.request.action.expectedOrder).toBe(token); expect(token).toHaveLength(75);
            for (const patch of [{ description: 'changed off-page' }, { rev: 99 }, { boardOrder: 99 }]) {
                const scope = structuredClone(e.prepared.scope); Object.assign(scope.columnTasks[2], patch);
                expect(boardOrderToken('next', e.request.action.filters, scope)).not.toBe(token);
            }
        } finally { await sqlite.close(); }
    });
});
