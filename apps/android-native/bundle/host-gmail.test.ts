import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gmailCaptureIdFor } from '@mindwtr/core';
import { createNativeGmail, type GmailStatusView, type NativeGmailBindings } from './host-gmail';

// Native Gmail capture (design pass G3): RN's controller on this host's bindings. The receipts file is a real SQLite file in a
// folder of its own, as HostGmailReceipts keeps it; Gmail's answers come from a fake authorization.

const ACCOUNT = 'f'.repeat(64);
const message = (id: string, text = 'Body') => ({ id, labelIds: ['label'], payload: { mimeType: 'text/plain',
    headers: [{ name: 'Subject', value: `Subject ${id}` }], body: { data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text) } } });

/** HostGmailReceipts' calls on a temporary folder, with bun's SQLite for the bundled driver. */
const receiptFolder = () => {
    const folder = mkdtempSync(join(tmpdir(), 'gmail-receipts-'));
    const open = new Map<string, Database>();
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
        const db = open.get(name);
        if (!db) throw new Error('The Gmail receipts file is not open');
        return JSON.stringify(db.query(text).all(...(JSON.parse(params) as never[])));
    };
    const receipts = () => {
        const db = new Database(join(folder, 'receipts.sqlite'));
        try { return (db.query('SELECT message FROM receipts').all() as Array<{ message: string }>).map((row) => row.message).sort(); }
        finally { db.close(); }
    };
    return { folder, file, sql, receipts, dispose: () => { open.forEach((db) => db.close()); rmSync(folder, { recursive: true, force: true }); } };
};

/** The host: Gmail connected with label "label", the store's save and its failure, manual timers, and every log line. */
const harness = (options: { messages?: string[]; sandbox?: boolean } = {}) => {
    const receipts = receiptFolder();
    let listed = options.messages ?? ['m1'];
    const calls: string[] = [];
    let failNext: string | null = null;
    const status = { available: true, connected: true, account: 'tester@example.invalid', accountId: ACCOUNT };
    const call: NativeGmailBindings['call'] = async ({ op, path }) => {
        calls.push(path ? `${op} ${path}` : op);
        if (failNext) { const code = failNext; failNext = null; throw new Error(code); }
        if (op === 'status' || op === 'connect') return status;
        if (op === 'get' && path === 'labels') return { labels: [{ id: 'label', name: 'Mindwtr' }] };
        if (op === 'get' && path?.startsWith('labels/')) return { id: 'label' };
        if (op === 'get' && path?.startsWith('messages?')) return { messages: listed.map((id) => ({ id })) };
        if (op === 'get' && path?.startsWith('messages/')) return message(decodeURIComponent(path.slice(9).split('?')[0]));
        return null;
    };
    const added: Array<{ title: string; captureId: string }> = [];
    let saveFails = false;
    let unsaved = false;
    const timers: Array<{ fn: () => void; at: number; id: number }> = [];
    let now = 0;
    let nextTimer = 1;
    const logs: Array<{ level: string; message: string; context: Record<string, string> }> = [];
    const statuses: GmailStatusView[] = [];
    const gmail = createNativeGmail({
        call,
        file: receipts.file,
        sql: receipts.sql,
        addTasks: async (items) => { added.push(...items); return { success: true }; },
        flushPendingSave: async () => { if (saveFails) unsaved = true; },
        requireSaved: () => { if (unsaved) throw new Error('SAVE_FAILED: Previous changes could not be saved; retry before continuing'); },
        sandbox: () => options.sandbox === true,
        logInfo: (msg, meta) => { logs.push({ level: 'info', message: msg, context: meta.context }); },
        logWarn: (msg, meta) => { logs.push({ level: 'warn', message: msg, context: meta.context }); },
        statusChanged: (next) => { statuses.push(next); },
        setTimer: ((fn: () => void, delay: number) => { const id = nextTimer++; timers.push({ fn, at: now + delay, id }); return id; }) as never,
        clearTimer: ((id: number) => { const at = timers.findIndex((timer) => timer.id === id); if (at >= 0) timers.splice(at, 1); }) as never,
    });
    const settle = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
    /** Runs every timer due within [ms], then lets the cycle it started finish. */
    const advance = async (ms: number) => {
        now += ms;
        for (const timer of timers.filter((item) => item.at <= now)) {
            timers.splice(timers.indexOf(timer), 1);
            timer.fn();
            await settle();
        }
    };
    const configure = async () => {
        const reply = await gmail.request('configure', { labelId: 'label', enabled: true }) as { value?: { enabled: boolean } };
        expect(reply.value?.enabled).toBe(true);
    };
    return {
        gmail, receipts, calls, added, logs, statuses, timers, advance, settle, configure,
        fail: (code: string) => { failNext = code; },
        list: (ids: string[]) => { listed = ids; },
        failSaves: (on: boolean) => { saveFails = on; if (!on) unsaved = false; },
    };
};

