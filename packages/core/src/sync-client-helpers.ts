import { sameStoreData, storeDataOf, useTaskStore } from './store';
import { CLOUD_PROVIDER_DROPBOX } from './sync-storage-keys';
import { computeSyncChangeFingerprint } from './sync-helpers';
import { cloneAppData } from './sync-runtime-utils';
import { normalizeAppData } from './sync-normalization';
import { hasSameEntityIdentity, reconcileEntityCollection, reconcileEntityCollectionPass, reuseSettingsIfEquivalent, stripSensitiveSettings } from './store-helpers';
import { SLICE_ITEMS, type CooperativePass } from './cooperative';
import { buildLoadContext, runLoadMigrationsPass } from './store-load-migrations';
import { normalizeTaskForLoad } from './task-status';
import { normalizeProjectLifecycleFields } from './project-status';
import type { TaskStore } from './store-types';
import type { AppData, Project, Task } from './types';

export const DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CLOUD_PROVIDER_SELF_HOSTED = 'selfhosted' as const;
export { CLOUD_PROVIDER_DROPBOX } from './sync-storage-keys';
export type CloudProvider = typeof CLOUD_PROVIDER_SELF_HOSTED | typeof CLOUD_PROVIDER_DROPBOX;

/** 'stale-db': another write reached the database after this sliced cycle's read (design D9b W3/W4). */
export type LocalSyncAbortReason = 'local-data-changed' | 'stale-db' | 'remote-write-conflict';

export class LocalSyncAbort extends Error {
    readonly reason: LocalSyncAbortReason;
    /** Transport-provided context for the abort, e.g. the HTTP status a WebDAV
     *  conditional write was rejected with. Surfaced in the requeue log so a
     *  server rejecting its own ETags (mod_deflate ETag mutation) is visible. */
    readonly detail: string | null;

    constructor(reason: LocalSyncAbortReason = 'local-data-changed', detail?: string) {
        super('Local changes detected during sync');
        this.name = 'LocalSyncAbort';
        this.reason = reason;
        this.detail = detail ?? null;
    }
}


export type LocalSyncSnapshotFreshnessOptions = {
    localSnapshotChangeAt: number;
    getCurrentChangeAt: () => number;
    requestFollowUp: () => void;
    acceptCoveredSnapshot?: (currentChangeAt: number) => boolean;
    onStale?: (details: { localSnapshotChangeAt: number; currentChangeAt: number }) => void;
};

export const ensureFreshLocalSyncSnapshot = ({
    localSnapshotChangeAt,
    getCurrentChangeAt,
    requestFollowUp,
    acceptCoveredSnapshot,
    onStale,
}: LocalSyncSnapshotFreshnessOptions): number => {
    const currentChangeAt = getCurrentChangeAt();
    if (currentChangeAt <= localSnapshotChangeAt) return currentChangeAt;
    if (acceptCoveredSnapshot?.(currentChangeAt)) return currentChangeAt;

    onStale?.({ localSnapshotChangeAt, currentChangeAt });
    requestFollowUp();
    throw new LocalSyncAbort('local-data-changed');
};

export const getInMemoryAppDataSnapshot = (): AppData => {
    const state = useTaskStore.getState();
    return cloneAppData({
        tasks: state._allTasks ?? state.tasks ?? [],
        projects: state._allProjects ?? state.projects ?? [],
        sections: state._allSections ?? state.sections ?? [],
        areas: state._allAreas ?? state.areas ?? [],
        people: state._allPeople ?? state.people ?? [],
        settings: state.settings ?? {},
    });
};

/**
 * The store's collections and settings in one read, not copied: each list is a new array holding the store's records, which
 * the store replaces and never changes in place. A sliced sync cycle copies them later, a few at a time (cloneAppDataPass),
 * and still holds one consistent state.
 */
export const captureInMemoryAppDataSnapshot = (store: Pick<typeof useTaskStore, 'getState'> = useTaskStore): AppData => {
    const state = store.getState();
    return {
        tasks: [...(state._allTasks ?? state.tasks ?? [])],
        projects: [...(state._allProjects ?? state.projects ?? [])],
        sections: [...(state._allSections ?? state.sections ?? [])],
        areas: [...(state._allAreas ?? state.areas ?? [])],
        people: [...(state._allPeople ?? state.people ?? [])],
        settings: state.settings ?? {},
    };
};

