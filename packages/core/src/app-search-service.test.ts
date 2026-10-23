// Moved with the service from React Native's lib/app-search-service.test.ts (pass O2c): the same cases through ports, so
// the native Android app's binding inherits them. React Native keeps its own copy, now running against this core service.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppSearchIndexing, type AppSearchIndexingPorts } from './app-search-service';
import type { Area, Project, Task } from './types';

type State = { tasks: Task[]; projects: Project[]; areas: Area[] };
type Listener = (state: State, prevState: State) => void;
const now = '2026-08-10T00:00:00.000Z';
const task = (overrides: Partial<Task> = {}): Task => ({
    id: 't1', title: 'Buy milk', status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now, ...overrides,
} as Task);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function setup(scheme?: string) {
    const listeners: Listener[] = [];
    const state: State = { tasks: [], projects: [], areas: [] };
    const ports = {
        isSupported: vi.fn(() => true),
        readEnabled: vi.fn(async () => true),
        readWipeOwed: vi.fn(async () => false),
        clearWipeOwed: vi.fn(async () => undefined),
        markWipeOwed: vi.fn(async () => undefined),
        upsert: vi.fn(async (_docs: unknown[]) => undefined),
        remove: vi.fn(async (_ids: string[]) => undefined),
        wipe: vi.fn(async () => undefined),
        logInfo: vi.fn(),
        logWarn: vi.fn(),
        store: {
            getState: () => state,
            subscribe: (listener: Listener) => {
                listeners.push(listener);
                return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
            },
        },
        nameListener: <L,>(_name: string, listener: L) => listener,
        ...(scheme ? { scheme } : {}),
    } satisfies AppSearchIndexingPorts;
    return { ports, state, listeners, indexing: createAppSearchIndexing(ports) };
}

