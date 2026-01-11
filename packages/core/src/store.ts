import { create } from 'zustand';
import { generateUUID as uuidv4 } from './uuid';
import { Task, TaskStatus, AppData, Project, Area, TaskEditorFieldId } from './types';
import { StorageAdapter, TaskQueryOptions, noopStorage } from './storage';
import { createNextRecurringTask } from './recurrence';
import { safeParseDate } from './date';
import { normalizeTaskForLoad } from './task-status';
import { rescheduleTask } from './task-utils';

let storage: StorageAdapter = noopStorage;

export function applyTaskUpdates(oldTask: Task, updates: Partial<Task>, now: string): { updatedTask: Task; nextRecurringTask: Task | null } {
    const incomingStatus = updates.status ?? oldTask.status;
    const statusChanged = incomingStatus !== oldTask.status;

    let finalUpdates: Partial<Task> = updates;
    let nextRecurringTask: Task | null = null;
    const isCompleteStatus = (status: TaskStatus) => status === 'done' || status === 'archived';

    if (statusChanged && incomingStatus === 'done') {
        finalUpdates = {
            ...updates,
            status: incomingStatus,
            completedAt: now,
            isFocusedToday: false,
        };
        nextRecurringTask = createNextRecurringTask(oldTask, now, oldTask.status);
    } else if (statusChanged && incomingStatus === 'archived') {
        finalUpdates = {
            ...updates,
            status: incomingStatus,
            completedAt: oldTask.completedAt || now,
            isFocusedToday: false,
        };
    } else if (statusChanged && isCompleteStatus(oldTask.status) && !isCompleteStatus(incomingStatus)) {
        finalUpdates = {
            ...updates,
            status: incomingStatus,
            completedAt: undefined,
        };
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'dueDate')) {
        const rescheduled = rescheduleTask(oldTask, updates.dueDate);
        finalUpdates = {
            ...finalUpdates,
            dueDate: rescheduled.dueDate,
            pushCount: rescheduled.pushCount,
        };
    }

    return {
        updatedTask: { ...oldTask, ...finalUpdates, updatedAt: now },
        nextRecurringTask,
    };
}

const isTaskVisible = (task?: Task | null) => Boolean(task && !task.deletedAt && task.status !== 'archived');

const updateVisibleTasks = (visible: Task[], previous?: Task | null, next?: Task | null): Task[] => {
    const wasVisible = isTaskVisible(previous);
    const isVisible = isTaskVisible(next);
    if (wasVisible && isVisible && next) {
        return visible.map((task) => (task.id === next.id ? next : task));
    }
    if (wasVisible && !isVisible && previous) {
        return visible.filter((task) => task.id !== previous.id);
    }
    if (!wasVisible && isVisible && next) {
        return [...visible, next];
    }
    return visible;
};

/**
 * Configure the storage adapter to use for persistence.
 * Must be called before using the store.
 */
export const setStorageAdapter = (adapter: StorageAdapter) => {
    storage = adapter;
};

export const getStorageAdapter = () => storage;

/**
 * Core application state interface.
 * 
 * IMPORTANT: `tasks` and `projects` contain only VISIBLE (non-deleted) items for UI.
 * The store internally tracks ALL items (including soft-deleted) for persistence.
 */
interface TaskStore {
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: AppData['settings'];
    isLoading: boolean;
    error: string | null;
    /** Updated whenever tasks/projects change (not settings) */
    lastDataChangeAt: number;
    /** Ephemeral highlight task id for UI navigation */
    highlightTaskId: string | null;
    highlightTaskAt: number | null;

    // Internal: full data including tombstones (not exposed to UI)
    _allTasks: Task[];
    _allProjects: Project[];
    _allAreas: Area[];

    // Actions
    /** Load all data from storage */
    fetchData: () => Promise<void>;
    /** Add a new task */
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<void>;
    /** Update an existing task */
    updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
    /** Soft-delete a task */
    deleteTask: (id: string) => Promise<void>;
    /** Restore a soft-deleted task */
    restoreTask: (id: string) => Promise<void>;
    /** Permanently remove a task from storage */
    purgeTask: (id: string) => Promise<void>;
    /** Permanently remove all soft-deleted tasks from storage */
    purgeDeletedTasks: () => Promise<void>;
    /** Duplicate a task (useful for reusable lists/templates) */
    duplicateTask: (id: string, asNextAction?: boolean) => Promise<void>;
    /** Reset checklist items to unchecked */
    resetTaskChecklist: (id: string) => Promise<void>;
    /** Move task to a different status */
    moveTask: (id: string, newStatus: TaskStatus) => Promise<void>;
    /** Batch update multiple tasks */
    batchUpdateTasks: (updates: Array<{ id: string; updates: Partial<Task> }>) => Promise<void>;
    /** Batch move tasks to a status */
    batchMoveTasks: (ids: string[], newStatus: TaskStatus) => Promise<void>;
    /** Batch soft-delete tasks */
    batchDeleteTasks: (ids: string[]) => Promise<void>;
    /** Query tasks using storage adapter when available */
    queryTasks: (options: TaskQueryOptions) => Promise<Task[]>;

