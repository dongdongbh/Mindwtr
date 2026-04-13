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
    computeProjectDerivedState,
    computeTaskDerivedState,
    ensureDeviceId,
    normalizeAiSettingsForSync,
    normalizeRevision,
    selectVisibleTasks,
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
const getFetchDataErrorMessage = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = detail.trim();
    if (!trimmed) return 'Failed to fetch data';
    if (/timed out/i.test(trimmed)) return 'Storage request timed out. Try again.';
    return `Failed to fetch data: ${trimmed}`;
};
const NON_MUTATING_SETTINGS_KEYS = new Set<keyof AppData['settings']>([
    'lastSyncAt',
    'lastSyncStatus',
    'lastSyncError',
    'pendingRemoteWriteAt',
    'pendingRemoteWriteRetryAt',
    'pendingRemoteWriteAttempts',
    'lastSyncStats',
    'lastSyncHistory',
]);

let derivedCache: DerivedCache | null = null;

export const clearDerivedCache = () => {
    derivedCache = null;
};

const settingsValueChanged = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);

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

function shouldPromoteScheduledTask(task: AppData['tasks'][number], nowMs: number): boolean {
    if (task.deletedAt || task.purgedAt) return false;
    // Explicit Waiting should remain stable even when dated items become due.
    // Waiting represents a handoff/follow-up decision, not a transient scheduling bucket.
    if (
        task.status === 'next'
        || task.status === 'waiting'
        || task.status === 'done'
        || task.status === 'archived'
        || task.status === 'reference'
    ) {
        return false;
    }
    const startMs = safeParseDate(task.startTime)?.getTime() ?? NaN;
    if (Number.isFinite(startMs) && startMs <= nowMs) return true;
    const dueMs = safeParseDate(task.dueDate)?.getTime() ?? NaN;
    if (Number.isFinite(dueMs) && dueMs <= nowMs) return true;
    return false;
}

const normalizeAreaForLoad = (area: Area, fallbackOrder: number, nowIso: string): Area => {
    const createdAt = typeof area?.createdAt === 'string' && area.createdAt.trim().length > 0
        ? area.createdAt
        : (typeof area?.updatedAt === 'string' && area.updatedAt.trim().length > 0 ? area.updatedAt : nowIso);
    const updatedAt = typeof area?.updatedAt === 'string' && area.updatedAt.trim().length > 0
        ? area.updatedAt
        : createdAt;
    return {
        ...area,
        order: Number.isFinite(area?.order) ? area.order : fallbackOrder,
        createdAt,
        updatedAt,
    };
};

type SettingsActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    flushPendingSave: () => Promise<void>;
    hasPendingSaveWork: () => boolean;
    getStorage: () => StorageAdapter;
};

