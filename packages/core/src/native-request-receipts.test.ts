import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeHostResult } from './native-host-contract';
import { createNativeRequestReceipts, loadNativeRequestReceipts, pruneNativeRequestReceipts, resetNativeRequestReceipts,
    runStoreWrite, settleWrite } from './native-request-receipts';
import type { SqliteClient } from './sqlite-adapter';
import { resetForTests, useTaskStore } from './store';
import { deterministicHash128, generateUUID } from './uuid';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScratchSqlite } from './screen-parity.replay';

const ok = <T,>(value: T): NativeHostResult<T> => ({ ok: true, value });
const saveFailed: NativeHostResult<never> = { ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } };
afterEach(() => resetNativeRequestReceipts());

/** A save that fails while `failing` is set, and can be held open. */
function createSave() {
    const state = { failing: false, calls: 0, hold: null as Promise<void> | null };
    const save = vi.fn(async (): Promise<NativeHostResult<null>> => {
        state.calls += 1;
        if (state.hold) await state.hold;
        return state.failing ? saveFailed : ok(null);
    });
    return { state, save };
}

describe('native request receipts', () => {
    it.each([false, true])('retains unfinished reminder IDs or commands in SQLite and replay memory (scoped=%s)', async (scoped) => {
        const directory = mkdtempSync(join(tmpdir(), 'mindwtr-retention-'));
        const sqlite = openScratchSqlite(join(directory, 'receipts.sqlite'));
        const commands = ['reminderComplete', 'reminderSnooze', 'notificationSetting'];
        const receiptCommands = [...commands, 'unknown', 'reminderComplete'];
        const payloads = receiptCommands.map((command) => JSON.stringify([command, 'opaque']));
        const ids = payloads.map(() => generateUUID());
        const fingerprint = (payload: string, command: string) => `${command}:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
        try {
            const options = scoped ? { durableCommands: commands } : undefined;
            await loadNativeRequestReceipts(sqlite.client, options);
            for (const [index, payload] of payloads.entries()) await sqlite.client.run(
                'INSERT INTO native_request_receipts VALUES (?, ?, ?, ?)',
                [ids[index], fingerprint(payload, receiptCommands[index]), '{"original":true}',
                    index === 4 ? '2026-09-09T00:00:00.000Z' : '2020-01-01T00:00:00.000Z'],
            );
            await loadNativeRequestReceipts(sqlite.client, options);
            const receipts = createNativeRequestReceipts({ save: async () => ok(null) });
            expect(await pruneNativeRequestReceipts(sqlite.client, new Date('2026-10-09T00:00:00.000Z'), {
                retainedRequestIds: [ids[0]], retainedCommands: ['reminderSnooze'],
            })).toBe(scoped ? 1 : 2);
            expect(await sqlite.client.all('SELECT request_id FROM native_request_receipts ORDER BY request_id'))
                .toEqual([ids[0], ids[1], ids[4], ...(scoped ? [ids[3]] : [])].sort().map((request_id) => ({ request_id })));
            expect(receipts.saved(ids[0], payloads[0])).toEqual(ok({ original: true }));
            expect(receipts.saved(ids[1], payloads[1])).toEqual(ok({ original: true }));
            expect(receipts.saved(ids[2], payloads[2])).toBeNull();
            // An explicit empty snapshot restores normal expiry; unknown scoped rows stay reserved.
            expect(await pruneNativeRequestReceipts(sqlite.client, new Date('2026-10-09T00:00:00.000Z'), {
                retainedRequestIds: [], retainedCommands: [],
            })).toBe(2);
            expect(receipts.saved(ids[0], payloads[0])).toBeNull();
            expect(receipts.saved(ids[1], payloads[1])).toBeNull();
            expect(receipts.saved(ids[4], payloads[4])).toEqual(ok({ original: true }));
            expect(await sqlite.client.all('SELECT request_id FROM native_request_receipts ORDER BY request_id'))
                .toEqual([ids[4], ...(scoped ? [ids[3]] : [])].sort().map((request_id) => ({ request_id })));
        } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
    });

    it('retains both reminder command families while default pruning still expires them', async () => {
        const payloads = ['reminderComplete', 'reminderSnooze', 'notificationSetting'].map((command) => JSON.stringify([command]));
        const rows = payloads.map((payload, index) => ({ request_id: generateUUID(),
            method: `${JSON.parse(payload)[0]}:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`,
            reply: JSON.stringify(index), saved_at: '2020-01-01T00:00:00.000Z' }));
        const deletes: unknown[][] = [];
        const client: SqliteClient = { run: async (sql, params) => { if (sql.startsWith('DELETE')) deletes.push(params ?? []); },
            all: async <T,>() => rows as T[], get: async () => undefined };
        await loadNativeRequestReceipts(client, { durableCommands: ['reminderComplete', 'reminderSnooze', 'notificationSetting'] });
        expect(await pruneNativeRequestReceipts(client, new Date(), { retainedCommands: ['reminderComplete', 'reminderSnooze'] })).toBe(1);
        expect(deletes).toHaveLength(1); expect(deletes[0][0]).toBe(rows[2].request_id);
        const receipts = createNativeRequestReceipts({ save: async () => ok(null) });
        expect(receipts.saved(rows[0].request_id, payloads[0])).toEqual(ok(0));
        expect(receipts.saved(rows[1].request_id, payloads[1])).toEqual(ok(1));
        expect(await pruneNativeRequestReceipts(client)).toBe(2);
        expect(receipts.saved(rows[0].request_id, payloads[0])).toBeNull();
        expect(receipts.saved(rows[1].request_id, payloads[1])).toBeNull();
    });

    it('scopes iOS disk replies to App lock, keeps other IDs reserved and preserves unknown rows', async () => {
        const appId = generateUUID();
        const otherId = generateUUID();
        const payload = JSON.stringify(['appLock', true, false, false, null]);
        const otherPayload = JSON.stringify(['other', 'opaque']);
        const otherFingerprint = `other:${deterministicHash128(otherPayload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
        const rows = [
            { request_id: appId, method: payload, reply: JSON.stringify({ changed: true, value: true }), saved_at: '2026-09-30T00:00:00.000Z' },
            { request_id: otherId, method: otherFingerprint, reply: JSON.stringify({ legacy: true }), saved_at: '2026-09-30T00:00:00.000Z' },
        ];
        const writes: Array<{ sql: string; params?: unknown[] }> = [];
        const client = { run: async (sql: string, params?: unknown[]) => { writes.push({ sql, params }); },
            all: async () => rows, get: async () => undefined, exec: async () => {} } as SqliteClient;
        expect(await loadNativeRequestReceipts(client, { durableCommands: ['appLock'] })).toBe(2);
        const { save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        expect(receipts.saved(appId, payload)).toEqual(ok({ changed: true, value: true }));
        expect(receipts.saved(appId, JSON.stringify(['appLock', false, false, false, null])))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(receipts.saved(otherId, otherPayload)).toBeNull();
        expect(receipts.checkIdentity(otherId, payload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(writes).toHaveLength(1); // schema creation only; loader never rewrites unknown rows
        expect(await pruneNativeRequestReceipts(client, new Date('2026-12-01T00:00:00.000Z'))).toBe(1);
        expect(writes).toHaveLength(2);
        expect(writes[1].sql).toBe('DELETE FROM native_request_receipts WHERE request_id = ? AND saved_at < ?');
        expect(writes[1].params?.[0]).toBe(appId); // unknown other row remains on disk
        resetNativeRequestReceipts();
        expect(await loadNativeRequestReceipts(client)).toBe(2); // Android default still reads all
        expect(createNativeRequestReceipts({ save }).saved(otherId, otherPayload)).toEqual(ok({ legacy: true }));
    });

    it('fails scoped boot closed on malformed App lock receipt rows', async () => {
        const id = generateUUID();
        const valid = { request_id: id, method: JSON.stringify(['appLock', true, false, false, null]),
            reply: JSON.stringify({ changed: true, value: true }), saved_at: '2026-09-30T00:00:00.000Z' };
        for (const row of [
            { ...valid, method: JSON.stringify(['appLock', 'true', false, false, null]) },
            { ...valid, method: JSON.stringify(['appLock', true, false, true, true]) },
            { ...valid, reply: JSON.stringify({ changed: true, value: false }) },
            { ...valid, reply: JSON.stringify({ changed: true, value: true, secret: 'bad' }) },
            { ...valid, saved_at: 'not-a-date' },
            { ...valid, request_id: id.toUpperCase() },
        ]) {
            const client = { run: async () => {}, all: async () => [row],
                get: async () => undefined, exec: async () => {} } as SqliteClient;
            await expect(loadNativeRequestReceipts(client, { durableCommands: ['appLock'] }))
                .rejects.toThrow('Invalid saved App lock receipt');
            resetNativeRequestReceipts();
        }
    });
    it('checks UUID ownership without reserving, writing or saving', async () => {
        const { save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        const otherMethod = createNativeRequestReceipts({ save });
        const id = generateUUID();
        expect(receipts.checkIdentity(id, 'rename')).toEqual(ok(null));
        expect(otherMethod.checkIdentity(id, 'create')).toEqual(ok(null));
        expect(save).not.toHaveBeenCalled();
        expect(await otherMethod.run(id, 'create', async () => ok('created'))).toEqual(ok('created'));
        expect(receipts.checkIdentity(id, 'rename')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(otherMethod.checkIdentity(id, 'create')).toEqual(ok(null));
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('runs concurrent duplicates once and gives both the same result', async () => {
        const { save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        const write = vi.fn(async () => ok('written'));
        const id = generateUUID();
        const [first, second] = await Promise.all([receipts.run(id, 'a', write), receipts.run(id, 'a', write)]);
        expect(first).toEqual(ok('written'));
        expect(second).toEqual(first);
        expect(write).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('refuses another payload under the same request ID, while running and after', async () => {
        const { save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        const write = vi.fn(async () => ok(1));
        const id = generateUUID();
        const running = receipts.run(id, 'a', write);
        expect(await receipts.run(id, 'b', write)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        await running;
        expect(await receipts.run(id, 'b', write)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await receipts.run('not-a-uuid', 'a', write)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('lets a write that did not land run again', async () => {
        const { save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        const id = generateUUID();
        const refused: NativeHostResult<number> = { ok: false, error: { code: 'ACTION_FAILED', message: 'no' } };
        expect(await receipts.run(id, 'a', async () => refused)).toEqual(refused);
        expect(await receipts.run(id, 'a', async () => ok(2))).toEqual(ok(2));
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('finishes a failed save on retry without writing again, and answers a lost reply without saving', async () => {
        const { state, save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        const write = vi.fn(async () => ok('purged'));
        const id = generateUUID();
        state.failing = true;
        expect(await receipts.run(id, 'a', write)).toEqual(saveFailed);
        state.failing = false;
        expect(await receipts.run(id, 'a', write)).toEqual(ok('purged'));
        expect(await receipts.run(id, 'a', write)).toEqual(ok('purged'));
        expect(write).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(2);
    });

    it('never evicts an unsaved write: a full bound refuses new requests until a retry saves them', async () => {
        const { state, save } = createSave();
        const receipts = createNativeRequestReceipts({ save, limit: 3 });
        const ids = [generateUUID(), generateUUID(), generateUUID(), generateUUID()];
        const writes = ids.map((_, index) => vi.fn(async () => ok(index)));
        state.failing = true;
        for (const index of [0, 1, 2]) expect(await receipts.run(ids[index], 'x', writes[index])).toEqual(saveFailed);
        expect(await receipts.run(ids[3], 'x', writes[3])).toEqual({
            ok: false, error: { code: 'ACTION_FAILED', message: 'Earlier changes are not saved yet. Retry them first.' },
        });
        expect(writes[3]).not.toHaveBeenCalled();
        // Storage recovers: the first write's retry saves every earlier write.
        state.failing = false;
        expect(await receipts.run(ids[0], 'x', writes[0])).toEqual(ok(0));
        expect(await receipts.run(ids[3], 'x', writes[3])).toEqual(ok(3));
        // The saved entry that made room is gone; the others still answer without writing.
        expect(await receipts.run(ids[2], 'x', writes[2])).toEqual(ok(2));
        expect(writes.map((write) => write.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });

    it('evicts only saved writes', async () => {
        const { state, save } = createSave();
        const receipts = createNativeRequestReceipts({ save, limit: 2 });
        const [saved, unsaved, next] = [generateUUID(), generateUUID(), generateUUID()];
        const write = vi.fn(async () => ok('w'));
        expect(await receipts.run(saved, 'x', write)).toEqual(ok('w'));
        state.failing = true;
        expect(await receipts.run(unsaved, 'x', write)).toEqual(saveFailed);
        expect(await receipts.run(next, 'x', write)).toEqual(saveFailed);
        state.failing = false;
        // The unsaved write kept its receipt: its retry saves and does not write again.
        expect(await receipts.run(unsaved, 'x', write)).toEqual(ok('w'));
        expect(write).toHaveBeenCalledTimes(3);
    });

    it('keeps a write that landed while its save failed: a retry only saves, and answers with its value', async () => {
        const { save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        // The store applied the change in memory, then could not save it.
        const write = vi.fn(async () => settleWrite(saveFailed as NativeHostResult<null>, 'moved'));
        const id = generateUUID();
        expect(await receipts.run(id, 'a', write)).toEqual(saveFailed);
        expect(save).not.toHaveBeenCalled();
        expect(await receipts.run(id, 'a', write)).toEqual(ok('moved'));
        expect(await receipts.run(id, 'a', write)).toEqual(ok('moved'));
        expect(write).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('says a store call landed only when it changed the store\'s data', async () => {
        resetForTests();
        useTaskStore.setState({ persistenceFailure: { message: 'disk unavailable', failedAt: '2026-09-24T00:00:00.000Z', retrying: false } });
        // Refused before it changed anything: it did not land, whatever earlier save failed.
        expect(await runStoreWrite(async () => ({ success: false, error: 'Task not found' })))
            .toEqual({ ok: false, error: { code: 'ACTION_FAILED', message: 'Task not found' } });
        expect(await runStoreWrite(async () => { throw new Error('boom'); }))
            .toEqual({ ok: false, error: { code: 'ACTION_FAILED', message: 'boom' } });
        // Changed the data, then failed to save it: it landed.
        expect(await runStoreWrite(async () => {
            useTaskStore.setState({ _allTasks: [] });
            return { success: false, error: 'Failed to save' };
        })).toEqual({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(await runStoreWrite(async () => [undefined, { success: true }])).toEqual({ ok: true, value: null });
        resetForTests();
    });

    it('does not count a write that landed during another request\'s save as saved', async () => {
        const { state, save } = createSave();
        const receipts = createNativeRequestReceipts({ save });
        const [first, second] = [generateUUID(), generateUUID()];
        let release!: () => void;
        state.hold = new Promise<void>((resolve) => { release = resolve; });
        const firstRun = receipts.run(first, 'x', async () => ok(1));
        await vi.waitFor(() => expect(state.calls).toBe(1));
        state.hold = null;
        state.failing = true;
        // The second write lands while the first save is still running, and its own save fails.
        expect(await receipts.run(second, 'x', async () => ok(2))).toEqual(saveFailed);
        state.failing = false;
        release();
        expect(await firstRun).toEqual(ok(1));
        // So its retry still saves.
        const calls = state.calls;
        expect(await receipts.run(second, 'x', async () => ok(99))).toEqual(ok(2));
        expect(state.calls).toBe(calls + 1);
    });
});
