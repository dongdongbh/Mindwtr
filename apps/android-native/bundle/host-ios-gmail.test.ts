import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { gmailCaptureIdFor } from '../../../packages/core/src/gmail-capture';

const ACCOUNT = 'a'.repeat(64);
const SECRET_TEXT = /tester@example|Subject m|Body m|Mindwtr label|ya29|refresh-token/;
let source: string;
const fixtures: Array<{ state: Record<string, any>; database: Database; dispose: () => void }> = [];

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        globalThis.fixture = { state: useTaskStore.getState, flush: flushPendingSave, reset: resetForTests,
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); f.dispose(); }
});

const message = (id: string) => ({ id, labelIds: ['label'], payload: { mimeType: 'text/plain',
    headers: [{ name: 'Subject', value: `Subject ${id}` }], body: { data: Buffer.from(`Body ${id}`).toString('base64url'), size: Buffer.byteLength(`Body ${id}`) } } });

const receiptFolder = () => {
    const folder = mkdtempSync(join(tmpdir(), 'ios-gmail-receipts-'));
    const open = new Map<string, Database>();
    let failAcknowledge = false;
    const path = (name: string) => {
        if (!/^(receipts(\.corrupt-\d+)?\.sqlite(-wal|-shm|-journal)?|receipts-reset)$/.test(name)) throw new Error('Not a Gmail receipts file');
        return join(folder, name);
    };
    const file = (op: string, name: string, to = ''): string => {
        if (op === 'list') return JSON.stringify(readdirSync(folder).sort());
        const target = path(name);
        if (op === 'exists') return String(existsSync(target));
        if (op === 'size') return String(statSync(target).size);
        if (op === 'create') { mkdirSync(folder, { recursive: true }); writeFileSync(target, '', { flag: 'wx' }); return ''; }
        if (op === 'rename') { if (existsSync(path(to))) throw new Error('exists'); renameSync(target, path(to)); return ''; }
        if (op === 'remove') { if (existsSync(target)) unlinkSync(target); return ''; }
        if (op === 'open') { open.get(name)?.close(); open.set(name, new Database(target)); return ''; }
        if (op === 'close') { open.get(name)?.close(); open.delete(name); return ''; }
        throw new Error('Unsupported');
    };
    const sql = (name: string, text: string, params: string): string => {
        if (failAcknowledge && text.startsWith('INSERT OR IGNORE INTO receipts')) throw new Error('disk I/O error');
        const db = open.get(name);
        if (!db) throw new Error('The Gmail receipts file is not open');
        return JSON.stringify(db.query(text).all(...(JSON.parse(params) as never[])));
    };
    const seed = (name: string, messages: string[]) => {
        const db = new Database(join(folder, name));
        db.exec('CREATE TABLE receipts (account TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (account, message))');
        db.exec('CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), account TEXT, label TEXT, enabled INTEGER NOT NULL, blocked INTEGER NOT NULL)');
        db.query('INSERT INTO control VALUES (1, ?, ?, 1, 0)').run(ACCOUNT, 'label');
        for (const id of messages) db.query('INSERT INTO receipts VALUES (?, ?)').run(ACCOUNT, id);
        db.close();
    };
    const receipts = () => {
        const db = new Database(join(folder, 'receipts.sqlite'));
        try { return (db.query('SELECT message FROM receipts').all() as Array<{ message: string }>).map((row) => row.message).sort(); }
        finally { db.close(); }
    };
    return { folder, file, sql, seed, receipts, failAcknowledge: (on: boolean) => { failAcknowledge = on; },
        dispose: () => { open.forEach((db) => db.close()); rmSync(folder, { recursive: true, force: true }); } };
};