type SettingsActions = Pick<TaskStore, 'fetchData' | 'updateSettings' | 'persistSnapshot' | 'getDerivedState' | 'setHighlightTask'>;

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
        const fetchStartedAt = get().lastDataChangeAt;
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
            // Store ALL data including tombstones for persistence
            const nowIso = new Date().toISOString();
            let didNormalizeAreaTimestamps = false;
            const sourceAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            const rawAreas = sourceAreas.map((area, index) => {
                const normalized = normalizeAreaForLoad(area, index, nowIso);
                if (normalized.createdAt !== area.createdAt || normalized.updatedAt !== area.updatedAt || normalized.order !== area.order) {
                    didNormalizeAreaTimestamps = true;
                }
                return normalized;
            });
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
            let didProjectOrderMigration = false;
            let didAreaMigration = didNormalizeAreaTimestamps;
            let didRunAreaDedupePass = false;
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
                    didRunAreaDedupePass = true;
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
            if (!didRunAreaDedupePass) {
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
            let didArchiveTasksForArchivedProjects = false;
            let didArchiveSectionsForArchivedProjects = false;
            const archivedProjectIds = new Set(
                allProjects
                    .filter((project) => !project.deletedAt && project.status === 'archived')
                    .map((project) => project.id)
            );
            if (archivedProjectIds.size > 0) {
                allTasks = allTasks.map((task) => {
                    if (task.deletedAt || task.status === 'archived') return task;
                    if (!task.projectId || !archivedProjectIds.has(task.projectId)) return task;
                    didArchiveTasksForArchivedProjects = true;
                    return {
                        ...task,
                        status: 'archived',
                        completedAt: task.completedAt || nowIso,
                        isFocusedToday: false,
                        updatedAt: nowIso,
                        rev: normalizeRevision(task.rev) + 1,
                        revBy: nextSettings.deviceId,
                    };
                });
                allSections = allSections.map((section) => {
                    if (section.deletedAt) return section;
                    if (!archivedProjectIds.has(section.projectId)) return section;
                    didArchiveSectionsForArchivedProjects = true;
                    return {
                        ...section,
                        deletedAt: nowIso,
                        updatedAt: nowIso,
                        rev: normalizeRevision(section.rev) + 1,
                        revBy: nextSettings.deviceId,
                    };
                });
            }
            let didRepairEntityReferences = false;
            const activeAreaIds = new Set(
                allAreas
                    .filter((area) => !area.deletedAt)
                    .map((area) => area.id)
            );
            allProjects = allProjects.map((project) => {
                if (project.deletedAt || !project.areaId || activeAreaIds.has(project.areaId)) return project;
                didRepairEntityReferences = true;
                return {
                    ...project,
                    areaId: undefined,
                    updatedAt: nowIso,
                    rev: normalizeRevision(project.rev) + 1,
                    revBy: nextSettings.deviceId,
                };
            });
            const activeProjectIds = new Set(
                allProjects
                    .filter((project) => !project.deletedAt)
                    .map((project) => project.id)
            );
            allSections = allSections.map((section) => {
                if (section.deletedAt || activeProjectIds.has(section.projectId)) return section;
                didRepairEntityReferences = true;
                return {
                    ...section,
                    deletedAt: nowIso,
                    updatedAt: nowIso,
                    rev: normalizeRevision(section.rev) + 1,
                    revBy: nextSettings.deviceId,
                };
            });
            const activeSectionProjectIds = new Map(
                allSections
                    .filter((section) => !section.deletedAt)
                    .map((section) => [section.id, section.projectId])
            );
            allTasks = allTasks.map((task) => {
                if (task.deletedAt) return task;
                let nextTask = task;
                let changed = false;
                if (nextTask.projectId && !activeProjectIds.has(nextTask.projectId)) {
                    nextTask = {
                        ...nextTask,
                        projectId: undefined,
                        sectionId: undefined,
                    };
                    changed = true;
                }
                const sectionProjectId = nextTask.sectionId ? activeSectionProjectIds.get(nextTask.sectionId) : undefined;
                if (nextTask.sectionId && (!sectionProjectId || (nextTask.projectId && sectionProjectId !== nextTask.projectId))) {
                    nextTask = {
                        ...nextTask,
                        sectionId: undefined,
                    };
                    changed = true;
                }
                if (nextTask.areaId && !activeAreaIds.has(nextTask.areaId)) {
                    nextTask = {
                        ...nextTask,
                        areaId: undefined,
                    };
                    changed = true;
                }
                if (!changed) return task;
                didRepairEntityReferences = true;
                return {
                    ...nextTask,
                    updatedAt: nowIso,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: nextSettings.deviceId,
                };
            });
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
                if (
                    cleanup.removedTaskTombstones > 0
                    || cleanup.removedProjectTombstones > 0
                    || cleanup.removedSectionTombstones > 0
                    || cleanup.removedAreaTombstones > 0
                    || cleanup.removedAttachmentTombstones > 0
                ) {
                    didTombstoneCleanup = true;
                    logWarn('Purged expired tombstones during data fetch', {
                        scope: 'store',
                        category: 'storage',
                        context: {
                            removedTaskTombstones: cleanup.removedTaskTombstones,
                            removedProjectTombstones: cleanup.removedProjectTombstones,
                            removedSectionTombstones: cleanup.removedSectionTombstones,
                            removedAreaTombstones: cleanup.removedAreaTombstones,
                            removedAttachmentTombstones: cleanup.removedAttachmentTombstones,
                        },
                    });
                }
            }
            // Filter out soft-deleted and archived items for day-to-day UI display
            const visibleTasks = selectVisibleTasks(allTasks);
            const visibleProjects = allProjects.filter(p => !p.deletedAt);
            const visibleSections = allSections.filter((section) => !section.deletedAt);
            const visibleAreas = allAreas.filter((area) => !area.deletedAt);
            markCoreStartupPhase('core.fetch_data.post_process:end', { durationMs: Date.now() - postProcessStartedAt });
            let skippedDueToConcurrentLocalChange = false;
            await measureCoreStartupPhase('core.fetch_data.zustand_set_state', async () => {
                set((state) => {
                    if (state.lastDataChangeAt > fetchStartedAt) {
                        skippedDueToConcurrentLocalChange = true;
                        return options?.silent ? {} : { isLoading: false };
                    }
                    return {
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
                        lastDataChangeAt:
                            didAutoArchive
                                || didPromoteScheduled
                                || didArchiveTasksForArchivedProjects
                                || didArchiveSectionsForArchivedProjects
                                || didRepairEntityReferences
                                || didTombstoneCleanup
                                ? Date.now()
                                : state.lastDataChangeAt,
                    };
                });
            });
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

            if (
                didAutoArchive
                || didPromoteScheduled
                || didArchiveTasksForArchivedProjects
                || didArchiveSectionsForArchivedProjects
                || didRepairEntityReferences
                || didTombstoneCleanup
                || didAreaMigration
                || didProjectOrderMigration
                || didSettingsUpdate
            ) {
                markCoreStartupPhase('core.fetch_data.debounced_save_enqueued');
                debouncedSave(
                    { tasks: allTasks, projects: allProjects, sections: allSections, areas: allAreas, settings: nextSettings },
                    (msg) => set({ error: msg })
                );
            }
            markCoreStartupPhase('core.fetch_data.end');
        } catch (err) {
            markCoreStartupPhase('core.fetch_data.error');
            set({ error: getFetchDataErrorMessage(err), isLoading: false });
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

            if ('language' in updates || 'weekStart' in updates || 'dateFormat' in updates || 'timeFormat' in updates) {
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
            const shouldTrackChange = shouldTrackSettingsChange(state.settings, newSettings, updates);
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
                    const newVisibleTasks = selectVisibleTasks(newAllTasks);
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
            return {
                settings: newSettings,
                lastDataChangeAt: shouldTrackChange ? Date.now() : state.lastDataChangeAt,
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    persistSnapshot: async () => {
        let snapshot: AppData | null = null;
        set((state) => {
            snapshot = buildSaveSnapshot(state);
            return {};
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    getDerivedState: () => {
        const state = get();
        if (derivedCache && derivedCache.tasksRef === state.tasks && derivedCache.projectsRef === state.projects) {
            return derivedCache.value;
        }
        const previous = derivedCache?.value;
        const taskDerived =
            derivedCache && derivedCache.tasksRef === state.tasks && previous
                ? {
                    tasksById: previous.tasksById,
                    activeTasksByStatus: previous.activeTasksByStatus,
                    allContexts: previous.allContexts,
                    allTags: previous.allTags,
                    focusedCount: previous.focusedCount,
                }
                : computeTaskDerivedState(state.tasks);
        const projectDerived =
            derivedCache && derivedCache.projectsRef === state.projects && previous
                ? {
                    projectMap: previous.projectMap,
                    sequentialProjectIds: previous.sequentialProjectIds,
                }
                : computeProjectDerivedState(state.projects);
        const derived = {
            ...projectDerived,
            ...taskDerived,
        };
        derivedCache = {
            tasksRef: state.tasks,
            projectsRef: state.projects,
            value: derived,
        };
        return derived;
    },

    setHighlightTask: (id: string | null) => {
        set({ highlightTaskId: id, highlightTaskAt: id ? Date.now() : null });
    },
});
