export interface SyncOrchestratorControls<Arg> {
    requestFollowUp: (nextArg?: Arg) => void;
    requestFollowUpAfter: (delayMs: number, nextArg?: Arg) => void;
}

interface CreateSyncOrchestratorOptions<Arg, Result> {
    runCycle: (arg: Arg, controls: SyncOrchestratorControls<Arg>) => Promise<Result>;
    onQueueStateChange?: (queued: boolean) => void;
    onDrained?: () => void;
    onQueuedRunComplete?: (result: Result) => void;
    onQueuedRunError?: (error: unknown) => void;
    /** Delay before a queued follow-up cycle starts, derived from how long the
     *  finished cycle took. Slow cycles (large datasets, slow storage) otherwise
     *  chain back-to-back and starve user interactions between them. */
    getFollowUpDelayMs?: (lastCycleDurationMs: number) => number;
}

export interface SyncOrchestrator<Arg, Result> {
    run: (arg: Arg) => Promise<Result>;
    requestFollowUp: (nextArg?: Arg) => void;
    requestFollowUpAfter: (delayMs: number, nextArg?: Arg) => void;
    clearFollowUp: () => void;
    reset: () => void;
    getState: () => { inFlight: boolean; queued: boolean };
}

export const createSyncOrchestrator = <Arg, Result>(
    options: CreateSyncOrchestratorOptions<Arg, Result>,
): SyncOrchestrator<Arg, Result> => {
    const { runCycle, onQueueStateChange, onDrained, onQueuedRunComplete, onQueuedRunError, getFollowUpDelayMs } = options;
    let inFlight: Promise<Result> | null = null;
    let queued = false;
    let queuedArg: Arg | undefined;
    let followUpTimer: ReturnType<typeof setTimeout> | null = null;
    let minimumFollowUpDelayMs = 0;

    const cancelFollowUpTimer = () => {
        if (followUpTimer) {
            clearTimeout(followUpTimer);
            followUpTimer = null;
        }
    };

    const setQueued = (next: boolean) => {
        if (queued === next) return;
        queued = next;
        onQueueStateChange?.(next);
    };

    const requestFollowUp = (nextArg?: Arg) => {
        if (nextArg !== undefined) queuedArg = nextArg;
        setQueued(true);
    };

    const requestFollowUpAfter = (delayMs: number, nextArg?: Arg) => {
        if (nextArg !== undefined) queuedArg = nextArg;
        minimumFollowUpDelayMs = Math.max(minimumFollowUpDelayMs, Math.max(0, Math.ceil(delayMs)));
        setQueued(true);
    };

    const clearFollowUp = () => {
        cancelFollowUpTimer();
        queuedArg = undefined;
        minimumFollowUpDelayMs = 0;
        setQueued(false);
    };

    const run = (arg: Arg): Promise<Result> => {
        if (inFlight) {
            requestFollowUp(arg);
            return inFlight;
        }

        cancelFollowUpTimer();
        setQueued(false);
        // A direct call is a newer user/system intent than the delayed request
        // waiting in queuedArg. The timer callback resolves queuedArg before it
        // calls run(), so only that callback consumes the delayed request.
        const cycleArg = arg;
        queuedArg = undefined;
        const cycleStartedAt = Date.now();

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
                requestFollowUpAfter: (delayMs: number, nextArg?: Arg) => requestFollowUpAfter(
                    delayMs,
                    nextArg ?? cycleArg,
                ),
            }).then(
                (result) => resolveDeferred(result),
                (error) => rejectDeferred(error),
            );
        } catch (error) {
            rejectDeferred(error);
        }

        // .finally() returns a derived promise that rejects with `current`'s reason
        // whenever this cycle throws. Nothing else holds onto that derived promise
        // (callers hold `current`, returned below), so an unhandled rejection would
        // fire for every failing cycle unless it's given a no-op handler here.
        current.finally(() => {
            if (inFlight !== current) return;
            inFlight = null;

            if (!queued) {
                onDrained?.();
                return;
            }

            const startQueuedRun = () => {
                followUpTimer = null;
                // A direct run() during the delay window already consumed the queue.
                if (inFlight || !queued) return;
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
            };

            const delayMs = Math.max(
                getFollowUpDelayMs?.(Date.now() - cycleStartedAt) ?? 0,
                minimumFollowUpDelayMs,
            );
            minimumFollowUpDelayMs = 0;
            if (delayMs > 0) {
                followUpTimer = setTimeout(startQueuedRun, delayMs);
                return;
            }
            startQueuedRun();
        }).catch(() => {});

        return current;
    };

    return {
        run,
        requestFollowUp,
        requestFollowUpAfter,
        clearFollowUp,
        reset: () => {
            cancelFollowUpTimer();
            inFlight = null;
            queuedArg = undefined;
            minimumFollowUpDelayMs = 0;
            setQueued(false);
        },
        getState: () => ({
            inFlight: !!inFlight,
            queued,
        }),
    };
};