const fixture = (options: { gmail?: boolean } = {}) => {
    const database = new Database(':memory:');
    const receipts = receiptFolder();
    const lines: string[] = [];
    const requests: string[] = [];
    let listed = ['m1'];
    let paged = false;
    const gmailCall = async ({ op, path }: { op: string; path?: string }) => {
        requests.push(path ? `${op} ${path}` : op);
        if (op === 'status' || op === 'connect') return { available: true, connected: true, account: 'tester@example.invalid', accountId: ACCOUNT };
        if (op === 'disconnect') return { revoked: true };
        if (op === 'get' && path === 'labels') return { labels: [{ id: 'label', name: 'Mindwtr label' }] };
        if (op === 'get' && path?.startsWith('labels/')) return { id: 'label' };
        if (op === 'get' && path?.startsWith('messages?') && paged) {
            return path.includes('pageToken=next') ? { messages: [{ id: 'm3' }, { id: 'm4' }] } : { messages: listed.map((id) => ({ id })), nextPageToken: 'next' };
        }
        if (op === 'get' && path?.startsWith('messages?')) return { messages: listed.map((id) => ({ id })) };
        if (op === 'get' && path?.startsWith('messages/')) return message(decodeURIComponent(path.slice(9).split('?')[0]));
        return null;
    };
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        ...(options.gmail === false ? {} : { __mindwtrGmailCall: gmailCall }),
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array.from({ length: count }, () => Math.floor(Math.random() * 256))),
            log: (line: string) => { lines.push(line); },
            logFile: (operation: string, text: string) => {
                if (operation === 'append' || operation === 'write') lines.push(text);
                return ['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : operation === 'size' ? '0' : '';
            },
            rnStateCommit: () => null, kvGet: () => '[null]', kvSet: () => null, kvRemove: () => null,
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
            ...(options.gmail === false ? {} : { gmailFile: receipts.file, gmailSql: receipts.sql }),
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 200; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    const request = async (name: string, input: Record<string, unknown> = {}) => poll(state.MindwtrHost.iosGmailRequest(name, JSON.stringify(input)));
    const lifecycle = async (appState: string) => poll(state.MindwtrHost.iosGmailLifecycle(appState));
    const boot = async () => { expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true }); };
    const gmailTasks = () => (state.fixture.state()._allTasks as Array<{ id: string; title: string; status: string; deletedAt?: string }>)
        .filter((task) => ['m1', 'm2', 'm3', 'm4'].map((id) => gmailCaptureIdFor(ACCOUNT, id)).includes(task.id));
    const storedTaskIds = () => (database.query('SELECT id FROM tasks').all() as Array<{ id: string }>).map((row) => row.id);
    const f = { state, database, receipts, lines, requests, poll, request, lifecycle, boot, gmailTasks, storedTaskIds,
        list: (ids: string[]) => { listed = ids; }, paged: (on: boolean) => { paged = on; }, dispose: receipts.dispose };
    fixtures.push(f);
    return f;
};

const start = async (f: ReturnType<typeof fixture>) => {
    await f.boot();
    expect(await f.request('configure', { labelId: 'label', enabled: true })).toMatchObject({ ok: true, value: { value: { enabled: true } } });
    expect(await f.lifecycle('active')).toMatchObject({ ok: true });
};

