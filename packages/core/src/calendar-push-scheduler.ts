/**
 * Shared scheduling shell for the one-way calendar push on desktop and mobile.
 *
 * Both platforms serialize every calendar write so a full sync (fired on mount)
 * and the debounced partial sync (or two rapid manual refreshes) cannot race on
 * the check-then-create path and create duplicate events (#743). The runs
 * themselves live in `calendar-push-run.ts`; provisioning the managed calendar
 * stays platform-side.
 */
export const CALENDAR_PUSH_SYNC_DEBOUNCE_MS = 2500;
export const CALENDAR_PUSH_SYNC_CONCURRENCY = 4;

export type CalendarPushSchedulerOptions = {
    debounceMs?: number;
    runFull: () => Promise<void>;
    runPartial: (taskIds: string[]) => Promise<void>;
    /** Synchronous, nonthrowing admission notification; the owner later calls runPartial. */
    onPartialDue?: (taskIds: string[]) => void;
};

export type CalendarPushScheduler = {
    /** Drops the pending debounce without running it (store unsubscribe / stop). */
    cancelPending: () => void;
    /** Runs arbitrary calendar work on the same queue (e.g. recreating the managed calendar). */
    enqueue: (run: () => Promise<void>) => Promise<void>;
    /** Clears the queue and any pending work; for tests. */
    reset: () => void;
    runFull: () => Promise<void>;
    runPartial: (taskIds: readonly string[]) => Promise<void>;
    scheduleDebounced: (taskIds: string[]) => void;
};

export function createCalendarPushScheduler(options: CalendarPushSchedulerOptions): CalendarPushScheduler {
    const debounceMs = options.debounceMs ?? CALENDAR_PUSH_SYNC_DEBOUNCE_MS;
    const pendingTaskIds = new Set<string>();
    let queue: Promise<void> = Promise.resolve();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const enqueue = (run: () => Promise<void>): Promise<void> => {
        const next = queue.catch(() => undefined).then(run);
        queue = next.catch(() => undefined);
        return next;
    };

    const cancelPending = (): void => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        pendingTaskIds.clear();
    };

    return {
        cancelPending,
        enqueue,
        reset: () => {
            cancelPending();
            queue = Promise.resolve();
        },
        runFull: () => enqueue(options.runFull),
        runPartial: (taskIds: readonly string[]) => {
            const idsToSync = [...taskIds];
            return enqueue(() => options.runPartial(idsToSync));
        },
        scheduleDebounced: (taskIds: string[]) => {
            taskIds.forEach((id) => pendingTaskIds.add(id));
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                const idsToSync = Array.from(pendingTaskIds);
                pendingTaskIds.clear();
                if (options.onPartialDue) options.onPartialDue(idsToSync);
                else void enqueue(() => options.runPartial(idsToSync));
            }, debounceMs);
        },
    };
}
