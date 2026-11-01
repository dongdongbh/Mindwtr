// Archive retention's host binding (host-entry archiveRetention, review N10): the shipped bundle over a bridge whose RN sync backend
// key holds what a test stores. A backend the host cannot read counts as selected (a680d9594), so the run waits for this session's
// first sync instead of purging.
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
            import { useTaskStore } from '../../../packages/core/src/store';
            globalThis.fixture = { days: (days) => useTaskStore.getState().setArchiveRetentionDays(days) };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const BACKEND = '@mindwtr_sync_backend';
const fixture = (backend: string | null) => {
    const database = new Database(':memory:'); databases.push(database);
    const stored = (key: string) => (key === BACKEND ? backend : null);
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'android', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => null, logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
            rnStateCommit: () => null, kvGet: (key: string) => JSON.stringify([stored(key)]), kvSet: () => null, kvRemove: () => null,
            kvMultiGet: (keys: string) => JSON.stringify((JSON.parse(keys) as string[]).map((key) => [key, stored(key)])), kvMultiSet: () => null, kvMultiRemove: () => null,
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null, hostEvent: () => null, debugProp: () => '',
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
    const run = async (editorOpen: boolean) => {
        const answer = await poll(state.MindwtrHost.archiveRetention(editorOpen));
        if (!answer.ok) throw new Error(answer.error);
        return answer.value;
    };
    return { state, poll, run };
};

const booted = async (backend: string | null) => {
    const f = fixture(backend);
    expect((await f.poll(f.state.MindwtrHost.boot('', '', 'journaled'))).ok).toBe(true);
    expect((await f.state.fixture.days(30)).success).toBe(true);
    return f;
};

describe('the Archive retention host binding', () => {
    it('runs at once with sync off', async () => {
        const f = await booted(null);
        expect(await f.run(false)).toMatchObject({ outcome: 'unchanged', skipped: null });
    });

    it('waits for this session\'s sync while a backend is selected', async () => {
        const f = await booted('webdav');
        expect(await f.run(false)).toMatchObject({ outcome: 'skipped', skipped: 'waiting-for-sync' });
    });

    it('reads an unreadable sync backend as null, so the run waits instead of failing or purging (a680d9594)', async () => {
        const f = await booted('not-a-backend');
        expect(await f.run(false)).toMatchObject({ outcome: 'skipped', skipped: 'waiting-for-sync' });
    });

    it('skips while an editor is open, without reading the backend', async () => {
        const f = await booted('not-a-backend');
        expect(await f.run(true)).toMatchObject({ outcome: 'skipped', skipped: 'editor-open' });
    });
});
