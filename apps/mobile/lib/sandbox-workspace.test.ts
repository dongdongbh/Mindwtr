import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
}));

const core = vi.hoisted(() => ({
    acquireWorkspaceTransitionLock: vi.fn(),
    createSandboxBootRequest: vi.fn(() => 'sandbox-request'),
    createSandboxData: vi.fn(() => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} })),
    createSandboxStorage: vi.fn(() => ({ getData: vi.fn(), saveData: vi.fn() })),
    flushPendingSave: vi.fn(),
    getSystemDefaultLanguage: vi.fn(() => 'en'),
    getPersistenceStatus: vi.fn(() => ({
        queued: 0,
        inFlight: false,
        immediate: 0,
        retrying: false,
        generation: 1,
        failed: false,
    })),
    initializeSandboxRuntime: vi.fn(),
    isSandboxMode: vi.fn(() => false),
    parseSandboxBootRequest: vi.fn(),
    setStorageAdapter: vi.fn(),
    useTaskStore: { getState: vi.fn(() => ({ settings: { language: 'en', theme: 'system' } })) },
    waitForSyncDocumentOperationsIdle: vi.fn(),
}));

const mobileStorage = vi.hoisted(() => ({ getData: vi.fn(), saveData: vi.fn() }));
const appLog = vi.hoisted(() => ({ logInfo: vi.fn().mockResolvedValue(null) }));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));
vi.mock('expo', () => ({ reloadAppAsync: vi.fn() }));
vi.mock('@mindwtr/core', () => ({
    ...core,
    LANGUAGE_STORAGE_KEY: 'mindwtr-language',
}));
vi.mock('./storage-adapter', () => ({
    mobileStorage,
    quiesceMobileStorageForWorkspaceSwitch: vi.fn(),
}));
vi.mock('./app-log', () => appLog);

import {
    MOBILE_SANDBOX_BOOT_REQUEST_KEY,
    consumeMobileSandboxBootRequest,
    getWorkspaceSwitching,
    initializeMobileWorkspace,
    reloadIntoMobileSandbox,
    reloadIntoPersonalWorkspace,
    type WorkspaceSwitchDependencies,
} from './sandbox-workspace';

const switchDependencies = (overrides: Partial<WorkspaceSwitchDependencies> = {}): WorkspaceSwitchDependencies => ({
    acquireTransitionLock: vi.fn(() => vi.fn()),
    flushSaves: vi.fn().mockResolvedValue(undefined),
    getPersistenceStatus: vi.fn(() => ({
        queued: 0,
        inFlight: false,
        immediate: 0,
        retrying: false,
        generation: 1,
        failed: false,
    })),
    quiescePersonalStorage: vi.fn().mockResolvedValue(undefined),
    waitForDocumentOperationsIdle: vi.fn().mockResolvedValue(undefined),
    waitForSyncIdle: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    storage: {
        getItem: vi.fn().mockResolvedValue(null),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem: vi.fn().mockResolvedValue(undefined),
    },
    transitionTimeoutMs: 15_000,
    ...overrides,
});

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
};

