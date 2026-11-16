import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageConflictError, type AppData } from '@mindwtr/core';
import { webStorage } from './storage-adapter-web';

vi.mock('./report-error', () => ({ reportError: vi.fn() }));

const initial = (): AppData => ({ tasks: [{ id: 'task', title: 'Original', status: 'next', tags: [], contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', timeSpentMinutes: 5 }],
projects: [], sections: [], areas: [], settings: {} });
const credited = (data: AppData): AppData => ({ ...data, tasks: [{ ...data.tasks[0], timeSpentMinutes: 8 }], settings: {
    pomodoroCredits: { '00000000-0000-4000-8000-000000000001': { taskId: 'task', minutes: 3 } },
} });

describe('browser credit writes', () => {
    beforeEach(() => {
        localStorage.clear();
        const tails = new Map<string, Promise<unknown>>();
        vi.stubGlobal('navigator', { locks: { request: vi.fn((name: string, operation: () => unknown) => {
            const pending = (tails.get(name) ?? Promise.resolve()).then(operation);
            tails.set(name, pending.catch(() => undefined));
            return pending;
        }) } });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('rejects an ordinary stale save queued during a conditional credit', async () => {
        await webStorage.saveData(initial());
        const expected = await webStorage.getData();
        const credit = webStorage.saveDataIfUnchanged!(credited(expected), expected);
        const ordinary = webStorage.saveData({ ...expected, tasks: [{ ...expected.tasks[0], title: 'External edit' }] });
        await expect(credit).resolves.toBeUndefined();
        await expect(ordinary).rejects.toBeInstanceOf(StorageConflictError);
        expect((await webStorage.getData()).tasks[0].timeSpentMinutes).toBe(8);
    });

    it('waits for the shared browser writer and refuses the changed document', async () => {
        await webStorage.saveData(initial());
        const expected = await webStorage.getData();
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        const held = navigator.locks.request('mindwtr-data:write', async () => {
            entered();
            await new Promise<void>((resolve) => { release = resolve; });
        });
        await ready;
        const ordinary = webStorage.saveData({ ...expected, tasks: [{ ...expected.tasks[0], title: 'External edit' }] });
        const credit = webStorage.saveDataIfUnchanged!(credited(expected), expected);
        expect(JSON.parse(localStorage.getItem('mindwtr-data')!).tasks[0].title).toBe('Original');
        release();
        await held;
        await ordinary;
        await expect(credit).rejects.toBeInstanceOf(StorageConflictError);
        expect((await webStorage.getData()).tasks[0].title).toBe('External edit');
    });

    it('fails closed for credits without Web Locks and keeps ordinary storage usable', async () => {
        vi.stubGlobal('navigator', {});
        await webStorage.saveData(initial());
        const expected = await webStorage.getData();
        await expect(webStorage.saveDataIfUnchanged!(credited(expected), expected)).rejects.toThrow('Atomic browser storage');
        expect((await webStorage.getData()).tasks[0].timeSpentMinutes).toBe(5);
    });

    it('keeps accepting a legacy stored document without settings', async () => {
        localStorage.setItem('mindwtr-data', JSON.stringify({ tasks: [], projects: [] }));
        const loaded = await webStorage.getData();
        await expect(webStorage.saveData({ ...loaded, settings: {} })).resolves.toBeUndefined();
    });
});
