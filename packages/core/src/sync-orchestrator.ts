export interface SyncOrchestratorControls<Arg> {
    requestFollowUp: (nextArg?: Arg) => void;
}

interface CreateSyncOrchestratorOptions<Arg, Result> {
    runCycle: (arg: Arg, controls: SyncOrchestratorControls<Arg>) => Promise<Result>;
    onQueueStateChange?: (queued: boolean) => void;
    onDrained?: () => void;
    onQueuedRunComplete?: (result: Result) => void;
    onQueuedRunError?: (error: unknown) => void;
}

export interface SyncOrchestrator<Arg, Result> {
    run: (arg: Arg) => Promise<Result>;
    requestFollowUp: (nextArg?: Arg) => void;
    reset: () => void;
    getState: () => { inFlight: boolean; queued: boolean };
}

export type PreSyncAttachmentBackend = 'off' | 'file' | 'webdav' | 'cloud' | 'cloudkit';
export type PreSyncAttachmentCloudProvider = 'dropbox' | 'selfhosted';
export type PreSyncAttachmentOperation<Data> = (data: Data) => Promise<boolean | Data | null | undefined>;

export interface RunPreSyncAttachmentPhaseOptions<Data> {
    backend: PreSyncAttachmentBackend;
    cloudProvider?: PreSyncAttachmentCloudProvider;
    data: Data;
    dropbox?: PreSyncAttachmentOperation<Data>;
    file?: PreSyncAttachmentOperation<Data>;
    selfHostedCloud?: PreSyncAttachmentOperation<Data>;
    webdav?: PreSyncAttachmentOperation<Data>;
    ensureNetworkStillAvailable?: () => Promise<void> | void;
}

export interface PreSyncAttachmentPhaseResult<Data> {
    data: Data | null;
    mutated: boolean;
    ran: boolean;
}

const normalizePreSyncAttachmentResult = <Data>(
    originalData: Data,
    result: boolean | Data | null | undefined
): PreSyncAttachmentPhaseResult<Data> => {
    if (result === true) {
        return { data: originalData, mutated: true, ran: true };
    }
    if (result && typeof result === 'object') {
        return { data: result, mutated: true, ran: true };
    }
    return { data: null, mutated: false, ran: true };
};

const ensureNetworkIfNeeded = async <Data>(
    operation: PreSyncAttachmentOperation<Data> | undefined,
    ensureNetworkStillAvailable: RunPreSyncAttachmentPhaseOptions<Data>['ensureNetworkStillAvailable']
): Promise<PreSyncAttachmentOperation<Data> | undefined> => {
    if (!operation) return undefined;
    await ensureNetworkStillAvailable?.();
    return operation;
};

export const runPreSyncAttachmentPhase = async <Data>(
    options: RunPreSyncAttachmentPhaseOptions<Data>
): Promise<PreSyncAttachmentPhaseResult<Data>> => {
    const { backend, cloudProvider = 'selfhosted', data } = options;
    let operation: PreSyncAttachmentOperation<Data> | undefined;

    if (backend === 'webdav') {
        operation = await ensureNetworkIfNeeded(options.webdav, options.ensureNetworkStillAvailable);
    } else if (backend === 'file') {
        operation = options.file;
    } else if (backend === 'cloud' && cloudProvider === 'selfhosted') {
        operation = await ensureNetworkIfNeeded(options.selfHostedCloud, options.ensureNetworkStillAvailable);
    } else if (backend === 'cloud' && cloudProvider === 'dropbox') {
        operation = await ensureNetworkIfNeeded(options.dropbox, options.ensureNetworkStillAvailable);
    }

    if (!operation) {
        return { data: null, mutated: false, ran: false };
    }

    return normalizePreSyncAttachmentResult(data, await operation(data));
};

export const createSyncOrchestrator = <Arg, Result>(
    options: CreateSyncOrchestratorOptions<Arg, Result>
): SyncOrchestrator<Arg, Result> => {
    const { runCycle, onQueueStateChange, onDrained, onQueuedRunComplete, onQueuedRunError } = options;
    let inFlight: Promise<Result> | null = null;
    let queued = false;
    let queuedArg: Arg | undefined;

    const setQueued = (next: boolean) => {
        if (queued === next) return;
        queued = next;
        onQueueStateChange?.(next);
    };

    const requestFollowUp = (nextArg?: Arg) => {
        if (nextArg !== undefined) queuedArg = nextArg;
        setQueued(true);
    };

    const run = (arg: Arg): Promise<Result> => {
        if (inFlight) {
            requestFollowUp(arg);
            return inFlight;
        }

        setQueued(false);
        const cycleArg = queuedArg ?? arg;
        queuedArg = undefined;

        let resolveDeferred!: (value: Result) => void;
        let rejectDeferred!: (error: unknown) => void;
        const current = new Promise<Result>((resolve, reject) => {
            resolveDeferred = resolve;
            rejectDeferred = reject;
        });
        inFlight = current;
        try {
            void runCycle(cycleArg, {
                requestFollowUp: (nextArg?: Arg) => requestFollowUp(nextArg ?? cycleArg),
            }).then(
                (result) => resolveDeferred(result),
                (error) => rejectDeferred(error),
            );
        } catch (error) {
            rejectDeferred(error);
        }

        current.finally(() => {
            if (inFlight !== current) return;
            inFlight = null;

            if (!queued) {
                onDrained?.();
                return;
            }

            const nextArg = queuedArg ?? cycleArg;
            setQueued(false);
            queuedArg = undefined;
            void run(nextArg)
                .then((result) => {
                    onQueuedRunComplete?.(result);
                })
                .catch((error) => {
                    onQueuedRunError?.(error);
                });
        });

        return current;
    };

    return {
        run,
        requestFollowUp,
        reset: () => {
            inFlight = null;
            queuedArg = undefined;
            setQueued(false);
        },
        getState: () => ({
            inFlight: !!inFlight,
            queued,
        }),
    };
};
