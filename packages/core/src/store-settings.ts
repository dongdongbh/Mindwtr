import { safeParseDate } from './date';
import { logWarn } from './logger';
import { purgeExpiredTombstones } from './sync';
import { markCoreStartupPhase, measureCoreStartupPhase } from './startup-profiler';
import { normalizeTaskForLoad } from './task-status';
import type { StorageAdapter } from './storage';
import type { AppData, Area, Project, TaskEditorFieldId } from './types';
import type { DerivedCache, TaskStore } from './store-types';
import {
    buildSaveSnapshot,
    computeDerivedState,
    ensureDeviceId,
    normalizeAiSettingsForSync,
    normalizeRevision,
    stripSensitiveSettings,
    withTimeout,
} from './store-helpers';
import { generateUUID as uuidv4 } from './uuid';

const MIGRATION_VERSION = 1;
// Run auto-archive at most twice a day to keep background work bounded.
const AUTO_ARCHIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TOMBSTONE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TASK_EDITOR_DEFAULTS_VERSION = 4;
const TASK_EDITOR_ALWAYS_VISIBLE: TaskEditorFieldId[] = ['status', 'project', 'description', 'checklist', 'contexts'];
const STORAGE_TIMEOUT_MS = 15_000;

let derivedCache: DerivedCache | null = null;

export const clearDerivedCache = () => {
    derivedCache = null;
};

function shouldPromoteScheduledTask(task: AppData['tasks'][number], nowMs: number): boolean {
    if (task.deletedAt || task.purgedAt) return false;
    if (task.status === 'next' || task.status === 'done' || task.status === 'archived' || task.status === 'reference') return false;
    const startMs = safeParseDate(task.startTime)?.getTime() ?? NaN;
    if (Number.isFinite(startMs) && startMs <= nowMs) return true;
    const dueMs = safeParseDate(task.dueDate)?.getTime() ?? NaN;
    if (Number.isFinite(dueMs) && dueMs <= nowMs) return true;
    return false;
}

type SettingsActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    flushPendingSave: () => Promise<void>;
    hasPendingSaveWork: () => boolean;
    getStorage: () => StorageAdapter;
};

type SettingsActions = Pick<TaskStore, 'fetchData' | 'updateSettings' | 'getDerivedState' | 'setHighlightTask'>;

