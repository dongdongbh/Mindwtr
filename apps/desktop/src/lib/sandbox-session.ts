import {
    acquireWorkspaceTransitionLock,
    createSandboxBootRequest,
    flushPendingSave,
    getPersistenceStatus,
    isSandboxMode,
    parseSandboxBootRequest,
    waitForSyncDocumentOperationsIdle,
    type AppSettings,
} from '@mindwtr/core';
import { logInfo } from './app-log';
import { isTauriRuntime } from './runtime';

export const DESKTOP_SANDBOX_BOOT_REQUEST_KEY = 'mindwtr:sandbox:boot-request:v1';
const WORKSPACE_TRANSITION_TIMEOUT_MS = 15_000;

export class DesktopSandboxBootRequestCleanupError extends Error {
    readonly reloadError: unknown;
    readonly cleanupError: unknown;

    constructor(reloadError: unknown, cleanupError: unknown) {
        super('Sandbox entry could not be cancelled safely. Restart Mindwtr before continuing.');
        this.name = 'DesktopSandboxBootRequestCleanupError';
        this.reloadError = reloadError;
        this.cleanupError = cleanupError;
    }
}

type SessionStoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type PersistenceStatus = ReturnType<typeof getPersistenceStatus>;
type DesktopSaveStatus = {
    pending: number;
    generation: number;
    failed: boolean;
    reconciliationPending: boolean;
};
type StorageIdleResult = {
    idle: boolean;
    status: DesktopSaveStatus | null;
};

type SandboxTransitionDependencies = {
    storage: SessionStoragePort;
    reload: () => void;
    flush: () => Promise<void>;
    acquireTransitionLock: () => (() => void) | null;
    waitForSyncIdle: (timeoutMs: number) => Promise<boolean>;
    isSyncIdle: () => boolean;
    waitForDocumentIdle: () => Promise<void>;
    waitForStorageIdle: (timeoutMs: number) => Promise<StorageIdleResult>;
    getStorageStatus: () => DesktopSaveStatus | null;
    getPersistenceStatus: () => PersistenceStatus;
    logEntryIdle: () => void;
    resumeWatcherAfterFailure: () => void;
    now: () => number;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
};

const defaultDependencies = (): SandboxTransitionDependencies => {
    let syncServiceModule: typeof import('./sync-service') | null = null;
    let readStorageStatus: (() => DesktopSaveStatus) | null = null;
    return {
        storage: window.sessionStorage,
        reload: () => window.location.reload(),
        flush: flushPendingSave,
        acquireTransitionLock: acquireWorkspaceTransitionLock,
        waitForSyncIdle: async (timeoutMs) => {
            syncServiceModule = await import('./sync-service');
            return syncServiceModule.SyncService.waitForSyncIdle(timeoutMs);
        },
        isSyncIdle: () => syncServiceModule?.SyncService.isSyncIdle() ?? false,
        waitForDocumentIdle: waitForSyncDocumentOperationsIdle,
        waitForStorageIdle: async (timeoutMs) => {
            if (!isTauriRuntime()) return { idle: true, status: null };
            const adapter = await import('./storage-adapter');
            readStorageStatus = adapter.getDesktopSaveStatus;
            const status = await adapter.waitForDesktopStorageIdleSnapshot(timeoutMs);
            return { idle: status !== null, status };
        },
        getStorageStatus: () => readStorageStatus?.() ?? null,
        getPersistenceStatus,
        logEntryIdle: () => {
            void logInfo('Sandbox entry reached a fully idle personal workspace', {
                scope: 'sandbox',
                force: true,
                extra: {
                    releaseCheck: '1.3.0/sandbox-workspace',
                    stage: 'entry-idle',
                },
            });
        },
        resumeWatcherAfterFailure: () => {
            void import('./local-data-watcher')
                .then(({ resumeAfterWorkspaceTransitionFailure }) => resumeAfterWorkspaceTransitionFailure())
                .catch(() => undefined);
        },
        now: () => Date.now(),
        setTimeout: globalThis.setTimeout.bind(globalThis) as typeof globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout.bind(globalThis) as typeof globalThis.clearTimeout,
    };
};

const waitWithTimeout = async (
    operation: Promise<void>,
    timeoutMs: number,
    deps: Pick<SandboxTransitionDependencies, 'setTimeout' | 'clearTimeout'>,
): Promise<void> => {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
        await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = deps.setTimeout(() => reject(new Error('Personal data is still saving.')), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== null) deps.clearTimeout(timer);
    }
};

