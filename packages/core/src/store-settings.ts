import { logInfo, logWarn } from './logger';
import { summarizeTaskLifecycleCounts } from './task-utils';
import { markCoreStartupPhase, measureCoreStartupPhase } from './startup-profiler';
import { normalizeTaskForLoad } from './task-status';
import type { StorageAdapter } from './storage';
import type { AppData } from './types';
import type { DerivedCache, TaskStore } from './store-types';
import {
    computeProjectDerivedState,
    computeTaskDerivedState,
    ensureDeviceId,
    getNextDataChangeAt,
    normalizeAiSettingsForSync,
    persist,
    reconcileEntityCollection,
    reuseArrayIfShallowEqual,
    reuseSettingsIfEquivalent,
    selectFocusedCount,
    selectVisibleAreas,
    selectVisiblePeople,
    selectVisibleProjects,
    selectVisibleSections,
    selectVisibleTasks,
    stripSensitiveSettings,
    withTimeout,
} from './store-helpers';
import { SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS } from './sync-helpers';
import { getGtdSyncSnapshot } from './settings-options';
import { DEFAULT_TOMBSTONE_RETENTION_DAYS, purgeExpiredTombstones } from './sync-tombstones';
import { buildLoadContext, runAutoArchive, runLoadMigrations } from './store-load-migrations';
import { createSeedGettingStartedAction } from './getting-started-seed';
import { beginNotifyProfile, endNotifyProfile, profilerNow, recordDerivedStateRebuild, type NotifyProfile } from './store-notify-profiler';

const STORAGE_TIMEOUT_MS = 15_000;
// Runtime diagnostic threshold: loads slower than this get a phase-breakdown log line.
const SLOW_FETCH_LOG_THRESHOLD_MS = 1_000;
const getFetchDataErrorMessage = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = detail.trim();
    if (!trimmed) return 'Failed to fetch data';
    if (/timed out/i.test(trimmed)) return 'Storage request timed out. Try again.';
    return `Failed to fetch data: ${trimmed}`;
};
const NON_MUTATING_SETTINGS_KEYS = new Set<keyof AppData['settings']>(SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS);

let derivedCache: DerivedCache | null = null;

export const clearDerivedCache = () => {
    derivedCache = null;
};

let documentReplacementPending = false;

/**
 * Declares that the next load reads a document the caller just persisted in
 * full (Restore Backup, import apply). Such a document is authoritative and may
 * legitimately share no ids with what the store still holds, so its load guard
 * checks only that the migrations kept every row — unlike an ordinary load,
 * where missing live rows mean a bad or truncated storage read.
 */
export const markNextLoadAsDocumentReplacement = (): void => {
    documentReplacementPending = true;
};

const consumeDocumentReplacementMark = (): boolean => {
    const pending = documentReplacementPending;
    documentReplacementPending = false;
    return pending;
};

const settingsValueChanged = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);

const mergeSettingsUpdates = (
    settings: AppData['settings'],
    updates: Partial<AppData['settings']>
): AppData['settings'] => {
    const nextSettings = { ...settings, ...updates };
    if (Object.prototype.hasOwnProperty.call(updates, 'appearance')) {
        const appearanceUpdate = updates.appearance;
        nextSettings.appearance = appearanceUpdate && typeof appearanceUpdate === 'object'
            ? { ...(settings.appearance ?? {}), ...appearanceUpdate }
            : appearanceUpdate;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'network')) {
        const networkUpdate = updates.network;
        nextSettings.network = networkUpdate && typeof networkUpdate === 'object'
            ? { ...(settings.network ?? {}), ...networkUpdate }
            : networkUpdate;
    }
    return nextSettings;
};

const shouldTrackSettingsChange = (
    previous: AppData['settings'],
    next: AppData['settings'],
    updates: Partial<AppData['settings']>
): boolean => {
    const trackedKeys = Object.keys(updates)
        .filter((key) => !NON_MUTATING_SETTINGS_KEYS.has(key as keyof AppData['settings'])) as Array<keyof AppData['settings']>;
    if (trackedKeys.length === 0) return false;
    return trackedKeys.some((key) => settingsValueChanged(previous[key], next[key]));
};

type SettingsActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    flushPendingSave: () => Promise<void>;
    hasPendingSaveWork: () => boolean;
    getSaveGeneration: () => number;
    getStorage: () => StorageAdapter;
};

type SettingsActions = Pick<TaskStore, 'fetchData' | 'seedGettingStarted' | 'updateSettings' | 'persistSnapshot' | 'getDerivedState' | 'getFocusedCount' | 'setHighlightTask'>;

export const createSettingsActions = ({
    set,
    get,
    debouncedSave,
    flushPendingSave,
    hasPendingSaveWork,
    getSaveGeneration,
    getStorage,
}: SettingsActionContext): SettingsActions => ({
    seedGettingStarted: createSeedGettingStartedAction(set, debouncedSave, flushPendingSave),

    /**
     * Fetch all data from the configured storage adapter.
     * Stores full data internally, filters for UI display.
     */
    fetchData: async (options) => {
        markCoreStartupPhase('core.fetch_data.start');
        // Consumed at entry so a fetch already in flight keeps its own answer.
        const isDocumentReplacement = consumeDocumentReplacementMark();
        const fetchInvokedAt = Date.now();
        const isResultStillRelevant = options?.isResultStillRelevant ?? (() => true);
        const finishIrrelevantFetch = () => {
            markCoreStartupPhase('core.fetch_data.skipped_irrelevant');
            if (!options?.silent) {
                set((state) => state.isLoading ? { isLoading: false } : state);
            }
        };
        let flushMs = 0;
        let storageReadMs = 0;
        let setStateMs = 0;
        if (hasPendingSaveWork()) {
            const flushStartedAt = Date.now();
            await measureCoreStartupPhase('core.fetch_data.flush_pending_save', async () => {
                await flushPendingSave();
            });
            flushMs = Date.now() - flushStartedAt;
        } else {
            markCoreStartupPhase('core.fetch_data.flush_pending_save.skipped', { reason: 'no_pending_work' });
        }
        const saveGenerationAtFetchStart = getSaveGeneration();
        if (!isResultStillRelevant()) {
            finishIrrelevantFetch();
            return;
        }
        if (options?.silent) {
            set((state) => state.error === null ? state : { error: null });
        } else {
            set((state) => state.isLoading && state.error === null
                ? state
                : { isLoading: true, error: null });
        }
        if (get().editLockCount > 0) {
            if (!options?.silent) {
                set({ isLoading: false });
            }
            logWarn('Skipped fetch while edits are in progress', {
                scope: 'store',
                category: 'storage',
                context: { editLockCount: get().editLockCount },
            });
            return;
        }
        const fetchStartedAt = get().lastDataChangeAt;
        try {
            // A preloaded snapshot must already be durably persisted (e.g. the merged
            // document sync just wrote); it skips the storage read but runs the exact
            // same load pipeline, and the lastDataChangeAt guard below still discards
            // it if local edits landed in the meantime.
            const storageReadStartedAt = Date.now();
            const sourceStorage = options?.preloadedData ? undefined : getStorage();
            const data = options?.preloadedData
                ?? await measureCoreStartupPhase('core.fetch_data.storage_get_data', async () =>
                    withTimeout(sourceStorage!.getData(), STORAGE_TIMEOUT_MS, 'Storage request timed out')
                );
            if (!isResultStillRelevant()) {
                finishIrrelevantFetch();
                return;
            }
            storageReadMs = options?.preloadedData ? 0 : Date.now() - storageReadStartedAt;
            const postProcessStartedAt = Date.now();
            markCoreStartupPhase('core.fetch_data.post_process:start');
            const nowIso = new Date().toISOString();
            const nowMs = Date.now();
            const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
            const rawProjects = Array.isArray(data.projects) ? data.projects : [];
            const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
            const rawSections = Array.isArray((data as AppData).sections) ? (data as AppData).sections : [];
            const rawAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            const rawPeople = Array.isArray((data as AppData).people) ? (data as AppData).people ?? [] : [];
            const settings = stripSensitiveSettings(rawSettings as AppData['settings']);
            const isFreshInstall =
                rawTasks.length === 0 &&
                rawProjects.length === 0 &&
                rawSections.length === 0 &&
                rawAreas.length === 0 &&
                rawPeople.length === 0 &&
                Object.keys(settings).length === 0;

            // normalizeTaskForLoad is a per-load status/date/shape normalizer, not a
            // migration: it always runs and never itself is a reason to persist,
            // same as `stripSensitiveSettings` above. Loading data never mutates it
            // for persistence purposes — only the explicit one-time passes below do.
            const normalizedTasks = rawTasks.map((task) => normalizeTaskForLoad(task, nowIso));

            const loadContext = buildLoadContext(settings, isFreshInstall, nowIso, nowMs);
            const initialData: AppData = {
                tasks: normalizedTasks,
                projects: rawProjects,
                sections: rawSections,
                areas: rawAreas,
                people: rawPeople,
                settings,
            };
            const { data: migratedData, applied } = runLoadMigrations(initialData, loadContext);
            const allTasks = migratedData.tasks;
            const allProjects = migratedData.projects;
            const allSections = migratedData.sections;
            const allAreas = migratedData.areas;
            const allPeople = migratedData.people ?? [];
            const nextSettings = migratedData.settings;

            const postProcessMs = Date.now() - postProcessStartedAt;
            markCoreStartupPhase('core.fetch_data.post_process:end', { durationMs: postProcessMs });
            let skippedDueToConcurrentLocalChange = false;
            let setProducerMs = 0;
            let tasksReplaced = 0;
            let projectsReplaced = 0;
            let attachmentOnlyTasksReplaced = 0;
            let settingsReused = false;
            let visibleTasksReused = false;
            let stateUpdateSkipped = false;
            let resultAccepted = false;
            const setStateStartedAt = Date.now();
            const notifyProfilingEnabled = nextSettings?.diagnostics?.loggingEnabled === true;
            let notifyProfile: NotifyProfile | null = null;
            if (notifyProfilingEnabled) beginNotifyProfile();
            try {
                await measureCoreStartupPhase('core.fetch_data.zustand_set_state', async () => {
                    set((state) => {
                        const producerStartedAt = Date.now();
                        if (!isResultStillRelevant()) {
                            stateUpdateSkipped = true;
                            setProducerMs = Date.now() - producerStartedAt;
                            return state;
                        }
                        resultAccepted = true;
                        if (state.lastDataChangeAt > fetchStartedAt) {
                            skippedDueToConcurrentLocalChange = true;
                            setProducerMs = Date.now() - producerStartedAt;
                            return options?.silent || !state.isLoading ? state : { isLoading: false };
                        }
                        const nextTasks = reconcileEntityCollection(state._allTasks, state._tasksById, allTasks);
                        const nextProjects = reconcileEntityCollection(state._allProjects, state._projectsById, allProjects);
                        const nextSections = reconcileEntityCollection(state._allSections, state._sectionsById, allSections);
                        const nextAreas = reconcileEntityCollection(state._allAreas, state._areasById, allAreas);
                        const nextPeople = reconcileEntityCollection(state._allPeople, state._peopleById, allPeople);
                        const visibleTasks = reuseArrayIfShallowEqual(state.tasks, selectVisibleTasks(nextTasks.items));
                        const visibleProjects = reuseArrayIfShallowEqual(state.projects, selectVisibleProjects(nextProjects.items));
                        const visibleSections = reuseArrayIfShallowEqual(state.sections, selectVisibleSections(nextSections.items));
                        const visibleAreas = reuseArrayIfShallowEqual(state.areas, selectVisibleAreas(nextAreas.items));
                        const visiblePeople = reuseArrayIfShallowEqual(state.people, selectVisiblePeople(nextPeople.items));
                        const settingsForState = reuseSettingsIfEquivalent(state.settings, nextSettings);
                        tasksReplaced = nextTasks.replacedCount;
                        projectsReplaced = nextProjects.replacedCount;
                        attachmentOnlyTasksReplaced = nextTasks.attachmentOnlyReplacedCount;
                        settingsReused = settingsForState === state.settings;
                        visibleTasksReused = visibleTasks === state.tasks;
                        const nextLastDataChangeAt = applied.length > 0
                            ? getNextDataChangeAt(state.lastDataChangeAt)
                            : state.lastDataChangeAt;
                        if (
                            visibleTasks === state.tasks
                            && visibleProjects === state.projects
                            && visibleSections === state.sections
                            && visibleAreas === state.areas
                            && visiblePeople === state.people
                            && settingsForState === state.settings
                            && nextTasks.items === state._allTasks
                            && nextProjects.items === state._allProjects
                            && nextSections.items === state._allSections
                            && nextAreas.items === state._allAreas
                            && nextPeople.items === state._allPeople
                            && nextTasks.byId === state._tasksById
                            && nextProjects.byId === state._projectsById
                            && nextSections.byId === state._sectionsById
                            && nextAreas.byId === state._areasById
                            && nextPeople.byId === state._peopleById
                            && state.isLoading === false
                            && nextLastDataChangeAt === state.lastDataChangeAt
                        ) {
                            stateUpdateSkipped = true;
                            setProducerMs = Date.now() - producerStartedAt;
                            return state;
                        }
                        if (applied.length > 0) {
                            // Baseline for the partial-snapshot guard. Normally it is the
                            // pre-load store, so a bad or truncated storage read cannot be
                            // saved over live rows. After a caller-declared full replace
                            // (Restore Backup) the new document is authoritative and shares
                            // no ids with the store, so there the guard only has to prove
                            // the migrations kept every row the document arrived with.
                            //
                            // Tombstone GC ('purge-expired-tombstones', applied above via
                            // runLoadMigrations) legitimately shrinks these collections
                            // once a day. Run the identical age-based cleanup on the
                            // baseline so the partial-snapshot guard compares like for
                            // like instead of tripping on that expected GC shrink (it
                            // would otherwise fail every load on the day it runs).
                            //
                            // DEFAULT_TOMBSTONE_RETENTION_DAYS is passed explicitly (matching
                            // purgeExpiredTombstonesMigration's own implicit default) rather
                            // than left to purgeExpiredTombstones' internal fallback: the
                            // sync-merge path threads a configurable io.tombstoneRetentionDays
                            // (sync.ts) instead of the default. If the load-migration path ever
                            // grows the same knob, this explicit constant is what a grep for
                            // DEFAULT_TOMBSTONE_RETENTION_DAYS turns up as the thing to update.
                            //
                            // `settings` is omitted from the input (passed as `{}`) because
                            // only .tasks/.projects/.sections/.areas/.people below are read --
                            // the pruned settings purgeExpiredTombstones would otherwise compute
                            // (savedFilters/pendingRemoteDeletes) are unused here.
                            const guardBaseline = isDocumentReplacement
                                ? initialData
                                : {
                                    tasks: state._allTasks,
                                    projects: state._allProjects,
                                    sections: state._allSections,
                                    areas: state._allAreas,
                                    people: state._allPeople,
                                };
                            const gcReference = purgeExpiredTombstones(
                                {
                                    tasks: guardBaseline.tasks,
                                    projects: guardBaseline.projects,
                                    sections: guardBaseline.sections,
                                    areas: guardBaseline.areas,
                                    people: guardBaseline.people ?? [],
                                    settings: {},
                                },
                                nowIso,
                                DEFAULT_TOMBSTONE_RETENTION_DAYS
                            ).data;
                            persist(set, debouncedSave, {
                                _allTasks: gcReference.tasks,
                                _allProjects: gcReference.projects,
                                _allSections: gcReference.sections,
                                _allAreas: gcReference.areas,
                                _allPeople: gcReference.people ?? [],
                                settings: state.settings,
                            }, {
                                tasks: nextTasks.items,
                                projects: nextProjects.items,
                                sections: nextSections.items,
                                areas: nextAreas.items,
                                people: nextPeople.items,
                                settings: nextSettings,
                            });
                            markCoreStartupPhase('core.fetch_data.debounced_save_enqueued');
                        }
                        setProducerMs = Date.now() - producerStartedAt;
                        return {
                            settings: settingsForState,
                            _allTasks: nextTasks.items,
                            _allProjects: nextProjects.items,
                            _allSections: nextSections.items,
                            _allAreas: nextAreas.items,
                            _allPeople: nextPeople.items,
                            isLoading: false,
                            lastDataChangeAt: nextLastDataChangeAt,
                        };
                    });
                });
            } finally {
                if (notifyProfilingEnabled) notifyProfile = endNotifyProfile();
            }
            setStateMs = Date.now() - setStateStartedAt;
            if (!resultAccepted) {
                finishIrrelevantFetch();
                return;
            }
            const totalFetchMs = Date.now() - fetchInvokedAt;
            // Proves the #1136 fix actually fired: a task whose attachments changed
            // (another device deleted or updated one) without the task's own
            // revision/tombstone fields changing was replaced in the in-memory
            // store instead of stale-cached, so this load's post-load persist
            // writes the current attachments instead of overwriting them right
            // back. One line per store load (never per task) — this branch can
            // fire on every idle load once a peer starts touching attachments.
            if (attachmentOnlyTasksReplaced > 0) {
                logInfo('Sync store reconcile replaced tasks for an attachment-only change', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        releaseCheck: 'v1.2.8/attachment-only-task-replace',
                        entity: 'task',
                        count: attachmentOnlyTasksReplaced,
                    },
                });
            }
            // Runtime diagnostic for shared beta logs: break the load pipeline down so a
            // slow refresh can be attributed to save-flush, storage read, or JS processing.
            if (totalFetchMs >= SLOW_FETCH_LOG_THRESHOLD_MS) {
                // Content-free lifecycle breakdown: taskCount counts the whole
                // stored array, which reads far higher than what the app shows
                // once sync tombstones accumulate — log the composition so a
                // shared log can attribute counts and growth directly (#766).
                const lifecycle = summarizeTaskLifecycleCounts(allTasks);
                logInfo('Slow data load pipeline', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        totalMs: totalFetchMs,
                        flushMs,
                        storageReadMs,
                        postProcessMs,
                        setStateMs,
                        // setStateMs = producer (reconcile + visibility filtering)
                        // + notify (store subscribers, incl. synchronous React
                        // re-renders). The split plus the reuse flags attribute a
                        // slow refresh to recompute vs re-render storm (#766).
                        setProducerMs,
                        setNotifyMs: Math.max(0, setStateMs - setProducerMs),
                        ...(notifyProfile ? {
                            notifyListenerCount: String(notifyProfile.listenerCount),
                            notifyTimedCalls: String(notifyProfile.timedCalls),
                            notifyTimedMs: String(Math.round(notifyProfile.timedTotalMs)),
                            notifyMaxMs: String(Math.round(notifyProfile.maxMs)),
                            notifyTop5Ms: notifyProfile.top5Ms.map(Math.round).join(','),
                            notifyTop5Names: notifyProfile.top5Names.join(','),
                            notifyDerivedRebuilds: String(notifyProfile.derivedRebuildCount),
                            notifyDerivedRebuildMs: String(Math.round(notifyProfile.derivedRebuildMs)),
                        } : {}),
                        tasksReplaced,
                        projectsReplaced,
                        settingsReused,
                        visibleTasksReused,
                        stateUpdateSkipped,
                        preloaded: Boolean(options?.preloadedData),
                        taskCount: allTasks.length,
                        liveTasks: lifecycle.live,
                        trashedTasks: lifecycle.trashed,
                        tombstoneTasks: lifecycle.tombstones,
                        tasksCreatedLast7d: lifecycle.createdLast7d,
                        skippedByLocalChange: skippedDueToConcurrentLocalChange,
                    },
                });
            }
            if (skippedDueToConcurrentLocalChange) {
                markCoreStartupPhase('core.fetch_data.skipped_local_change');
                logWarn('Skipped fetch result because local data changed during fetch', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        fetchStartedAt,
                        currentChangeAt: get().lastDataChangeAt,
                    },
                });
                return;
            }

            // Storage may quarantine writes until the foreground store has
            // replaced a potentially stale snapshot. Only acknowledge the exact
            // object returned by this direct read after it was actually applied;
            // preloaded/background sync snapshots do not prove that lineage.
            // Deliberately count every full-snapshot enqueue, including a load
            // migration. That can require one more clean reload, but releasing a
            // recovery barrier while an unacknowledged snapshot is queued could
            // let that save erase the data the reload just recovered.
            if (getSaveGeneration() === saveGenerationAtFetchStart) {
                sourceStorage?.acknowledgeDataLoad?.(data);
            }

            markCoreStartupPhase('core.fetch_data.end');
        } catch (err) {
            if (!isResultStillRelevant()) {
                finishIrrelevantFetch();
                return;
            }
            markCoreStartupPhase('core.fetch_data.error');
            set({ error: getFetchDataErrorMessage(err), isLoading: false });
            if (options?.throwOnError) throw err;
        }
    },

    /**
     * Update application settings.
     * @param updates Settings to update
     */
    updateSettings: async (updates: Partial<AppData['settings']>) => {
        // A store that never loaded a document has no device identity yet.
        // Persisting from it would enqueue a snapshot of the empty in-memory
        // state, which the pre-load save flush then writes over the on-disk
        // document (#852). Apply the update in memory only and let the first
        // load win; callers that still need the change re-apply after load.
        if (!get().settings.deviceId) {
            set((state) => ({ settings: mergeSettingsUpdates(state.settings, updates) }));
            logWarn('Skipped settings persistence before initial data load', {
                scope: 'store',
                category: 'storage',
                context: { keys: Object.keys(updates).join(',') },
            });
            return;
        }
        const archiveDaysUpdate = updates.gtd?.autoArchiveDays !== undefined;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const nowIso = new Date().toISOString();
            const nextSettings = mergeSettingsUpdates(deviceState.settings, updates);
            const nextSyncUpdatedAt = { ...(deviceState.settings.syncPreferencesUpdatedAt ?? {}) };
            let syncUpdated = false;

            const markSyncUpdated = (key: keyof NonNullable<AppData['settings']['syncPreferencesUpdatedAt']>) => {
                nextSyncUpdatedAt[key] = nowIso;
                syncUpdated = true;
            };

            if ('syncPreferences' in updates) {
                markSyncUpdated('preferences');
            }

            if ('theme' in updates || 'appearance' in updates || 'keybindingStyle' in updates) {
                markSyncUpdated('appearance');
            }

            if ('language' in updates || 'weekStart' in updates || 'dateFormat' in updates || 'timeFormat' in updates) {
                markSyncUpdated('language');
            }

            if (settingsValueChanged(
                getGtdSyncSnapshot(deviceState.settings),
                getGtdSyncSnapshot(nextSettings),
            )) {
                markSyncUpdated('gtd');
            }

            if ('externalCalendars' in updates) {
                markSyncUpdated('externalCalendars');
            }

            if ('savedFilters' in updates) {
                markSyncUpdated('savedFilters');
            }

            if ('ai' in updates) {
                const prevAi = normalizeAiSettingsForSync(deviceState.settings.ai);
                const nextAi = normalizeAiSettingsForSync(nextSettings.ai);
                if (JSON.stringify(prevAi ?? null) !== JSON.stringify(nextAi ?? null)) {
                    markSyncUpdated('ai');
                }
            }

            const newSettings = syncUpdated ? { ...nextSettings, syncPreferencesUpdatedAt: nextSyncUpdatedAt } : nextSettings;
            const shouldTrackChange = shouldTrackSettingsChange(state.settings, newSettings, updates);
            if (archiveDaysUpdate) {
                const autoArchiveResult = runAutoArchive(state._allTasks, newSettings, {
                    nowIso,
                    nowMs: Date.now(),
                    deviceId: deviceState.deviceId,
                });

                if (autoArchiveResult.didAutoArchive) {
                    persist(set, debouncedSave, state, { tasks: autoArchiveResult.allTasks, settings: newSettings });
                    return {
                        _allTasks: autoArchiveResult.allTasks,
                        settings: newSettings,
                        lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt),
                    };
                }
            }

            persist(set, debouncedSave, state, { settings: newSettings });
            return {
                settings: newSettings,
                lastDataChangeAt: shouldTrackChange ? getNextDataChangeAt(state.lastDataChangeAt) : state.lastDataChangeAt,
            };
        });
    },

    persistSnapshot: async () => {
        set((state) => {
            persist(set, debouncedSave, state);
            return {};
        });
    },

    getDerivedState: () => {
        const state = get();
        if (
            derivedCache
            && derivedCache.visibleTasksRef === state.tasks
            && derivedCache.taskLookupRef === state._tasksById
            && derivedCache.projectLookupRef === state._projectsById
        ) {
            return derivedCache.value;
        }
        const rebuildStartedAt = profilerNow();
        const previous = derivedCache?.value;
        const taskDerived =
            derivedCache
                && derivedCache.visibleTasksRef === state.tasks
                && derivedCache.taskLookupRef === state._tasksById
                && previous
                ? {
                    tasksById: previous.tasksById,
                    activeTasksByStatus: previous.activeTasksByStatus,
                    tasksByProjectId: previous.tasksByProjectId,
                    tasksByContext: previous.tasksByContext,
                    tasksByTag: previous.tasksByTag,
                    focusedTasks: previous.focusedTasks,
                    projectTaskSummaryById: previous.projectTaskSummaryById,
                    allContexts: previous.allContexts,
                    allTags: previous.allTags,
                    contextTokenUsage: previous.contextTokenUsage,
                    tagTokenUsage: previous.tagTokenUsage,
                    dateCoherenceIssuesByTaskId: previous.dateCoherenceIssuesByTaskId,
                    focusedCount: previous.focusedCount,
                }
                : computeTaskDerivedState(state.tasks, state._tasksById);
        const projectDerived =
            derivedCache && derivedCache.projectLookupRef === state._projectsById && previous
                ? {
                    projectMap: previous.projectMap,
                    sequentialProjectIds: previous.sequentialProjectIds,
                    sequentialWithinSectionProjectIds: previous.sequentialWithinSectionProjectIds,
                    focusedProjectCount: previous.focusedProjectCount,
                }
                : computeProjectDerivedState(state._allProjects, state._projectsById);
        const derived = {
            ...projectDerived,
            ...taskDerived,
        };
        derivedCache = {
            visibleTasksRef: state.tasks,
            taskLookupRef: state._tasksById,
            projectLookupRef: state._projectsById,
            value: derived,
        };
        recordDerivedStateRebuild(profilerNow() - rebuildStartedAt);
        return derived;
    },

    setHighlightTask: (id: string | null) => {
        set({ highlightTaskId: id, highlightTaskAt: id ? Date.now() : null });
    },

    getFocusedCount: () => selectFocusedCount(get().tasks),
});
