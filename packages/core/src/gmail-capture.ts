import { buildTaskFromEmailMessage } from './email-capture';
import { generateDeterministicUUID } from './uuid';
import { runStoreCommand } from './store-write-gate';
import type { Task } from './types';

export type GmailCaptureConfig = {
    available: boolean;
    connected: boolean;
    account: string | null;
    accountId: string | null;
    labelId: string | null;
    enabled: boolean;
};
export type GmailCaptureLabel = { id: string; name: string };
export type GmailCaptureBatch = {
    batchId: string;
    accountId: string;
    messages: Array<{ id: string; subject: string; from: string; bodyText: string }>;
    hasMore: boolean;
};
export type GmailCaptureTransport = {
    status: () => Promise<GmailCaptureConfig>;
    connect: () => Promise<GmailCaptureConfig>;
    cancel: () => Promise<void>;
    labels: () => Promise<GmailCaptureLabel[]>;
    configure: (labelId: string, enabled: boolean) => Promise<GmailCaptureConfig>;
    disconnect: () => Promise<{ revoked: boolean }>;
    poll: () => Promise<GmailCaptureBatch>;
    validate: (batchId: string) => Promise<boolean>;
    commit: (batchId: string) => Promise<void>;
};

export type GmailCaptureErrorKind = 'auth' | 'network' | 'config' | 'cancelled' | 'storage' | 'other';
export type GmailCaptureError = { kind: GmailCaptureErrorKind; message: string };
export type GmailCaptureStatus = {
    lastPollAt: string | null;
    lastImportCount: number;
    lastError: GmailCaptureError | null;
    terminal: boolean;
};

const errorMessages: Record<GmailCaptureErrorKind, string> = {
    auth: 'Reconnect Gmail to restore access.',
    network: 'Gmail is temporarily unreachable.',
    config: 'Check your Gmail label and connection.',
    cancelled: 'Gmail connection cancelled.',
    storage: 'Gmail capture could not save securely.',
    other: 'Gmail capture failed.',
};

// Never surface a provider response, URL, mailbox content, or credential in an error.
export const toGmailCaptureError = (error: unknown): GmailCaptureError => {
    const kind = error && typeof error === 'object' && 'kind' in error ? error.kind : 'other';
    const safeKind = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(errorMessages, kind)
        ? kind as GmailCaptureErrorKind
        : 'other';
    return { kind: safeKind, message: errorMessages[safeKind] };
};

export const gmailCaptureErrorTranslation = (error: GmailCaptureError): string => ({
    auth: 'settings.gmailCaptureAuthFailed',
    network: 'settings.gmailCaptureNetworkFailed',
    config: 'settings.gmailCaptureConfigFailed',
    cancelled: 'settings.gmailCaptureCancelled',
    storage: 'settings.gmailCaptureStorageFailed',
    other: 'settings.gmailCaptureFailed',
})[error.kind];

export const gmailCaptureIdFor = (accountId: string, messageId: string): string => (
    generateDeterministicUUID(`gmail-capture:${accountId}:${messageId}`)
);

export type GmailCaptureController = {
    start: () => void;
    pause: () => void;
    resume: () => void;
    pollNow: () => Promise<void>;
    invalidate: () => void;
    handleConfigChanged: () => void;
    dispose: () => void;
};

type GmailCaptureControllerOptions = {
    getConfig?: () => Promise<GmailCaptureConfig>;
    poll?: () => Promise<GmailCaptureBatch>;
    validate?: (batchId: string) => Promise<boolean>;
    commit?: (batchId: string) => Promise<void>;
    addTasks: (items: Array<{ title: string; initialProps?: Partial<Task>; captureId: string }>) => Promise<{ success: boolean; error?: string }>;
    flushPendingSave: () => Promise<void>;
    logInfo?: (message: string, extra?: Record<string, string>) => void;
    onStatusChange?: (status: GmailCaptureStatus) => void;
    now?: () => Date;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    intervalMs?: number;
    initialDelayMs?: number;
    maxRoundsPerCycle?: number;
};


