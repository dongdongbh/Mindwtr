// Pass D1c design §3.1-§3.5 and review 2 #14: host-entry's side of Settings › Data's file channel, in the shipped bundle over
// a bridge that answers as DataChannel.kt does (tagged reads, UTF-8 counted by bytes, a strict encoder that refuses a lone
// surrogate). Each JS fix has a red run: the same test over a bundle with that fix taken out must fail.
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { build } from 'esbuild';

const databases: Database[] = [];
let source: string;
beforeAll(async () => {
    const built = await build({
        stdin: { contents: `
            import './host-entry';
            import { getStorageTimeoutMs, useTaskStore } from '../../../packages/core/src/store';
            globalThis.fixture = { touch: () => useTaskStore.setState({ lastDataChangeAt: useTaskStore.getState().lastDataChangeAt + 1 }),
                timeout: getStorageTimeoutMs };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const MARKER = '!MindwtrNativeError:';
const CHUNK_BYTES = 1024 * 1024;
type Handle = { read?: Buffer; at: number; written: Buffer[]; base64?: boolean; failRead?: string; failClose?: string };

const fixture = (bundle = source, onSql: (sql: string) => void = () => undefined) => {
    const database = new Database(':memory:'); databases.push(database);
    const handles = new Map<string, Handle>();
    const closed = new Map<string, Handle>();
    let next = 0;
    const fail = (code: string) => `${MARKER}${code}`;
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => { onSql(sql); return JSON.stringify(database.query(sql).all(...JSON.parse(params))); },
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => null, logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
            rnStateCommit: () => null, kvGet: () => '[null]', kvSet: () => null, kvRemove: () => null,
            kvMultiGet: (keys: string) => JSON.stringify((JSON.parse(keys) as string[]).map((key) => [key, null])), kvMultiSet: () => null, kvMultiRemove: () => null,
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null, hostEvent: () => null,
            debugProp: (name: string) => state.debugProps?.[name] ?? '',
            // DataChannel.kt's answers: reads 1 MiB of bytes at a time, never splitting a character; strict UTF-8 writes.
            dataRead: (id: string) => {
                state.onDataRead?.();
                const handle = handles.get(id);
                if (!handle?.read) return fail('DATA_HANDLE');
                if (handle.failRead) return fail(handle.failRead);
                if (handle.at >= handle.read.length) return 'E';
                let end = Math.min(handle.read.length, handle.at + CHUNK_BYTES);
                while (end < handle.read.length && (handle.read[end] & 0xc0) === 0x80) end -= 1;
                const chunk = handle.read.subarray(handle.at, end).toString('utf8');
                handle.at = end;
                return `D${chunk}`;
            },
            dataWrite: (id: string, chunk: string) => {
                const handle = handles.get(id);
                if (!handle) return fail('DATA_HANDLE');
                if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk)) return fail('DATA_IO');
                handle.written.push(handle.base64 ? Buffer.from(chunk, 'base64') : Buffer.from(chunk, 'utf8'));
                return null;
            },
            dataClose: (id: string) => {
                const handle = handles.get(id);
                if (!handle) return fail('DATA_HANDLE');
                handles.delete(id); closed.set(id, handle);
                if (handle.failClose) return fail(handle.failClose);
                const bytes = handle.read ?? Buffer.concat(handle.written);
                return JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
            },
        },
    };
    vm.runInNewContext(bundle, state);
    const open = (handle: Partial<Handle> & { base64?: boolean }) => { const id = `h${next++}`; handles.set(id, { at: 0, written: [], ...handle } as Handle); return id; };
    const poll = async (ticket: string) => {
        for (let step = 0; step < 2000; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    return { state, open, poll, handles, written: (id: string) => Buffer.concat((handles.get(id) ?? closed.get(id))?.written ?? []) };
};

// The second 1 MiB read starts with the bridge's error marker; the first 512 Ki-unit write ends inside a surrogate pair.
const head = 'a'.repeat(512 * 1024 - 1) + '🦉';
const text = head + 'b'.repeat(CHUNK_BYTES - Buffer.byteLength(head)) + `${MARKER}tail`;

const roundTrip = async (bundle: string) => {
    const f = fixture(bundle);
    const read = f.open({ read: Buffer.from(text, 'utf8') });
    const handles = f.handles;
    const write = f.open({});
    const kept = handles.get(write)!;
    const answer = await f.poll(f.state.MindwtrHost.dataChannelRoundTrip(read, write));
    return { answer, copy: Buffer.concat(kept.written).toString('utf8') };
};

describe('the data channel through the shipped bundle (D1c)', () => {
    it('a chunk that starts with the error marker is data, and a surrogate pair at a write boundary stays whole', async () => {
        const { answer, copy } = await roundTrip(source);
        expect(answer.ok).toBe(true);
        expect(copy === text).toBe(true);
    });

    it('red: payloads read through the error check (no tag) fail on the marker chunk', async () => {
        const fix = 'parts.push(reply.slice(1));';
        expect(source.includes(fix)).toBe(true);
        const { answer } = await roundTrip(source.replace(fix, 'parts.push(checked(reply.slice(1)));'));
        expect(answer.ok).toBe(false);
    });

    it('red: a splitter that ignores surrogate pairs fails the write', async () => {
        const found = /if \(end < \w+\.length && last >= 55296 && last <= 56319\) end -= 1;/u.exec(source)?.[0];
        expect(found).toBeTruthy();
        const { answer } = await roundTrip(source.replace(found!, ''));
        expect(answer.ok).toBe(false);
    });

    it('a commit whose plan cannot be read keeps its journal entry; one whose bytes changed is refused', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        const reference = JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), byteCount: 100 });
        const name = 'data.2026-10-04T12-00-00.000.snapshot.json';
        const unreadable = f.open({ read: Buffer.from('{}'), failRead: 'DATA_IO' });
        expect((await f.poll(f.state.MindwtrHost.backupDocumentCommit(reference, unreadable, name))).error).toBe('SAVE_FAILED: Backup plan could not be read');
        const changed = f.open({ read: Buffer.from('{}'), failClose: 'DATA_MISMATCH' });
        expect((await f.poll(f.state.MindwtrHost.backupDocumentCommit(reference, changed, name))).error).toBe('INVALID_INPUT: Backup operation files do not match');
    });

    it('an export checks the library inside its window: too large is refused before anything is written, an edit meanwhile is not exported', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        const fits = f.open({});
        const exported = await f.poll(f.state.MindwtrHost.dataExportFile('json', fits, 512 * 1024 * 1024));
        expect(exported.ok).toBe(true);
        expect(exported.value.bytes).toBe(f.written(fits).length);
        expect(JSON.parse(f.written(fits).toString('utf8')).tasks).toEqual([]);
        const refused = f.open({});
        expect((await f.poll(f.state.MindwtrHost.dataExportFile('json', refused, 1))).error).toMatch(/^TOO_LARGE:/);
        expect(f.written(refused).length).toBe(0);
        // An edit lands while the library's size is read: the export answers NOT_READY and writes nothing.
        let touched = false;
        const g = fixture(source, (sql) => { if (sql === 'PRAGMA page_count' && touched) g.state.fixture.touch(); });
        expect((await g.poll(g.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        touched = true;
        const raced = g.open({});
        expect((await g.poll(g.state.MindwtrHost.dataExportFile('json', raced, 512 * 1024 * 1024))).error).toMatch(/^NOT_READY:/);
        expect(g.written(raced).length).toBe(0);
    });

    it('a TaskNotes export is written as its ZIP bytes', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        const zip = f.open({ base64: true } as never);
        const exported = await f.poll(f.state.MindwtrHost.dataExportFile('tasknotes', zip, 512 * 1024 * 1024));
        expect(exported.ok).toBe(true);
        expect(f.written(zip).subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('the storage read budget follows the library: boot\'s, an activation\'s after replays, a commit\'s frozen one and the one it leaves', async () => {
        const budget = JSON.stringify({ baseMs: 1000, msPerMiB: 10, storageTimeoutMs: 4321 });
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.bootRecovery('', '', 'journaled', budget))).ok).toBe(true);
        expect(f.state.fixture.timeout()).toBe(4321);
        expect((await f.poll(f.state.MindwtrHost.resumeActivation())).ok).toBe(true);
        // The library is under 1 MiB here: one started MiB.
        expect(f.state.fixture.timeout()).toBe(1010);
        let during = 0;
        f.state.onDataRead = () => { during = f.state.fixture.timeout(); };
        const reference = JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), byteCount: 100 });
        const plan = f.open({ read: Buffer.from('{}'), failRead: 'DATA_IO' });
        await f.poll(f.state.MindwtrHost.backupDocumentCommit(reference, plan, 'data.2026-10-04T12-00-00.000.snapshot.json', 77_777));
        expect(during).toBe(77_777);
        expect(f.state.fixture.timeout()).toBe(1010);
    });

    it('a host that sends no budget (iOS) keeps core\'s 15 s', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', ''))).ok).toBe(true);
        expect(f.state.fixture.timeout()).toBe(15_000);
    });

    // Code review P2: the deadline rows' delays wait on timers, so core's storage timeout and the host's deadline run while they
    // wait. A delay that blocked inside one bridge call would finish before any timer fired, and these would pass without a fix.
    it('a debug read delay lets the storage timeout fire; within a larger budget the load finishes', async () => {
        const slow = fixture();
        slow.state.debugProps = { sql_read_delay_ms: '300' };
        const failed = await slow.poll(slow.state.MindwtrHost.boot('', '', 'journaled', JSON.stringify({ baseMs: 1000, msPerMiB: 10, storageTimeoutMs: 50 })));
        expect(failed.ok).toBe(false);
        expect(String(failed.error)).toContain('Storage request timed out');
        const roomy = fixture();
        roomy.state.debugProps = { sql_read_delay_ms: '300' };
        const started = Date.now();
        expect((await roomy.poll(roomy.state.MindwtrHost.boot('', '', 'journaled', JSON.stringify({ baseMs: 1000, msPerMiB: 10, storageTimeoutMs: 5000 })))).ok).toBe(true);
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    });

    it('a debug write delay pauses an export across engine turns: its call is still open on the first poll', async () => {
        const f = fixture();
        expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
        f.state.debugProps = { channel_write_delay_ms: '300' };
        const handle = f.open({});
        const started = Date.now();
        const ticket = f.state.MindwtrHost.dataExportFile('json', handle, 512 * 1024 * 1024);
        await new Promise((done) => setTimeout(done, 20));
        expect(f.state.MindwtrHost.poll(ticket)).toBeNull();
        const answer = await f.poll(ticket);
        expect(answer.ok).toBe(true);
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    });
});
