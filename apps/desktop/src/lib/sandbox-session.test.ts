import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSandboxRuntime } from '@mindwtr/core';
import {
    consumeDesktopSandboxBootRequest,
    DESKTOP_SANDBOX_BOOT_REQUEST_KEY,
    DesktopSandboxBootRequestCleanupError,
    exitDesktopSandbox,
    openDesktopSandbox,
    resetDesktopSandbox,
} from './sandbox-session';

const makeStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        values,
    };
};

const idlePersistence = (generation = 1) => ({
    queued: 0,
    inFlight: false,
    immediate: 0,
    retrying: false,
    generation,
    failed: false,
});

const idleStorage = (generation = 1) => ({
    pending: 0,
    generation,
    failed: false,
    reconciliationPending: false,
});

type TransitionOverrides = NonNullable<Parameters<typeof openDesktopSandbox>[1]>;

const makeTransitionDependencies = (overrides: TransitionOverrides = {}) => {
    const release = vi.fn();
    return {
        release,
        dependencies: {
            storage: makeStorage(),
            reload: vi.fn(),
            flush: () => Promise.resolve(),
            acquireTransitionLock: () => release,
            waitForSyncIdle: () => Promise.resolve(true),
            isSyncIdle: () => true,
            waitForDocumentIdle: () => Promise.resolve(),
            waitForStorageIdle: () => Promise.resolve({ idle: true, status: null }),
            getStorageStatus: () => null,
            getPersistenceStatus: () => idlePersistence(),
            logEntryIdle: vi.fn(),
            resumeWatcherAfterFailure: vi.fn(),
            ...overrides,
        },
    };
};

