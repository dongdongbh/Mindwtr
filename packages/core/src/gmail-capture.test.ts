import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { runSyncStoreSave } from './store-write-gate';
import {
    createGmailCaptureRuntime, gmailCaptureIdFor,
    type GmailCaptureConfig, type GmailCaptureTransport, type GmailCaptureController,
} from './gmail-capture';

const config = (): GmailCaptureConfig => ({
    available: true, connected: true, account: 'designated@example.test', accountId: 'mailbox', labelId: 'label', enabled: true,
});
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const transport = (): GmailCaptureTransport => ({
    status: vi.fn(async () => config()),
    connect: vi.fn(async () => ({ ...config(), enabled: false })),
    cancel: vi.fn(async () => undefined),
    labels: vi.fn(async () => [{ id: 'label', name: 'Mindwtr' }]),
    configure: vi.fn(async (labelId, enabled) => ({ ...config(), labelId, enabled })),
    disconnect: vi.fn(async () => ({ revoked: true })),
    poll: vi.fn(async () => ({ batchId: 'batch', accountId: 'mailbox', messages: [{ id: 'message', subject: 'Subject', from: 'Sender', bodyText: 'Body' }], hasMore: false })),
    validate: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
});
const controllers: GmailCaptureController[] = [];
const setup = (native = transport()) => {
    const runtime = createGmailCaptureRuntime(native);
    const addTasks = vi.fn(async () => ({ success: true }));
    const flushPendingSave = vi.fn(async () => undefined);
    const controller = runtime.createGmailCaptureController({ addTasks, flushPendingSave });
    controllers.push(controller);
    runtime.registerGmailCaptureController(controller);
    return { runtime, native, controller, addTasks, flushPendingSave };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.dispose());
    vi.useRealTimers();
});

describe('shared Gmail capture runtime', () => {
    it('keeps configuration generations and status subscriptions local to each runtime', async () => {
        const first = setup();
        const second = setup();
        const validation = deferred<boolean>();
        vi.mocked(first.native.validate).mockReturnValue(validation.promise);
        const firstCycle = first.controller.pollNow();
        await vi.waitFor(() => expect(first.native.validate).toHaveBeenCalledOnce());
        await first.runtime.disconnectGmailCapture();
        await second.controller.pollNow();
        validation.resolve(true);
        await firstCycle;
        expect(first.addTasks).not.toHaveBeenCalled();
        expect(first.native.commit).not.toHaveBeenCalled();
        expect(second.addTasks).toHaveBeenCalledWith([{
            title: 'Subject', initialProps: { status: 'inbox', description: 'From: Sender\n\nBody' },
            captureId: gmailCaptureIdFor('mailbox', 'message'),
        }]);
        expect(second.native.commit).toHaveBeenCalledWith('batch');
        expect(second.runtime.getGmailCaptureStatus().lastImportCount).toBe(1);
        expect(first.runtime.getGmailCaptureStatus().lastImportCount).toBe(0);
    });

    it('pauses an async cycle without rearming a timer or cancelling browser authorization', async () => {
        const { native, controller, addTasks } = setup();
        const validation = deferred<boolean>();
        vi.mocked(native.validate).mockReturnValueOnce(validation.promise).mockResolvedValue(true);
        const cycle = controller.pollNow();
        await vi.waitFor(() => expect(native.validate).toHaveBeenCalledOnce());
        controller.pause();
        validation.resolve(true);
        await cycle;
        expect(addTasks).not.toHaveBeenCalled();
        expect(native.commit).not.toHaveBeenCalled();
        expect(native.cancel).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await controller.pollNow();
        expect(native.poll).toHaveBeenCalledOnce();
        controller.resume();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(addTasks).toHaveBeenCalledOnce();
        expect(native.commit).toHaveBeenCalledOnce();
    });

    it('checks pause again after waiting behind the real sync writer gate', async () => {
        const held = deferred<void>();
        const entered = deferred<void>();
        const save = runSyncStoreSave(async () => { entered.resolve(); await held.promise; });
        await entered.promise;
        const { native, controller, addTasks } = setup();
        const cycle = controller.pollNow();
        try {
            await vi.waitFor(() => expect(native.poll).toHaveBeenCalledOnce());
            controller.pause();
        } finally {
            held.resolve();
            await save;
            await cycle;
        }
        expect(native.validate).not.toHaveBeenCalled();
        expect(addTasks).not.toHaveBeenCalled();
        expect(native.commit).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('invalidates a batch synchronously even when configuration fails', async () => {
        const { runtime, native, controller, addTasks } = setup();
        const validation = deferred<boolean>();
        vi.mocked(native.validate).mockReturnValueOnce(validation.promise);
        vi.mocked(native.configure).mockRejectedValue({ kind: 'network' });
        const cycle = controller.pollNow();
        await vi.waitFor(() => expect(native.validate).toHaveBeenCalledOnce());
        await expect(runtime.configureGmailCapture('another-label', true)).rejects.toMatchObject({ kind: 'network' });
        validation.resolve(true);
        await cycle;
        expect(addTasks).not.toHaveBeenCalled();
        expect(native.commit).not.toHaveBeenCalled();
    });
});

// After the receipts file is reset (the RN opener carries every readable receipt over), a message whose receipt was lost is
// fetched again. Its task ID is deterministic, so the store keeps the task the user has, even one they finished or deleted.
describe('a message captured again after its receipt was lost', () => {
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
    });

    it('never adds a second task, live, done or in Trash', async () => {
        vi.useRealTimers();
        resetForTests();
        setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }), saveData: async () => undefined });
        await useTaskStore.getState().fetchData();
        const runtime = createGmailCaptureRuntime(transport());
        const controller = runtime.createGmailCaptureController({
            addTasks: (items) => useTaskStore.getState().addTasks(items), flushPendingSave,
        });
        controllers.push(controller);
        const id = gmailCaptureIdFor('mailbox', 'message');
        const copies = () => useTaskStore.getState()._allTasks.filter((task) => task.title === 'Subject');

        await controller.pollNow();
        expect(copies().map((task) => task.id)).toEqual([id]);
        await useTaskStore.getState().updateTask(id, { status: 'done' });
        await controller.pollNow();
        expect(copies()).toHaveLength(1);
        expect(copies()[0].status).toBe('done');
        await useTaskStore.getState().deleteTask(id);
        await controller.pollNow();
        expect(copies()).toHaveLength(1);
        expect(copies()[0].deletedAt).toBeTruthy();
    });
});
