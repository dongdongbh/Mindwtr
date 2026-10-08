import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

type Alarm = { repeat: string; key: string };

const now = 1_800_000_000_000;
const names = ['mindwtr:local:alarms:v1', 'mindwtr:native:reminders:v1'];
const databases: Database[] = [];
let source: string;
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, setStorageAdapter, flushPendingSave } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        globalThis.fixture = {
            seed: (tasks, settings) => useTaskStore.setState({ tasks, _allTasks: tasks, settings }),
            queueSave: () => useTaskStore.getState().addTask('Synthetic queued task'), flush: flushPendingSave,
            failSave: () => useTaskStore.setState({ persistenceFailure: { message: 'private failure' } }),
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            replace: () => setStorageAdapter({ getData: async () => ({}), saveData: async () => {} }),
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const fixture = (platform = 'ios') => {
    const database = new Database(':memory:'); databases.push(database);
    const writes: string[] = [], reads: string[][] = [], effects: string[] = [], consoleLines: string[] = [];
    const saved = new Map(names.map((name) => [name, null as string | null]));
    let cancelNext = false, failLog = false, logText = '', onRead = () => {};
    class Controller extends AbortController {
        constructor() { super(); if (cancelNext) { cancelNext = false; this.abort(); } }
    }
    // The fixture owns a closed VM; any unexpected bridge access fails the case.
    const state = {
        MindwtrHost: undefined as unknown as { boot(first: string, second: string): string; poll(ticket: string): string | null;
            iosReadReminderPlan(grant: unknown): string; abort(ticket: string): void },
        fixture: undefined as unknown as { seed(tasks: unknown[], settings: Record<string, unknown>): void;
            failSave(): void; sandbox(): void; transition(): void; replace(): void; queueSave(): void; flush(): Promise<void> },
        AbortController: Controller, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        Date: new Proxy(Date, { construct: (target, args) => Reflect.construct(target, args.length ? args : [now]),
            get: (target, property) => property === 'now' ? () => now : Reflect.get(target, property) }),
        __mindwtrHostPlatform: platform, console: Object.fromEntries(['info', 'warn', 'error', 'log'].map((name) => [name, (...args: unknown[]) => consoleLines.push(JSON.stringify(args))])),
        fetch: () => { effects.push('HTTP'); throw new Error('No HTTP admitted'); },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => now, randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: () => {}, rnStateCommit: () => null, kvGet: () => '[null]',
            kvMultiGet: (raw: string) => { const keys = JSON.parse(raw) as string[]; reads.push(keys); onRead(); return JSON.stringify(keys.map((key) => [key, saved.get(key)])); },
            kvSet: () => { writes.push('kvSet'); return null; }, kvRemove: () => { writes.push('kvRemove'); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => { writes.push('fileDelete'); return null; },
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('private logging failure');
                if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                if (operation === 'size') return String(logText.length);
                if (operation === 'read') return logText;
                if (operation === 'exists') return logText ? '1' : '';
                if (operation === 'isAbsent') return logText ? '' : '1';
                if (operation === 'append') { logText += text; return ''; }
                if (operation === 'write') { logText = text; return ''; }
                if (operation === 'delete') { logText = ''; return '1'; }
                throw new Error('Unexpected diagnostic operation');
            },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 100; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Reminder read did not settle');
    };
    const boot = async () => {
        expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        writes.length = 0; reads.length = 0; logText = '';
    };
    const tasks = Array.from({ length: 205 }, (_, index) => ({ id: `cap-${index}`, title: `Private task ${index}`,
        status: index % 2 ? 'waiting' : 'someday', tags: [], contexts: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        dueDate: new Date(now + 3_600_000 + index * 60_000).toISOString() })).reverse();
    const seed = (logging = false) => state.fixture.seed(tasks, { dailyDigestMorningEnabled: true, dailyDigestEveningEnabled: true, weeklyReviewEnabled: true, diagnostics: { loggingEnabled: logging } });
    return { state, writes, reads, effects, consoleLines, saved, tasks, poll, boot, seed,
        plan: (grant: unknown = true) => poll(state.MindwtrHost.iosReadReminderPlan(grant)),
        onRead: (callback: () => void) => { onRead = callback; }, cancelNext: () => { cancelNext = true; },
        log: () => logText, failLog: () => { failLog = true; } };
};

const unavailable = { ok: false, error: 'NOT_READY: Reminder plan is unavailable' };
describe('actual iOS read-only reminder preview bridge', () => {
    it('selects earliest60 with independent recurring policy, reads only saved maps and preserves a no-op preview', async () => {
        const f = fixture(); await f.boot(); f.seed();
        expect(f.reads).toEqual([]); expect(f.effects).toEqual([]);
        const first = await f.plan(); expect(first.ok).toBe(true);
        const plan = first.value;
        expect(plan.mode).toBe('active');
        expect(plan.schedule.filter((alarm: Alarm) => alarm.repeat === 'once').map((alarm: Alarm) => alarm.key)).toEqual(Array.from({ length: 60 }, (_, index) => `task:cap-${index}`));
        expect(plan.schedule.filter((alarm: Alarm) => alarm.repeat !== 'once').map((alarm: Alarm) => alarm.repeat)).toEqual(['daily', 'daily', 'weekly']);
        expect(plan.topUpDelayMs).toBeGreaterThan(0);
        f.saved.set(names[0], plan.alarms); f.saved.set(names[1], plan.state);
        const bytes = [...f.saved];
        const next = await f.plan(); expect(next.ok).toBe(true); expect(next.value.schedule).toEqual([]); expect(next.value.cancel).toEqual([]);
        expect(next.value.alarms).toBe(plan.alarms); expect(next.value.topUpDelayMs).toBe(plan.topUpDelayMs);
        expect([...f.saved]).toEqual(bytes); expect(f.reads).toEqual([names, names]); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
        const markers = f.log().trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.context?.releaseCheck === 'v1.3.5/ios-reminder-plan');
        expect(markers).toHaveLength(2);
        expect(markers[0]).toEqual({ ts: expect.any(String), level: 'info', scope: 'native-ios', message: 'Native iOS reminder plan inspected', context: { releaseCheck: 'v1.3.5/ios-reminder-plan', outcome: 'planned' } });
        expect(f.log()).not.toContain('Private task'); expect(f.log()).not.toContain('task:cap-');
    });
    it.each([['{not json', '{bad state'], ['{"foreign":{"id":"bad"}}', '{"bad":{"kind":"snooze","id":null}}']])('keeps shared malformed preview semantics without writing saved bytes %#', async (alarms, state) => {
        const f = fixture(); await f.boot(); f.seed(); f.saved.set(names[0], alarms); f.saved.set(names[1], state);
        const before = [...f.saved]; const result = await f.plan();
        expect(result.ok).toBe(true); expect(result.value.schedule.filter((alarm: Alarm) => alarm.repeat === 'once')).toHaveLength(60);
        expect([...f.saved]).toEqual(before); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
    it('uses observed denied permission and preserves result if the diagnostic sink fails', async () => {
        const f = fixture(); await f.boot(); f.seed(); f.failLog();
        expect(await f.plan(false)).toMatchObject({ ok: true, value: { mode: 'revoked', schedule: [], clearDelivered: true } });
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
    it.each(['boot', 'platform', 'sandbox', 'transition', 'persistence'])('refuses %s before saved-map reads', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot();
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'persistence') f.state.fixture.failSave();
        expect(await f.plan()).toEqual(unavailable); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).toBe('');
    });
    it.each(['transition', 'replace'])('refuses %s across the saved-map await without stale publication', async (change) => {
        const f = fixture(); await f.boot(); f.seed(); f.onRead(() => f.state.fixture[change as 'transition' | 'replace']());
        expect(await f.plan()).toEqual(unavailable); expect(f.reads).toEqual([names]); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).toBe('');
    });
    it.each([null, 1, 'true', {}])('refuses nonboolean grant %# without saved-map reads', async (grant) => {
        const f = fixture(); await f.boot();
        expect(await f.plan(grant)).toEqual({ ok: false, error: 'INVALID_INPUT: Reminder permission must be a boolean' });
        expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
    it('refuses cancellation before maps and after the saved-map await', async () => {
        const f = fixture(); await f.boot(); f.cancelNext();
        expect(await f.plan()).toEqual({ ok: false, error: 'CANCELLED: Reminder plan read was cancelled' }); expect(f.reads).toEqual([]);
        let ticket = '';
        f.onRead(() => queueMicrotask(() => f.state.MindwtrHost.abort(ticket)));
        ticket = f.state.MindwtrHost.iosReadReminderPlan(true);
        expect(await f.poll(ticket)).toEqual({ ok: false, error: 'CANCELLED: Reminder plan read was cancelled' });
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).toBe('');
    });
    it('never exports malformed stored content through parse-error diagnostics', async () => {
        const f = fixture(); await f.boot(); f.seed(true); f.saved.set(names[0], 'PRIVATE'); f.saved.set(names[1], 'PRIVATE');
        const before = [...f.saved]; const result = await f.plan(); expect(result.ok).toBe(true);
        expect([...f.saved]).toEqual(before); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
        expect(f.log()).not.toContain('PRIVATE'); expect(f.consoleLines.join('\n')).not.toContain('PRIVATE');
    });
    it.each(['before', 'during'])('refuses unsettled save work %s the saved-map await without flushing it', async (when) => {
        const f = fixture(); await f.boot(); f.seed();
        if (when === 'before') f.state.fixture.queueSave();
        else f.onRead(() => f.state.fixture.queueSave());
        try {
            expect(await f.plan()).toEqual(unavailable); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).toBe('');
        } finally { await f.state.fixture.flush(); }
    });
    it('refuses malformed native storage frames without accepting caller maps', async () => {
        const f = fixture(); await f.boot();
        for (const raw of ['[]', '[["wrong",null],["wrong",null]]', '[["mindwtr:local:alarms:v1",{}],["mindwtr:native:reminders:v1",null]]']) {
            f.state.__mindwtrNative.kvMultiGet = () => raw; expect(await f.plan()).toEqual(unavailable);
        }
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).toBe('');
    });
});
