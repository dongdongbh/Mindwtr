


export const CALENDAR_PUSH_SYNC_DEBOUNCE_MS = 2500;
export const CALENDAR_PUSH_SYNC_CONCURRENCY = 4;

export type CalendarPushSchedulerOptions = {
    debounceMs?: number;
    runFull: () => Promise<void>;
    runPartial: (taskIds: string[]) => Promise<void>;

    onPartialDue?: (taskIds: string[]) => void;
};

export type CalendarPushScheduler = {

    cancelPending: () => void;

    enqueue: (run: () => Promise<void>) => Promise<void>;

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