    // Project Actions
    /** Add a new project */
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project>;
    /** Update a project */
    updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
    /** Delete a project */
    deleteProject: (id: string) => Promise<void>;
    /** Toggle focus status of a project (max 5) */
    toggleProjectFocus: (id: string) => Promise<void>;

    // Area Actions
    /** Add a new area */
    addArea: (name: string, initialProps?: Partial<Area>) => Promise<void>;
    /** Update an area */
    updateArea: (id: string, updates: Partial<Area>) => Promise<void>;
    /** Delete an area and clear areaId on child projects */
    deleteArea: (id: string) => Promise<void>;
    /** Reorder areas by id list */
    reorderAreas: (orderedIds: string[]) => Promise<void>;
    /** Reorder projects within a specific area by id list */
    reorderProjects: (orderedIds: string[], areaId?: string) => Promise<void>;
    /** Reorder tasks within a project */
    reorderProjectTasks: (projectId: string, orderedIds: string[]) => Promise<void>;

    // Tag Actions
    /** Delete a tag from tasks and projects */
    deleteTag: (tagId: string) => Promise<void>;

    // Settings Actions
    /** Update application settings */
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    /** Highlight a task in UI lists (non-persistent) */
    setHighlightTask: (id: string | null) => void;
}

// Save queue helper - coalesces writes while ensuring the latest snapshot is persisted quickly.
let pendingData: AppData | null = null;
let pendingOnError: Array<(msg: string) => void> = [];
let pendingVersion = 0;
let pendingDataVersion = 0;
let savedVersion = 0;
let saveInFlight: Promise<void> | null = null;
const MIGRATION_VERSION = 1;
const AUTO_ARCHIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TASK_EDITOR_DEFAULTS_VERSION = 2;
const TASK_EDITOR_ALWAYS_VISIBLE: TaskEditorFieldId[] = ['status', 'project', 'description', 'checklist', 'contexts'];
const STORAGE_TIMEOUT_MS = 15_000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

const normalizeTagId = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const withPrefix = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return withPrefix.toLowerCase();
};

const stripSensitiveSettings = (settings: AppData['settings']): AppData['settings'] => {
    if (!settings?.ai || !settings.ai.apiKey) return settings;
    return {
        ...settings,
        ai: {
            ...settings.ai,
            apiKey: undefined,
        },
    };
};

const cloneSettings = (settings: AppData['settings']): AppData['settings'] => {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(settings);
        }
    } catch {
        // Fallback below
    }
    return JSON.parse(JSON.stringify(settings)) as AppData['settings'];
};

const cloneTask = (task: Task): Task => ({
    ...task,
    tags: task.tags ? [...task.tags] : [],
    contexts: task.contexts ? [...task.contexts] : [],
    checklist: task.checklist ? task.checklist.map((item) => ({ ...item })) : [],
    attachments: task.attachments ? task.attachments.map((item) => ({ ...item })) : [],
});

const cloneProject = (project: Project): Project => ({
    ...project,
    tagIds: project.tagIds ? [...project.tagIds] : [],
    attachments: project.attachments ? project.attachments.map((item) => ({ ...item })) : [],
});

const cloneArea = (area: Area): Area => ({ ...area });

const sanitizeAppDataForStorage = (data: AppData): AppData => ({
    ...data,
    settings: stripSensitiveSettings(cloneSettings(data.settings)),
    tasks: data.tasks.map(cloneTask),
    projects: data.projects.map(cloneProject),
    areas: (data.areas || []).map(cloneArea),
});

const projectOrderCache = new WeakMap<Task[], Map<string, number>>();

const getNextProjectOrder = (projectId: string | undefined, tasks: Task[]): number | undefined => {
    if (!projectId) return undefined;
    let cache = projectOrderCache.get(tasks);
    if (!cache) {
        cache = new Map();
        projectOrderCache.set(tasks, cache);
    }
    const cached = cache.get(projectId);
    if (cached !== undefined) return cached;
    const projectTasks = tasks.filter((task) => task.projectId === projectId && !task.deletedAt);
    if (projectTasks.length === 0) return 0;
    const ordered = projectTasks
        .map((task) => task.orderNum)
        .filter((value): value is number => Number.isFinite(value));
    if (ordered.length > 0) {
        const next = Math.max(...ordered) + 1;
        cache.set(projectId, next);
        return next;
    }
    const next = projectTasks.length;
    cache.set(projectId, next);
    return next;
};

/**
 * Save data with write coalescing.
 * Captures a snapshot immediately and serializes writes to avoid lost updates.
 * @param data Snapshot of data to save (must include ALL items including tombstones)
 * @param onError Callback for save failures
 */
const debouncedSave = (data: AppData, onError?: (msg: string) => void) => {
    pendingVersion += 1;
    pendingData = sanitizeAppDataForStorage(data);
    pendingDataVersion = pendingVersion;
    if (onError) pendingOnError.push(onError);
    void flushPendingSave().catch((error) => {
        console.error('Failed to flush pending save:', error);
    });
};

