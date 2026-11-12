import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveNativeShortcutCaptureDraft } from '../../../packages/core/src/native-route-destination';
import { openScreenHost } from '../../../packages/core/src/screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import type { Project, Task } from '../../../packages/core/src/types';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    iosShortcutCaptureDraft(url: string): string {');
const end = entry.indexOf('    iosContextAutomation(url: string): string {', start);
if (start < 0 || end < 0) throw new Error('Shortcut capture bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
const at = '2026-11-12T00:00:00.000Z';
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const task = (taskId: string, extra: Partial<Task> = {}): Task => ({
    id: taskId, title: 'PRIVATE', status: 'inbox', contexts: [], tags: [], createdAt: at, updatedAt: at, ...extra,
});
const project: Project = { id: 'p-home', title: 'Home', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at };

afterEach(async () => { await flushPendingSave(); resetForTests(); });

const fixture = async ({ platform = 'ios', sandbox = false, saved = true } = {}) => {
    const writes: unknown[] = [];
    await openScreenHost({ data: { tasks: [task('deleted-capture', { deletedAt: at })], projects: [project] },
        record: {}, log: [], saveData: async (data) => { writes.push(data); } });
    writes.length = 0;
    const state = {
        __mindwtrHostPlatform: platform, isSandboxMode: () => sandbox, useTaskStore, resolveNativeShortcutCaptureDraft,
        requireSaved: () => { if (!saved) throw new Error('NOT_READY: unsaved'); },
        submit: (work: () => Promise<unknown>) => work(),
        port: undefined as unknown as { iosShortcutCaptureDraft(url: unknown): Promise<unknown> },
    };
    vm.runInNewContext(source, state);
    return { port: state.port, writes };
};

describe('iOS shortcut capture draft bridge', () => {
    it.each(['mindwtr', 'mindwtr-native-dev'])('reads the %s capture link read-only', async (scheme) => {
        const f = await fixture(), before = useTaskStore.getState();
        expect(await f.port.iosShortcutCaptureDraft(`${scheme}:///capture?title=Call&requestId=${id}&note=Ask&tags=a,b&project=home`))
            .toEqual({ type: 'draft', captureId: id, text: 'Call #a #b', note: 'Ask', projectId: 'p-home' });
        await flushPendingSave();
        expect(useTaskStore.getState()._allTasks).toBe(before._allTasks);
        expect(f.writes).toEqual([]);
    });
    it('treats a deleted task with the request ID as already captured', async () => {
        const f = await fixture();
        useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks, task(id, { deletedAt: at })] }));
        expect(await f.port.iosShortcutCaptureDraft(`mindwtr:///capture?title=Call&requestId=${id}`)).toEqual({ type: 'none' });
    });
    it.each(['https:///capture?title=Call', 'mindwtr:///capture?note=Only', 'mindwtr:///focus', ''])('opens nothing for %s', async (url) => {
        const f = await fixture();
        expect(await f.port.iosShortcutCaptureDraft(url)).toEqual({ type: 'none' });
    });
    it('opens nothing in the Sandbox', async () => {
        const f = await fixture({ sandbox: true });
        expect(await f.port.iosShortcutCaptureDraft('mindwtr:///capture?title=Call')).toEqual({ type: 'none' });
    });
    it('waits for saved canonical data', async () => {
        const f = await fixture({ saved: false });
        await expect(f.port.iosShortcutCaptureDraft('mindwtr:///capture?title=Call')).rejects.toThrow('NOT_READY');
    });
    it.each([null, 1, {}, 'x'.repeat(16_001)])('refuses invalid input %#', async (url) => {
        const f = await fixture();
        await expect(f.port.iosShortcutCaptureDraft(url)).rejects.toThrow('INVALID_INPUT');
    });
    it('refuses Android', async () => {
        const f = await fixture({ platform: 'android' });
        await expect(f.port.iosShortcutCaptureDraft('mindwtr:///capture?title=Call')).rejects.toThrow('INVALID_INPUT');
    });
});
