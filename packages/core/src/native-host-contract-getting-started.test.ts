import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_SEED_STRINGS } from './i18n/starter-seed-strings';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import type { NativeHostResult } from './native-host-contract';
import { createSettingsMethods } from './native-host-contract-settings';
import { openSqliteHost, requestId as newRequestId } from './screen-parity.replay';
import type { SqliteClient } from './sqlite-adapter';
import { resetForTests, useTaskStore } from './store';

/**
 * Settings › Data's Getting Started row through the native host contract over SQLite (D1b design §0 fix 3): the seed's rows
 * and its request receipt commit in one transaction, so a replay after process death either finds the receipt and writes
 * nothing, or finds nothing and seeds once. Never the old gap: rows committed, receipt lost, and a title match that a newer
 * seed copy no longer finds.
 */
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

let failReceipts = false;
const wrap = (client: SqliteClient): SqliteClient => ({
    ...client,
    run: async (sql, params) => {
        if (failReceipts && sql.startsWith('INSERT INTO native_request_receipts')) throw new Error('disk full');
        await client.run(sql, params);
    },
});
const starterRows = async (env: Awaited<ReturnType<typeof openSqliteHost>>) =>
    env.sql<{ title: string; rev: number; projectId: string | null; status: string }>(
        'SELECT title, rev, projectId, status FROM tasks WHERE deletedAt IS NULL ORDER BY title');

