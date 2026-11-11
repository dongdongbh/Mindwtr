import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

const databases: Database[] = [];
let source: string;

beforeAll(async () => {
    const built = await build({
        entryPoints: [`${import.meta.dir}/host-entry.ts`],
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const fixture = (platform: 'ios' | 'android') => {
    const database = new Database(':memory:'); databases.push(database);
    const kv = new Map<string, string>([['@mindwtr_sync_backend', 'off']]);
    const requests: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: platform, console: { info() {}, warn() {}, error() {}, log() {} },
        fetch: (input: RequestInfo | URL) => { requests.push(String(input)); throw new Error('Unexpected network'); },
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => {},
            logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : operation === 'size' ? '0' : ''),
            rnStateCommit: () => null,
            kvGet: (key: string) => JSON.stringify([kv.get(key) ?? null]),
            kvSet: (key: string, value: string) => { kv.set(key, value); return null; },
            kvRemove: (key: string) => { kv.delete(key); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
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
    const begin = () => poll(state.MindwtrHost.beginStartupPrompts(JSON.stringify({ installerSource: 'play-store', donationEnabled: true, deferDelay: true })));
    return { state, kv, requests, poll, begin, boot: async () => expect((await poll(state.MindwtrHost.boot('', ''))).ok).toBe(true) };
};

describe('iOS startup prompt host', () => {
    it('opens the welcome sheet on an empty iOS library and stores Skip under RN\'s device key', async () => {
        const f = fixture('ios'); await f.boot();
        const opened = await f.begin();
        expect(opened.ok).toBe(true);
        expect(opened.value.delayMs).toBe(0);
        expect(opened.value.prompt).toMatchObject({ id: 'onboarding', words: { title: 'Welcome to Mindwtr', importTitle: expect.any(String) } });
        expect(f.kv.has('mindwtr:local-user-prompts:v1')).toBe(true);
        expect(await f.poll(f.state.MindwtrHost.startupPromptAction(JSON.stringify({ id: 'onboarding', action: 'dismiss' }))))
            .toEqual({ ok: true, value: { shownAt: null } });
        expect(f.kv.get('mindwtr:mobile:first-run-onboarding:v1')).toBe('dismissed');
        expect((await f.begin()).value).toEqual({ prompt: null, delayMs: 0 });
        expect(f.requests).toEqual([]);
    });

    it('keeps the Android host without an iOS prompt host', async () => {
        const f = fixture('android'); await f.boot();
        const answer = await f.begin();
        expect(answer.ok).toBe(false);
        expect(f.kv.has('mindwtr:local-user-prompts:v1')).toBe(false);
    });
});
