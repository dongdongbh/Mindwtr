import type { AppSearchDoc } from './app-search-projection';
import { buildAppSearchDelta, buildFullAppSearchIndex } from './app-search-projection';
import type { Area, Project, Task } from './types';

/**
 * Orchestrates the Android AppSearch secondary index (#1017): arms a debounced
 * store subscription that keeps the disposable projection in sync with the
 * visible tasks/projects/areas, with a zero-overhead early exit whenever the
 * feature is off or unsupported. AppSearch is a mirror, not a source of
 * truth — every failure here is logged and swallowed, never surfaced as a
 * core-data error.
 *
 * Mutation-hook placement: subscribes to the same whole-store `useTaskStore`
 * used by the mobile reminder rescheduler
 * (`lib/notification-service-local.ts`), reference-comparing only the
 * `tasks`/`projects`/`areas` slices so unrelated store writes (sync status,
 * editor UI state) are free. Work is debounced so a bulk edit does one index
 * round-trip, not N.
 *
 * Moved from React Native's lib/app-search-service.ts (pass O2c): each app binds the ports (its AppSearch module, its
 * device keys, its log and its store), so React Native and the native Android app index the same way.
 */

const REINDEX_DEBOUNCE_MS = 2_000;

type IndexedState = { tasks: Task[]; projects: Project[]; areas: Area[] };

/** Each app's side. The device-key ports never reject (a key that cannot be stored only loses a retry at the next start). */
export type AppSearchIndexingPorts = {
    /** Android 12 (API 31) or later; below that nothing runs. */
    isSupported(): boolean;
    readEnabled(): Promise<boolean>;
    readWipeOwed(): Promise<boolean>;
    /** Stores that a wipe is due, before it is sent: a death or failure before it lands leaves it for the next start. */
    markWipeOwed(): Promise<void>;
    clearWipeOwed(): Promise<void>;
    upsert(docs: AppSearchDoc[]): Promise<unknown>;
    remove(ids: string[]): Promise<unknown>;
    wipe(): Promise<unknown>;
    logInfo(message: string, extra: Record<string, string>): void;
    logWarn(message: string, extra: Record<string, string>): void;
    store: {
        getState(): IndexedState;
        subscribe(listener: (state: IndexedState, prevState: IndexedState) => void): () => void;
    };
    /** Names the store listener for the notify profiler (core's nameNotifyListener). */
    nameListener<L>(name: string, listener: L): L;
    /** The link scheme a result opens; 'mindwtr' unless the build has its own. */
    scheme?: string;
};