/**
 * Immediately save any pending debounced data.
 * Call this when the app goes to background or is about to be terminated.
 */
export const flushPendingSave = async (): Promise<void> => {
    while (true) {
        if (saveInFlight) {
            await saveInFlight;
            continue;
        }
        if (!pendingData) return;
        if (pendingDataVersion === savedVersion) return;
        const targetVersion = pendingDataVersion;
        const dataToSave = pendingData;
        const onErrorCallbacks = pendingOnError;
        pendingOnError = [];
        saveInFlight = storage.saveData(dataToSave).then(() => {
            savedVersion = targetVersion;
        }).catch((e) => {
            console.error('Failed to flush pending save:', e);
            if (onErrorCallbacks.length > 0) {
                onErrorCallbacks.forEach((callback) => callback('Failed to save data'));
            }
        }).finally(() => {
            saveInFlight = null;
        });
        await saveInFlight;
    }
};

export const useTaskStore = create<TaskStore>((set, get) => ({
    tasks: [],
    projects: [],
    areas: [],
    settings: {},
    isLoading: false,
    error: null,
    lastDataChangeAt: 0,
    highlightTaskId: null,
    highlightTaskAt: null,
    // Internal: full data including tombstones
    _allTasks: [],
    _allProjects: [],
    _allAreas: [],

    /**
     * Fetch all data from the configured storage adapter.
     * Stores full data internally, filters for UI display.
     */
    fetchData: async () => {
        await flushPendingSave();
        set({ isLoading: true, error: null });
        try {
            const data = await withTimeout(storage.getData(), STORAGE_TIMEOUT_MS, 'Storage request timed out');
            const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
            const rawProjects = Array.isArray(data.projects) ? data.projects : [];
            const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
            const rawAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            // Store ALL data including tombstones for persistence
            const nowIso = new Date().toISOString();
            const settings = stripSensitiveSettings(rawSettings as AppData['settings']);
            const migrations = settings.migrations ?? {};
            const shouldRunMigrations = (migrations.version ?? 0) < MIGRATION_VERSION;
            const lastAutoArchiveAt = safeParseDate(migrations.lastAutoArchiveAt)?.getTime() ?? 0;
            const shouldRunAutoArchive = Date.now() - lastAutoArchiveAt > AUTO_ARCHIVE_INTERVAL_MS;
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

            let nextSettings = didSettingsUpdate
                ? { ...settings, migrations: nextMigrationState }
                : settings;

            const taskEditorDefaultsVersion = nextSettings.gtd?.taskEditor?.defaultsVersion ?? 0;
            if (taskEditorDefaultsVersion < TASK_EDITOR_DEFAULTS_VERSION) {
                const hidden = new Set(nextSettings.gtd?.taskEditor?.hidden ?? []);
                TASK_EDITOR_ALWAYS_VISIBLE.forEach((fieldId) => hidden.delete(fieldId));
                nextSettings = {
                    ...nextSettings,
                    gtd: {
                        ...(nextSettings.gtd ?? {}),
                        taskEditor: {
                            ...(nextSettings.gtd?.taskEditor ?? {}),
                            hidden: Array.from(hidden),
                            defaultsVersion: TASK_EDITOR_DEFAULTS_VERSION,
                        },
                    },
                };
                didSettingsUpdate = true;
            }

            let allTasks = (shouldRunMigrations || shouldRunAutoArchive)
                ? rawTasks.map((task) => normalizeTaskForLoad(task, nowIso))
                : rawTasks;

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
                    };
                });
            }
            let didProjectOrderMigration = false;
            let didAreaMigration = false;
            let allProjects = rawProjects;
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
                    const areaIdExists = (areaId?: string) => Boolean(areaId && allAreas.some((area) => area.id === areaId));
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
                    allAreas = allAreas
                        .map((area, index) => ({
                            ...area,
                            order: Number.isFinite(area.order) ? area.order : index,
                        }))
                        .sort((a, b) => a.order - b.order);
                }
            }
            // Filter out soft-deleted and archived items for day-to-day UI display
            const visibleTasks = allTasks.filter(t => !t.deletedAt && t.status !== 'archived');
            const visibleProjects = allProjects.filter(p => !p.deletedAt);
            set({
                tasks: visibleTasks,
                projects: visibleProjects,
                areas: allAreas,
                settings: nextSettings,
                _allTasks: allTasks,
                _allProjects: allProjects,
                _allAreas: allAreas,
                isLoading: false,
                lastDataChangeAt: didAutoArchive ? Date.now() : get().lastDataChangeAt,
            });

            if (didAutoArchive || didAreaMigration || didProjectOrderMigration || didSettingsUpdate) {
                debouncedSave(
                    { tasks: allTasks, projects: allProjects, areas: allAreas, settings: nextSettings },
                    (msg) => set({ error: msg })
                );
            }
        } catch (err) {
            set({ error: 'Failed to fetch data', isLoading: false });
        }
    },

    /**
     * Add a new task to the store and persist to storage.
     * @param title Task title
     * @param initialProps Optional initial properties
     */
    addTask: async (title: string, initialProps?: Partial<Task>) => {
        const changeAt = Date.now();
        const hasOrderNum = Object.prototype.hasOwnProperty.call(initialProps ?? {}, 'orderNum');
        const resolvedProjectId = initialProps?.projectId;
        const resolvedOrderNum = !hasOrderNum && resolvedProjectId
            ? getNextProjectOrder(resolvedProjectId, get()._allTasks)
            : initialProps?.orderNum;
        const newTask: Task = {
            id: uuidv4(),
            title,
            status: 'inbox',
            taskMode: 'task',
            tags: [],
            contexts: [],
            pushCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...initialProps,
            orderNum: resolvedOrderNum,
        };

        const newAllTasks = [...get()._allTasks, newTask];
        const newVisibleTasks = updateVisibleTasks(get().tasks, null, newTask);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Update an existing task.
     * @param id Task ID
     * @param updates Properties to update
     */
    updateTask: async (id: string, updates: Partial<Task>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let nextAllTasks: Task[] | null = null;
        let nextVisibleTasks: Task[] | null = null;
        set((state) => {
            const oldTask = state._allTasks.find((t) => t.id === id);
            if (!oldTask) return state;

            let adjustedUpdates = updates;
            if (Object.prototype.hasOwnProperty.call(updates, 'projectId')) {
                const rawProjectId = updates.projectId;
                const normalizedProjectId =
                    typeof rawProjectId === 'string' && rawProjectId.trim().length > 0
                        ? rawProjectId
                        : undefined;
                const nextProjectId = normalizedProjectId ?? undefined;
                const projectChanged = (oldTask.projectId ?? undefined) !== nextProjectId;
                if (projectChanged) {
                    const hasOrderNum = Object.prototype.hasOwnProperty.call(updates, 'orderNum');
                    if (nextProjectId) {
                        if (!hasOrderNum) {
                            adjustedUpdates = {
                                ...adjustedUpdates,
                                orderNum: getNextProjectOrder(nextProjectId, state._allTasks),
                            };
                        }
                    } else {
                        adjustedUpdates = {
                            ...adjustedUpdates,
                            projectId: undefined,
                            orderNum: undefined,
                        };
                    }
                } else if (normalizedProjectId !== updates.projectId) {
                    adjustedUpdates = {
                        ...adjustedUpdates,
                        projectId: normalizedProjectId,
                    };
                }
            }

            const { updatedTask, nextRecurringTask } = applyTaskUpdates(oldTask, adjustedUpdates, now);

            const updatedAllTasks = state._allTasks.map((task) =>
                task.id === id ? updatedTask : task
            );

            if (nextRecurringTask) updatedAllTasks.push(nextRecurringTask);

            let updatedVisibleTasks = updateVisibleTasks(state.tasks, oldTask, updatedTask);
            if (nextRecurringTask) {
                updatedVisibleTasks = updateVisibleTasks(updatedVisibleTasks, null, nextRecurringTask);
            }
            nextAllTasks = updatedAllTasks;
            nextVisibleTasks = updatedVisibleTasks;
            return { tasks: updatedVisibleTasks, _allTasks: updatedAllTasks, lastDataChangeAt: changeAt };
        });

        if (!nextAllTasks || !nextVisibleTasks) {
            return;
        }
        debouncedSave(
            { tasks: nextAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Soft-delete a task by setting deletedAt.
     * @param id Task ID
     */
    deleteTask: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const oldTask = get()._allTasks.find((task) => task.id === id);
        const updatedTask = oldTask ? { ...oldTask, deletedAt: now, updatedAt: now } : null;
        // Update in full data (set tombstone)
        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id ? (updatedTask ?? task) : task
        );
        // Filter for UI state (hide deleted)
        const newVisibleTasks = updateVisibleTasks(get().tasks, oldTask, updatedTask);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        // Save with all data including tombstones
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Restore a soft-deleted task (returns to Inbox).
     */
    restoreTask: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const oldTask = get()._allTasks.find((task) => task.id === id);
        const updatedTask = oldTask
            ? {
                ...oldTask,
                deletedAt: undefined,
                purgedAt: undefined,
                status: oldTask.status === 'archived' ? 'inbox' : oldTask.status,
                updatedAt: now,
            }
            : null;
        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id
                ? (updatedTask ?? task)
                : task
        );
        const newVisibleTasks = updateVisibleTasks(get().tasks, oldTask, updatedTask);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Permanently delete a task (removes from storage).
     */
    purgeTask: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const oldTask = get()._allTasks.find((task) => task.id === id);
        if (!oldTask) return;
        const updatedTask = {
            ...oldTask,
            deletedAt: oldTask.deletedAt ?? now,
            purgedAt: now,
            updatedAt: now,
        };
        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id ? updatedTask : task
        );
        const newVisibleTasks = updateVisibleTasks(get().tasks, oldTask, updatedTask);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Permanently delete all soft-deleted tasks.
     */
    purgeDeletedTasks: async () => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const newAllTasks = get()._allTasks.map((task) =>
            task.deletedAt
                ? { ...task, purgedAt: now, updatedAt: now }
                : task
        );
        const newVisibleTasks = get().tasks.filter((task) => !task.deletedAt && task.status !== 'archived');
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Duplicate a task for reusable lists/templates.
     */
    duplicateTask: async (id: string, asNextAction?: boolean) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const sourceTask = get()._allTasks.find((task) => task.id === id && !task.deletedAt);
        if (!sourceTask) return;

        const duplicatedChecklist = (sourceTask.checklist || []).map((item) => ({
            ...item,
            id: uuidv4(),
            isCompleted: false,
        }));
        const duplicatedAttachments = (sourceTask.attachments || []).map((attachment) => ({
            ...attachment,
            id: uuidv4(),
            createdAt: now,
            updatedAt: now,
            deletedAt: undefined,
        }));

        const newTask: Task = {
            ...sourceTask,
            id: uuidv4(),
            title: `${sourceTask.title} (Copy)`,
            status: asNextAction ? 'next' : 'inbox',
            checklist: duplicatedChecklist.length > 0 ? duplicatedChecklist : undefined,
            attachments: duplicatedAttachments.length > 0 ? duplicatedAttachments : undefined,
            startTime: undefined,
            dueDate: undefined,
            recurrence: undefined,
            reviewAt: undefined,
            completedAt: undefined,
            isFocusedToday: false,
            pushCount: 0,
            deletedAt: undefined,
            createdAt: now,
            updatedAt: now,
            orderNum: sourceTask.projectId
                ? getNextProjectOrder(sourceTask.projectId, get()._allTasks)
                : undefined,
        };

        const newAllTasks = [...get()._allTasks, newTask];
        const newVisibleTasks = updateVisibleTasks(get().tasks, null, newTask);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Reset checklist items to unchecked (useful for reusable lists).
     */
    resetTaskChecklist: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const sourceTask = get()._allTasks.find((task) => task.id === id && !task.deletedAt);
        if (!sourceTask || !sourceTask.checklist || sourceTask.checklist.length === 0) return;

        const resetChecklist = sourceTask.checklist.map((item) => ({
            ...item,
            isCompleted: false,
        }));
        const wasDone = sourceTask.status === 'done';
        const nextStatus: TaskStatus = wasDone ? 'next' : sourceTask.status;

        const updatedTask: Task = {
            ...sourceTask,
            checklist: resetChecklist,
            status: nextStatus,
            completedAt: wasDone ? undefined : sourceTask.completedAt,
            isFocusedToday: wasDone ? false : sourceTask.isFocusedToday,
            updatedAt: now,
        };

        const newAllTasks = get()._allTasks.map((task) => (task.id === id ? updatedTask : task));
        const newVisibleTasks = updateVisibleTasks(get().tasks, sourceTask, updatedTask);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Move a task to a different status.
     * @param id Task ID
     * @param newStatus New status
     */
    moveTask: async (id: string, newStatus: TaskStatus) => {
        // Delegate to updateTask to ensure recurrence/metadata logic is applied
        await get().updateTask(id, { status: newStatus });
    },

    /**
     * Batch update tasks in a single save cycle.
     */
    batchUpdateTasks: async (updatesList: Array<{ id: string; updates: Partial<Task> }>) => {
        if (updatesList.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const updatesById = new Map(updatesList.map((u) => [u.id, u.updates]));
        const nextRecurringTasks: Task[] = [];
        let snapshot: AppData | null = null;

        set((state) => {
            let newVisibleTasks = state.tasks;
            const newAllTasks = state._allTasks.map((task) => {
                const updates = updatesById.get(task.id);
                if (!updates) return task;
                const { updatedTask, nextRecurringTask } = applyTaskUpdates(task, updates, now);
                if (nextRecurringTask) nextRecurringTasks.push(nextRecurringTask);
                newVisibleTasks = updateVisibleTasks(newVisibleTasks, task, updatedTask);
                return updatedTask;
            });

            if (nextRecurringTasks.length > 0) {
                newAllTasks.push(...nextRecurringTasks);
                nextRecurringTasks.forEach((task) => {
                    newVisibleTasks = updateVisibleTasks(newVisibleTasks, null, task);
                });
            }

            snapshot = {
                tasks: newAllTasks,
                projects: state._allProjects,
                areas: state._allAreas,
                settings: state.settings,
            };

            return { tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    batchMoveTasks: async (ids: string[], newStatus: TaskStatus) => {
        await get().batchUpdateTasks(ids.map((id) => ({ id, updates: { status: newStatus } })));
    },

    batchDeleteTasks: async (ids: string[]) => {
        if (ids.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const idSet = new Set(ids);
        let newVisibleTasks = get().tasks;
        const newAllTasks = get()._allTasks.map((task) => {
            if (!idSet.has(task.id)) return task;
            const updatedTask = { ...task, deletedAt: now, updatedAt: now };
            newVisibleTasks = updateVisibleTasks(newVisibleTasks, task, updatedTask);
            return updatedTask;
        });
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    queryTasks: async (options: TaskQueryOptions) => {
        if (storage.queryTasks) {
            return storage.queryTasks(options);
        }
        const tasks = get()._allTasks;
        const statusFilter = options.status;
        const excludeStatuses = options.excludeStatuses ?? [];
        const includeArchived = options.includeArchived === true;
        const includeDeleted = options.includeDeleted === true;
        return tasks.filter((task) => {
            if (!includeDeleted && task.deletedAt) return false;
            if (!includeArchived && task.status === 'archived') return false;
            if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
            if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
            if (options.projectId && task.projectId !== options.projectId) return false;
            return true;
        });
    },

    /**
     * Add a new project.
     * @param title Project title
     * @param color Project color hex code
     */
    addProject: async (title: string, color: string, initialProps?: Partial<Project>) => {
        const changeAt = Date.now();
        const targetAreaId = initialProps?.areaId;
        const maxOrder = get()._allProjects
            .filter((project) => (project.areaId ?? undefined) === (targetAreaId ?? undefined))
            .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
        const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
        const newProject: Project = {
            id: uuidv4(),
            title,
            color,
            order: baseOrder,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...initialProps,
            tagIds: initialProps?.tagIds ?? [],
        };
        const newAllProjects = [...get()._allProjects, newProject];
        const newVisibleProjects = [...get().projects, newProject];
        set({ projects: newVisibleProjects, _allProjects: newAllProjects, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
        return newProject;
    },

    /**
     * Update an existing project.
     * @param id Project ID
     * @param updates Properties to update
     */
    updateProject: async (id: string, updates: Partial<Project>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const allProjects = get()._allProjects;
        const oldProject = allProjects.find(p => p.id === id);

        const incomingStatus = updates.status ?? oldProject?.status;
        const statusChanged = !!oldProject && !!incomingStatus && incomingStatus !== oldProject.status;

        let newAllTasks = get()._allTasks;

        if (statusChanged && incomingStatus === 'archived') {
            const taskStatus: TaskStatus = 'archived';
            newAllTasks = newAllTasks.map(task => {
                if (
                    task.projectId === id &&
                    !task.deletedAt &&
                    task.status !== taskStatus
                ) {
                    return {
                        ...task,
                        status: taskStatus,
                        completedAt: task.completedAt || now,
                        isFocusedToday: false,
                        updatedAt: now,
                    };
                }
                return task;
            });
        }

        let adjustedOrder = updates.order;
        if (oldProject) {
            const nextAreaId = updates.areaId ?? oldProject.areaId;
            const areaChanged = updates.areaId !== undefined && updates.areaId !== oldProject.areaId;
            if (areaChanged && !Number.isFinite(adjustedOrder)) {
                const maxOrder = allProjects
                    .filter((project) => (project.areaId ?? undefined) === (nextAreaId ?? undefined))
                    .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
                adjustedOrder = maxOrder + 1;
            }
        }

        const finalProjectUpdates: Partial<Project> = {
            ...updates,
            ...(Number.isFinite(adjustedOrder) ? { order: adjustedOrder } : {}),
            ...(statusChanged && incomingStatus && incomingStatus !== 'active'
                ? { isFocused: false }
                : {}),
        };

        const newAllProjects = allProjects.map(project =>
            project.id === id ? { ...project, ...finalProjectUpdates, updatedAt: now } : project
        );

        const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
        const newVisibleTasks = newAllTasks.filter(t => !t.deletedAt && t.status !== 'archived');

        set({
            projects: newVisibleProjects,
            _allProjects: newAllProjects,
            tasks: newVisibleTasks,
            _allTasks: newAllTasks,
            lastDataChangeAt: changeAt,
        });

        debouncedSave(
            { tasks: newAllTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Soft-delete a project and all its tasks.
     * @param id Project ID
     */
    deleteProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        // Soft-delete project
        const newAllProjects = get()._allProjects.map((project) =>
            project.id === id ? { ...project, deletedAt: now, updatedAt: now } : project
        );
        // Also soft-delete tasks that belonged to this project
        const newAllTasks = get()._allTasks.map(task =>
            task.projectId === id && !task.deletedAt
                ? { ...task, deletedAt: now, updatedAt: now }
                : task
        );
        // Filter for UI state
        const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
        const newVisibleTasks = newAllTasks.filter(t => !t.deletedAt && t.status !== 'archived');
        set({
            projects: newVisibleProjects,
            tasks: newVisibleTasks,
            _allProjects: newAllProjects,
            _allTasks: newAllTasks,
            lastDataChangeAt: changeAt,
        });
        // Save with all data including tombstones
        debouncedSave(
            { tasks: newAllTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Toggle the focus status of a project.
     * Enforces a maximum of 5 focused projects.
     * @param id Project ID
     */
    toggleProjectFocus: async (id: string) => {
        const allProjects = get()._allProjects;
        const project = allProjects.find(p => p.id === id);
        if (!project) return;
        if (project.status !== 'active' && !project.isFocused) return;

        // If turning on focus, check if we already have 5 focused
        const focusedCount = allProjects.filter(p => p.isFocused && !p.deletedAt).length;
        const isCurrentlyFocused = project.isFocused;

        // Don't allow more than 5 focused projects
        if (!isCurrentlyFocused && focusedCount >= 5) {
            return;
        }

        const changeAt = Date.now();
        const now = new Date().toISOString();
        const newAllProjects = allProjects.map(p =>
            p.id === id ? { ...p, isFocused: !p.isFocused, updatedAt: now } : p
        );
        const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
        set({ projects: newVisibleProjects, _allProjects: newAllProjects, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    addArea: async (name: string, initialProps?: Partial<Area>) => {
        const trimmedName = typeof name === 'string' ? name.trim() : '';
        if (!trimmedName) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const allAreas = get()._allAreas;
        const normalized = trimmedName.toLowerCase();
        const existing = allAreas.find((area) => area?.name?.trim().toLowerCase() === normalized);
        if (existing) {
            if (initialProps && Object.keys(initialProps).length > 0) {
                await get().updateArea(existing.id, { ...initialProps });
            }
            return;
        }
        const maxOrder = allAreas.reduce(
            (max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1),
            -1
        );
        const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
        const newArea: Area = {
            id: uuidv4(),
            name: trimmedName,
            ...initialProps,
            order: baseOrder,
            createdAt: initialProps?.createdAt ?? now,
            updatedAt: now,
        };
        const newAllAreas = [...allAreas, newArea].sort((a, b) => a.order - b.order);
        set({ areas: newAllAreas, _allAreas: newAllAreas, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: get()._allTasks, projects: get()._allProjects, areas: newAllAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    updateArea: async (id: string, updates: Partial<Area>) => {
        const allAreas = get()._allAreas;
        const area = allAreas.find(a => a.id === id);
        if (!area) return;
        if (updates.name) {
            const trimmedName = updates.name.trim();
            if (!trimmedName) return;
            const normalized = trimmedName.toLowerCase();
            const existing = allAreas.find((a) => a.id !== id && a?.name?.trim().toLowerCase() === normalized);
            if (existing) {
                const now = new Date().toISOString();
                const mergedArea: Area = { ...existing, ...updates, name: trimmedName, updatedAt: now };
                const newAllAreas = allAreas
                    .filter((a) => a.id !== id && a.id !== existing.id)
                    .concat(mergedArea)
                    .sort((a, b) => a.order - b.order);
                const newAllProjects = get()._allProjects.map((project) => {
                    if (project.areaId !== id) return project;
                    return { ...project, areaId: existing.id, updatedAt: now };
                });
                const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
                set({
                    areas: newAllAreas,
                    _allAreas: newAllAreas,
                    projects: newVisibleProjects,
                    _allProjects: newAllProjects,
                    lastDataChangeAt: Date.now(),
                });
                debouncedSave(
                    { tasks: get()._allTasks, projects: newAllProjects, areas: newAllAreas, settings: get().settings },
                    (msg) => set({ error: msg })
                );
                return;
            }
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const nextOrder = Number.isFinite(updates.order) ? (updates.order as number) : area.order;
        const nextName = updates.name ? updates.name.trim() : area.name;
        const newAllAreas = allAreas
            .map(a => (a.id === id ? { ...a, ...updates, name: nextName, order: nextOrder, updatedAt: now } : a))
            .sort((a, b) => a.order - b.order);
        set({ areas: newAllAreas, _allAreas: newAllAreas, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: get()._allTasks, projects: get()._allProjects, areas: newAllAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    deleteArea: async (id: string) => {
        const allAreas = get()._allAreas;
        const areaExists = allAreas.some(a => a.id === id);
        if (!areaExists) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const newAllAreas = allAreas.filter(a => a.id !== id).sort((a, b) => a.order - b.order);
        const newAllProjects = get()._allProjects.map((project) => {
            if (project.areaId !== id) return project;
            return { ...project, areaId: undefined, areaTitle: undefined, updatedAt: now };
        });
        const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
        set({
            areas: newAllAreas,
            _allAreas: newAllAreas,
            projects: newVisibleProjects,
            _allProjects: newAllProjects,
            lastDataChangeAt: changeAt,
        });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, areas: newAllAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    reorderAreas: async (orderedIds: string[]) => {
        if (orderedIds.length === 0) return;
        const allAreas = get()._allAreas;
        const areaById = new Map(allAreas.map(area => [area.id, area]));
        const seen = new Set<string>();
        const now = new Date().toISOString();

        const reordered: Area[] = [];
        orderedIds.forEach((id, index) => {
            const area = areaById.get(id);
            if (!area) return;
            seen.add(id);
            reordered.push({ ...area, order: index, updatedAt: now });
        });

        const remaining = allAreas
            .filter(area => !seen.has(area.id))
            .sort((a, b) => a.order - b.order)
            .map((area, idx) => ({
                ...area,
                order: reordered.length + idx,
                updatedAt: now,
            }));

        const newAllAreas = [...reordered, ...remaining];
        set({ areas: newAllAreas, _allAreas: newAllAreas, lastDataChangeAt: Date.now() });
        debouncedSave(
            { tasks: get()._allTasks, projects: get()._allProjects, areas: newAllAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    reorderProjects: async (orderedIds: string[], areaId?: string) => {
        if (orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const targetAreaId = areaId ?? undefined;
        const allProjects = get()._allProjects;
        const isInArea = (project: Project) => (project.areaId ?? undefined) === targetAreaId && !project.deletedAt;

        const areaProjects = allProjects.filter(isInArea);
        const orderedSet = new Set(orderedIds);
        const remaining = areaProjects
            .filter((project) => !orderedSet.has(project.id))
            .sort((a, b) => (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0));

        const finalIds = [...orderedIds, ...remaining.map((project) => project.id)];
        const orderById = new Map<string, number>();
        finalIds.forEach((id, index) => {
            orderById.set(id, index);
        });

        const newAllProjects = allProjects.map((project) => {
            if (!isInArea(project)) return project;
            const nextOrder = orderById.get(project.id);
            if (!Number.isFinite(nextOrder)) return project;
            return { ...project, order: nextOrder as number, updatedAt: now };
        });

        const newVisibleProjects = newAllProjects.filter((p) => !p.deletedAt);
        set({ projects: newVisibleProjects, _allProjects: newAllProjects, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    reorderProjectTasks: async (projectId: string, orderedIds: string[]) => {
        if (!projectId || orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const allTasks = get()._allTasks;
        const isInProject = (task: Task) => task.projectId === projectId && !task.deletedAt;

        const projectTasks = allTasks.filter(isInProject);
        const orderedSet = new Set(orderedIds);
        const remaining = projectTasks
            .filter((task) => !orderedSet.has(task.id))
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.orderNum) ? (a.orderNum as number) : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.orderNum) ? (b.orderNum as number) : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });

        const finalIds = [...orderedIds, ...remaining.map((task) => task.id)];
        const orderById = new Map<string, number>();
        finalIds.forEach((id, index) => {
            orderById.set(id, index);
        });

        const newAllTasks = allTasks.map((task) => {
            if (!isInProject(task)) return task;
            const nextOrder = orderById.get(task.id);
            if (!Number.isFinite(nextOrder)) return task;
            return { ...task, orderNum: nextOrder as number, updatedAt: now };
        });

        const newVisibleTasks = newAllTasks.filter((task) => !task.deletedAt && task.status !== 'archived');
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    deleteTag: async (tagId: string) => {
        const normalizedTarget = normalizeTagId(tagId);
        if (!normalizedTarget) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();

        const newAllTasks = get()._allTasks.map((task) => {
            if (!task.tags || task.tags.length === 0) return task;
            const filtered = task.tags.filter((tag) => normalizeTagId(tag) !== normalizedTarget);
            if (filtered.length === task.tags.length) return task;
            return { ...task, tags: filtered, updatedAt: now };
        });

        const newAllProjects = get()._allProjects.map((project) => {
            if (!project.tagIds || project.tagIds.length === 0) return project;
            const filtered = project.tagIds.filter((tag) => normalizeTagId(tag) !== normalizedTarget);
            if (filtered.length === project.tagIds.length) return project;
            return { ...project, tagIds: filtered, updatedAt: now };
        });

        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt && t.status !== 'archived');
        const newVisibleProjects = newAllProjects.filter((p) => !p.deletedAt);

        set({
            tasks: newVisibleTasks,
            projects: newVisibleProjects,
            _allTasks: newAllTasks,
            _allProjects: newAllProjects,
            lastDataChangeAt: changeAt,
        });

        debouncedSave(
            { tasks: newAllTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Update application settings.
     * @param updates Settings to update
     */
    updateSettings: async (updates: Partial<AppData['settings']>) => {
        const newSettings = { ...get().settings, ...updates };
        const archiveDaysUpdate = updates.gtd?.autoArchiveDays !== undefined;

        if (archiveDaysUpdate) {
            const configuredArchiveDays = newSettings.gtd?.autoArchiveDays;
            const archiveDays = Number.isFinite(configuredArchiveDays)
                ? Math.max(0, Math.floor(configuredArchiveDays as number))
                : 7;
            const shouldAutoArchive = archiveDays > 0;
            const cutoffMs = shouldAutoArchive ? Date.now() - archiveDays * 24 * 60 * 60 * 1000 : 0;
            const nowIso = new Date().toISOString();
            let didAutoArchive = false;

            let newAllTasks = get()._allTasks;
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
                    };
                });
            }

            if (didAutoArchive) {
                const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt && t.status !== 'archived');
                set({
                    tasks: newVisibleTasks,
                    _allTasks: newAllTasks,
                    settings: newSettings,
                    lastDataChangeAt: Date.now(),
                });
                debouncedSave(
                    { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: newSettings },
                    (msg) => set({ error: msg })
                );
                return;
            }
        }

        set({ settings: newSettings });
        debouncedSave(
            { tasks: get()._allTasks, projects: get()._allProjects, areas: get()._allAreas, settings: newSettings },
            (msg) => set({ error: msg })
        );
    },
    setHighlightTask: (id: string | null) => {
        set({ highlightTaskId: id, highlightTaskAt: id ? Date.now() : null });
    },
}));