describe('AppSearch indexing (core, shared by React Native and native Android)', () => {
    let env: ReturnType<typeof setup>;
    beforeEach(() => { vi.useFakeTimers(); env = setup(); });
    afterEach(() => { env.indexing.disarm(); vi.useRealTimers(); });

    it('does not subscribe when unsupported, and arms one subscription even when called twice', () => {
        env.ports.isSupported.mockReturnValue(false);
        env.indexing.arm();
        expect(env.listeners).toHaveLength(0);
        env.ports.isSupported.mockReturnValue(true);
        env.indexing.arm();
        env.indexing.arm();
        expect(env.listeners).toHaveLength(1);
    });

    it('debounces a burst into one round-trip and ignores edits outside tasks, projects and areas', async () => {
        env.indexing.arm();
        const listener = env.listeners[0];
        listener({ ...env.state }, { ...env.state });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(env.ports.upsert).not.toHaveBeenCalled();
        let prev = { ...env.state };
        env.state.tasks = [task()];
        listener({ ...env.state }, prev);
        prev = { ...env.state };
        env.state.tasks = [task({ title: 'Buy oat milk' })];
        listener({ ...env.state }, prev);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(env.ports.upsert).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(env.ports.upsert).toHaveBeenCalledTimes(1);
        expect(env.ports.upsert).toHaveBeenCalledWith([expect.objectContaining({ title: 'Buy oat milk' })]);
    });

    it('still runs removals when the upsert in the same batch fails (#1017 correction), logging and swallowing the failure', async () => {
        env.indexing.arm();
        env.state.tasks = [task(), task({ id: 't2', title: 'Other' })];
        env.listeners[0]({ ...env.state }, { ...env.state, tasks: [] });
        await vi.advanceTimersByTimeAsync(2_000);
        await flush();
        env.ports.upsert.mockClear();
        env.ports.upsert.mockRejectedValueOnce(new Error('boom'));
        const prev = { ...env.state };
        env.state.tasks = [task({ title: 'Changed' })];
        env.listeners[0]({ ...env.state }, prev);
        await vi.advanceTimersByTimeAsync(2_000);
        await flush();
        expect(env.ports.remove).toHaveBeenCalledWith(['task:t2']);
        expect(env.ports.logWarn).toHaveBeenCalledWith('AppSearch index update failed; local data is unaffected', { error: 'boom' });
    });

    it('re-wipes instead of arming if the preference flips off mid-reindex (#1017 correction)', async () => {
        let resolveUpsert!: () => void;
        env.ports.upsert.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveUpsert = () => resolve(undefined); }));
        const enabling = env.indexing.enable();
        await flush();
        env.ports.readEnabled.mockResolvedValue(false);
        resolveUpsert();
        await enabling;
        expect(env.indexing.isArmed()).toBe(false);
        expect(env.ports.wipe).toHaveBeenCalledTimes(2);
    });

    it('finishes an owed wipe at the next start, and keeps it owed until a wipe lands', async () => {
        env.ports.wipe.mockRejectedValueOnce(new Error('boom'));
        await env.indexing.wipe();
        expect(env.ports.clearWipeOwed).not.toHaveBeenCalled();
        env.ports.readEnabled.mockResolvedValue(false);
        env.ports.readWipeOwed.mockResolvedValue(true);
        env.ports.wipe.mockRejectedValueOnce(new Error('again'));
        await env.indexing.syncWithPreference();
        expect(env.ports.clearWipeOwed).not.toHaveBeenCalled();
        expect(env.ports.logInfo).toHaveBeenLastCalledWith('AppSearch owed wipe finished at start', { releaseCheck: 'v1.3.7/app-search-owed-wipe', outcome: 'failed' });
        await env.indexing.syncWithPreference();
        expect(env.ports.clearWipeOwed).toHaveBeenCalledTimes(1);
        expect(env.ports.logInfo).toHaveBeenLastCalledWith('AppSearch owed wipe finished at start', { releaseCheck: 'v1.3.7/app-search-owed-wipe', outcome: 'wiped' });
    });

    // A reindex never clears an owed wipe: a toggle-off can land while it runs, and its upsert lands after that wipe.
    const midReindexOff = async (start: () => Promise<void>) => {
        let resolveUpsert!: () => void;
        env.ports.upsert.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveUpsert = () => resolve(undefined); }));
        const starting = start();
        await flush();
        // The user turns the switch off: the owed wipe is stored, the switch goes, and its wipe lands.
        env.ports.readEnabled.mockResolvedValue(false);
        await env.indexing.wipe();
        resolveUpsert();
        await starting;
    };

    it('a toggle-off during the start\'s reindex wins: no live indexing, and the last wipe stays owed until it lands', async () => {
        env.ports.wipe.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('died'));
        await midReindexOff(() => env.indexing.syncWithPreference());
        expect(env.indexing.isArmed()).toBe(false);
        // The reindex's late upsert is wiped again, owed first; that wipe failing leaves it owed for the next start.
        expect(env.ports.markWipeOwed).toHaveBeenCalledTimes(1);
        expect(env.ports.markWipeOwed.mock.invocationCallOrder[0]).toBeLessThan(env.ports.wipe.mock.invocationCallOrder[2]);
        // The toggle-off's wipe landed during the rebuild, so it cleared nothing; the last wipe failed: still owed.
        expect(env.ports.clearWipeOwed).not.toHaveBeenCalled();
    });

    it('a toggle-off during the reindex that turning it on started leaves the wipe owed until the last wipe lands', async () => {
        env.ports.wipe.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('died'));
        await midReindexOff(() => env.indexing.enable());
        expect(env.indexing.isArmed()).toBe(false);
        expect(env.ports.markWipeOwed).toHaveBeenCalledTimes(1);
        expect(env.ports.clearWipeOwed.mock.invocationCallOrder.every((order) => order < env.ports.markWipeOwed.mock.invocationCallOrder[0])).toBe(true);
    });

    // O2c review notes: a port that rejects anyway (the contract says they never do) cannot stop the wipe, and a toggle-off's
    // wipe that lands while a rebuild runs leaves the owed wipe owed (the rebuild's upsert lands after it).
    it('still wipes when marking the owed wipe fails', async () => {
        env.ports.readEnabled.mockResolvedValue(false);
        env.ports.markWipeOwed.mockRejectedValueOnce(new Error('disk'));
        await env.indexing.enable();
        expect(env.ports.wipe).toHaveBeenCalledTimes(2);
        expect(env.ports.clearWipeOwed).toHaveBeenCalledTimes(1);
    });

    it('a toggle-off wipe that lands during a rebuild leaves the wipe owed', async () => {
        let resolveUpsert!: () => void;
        env.ports.upsert.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveUpsert = () => resolve(undefined); }));
        const rebuilding = env.indexing.runFullReindex();
        await flush();
        await env.indexing.wipe();
        expect(env.ports.clearWipeOwed).not.toHaveBeenCalled();
        resolveUpsert();
        await rebuilding;
        await env.indexing.wipe();
        expect(env.ports.clearWipeOwed).toHaveBeenCalledTimes(1);
    });

    it('a full reindex wipes, then upserts every active item; wipe disarms; disarm stops later updates', async () => {
        env.state.tasks = [task(), task({ id: 'gone', deletedAt: now })];
        env.state.projects = [{ id: 'p1', title: 'P', status: 'active', color: '#000', order: 0, tagIds: [], createdAt: now, updatedAt: now } as Project];
        await env.indexing.runFullReindex();
        expect(env.ports.wipe.mock.invocationCallOrder[0]).toBeLessThan(env.ports.upsert.mock.invocationCallOrder[0]);
        expect(env.ports.upsert).toHaveBeenCalledWith([expect.objectContaining({ id: 'task:t1' }), expect.objectContaining({ id: 'project:p1' })]);
        env.indexing.arm();
        await env.indexing.wipe();
        expect(env.indexing.isArmed()).toBe(false);
        env.indexing.arm();
        env.ports.upsert.mockClear();
        // An edit already debounced, then disarm: the pending update is dropped and the store listener is gone.
        env.listeners[0]({ ...env.state, tasks: [task({ title: 'later' })] }, { ...env.state });
        env.indexing.disarm();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(env.ports.upsert).not.toHaveBeenCalled();
        expect(env.listeners).toHaveLength(0);
    });

    it('seeds with a full reindex in the build\'s scheme', async () => {
        const dev = setup('mindwtr-native-dev');
        dev.state.tasks = [task(), task({ id: 'done', status: 'done' })];
        await dev.indexing.syncWithPreference();
        expect(dev.ports.wipe).toHaveBeenCalledTimes(1);
        expect(dev.ports.upsert).toHaveBeenCalledWith([expect.objectContaining({ id: 'task:t1', deepLink: 'mindwtr-native-dev://open?task=t1' })]);
        dev.indexing.disarm();
    });
});
