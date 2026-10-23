export type NotifyProfile = {
    listenerCount: number;
    timedCalls: number;
    timedTotalMs: number;
    maxMs: number;
    top5Ms: number[];
    top5Names: string[];
    /**
     * Derived-state rebuilds that ran inside this notify (getDerivedState cache
     * misses). setNotifyMs minus notifyTimedMs isolates React render time, but
     * a rebuild reached through a subscriber's SELECTOR lands in that remainder
     * too (#766) — these two numbers split it: remainder minus derivedRebuildMs
     * is genuinely React.
     */
    derivedRebuildCount: number;
    derivedRebuildMs: number;
};

type TimedEntry = {
    ms: number;
    name: string;
};

type ProfileCollection = {
    entries: TimedEntry[];
    derivedRebuildCount: number;
    derivedRebuildMs: number;
};

type InstrumentableStore = {
    subscribe: (...args: never[]) => unknown;
};

let activeListenerCount = 0;
let currentProfile: ProfileCollection | null = null;
const instrumentedStores = new WeakSet<object>();
const listenerNames = new WeakMap<object, string>();

const now = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

/**
 * Labels a store listener so slow-pipeline logs can attribute time to it by
 * name instead of an anonymous slot in `notifyTop5Ms` (#766: one ~420ms
 * subscriber stayed unidentified for a whole round). Only ever pass fixed
 * string literals — the name lands in diagnostic logs.
 */
export const nameNotifyListener = <T extends object>(name: string, listener: T): T => {
    listenerNames.set(listener, name);
    return listener;
};

const resolveListenerName = (listener: object): string => {
    const named = listenerNames.get(listener);
    if (named) return named;
    const fnName = (listener as { name?: string }).name;
    return fnName && fnName.length > 0 ? fnName : 'anonymous';
};

const timeListener = (
    listener: (...args: unknown[]) => unknown,
): ((...args: unknown[]) => unknown) =>
    function (this: unknown, ...listenerArgs: unknown[]): unknown {
        const profile = currentProfile;
        if (!profile) return listener.apply(this, listenerArgs);

        const startedAt = now();
        try {
            return listener.apply(this, listenerArgs);
        } finally {
            profile.entries.push({
                ms: now() - startedAt,
                name: resolveListenerName(listener),
            });
        }
    };

export const instrumentStoreSubscribe = <TStore extends InstrumentableStore>(
    api: TStore,
): void => {
    if (instrumentedStores.has(api)) return;

    const originalSubscribe = api.subscribe as unknown as (
        ...args: unknown[]
    ) => unknown;
    const subscribe = function (this: unknown, ...args: unknown[]): unknown {
        // Hook form is subscribe(listener); selector form is
        // subscribe(selector, listener[, options]) — time the listener in both
        // so setNotifyMs minus notifyTimedMs isolates React render time.
        let subscribeArgs = args;
        if (args.length === 1 && typeof args[0] === 'function') {
            subscribeArgs = [timeListener(args[0] as (...a: unknown[]) => unknown)];
        } else if (
            args.length >= 2
            && typeof args[0] === 'function'
            && typeof args[1] === 'function'
        ) {
            subscribeArgs = [
                args[0],
                timeListener(args[1] as (...a: unknown[]) => unknown),
                ...args.slice(2),
            ];
        }
        const unsubscribe = originalSubscribe.apply(this, subscribeArgs);
        if (typeof unsubscribe !== 'function') return unsubscribe;

        activeListenerCount += 1;
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            activeListenerCount -= 1;
            unsubscribe();
        };
    };

    api.subscribe = subscribe as TStore['subscribe'];
    instrumentedStores.add(api);
};

/** The store's live subscribers (every subscribe through an instrumented store, until it unsubscribes). */
export const getStoreListenerCount = (): number => activeListenerCount;

export const beginNotifyProfile = (): void => {
    currentProfile = { entries: [], derivedRebuildCount: 0, derivedRebuildMs: 0 };
};

/** Called by getDerivedState when a cache miss forces a rebuild. Free outside
 *  a profiling window — the accumulator only exists while one is open. */
export const recordDerivedStateRebuild = (ms: number): void => {
    const profile = currentProfile;
    if (!profile) return;
    profile.derivedRebuildCount += 1;
    profile.derivedRebuildMs += ms;
};

export const profilerNow = now;

export const endNotifyProfile = (): NotifyProfile | null => {
    const profile = currentProfile;
    if (!profile) return null;
    currentProfile = null;

    profile.entries.sort((left, right) => right.ms - left.ms);
    const top5 = profile.entries.slice(0, 5);
    return {
        listenerCount: activeListenerCount,
        timedCalls: profile.entries.length,
        timedTotalMs: profile.entries.reduce(
            (total, entry) => total + entry.ms,
            0,
        ),
        maxMs: profile.entries[0]?.ms ?? 0,
        top5Ms: top5.map((entry) => entry.ms),
        top5Names: top5.map((entry) => entry.name),
        derivedRebuildCount: profile.derivedRebuildCount,
        derivedRebuildMs: profile.derivedRebuildMs,
    };
};