/** A store publish built before the write gate (D9b W6): applySyncedDataToStore swaps it in when the store has not moved. */
export type PreparedStorePublish = {
    /** The document it publishes; any other document is computed in the gate. */
    readonly data: AppData;
    /** The store's data references it was reconciled against (storeDataOf). */
    readonly against: readonly unknown[];
    /** Only what changed: the reconciled lists that differ from the store's, and the settings when they differ. */
    readonly update: Partial<TaskStore>;
};

/**
 * Builds applySyncedDataToStore's state for [data] against the store as it is now, as a cooperative pass. Its first step
 * takes the store's references; later steps read only them, never the live store.
 */
export function* prepareSyncedDataPublishPass(
    data: AppData,
    store: Pick<typeof useTaskStore, 'getState'> = useTaskStore,
): CooperativePass<PreparedStorePublish> {
    const next = normalizeAppData(data);
    const state = store.getState();
    const against = storeDataOf(state);
    const tasks = yield* reconcileEntityCollectionPass(state._allTasks, state._tasksById, next.tasks);
    const projects = yield* reconcileEntityCollectionPass(state._allProjects, state._projectsById, next.projects);
    const sections = yield* reconcileEntityCollectionPass(state._allSections, state._sectionsById, next.sections);
    const areas = yield* reconcileEntityCollectionPass(state._allAreas, state._areasById, next.areas);
    const people = yield* reconcileEntityCollectionPass(state._allPeople, state._peopleById, next.people ?? []);
    const settings = reuseSettingsIfEquivalent(state.settings, stripSensitiveSettings(next.settings ?? state.settings));
    const update: Partial<TaskStore> = {};
    if (tasks.items !== state._allTasks) update._allTasks = tasks.items;
    if (projects.items !== state._allProjects) update._allProjects = projects.items;
    if (sections.items !== state._allSections) update._allSections = sections.items;
    if (areas.items !== state._allAreas) update._allAreas = areas.items;
    if (people.items !== state._allPeople) update._allPeople = people.items;
    if (settings !== state.settings) update.settings = settings;
    return { data, against, update };
}

/**
 * Would a load of [data] (fetchData with it preloaded, the end-of-cycle refresh) leave a store that shows [shown] as it is?
 * A cooperative pass that mirrors fetchData (store-settings.ts): it normalizes each task and project for load, keeps the
 * shown row where the normalized one has the same revision identity and the same Focus fields, and runs the load migrations
 * on the normalized document. [shown] must be the store's lists for [data]'s rows, in [data]'s order (after its publish).
 * It assumes the load reuses rows, which fetchData does not right after a recovery load (lastStoreLoadWasRecovery).
 */
export function* loadLeavesStorePass(
    data: AppData,
    shown: { tasks: readonly Task[]; projects: readonly Project[] },
): CooperativePass<boolean> {
    if (shown.tasks.length !== data.tasks.length || shown.projects.length !== data.projects.length) return false;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const tasks: Task[] = new Array(data.tasks.length);
    for (let index = 0; index < data.tasks.length; index += 1) {
        const task = normalizeTaskForLoad(data.tasks[index], nowIso);
        const kept = shown.tasks[index];
        if (!hasSameEntityIdentity(kept, task) || kept.isFocusedToday !== task.isFocusedToday || kept.focusOrder !== task.focusOrder) {
            return false;
        }
        tasks[index] = task;
        if ((index + 1) % SLICE_ITEMS === 0) yield;
    }
    const projects = data.projects.map(normalizeProjectLifecycleFields);
    if (projects.some((project, index) => !hasSameEntityIdentity(shown.projects[index], project))) return false;
    const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
    const settings = stripSensitiveSettings(rawSettings as AppData['settings']);
    const people = data.people ?? [];
    const isFreshInstall = tasks.length === 0 && projects.length === 0 && data.sections.length === 0
        && data.areas.length === 0 && people.length === 0 && Object.keys(settings).length === 0;
    const { applied } = yield* runLoadMigrationsPass(
        { tasks, projects, sections: data.sections, areas: data.areas, people, settings },
        buildLoadContext(settings, isFreshInstall, nowIso, nowMs),
    );
    return applied.length === 0;
}

/**
 * Publish a document a sync save just wrote, inside the same store write gate hold
 * (store-write-gate.ts), so the next command acts on what disk holds. Rows whose
 * revision identity did not change keep their objects, as a load does (#766).
 * A [prepared] publish of this document is swapped in when the store still holds what it was built against; else, and
 * without one, the publish is computed here. Returns true when it swapped.
 */
