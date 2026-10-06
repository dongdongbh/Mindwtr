import { afterEach, describe, expect, it } from 'bun:test';
import {
    BACKGROUND_SYNC_FAILURE_STATE_KEY,
    NativeAttachmentCleanupUnconfirmedError,
    SYNC_BACKEND_KEY,
    WEBDAV_URL_KEY,
    setLogger,
} from '@mindwtr/core';
import { createDeadlineFetch, createNativeSync } from './host-sync';

// The native app's background sync binding (S4a): core's runner and schedule decision on the host's ports.
const globals = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;

const host = (stored: Record<string, string> = {}, refuseSchedule = false, getData?: () => Promise<never>) => {
    const kv = new Map(Object.entries(stored));
    const schedules: boolean[] = [];
    const lines: string[] = [];
    const traces: string[] = [];
    const calls: string[] = [];
    const bindings: Parameters<typeof createNativeSync>[0] = {
        keyValue: {
            get: async (key) => { calls.push('get'); return kv.get(key) ?? null; },
            set: async (key, value) => { calls.push('set'); kv.set(key, value); },
            remove: async (key) => { calls.push('remove'); kv.delete(key); },
            multiGet: async (keys) => { calls.push('multiGet'); return keys.map((key) => [key, kv.get(key) ?? null] as [string, string | null]); },
            multiSet: async (pairs) => { calls.push('multiSet'); for (const [key, value] of pairs) kv.set(key, value); },
        },
        secrets: {
            getSecret: async () => { calls.push('getSecret'); return null; },
            setSecret: async () => { calls.push('setSecret'); },
            deleteSecret: async () => { calls.push('deleteSecret'); },
        },
        localData: () => ({ getData: getData ?? (async () => { throw new Error('no local data in this test'); }), saveData: async () => undefined }),
        networkState: () => { calls.push('networkState'); return { isConnected: true, isInternetReachable: true }; },
        appendLog: async (entry) => { calls.push('appendLog'); lines.push(entry.message); return null; },
        translate: (key) => key,
        emit: () => { calls.push('emit'); },
        trace: (line) => { calls.push('trace'); traces.push(line); },
        scheduleBackgroundSync: (on) => {
            if (refuseSchedule) throw new Error('WorkManager did not store the work');
            calls.push('schedule');
            schedules.push(on);
        },
        isFossBuild: false,
    };
    const sync = createNativeSync(bindings);
    return { sync, kv, schedules, lines, traces, calls, bindings };
};

const fetches: string[] = [];
/** A server that refuses the password: a failure core does not retry, so a cycle fails at once. */
const failingFetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response('', { status: 401, statusText: 'Unauthorized' });
}) as typeof fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    fetches.length = 0;
    delete globals.__mindwtrCryptoCall;
    setLogger(null);
});