describe('iOS Gmail capture host', () => {
    it.each(['boot', 'sandbox', 'transition', 'binding'])('refuses %s as not ready', async (guard) => {
        const f = fixture({ gmail: guard !== 'binding' });
        if (guard !== 'boot') await f.boot();
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        expect(await f.request('config')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        expect(await f.lifecycle('active')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
    });

    it('rejects malformed input before it reaches Gmail', async () => {
        const f = fixture();
        await f.boot();
        expect(await f.poll(f.state.MindwtrHost.iosGmailRequest('config'))).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(await f.poll(f.state.MindwtrHost.iosGmailRequest('config', '[]'))).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(await f.lifecycle('inactive')).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(await f.request('nope')).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(f.requests).toEqual([]);
    });

    it('saves each message as one Inbox task, keeps it on disk before its receipt, and never repeats it', async () => {
        const f = fixture();
        await start(f);
        expect(await f.request('checkNow')).toEqual({ ok: true, value: { value: null } });
        expect(f.gmailTasks().map((task) => [task.title, task.status])).toEqual([['Subject m1', 'inbox']]);
        expect(f.storedTaskIds()).toContain(gmailCaptureIdFor(ACCOUNT, 'm1'));
        expect(f.receipts.receipts()).toEqual(['m1']);
        f.list(['m2', 'm1']);
        await f.request('checkNow');
        await f.request('checkNow');
        expect(f.gmailTasks().map((task) => task.title).sort()).toEqual(['Subject m1', 'Subject m2']);
        expect(f.requests.filter((line) => line.startsWith('get messages/'))).toEqual(['get messages/m1?format=full', 'get messages/m2?format=full']);
        expect((await f.request('status')).value.value).toMatchObject({ lastImportCount: 0, lastError: null, terminal: false });
    });

    it('reads one page per check, so one check holds the host for one page only', async () => {
        const f = fixture();
        f.paged(true);
        await start(f);
        f.list(['m1', 'm2']);
        await f.request('checkNow');
        expect(f.requests.filter((line) => line.startsWith('get messages?'))).toHaveLength(1);
        await f.request('checkNow');
        expect(f.requests.filter((line) => line.startsWith('get messages?'))).toEqual([
            'get messages?labelIds=label&maxResults=25', 'get messages?labelIds=label&maxResults=25&pageToken=next']);
        expect(f.gmailTasks()).toHaveLength(4);
    });

    it('a receipt lost after the save captures the mail again without a second task', async () => {
        const f = fixture();
        await start(f);
        f.receipts.failAcknowledge(true);
        await f.request('checkNow');
        expect((await f.request('status')).value.value).toMatchObject({ lastError: { kind: 'storage' }, lastErrorKey: 'settings.gmailCaptureStorageFailed' });
        expect(f.gmailTasks()).toHaveLength(1);
        expect(f.receipts.receipts()).toEqual([]);
        f.receipts.failAcknowledge(false);
        await f.request('checkNow');
        expect(f.gmailTasks()).toHaveLength(1);
        expect(f.storedTaskIds().filter((id) => id === gmailCaptureIdFor(ACCOUNT, 'm1'))).toHaveLength(1);
        expect(f.receipts.receipts()).toEqual(['m1']);
    });

    it('a deleted captured task is not brought back when its receipt was lost', async () => {
        const f = fixture();
        await start(f);
        f.receipts.failAcknowledge(true);
        await f.request('checkNow');
        await f.state.fixture.state().deleteTask(gmailCaptureIdFor(ACCOUNT, 'm1'));
        await f.state.fixture.flush();
        f.receipts.failAcknowledge(false);
        await f.request('checkNow');
        expect(f.gmailTasks().map((task) => Boolean(task.deletedAt))).toEqual([true]);
        expect(f.receipts.receipts()).toEqual(['m1']);
    });

    it('a damaged receipts file is moved aside, capture stops and says so until it starts again, and saved mail stays saved', async () => {
        const f = fixture();
        f.receipts.seed('receipts.corrupt-1.sqlite', ['m1']);
        writeFileSync(join(f.receipts.folder, 'receipts.sqlite'), 'damaged');
        await f.boot();
        expect((await f.request('config')).value.value).toMatchObject({ connected: true, enabled: false, labelId: null });
        expect(await f.request('receiptsReset')).toEqual({ ok: true, value: { value: true } });
        expect(readdirSync(f.receipts.folder).filter((name) => name.startsWith('receipts.corrupt-'))).toHaveLength(2);
        expect(f.lines.some((line) => line.includes('v1.3.8/gmail-receipts-recovered'))).toBe(true);
        expect(await f.lifecycle('active')).toMatchObject({ ok: true });
        f.list(['m1', 'm2']);
        await f.request('checkNow');
        expect(f.gmailTasks()).toEqual([]);
        expect(await f.request('connect')).toMatchObject({ ok: true });
        expect(await f.request('receiptsReset')).toEqual({ ok: true, value: { value: true } });
        expect(await f.request('configure', { labelId: 'label', enabled: true })).toMatchObject({ ok: true, value: { value: { enabled: true } } });
        expect(await f.request('clearReceiptsReset')).toEqual({ ok: true, value: { value: null } });
        expect(await f.request('receiptsReset')).toEqual({ ok: true, value: { value: false } });
        await f.request('checkNow');
        expect(f.gmailTasks().map((task) => task.title)).toEqual(['Subject m2']);
        expect(f.receipts.receipts()).toEqual(['m1', 'm2']);
    });

    it('carries receipts over from a reset cut short after the move, so a restart captures nothing twice', async () => {
        const f = fixture();
        f.receipts.seed('receipts.corrupt-7.sqlite', ['m1']);
        writeFileSync(join(f.receipts.folder, 'receipts-reset'), '');
        await f.boot();
        expect((await f.request('config')).value.value).toMatchObject({ enabled: false });
        expect(await f.request('receiptsReset')).toEqual({ ok: true, value: { value: true } });
        await f.request('configure', { labelId: 'label', enabled: true });
        await f.request('clearReceiptsReset');
        await f.lifecycle('active');
        f.list(['m1', 'm2']);
        await f.request('checkNow');
        expect(f.gmailTasks().map((task) => task.title)).toEqual(['Subject m2']);
        expect(f.receipts.receipts()).toEqual(['m1', 'm2']);
    });

    it('finishes a reset cut short before the move: the damaged file still moves aside once', async () => {
        const f = fixture();
        writeFileSync(join(f.receipts.folder, 'receipts-reset'), '');
        writeFileSync(join(f.receipts.folder, 'receipts.sqlite'), 'damaged');
        await f.boot();
        expect((await f.request('config')).value.value).toMatchObject({ enabled: false });
        expect(readdirSync(f.receipts.folder).filter((name) => name.startsWith('receipts.corrupt-'))).toHaveLength(1);
        expect(await f.request('receiptsReset')).toEqual({ ok: true, value: { value: true } });
        await f.request('configure', { labelId: 'label', enabled: true });
        await f.lifecycle('active');
        await f.request('checkNow');
        expect(f.gmailTasks().map((task) => task.title)).toEqual(['Subject m1']);
    });

    it('stops admitting mail in the background and never schedules its own timer', async () => {
        const f = fixture();
        await start(f);
        await f.lifecycle('background');
        await f.request('checkNow');
        expect(f.gmailTasks()).toEqual([]);
        await new Promise((done) => setTimeout(done, 50));
        expect(f.requests.filter((line) => line.startsWith('get messages'))).toEqual([]);
        await f.lifecycle('active');
        await f.request('checkNow');
        expect(f.gmailTasks()).toHaveLength(1);
    });

    it('logs the iOS connect outcome with no account, label, token or mail text', async () => {
        const f = fixture();
        await start(f);
        expect(await f.request('connect')).toMatchObject({ ok: true, value: { value: { connected: true } } });
        await f.request('configure', { labelId: 'label', enabled: true });
        await f.request('checkNow');
        expect(f.lines.filter((line) => line.includes('v1.3.9/ios-gmail-capture'))).toEqual([
            expect.stringContaining('Native iOS Gmail connect')]);
        expect(f.lines.some((line) => line.includes('outcome') && line.includes('connected'))).toBe(true);
        for (const line of f.lines) expect(line).not.toMatch(SECRET_TEXT);
    });
});
