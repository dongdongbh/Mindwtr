import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandboxRuntime, resetForTests, useTaskStore, type Task } from '@mindwtr/core';
import { createNativeAppSearch, type AppSearchCall } from './host-app-search';

// Android system search on the native host (pass O2d): core's service bound to Kotlin's index and RN's RKStorage keys. RN's
// inventory rows the bind owns: armed once per start with one full reindex, never in the sandbox, General's switch written to
// RKStorage (owed wipe first) and kept from Kotlin's device store, the row hidden where the index does not run.

const at = '2026-10-21T12:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, ...extra } as Task);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(info: Record<string, unknown> = { supported: true, scheme: 'mindwtr-native-dev' }, stored: Record<string, string> = {}) {
    const keys = new Map(Object.entries(stored));
    const kvLog: string[] = [];
    const keyValue = {
        get: async (key: string) => keys.get(key) ?? null,
        set: async (key: string, value: string) => { kvLog.push(`set ${key}=${value}`); keys.set(key, value); },
        remove: async (key: string) => { kvLog.push(`remove ${key}`); keys.delete(key); },
    };
    const calls: { op: string; ids?: string[]; docs?: { id: string; deepLink: string }[] }[] = [];
    const call: AppSearchCall = async (request) => { calls.push(request as never); return null; };
    return { keys, kvLog, calls, appSearch: createNativeAppSearch(JSON.stringify(info), call, keyValue) };
}

describe('native Android system search', () => {
    afterEach(() => resetForTests());

    it('reindexes in full once at the start when the switch is on, in the build\'s scheme', async () => {
        resetForTests();
        useTaskStore.setState({ _allTasks: [task('t1'), task('done', { status: 'done' })] } as never);
        const { calls, appSearch } = setup(undefined, { 'mindwtr:appSearchIndexingEnabled': 'true' });
        await appSearch!.start();
        await appSearch!.start();
        await flush();
        expect(calls.map((item) => item.op)).toEqual(['wipe', 'upsert']);
        expect(calls[1].docs).toEqual([expect.objectContaining({ id: 'task:t1', deepLink: 'mindwtr-native-dev://open?task=t1' })]);
        expect(appSearch!.device()).toEqual({ supported: true, enabled: true });
    });

    // Kotlin's DeviceWrites stores General's switch in RKStorage (with its journal order) before the reply comes back; then the
    // index follows the stored switch. The bundle never writes the keys itself, so a replayed old entry cannot win.
    it('follows the stored switch after General\'s edit: off wipes, on reindexes', async () => {
        resetForTests();
        useTaskStore.setState({ _allTasks: [task('t1')] } as never);
        const { keys, kvLog, calls, appSearch } = setup(undefined, { 'mindwtr:appSearchIndexingEnabled': 'true' });
        await flush();
        expect(appSearch!.device().enabled).toBe(true);
        keys.delete('mindwtr:appSearchIndexingEnabled');
        keys.set('mindwtr:appSearchWipeOwed', 'true');
        await appSearch!.apply();
        await flush();
        expect(calls.map((item) => item.op)).toEqual(['wipe']);
        expect(kvLog).toEqual(['remove mindwtr:appSearchWipeOwed']);
        expect(appSearch!.device().enabled).toBe(false);
        keys.set('mindwtr:appSearchIndexingEnabled', 'true');
        await appSearch!.apply();
        await flush();
        expect(calls.map((item) => item.op)).toEqual(['wipe', 'wipe', 'upsert']);
    });

    it('is absent without Kotlin\'s bridge, and hides the row below Android 12', async () => {
        expect(createNativeAppSearch(undefined, async () => null, { get: async () => null, set: async () => {}, remove: async () => {} })).toBeNull();
        const { calls, appSearch } = setup({ supported: false, scheme: 'mindwtr' }, { 'mindwtr:appSearchIndexingEnabled': 'true' });
        await appSearch!.start();
        expect(calls).toEqual([]);
        expect(appSearch!.device().supported).toBe(false);
    });
    // Last: a runtime's sandbox mode is fixed once set (initializeSandboxRuntime).
    it('indexes nothing in the sandbox and hides the row there', async () => {
        resetForTests();
        initializeSandboxRuntime(true);
        const { calls, appSearch } = setup(undefined, { 'mindwtr:appSearchIndexingEnabled': 'true', 'mindwtr:appSearchWipeOwed': 'true' });
        await appSearch!.start();
        expect(calls).toEqual([]);
        expect(appSearch!.device()).toEqual({ supported: false, enabled: false });
    });

});