describe('native background sync binding', () => {
    it('manual sync preserves fatal cleanup identity without a cycle increment or any post-fatal host work', async () => {
        globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        let at!: { cycles: number; calls: number; lines: number; traces: number; kv: [string, string][] };
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => {
            at = { cycles: fixture.sync.state().cycles, calls: fixture.calls.length, lines: fixture.lines.length,
                traces: fixture.traces.length, kv: [...fixture.kv] };
            throw fatal;
        });
        const result = await fixture.sync.settingsHost.performSync(undefined, { manual: true }).catch((error: unknown) => error);
        expect(at).toBeDefined();
        expect(result).toBe(fatal);
        await Promise.resolve();
        await Promise.resolve();
        expect(fixture.sync.state().cycles).toBe(at.cycles);
        expect(fixture.calls.slice(at.calls)).toEqual([]);
        expect(fixture.lines.slice(at.lines)).toEqual([]);
        expect(fixture.traces.slice(at.traces)).toEqual([]);
        expect([...fixture.kv]).toEqual(at.kv);
    });

    it('manual sync with an ordinary same-name error retains the normal cycle and configuration refresh', async () => {
        globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
        let read = false;
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => {
            read = true;
            throw Object.assign(new Error('ordinary local read failure'), { name: 'NativeAttachmentCleanupUnconfirmedError' });
        });
        expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: false });
        expect(read).toBe(true);
        expect(fixture.sync.state().cycles).toBe(1);
        await fixture.sync.settingsHost.reconcileBackgroundSync();
        expect(fixture.calls).toContain('get');
        expect(fixture.traces.some((line) => line.includes('cycles=1'))).toBe(true);
    });

    it('a successful disabled manual cycle refreshes configuration and emits its new cycle count', async () => {
        const { sync, traces } = host();
        expect(await sync.settingsHost.performSync(undefined, { manual: true })).toMatchObject({ success: true });
        expect(sync.state().cycles).toBe(1);
        await sync.settingsHost.reconcileBackgroundSync();
        expect(traces.some((line) => line.includes('cycles=1'))).toBe(true);
    });

    for (const completion of ['resolve', 'reject'] as const) {
        it(`fences earlier configuration refresh and scheduling when held reads ${completion} after a fatal manual sync`, async () => {
            globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
            const fatal = new NativeAttachmentCleanupUnconfirmedError();
            const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' }, false, async () => { throw fatal; });
            const held: { resolve: (value: string | null) => void; reject: (error: Error) => void }[] = [];
            let allEntered!: () => void;
            const entered = new Promise<void>((resolve) => { allEntered = resolve; });
            let holding = true;
            const get = fixture.bindings.keyValue.get;
            fixture.bindings.keyValue.get = async (key) => {
                const value = await get(key);
                if (holding && key === WEBDAV_URL_KEY) {
                    return new Promise<string | null>((resolve, reject) => {
                        held.push({ resolve, reject });
                        if (held.length === 3) allEntered();
                    });
                }
                return value;
            };
            // Successful verification's finally refresh uses this same path; an Off
            // cycle admits it here without a second synthetic remote-write fixture.
            expect(await fixture.sync.settingsHost.performSync(undefined, { manual: true, configOverride: { backend: 'off' } })).toMatchObject({ success: true });
            const reconcile = fixture.sync.settingsHost.reconcileBackgroundSync().catch((error: unknown) => error);
            await entered;
            holding = false;
            await expect(fixture.sync.settingsHost.performSync(undefined, { manual: true })).rejects.toBe(fatal);
            const at = { calls: fixture.calls.length, schedules: fixture.schedules.length, lines: fixture.lines.length,
                traces: fixture.traces.length, state: fixture.sync.state() };
            expect(held).toHaveLength(3);
            for (const read of held) {
                if (completion === 'resolve') read.resolve('https://dav.example.com');
                else read.reject(fatal);
            }
            expect(await reconcile).toBe(fatal);
            await Promise.resolve();
            expect(fixture.calls.slice(at.calls)).toEqual([]);
            expect(fixture.schedules.slice(at.schedules)).toEqual([]);
            expect(fixture.lines.slice(at.lines)).toEqual([]);
            expect(fixture.traces.slice(at.traces)).toEqual([]);
            expect(fixture.sync.state()).toEqual(at.state);
            expect(fixture.sync.state().cycles).toBe(1);
            await expect(fixture.sync.settingsHost.reconcileBackgroundSync()).rejects.toBe(fatal);
            expect(fixture.calls.slice(at.calls)).toEqual([]);
        });
    }

    it('keeps the ordinary fallback emission when an earlier refresh read rejects', async () => {
        const fixture = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' });
        const held: ((error: Error) => void)[] = [];
        let allEntered!: () => void;
        const entered = new Promise<void>((resolve) => { allEntered = resolve; });
        const get = fixture.bindings.keyValue.get;
        fixture.bindings.keyValue.get = async (key) => {
            const value = await get(key);
            if (key === WEBDAV_URL_KEY) return new Promise<string | null>((_resolve, reject) => {
                held.push(reject);
                if (held.length === 2) allEntered();
            });
            return value;
        };
        const ordinary = new Error('ordinary configuration read failure');
        const reconcile = fixture.sync.settingsHost.reconcileBackgroundSync().catch((error: unknown) => error);
        await entered;
        for (const reject of held) reject(ordinary);
        expect(await reconcile).toBe(ordinary);
        await Promise.resolve();
        expect(fixture.traces).toContain('Native Android sync state badge=hidden cycles=0');
        expect(fixture.calls).toContain('emit');
        expect(fixture.schedules).toEqual([]);
    });

    it('schedules the background job only for a configured WebDAV or cloud backend (core\'s decision)', async () => {
        const off = host();
        await off.sync.settingsHost.reconcileBackgroundSync();
        expect(off.schedules).toEqual([false]);
        const webdav = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await webdav.sync.settingsHost.reconcileBackgroundSync();
        expect(webdav.schedules).toEqual([true]);
        const file = host({ [SYNC_BACKEND_KEY]: 'file', '@mindwtr_sync_path': 'content://folder' });
        await file.sync.settingsHost.reconcileBackgroundSync();
        expect(file.schedules).toEqual([false]);
    });

    // Review S4a 4: the schedule is reported only once WorkManager stored it; a refusal reaches the caller (and is retried at the
    // next start, resume or leave, which reconcile again).
    it('reports the job scheduled only once the host stored it; a refusal fails the reconcile', async () => {
        const { sync, traces } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' }, true);
        await expect(sync.settingsHost.reconcileBackgroundSync()).rejects.toThrow('WorkManager did not store the work');
        expect(traces.filter((line) => line.startsWith('Native Android background sync schedule'))).toEqual([]);
        const stored = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await stored.sync.settingsHost.reconcileBackgroundSync();
        expect(stored.traces).toContain('Native Android background sync schedule=on');
    });

    it('a capture run with nothing imported sends nothing; one with an import syncs and records its failure', async () => {
        globalThis.fetch = failingFetch;
        const { sync, kv } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        expect(await sync.backgroundSync('capture', 0)).toEqual({ schedule: true });
        expect(kv.has(BACKGROUND_SYNC_FAILURE_STATE_KEY)).toBe(false);
        await sync.backgroundSync('capture', 1);
        expect(JSON.parse(kv.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!).consecutiveFailures).toBe(1);
    });

    it('a scheduled run inside the failure cooldown is skipped and fetches nothing', async () => {
        globalThis.fetch = failingFetch;
        const { sync, lines } = host({
            [SYNC_BACKEND_KEY]: 'webdav',
            [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav',
            [BACKGROUND_SYNC_FAILURE_STATE_KEY]: JSON.stringify({ lastFailureAt: Date.now(), consecutiveFailures: 1 }),
        });
        expect(await sync.backgroundSync('scheduled', 0)).toEqual({ schedule: true });
        expect(fetches).toEqual([]);
        expect(lines).toContain('Mobile background sync skipped during failure cooldown');
    });

    it('answers schedule false once sync is off, so the running job does not queue its next run', async () => {
        const { sync } = host();
        expect(await sync.backgroundSync('scheduled', 0)).toEqual({ schedule: false });
    });

    it('refuses a sync request that would start past the run\'s deadline (RN\'s setMobileSyncRequestDeadline)', async () => {
        const deadline = createDeadlineFetch(failingFetch);
        expect((await deadline.fetch('http://a/1')).status).toBe(401);
        deadline.setDeadline(Date.now() - 1);
        await expect(deadline.fetch('http://a/2')).rejects.toMatchObject({ name: 'AbortError' });
        deadline.setDeadline(null);
        expect((await deadline.fetch('http://a/3')).status).toBe(401);
        expect(fetches).toEqual(['http://a/1', 'http://a/3']);
    });

    // About 35 s: the aborted cycle's WebDAV read retries (core's backoff) before it ends; none of them is sent (the signal is
    // aborted, so the host's fetch refuses each before it starts).
    it('a run abandoned at its deadline ends its cycle with no follow-up: the job, not a timer, retries it (review S4a 1)', async () => {
        const sent: string[] = [];
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
            const cancelled = () => reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' }));
            if (init?.signal?.aborted) return cancelled();
            sent.push(String(input));
            init?.signal?.addEventListener('abort', cancelled);
        })) as typeof fetch;
        const { sync, kv, lines } = host({ [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'http://127.0.0.1:1/dav' });
        await sync.backgroundSync('scheduled', 0, 50);
        expect(lines).toContain('Mobile background sync did not finish before its deadline and was abandoned');
        expect(JSON.parse(kv.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!).consecutiveFailures).toBe(1);
        for (let waited = 0; waited < 50_000 && !lines.includes('Sync aborted at the background run\'s deadline'); waited += 500) {
            await new Promise((done) => setTimeout(done, 500));
        }
        expect(lines).toContain('Sync aborted at the background run\'s deadline');
        await new Promise((done) => setTimeout(done, 1_000));
        expect(lines).not.toContain('Sync follow-up scheduled');
        expect(sent).toHaveLength(1);
    }, 60_000);
});
