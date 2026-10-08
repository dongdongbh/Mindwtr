import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { build } from 'esbuild';
import vm from 'node:vm';

let source: string;
const databases: Database[] = [];
beforeAll(async () => {
    const built = await build({ entryPoints: [import.meta.dir + '/host-entry.ts'], bundle: true, write: false,
        format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(() => { databases.splice(0).forEach((value) => value.close()); });
const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    let log = '', failLog = false;
    const writes: string[] = [];
    const state = { AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { log() {}, info() {}, warn() {}, error() {} },
        MindwtrHost: undefined as unknown as Record<string, (...args: string[]) => string | null>,
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => 1_800_000_000_000, randomBytes: (n: number) => JSON.stringify(Array(n).fill(7)), log: () => {}, rnStateCommit: () => null,
            kvGet: () => '[null]', kvMultiGet: (raw: string) => JSON.stringify((JSON.parse(raw) as string[]).map((name) => [name, null])),
            kvSet: () => null, kvRemove: () => null, fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('PRIVATE_LOG_ERROR');
                if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                if (operation === 'size') return String(log.length); if (operation === 'read') return log;
                if (operation === 'exists') return log ? '1' : ''; if (operation === 'isAbsent') return log ? '' : '1';
                if (operation === 'append') { log += text; return ''; } if (operation === 'write') { log = text; return ''; }
                if (operation === 'delete') { log = ''; return '1'; } throw new Error('Unexpected diagnostic operation');
            },
        } };
    vm.runInNewContext(source, state);
    const poll = async (id: string | null) => {
        for (let step = 0; step < 200; step++) {
            const value = state.MindwtrHost.poll(id!);
            if (value !== null) return JSON.parse(value); await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Notification Settings bridge did not settle');
    };
    const call = (name: string, value?: unknown) => poll(state.MindwtrHost[name](...(value === undefined ? [] : [JSON.stringify(value)])));
    return { database, writes, log: () => log, failLog: () => { failLog = true; }, call,
        boot: async () => { expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true }); writes.length = 0; log = ''; } };
};
const request = (value: boolean, expected: unknown, requestId = '12345678-1234-1234-1234-123456789abc') =>
    ({ requestId, edit: { type: 'notificationsEnabled', value }, expected });

describe('actual private iOS prepared Notification Settings bridge', () => {
    it('projects all ten raw witnesses and validates a bounded frozen envelope without writing', async () => {
        const f = fixture(); await f.boot();
        const options = await f.call('notificationSettingOptions', {});
        expect(options.ok).toBe(true); expect(Object.keys(options.value.expected)).toHaveLength(10);
        const selected = request(true, options.value.expected.notificationsEnabled);
        const prepared = await f.call('notificationSettingPrepare', selected);
        expect(prepared).toEqual({ ok: true, value: { kind: 'prepared', prepared: { version: 1, request: selected } } });
        const envelope = { request: selected, prepared: prepared.value.prepared };
        expect(await f.call('notificationSettingValidate', envelope)).toEqual({ ok: true,
            value: { type: 'notificationsEnabled', value: true, changed: true } });
        expect((await f.call('notificationSettingValidate', { ...envelope, request: { ...selected, permissionGranted: true } })).ok).toBe(false);
        expect(f.writes).toEqual([]); expect(f.log()).toBe('');
    });
    it('saves once through the existing receipt adapter and replays the original UUID after a later choice', async () => {
        const f = fixture(); await f.boot(); const options = await f.call('notificationSettingOptions', {});
        const selected = request(true, options.value.expected.notificationsEnabled);
        const prepared = await f.call('notificationSettingPrepare', selected), envelope = { request: selected, prepared: prepared.value.prepared };
        expect(await f.call('notificationSettingCommit', envelope)).toEqual({ ok: true,
            value: { type: 'notificationsEnabled', value: true, changed: true } });
        const nextOptions = await f.call('notificationSettingOptions', {}), next = request(false,
            nextOptions.value.expected.notificationsEnabled, '22345678-1234-1234-1234-123456789abc');
        const second = await f.call('notificationSettingPrepare', next);
        expect((await f.call('notificationSettingCommit', { request: next, prepared: second.value.prepared })).ok).toBe(true);
        const before = f.writes.length;
        expect(await f.call('notificationSettingRetryOutcome', selected)).toEqual({ ok: true,
            value: { type: 'notificationsEnabled', value: true, changed: true } });
        expect(await f.call('notificationSettingCommit', envelope)).toEqual({ ok: true,
            value: { type: 'notificationsEnabled', value: true, changed: true } });
        expect(f.writes.length).toBe(before);
        expect((await f.call('notificationSettingOptions', {})).value.expected.notificationsEnabled).toEqual({ present: true, value: false });
    });
    it('refuses receipt-less/caller-hinted authority and keeps fixed saved logging best effort', async () => {
        const f = fixture(); await f.boot(); const options = await f.call('notificationSettingOptions', {});
        const selected = request(true, options.value.expected.notificationsEnabled), envelope = { request: selected, prepared: { version: 1, request: selected } };
        expect((await f.call('notificationSettingRetryOutcome', selected)).ok).toBe(false);
        expect((await f.call('notificationSettingCommit', envelope)).ok).toBe(false);
        expect((await f.call('notificationSettingPrepare', { ...selected, permissionGranted: true })).ok).toBe(false);
        expect(f.writes).toEqual([]); expect(f.log()).toBe('');
        expect(await f.call('notificationSettingAcknowledged')).toEqual({ ok: true, value: null });
        expect(JSON.parse(f.log().trim()).context).toEqual({ releaseCheck: 'v1.3.5/ios-notification-setting', outcome: 'saved' });
        expect(f.log()).not.toContain('PRIVATE'); const old = f.log(); f.failLog();
        expect(await f.call('notificationSettingAcknowledged')).toEqual({ ok: true, value: null });
        expect(f.log()).toBe(old); expect(f.writes).toEqual([]);
    });
});