export const createSettingsActions = ({
    set,
    get,
    debouncedSave,
    flushPendingSave,
    hasPendingSaveWork,
    getStorage,
}: SettingsActionContext): SettingsActions => ({
    /**
     * Fetch all data from the configured storage adapter.
     * Stores full data internally, filters for UI display.
     */
    fetchData: async (options) => {
        markCoreStartupPhase('core.fetch_data.start');
        if (hasPendingSaveWork()) {
            await measureCoreStartupPhase('core.fetch_data.flush_pending_save', async () => {
                await flushPendingSave();
            });
        } else {
            markCoreStartupPhase('core.fetch_data.flush_pending_save.skipped', { reason: 'no_pending_work' });
        }
        if (options?.silent) {
            set({ error: null });
        } else {
            set({ isLoading: true, error: null });
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
        try {
            const storage = getStorage();
            const data = await measureCoreStartupPhase('core.fetch_data.storage_get_data', async () =>
                withTimeout(storage.getData(), STORAGE_TIMEOUT_MS, 'Storage request timed out')
            );
            const postProcessStartedAt = Date.now();
            markCoreStartupPhase('core.fetch_data.post_process:start');
            const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
            const rawProjects = Array.isArray(data.projects) ? data.projects : [];
            const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
            const rawSections = Array.isArray((data as AppData).sections) ? (data as AppData).sections : [];
            const rawAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            // Store ALL data including tombstones for persistence
            const nowIso = new Date().toISOString();
            const settings = stripSensitiveSettings(rawSettings as AppData['settings']);
            const isFreshInstall =
                rawTasks.length === 0 &&
                rawProjects.length === 0 &&
                rawSections.length === 0 &&
                rawAreas.length === 0 &&
                Object.keys(settings).length === 0;
            const migrations = settings.migrations ?? {};
            const shouldRunMigrations = (migrations.version ?? 0) < MIGRATION_VERSION;
            const lastAutoArchiveAt = safeParseDate(migrations.lastAutoArchiveAt)?.getTime() ?? 0;
            const shouldRunAutoArchive = Date.now() - lastAutoArchiveAt > AUTO_ARCHIVE_INTERVAL_MS;
            const lastTombstoneCleanupAt = safeParseDate(migrations.lastTombstoneCleanupAt)?.getTime() ?? 0;
            const shouldRunTombstoneCleanup = Date.now() - lastTombstoneCleanupAt > TOMBSTONE_CLEANUP_INTERVAL_MS;
            const nextMigrationState = { ...migrations };
            let didSettingsUpdate = false;

            if (shouldRunMigrations) {
                nextMigrationState.version = MIGRATION_VERSION;
                didSettingsUpdate = true;
            }
            if (shouldRunAutoArchive) {
                nextMigrationState.lastAutoArchiveAt = nowIso;
                didSettingsUpdate = true;
            }
            if (shouldRunTombstoneCleanup) {
                nextMigrationState.lastTombstoneCleanupAt = nowIso;
                didSettingsUpdate = true;
            }

            let nextSettings = didSettingsUpdate
                ? { ...settings, migrations: nextMigrationState }
                : settings;
            const deviceState = ensureDeviceId(nextSettings);
            nextSettings = deviceState.settings;
            if (deviceState.updated) {
                didSettingsUpdate = true;
            }
            if (isFreshInstall && nextSettings.notificationsEnabled === undefined) {
                nextSettings = { ...nextSettings, notificationsEnabled: false };
                didSettingsUpdate = true;
            }

            const taskEditorDefaultsVersion = nextSettings.gtd?.taskEditor?.defaultsVersion ?? 0;
            if (taskEditorDefaultsVersion < TASK_EDITOR_DEFAULTS_VERSION) {
                const hidden = new Set(nextSettings.gtd?.taskEditor?.hidden ?? []);
                TASK_EDITOR_ALWAYS_VISIBLE.forEach((fieldId) => hidden.delete(fieldId));
                if (taskEditorDefaultsVersion < 4) {
                    hidden.delete('textDirection');
                }
                const existingOrder = nextSettings.gtd?.taskEditor?.order;
                const normalizedOrder = existingOrder?.filter((fieldId) => fieldId !== 'textDirection');
                nextSettings = {
                    ...nextSettings,
                    gtd: {
                        ...(nextSettings.gtd ?? {}),
                        taskEditor: {
                            ...(nextSettings.gtd?.taskEditor ?? {}),
                            ...(normalizedOrder ? { order: normalizedOrder } : {}),
                            hidden: Array.from(hidden),
                            defaultsVersion: TASK_EDITOR_DEFAULTS_VERSION,
                        },
                    },
                };
                didSettingsUpdate = true;
            }

            let allTasks = rawTasks.map((task) => normalizeTaskForLoad(task, nowIso));

            // Auto-archive stale completed items to keep day-to-day UI fast/clean.
            const configuredArchiveDays = settings.gtd?.autoArchiveDays;
            const archiveDays = Number.isFinite(configuredArchiveDays)
                ? Math.max(0, Math.floor(configuredArchiveDays as number))
                : 7;
            const shouldAutoArchive = archiveDays > 0;
            const cutoffMs = shouldAutoArchive ? Date.now() - archiveDays * 24 * 60 * 60 * 1000 : 0;
            let didAutoArchive = false;
            if (shouldAutoArchive && shouldRunAutoArchive) {
                allTasks = allTasks.map((task) => {
                    if (task.deletedAt) return task;
                    if (task.status !== 'done') return task;
                    const completedAt = safeParseDate(task.completedAt)?.getTime() ?? NaN;
                    const updatedAt = safeParseDate(task.updatedAt)?.getTime() ?? NaN;
                    const resolvedCompletedAt = Number.isFinite(completedAt) ? completedAt : updatedAt;
                    if (!Number.isFinite(resolvedCompletedAt) || resolvedCompletedAt <= 0) return task;
                    if (resolvedCompletedAt >= cutoffMs) return task;
                    didAutoArchive = true;
                    return {
                        ...task,
                        status: 'archived',
                        completedAt: Number.isFinite(completedAt) ? task.completedAt : task.updatedAt || nowIso,
                        isFocusedToday: false,
                        updatedAt: nowIso,
                        rev: normalizeRevision(task.rev) + 1,
                        revBy: nextSettings.deviceId,
                    };
                });
            }
            const nowMs = Date.now();
            let didPromoteScheduled = false;
            allTasks = allTasks.map((task) => {
                if (!shouldPromoteScheduledTask(task, nowMs)) return task;
                didPromoteScheduled = true;
                return {
                    ...task,
                    status: 'next',
                    updatedAt: nowIso,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: nextSettings.deviceId,
                };
            });
            let didProjectOrderMigration = false;
            let didAreaMigration = false;
            let allProjects = rawProjects;
            let allSections = rawSections;
            let allAreas = rawAreas;

            if (shouldRunMigrations) {
                allProjects = rawProjects.map((project) => {
                    const status = project.status;
                    const normalizedStatus =
                        status === 'active' || status === 'someday' || status === 'waiting' || status === 'archived'
                            ? status
                            : status === 'completed'
                                ? 'archived'
                                : 'active';
                    const tagIds = Array.isArray((project as Project).tagIds) ? (project as Project).tagIds : [];
                    const normalizedProject =
                        normalizedStatus === status
                            ? { ...project, tagIds }
                            : { ...project, status: normalizedStatus, tagIds };
                    return normalizedProject;
                });
                const projectOrderCounters = new Map<string, number>();
                allProjects = allProjects.map((project) => {
                    const areaKey = project.areaId ?? '__none__';
                    const nextIndex = projectOrderCounters.get(areaKey) ?? 0;
                    const existingOrder = Number.isFinite((project as Project).order) ? (project as Project).order : undefined;
                    if (!Number.isFinite(existingOrder)) {
                        didProjectOrderMigration = true;
                    }
                    const order = Number.isFinite(existingOrder) ? (existingOrder as number) : nextIndex;
                    projectOrderCounters.set(areaKey, Math.max(nextIndex, order + 1));
                    return { ...project, order } as Project;
                });
                allAreas = rawAreas
                    .map((area, index) => ({
                        ...area,
                        order: Number.isFinite(area.order) ? area.order : index,
                    }))
                    .sort((a, b) => a.order - b.order);
                const areaIds = new Set(allAreas.map((area) => area.id));
                let hasLegacyAreaTitle = false;
                let hasMissingAreaId = false;
                for (const project of rawProjects) {
                    if (!hasLegacyAreaTitle && typeof project.areaTitle === 'string' && project.areaTitle.trim() && !project.areaId) {
                        hasLegacyAreaTitle = true;
                    }
                    if (!hasMissingAreaId && project.areaId && !areaIds.has(project.areaId)) {
                        hasMissingAreaId = true;
                    }
                    if (hasLegacyAreaTitle && hasMissingAreaId) break;
                }
                const nameSet = new Set<string>();
                let hasDuplicateNames = false;
                for (const area of allAreas) {
                    if (area.deletedAt) continue;
                    const normalizedName = typeof area?.name === 'string' ? area.name.trim().toLowerCase() : '';
                    if (!normalizedName) continue;
                    if (nameSet.has(normalizedName)) {
                        hasDuplicateNames = true;
                        break;
                    }
                    nameSet.add(normalizedName);
                }
                const shouldRunAreaMigration = hasLegacyAreaTitle || hasMissingAreaId || hasDuplicateNames;
                if (shouldRunAreaMigration) {
                    const areaByName = new Map<string, string>();
                    const areaIdRemap = new Map<string, string>();
                    const uniqueAreas: Area[] = [];
                    allAreas.forEach((area) => {
                        if (area.deletedAt) {
                            uniqueAreas.push(area);
                            return;
                        }
                        const normalizedName = typeof area?.name === 'string' ? area.name.trim().toLowerCase() : '';
                        if (!normalizedName) {
                            uniqueAreas.push(area);
                            return;
                        }
                        const existingId = areaByName.get(normalizedName);
                        if (existingId) {
                            areaIdRemap.set(area.id, existingId);
                            didAreaMigration = true;
                            return;
                        }
                        areaByName.set(normalizedName, area.id);
                        uniqueAreas.push(area);
                    });
                    allAreas = uniqueAreas
                        .map((area, index) => ({
                            ...area,
                            order: Number.isFinite(area.order) ? area.order : index,
                        }))
                        .sort((a, b) => a.order - b.order);
                    const ensureAreaForTitle = (title: string) => {
                        const trimmed = title.trim();
                        if (!trimmed) return undefined;
                        const key = trimmed.toLowerCase();
                        const existing = areaByName.get(key);
                        if (existing) return existing;
                        const now = new Date().toISOString();
                        const id = uuidv4();
                        const order = allAreas.reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;
                        allAreas = [...allAreas, { id, name: trimmed, order, createdAt: now, updatedAt: now }];
                        areaByName.set(key, id);
                        didAreaMigration = true;
                        return id;
                    };
                    const areaIdExists = (areaId?: string) =>
                        Boolean(areaId && allAreas.some((area) => area.id === areaId && !area.deletedAt));
                    allProjects = allProjects.map((project) => {
                        const remappedAreaId = project.areaId ? areaIdRemap.get(project.areaId) : undefined;
                        if (remappedAreaId && remappedAreaId !== project.areaId) {
                            didAreaMigration = true;
                            return { ...project, areaId: remappedAreaId };
                        }
                        if (areaIdExists(project.areaId)) return project;
                        const areaTitle = typeof project.areaTitle === 'string' ? project.areaTitle : '';
                        if (!areaTitle) return project;
                        const derivedId = ensureAreaForTitle(areaTitle);
                        if (!derivedId) return project;
                        didAreaMigration = true;
                        return { ...project, areaId: derivedId };
                    });
                    if (areaIdRemap.size > 0) {
                        allTasks = allTasks.map((task) => {
                            const remappedAreaId = task.areaId ? areaIdRemap.get(task.areaId) : undefined;
                            if (!remappedAreaId || remappedAreaId === task.areaId) return task;
                            didAreaMigration = true;
                            return { ...task, areaId: remappedAreaId };
                        });
                    }
                    allAreas = allAreas
                        .map((area, index) => ({
                            ...area,
                            order: Number.isFinite(area.order) ? area.order : index,
                        }))
                        .sort((a, b) => a.order - b.order);
                }
            }
            {
                const areaByName = new Map<string, string>();
                const areaIdRemap = new Map<string, string>();
                const uniqueAreas: Area[] = [];
                allAreas.forEach((area) => {
                    if (area.deletedAt) {
                        uniqueAreas.push(area);
                        return;
                    }
                    const normalizedName = typeof area?.name === 'string' ? area.name.trim().toLowerCase() : '';
                    if (!normalizedName) {
                        uniqueAreas.push(area);
                        return;
                    }
                    const existingId = areaByName.get(normalizedName);
                    if (existingId) {
                        areaIdRemap.set(area.id, existingId);
                        return;
                    }
                    areaByName.set(normalizedName, area.id);
                    uniqueAreas.push(area);
                });
                if (areaIdRemap.size > 0) {
                    didAreaMigration = true;
                    allAreas = uniqueAreas
                        .map((area, index) => ({
                            ...area,
                            order: Number.isFinite(area.order) ? area.order : index,
                        }))
                        .sort((a, b) => a.order - b.order);
                    allProjects = allProjects.map((project) => {
                        const remappedAreaId = project.areaId ? areaIdRemap.get(project.areaId) : undefined;
                        if (!remappedAreaId || remappedAreaId === project.areaId) return project;
                        return { ...project, areaId: remappedAreaId };
                    });
                    allTasks = allTasks.map((task) => {
                        const remappedAreaId = task.areaId ? areaIdRemap.get(task.areaId) : undefined;
                        if (!remappedAreaId || remappedAreaId === task.areaId) return task;
                        return { ...task, areaId: remappedAreaId };
                    });
                }
            }
            let didTombstoneCleanup = false;
            if (shouldRunTombstoneCleanup) {
                const cleanup = purgeExpiredTombstones(
                    {
                        tasks: allTasks,
                        projects: allProjects,
                        sections: allSections,
                        areas: allAreas,
                        settings: nextSettings,
                    },
                    nowIso
                );
                allTasks = cleanup.data.tasks;
                allProjects = cleanup.data.projects;
                if (cleanup.removedTaskTombstones > 0 || cleanup.removedAttachmentTombstones > 0) {
                    didTombstoneCleanup = true;
                    logWarn('Purged expired tombstones during data fetch', {
                        scope: 'store',
                        category: 'storage',
                        context: {
                            removedTaskTombstones: cleanup.removedTaskTombstones,
                            removedAttachmentTombstones: cleanup.removedAttachmentTombstones,
                        },
                    });
                }
            }
            // Filter out soft-deleted and archived items for day-to-day UI display
            const visibleTasks = allTasks.filter(t => !t.deletedAt && t.status !== 'archived');
            const visibleProjects = allProjects.filter(p => !p.deletedAt);
            const visibleSections = allSections.filter((section) => !section.deletedAt);
            const visibleAreas = allAreas.filter((area) => !area.deletedAt);
            markCoreStartupPhase('core.fetch_data.post_process:end', { durationMs: Date.now() - postProcessStartedAt });
            await measureCoreStartupPhase('core.fetch_data.zustand_set_state', async () => {
                set({
                    tasks: visibleTasks,
                    projects: visibleProjects,
                    sections: visibleSections,
                    areas: visibleAreas,
                    settings: nextSettings,
                    _allTasks: allTasks,
                    _allProjects: allProjects,
                    _allSections: allSections,
                    _allAreas: allAreas,
                    isLoading: false,
                    lastDataChangeAt: didAutoArchive || didPromoteScheduled || didTombstoneCleanup ? Date.now() : get().lastDataChangeAt,
                });
            });

            if (didAutoArchive || didPromoteScheduled || didTombstoneCleanup || didAreaMigration || didProjectOrderMigration || didSettingsUpdate) {
                markCoreStartupPhase('core.fetch_data.debounced_save_enqueued');
                debouncedSave(
                    { tasks: allTasks, projects: allProjects, sections: allSections, areas: allAreas, settings: nextSettings },
                    (msg) => set({ error: msg })
                );
            }
            markCoreStartupPhase('core.fetch_data.end');
        } catch (err) {
            markCoreStartupPhase('core.fetch_data.error');
            set({ error: 'Failed to fetch data', isLoading: false });
        }
    },

    /**
     * Update application settings.
     * @param updates Settings to update
     */
    updateSettings: async (updates: Partial<AppData['settings']>) => {
        const archiveDaysUpdate = updates.gtd?.autoArchiveDays !== undefined;
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const nowIso = new Date().toISOString();
            const nextSettings = { ...deviceState.settings, ...updates };
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

            if ('language' in updates || 'weekStart' in updates || 'dateFormat' in updates) {
                markSyncUpdated('language');
            }

            if ('externalCalendars' in updates) {
                markSyncUpdated('externalCalendars');
            }

            if ('ai' in updates) {
                const prevAi = normalizeAiSettingsForSync(deviceState.settings.ai);
                const nextAi = normalizeAiSettingsForSync(nextSettings.ai);
                if (JSON.stringify(prevAi ?? null) !== JSON.stringify(nextAi ?? null)) {
                    markSyncUpdated('ai');
                }
            }

            const newSettings = syncUpdated ? { ...nextSettings, syncPreferencesUpdatedAt: nextSyncUpdatedAt } : nextSettings;
            if (archiveDaysUpdate) {
                const configuredArchiveDays = newSettings.gtd?.autoArchiveDays;
                const archiveDays = Number.isFinite(configuredArchiveDays)
                    ? Math.max(0, Math.floor(configuredArchiveDays as number))
                    : 7;
                const shouldAutoArchive = archiveDays > 0;
                const cutoffMs = shouldAutoArchive ? Date.now() - archiveDays * 24 * 60 * 60 * 1000 : 0;
                let didAutoArchive = false;

                let newAllTasks = state._allTasks;
                if (shouldAutoArchive) {
                    newAllTasks = newAllTasks.map((task) => {
                        if (task.deletedAt) return task;
                        if (task.status !== 'done') return task;
                        const completedAt = safeParseDate(task.completedAt)?.getTime() ?? NaN;
                        const updatedAt = safeParseDate(task.updatedAt)?.getTime() ?? NaN;
                        const resolvedCompletedAt = Number.isFinite(completedAt) ? completedAt : updatedAt;
                        if (!Number.isFinite(resolvedCompletedAt) || resolvedCompletedAt <= 0) return task;
                        if (resolvedCompletedAt >= cutoffMs) return task;
                        didAutoArchive = true;
                        return {
                            ...task,
                            status: 'archived',
                            isFocusedToday: false,
                            updatedAt: nowIso,
                            completedAt: Number.isFinite(completedAt) ? task.completedAt : task.updatedAt || nowIso,
                            rev: normalizeRevision(task.rev) + 1,
                            revBy: deviceState.deviceId,
                        };
                    });
                }

                if (didAutoArchive) {
                    const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt && t.status !== 'archived');
                    snapshot = buildSaveSnapshot(state, { tasks: newAllTasks, settings: newSettings });
                    return {
                        tasks: newVisibleTasks,
                        _allTasks: newAllTasks,
                        settings: newSettings,
                        lastDataChangeAt: Date.now(),
                    };
                }
            }

            snapshot = buildSaveSnapshot(state, { settings: newSettings });
            return { settings: newSettings };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    getDerivedState: () => {
        const state = get();
        if (derivedCache && derivedCache.lastDataChangeAt === state.lastDataChangeAt) {
            return derivedCache.value;
        }
        const derived = computeDerivedState(state.tasks, state.projects);
        derivedCache = {
            lastDataChangeAt: state.lastDataChangeAt,
            value: derived,
        };
        return derived;
    },

    setHighlightTask: (id: string | null) => {
        set({ highlightTaskId: id, highlightTaskAt: id ? Date.now() : null });
    },
});