describe('desktop sandbox session handoff', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('consumes the request before parsing and rejects invalid input', () => {
        const storage = makeStorage();
        storage.setItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY, '{invalid');
        expect(consumeDesktopSandboxBootRequest(storage)).toBeNull();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('does not request a reload when personal saves fail and releases the transition', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            flush: () => Promise.reject(new Error('save failed')),
            waitForSyncIdle: vi.fn(),
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('save failed');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('does not request a reload while sync is active', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            waitForSyncIdle: () => Promise.resolve(false),
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Sync is still finishing.');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('waits for an admitted sync before draining document work', async () => {
        let finishSync!: (idle: boolean) => void;
        const syncIdle = new Promise<boolean>((resolve) => { finishSync = resolve; });
        const events: string[] = [];
        const { dependencies } = makeTransitionDependencies({
            flush: vi.fn(async () => { events.push('flush'); }),
            waitForSyncIdle: async () => {
                events.push('sync:start');
                const idle = await syncIdle;
                events.push('sync:end');
                return idle;
            },
            waitForDocumentIdle: async () => { events.push('documents'); },
        });

        const transition = openDesktopSandbox({}, dependencies);
        await vi.waitFor(() => expect(events).toEqual(['flush', 'sync:start']));
        finishSync(true);
        await transition;
        expect(events).toEqual(['flush', 'sync:start', 'sync:end', 'documents', 'flush']);
    });

    it('writes only the shared allowlisted request after all personal work settles', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const logEntryIdle = vi.fn();
        const { dependencies, release } = makeTransitionDependencies({ storage, reload, logEntryIdle });
        await openDesktopSandbox({
            theme: 'dark',
            deviceId: 'private-device',
            network: { proxyUrl: 'https://private.example' },
        }, dependencies);
        const raw = storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY);
        expect(raw).toContain('"theme":"dark"');
        expect(raw).not.toContain('private-device');
        expect(raw).not.toContain('private.example');
        expect(logEntryIdle).toHaveBeenCalledOnce();
        expect(reload).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
    });

    it('keeps the personal session active when the post-drain flush fails', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const flush = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('merged save failed'));
        const { dependencies, release } = makeTransitionDependencies({ storage, reload, flush });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('merged save failed');
        expect(flush).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('keeps the personal session active while native storage is still finishing', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            waitForStorageIdle: () => Promise.resolve({ idle: false, status: null }),
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal storage is still finishing.');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('fails closed when a new core save is admitted after the final flush', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const getPersistenceStatus = vi.fn()
            .mockReturnValueOnce(idlePersistence(4))
            .mockReturnValueOnce(idlePersistence(5));
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            getPersistenceStatus,
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal data is still saving.');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('fails closed when core persistence is not actually idle', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const getPersistenceStatus = vi.fn()
            .mockReturnValueOnce(idlePersistence(4))
            .mockReturnValueOnce({ ...idlePersistence(4), queued: 1 });
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            getPersistenceStatus,
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal data is still saving.');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
    });

    it('fails closed when a native write begins after the native idle observation', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            waitForStorageIdle: () => Promise.resolve({ idle: true, status: idleStorage(8) }),
            getStorageStatus: () => idleStorage(9),
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal storage is still finishing.');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
    });

    it('keeps the personal session active after an exhausted save failure', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const failed = { ...idlePersistence(), failed: true };
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            getPersistenceStatus: () => failed,
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal data has not been saved.');
        expect(release).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('times out fail closed, releases the lease, and permits a retry', async () => {
        const firstRelease = vi.fn();
        const secondRelease = vi.fn();
        const acquireTransitionLock = vi.fn()
            .mockReturnValueOnce(firstRelease)
            .mockReturnValueOnce(secondRelease);
        const flush = vi.fn()
            .mockReturnValueOnce(new Promise<void>(() => undefined))
            .mockResolvedValue(undefined);
        const immediateTimeout = ((callback: TimerHandler) => {
            queueMicrotask(() => {
                if (typeof callback === 'function') callback();
            });
            return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout;
        const { dependencies } = makeTransitionDependencies({
            acquireTransitionLock,
            flush,
            setTimeout: immediateTimeout,
            clearTimeout: vi.fn() as unknown as typeof clearTimeout,
        });

        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal data is still saving.');
        expect(firstRelease).toHaveBeenCalledOnce();
        await expect(openDesktopSandbox({}, {
            ...dependencies,
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })).resolves.toBeUndefined();
        expect(secondRelease).not.toHaveBeenCalled();
    });

    it('fails closed when resolved idle gates resume at the overall deadline', async () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const logEntryIdle = vi.fn();
        let now = 0;
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload,
            logEntryIdle,
            now: () => now,
            waitForStorageIdle: async () => {
                now = 15_000;
                return { idle: true, status: null };
            },
        });

        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('Personal data is still saving.');
        expect(logEntryIdle).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
        expect(release).toHaveBeenCalledOnce();
    });

    it('rejects a competing sandbox entry before flushing personal data', async () => {
        const flush = vi.fn();
        const { dependencies } = makeTransitionDependencies({
            acquireTransitionLock: () => null,
            flush,
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('A workspace switch is already in progress.');
        expect(flush).not.toHaveBeenCalled();
    });

    it('releases the lease and removes the request when reload throws', async () => {
        const storage = makeStorage();
        const { dependencies, release } = makeTransitionDependencies({
            storage,
            reload: () => { throw new Error('reload failed'); },
        });
        await expect(openDesktopSandbox({}, dependencies)).rejects.toThrow('reload failed');
        expect(release).toHaveBeenCalledOnce();
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
    });

    it('retains the lease and does not replay watchers when a live request cannot be removed', async () => {
        const storage = makeStorage();
        const unsafeStorage = {
            ...storage,
            removeItem: () => { throw new Error('session storage unavailable'); },
        };
        const resumeWatcherAfterFailure = vi.fn();
        const { dependencies, release } = makeTransitionDependencies({
            storage: unsafeStorage,
            reload: () => { throw new Error('reload failed'); },
            resumeWatcherAfterFailure,
        });

        await expect(openDesktopSandbox({}, dependencies)).rejects.toBeInstanceOf(
            DesktopSandboxBootRequestCleanupError,
        );
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).not.toBeNull();
        expect(release).not.toHaveBeenCalled();
        expect(resumeWatcherAfterFailure).not.toHaveBeenCalled();
    });

    it('binds browser timer dependencies to the global receiver', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        const receiverSensitiveSetTimeout = (function (this: unknown, ...args: unknown[]) {
            if (this !== globalThis) throw new TypeError('Illegal invocation');
            return Reflect.apply(originalSetTimeout, globalThis, args);
        }) as typeof globalThis.setTimeout;
        const receiverSensitiveClearTimeout = (function (this: unknown, ...args: unknown[]) {
            if (this !== globalThis) throw new TypeError('Illegal invocation');
            return Reflect.apply(originalClearTimeout, globalThis, args);
        }) as typeof globalThis.clearTimeout;
        vi.stubGlobal('setTimeout', receiverSensitiveSetTimeout);
        vi.stubGlobal('clearTimeout', receiverSensitiveClearTimeout);
        const storage = makeStorage();
        const reload = vi.fn();
        const { dependencies } = makeTransitionDependencies({ storage, reload });
        try {
            await expect(openDesktopSandbox({}, dependencies)).resolves.toBeUndefined();
            expect(reload).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reset creates a fresh request and exit clears it', () => {
        initializeSandboxRuntime(true);
        const storage = makeStorage();
        const reload = vi.fn();
        resetDesktopSandbox({ theme: 'nord' }, { storage, reload });
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toContain('"theme":"nord"');
        exitDesktopSandbox({ storage, reload });
        expect(storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY)).toBeNull();
        expect(reload).toHaveBeenCalledTimes(2);
    });
});
