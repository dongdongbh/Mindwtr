import AsyncStorage from '@react-native-async-storage/async-storage';
import { reloadAppAsync } from 'expo';
import {
    acquireWorkspaceTransitionLock,
    createSandboxBootRequest,
    createSandboxData,
    createSandboxStorage,
    flushPendingSave,
    getPersistenceStatus,
    getSystemDefaultLanguage,
    initializeSandboxRuntime,
    isSandboxMode,
    LANGUAGE_STORAGE_KEY,
    parseSandboxBootRequest,
    setStorageAdapter,
    useTaskStore,
    waitForSyncDocumentOperationsIdle,
    type AppSettings,
} from '@mindwtr/core';

import {
    mobileStorage,
    quiesceMobileStorageForWorkspaceSwitch,
} from '@/lib/storage-adapter';
import { logInfo } from '@/lib/app-log';
import { seedSandboxSessionStorage } from '@/lib/workspace-session-storage';

export const MOBILE_SANDBOX_BOOT_REQUEST_KEY = '@mindwtr_sandbox_boot_request_v1';
export const MOBILE_WORKSPACE_TRANSITION_TIMEOUT_MS = 15_000;
const MOBILE_THEME_STORAGE_KEY = '@mindwtr_theme';
const PERSISTENCE_IDLE_POLL_MS = 10;

type BootRequestStorage = Pick<typeof AsyncStorage, 'getItem' | 'removeItem' | 'setItem'>;

export type MobileWorkspaceBootstrap = {
    mode: 'personal' | 'sandbox';
    requestError?: Error;
};

let mobileWorkspaceBootstrapPromise: Promise<MobileWorkspaceBootstrap> | null = null;
let workspaceSwitching = false;
const workspaceSwitchListeners = new Set<() => void>();

const setWorkspaceSwitching = (next: boolean): void => {
    if (workspaceSwitching === next) return;
    workspaceSwitching = next;
    workspaceSwitchListeners.forEach((listener) => listener());
};

export const getWorkspaceSwitching = (): boolean => workspaceSwitching;
export const subscribeWorkspaceSwitching = (listener: () => void): (() => void) => {
    workspaceSwitchListeners.add(listener);
    return () => workspaceSwitchListeners.delete(listener);
};

const asError = (value: unknown): Error => (
    value instanceof Error ? value : new Error(String(value))
);

