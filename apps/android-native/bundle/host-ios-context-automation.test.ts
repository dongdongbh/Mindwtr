import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { NativeHostResult } from '../../../packages/core/src/native-host-contract';
import { openScreenHost } from '../../../packages/core/src/screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import type { Task } from '../../../packages/core/src/types';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    iosContextAutomation(url: string): string {');
const end = entry.indexOf('    reminderSnoozePrepare(', start);
if (start < 0 || end < 0) throw new Error('Context automation bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
const at = '2026-11-12T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `Call ${id}`, status: 'next', contexts: ['@home'], tags: [], createdAt: at, updatedAt: at, ...extra,
});

afterEach(async () => { await flushPendingSave(); resetForTests(); });

const fixture = async ({ platform = 'ios', sandbox = false, ready = true } = {}) => {
    const writes: unknown[] = [];
    const host = await openScreenHost({ data: { tasks: [task('one'), task('two'), task('office', { contexts: ['@office'] })] },
        record: {}, log: [], saveData: async (data) => { writes.push(data); } });
    writes.length = 0;
    const state = {
        __mindwtrHostPlatform: platform,
        isSandboxMode: () => sandbox,
        port: undefined as unknown as { iosContextAutomation(url: unknown): Promise<unknown> },
        submit: (work: () => Promise<unknown>) => work(),
        unwrap: (reply: NativeHostResult<unknown>) => { if (!reply.ok) throw new Error(reply.error.code); return reply.value; },
        contract: ready ? host : { runContextAutomation: () => ({ ok: false, error: { code: 'NOT_READY' } }) },
    };
    vm.runInNewContext(source, state);
    return { port: state.port, writes };
};

describe('iOS context automation bridge', () => {
    it.each([
        'mindwtr://activate-context?context=home',
        'mindwtr-native-dev://activate-context/%40home',
        'MINDWTR:///context?name=home&action=on',
    ])('builds the RN next-action notification for %s without writes', async (url) => {
        const f = await fixture(), before = useTaskStore.getState();
        const reply = await f.port.iosContextAutomation(url) as Record<string, string>;
        expect(Object.keys(reply).sort()).toEqual(['context', 'message', 'title', 'type']);
        expect(reply.type).toBe('notify');
        expect(reply.context).toBe('@home');
        expect(reply.title).toContain('@home');
        expect(reply.message).toContain('Call one');
        expect(reply.message).not.toContain('Call office');
        await flushPendingSave();
        expect(useTaskStore.getState()._allTasks).toBe(before._allTasks);
        expect(f.writes).toEqual([]);
    });
    it('skips a repeat of the same context within the throttle window', async () => {
        const f = await fixture();
        expect(await f.port.iosContextAutomation('mindwtr://activate-context?context=home')).toMatchObject({ type: 'notify' });
        expect(await f.port.iosContextAutomation('mindwtr://activate-context?context=home')).toEqual({ type: 'none' });
    });
    it.each([
        'mindwtr://deactivate-context?context=home',
        'mindwtr://activate-context?context=garden',
        'mindwtr://activate-context',
        'mindwtr:///focus',
        'https://activate-context?context=home',
        '',
    ])('stays quiet for %s', async (url) => {
        const f = await fixture();
        expect(await f.port.iosContextAutomation(url)).toEqual({ type: 'none' });
        expect(f.writes).toEqual([]);
    });
    it('stays quiet in the Sandbox', async () => {
        const f = await fixture({ sandbox: true });
        expect(await f.port.iosContextAutomation('mindwtr://activate-context?context=home')).toEqual({ type: 'none' });
    });
    it('waits for canonical startup', async () => {
        const f = await fixture({ ready: false });
        await expect(f.port.iosContextAutomation('mindwtr://activate-context?context=home')).rejects.toThrow('NOT_READY');
    });
    it.each([null, 1, {}, 'x'.repeat(16_001)])('refuses invalid input %#', async (url) => {
        const f = await fixture();
        await expect(f.port.iosContextAutomation(url)).rejects.toThrow('INVALID_INPUT');
    });
    it('refuses Android', async () => {
        const f = await fixture({ platform: 'android' });
        await expect(f.port.iosContextAutomation('mindwtr://activate-context?context=home')).rejects.toThrow('INVALID_INPUT');
    });
});
