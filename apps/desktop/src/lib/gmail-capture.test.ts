import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushPendingSave, resetForTests, runSyncStoreSave, setSaveRetrySleepForTests, setStorageAdapter, useTaskStore,
    type AppData, type Task,
} from '@mindwtr/core';

const native = vi.hoisted(() => vi.fn());
vi.mock('./tauri-invoke', () => ({ invokeNative: native, invokeNativeOr: native }));

import {
    cancelGmailCapture, configureGmailCapture, connectGmailCapture, createGmailCaptureController,
    disconnectGmailCapture, gmailCaptureIdFor, registerGmailCaptureController, toGmailCaptureError,
    type GmailCaptureBatch, type GmailCaptureConfig, type GmailCaptureController, type GmailCaptureStatus,
} from './gmail-capture';

const config = (): GmailCaptureConfig => ({
    available: true, connected: true, account: 'designated@example.test', accountId: 'mailbox-hash', labelId: 'Label_1', enabled: true,
});
const batch = (overrides: Partial<GmailCaptureBatch> = {}): GmailCaptureBatch => ({
    batchId: 'batch-1', accountId: 'mailbox-hash',
    messages: [{ id: 'message-1', subject: 'Renew passport', from: 'Sender', bodyText: 'Bring the old passport.' }],
    hasMore: false,
    ...overrides,
});
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
type Options = Partial<Parameters<typeof createGmailCaptureController>[0]>;
const controllers: GmailCaptureController[] = [];
const create = (overrides: Options = {}) => {
    const events: string[] = [];
    const statuses: GmailCaptureStatus[] = [];
    const options = {
        getConfig: vi.fn(async () => config()),
        poll: vi.fn(async () => batch()),
        validate: vi.fn(async () => { events.push('validate'); return true; }),
        addTasks: vi.fn(async () => { events.push('add'); return { success: true }; }),
        flushPendingSave: vi.fn(async () => { events.push('flush'); }),
        commit: vi.fn(async () => { events.push('commit'); }),
        logInfo: vi.fn(),
        onStatusChange: (status: GmailCaptureStatus) => statuses.push(status),
        setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
        clearTimer: vi.fn(),
        ...overrides,
    };
    const controller = createGmailCaptureController(options);
    controllers.push(controller);
    return { controller, options, events, statuses };
};

beforeEach(() => { native.mockReset(); });
afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.dispose());
    registerGmailCaptureController(null);
    setSaveRetrySleepForTests(null);
    resetForTests();
});