export function createGmailCaptureRuntime(transport: GmailCaptureTransport) {
    const initialStatus = (): GmailCaptureStatus => ({
        lastPollAt: null, lastImportCount: 0, lastError: null, terminal: false,
    });
    let currentStatus = initialStatus();
    const statusListeners = new Set<(status: GmailCaptureStatus) => void>();
    const publishStatus = (status: GmailCaptureStatus) => {
        currentStatus = status;
        statusListeners.forEach((listener) => listener(status));
    };
    const getGmailCaptureStatus = (): GmailCaptureStatus => currentStatus;
    const subscribeGmailCaptureStatus = (listener: (status: GmailCaptureStatus) => void): (() => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
    };

    let configGeneration = 0;
    let configChanging = false;
    let activeController: GmailCaptureController | null = null;

    // Invalidate queued writes before the transport yields, including a failed change.
    const changeConfiguration = async <T>(work: () => Promise<T>): Promise<T> => {
        const generation = ++configGeneration;
        configChanging = true;
        activeController?.invalidate();
        try {
            return await work();
        } finally {
            if (generation === configGeneration) {
                configChanging = false;
                activeController?.handleConfigChanged();
            }
        }
    };
    const getGmailCaptureConfig = () => transport.status();
    const getGmailCaptureLabels = () => transport.labels();
    const connectGmailCapture = () => changeConfiguration(() => transport.connect());
    const cancelGmailCapture = () => changeConfiguration(() => transport.cancel());
    const configureGmailCapture = (labelId: string, enabled: boolean) => changeConfiguration(() => transport.configure(labelId, enabled));
    const disconnectGmailCapture = () => changeConfiguration(() => transport.disconnect());

    const createGmailCaptureController = (options: GmailCaptureControllerOptions): GmailCaptureController => {
        const getConfig = options.getConfig ?? getGmailCaptureConfig;
        const poll = options.poll ?? (() => transport.poll());
        const validate = options.validate ?? ((batchId: string) => transport.validate(batchId));
        const commit = options.commit ?? ((batchId: string) => transport.commit(batchId));
        const setTimer = options.setTimer ?? setTimeout;
        const clearTimer = options.clearTimer ?? clearTimeout;
        const now = options.now ?? (() => new Date());
        const onStatusChange = options.onStatusChange ?? publishStatus;
        let status = initialStatus();
        let timer: ReturnType<typeof setTimeout> | null = null;
        let generation = 0;
        let running = false;
        let disposed = false;
        let paused = false;

        const updateStatus = (updates: Partial<GmailCaptureStatus>) => {
            status = { ...status, ...updates };
            onStatusChange(status);
        };
        const clearScheduled = () => {
            if (timer !== null) clearTimer(timer);
            timer = null;
        };
        const schedule = (delay: number) => {
            clearScheduled();
            if (disposed || paused || configChanging) return;
            timer = setTimer(() => {
                timer = null;
                void runCycle();
            }, delay);
        };

        const runCycle = async (): Promise<void> => {
            if (disposed || paused || running || status.terminal || configChanging) return;
            running = true;
            const cycleGeneration = generation;
            const cycleConfigGeneration = configGeneration;
            const isCurrent = () => !disposed && !paused && !configChanging
                && generation === cycleGeneration && configGeneration === cycleConfigGeneration;
            try {
                const config = await getConfig();
                if (!isCurrent() || !config.available || !config.connected || !config.enabled || !config.labelId || !config.accountId) return;
                let imported = 0;
                for (let round = 0; round < (options.maxRoundsPerCycle ?? 10); round += 1) {
                    // Network fetches stay outside the store writer gate.
                    const batch = await poll();
                    if (!isCurrent() || batch.accountId !== config.accountId) return;
                    const saved = await runStoreCommand(async () => {
                        if (!isCurrent()) return false;
                        const valid = await validate(batch.batchId);
                        if (!isCurrent() || !valid) return false;
                        if (batch.messages.length > 0) {
                            const items = batch.messages.map((message) => {
                                const { title, description } = buildTaskFromEmailMessage(message);
                                return {
                                    title,
                                    initialProps: { status: 'inbox' as const, ...(description ? { description } : {}) },
                                    captureId: gmailCaptureIdFor(batch.accountId, message.id),
                                };
                            });
                            const added = await options.addTasks(items);
                            if (!added.success) throw { kind: 'storage' };
                            // Once admitted, finish persistence even if the connection changes mid-save.
                            try {
                                await options.flushPendingSave();
                            } catch {
                                throw { kind: 'storage' };
                            }
                        }
                        return true;
                    });
                    if (!saved || !isCurrent()) return;
                    await commit(batch.batchId);
                    if (!isCurrent()) return;
                    imported += batch.messages.length;
                    if (batch.messages.length > 0) {
                        options.logInfo?.('Gmail capture imported messages', {
                            releaseCheck: 'v1.3.7/gmail-capture', count: String(batch.messages.length),
                        });
                    }
                    if (!batch.hasMore) break;
                }
                updateStatus({ lastPollAt: now().toISOString(), lastImportCount: imported, lastError: null, terminal: false });
            } catch (error) {
                if (!isCurrent()) return;
                const info = toGmailCaptureError(error);
                updateStatus({
                    lastPollAt: now().toISOString(), lastError: info,
                    terminal: info.kind === 'auth' || info.kind === 'config',
                });
            } finally {
                running = false;
                if (!disposed && !paused && !status.terminal && !configChanging && timer === null) {
                    schedule(isCurrent() ? (options.intervalMs ?? 5 * 60 * 1000) : 1_000);
                }
            }
        };

        const invalidate = () => {
            generation += 1;
            clearScheduled();
            updateStatus({ lastError: null, terminal: false });
        };
        return {
            start: () => schedule(options.initialDelayMs ?? 20_000),
            pause: () => {
                paused = true;
                generation += 1;
                clearScheduled();
            },
            resume: () => {
                if (disposed) return;
                paused = false;
                if (!status.terminal) schedule(1_000);
            },
            pollNow: runCycle,
            invalidate,
            handleConfigChanged: () => {
                invalidate();
                schedule(1_000);
            },
            dispose: () => {
                disposed = true;
                invalidate();
            },
        };
    };

    const registerGmailCaptureController = (controller: GmailCaptureController | null) => {
        activeController = controller;
    };
    const pollGmailCaptureNow = async (): Promise<void> => { await activeController?.pollNow(); };

    return {
        getGmailCaptureConfig, getGmailCaptureLabels, connectGmailCapture, cancelGmailCapture,
        configureGmailCapture, disconnectGmailCapture, getGmailCaptureStatus, subscribeGmailCaptureStatus,
        createGmailCaptureController, registerGmailCaptureController, pollGmailCaptureNow,
    };
}
