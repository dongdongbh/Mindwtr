import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeHostResult } from './native-host-contract';
import { loadNativeRequestReceipts, NATIVE_UNJOURNALED_COMMANDS, pruneNativeRequestReceipts, requestRowId, resetNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { openScratchSqlite, openSqliteHost, requestId as newRequestId, value, type ScreenHost } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, getSaveSnapshotGeneration, getStorageAdapter, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Person, Project, Task } from './types';

const AT = '2026-09-01T00:00:00.000Z';
// Relative: a fixed deletion date passes the 90-day tombstone purge and the deleted row is gone on load.
const DELETED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', ...extra,
});
const project = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
    id, title, status: 'active', color: '#2563EB', order: 0, tagIds: [], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', ...extra,
});
const area = (id: string, name: string, extra: Partial<Area> = {}): Area => ({
    id, name, color: '#14b8a6', order: 0, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', ...extra,
});
const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
    id, name, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', ...extra,
});

/** Each transaction's statements, from BEGIN to COMMIT or ROLLBACK, and whether it committed. */
const transactions = (afterCommit?: (client: SqliteClient) => Promise<void>) => {
    const log: { statements: string[]; committed: boolean }[] = [];
    let open: string[] | null = null;
    let failCommits = 0;
    let hold: Promise<void> | null = null;
    const wrap = (client: SqliteClient): SqliteClient => ({
        ...client,
        run: async (sql, params) => {
            if (sql.startsWith('BEGIN') && hold) {
                const held = hold;
                hold = null;
                await held;
            }
            if (sql.startsWith('BEGIN')) open = [];
            else if (sql === 'COMMIT' && failCommits > 0) {
                failCommits -= 1;
                throw new Error('disk full');
            } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                if (open) log.push({ statements: open, committed: sql === 'COMMIT' });
                open = null;
            } else if (open) {
                open.push(sql.startsWith('INSERT INTO native_request_receipts') ? `receipt ${String(params?.[0])}` : sql.trim().split(/\s+/).slice(0, 3).join(' '));
            }
            await client.run(sql, params);
            if (sql === 'COMMIT' && afterCommit) await afterCommit(client);
        },
    });
    return {
        wrap,
        log,
        /** Request IDs whose receipt each committed transaction wrote. */
        committedReceipts: () => log.filter((entry) => entry.committed).map((entry) => entry.statements.filter((line) => line.startsWith('receipt ')).map((line) => line.slice(8))),
        failNextCommits: (count: number) => { failCommits = count; },
        /** The next transaction waits at BEGIN until `release`. */
        holdNextTransaction: () => {
            let release!: () => void;
            hold = new Promise((resolve) => { release = resolve; });
            return release;
        },
    };
};