export const applySyncedDataToStore = (
    data: AppData,
    store: Pick<typeof useTaskStore, 'setState' | 'getState'> = useTaskStore,
    prepared?: PreparedStorePublish,
): boolean => {
    if (prepared && prepared.data === data && sameStoreData(storeDataOf(store.getState()), prepared.against)) {
        if (Object.keys(prepared.update).length > 0) store.setState(prepared.update);
        return true;
    }
    const next = normalizeAppData(data);
    store.setState((state) => ({
        _allTasks: reconcileEntityCollection(state._allTasks, state._tasksById, next.tasks).items,
        _allProjects: reconcileEntityCollection(state._allProjects, state._projectsById, next.projects).items,
        _allSections: reconcileEntityCollection(state._allSections, state._sectionsById, next.sections).items,
        _allAreas: reconcileEntityCollection(state._allAreas, state._areasById, next.areas).items,
        _allPeople: reconcileEntityCollection(state._allPeople, state._peopleById, next.people ?? []).items,
        settings: reuseSettingsIfEquivalent(state.settings, stripSensitiveSettings(next.settings ?? state.settings)),
    }));
    return false;
};

/**
 * Change fingerprint of the live store, without the deep clone
 * getInMemoryAppDataSnapshot needs — this only reads. Callers that just want to
 * know "did anything sync-worthy change" (auto-sync triggers) must use this:
 * cloning + fingerprinting the whole payload instead cost seconds per store
 * change on large Android libraries (#766).
 */
export const getInMemorySyncChangeFingerprint = (): string => {
    const state = useTaskStore.getState();
    return computeSyncChangeFingerprint({
        tasks: state._allTasks ?? state.tasks ?? [],
        projects: state._allProjects ?? state.projects ?? [],
        sections: state._allSections ?? state.sections ?? [],
        areas: state._allAreas ?? state.areas ?? [],
        people: state._allPeople ?? state.people ?? [],
        settings: state.settings ?? {},
    });
};

export const shouldRunAttachmentCleanup = (
    lastCleanupAt: string | undefined,
    intervalMs: number = DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS
): boolean => {
    if (!lastCleanupAt) return true;
    const parsed = Date.parse(lastCleanupAt);
    if (Number.isNaN(parsed)) return true;
    return Date.now() - parsed >= intervalMs;
};

export const normalizeCloudProvider = (
    value: string | null | undefined,
    options?: { allowDropbox?: boolean }
): CloudProvider => {
    const allowDropbox = options?.allowDropbox ?? true;
    return allowDropbox && value === CLOUD_PROVIDER_DROPBOX
        ? CLOUD_PROVIDER_DROPBOX
        : CLOUD_PROVIDER_SELF_HOSTED;
};

export const createAbortableFetch = (
    baseFetch: typeof fetch,
    options: { baseSignal: AbortSignal }
): typeof fetch => {
    const { baseSignal } = options;
    return (input, init) => {
        const existingSignal = (init?.signal ?? undefined) as AbortSignal | undefined;
        if (!existingSignal) {
            return baseFetch(input, { ...(init || {}), signal: baseSignal });
        }
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
            return baseFetch(input, { ...(init || {}), signal: AbortSignal.any([baseSignal, existingSignal]) });
        }

        const mergedController = new AbortController();
        let listening = false;
        const removeAbortListeners = () => {
            if (!listening) return;
            listening = false;
            baseSignal.removeEventListener('abort', abortFromBase);
            existingSignal.removeEventListener('abort', abortFromExisting);
        };
        const abortFrom = (signal: AbortSignal) => {
            if (!mergedController.signal.aborted) {
                mergedController.abort(signal.reason);
            }
            removeAbortListeners();
        };
        const abortFromBase = () => abortFrom(baseSignal);
        const abortFromExisting = () => abortFrom(existingSignal);
        if (baseSignal.aborted || existingSignal.aborted) {
            abortFrom(baseSignal.aborted ? baseSignal : existingSignal);
        } else {
            listening = true;
            baseSignal.addEventListener('abort', abortFromBase, { once: true });
            existingSignal.addEventListener('abort', abortFromExisting, { once: true });
        }
        return baseFetch(input, { ...(init || {}), signal: mergedController.signal }).then(
            (response) => {
                // Fetch resolves when response headers arrive, before its body is consumed.
                // Keep the bridge alive for body-owning callers; a cycle controller is
                // short-lived and aborts on teardown. Header-only responses can detach now.
                if (!response.body) removeAbortListeners();
                return response;
            },
            (error) => {
                removeAbortListeners();
                throw error;
            },
        );
    };
};