describe('native Getting Started: one transaction for the seed and its receipt', { timeout: 30_000 }, () => {
    let env: Awaited<ReturnType<typeof openSqliteHost>> | null = null;
    const focusTitle = STARTER_SEED_STRINGS.de['starter.focus.title'];
    const lines: LogPayload[] = [];
    afterEach(async () => {
        failReceipts = false;
        STARTER_SEED_STRINGS.de['starter.focus.title'] = focusTitle;
        setLogger(consoleLogger);
        lines.length = 0;
        await env?.close();
        env = null;
    });

    it('a receipt that never committed takes the seed rows with it: the replay after an update to the seed copy seeds once, all fresh', async () => {
        env = await openSqliteHost({}, wrap);
        const input = { requestId: newRequestId(), language: 'de' };
        failReceipts = true;
        expect((await env.host.seedGettingStarted(input)).ok).toBe(false);
        // Process death: the queued retries die with the process.
        resetForTests();
        failReceipts = false;
        expect(await starterRows(env)).toEqual([]);
        // An app update changed one German tutorial title before the replay.
        STARTER_SEED_STRINGS.de['starter.focus.title'] = `${focusTitle} (neu)`;
        await env.restart();
        const reply = value(await env.host.seedGettingStarted(input));
        const rows = await starterRows(env);
        expect(rows).toHaveLength(9);
        expect(rows.filter((row) => row.projectId === reply.projectId)).toHaveLength(7);
        expect(rows.filter((row) => row.projectId === null && row.status === 'inbox')).toHaveLength(2);
        expect(rows.map((row) => row.title)).toContain(`${focusTitle} (neu)`);
        expect(rows.every((row) => row.rev === 1)).toBe(true);
        expect(await env.receiptIds()).toEqual([input.requestId]);
    });

    it('a request that landed replays its first reply and writes nothing, even after the seed copy changed', async () => {
        env = await openSqliteHost({}, wrap);
        const input = { requestId: newRequestId(), language: 'de' };
        const first = value(await env.host.seedGettingStarted(input));
        expect(first.projectId).toEqual(expect.any(String));
        STARTER_SEED_STRINGS.de['starter.focus.title'] = `${focusTitle} (neu)`;
        expect(await env.replay((host) => host.seedGettingStarted(input))).toEqual({ result: { ok: true, value: first }, wrote: false, receipts: false });
        expect(await starterRows(env)).toHaveLength(9);
    });

    it('refuses the same request id with another language and an unsupported language, writing nothing', async () => {
        env = await openSqliteHost({});
        const input = { requestId: newRequestId(), language: 'de' };
        value(await env.host.seedGettingStarted(input));
        const other = await env.host.seedGettingStarted({ ...input, language: 'fr' });
        expect(other.ok ? null : other.error.code).toBe('INVALID_INPUT');
        const unsupported = await env.host.seedGettingStarted({ requestId: newRequestId(), language: 'xx' });
        expect(unsupported.ok ? null : unsupported.error.code).toBe('INVALID_INPUT');
        expect(await starterRows(env)).toHaveLength(9);
    });

    it('logs created, then unchanged for a second request; a receipt replay logs nothing', async () => {
        setLogger((payload) => { lines.push(payload); });
        env = await openSqliteHost({});
        const input = { requestId: newRequestId(), language: 'en' };
        value(await env.host.seedGettingStarted(input));
        value(await env.host.seedGettingStarted({ requestId: newRequestId(), language: 'en' }));
        await env.replay((host) => host.seedGettingStarted(input));
        const seeded = lines.filter((line) => line.message === 'Native Getting Started seeded');
        expect(seeded.map((line) => line.context)).toEqual([
            { releaseCheck: 'v1.3.7/native-getting-started', outcome: 'created' },
            { releaseCheck: 'v1.3.7/native-getting-started', outcome: 'unchanged' },
        ]);
        expect(useTaskStore.getState()._allTasks.filter((task) => !task.deletedAt)).toHaveLength(9);
    });

    it('probes an unknown or pending request without seeding, saving, logging or checking readiness', async () => {
        env = await openSqliteHost({}, wrap);
        setLogger((payload) => { lines.push(payload); });
        const unavailable = () => { throw new Error('The probe must not consult write dependencies'); };
        const probe = createSettingsMethods({
            readiness: unavailable, save: unavailable, t: unavailable, language: unavailable,
            systemLocale: unavailable, dateFormatting: unavailable, dataRevision: unavailable,
            requestIdPattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
        }).probeGettingStartedOutcome;
        const input = { requestId: newRequestId(), language: 'de' };
        const before = useTaskStore.getState();
        expect(probe(input)).toEqual({ ok: true, value: null });
        expect(useTaskStore.getState()).toBe(before);
        expect(await starterRows(env)).toEqual([]);
        expect(await env.receiptIds()).toEqual([]);
        expect(lines).toEqual([]);

        failReceipts = true;
        expect((await env.host.seedGettingStarted(input)).ok).toBe(false);
        const pending = useTaskStore.getState();
        expect(probe(input)).toEqual({ ok: true, value: null });
        expect(useTaskStore.getState()).toBe(pending);
        expect(await starterRows(env)).toEqual([]);
        expect(await env.receiptIds()).toEqual([]);
        expect(lines.filter((line) => line.message === 'Native Getting Started seeded')).toEqual([]);
        // Retire the failed process state, without letting its queued save retry during cleanup.
        resetForTests();
        failReceipts = false;
    });

    it('probes the saved first reply warm and cold without repair or a new receipt', async () => {
        env = await openSqliteHost({});
        const input = { requestId: newRequestId(), language: 'de' };
        const first = value(await env.host.seedGettingStarted(input));
        setLogger((payload) => { lines.push(payload); });
        STARTER_SEED_STRINGS.de['starter.focus.title'] = `${focusTitle} (neu)`;
        const before = useTaskStore.getState();
        expect(env.host.probeGettingStartedOutcome(input)).toEqual({ ok: true, value: first });
        expect(env.host.probeGettingStartedOutcome({ ...input, requestId: newRequestId() })).toEqual({ ok: true, value: null });
        expect(useTaskStore.getState()).toBe(before);
        expect(await env.replay(async (host) => host.probeGettingStartedOutcome(input))).toEqual({
            result: { ok: true, value: first }, wrote: false, receipts: false,
        });
        expect((await starterRows(env)).map((row) => row.title)).not.toContain(`${focusTitle} (neu)`);
        expect(lines.filter((line) => line.message === 'Native Getting Started seeded')).toEqual([]);
    });

    it('refuses invalid probe identity and language reuse without modifying the saved receipt', async () => {
        env = await openSqliteHost({});
        const input = { requestId: newRequestId(), language: 'de' };
        const first = value(await env.host.seedGettingStarted(input));
        const before = useTaskStore.getState();
        for (const invalid of [
            { ...input, requestId: 'invalid' }, { ...input, language: 'xx' }, { ...input, language: 'fr' },
        ]) {
            const result = env.host.probeGettingStartedOutcome(invalid);
            expect(result.ok ? null : result.error.code).toBe('INVALID_INPUT');
        }
        expect(useTaskStore.getState()).toBe(before);
        expect(await env.receiptIds()).toEqual([input.requestId]);
        expect(env.host.probeGettingStartedOutcome(input)).toEqual({ ok: true, value: first });
    });
});