export function createAppSearchIndexing(ports: AppSearchIndexingPorts) {
    let storeUnsubscribe: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastIndexedTasks: Task[] = [];
    let lastIndexedProjects: Project[] = [];
    let lastIndexedAreas: Area[] = [];
    const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

    const isArmed = (): boolean => storeUnsubscribe !== null;

    const applyDelta = async (prev: IndexedState, next: IndexedState): Promise<void> => {
        const delta = buildAppSearchDelta({
            prevTasks: prev.tasks,
            nextTasks: next.tasks,
            prevProjects: prev.projects,
            nextProjects: next.projects,
            prevAreas: prev.areas,
            nextAreas: next.areas,
            scheme: ports.scheme,
        });
        if (delta.upserts.length === 0 && delta.removeIds.length === 0) return;
        // Removals are the privacy-relevant half (a completed/deleted task must
        // stop appearing in system search): run both independently so a failed
        // upsert can never suppress a removal that was due in the same batch.
        const [upsertResult, removeResult] = await Promise.allSettled([
            ports.upsert(delta.upserts),
            ports.remove(delta.removeIds),
        ]);
        for (const result of [upsertResult, removeResult]) {
            if (result.status !== 'rejected') continue;
            ports.logWarn('AppSearch index update failed; local data is unaffected', { error: errorText(result.reason) });
        }
    };

    /** Arms the debounced store subscription. Idempotent and a no-op when unsupported. */
    const arm = (): void => {
        if (!ports.isSupported()) return;
        if (storeUnsubscribe) return;

        const seed = ports.store.getState();
        lastIndexedTasks = seed.tasks;
        lastIndexedProjects = seed.projects;
        lastIndexedAreas = seed.areas;

        storeUnsubscribe = ports.store.subscribe(ports.nameListener('app-search-reindex', (state: IndexedState, prevState: IndexedState) => {
            if (state.tasks === prevState.tasks && state.projects === prevState.projects && state.areas === prevState.areas) {
                return;
            }
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                const next = { tasks: state.tasks, projects: state.projects, areas: state.areas };
                const prev = { tasks: lastIndexedTasks, projects: lastIndexedProjects, areas: lastIndexedAreas };
                lastIndexedTasks = next.tasks;
                lastIndexedProjects = next.projects;
                lastIndexedAreas = next.areas;
                void applyDelta(prev, next);
            }, REINDEX_DEBOUNCE_MS);
        }));
    };

    /** Disarms the subscription without touching the native index (see `wipe` for toggle-off). */
    const disarm = (): void => {
        storeUnsubscribe?.();
        storeUnsubscribe = null;
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    };

    /**
     * Rebuilds the index from scratch: wipe, then upsert every currently
     * indexable task/project/area. Used on toggle-on and as the drift-recovery
     * strategy (called again whenever indexing is (re-)armed after being off —
     * simplest way to guarantee the on-device index matches the store after any
     * period of not observing it, at the cost of one full rewrite rather than a
     * cleverer drift-detection pass).
     */
    // Rebuilds still running: a toggle-off's wipe that lands meanwhile leaves its owed wipe owed, since this rebuild's upsert
    // lands after that wipe (enable() then wipes again, owed first).
    let rebuilding = 0;
    const runFullReindex = async (): Promise<void> => {
        if (!ports.isSupported()) return;
        const state = ports.store.getState();
        const docs = buildFullAppSearchIndex({ tasks: state.tasks, projects: state.projects, areas: state.areas, scheme: ports.scheme });
        rebuilding += 1;
        try {
            // An owed wipe stays owed: a toggle-off can land while this runs, and this upsert lands after its wipe.
            await ports.wipe();
            await ports.upsert(docs);
        } catch (error) {
            ports.logWarn('AppSearch full reindex failed; local data is unaffected', { error: errorText(error) });
        } finally {
            rebuilding -= 1;
        }
    };

    /**
     * Runs a full reindex, then arms — but only if the device-local preference
     * still reads on by the time the reindex finishes. A toggle-off landing
     * mid-reindex must win: the reindex's own upserts just repopulated the
     * index, so this re-checks and wipes again rather than leaving documents
     * behind (and a live subscription) while the setting reads OFF.
     */
    const enable = async (): Promise<void> => {
        if (!ports.isSupported()) return;
        await runFullReindex();
        if (await ports.readEnabled()) {
            arm();
            return;
        }
        // A mark that fails anyway never stops the wipe; only its retry at the next start is lost.
        await ports.markWipeOwed().catch(() => undefined);
        try {
            await ports.wipe();
            await ports.clearWipeOwed();
        } catch (error) {
            ports.logWarn('AppSearch post-toggle-off wipe failed', { error: errorText(error) });
        }
    };

    /** Wipes the native index and disarms — used when the user turns the setting off. */
    const wipe = async (): Promise<void> => {
        disarm();
        if (!ports.isSupported()) return;
        try {
            await ports.wipe();
            if (rebuilding === 0) await ports.clearWipeOwed();
        } catch (error) {
            ports.logWarn('AppSearch wipe failed', { error: errorText(error) });
        }
    };

    /**
     * Reads the persisted device-local preference and arms (with a seeding full
     * reindex) or leaves the index disarmed to match it. Safe to call from
     * multiple mount points — arming is idempotent.
     */
    const syncWithPreference = async (): Promise<void> => {
        if (!ports.isSupported()) return;
        const enabled = await ports.readEnabled();
        if (!enabled) {
            // A toggle-off whose wipe never landed: finish it now, so titles do not stay in system search.
            if (!(await ports.readWipeOwed())) return;
            let outcome = 'wiped';
            try {
                await ports.wipe();
                await ports.clearWipeOwed();
            } catch {
                outcome = 'failed';
            }
            ports.logInfo('AppSearch owed wipe finished at start', { releaseCheck: 'v1.3.7/app-search-owed-wipe', outcome });
            return;
        }
        if (isArmed()) return;
        // As turning it on: a toggle-off that lands during this reindex wins.
        await enable();
    };

    return { isArmed, arm, disarm, runFullReindex, enable, wipe, syncWithPreference };
}