const store = () => useTaskStore.getState();
/** A later change through the store, saved: in the app, another screen's write. */
const later = async (change: () => Promise<unknown>) => {
    await change();
    await flushPendingSave();
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('durable request receipts: the native host over SQLite', () => {
    let env: Awaited<ReturnType<typeof openSqliteHost>> | null = null;
    const open = async (...args: Parameters<typeof openSqliteHost>) => {
        env = await openSqliteHost(...args);
        return env;
    };
    afterEach(async () => {
        await env?.close();
        env = null;
    });

    it('the adapter hook runs inside saveData and saveTask right before COMMIT, and a throw rolls the save back', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-hook-'));
        const scratch = openScratchSqlite(join(dir, 'hook.db'));
        try {
            const trace = transactions();
            const client = trace.wrap(scratch.client);
            let fail = false;
            class Probe extends SqliteAdapter {
                protected override async beforeCommit(write: { data: AppData } | { task: Task }) {
                    await client.run('INSERT INTO probe (kind) VALUES (?)', ['data' in write ? 'data' : 'task']);
                    if (fail) throw new Error('hook refused');
                }
            }
            const adapter = new Probe(client);
            await adapter.ensureSchema();
            await client.exec('CREATE TABLE probe (kind TEXT)');
            const kinds = () => scratch.client.all<{ kind: string }>('SELECT kind FROM probe');
            await adapter.saveData({ tasks: [task('a')], projects: [], sections: [], areas: [], people: [], settings: {} });
            await adapter.saveTask({ ...task('a'), title: 'Edited', rev: 2 });
            const [data, single] = trace.log.filter((entry) => entry.committed).slice(-2).map((entry) => entry.statements);
            expect(data).toContain('INSERT INTO tasks');
            expect(data.at(-1)).toBe('INSERT INTO probe');
            expect(single).toEqual(['INSERT INTO tasks', 'INSERT INTO probe']);
            expect(await kinds()).toEqual([{ kind: 'data' }, { kind: 'task' }]);

            fail = true;
            await expect(adapter.saveTask({ ...task('a'), title: 'Refused', rev: 3 })).rejects.toThrow('hook refused');
            await expect(adapter.saveData({ tasks: [{ ...task('a'), title: 'Refused', rev: 3 }], projects: [], sections: [], areas: [], people: [], settings: {} }))
                .rejects.toThrow('hook refused');
            expect((await adapter.getData()).tasks[0].title).toBe('Edited');
            expect(await kinds()).toEqual([{ kind: 'data' }, { kind: 'task' }]);
        } finally {
            scratch.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('commits a write\'s receipt in the transaction that commits its data', async () => {
        const trace = transactions();
        const { host, receiptIds } = await open({}, trace.wrap);
        const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
        expect(value(await host.createProject(input))).toEqual({ id: input.requestId });
        const landed = trace.log.filter((entry) => entry.statements.includes(`receipt ${input.requestId}`));
        expect(landed).toHaveLength(1);
        expect(landed[0]).toMatchObject({ committed: true, statements: expect.arrayContaining(['INSERT INTO projects']) });
        expect(await receiptIds()).toEqual([input.requestId]);
    });

    // The rule that keeps a receipt from outliving its data: a save may carry only receipts
    // whose writes its snapshot holds. A snapshot taken before a write never carries it.
    it('a receipt rides only a save whose snapshot holds its write, never one taken before it', async () => {
        const trace = transactions();
        const { host, receiptIds } = await open({}, trace.wrap);
        await store().updateSettings({ weekStart: 'monday' });
        const release = trace.holdNextTransaction();
        // That save took its snapshot now, before the request below, and waits at BEGIN.
        const earlier = flushPendingSave();
        const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
        const creating = host.createProject(input);
        await tick();
        release();
        await earlier;
        expect(value(await creating)).toEqual({ id: input.requestId });
        const committed = trace.committedReceipts().slice(-2);
        expect(committed).toEqual([[], [input.requestId]]);
        // The first of those two transactions saved no project: its snapshot was taken before the request.
        expect(trace.log.filter((entry) => entry.committed).slice(-2)[0].statements).not.toContain('INSERT INTO projects');
        expect(await receiptIds()).toEqual([input.requestId]);
    });

    it('a save that rolls back keeps its receipts pending; the next save commits them', async () => {
        const trace = transactions();
        const env = await open({}, trace.wrap);
        const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
        trace.failNextCommits(1);
        // The store retries the failed save by itself; that retry carries the receipt.
        expect(value(await env.host.createProject(input))).toEqual({ id: input.requestId });
        const tries = trace.log.filter((entry) => entry.statements.includes(`receipt ${input.requestId}`));
        expect(tries.map((entry) => entry.committed)).toEqual([false, true]);
        expect(await env.receiptIds()).toEqual([input.requestId]);
        expect(await env.replay((restarted) => restarted.createProject(input))).toEqual({ result: { ok: true, value: { id: input.requestId } }, wrote: false, receipts: false });
    });

    it('offers saveTask only while a receipted write runs or its receipt is pending, so no later change reaches the disk before it', async () => {
        const trace = transactions();
        const env = await open({ tasks: [task('a')] }, trace.wrap);
        expect(getStorageAdapter().saveTask).toEqual(expect.any(Function));
        const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
        const release = trace.holdNextTransaction();
        const creating = env.host.createProject(input);
        await tick();
        // The create landed in memory; its save waits at BEGIN. A single-task edit now queues a whole snapshot.
        expect(getStorageAdapter().saveTask).toBeUndefined();
        const from = trace.log.length;
        const editing = store().updateTask('a', { title: 'Edited' });
        release();
        expect(await creating).toEqual({ ok: true, value: { id: input.requestId } });
        await editing;
        await flushPendingSave();
        const committed = trace.log.slice(from).filter((entry) => entry.committed).map((entry) => entry.statements);
        // The edit lands with the receipt or after it.
        const receiptAt = committed.findIndex((statements) => statements.includes(`receipt ${input.requestId}`));
        const editAt = committed.findIndex((statements) => statements.includes('INSERT INTO tasks'));
        expect(receiptAt).toBeGreaterThanOrEqual(0);
        expect(editAt).toBeGreaterThanOrEqual(receiptAt);
        expect(getStorageAdapter().saveTask).toEqual(expect.any(Function));
    });

    it('a write that changed nothing is acknowledged after a receipt-only commit', async () => {
        const trace = transactions();
        const env = await open({ projects: [project('p-launch', 'Launch')] }, trace.wrap);
        const reuse = { title: 'Launch', areaId: null, requestId: newRequestId() };
        expect(await env.host.createProject(reuse)).toEqual({ ok: true, value: { id: 'p-launch' } });
        expect(trace.log.at(-1)).toEqual({ committed: true, statements: [`receipt ${reuse.requestId}`] });
        expect(await env.receiptIds()).toEqual([reuse.requestId]);
    });

    it('killed between the data COMMIT and the journal drop: the replay answers the first reply and writes nothing', async () => {
        const env = await open({ areas: [area('a-home', 'Home')] });
        const input = { title: 'Launch', areaId: 'a-home', requestId: newRequestId() };
        const first = await env.host.createProject(input);
        expect(first).toEqual({ ok: true, value: { id: input.requestId } });
        // The process dies here, before the journal drops the entry; the next boot replays it.
        const projects = await env.sql('SELECT id, title, rev FROM projects ORDER BY id');
        const replay = await env.replay((restarted) => restarted.createProject(input));
        expect(replay).toEqual({ result: first, wrote: false, receipts: false });
        expect(await env.sql('SELECT id, title, rev FROM projects ORDER BY id')).toEqual(projects);
        // The same request ID with another input is refused, as before the restart.
        expect(await env.host.createProject({ ...input, title: 'Other' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('durable receipts: a Manage restore of a same-named deleted area, replayed after it was deleted again and a restart, answers its first reply', async () => {
        const env = await open({ areas: [area('a-gone', 'Gone', { deletedAt: DELETED_AT })] });
        const input = { requestId: newRequestId(), target: { type: 'newArea' as const }, name: 'Gone', color: '#14b8a6' };
        const first = await env.host.saveManageEditor(input);
        expect(first).toEqual({ ok: true, value: { changed: true } });
        expect(store()._allAreas.find((entry) => entry.id === 'a-gone')?.deletedAt).toBeUndefined();
        await later(() => store().deleteArea('a-gone'));
        const deletedAt = store()._allAreas.find((entry) => entry.id === 'a-gone')?.deletedAt;
        expect(deletedAt).toEqual(expect.any(String));
        expect(await env.replay((restarted) => restarted.saveManageEditor(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(store()._allAreas.find((entry) => entry.id === 'a-gone')?.deletedAt).toBe(deletedAt);
        expect(store().areas.filter((entry) => entry.name === 'Gone')).toEqual([]);
    });

    it('durable receipts: a Manage new person named like a deleted one, replayed after it was deleted again and a restart, answers its first reply', async () => {
        const env = await open({ people: [person('pe-gone', 'Eve', { deletedAt: DELETED_AT })] });
        const input = { requestId: newRequestId(), target: { type: 'newPerson' as const }, name: 'Eve', note: '' };
        const first = await env.host.saveManageEditor(input);
        expect(first).toEqual({ ok: true, value: { changed: true } });
        const made = store().people.find((entry) => entry.name === 'Eve')!;
        await later(() => store().deletePerson(made.id));
        const people = JSON.stringify(store()._allPeople);
        expect(await env.replay((restarted) => restarted.saveManageEditor(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(JSON.stringify(store()._allPeople)).toBe(people);
        expect(store().people.filter((entry) => entry.name === 'Eve')).toEqual([]);
    });

    it('createProject that reused a same-titled project: a replay after that project was renamed makes no second project', async () => {
        const env = await open({ projects: [project('p-launch', 'Launch')] });
        const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
        const first = await env.host.createProject(input);
        expect(first).toEqual({ ok: true, value: { id: 'p-launch' } });
        // The rename's save also commits that reuse's receipt (it wrote no data of its own).
        await later(() => store().updateProject('p-launch', { title: 'Renamed' }));
        expect(await env.replay((restarted) => restarted.createProject(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(store()._allProjects.map((entry) => [entry.id, entry.title])).toEqual([['p-launch', 'Renamed']]);
    });

    it('a capture whose project landed and task failed: a replay after the project was renamed adds the task to it and makes no second project', async () => {
        const env = await open({});
        const options = value(env.host.openQuickCapture()).options;
        const capture = { text: 'Plan beds +Garden', options, captureId: newRequestId() };
        const projectId = requestRowId(capture.captureId, 'project:garden');
        const addTask = store().addTask;
        useTaskStore.setState({ addTask: async () => ({ success: false, error: 'Task store refused' }) });
        expect(await env.host.submitQuickCapture(capture)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        useTaskStore.setState({ addTask });
        // The project landed without its task: the request did not land, so it keeps no receipt.
        await flushPendingSave();
        expect(await env.receiptIds()).toEqual([]);
        await later(() => store().updateProject(projectId, { title: 'Beds' }));
        const replay = await env.replay((restarted) => restarted.submitQuickCapture(capture));
        expect(replay.result).toMatchObject({ ok: true, value: { kind: 'saved', taskId: capture.captureId.toLowerCase(), projectId } });
        expect(store()._allProjects.map((entry) => [entry.id, entry.title])).toEqual([[projectId, 'Beds']]);
        expect(store()._tasksById.get(capture.captureId.toLowerCase())).toMatchObject({ title: 'Plan beds', projectId });
        // Landed now: the next replay answers from its receipt.
        expect(await env.replay((restarted) => restarted.submitQuickCapture(capture))).toEqual({ result: replay.result, wrote: false, receipts: false });
    });

    it('a Someday section created then deleted: a replay after a restart does not make it again', async () => {
        const env = await open({});
        const input = { title: 'Hobbies', requestId: newRequestId() };
        const first = await env.host.createSomedaySection(input);
        expect(first).toEqual({ ok: true, value: { id: input.requestId.toLowerCase(), existing: false } });
        expect(value(await env.host.deleteSomedaySection({ id: input.requestId.toLowerCase() }))).toMatchObject({ changed: true });
        const settings = JSON.stringify(store().settings);
        expect(await env.replay((restarted) => restarted.createSomedaySection(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(JSON.stringify(store().settings)).toBe(settings);
    });

    it('a saved search created then deleted: a replay after a restart does not make it again', async () => {
        const env = await open({});
        const input = { query: 'launch', name: 'Launch', requestId: newRequestId() };
        const first = await env.host.saveSearch(input);
        expect(first).toEqual({ ok: true, value: { id: input.requestId.toLowerCase(), existing: false } });
        expect(value(await env.host.deleteSavedSearch({ requestId: newRequestId(), id: input.requestId.toLowerCase() }))).toEqual({ changed: true });
        expect(await env.replay((restarted) => restarted.saveSearch(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(store().settings.savedSearches ?? []).toEqual([]);
    });

    it('editor ABA: a replay of A to B after a later change back to A keeps A', async () => {
        const env = await open({ tasks: [task('a', { title: 'A' })] });
        const toB = { id: 'a', base: { title: 'A' }, patch: { title: 'B' }, requestId: newRequestId() };
        const first = await env.host.updateTask(toB);
        expect(first).toEqual({ ok: true, value: { id: 'a', changed: true } });
        expect(value(await env.host.saveTaskDraft({ id: 'a', base: { title: 'B' }, patch: { title: 'A' }, requestId: newRequestId() })).draft.title).toBe('A');
        expect(await env.replay((restarted) => restarted.updateTask(toB))).toEqual({ result: first, wrote: false, receipts: false });
        expect(store()._tasksById.get('a')?.title).toBe('A');
        // The draft save the same way.
        const draftToB = { id: 'a', base: { title: 'A' }, patch: { title: 'B' }, requestId: newRequestId() };
        const draftFirst = await env.host.saveTaskDraft(draftToB);
        await later(() => store().updateTask('a', { title: 'A' }));
        expect(await env.replay((restarted) => restarted.saveTaskDraft(draftToB))).toEqual({ result: draftFirst, wrote: false, receipts: false });
        expect(store()._tasksById.get('a')?.title).toBe('A');
    });

    it('a setting changed later: a replay of the earlier change keeps the later value', async () => {
        const env = await open({});
        const earlier = { requestId: newRequestId(), edit: { type: 'timeFormat' as const, value: '12h' } };
        const first = await env.host.setGeneralSetting(earlier);
        expect(first.ok).toBe(true);
        expect(value(await env.host.setGeneralSetting({ requestId: newRequestId(), edit: { type: 'timeFormat', value: '24h' } })).changed).toBe(true);
        expect(await env.replay((restarted) => restarted.setGeneralSetting(earlier))).toEqual({ result: first, wrote: false, receipts: false });
        expect(store().settings.timeFormat).toBe('24h');
    });

    it('Debug logging switched off later: a replay of the earlier switch-on keeps it off', async () => {
        const env = await open({});
        const on = { requestId: newRequestId(), edit: { type: 'debugLogging' as const, value: true } };
        const first = await env.host.setDataSetting(on);
        expect(first.ok).toBe(true);
        expect(value(await env.host.setDataSetting({ requestId: newRequestId(), edit: { type: 'debugLogging', value: false } })).changed).toBe(true);
        expect(await env.replay((restarted) => restarted.setDataSetting(on))).toEqual({ result: first, wrote: false, receipts: false });
        expect(store().settings.diagnostics?.loggingEnabled).toBe(false);
    });

    it('the scoped Data receipt survives a cold old-on replay after later-off without changing raw settings or receipts', async () => {
        const env = await open({ settings: { diagnostics: { loggingEnabled: false, retained197: 'keep' } as AppData['settings']['diagnostics'] } });
        await loadNativeRequestReceipts(env.client(), { durableCommands: ['data'] });
        const on = { requestId: newRequestId(), edit: { type: 'debugLogging' as const, value: true } };
        const first = await env.host.setDataSetting(on);
        expect(first).toEqual({ ok: true, value: { changed: true, deviceWrites: [] } });
        const off = { requestId: newRequestId(), edit: { type: 'debugLogging' as const, value: false } };
        expect(value(await env.host.setDataSetting(off)).changed).toBe(true);
        const receipts = await env.sql<{ method: string }>('SELECT rowid AS evidence_rowid, * FROM native_request_receipts ORDER BY rowid');
        expect(receipts).toHaveLength(2);
        expect(receipts.every((row) => /^data:[0-9a-f]{32}$/.test(row.method))).toBe(true);
        const restarted = await env.restart();
        await loadNativeRequestReceipts(env.client(), { durableCommands: ['data'] });
        const settings = await env.sql('SELECT rowid AS evidence_rowid, * FROM settings ORDER BY rowid');
        expect(await restarted.setDataSetting(on)).toEqual(first);
        await flushPendingSave();
        expect(await env.sql('SELECT rowid AS evidence_rowid, * FROM settings ORDER BY rowid')).toEqual(settings);
        expect(await env.sql('SELECT rowid AS evidence_rowid, * FROM native_request_receipts ORDER BY rowid')).toEqual(receipts);
        expect(store().settings.diagnostics).toEqual({ loggingEnabled: false, retained197: 'keep' });
    });

    it('the scoped Data receipt rejects reuse of a saved UUID for the opposite switch value after cold boot', async () => {
        const env = await open({});
        await loadNativeRequestReceipts(env.client(), { durableCommands: ['data'] });
        const input = { requestId: newRequestId(), edit: { type: 'debugLogging' as const, value: true } };
        expect((await env.host.setDataSetting(input)).ok).toBe(true);
        const restarted = await env.restart();
        await loadNativeRequestReceipts(env.client(), { durableCommands: ['data'] });
        const settings = await env.sql('SELECT rowid AS evidence_rowid, * FROM settings');
        const receipts = await env.sql('SELECT rowid AS evidence_rowid, * FROM native_request_receipts');
        const refused = await restarted.setDataSetting({ ...input, edit: { type: 'debugLogging', value: false } });
        expect(refused.ok ? null : refused.error.code).toBe('INVALID_INPUT');
        expect(await env.sql('SELECT rowid AS evidence_rowid, * FROM settings')).toEqual(settings);
        expect(await env.sql('SELECT rowid AS evidence_rowid, * FROM native_request_receipts')).toEqual(receipts);
    });

    it('scoped Data saves carry their receipt through rollback and automatic retry, then return the original ACK cold', async () => {
        const trace = transactions();
        const env = await open({}, trace.wrap);
        await loadNativeRequestReceipts(env.client(), { durableCommands: ['data'] });
        const input = { requestId: newRequestId(), edit: { type: 'debugLogging' as const, value: true } };
        trace.failNextCommits(1);
        const first = await env.host.setDataSetting(input);
        expect(first).toEqual({ ok: true, value: { changed: true, deviceWrites: [] } });
        expect(trace.log.filter((transaction) => transaction.statements.includes(`receipt ${input.requestId}`)).map((transaction) => transaction.committed)).toEqual([false, true]);
        expect(await env.receiptIds()).toEqual([input.requestId]);
        const restarted = await env.restart();
        await loadNativeRequestReceipts(env.client(), { durableCommands: ['data'] });
        const rows = await env.sql('SELECT rowid AS evidence_rowid, * FROM native_request_receipts');
        expect(await restarted.setDataSetting(input)).toEqual(first);
        expect(await env.sql('SELECT rowid AS evidence_rowid, * FROM native_request_receipts')).toEqual(rows);
    });

    // An archived project's task set back to Next reactivates the project, and the store saves
    // that inside the write (before its receipt exists).
    const reactivation = {
        projects: [project('p-arch', 'Old', { status: 'archived' })],
        tasks: [task('t-done', { status: 'done', projectId: 'p-arch', contexts: ['@home'], completedAt: AT })],
    };
    const reactivate = (requestId: string) => ({
        requestId, action: { type: 'setTaskStatus' as const, taskId: 't-done', status: 'next' as const, taskRevision: taskRevisionOf(store()._tasksById.get('t-done')!) },
    });

    it('a write whose data a save inside it committed is acknowledged only after a commit that carries its receipt', async () => {
        const trace = transactions();
        const env = await open(reactivation, trace.wrap);
        const input = reactivate(newRequestId());
        const first = await env.host.runContextsAction(input);
        expect(first).toMatchObject({ ok: true, value: { changed: true } });
        expect(store()._projectsById.get('p-arch')?.status).toBe('active');
        expect(trace.log.filter((entry) => entry.committed).at(-1)!.statements).toContain(`receipt ${input.requestId}`);
        expect(await env.receiptIds()).toEqual([input.requestId]);
        expect(await env.replay((restarted) => restarted.runContextsAction(input))).toEqual({ result: first, wrote: false, receipts: false });
    });

    // Process death right after each COMMIT a write makes: the journal still holds the request, and
    // the next boot replays it on the disk as that COMMIT left it.
    it.each([
        ['a write whose store action saves inside it', reactivation, (requestId: string) => {
            const input = reactivate(requestId);
            return (host: ScreenHost) => host.runContextsAction(input);
        }],
        ['a create', {}, (requestId: string) => (host: ScreenHost) => host.createProject({ title: 'Launch', areaId: null, requestId })],
    ] as const)('killed right after any COMMIT of %s: the replay writes nothing more; after the last one, it answers the first reply', async (_name, seed, request) => {
        let copies: string[] | null = null;
        let env: Awaited<ReturnType<typeof open>>;
        const trace = transactions(async (client) => {
            if (!copies) return;
            const copy = join(env.dir, `commit-${copies.length}.db`);
            await client.exec(`VACUUM INTO '${copy}'`);
            copies.push(copy);
        });
        env = await open(seed, trace.wrap);
        const run = request(newRequestId());
        copies = [];
        const first = await run(env.host);
        const commits = copies;
        copies = null;
        expect(first.ok).toBe(true);
        expect(commits.length).toBeGreaterThan(0);
        const state = () => JSON.stringify([store()._allTasks.map((entry) => [entry.id, entry.status]), store()._allProjects.map((entry) => [entry.id, entry.status, entry.title])]);
        const landed = state();
        for (const [index, copy] of commits.entries()) {
            const replay = await env.replay(run, copy);
            expect(replay.result.ok).toBe(true);
            expect(replay.wrote).toBe(false);
            expect(state()).toBe(landed);
            // The reply came after the last COMMIT: that disk holds the receipt, so the replay answers it.
            if (index === commits.length - 1) expect(replay).toEqual({ result: first, wrote: false, receipts: false });
        }
    });

    it('a request UUID a pending receipt holds is refused to another command', async () => {
        const trace = transactions();
        const env = await open({}, trace.wrap);
        const requestId = newRequestId();
        const release = trace.holdNextTransaction();
        // The create landed in memory; its save (with its receipt) waits at BEGIN.
        const creating = env.host.createProject({ title: 'Launch', areaId: null, requestId });
        await tick();
        expect(await env.host.setGeneralSetting({ requestId, edit: { type: 'timeFormat', value: '12h' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        release();
        expect(await creating).toEqual({ ok: true, value: { id: requestId } });
        expect(store().settings.timeFormat).toBeUndefined();
    });

    it('tags save snapshots with their generation only while durable receipts are on: React Native pays nothing', async () => {
        const captured: AppData[] = [];
        const capture = { getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData: async (data: AppData) => { captured.push(data); } };
        resetNativeRequestReceipts();
        setStorageAdapter(capture);
        await store().persistSnapshot();
        await flushPendingSave();
        expect(captured).toHaveLength(1);
        expect(getSaveSnapshotGeneration(captured[0])).toBeUndefined();

        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-generation-'));
        const scratch = openScratchSqlite(join(dir, 'receipts.db'));
        try {
            await loadNativeRequestReceipts(scratch.client);
            setStorageAdapter(capture);
            await store().persistSnapshot();
            await flushPendingSave();
            expect(captured).toHaveLength(2);
            expect(getSaveSnapshotGeneration(captured[1])).toEqual(expect.any(Number));
        } finally {
            resetNativeRequestReceipts();
            scratch.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps a fingerprint of the request on disk, never its text: the command and a 128-bit hash', async () => {
        const env = await open({});
        const input = { title: 'Launch plan for Mira', areaId: null, requestId: newRequestId() };
        const first = await env.host.createProject(input);
        const rows = await env.sql<{ method: string; reply: string }>('SELECT method, reply FROM native_request_receipts');
        expect(rows).toHaveLength(1);
        expect(rows[0].method).toMatch(/^createProject:[0-9a-f]{32}$/);
        expect(rows[0].method).not.toContain('Mira');
        // The fingerprint still tells the same request from another under its ID.
        expect(await env.replay((restarted) => restarted.createProject(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(await env.host.createProject({ ...input, title: 'Other' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('keeps no receipt on disk for a command the journal never keeps', async () => {
        const unjournaled = NATIVE_UNJOURNALED_COMMANDS as Set<string>;
        unjournaled.add('createProject');
        try {
            const env = await open({});
            const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
            expect(await env.host.createProject(input)).toEqual({ ok: true, value: { id: input.requestId } });
            expect(await env.receiptIds()).toEqual([]);
            expect(getStorageAdapter().saveTask).toEqual(expect.any(Function));
        } finally {
            unjournaled.delete('createProject');
        }
    });

    it('prunes receipts older than 30 days, on the call after the boot replay', async () => {
        const env = await open({});
        const input = { title: 'Launch', areaId: null, requestId: newRequestId() };
        const first: NativeHostResult<{ id: string }> = await env.host.createProject(input);
        expect(first.ok).toBe(true);
        const client = env.client();
        expect(await pruneNativeRequestReceipts(client, new Date(Date.now() + 29 * 24 * 60 * 60 * 1000))).toBe(0);
        expect(await env.receiptIds()).toEqual([input.requestId]);
        expect(await pruneNativeRequestReceipts(client, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1);
        expect(await env.receiptIds()).toEqual([]);
        // Without its receipt the replay runs again, under the write rules: the project its UUID named
        // answers, nothing is written, and the replay keeps a receipt of its own.
        expect(await env.replay((restarted) => restarted.createProject(input))).toEqual({ result: first, wrote: false, receipts: true });
    });
});