describe('Gmail capture controller', () => {
    it('validates the batch, durably saves core capture IDs, then acknowledges and logs', async () => {
        const { controller, options, events } = create();
        await controller.pollNow();
        expect(events).toEqual(['validate', 'add', 'flush', 'commit']);
        expect(options.addTasks).toHaveBeenCalledWith([{
            title: 'Renew passport',
            initialProps: { status: 'inbox', description: 'From: Sender\n\nBring the old passport.' },
            captureId: gmailCaptureIdFor('mailbox-hash', 'message-1'),
        }]);
        expect(options.commit).toHaveBeenCalledWith('batch-1');
        expect(options.logInfo).toHaveBeenCalledWith('Gmail capture imported messages', {
            releaseCheck: 'v1.3.7/gmail-capture', count: '1',
        });
        expect(gmailCaptureIdFor('another-mailbox', 'message-1')).not.toBe(gmailCaptureIdFor('mailbox-hash', 'message-1'));
    });

    it.each(['disabled', 'disconnected', 'missing-label', 'unavailable'] as const)('never polls when %s', async (state) => {
        const next = config();
        if (state === 'disabled') next.enabled = false;
        if (state === 'disconnected') next.connected = false;
        if (state === 'missing-label') next.labelId = null;
        if (state === 'unavailable') next.available = false;
        const { controller, options } = create({ getConfig: async () => next });
        await controller.pollNow();
        expect(options.poll).not.toHaveBeenCalled();
    });

    it('polls outside the real writer gate, but waits for sync before validation and task creation', async () => {
        const held = deferred<void>();
        const entered = deferred<void>();
        const sync = runSyncStoreSave(async () => { entered.resolve(); await held.promise; });
        await entered.promise;
        const { controller, options } = create();
        const cycle = controller.pollNow();
        try {
            await vi.waitFor(() => expect(options.poll).toHaveBeenCalledOnce());
            expect(options.validate).not.toHaveBeenCalled();
            expect(options.addTasks).not.toHaveBeenCalled();
        } finally {
            held.resolve();
            await sync;
            await cycle;
        }
        expect(options.validate).toHaveBeenCalledOnce();
        expect(options.addTasks).toHaveBeenCalledOnce();
    });

    it.each(['configure', 'connect', 'cancel', 'disconnect'] as const)('invalidates a queued write synchronously before a pending %s IPC', async (operation) => {
        const held = deferred<void>();
        const entered = deferred<void>();
        const sync = runSyncStoreSave(async () => { entered.resolve(); await held.promise; });
        await entered.promise;
        const { controller, options } = create();
        registerGmailCaptureController(controller);
        const cycle = controller.pollNow();
        await vi.waitFor(() => expect(options.poll).toHaveBeenCalledOnce());
        const ipc = deferred<unknown>();
        native.mockReturnValue(ipc.promise);
        const mutation = operation === 'configure' ? configureGmailCapture('Label_2', true)
            : operation === 'connect' ? connectGmailCapture()
                : operation === 'cancel' ? cancelGmailCapture() : disconnectGmailCapture();
        try {
            held.resolve();
            await sync;
            await cycle;
            expect(options.validate).not.toHaveBeenCalled();
            expect(options.addTasks).not.toHaveBeenCalled();
            expect(options.commit).not.toHaveBeenCalled();
        } finally {
            ipc.resolve(config());
            await mutation;
        }
    });

    it('rechecks generation immediately after async batch validation', async () => {
        const validation = deferred<boolean>();
        const { controller, options } = create({ validate: vi.fn(() => validation.promise) });
        const cycle = controller.pollNow();
        await vi.waitFor(() => expect(options.validate).toHaveBeenCalledOnce());
        controller.handleConfigChanged();
        validation.resolve(true);
        await cycle;
        expect(options.addTasks).not.toHaveBeenCalled();
        expect(options.commit).not.toHaveBeenCalled();
    });

    it('refuses a batch invalidated natively or from a different account', async () => {
        const invalid = create({ validate: vi.fn(async () => false) });
        await invalid.controller.pollNow();
        expect(invalid.options.addTasks).not.toHaveBeenCalled();
        expect(invalid.options.commit).not.toHaveBeenCalled();
        const wrongAccount = create({ poll: async () => batch({ accountId: 'another-mailbox' }) });
        await wrongAccount.controller.pollNow();
        expect(wrongAccount.options.validate).not.toHaveBeenCalled();
        expect(wrongAccount.options.commit).not.toHaveBeenCalled();
    });

    it('finishes an admitted durable save during disconnect without acknowledging the stale batch', async () => {
        const save = deferred<void>();
        const { controller, options } = create({ flushPendingSave: vi.fn(() => save.promise) });
        registerGmailCaptureController(controller);
        const cycle = controller.pollNow();
        await vi.waitFor(() => expect(options.flushPendingSave).toHaveBeenCalledOnce());
        native.mockResolvedValue({ revoked: true });
        await disconnectGmailCapture();
        save.resolve();
        await cycle;
        expect(options.addTasks).toHaveBeenCalledOnce();
        expect(options.commit).not.toHaveBeenCalled();
        expect(options.logInfo).not.toHaveBeenCalled();
    });

    it.each(['add', 'flush', 'commit'] as const)('does not acknowledge failed %s work or emit a success diagnostic', async (failure) => {
        const { controller, options } = create({
            ...(failure === 'add' ? { addTasks: vi.fn(async () => ({ success: false })) } : {}),
            ...(failure === 'flush' ? { flushPendingSave: vi.fn(async () => { throw new Error('disk full'); }) } : {}),
            ...(failure === 'commit' ? { commit: vi.fn(async () => { throw { kind: 'storage' }; }) } : {}),
        });
        await controller.pollNow();
        if (failure !== 'commit') expect(options.commit).not.toHaveBeenCalled();
        expect(options.logInfo).not.toHaveBeenCalled();
    });

    it('acknowledges an empty page and bounds backlog work to ten pages', async () => {
        const { controller, options } = create({ poll: vi.fn(async () => batch({ messages: [], hasMore: true })) });
        await controller.pollNow();
        expect(options.addTasks).not.toHaveBeenCalled();
        expect(options.poll).toHaveBeenCalledTimes(10);
        expect(options.commit).toHaveBeenCalledTimes(10);
    });

    it('stops revoked access until reconnect and retries network errors next interval', async () => {
        const auth = create({ poll: vi.fn(async () => { throw { kind: 'auth', message: 'private-provider-response' }; }) });
        await auth.controller.pollNow();
        await auth.controller.pollNow();
        expect(auth.options.poll).toHaveBeenCalledOnce();
        expect(auth.statuses[auth.statuses.length - 1]?.terminal).toBe(true);
        expect(auth.options.setTimer).not.toHaveBeenCalled();
        auth.controller.handleConfigChanged();
        await auth.controller.pollNow();
        expect(auth.options.poll).toHaveBeenCalledTimes(2);
        const network = create({ poll: vi.fn(async () => { throw { kind: 'network' }; }) });
        await network.controller.pollNow();
        expect(network.statuses[network.statuses.length - 1]?.terminal).toBe(false);
        expect(network.options.setTimer).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
        expect(toGmailCaptureError(new Error('private-content')).message).not.toContain('private');
        expect(toGmailCaptureError({ kind: 'auth', message: 'private-content' }).message).not.toContain('private');
    });

    it('retries a failed durable save through the real core factory without replacing edits or retained tombstones', async () => {
        const data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'gmail-test' } };
        let failWrites = true;
        const durable: AppData[] = [];
        const saveData = vi.fn(async (snapshot: AppData) => {
            if (failWrites) throw new Error('disk full');
            durable.push(structuredClone(snapshot));
        });
        setSaveRetrySleepForTests(async () => undefined);
        setStorageAdapter({ getData: async () => data, saveData });
        useTaskStore.setState({
            tasks: [], _allTasks: [], _tasksById: new Map(), projects: [], _allProjects: [], areas: [], _allAreas: [],
            sections: [], _allSections: [], people: [], _allPeople: [], settings: data.settings,
            persistenceFailure: null, error: null, isLoading: false,
        });
        const { controller, options } = create({
            addTasks: (items) => useTaskStore.getState().addTasks(items),
            flushPendingSave,
        });
        await controller.pollNow();
        expect(saveData).toHaveBeenCalledTimes(5);
        expect(options.commit).not.toHaveBeenCalled();
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        const id = gmailCaptureIdFor('mailbox-hash', 'message-1');
        expect(useTaskStore.getState()._allTasks).toHaveLength(1);
        expect(useTaskStore.getState()._allTasks[0]).toMatchObject({ id, rev: expect.any(Number), revBy: 'gmail-test' });
        const edited: Task = { ...useTaskStore.getState()._allTasks[0], title: 'My edited task', rev: 8 };
        useTaskStore.setState({ tasks: [edited], _allTasks: [edited], _tasksById: new Map([[id, edited]]) });
        failWrites = false;
        await controller.pollNow();
        expect(options.commit).toHaveBeenCalledOnce();
        expect(useTaskStore.getState()._allTasks).toEqual([edited]);
        expect(durable[durable.length - 1].tasks).toEqual([edited]);
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
        const tombstone: Task = { ...edited, deletedAt: '2026-10-20T12:00:00.000Z', rev: 9 };
        useTaskStore.setState({ tasks: [], _allTasks: [tombstone], _tasksById: new Map([[id, tombstone]]) });
        await controller.pollNow();
        expect(useTaskStore.getState()._allTasks).toEqual([tombstone]);
        await flushPendingSave();
    });
});
