import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, loadTranslations, noopStorage, resetForTests, setStorageAdapter, useTaskStore, type AppData } from '@mindwtr/core';
import { createMobileBackgroundSyncRunner } from '@mindwtr/core/mobile-background-sync';
import { drainPendingCapturesInBackground } from './pending-capture-drain';
import { replayNotificationCompletions } from './notification-completion-drain';
import { resetMobileWidgetRenderCache, updateMobileWidgetFromData } from './widget-service';

const h = vi.hoisted(() => ({
    receipts: [] as { actionId: string; taskId: string }[],
    payloads: [] as string[], order: [] as string[], publishFails: false, log: vi.fn(async () => undefined),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'background' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.3.8' } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async () => null, setItem: async () => undefined,
} }));
vi.mock('../modules/notification-open-intents', () => ({
    peekPendingNotificationCompletions: async () => [...h.receipts],
    acknowledgeNotificationCompletion: async (actionId: string) => {
        h.order.push('ack'); h.receipts = h.receipts.filter((item) => item.actionId !== actionId);
    },
}));
vi.mock('../modules/android-widget', () => ({
    isSupported: () => true, getWidgetListSelections: () => ['inbox'],
    setPayload: (payload: string) => {
        if (h.publishFails) throw new Error('widget host unavailable');
        h.order.push('publish'); h.payloads.push(payload);
    },
    updateWidgets: () => undefined,
}));
vi.mock('react-native-widgetkit', () => ({}));
vi.mock('./system-color-scheme', () => ({ getSystemColorSchemeForWidget: () => 'light' }));
vi.mock('./app-log', () => ({ logInfo: h.log, logWarn: h.log, logError: h.log }));
vi.mock('./file-system', () => ({
    documentDirectory: null, getInfoAsync: vi.fn(), readDirectoryAsync: vi.fn(),
    readAsStringAsync: vi.fn(), deleteAsync: vi.fn(),
}));

let persisted: AppData;
let finishSave: (() => void) | undefined;
let pauseSave = false;
let failSaves = false;
const storage = {
    getData: async () => structuredClone(persisted),
    saveData: async (data: AppData) => {
        if (failSaves) throw new Error('disk unavailable');
        if (pauseSave) await new Promise<void>((resolve) => { finishSave = resolve; });
        persisted = structuredClone(data); h.order.push('saved');
    },
};
vi.mock('./storage-adapter', () => ({ mobileStorage: {
    getData: () => storage.getData(), saveData: (data: AppData) => storage.saveData(data),
} }));


beforeEach(async () => {
    resetForTests(); resetMobileWidgetRenderCache(); await loadTranslations('en');
    h.receipts = [{ actionId: 'done:task', taskId: 'task' }];
    h.payloads = []; h.order = []; h.publishFails = false; h.log.mockClear();
    finishSave = undefined; pauseSave = false; failSaves = false;
    persisted = {
        tasks: [{ id: 'task', title: 'Private reminder title', status: 'inbox', contexts: [], tags: [],
            createdAt: '2026-10-20T12:00:00Z', updatedAt: '2026-10-20T12:00:00Z' }],
        projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'reminder-test' },
    };
    // The host already displays Inbox before the app process exits.
    await updateMobileWidgetFromData(persisted); h.order = [];
    setStorageAdapter(noopStorage);
});
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('notification Done without an app root (#1436)', () => {
    it('hydrates, durably completes and publishes Inbox with sync Off and no capture files', async () => {
        const network = vi.fn();
        const runner = createMobileBackgroundSyncRunner({
            storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
            log: { info: vi.fn(), warn: vi.fn() },
            sync: { getConfigurationStatus: async () => ({ backend: 'off', configured: false }),
                performSync: network, abort: vi.fn(), setRequestDeadline: vi.fn() },
            drainPendingCaptures: drainPendingCapturesInBackground, flushPendingSave,
            quiesceStorage: async () => undefined, timersPaused: () => false,
            onAppStateChange: () => ({ remove: () => undefined }),
        });
        await runner.runCapture();
        expect(network).not.toHaveBeenCalled();
        expect(persisted.tasks[0].status).toBe('done');
        expect(persisted.tasks[0].rev).toBeGreaterThan(0);
        expect(h.order).toEqual(['saved', 'publish', 'ack']);
        expect(h.receipts).toEqual([]);
        expect(JSON.parse(h.payloads[0]).lists.inbox.items.map((item: { id: string }) => item.id)).toContain('task');
        expect(JSON.parse(h.payloads.at(-1)!).lists.inbox.items).toEqual([]);
        expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Background Done'), expect.objectContaining({
            extra: expect.objectContaining({ releaseCheck: 'v1.3.8/reminder-background-completion', widgetUpdated: 'true' }),
        }));
        expect(JSON.stringify(h.log.mock.calls)).not.toContain('Private reminder title');
    });

    it('retains the receipt and old widget until a slow real save finishes; warm duplicates join', async () => {
        pauseSave = true;
        const background = drainPendingCapturesInBackground('capture');
        await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
        const duplicate = replayNotificationCompletions();
        expect(h.payloads).toHaveLength(1); expect(h.receipts).toHaveLength(1);
        expect(persisted.tasks[0].status).toBe('inbox');
        finishSave!();
        await Promise.all([background, duplicate]);
        expect(h.order).toEqual(['saved', 'publish', 'ack']);
        expect(h.receipts).toEqual([]);
    });

    it('retries failed widget publication without generating another recurring instance', async () => {
        persisted.tasks[0] = { ...persisted.tasks[0], status: 'next', recurrence: { rule: 'daily' }, dueDate: '2026-10-22' };
        h.publishFails = true;
        expect(await drainPendingCapturesInBackground('capture')).toBe(0);
        expect(h.receipts).toHaveLength(1);
        expect(persisted.tasks.filter((task) => task.status === 'next')).toHaveLength(1);
        const saved = structuredClone(persisted.tasks);
        h.publishFails = false;
        expect(await replayNotificationCompletions()).toBe(1);
        expect(persisted.tasks).toEqual(saved);
        expect(h.receipts).toEqual([]);
    });

    it('retains exhausted disk failures and retries the optimistic recurring snapshot durably', async () => {
        vi.useFakeTimers();
        persisted.tasks[0] = { ...persisted.tasks[0], status: 'next', recurrence: { rule: 'daily' }, dueDate: '2026-10-22' };
        failSaves = true;
        const first = drainPendingCapturesInBackground('capture');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await first).toBe(0);
        expect(h.receipts).toHaveLength(1);
        expect(h.payloads).toHaveLength(1);
        const optimistic = structuredClone(useTaskStore.getState()._allTasks);
        expect(optimistic.filter((task) => task.status === 'next')).toHaveLength(1);
        failSaves = false;
        const retry = replayNotificationCompletions();
        await vi.runAllTimersAsync();
        expect(await retry).toBe(1);
        expect(persisted.tasks).toEqual(optimistic);
        expect(h.receipts).toEqual([]);
    });
});