describe('native Gmail capture', () => {
    it('keeps no receipt for mail whose save failed, and captures it again once saves work (the lost-mail rule)', async () => {
        const host = harness();
        try {
            await host.configure();
            host.gmail.start('active');
            host.failSaves(true);
            await host.advance(1_000);
            expect(host.added.map((item) => item.captureId)).toEqual([gmailCaptureIdFor(ACCOUNT, 'm1')]);
            expect(host.statuses.at(-1)).toMatchObject({ lastError: { kind: 'storage' }, lastErrorKey: 'settings.gmailCaptureStorageFailed' });
            expect(host.receipts.receipts()).toEqual([]);
            host.failSaves(false);
            await host.advance(1_000);
            await host.advance(5 * 60 * 1000);
            expect(host.added.map((item) => item.captureId)).toEqual([gmailCaptureIdFor(ACCOUNT, 'm1'), gmailCaptureIdFor(ACCOUNT, 'm1')]);
            expect(host.receipts.receipts()).toEqual(['m1']);
            expect(host.statuses.at(-1)).toMatchObject({ lastError: null, lastImportCount: 1 });
            expect(host.statuses.at(-1)?.lastPollText).toBeString();
            expect(await host.gmail.request('status', {})).toMatchObject({ value: { lastImportCount: 1, lastPollText: host.statuses.at(-1)?.lastPollText } });
            expect(host.logs.filter((line) => line.context.releaseCheck === 'v1.3.7/gmail-capture')).toEqual([
                { level: 'info', message: 'Gmail capture imported messages', context: { releaseCheck: 'v1.3.7/gmail-capture', count: '1' } }]);
        } finally { host.receipts.dispose(); }
    });

    it('starts one second after the load in front, polls every five minutes, and stops behind (pause then dispose)', async () => {
        const host = harness();
        try {
            await host.configure();
            host.gmail.appState('active');
            await host.advance(10_000);
            expect(host.added).toEqual([]);
            host.gmail.start('background');
            await host.advance(10_000);
            expect(host.added).toEqual([]);
            host.gmail.appState('active');
            await host.advance(999);
            expect(host.added).toEqual([]);
            await host.advance(1);
            expect(host.added).toHaveLength(1);
            host.list(['m1', 'm2']);
            await host.advance(5 * 60 * 1000 - 1);
            expect(host.added).toHaveLength(1);
            await host.advance(1);
            expect(host.added.map((item) => item.title)).toEqual(['Subject m1', 'Subject m2']);
            host.gmail.appState('background');
            expect(host.timers).toEqual([]);
            host.list(['m1', 'm2', 'm3']);
            await host.advance(60 * 60 * 1000);
            expect(await host.gmail.request('checkNow', {})).toEqual({ value: null });
            expect(host.added).toHaveLength(2);
        } finally { host.receipts.dispose(); }
    });

    it('never captures in sandbox mode', async () => {
        const host = harness({ sandbox: true });
        try {
            await host.configure();
            host.gmail.start('active');
            host.gmail.appState('active');
            await host.advance(60 * 60 * 1000);
            expect(host.added).toEqual([]);
            expect(host.timers).toEqual([]);
        } finally { host.receipts.dispose(); }
    });

    it('reads a rejection by its fixed code only: AUTH stops capture, any other text is OTHER', async () => {
        const host = harness();
        try {
            await host.configure();
            host.fail('Unterminated string at 40: "Subject: payslip');
            expect(await host.gmail.request('labels', {})).toEqual({ errorKey: 'settings.gmailCaptureFailed' });
            host.fail('E_GMAIL_NETWORK');
            expect(await host.gmail.request('labels', {})).toEqual({ errorKey: 'settings.gmailCaptureNetworkFailed' });
            host.gmail.start('active');
            host.fail('E_GMAIL_AUTH');
            await host.advance(1_000);
            expect(host.statuses.at(-1)).toMatchObject({ terminal: true, lastError: { kind: 'auth' } });
            const config = await host.gmail.request('config', {}) as { value: { enabled: boolean } };
            expect(config.value.enabled).toBe(false);
            await host.advance(60 * 60 * 1000);
            expect(host.added).toEqual([]);
        } finally { host.receipts.dispose(); }
    });

    it('logs the connect outcome, with no account, label or mail data', async () => {
        const host = harness();
        try {
            expect(await host.gmail.request('connect', {})).toMatchObject({ value: { connected: true } });
            host.fail('E_GMAIL_CANCELLED');
            expect(await host.gmail.request('connect', {})).toEqual({ errorKey: 'settings.gmailCaptureCancelled' });
            expect(host.logs.filter((line) => line.context.releaseCheck === 'v1.3.8/native-gmail-connect').map((line) => line.context))
                .toEqual([{ releaseCheck: 'v1.3.8/native-gmail-connect', outcome: 'connected' },
                    { releaseCheck: 'v1.3.8/native-gmail-connect', outcome: 'cancelled' }]);
            for (const line of host.logs) expect(JSON.stringify(line)).not.toMatch(/tester@example|label|Mindwtr|m1|Subject/);
        } finally { host.receipts.dispose(); }
    });

    it('reports the stage that failed when the receipts file cannot open, and stays shut until the next start', async () => {
        const receipts = receiptFolder();
        const logs: Array<Record<string, string>> = [];
        try {
            const gmail = createNativeGmail({
                call: async ({ op }) => (op === 'status' ? { available: true, connected: true, account: 'tester@example.invalid', accountId: ACCOUNT } : null),
                file: (op, name, to) => { if (op === 'open') throw new Error('disk I/O error'); return receipts.file(op, name, to); },
                sql: receipts.sql,
                addTasks: async () => ({ success: true }), flushPendingSave: async () => {}, requireSaved: () => {}, sandbox: () => false,
                logInfo: () => {}, logWarn: (_message, meta) => { logs.push(meta.context); }, statusChanged: () => {},
            });
            expect(await gmail.request('config', {})).toEqual({ errorKey: 'settings.gmailCaptureStorageFailed' });
            expect(await gmail.request('config', {})).toEqual({ errorKey: 'settings.gmailCaptureStorageFailed' });
            expect(logs).toEqual([{ releaseCheck: 'v1.3.8/native-gmail-receipts', stage: 'open', errorKind: 'native' }]);
        } finally { receipts.dispose(); }
    });
});