/** Remove first, then parse. A malformed or stale request always boots personal. */
export async function consumeMobileSandboxBootRequest(
    storage: BootRequestStorage = AsyncStorage,
): Promise<{ settings: AppSettings | null; error?: Error }> {
    let raw: string | null = null;
    try {
        raw = await storage.getItem(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
        await storage.removeItem(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
    } catch (error) {
        return { settings: null, error: asError(error) };
    }
    return { settings: parseSandboxBootRequest(raw) };
}

/** Configure the one storage adapter this JS runtime will use before hydration. */
async function initializeMobileWorkspaceFromStorage(
    storage: BootRequestStorage = AsyncStorage,
): Promise<MobileWorkspaceBootstrap> {
    const request = await consumeMobileSandboxBootRequest(storage);
    if (request.settings !== null) {
        try {
            const sandboxStorage = createSandboxStorage(createSandboxData({ settings: request.settings }));
            seedSandboxSessionStorage(request.settings);
            setStorageAdapter(sandboxStorage);
            initializeSandboxRuntime(true);
            return { mode: 'sandbox' };
        } catch (error) {
            setStorageAdapter(mobileStorage);
            initializeSandboxRuntime(false);
            return { mode: 'personal', requestError: asError(error) };
        }
    }

    setStorageAdapter(mobileStorage);
    initializeSandboxRuntime(false);
    return {
        mode: 'personal',
        ...(request.error ? { requestError: request.error } : {}),
    };
}

/** Strict Mode may remount the gate; consume and initialize exactly once per JS runtime. */
export function initializeMobileWorkspace(
    storage: BootRequestStorage = AsyncStorage,
): Promise<MobileWorkspaceBootstrap> {
    if (storage !== AsyncStorage) return initializeMobileWorkspaceFromStorage(storage);
    mobileWorkspaceBootstrapPromise ??= initializeMobileWorkspaceFromStorage(storage);
    return mobileWorkspaceBootstrapPromise;
}

export type WorkspaceSwitchDependencies = {
    acquireTransitionLock: typeof acquireWorkspaceTransitionLock;
    flushSaves: typeof flushPendingSave;
    getPersistenceStatus: typeof getPersistenceStatus;
    quiescePersonalStorage: typeof quiesceMobileStorageForWorkspaceSwitch;
    waitForDocumentOperationsIdle: typeof waitForSyncDocumentOperationsIdle;
    waitForSyncIdle: () => Promise<void>;
    reload: typeof reloadAppAsync;
    storage: BootRequestStorage;
    transitionTimeoutMs: number;
};

type WorkspaceTransitionDeadline = {
    expiresAt: number;
};

class WorkspaceTransitionTimeoutError extends Error {
    constructor() {
        super('Timed out waiting for personal data activity to finish');
        this.name = 'WorkspaceTransitionTimeoutError';
    }
}

const assertBeforeDeadline = (deadline: WorkspaceTransitionDeadline): void => {
    if (Date.now() >= deadline.expiresAt) throw new WorkspaceTransitionTimeoutError();
};

/**
 * A timed-out AsyncStorage write cannot be cancelled. Keep the exclusive lease
 * until that exact write settles and its exact value is gone, so a late write
 * cannot resurrect a boot request or race a retry. Cleanup failure stays locked.
 */
const cleanOwnedBootRequestThenRelease = (
    writePromise: Promise<void>,
    request: string,
    dependencies: WorkspaceSwitchDependencies,
    releaseTransitionLock: () => void,
): void => {
    void writePromise
        .catch(() => undefined)
        .then(async () => {
            const stored = await dependencies.storage.getItem(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
            if (stored === request) {
                await dependencies.storage.removeItem(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
            } else if (stored !== null) {
                throw new Error('Sandbox boot request ownership changed during cleanup');
            }
            releaseTransitionLock();
        })
        .catch(() => {
            // Fail closed. A possibly-live request must keep the transition lease.
        });
};

const waitWithinDeadline = async <T>(
    startOperation: () => Promise<T>,
    deadline: WorkspaceTransitionDeadline,
): Promise<T> => {
    const remainingMs = deadline.expiresAt - Date.now();
    if (remainingMs <= 0) throw new WorkspaceTransitionTimeoutError();
    const operation = startOperation();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new WorkspaceTransitionTimeoutError()), remainingMs);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
};

const pauseWithinDeadline = (
    deadline: WorkspaceTransitionDeadline,
): Promise<void> => waitWithinDeadline(
    () => new Promise((resolve) => setTimeout(resolve, PERSISTENCE_IDLE_POLL_MS)),
    deadline,
);

type PersistenceStatus = ReturnType<typeof getPersistenceStatus>;

const isPersistenceIdle = (status: PersistenceStatus): boolean => (
    status.queued === 0
    && !status.inFlight
    && status.immediate === 0
    && !status.retrying
);

const assertPersistenceHealthy = (status: PersistenceStatus): void => {
    if (status.failed) throw new Error('Personal data has unsaved changes');
};

/** Flush until the read-only status is idle and remains idle for a microtask turn. */
const waitForStablePersistence = async (
    dependencies: WorkspaceSwitchDependencies,
    deadline: WorkspaceTransitionDeadline,
): Promise<number> => {
    while (true) {
        await waitWithinDeadline(() => dependencies.flushSaves(), deadline);
        const first = dependencies.getPersistenceStatus();
        assertPersistenceHealthy(first);
        if (isPersistenceIdle(first)) {
            await Promise.resolve();
            const stable = dependencies.getPersistenceStatus();
            assertPersistenceHealthy(stable);
            if (isPersistenceIdle(stable) && stable.generation === first.generation) {
                return stable.generation;
            }
        }
        await pauseWithinDeadline(deadline);
    }
};

/** An admitted sync may merge after the first flush, and its save may queue native work. */
const drainPersonalWorkspace = async (
    dependencies: WorkspaceSwitchDependencies,
    deadline: WorkspaceTransitionDeadline,
): Promise<number> => {
    await waitForStablePersistence(dependencies, deadline);
    await waitWithinDeadline(() => dependencies.waitForSyncIdle(), deadline);
    await waitWithinDeadline(() => dependencies.waitForDocumentOperationsIdle(), deadline);
    while (true) {
        const generation = await waitForStablePersistence(dependencies, deadline);
        await waitWithinDeadline(() => dependencies.quiescePersonalStorage(), deadline);
        const afterNativeDrain = dependencies.getPersistenceStatus();
        assertPersistenceHealthy(afterNativeDrain);
        if (isPersistenceIdle(afterNativeDrain) && afterNativeDrain.generation === generation) {
            return generation;
        }
        await pauseWithinDeadline(deadline);
    }
};

async function getSandboxDisplaySettings(storage: BootRequestStorage): Promise<AppSettings> {
    const settings = useTaskStore.getState().settings ?? {};
    const configuredLanguage = settings.language === 'system'
        ? getSystemDefaultLanguage()
        : settings.language;
    if (isSandboxMode() || (configuredLanguage && settings.theme)) {
        return {
            ...settings,
            ...(configuredLanguage ? { language: configuredLanguage } : {}),
        } as AppSettings;
    }

    const [storedLanguage, theme] = await Promise.all([
        settings.language ? null : storage.getItem(LANGUAGE_STORAGE_KEY),
        settings.theme ? null : storage.getItem(MOBILE_THEME_STORAGE_KEY),
    ]);
    const storedOrConfiguredLanguage = configuredLanguage ?? storedLanguage;
    const language = storedOrConfiguredLanguage === 'system'
        ? getSystemDefaultLanguage()
        : (storedOrConfiguredLanguage ?? getSystemDefaultLanguage());
    return {
        ...settings,
        ...(language ? { language } : {}),
        ...(theme ? { theme } : {}),
    } as AppSettings;
}

const defaultSwitchDependencies: WorkspaceSwitchDependencies = {
    acquireTransitionLock: acquireWorkspaceTransitionLock,
    flushSaves: flushPendingSave,
    getPersistenceStatus,
    quiescePersonalStorage: quiesceMobileStorageForWorkspaceSwitch,
    waitForDocumentOperationsIdle: waitForSyncDocumentOperationsIdle,
    waitForSyncIdle: async () => {
        const { waitForMobileSyncIdle } = await import('@/lib/sync-service');
        await waitForMobileSyncIdle();
    },
    reload: reloadAppAsync,
    storage: AsyncStorage,
    transitionTimeoutMs: MOBILE_WORKSPACE_TRANSITION_TIMEOUT_MS,
};

export async function reloadIntoMobileSandbox(
    dependencies: WorkspaceSwitchDependencies = defaultSwitchDependencies,
): Promise<void> {
    const releaseTransitionLock = dependencies.acquireTransitionLock();
    if (!releaseTransitionLock) throw new Error('Another workspace transition is already active');
    setWorkspaceSwitching(true);
    const deadline = { expiresAt: Date.now() + dependencies.transitionTimeoutMs };
    let requestWrite: Promise<void> | null = null;
    let ownedRequest: string | null = null;
    try {
        const enteringFromPersonal = !isSandboxMode();
        if (enteringFromPersonal) await drainPersonalWorkspace(dependencies, deadline);
        else await waitForStablePersistence(dependencies, deadline);

        const displaySettings = await waitWithinDeadline(
            () => getSandboxDisplaySettings(dependencies.storage),
            deadline,
        );
        const generationBeforeRequest = enteringFromPersonal
            ? await drainPersonalWorkspace(dependencies, deadline)
            : await waitForStablePersistence(dependencies, deadline);
        const request = createSandboxBootRequest(displaySettings);
        ownedRequest = request;
        assertBeforeDeadline(deadline);
        requestWrite = dependencies.storage.setItem(MOBILE_SANDBOX_BOOT_REQUEST_KEY, request);
        await waitWithinDeadline(() => requestWrite as Promise<void>, deadline);
        assertBeforeDeadline(deadline);

        if (enteringFromPersonal) {
            await waitWithinDeadline(() => dependencies.quiescePersonalStorage(), deadline);
        }
        const finalStatus = dependencies.getPersistenceStatus();
        assertPersistenceHealthy(finalStatus);
        if (!isPersistenceIdle(finalStatus) || finalStatus.generation !== generationBeforeRequest) {
            throw new Error('Personal data changed while opening the sandbox');
        }
        assertBeforeDeadline(deadline);
        if (enteringFromPersonal) {
            void logInfo('Sandbox workspace entry reached idle boundary', {
                scope: 'sandbox',
                extra: {
                    releaseCheck: '1.3.0/sandbox-workspace',
                    stage: 'entry-idle',
                },
            });
        }
        // Keep the transition lease through reload. The new JS runtime owns the next workspace.
        await dependencies.reload();
    } catch (error) {
        setWorkspaceSwitching(false);
        if (requestWrite && ownedRequest !== null) {
            cleanOwnedBootRequestThenRelease(
                requestWrite,
                ownedRequest,
                dependencies,
                releaseTransitionLock,
            );
        } else {
            releaseTransitionLock();
        }
        throw error;
    }
}

export async function reloadIntoPersonalWorkspace(
    dependencies: WorkspaceSwitchDependencies = defaultSwitchDependencies,
): Promise<void> {
    const releaseTransitionLock = dependencies.acquireTransitionLock();
    if (!releaseTransitionLock) throw new Error('Another workspace transition is already active');
    setWorkspaceSwitching(true);
    const deadline = { expiresAt: Date.now() + dependencies.transitionTimeoutMs };
    let requestRemoval: Promise<void> | null = null;
    try {
        await waitForStablePersistence(dependencies, deadline);
        assertBeforeDeadline(deadline);
        requestRemoval = dependencies.storage.removeItem(MOBILE_SANDBOX_BOOT_REQUEST_KEY);
        await waitWithinDeadline(() => requestRemoval as Promise<void>, deadline);
        assertBeforeDeadline(deadline);
        const finalStatus = dependencies.getPersistenceStatus();
        assertPersistenceHealthy(finalStatus);
        if (!isPersistenceIdle(finalStatus)) {
            throw new Error('Sandbox data changed while exiting');
        }
        await dependencies.reload();
    } catch (error) {
        setWorkspaceSwitching(false);
        if (requestRemoval) {
            void requestRemoval.then(releaseTransitionLock).catch(() => {
                // A failed removal may leave a boot request live. Keep the lease.
            });
        } else {
            releaseTransitionLock();
        }
        throw error;
    }
}