/** Remove the one-shot request before parsing so a crash never reopens sandbox. */
export function consumeDesktopSandboxBootRequest(
    storage: SessionStoragePort = window.sessionStorage,
    now = Date.now(),
): AppSettings | null {
    let raw: string | null = null;
    try {
        raw = storage.getItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY);
        storage.removeItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY);
    } catch {
        return null;
    }
    return parseSandboxBootRequest(raw, now);
}

function storeRequestAndReload(
    settings: AppSettings,
    deps: Pick<SandboxTransitionDependencies, 'storage' | 'reload'>,
): void {
    deps.storage.setItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY, createSandboxBootRequest(settings));
    try {
        deps.reload();
    } catch (reloadError) {
        try {
            deps.storage.removeItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY);
        } catch (cleanupError) {
            throw new DesktopSandboxBootRequestCleanupError(reloadError, cleanupError);
        }
        throw reloadError;
    }
}

/** Personal entry is all-or-nothing: the request is not written until saves and sync settle. */
export async function openDesktopSandbox(
    settings: AppSettings,
    overrides: Partial<SandboxTransitionDependencies> = {},
): Promise<void> {
    if (isSandboxMode()) throw new Error('Sandbox is already open.');
    const deps = { ...defaultDependencies(), ...overrides };
    const releaseTransitionLock = deps.acquireTransitionLock();
    if (!releaseTransitionLock) throw new Error('A workspace switch is already in progress.');
    let retainTransitionLock = false;
    const deadline = deps.now() + WORKSPACE_TRANSITION_TIMEOUT_MS;
    const remainingMs = () => Math.max(0, deadline - deps.now());
    try {
        await waitWithTimeout(deps.flush(), remainingMs(), deps);
        if (!await deps.waitForSyncIdle(remainingMs())) {
            throw new Error('Sync is still finishing.');
        }
        // Existing file-watcher, import, restore, and sync document work shares
        // this lane. New document writers are rejected while the transition
        // lease is held, so the barrier drains everything admitted before it.
        await waitWithTimeout(deps.waitForDocumentIdle(), remainingMs(), deps);
        // Sync or a complete-document writer may have queued a local save after
        // the first flush. This flush runs after both lanes are fully drained.
        await waitWithTimeout(deps.flush(), remainingMs(), deps);
        const persistenceBaseline = deps.getPersistenceStatus();
        const storageIdle = await deps.waitForStorageIdle(remainingMs());
        if (!storageIdle.idle) {
            throw new Error('Personal storage is still finishing.');
        }

        // No await is allowed after these observations. Generation equality
        // catches a save admitted while the preceding native idle wait resumed.
        const finalPersistence = deps.getPersistenceStatus();
        const finalStorage = deps.getStorageStatus();
        if (finalPersistence.failed || finalStorage?.failed) {
            throw new Error('Personal data has not been saved.');
        }
        const persistenceIsIdle = finalPersistence.queued === 0
            && !finalPersistence.inFlight
            && finalPersistence.immediate === 0
            && !finalPersistence.retrying;
        if (!deps.isSyncIdle()
            || !persistenceIsIdle
            || finalPersistence.generation !== persistenceBaseline.generation) {
            throw new Error('Personal data is still saving.');
        }
        if (storageIdle.status && (
            !finalStorage
            || finalStorage.pending !== 0
            || finalStorage.reconciliationPending
            || finalStorage.generation !== storageIdle.status.generation
        )) {
            throw new Error('Personal storage is still finishing.');
        }
        if (deps.now() >= deadline) {
            throw new Error('Personal data is still saving.');
        }
        deps.logEntryIdle();
        storeRequestAndReload(settings, deps);
        retainTransitionLock = true;
    } catch (error) {
        if (error instanceof DesktopSandboxBootRequestCleanupError) {
            retainTransitionLock = true;
        }
        throw error;
    } finally {
        if (!retainTransitionLock) {
            releaseTransitionLock();
            deps.resumeWatcherAfterFailure();
        }
    }
}

export function resetDesktopSandbox(
    settings: AppSettings,
    overrides: Partial<SandboxTransitionDependencies> = {},
): void {
    if (!isSandboxMode()) throw new Error('Sandbox is not open.');
    const deps = { ...defaultDependencies(), ...overrides };
    storeRequestAndReload(settings, deps);
}

export function exitDesktopSandbox(
    overrides: Partial<Pick<SandboxTransitionDependencies, 'storage' | 'reload'>> = {},
): void {
    if (!isSandboxMode()) return;
    const defaults = defaultDependencies();
    const deps = { storage: overrides.storage ?? defaults.storage, reload: overrides.reload ?? defaults.reload };
    deps.storage.removeItem(DESKTOP_SANDBOX_BOOT_REQUEST_KEY);
    deps.reload();
}
