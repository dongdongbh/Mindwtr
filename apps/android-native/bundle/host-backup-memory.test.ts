// Pass D1c, cut i: the host's storage adapter caches no document, so a boot's reads and a backup commit's reads are free
// once they are used. A cached read (the old `latestData`) kept a whole library alive past the store's own reload.
// The shipped host-entry runs in a VM over bun:sqlite; each getData result is watched through a WeakRef.
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

const databases: Database[] = [];
let source: string;

beforeAll(async () => {
    const built = await build({
        stdin: { contents: `
            import './host-entry';
            import { NativeReceiptSqliteAdapter } from '../../../packages/core/src/native-request-receipts';
            const reads = [];
            const read = NativeReceiptSqliteAdapter.prototype.getData;
            NativeReceiptSqliteAdapter.prototype.getData = async function (options) {
                const data = await read.call(this, options);
                reads.push(new WeakRef(data));
                return data;
            };
            globalThis.fixture = { reads };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const settle = () => new Promise((done) => setImmediate(done));
const fixture = (rnStateCommit: () => unknown = () => null) => {
    const database = new Database(':memory:'); databases.push(database);
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, WeakRef,
        // Shared host-entry code; the iOS table needs the fewest bridge functions.
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => null, logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
            rnStateCommit, kvGet: () => '[null]', kvSet: () => null, kvRemove: () => null,
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 500; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    /** How many of the boot's and operations' reads are still reachable after a full collection. */
    const reachable = async () => {
        await settle(); Bun.gc(true); await settle(); Bun.gc(true);
        return (state.fixture.reads as WeakRef<object>[]).filter((ref) => ref.deref() !== undefined).length;
    };
    return { state, poll, reachable, reads: () => (state.fixture.reads as unknown[]).length };
};
const legacy = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ jsonAhead: false, reconciled: true, backupVersion: null, backupPresent: false, ...overrides });

describe('the host storage adapter keeps no read document (D1c cut i)', () => {
    it('a boot without the RN legacy state keeps none of its reads', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', ''))).ok).toBe(true);
        expect(f.reads()).toBeGreaterThan(0);
        expect(await f.reachable()).toBe(0);
    });
    it('a boot with the RN legacy state plans from its own read, and keeps none of its reads', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot(legacy(), ''))).ok).toBe(true);
        expect(f.reads()).toBeGreaterThan(1);
        expect(await f.reachable()).toBe(0);
    });
    it('a recovery boot and its later activation keep none of their reads', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.bootRecovery('', ''))).ok).toBe(true);
        expect((await f.poll(f.state.MindwtrHost.resumeActivation())).ok).toBe(true);
        expect(f.reads()).toBeGreaterThan(0);
        expect(await f.reachable()).toBe(0);
    });
    it('a legacy import that fails keeps none of its reads', async () => {
        const f = fixture(() => { throw new Error('synthetic RN state failure'); });
        const backup = JSON.stringify({ tasks: [{ id: 'rn-only', title: 'From RN', status: 'inbox', tags: [], contexts: [],
            createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }], projects: [], sections: [], areas: [], settings: {} });
        const answer = await f.poll(f.state.MindwtrHost.boot(legacy({ jsonAhead: true, backupVersion: '2', backupPresent: true }), backup));
        expect(answer.ok).toBe(false);
        expect(f.reads()).toBeGreaterThan(0);
        expect(await f.reachable()).toBe(0);
    });
});
