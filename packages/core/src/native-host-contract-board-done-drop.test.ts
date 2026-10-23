import { afterEach, describe, expect, it, vi } from 'vitest';
import { planBoardDrop } from './board-view-model';
import { taskRevisionOf } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Task } from './types';

const NOW = '2026-10-20T12:00:00.000Z';
const SOURCE = 'board-done-source';
const REQUEST = '00000000-0000-4000-8000-000000000736';
const value = <T,>(reply: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    return reply.value;
};
const task = (id: string, status: Task['status'], boardOrder: number): Task => ({
    id, title: id, status, boardOrder, createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'board-done-device',
    tags: ['#keep'], contexts: ['@desk'], description: 'Preserve metadata',
    ...(status === 'done' ? { completedAt: '2026-10-19T12:00:00.000Z' } : {}),
});
const seed = (source: Task['status'], destination: Task['status']): Partial<AppData> => ({
    tasks: [task(SOURCE, source, 42), task('board-done-peer', destination, 2048), task('board-done-protected', 'reference', 4096)],
    projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'board-done-device', analyticsProfileId: REQUEST, gtd: { autoArchiveDays: 0, focusTaskLimit: 3 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// All app/FTS tables and raw rowids, including shadow tables; only the intended receipt rows differ from RN.
const domain = async (sqlite: Sqlite) => {
    const schema = await sqlite.sql<{ type: string; name: string; tbl_name: string; sql: string | null }>(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
    const tables: Record<string, unknown> = {};
    for (const entry of schema) {
        if (entry.type !== 'table' || entry.name === 'native_request_receipts') continue;
        const name = String(entry.name), withoutRowid = /WITHOUT\s+ROWID/i.test(String(entry.sql));
        if (withoutRowid) {
            const columns = await sqlite.sql<{ pk: number; name: string }>(`PRAGMA table_info(${quote(name)})`);
            const primary = columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
            expect(primary.length).toBeGreaterThan(0);
            tables[name] = await sqlite.sql(`SELECT * FROM ${quote(name)} ORDER BY ${primary.map(column => quote(String(column.name))).join(',')}`);
        } else tables[name] = await sqlite.sql(`SELECT rowid AS __rowid__,* FROM ${quote(name)} ORDER BY rowid`);
    }
    return { schema, tables };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Done cross-drop maps the actual RN planner to existing durable owners', () => {
    it.each((['inbox', 'next', 'waiting', 'someday'] as const).flatMap(status => [
        { from: status, to: 'done' as const }, { from: 'done' as const, to: status },
    ]))('$from → $to preserves full RN rows/settings/schema/FTS and destination peers', async ({ from, to }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(from, to), rn = await openSqliteHost(data);
        let expected: Awaited<ReturnType<typeof domain>>;
        try {
            const source = useTaskStore.getState()._tasksById.get(SOURCE)!;
            const drop = planBoardDrop({ task: source, status: to, columnIds: ['board-done-peer'] });
            expect(drop).toEqual({ kind: 'status', taskId: SOURCE, status: to });
            if (drop?.kind !== 'status') throw new Error('Expected cross-column status intent');
            expect(await useTaskStore.getState().updateTask(drop.taskId, { status: drop.status })).toEqual({ success: true });
            await flushPendingSave();
            expected = await domain(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(data, client => client, {}, { rejectConcurrentWrites: true });
        try {
            const before = await domain(native), source = useTaskStore.getState()._tasksById.get(SOURCE)!;
            if (to === 'done') {
                const request = { id: SOURCE, requestId: REQUEST, taskRevision: taskRevisionOf(source), source: 'board' as const };
                const prepared = value(await native.host.prepareTaskCompletion(request));
                expect(await domain(native)).toEqual(before);
                value(await native.host.commitPreparedTaskCompletion({ request, prepared: prepared.prepared }));
            } else {
                const request = { requestId: REQUEST, action: { type: 'moveCard' as const, taskId: SOURCE, status: to,
                    taskRevision: taskRevisionOf(source), filters: value(native.host.getBoardView({ limit: 100 })).filters } };
                const prepared = value(native.host.prepareBoardAction(request));
                if (prepared.kind !== 'prepared') throw new Error('Expected prepared Done reactivation');
                expect(await domain(native)).toEqual(before);
                value(await native.host.commitPreparedBoardAction({ request, prepared: prepared.prepared }));
            }
            expect(await domain(native)).toEqual(expected!);
            expect(useTaskStore.getState()._tasksById.get(SOURCE)?.boardOrder).toBeUndefined();
            expect(useTaskStore.getState()._tasksById.get('board-done-peer')?.boardOrder).toBe(2048);
            expect(await native.receiptIds()).toEqual([REQUEST]);
            const receipts = await native.sql<{ method: string }>('SELECT method FROM native_request_receipts');
            expect(receipts[0].method).toMatch(to === 'done' ? /^boardTaskCompletion:[0-9a-f]{32}$/ : /^boardTaskReactivate:[0-9a-f]{32}$/);
        } finally { await native.close(); }
    });
});