describe('mobile sandbox workspace transition', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        core.acquireWorkspaceTransitionLock.mockImplementation(() => vi.fn());
        core.isSandboxMode.mockReturnValue(false);
        core.parseSandboxBootRequest.mockReturnValue(null);
        core.useTaskStore.getState.mockReturnValue({ settings: { language: 'en', theme: 'system' } });
    });

    it('removes the one-shot request before parsing it', async () => {
        const order: string[] = [];
        const storage = {
            getItem: vi.fn(async () => {
                order.push('get');
                return 'raw-request';
            }),
            removeItem: vi.fn(async () => {
                order.push('remove');
            }),
            setItem: vi.fn(),
        };
        core.parseSandboxBootRequest.mockImplementation(() => {
            order.push('parse');
            return {};
        });

        await expect(consumeMobileSandboxBootRequest(storage)).resolves.toEqual({ settings: {} });
        expect(order).toEqual(['get', 'remove', 'parse']);
    });

    it('does not create a request when settling saves fails', async () => {
        const release = vi.fn();
        const dependencies = switchDependencies({
            acquireTransitionLock: vi.fn(() => release),
            flushSaves: vi.fn().mockRejectedValue(new Error('save failed')),
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('save failed');
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        expect(dependencies.reload).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(getWorkspaceSwitching()).toBe(false);
    });

    it('waits for deferred saves, sync, document work, and native storage before writing the request', async () => {
        const firstSave = deferred();
        const syncIdle = deferred();
        const documentIdle = deferred();
        const nativeIdle = deferred();
        const dependencies = switchDependencies({
            flushSaves: vi.fn()
                .mockImplementationOnce(() => firstSave.promise)
                .mockResolvedValue(undefined),
            waitForSyncIdle: vi.fn()
                .mockImplementationOnce(() => syncIdle.promise)
                .mockResolvedValue(undefined),
            waitForDocumentOperationsIdle: vi.fn()
                .mockImplementationOnce(() => documentIdle.promise)
                .mockResolvedValue(undefined),
            quiescePersonalStorage: vi.fn()
                .mockImplementationOnce(() => nativeIdle.promise)
                .mockResolvedValue(undefined),
        });
        const transition = reloadIntoMobileSandbox(dependencies);

        expect(dependencies.flushSaves).toHaveBeenCalledOnce();
        expect(dependencies.waitForSyncIdle).not.toHaveBeenCalled();
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        firstSave.resolve(undefined);
        await vi.waitFor(() => expect(dependencies.waitForSyncIdle).toHaveBeenCalledOnce());
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        syncIdle.resolve(undefined);
        await vi.waitFor(() => expect(dependencies.waitForDocumentOperationsIdle).toHaveBeenCalledOnce());
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        documentIdle.resolve(undefined);
        await vi.waitFor(() => expect(dependencies.quiescePersonalStorage).toHaveBeenCalledOnce());
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        nativeIdle.resolve(undefined);

        await transition;
        expect(dependencies.flushSaves).toHaveBeenCalledTimes(4);
        expect(dependencies.waitForSyncIdle).toHaveBeenCalledTimes(2);
        expect(dependencies.waitForDocumentOperationsIdle).toHaveBeenCalledTimes(2);
        expect(dependencies.quiescePersonalStorage).toHaveBeenCalledTimes(3);
        expect(dependencies.storage.setItem).toHaveBeenCalledWith(
            MOBILE_SANDBOX_BOOT_REQUEST_KEY,
            'sandbox-request',
        );
        expect(dependencies.reload).toHaveBeenCalledOnce();
    });

    it('rejects a recorded persistence failure and releases the transition', async () => {
        const release = vi.fn();
        const dependencies = switchDependencies({
            acquireTransitionLock: vi.fn(() => release),
            getPersistenceStatus: vi.fn(() => ({
                queued: 0,
                inFlight: false,
                immediate: 0,
                retrying: false,
                generation: 1,
                failed: true,
            })),
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('unsaved changes');
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        expect(dependencies.reload).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it('rejects a core write admitted while the boot request storage write was pending', async () => {
        let generation = 4;
        let queued = 0;
        const release = vi.fn();
        const getStatus = vi.fn(() => ({
            queued,
            inFlight: false,
            immediate: 0,
            retrying: false,
            generation,
            failed: false,
        }));
        const dependencies = switchDependencies({
            acquireTransitionLock: vi.fn(() => release),
            getPersistenceStatus: getStatus,
        });
        vi.mocked(dependencies.storage.getItem).mockResolvedValue('sandbox-request');
        vi.mocked(dependencies.storage.setItem).mockImplementation(async () => {
            generation += 1;
            queued = 1;
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow(
            'Personal data changed while opening the sandbox',
        );
        await vi.waitFor(() => expect(dependencies.storage.removeItem).toHaveBeenCalledWith(
            MOBILE_SANDBOX_BOOT_REQUEST_KEY,
        ));
        expect(dependencies.reload).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it('acquires synchronously, rejects a competing entry, and keeps the successful lease', async () => {
        let locked = false;
        const syncIdle = deferred();
        const release = vi.fn(() => { locked = false; });
        const acquire = vi.fn(() => {
            if (locked) return null;
            locked = true;
            return release;
        });
        const dependencies = switchDependencies({
            acquireTransitionLock: acquire,
            waitForSyncIdle: vi.fn()
                .mockImplementationOnce(() => syncIdle.promise)
                .mockResolvedValue(undefined),
        });

        const first = reloadIntoMobileSandbox(dependencies);
        expect(acquire).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(dependencies.waitForSyncIdle).toHaveBeenCalledOnce());
        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('already active');
        expect(dependencies.storage.removeItem).not.toHaveBeenCalled();

        syncIdle.resolve(undefined);
        await first;
        expect(release).not.toHaveBeenCalled();
        expect(locked).toBe(true);
    });

    it('times out without a late request, releases the lease, and permits a clean retry', async () => {
        let locked = false;
        const firstSyncIdle = deferred();
        const release = vi.fn(() => { locked = false; });
        const acquire = vi.fn(() => {
            if (locked) return null;
            locked = true;
            return release;
        });
        const waitForSyncIdle = vi.fn()
            .mockImplementationOnce(() => firstSyncIdle.promise)
            .mockResolvedValue(undefined);
        const dependencies = switchDependencies({
            acquireTransitionLock: acquire,
            transitionTimeoutMs: 20,
            waitForSyncIdle,
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('Timed out');
        expect(release).toHaveBeenCalledOnce();
        expect(dependencies.storage.setItem).not.toHaveBeenCalled();
        expect(dependencies.storage.removeItem).not.toHaveBeenCalled();

        dependencies.transitionTimeoutMs = 15_000;
        await reloadIntoMobileSandbox(dependencies);
        expect(dependencies.reload).toHaveBeenCalledOnce();
        firstSyncIdle.resolve(undefined);
        await Promise.resolve();
        expect(dependencies.storage.setItem).toHaveBeenCalledOnce();
        expect(dependencies.reload).toHaveBeenCalledOnce();
    });

    it('holds the lease after a boot-write timeout until the late request is removed', async () => {
        let locked = false;
        let storedRequest: string | null = null;
        const lateSet = deferred();
        const release = vi.fn(() => { locked = false; });
        const acquire = vi.fn(() => {
            if (locked) return null;
            locked = true;
            return release;
        });
        const storage = {
            getItem: vi.fn(async () => storedRequest),
            removeItem: vi.fn(async () => { storedRequest = null; }),
            setItem: vi.fn()
                .mockImplementationOnce(async (_key: string, value: string) => {
                    await lateSet.promise;
                    storedRequest = value;
                })
                .mockImplementation(async (_key: string, value: string) => {
                    storedRequest = value;
                }),
        };
        const dependencies = switchDependencies({
            acquireTransitionLock: acquire,
            storage,
            transitionTimeoutMs: 20,
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('Timed out');
        expect(getWorkspaceSwitching()).toBe(false);
        expect(release).not.toHaveBeenCalled();
        expect(dependencies.reload).not.toHaveBeenCalled();
        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('already active');

        lateSet.resolve(undefined);
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
        expect(storage.removeItem).toHaveBeenCalledWith(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
        expect(storedRequest).toBeNull();

        dependencies.transitionTimeoutMs = 15_000;
        await reloadIntoMobileSandbox(dependencies);
        expect(dependencies.reload).toHaveBeenCalledOnce();
    });

    it('cleans its exact request and releases the lease when reload rejects', async () => {
        let storedRequest: string | null = null;
        const release = vi.fn();
        const storage = {
            getItem: vi.fn(async () => storedRequest),
            removeItem: vi.fn(async () => { storedRequest = null; }),
            setItem: vi.fn(async (_key: string, value: string) => { storedRequest = value; }),
        };
        const dependencies = switchDependencies({
            acquireTransitionLock: vi.fn(() => release),
            reload: vi.fn().mockRejectedValue(new Error('reload failed')),
            storage,
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('reload failed');
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
        expect(storage.removeItem).toHaveBeenCalledWith(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
        expect(storedRequest).toBeNull();
    });

    it('keeps the lease when exact request cleanup fails after reload rejects', async () => {
        let locked = false;
        let storedRequest: string | null = null;
        const release = vi.fn(() => { locked = false; });
        const acquire = vi.fn(() => {
            if (locked) return null;
            locked = true;
            return release;
        });
        const storage = {
            getItem: vi.fn(async () => storedRequest),
            removeItem: vi.fn().mockRejectedValue(new Error('remove failed')),
            setItem: vi.fn(async (_key: string, value: string) => { storedRequest = value; }),
        };
        const dependencies = switchDependencies({
            acquireTransitionLock: acquire,
            reload: vi.fn().mockRejectedValue(new Error('reload failed')),
            storage,
        });

        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('reload failed');
        await vi.waitFor(() => expect(storage.removeItem).toHaveBeenCalledOnce());
        expect(release).not.toHaveBeenCalled();
        expect(storedRequest).toBe('sandbox-request');
        await expect(reloadIntoMobileSandbox(dependencies)).rejects.toThrow('already active');
    });

    it('does not await the entry diagnostic after the final idle check', async () => {
        appLog.logInfo.mockReturnValueOnce(new Promise(() => {}));
        const dependencies = switchDependencies();

        await reloadIntoMobileSandbox(dependencies);

        expect(appLog.logInfo).toHaveBeenCalledWith(
            'Sandbox workspace entry reached idle boundary',
            {
                scope: 'sandbox',
                extra: {
                    releaseCheck: '1.3.0/sandbox-workspace',
                    stage: 'entry-idle',
                },
            },
        );
        expect(dependencies.reload).toHaveBeenCalledOnce();
    });

    it('resolves the system language before creating the sample dataset request', async () => {
        core.useTaskStore.getState.mockReturnValue({ settings: { language: 'system', theme: 'dark' } });
        core.getSystemDefaultLanguage.mockReturnValue('de');
        const dependencies = switchDependencies();

        await reloadIntoMobileSandbox(dependencies);

        expect(core.createSandboxBootRequest).toHaveBeenCalledWith(expect.objectContaining({
            language: 'de',
            theme: 'dark',
        }));
    });

    it('removes the boot request before reloading into personal data', async () => {
        core.isSandboxMode.mockReturnValue(true);
        const order: string[] = [];
        const dependencies = switchDependencies({
            flushSaves: vi.fn(async () => { order.push('flush'); }),
            reload: vi.fn(async () => { order.push('reload'); }),
            storage: {
                getItem: vi.fn(),
                setItem: vi.fn(),
                removeItem: vi.fn(async () => { order.push('remove'); }),
            },
        });

        await reloadIntoPersonalWorkspace(dependencies);
        expect(order).toEqual(['flush', 'remove', 'reload']);
    });

    it('memoizes default bootstrap so Strict Mode cannot consume twice', async () => {
        asyncStorage.getItem.mockResolvedValue(null);
        asyncStorage.removeItem.mockResolvedValue(undefined);
        core.parseSandboxBootRequest.mockReturnValue(null);

        const first = initializeMobileWorkspace();
        const second = initializeMobileWorkspace();

        expect(second).toBe(first);
        await expect(first).resolves.toEqual({ mode: 'personal' });
        expect(asyncStorage.getItem).toHaveBeenCalledTimes(1);
        expect(asyncStorage.removeItem).toHaveBeenCalledTimes(1);
        expect(core.initializeSandboxRuntime).toHaveBeenCalledTimes(1);
        expect(core.setStorageAdapter).toHaveBeenCalledWith(mobileStorage);
    });
});
