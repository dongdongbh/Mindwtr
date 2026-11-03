import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import { NativeReceiptSqliteAdapter, resetNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { getAdvancedReviewDate } from './review-utils';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData, Task } from './types';

const NOW = '2026-09-23T14:00:00.000Z';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const task = (id: string, reviewAt: string): Task => ({
    id, title: `Review ${id}`, status: 'next', reviewAt, description: 'Retained note',
    tags: ['#retained'], contexts: ['@home'], createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', rev: 7, revBy: 'first-device',
});

const require = createRequire(import.meta.url);
type Statement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const sqliteRoot = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(sqliteRoot, { recursive: true });

describe('prepared Review row Task write on SQLite', () => {
    const originalTZ = process.env.TZ;
    const databases: Database[] = [];
    const directories: string[] = [];
    const clientOf = (db: Database, fault: { commits: number }): SqliteClient => ({
        run: async (sql, params = []) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits -= 1; throw new Error('injected commit failure'); }
            db.prepare(sql).run(...params);
        },
        all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
        get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
        exec: async (sql) => { db.exec(sql); },
    });
    const openSqlite = async (path: string, seed = false) => {


        resetForTests(); resetNativeRequestReceipts();
        const db = new DatabaseSync(path); databases.push(db);
        const fault = { commits: 0 };
        const client = clientOf(db, fault);
        if (seed) await new NativeReceiptSqliteAdapter(client).saveData(initial());
        setStorageAdapter(new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true }));
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        await flushPendingSave();
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        await flushPendingSave();
        return { db, host, fault };
    };

    beforeEach(() => {
        process.env.TZ = 'America/New_York';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
    });
    afterEach(async () => {
        resetForTests(); resetNativeRequestReceipts();
        for (const db of databases.splice(0)) db.close();
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
        vi.useRealTimers();
        if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    });

    it('cold-retries a failed COMMIT exactly, then refuses an intervening saved edit', async () => {
        const directory = mkdtempSync(join(sqliteRoot, 'review-task-')); directories.push(directory);
        const path = join(directory, 'data.sqlite');
        const first = await openSqlite(path, true);
        const source = useTaskStore.getState()._tasksById.get('timed')!;
        const input = { type: 'markTaskReviewed' as const, taskId: source.id, advance: true,
            taskRevision: taskRevisionOf(source) };
        const plan = await first.host.prepareReviewTaskWrite(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const { request } = plan.value.prepared;
        const prepared = clone(plan.value.prepared);
        const before = first.db.prepare('SELECT * FROM tasks ORDER BY id').all();
        first.fault.commits = 10;
        expect(await first.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(first.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);

        const cold = await openSqlite(path);
        expect(await cold.host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        const committed = cold.db.prepare('SELECT * FROM tasks ORDER BY id').all();
        expect(cold.db.prepare('SELECT reviewAt, description, rev, updatedAt FROM tasks WHERE id = ?').get('timed'))
            .toEqual({ reviewAt: '2026-09-30T09:30', description: 'Retained note',
                rev: prepared.effect.task.after.rev, updatedAt: prepared.preparedAt });
        expect(committed.find((row) => (row as { id: string }).id === 'day'))
            .toEqual(before.find((row) => (row as { id: string }).id === 'day'));

        const replay = await openSqlite(path);
        expect(await replay.host.commitPreparedTaskDraftSave({ request, prepared })).toMatchObject({ ok: true });
        expect(replay.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(committed);
        replay.db.prepare('UPDATE tasks SET description = ?, rev = ?, revBy = ?, updatedAt = ? WHERE id = ?')
            .run('Other writer', 50, 'second-device', '2026-09-24T12:00:00.000Z', 'timed');
        const changed = replay.db.prepare('SELECT * FROM tasks ORDER BY id').all();
        const stale = await openSqlite(path);
        expect(await stale.host.commitPreparedTaskDraftSave({ request, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stale.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(changed);
    }, 30_000);
});
const initial = (): AppData => ({
    tasks: [task('day', '2026-09-21'), task('timed', '2026-09-21T09:30'), task('future', '2026-10-01')],
    projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'review-device' },
});

describe('prepared native Review row Task write', () => {
    const originalTZ = process.env.TZ;
    let durable: AppData;
    let saves: ReturnType<typeof vi.fn>;
    let afterDurableRead: (() => void) | null = null;

    const open = async (data = initial()) => {
        await flushPendingSave();
        resetForTests();
        durable = clone(data);
        afterDurableRead = null;
        saves = vi.fn(async (next: AppData) => { durable = clone(next); });
        setStorageAdapter({ getData: async () => {
            const snapshot = clone(durable);
            afterDurableRead?.();
            return snapshot;
        }, saveData: saves });
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true, recoveryLoad: true })).toMatchObject({ ok: true });
        await flushPendingSave();
        saves.mockClear();
        return host;
    };
    const saved = (id: string) => clone(durable.tasks.find((row) => row.id === id)!);
    const action = (id: string, advance: boolean) => ({
        type: 'markTaskReviewed' as const, taskId: id, advance,
        taskRevision: taskRevisionOf(saved(id)),
    });
    const prepared = async (host: Awaited<ReturnType<typeof open>>, input: ReturnType<typeof action>) => {
        const result = await host.prepareReviewTaskWrite(input);
        if (!result.ok || result.value.kind !== 'prepared') throw new Error(JSON.stringify(result));
        return result.value.prepared;
    };

    beforeEach(() => {
        process.env.TZ = 'America/New_York';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
    });
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    });

    it.each([
        ['day', true, '2026-09-30'],
        ['timed', true, '2026-09-30T09:30'],
        ['day', false, undefined],
    ] as const)('matches the complete RN updateTask row for %s advance=%s', async (id, advance, reviewAt) => {
        await open();
        const before = saved(id);
        expect(await useTaskStore.getState().updateTask(id, {
            reviewAt: advance ? getAdvancedReviewDate(before.reviewAt, new Date()) : undefined,
        })).toMatchObject({ success: true });
        await flushPendingSave();
        const expected = saved(id);
        const host = await open();
        const input = action(id, advance);
        const baseline = clone(durable);
        const plan = await prepared(host, input);
        expect(durable).toEqual(baseline);
        expect(saves).not.toHaveBeenCalled();
        expect(plan.request).toEqual({ id, base: { reviewAt: expect.any(String) },
            patch: { reviewAt: advance ? reviewAt : '' }, scheduleBase: expect.objectContaining({ reviewAt: before.reviewAt }) });
        expect(plan.effect.task.after).toEqual(expected);
        expect(await host.commitPreparedTaskDraftSave({ request: plan.request, prepared: plan }))
            .toMatchObject({ ok: true, value: { id } });
        expect(saved(id)).toEqual(expected);
        expect(saved(id).reviewAt).toBe(reviewAt);
        expect(saved(id).description).toBe('Retained note');
    });

    it('returns the ordinary no-op for a no-longer-due row before checking its displayed revision', async () => {
        const host = await open();
        const input = { ...action('future', true), taskRevision: 'older:revision:value' };
        const before = clone(durable);
        expect(await host.prepareReviewTaskWrite(input)).toMatchObject({ ok: true, value: { kind: 'noop', result: { id: 'future' } } });
        expect(durable).toEqual(before);
        expect(saves).not.toHaveBeenCalled();
    });

    it('refuses a due row whose displayed revision changed, and rejects malformed action shapes', async () => {
        const host = await open();
        const stale = { ...action('day', true), taskRevision: 'older:revision:value' };
        const before = clone(durable);
        expect(await host.prepareReviewTaskWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await host.prepareReviewTaskWrite({ ...stale, taskId: 'missing' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        for (const invalid of [{ ...action('day', true), extra: 1 }, { ...action('day', true), advance: 'true' },
            { ...action('day', true), taskRevision: '' }, { ...action('day', true), taskId: 'x'.repeat(501) }]) {
            expect(await host.prepareReviewTaskWrite(invalid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(durable).toEqual(before);
        expect(saves).not.toHaveBeenCalled();
    });

    it('freezes the next local review day across midnight and rejects a widened prepared effect', async () => {
        const host = await open();
        const input = action('day', true);
        const plan = await prepared(host, input);
        expect(plan.effect.task.after.reviewAt).toBe('2026-09-30');
        const widened = clone(plan);
        widened.effect.task.after.description = 'Injected';
        expect(host.validatePreparedTaskDraftSave({ request: widened.request, prepared: widened }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        vi.setSystemTime(new Date('2026-09-24T14:00:00.000Z'));
        expect(await host.commitPreparedTaskDraftSave({ request: plan.request, prepared: plan })).toMatchObject({ ok: true });
        expect(saved('day').reviewAt).toBe('2026-09-30');
        expect(saved('day').updatedAt).toBe(NOW);
    });

    it('refuses a writer between the Review read and Draft V2 read even when the review date stayed due', async () => {
        const host = await open();
        const input = action('day', true);
        afterDurableRead = () => {
            afterDurableRead = null;
            const row = durable.tasks.find((entry) => entry.id === 'day')!;
            Object.assign(row, { description: 'Another writer', rev: 8, updatedAt: '2026-09-23T13:00:00.000Z' });
        };
        expect(await host.prepareReviewTaskWrite(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saved('day')).toMatchObject({ description: 'Another writer', reviewAt: '2026-09-21', rev: 8 });
        expect(saves).not.toHaveBeenCalled();
    });
});
