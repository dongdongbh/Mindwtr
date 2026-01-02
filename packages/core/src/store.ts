import { create } from 'zustand';
import { generateUUID as uuidv4 } from './uuid';
import { Task, TaskStatus, AppData, Project, Area } from './types';
import { StorageAdapter, noopStorage } from './storage';
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

/**
 * Configure the storage adapter to use for persistence.
 * Must be called before using the store.
 */
export const setStorageAdapter = (adapter: StorageAdapter) => {
    storage = adapter;
};

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

    // Project Actions
    /** Add a new project */
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<void>;
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

    // Settings Actions
    /** Update application settings */
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    /** Highlight a task in UI lists (non-persistent) */
    setHighlightTask: (id: string | null) => void;
}

// Save queue helper - coalesces writes while ensuring the latest snapshot is persisted quickly.
let pendingData: AppData | null = null;
let pendingOnError: ((msg: string) => void) | null = null;
let saveInFlight: Promise<void> | null = null;

/**
 * Save data with write coalescing.
 * Captures a snapshot immediately and serializes writes to avoid lost updates.
 * @param data Snapshot of data to save (must include ALL items including tombstones)
 * @param onError Callback for save failures
 */
const debouncedSave = (data: AppData, onError?: (msg: string) => void) => {
    pendingData = {
        ...data,
        tasks: [...data.tasks],
        projects: [...data.projects],
        areas: [...(data.areas || [])],
    };
    if (onError) pendingOnError = onError;
    void flushPendingSave();
};

/**
 * Immediately save any pending debounced data.
 * Call this when the app goes to background or is about to be terminated.
 */
export const flushPendingSave = async (): Promise<void> => {
    if (saveInFlight || !pendingData) return;
    const dataToSave = pendingData;
    const onErrorCallback = pendingOnError;
    pendingData = null;
    pendingOnError = null;
    saveInFlight = storage.saveData(dataToSave).catch((e) => {
        console.error('Failed to flush pending save:', e);
        if (onErrorCallback) {
            onErrorCallback('Failed to save data');
        }
    }).finally(() => {
        saveInFlight = null;
        if (pendingData) {
            void flushPendingSave();
        }
    });
    await saveInFlight;
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
        set({ isLoading: true, error: null });
        try {
            const data = await storage.getData();
            const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
            const rawProjects = Array.isArray(data.projects) ? data.projects : [];
            const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
            const rawAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            // Store ALL data including tombstones for persistence
            const nowIso = new Date().toISOString();
            let allTasks = rawTasks.map((task) => normalizeTaskForLoad(task, nowIso));

            // Auto-archive stale completed items to keep day-to-day UI fast/clean.
            const configuredArchiveDays = (rawSettings as AppData['settings']).gtd?.autoArchiveDays;
            const archiveDays = Number.isFinite(configuredArchiveDays)
                ? Math.max(0, Math.floor(configuredArchiveDays as number))
                : 7;
            const shouldAutoArchive = archiveDays > 0;
            const cutoffMs = shouldAutoArchive ? Date.now() - archiveDays * 24 * 60 * 60 * 1000 : 0;
            let didAutoArchive = false;
            if (shouldAutoArchive) {
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
            const allProjects = rawProjects.map((project) => {
                const status = project.status;
                const normalizedStatus =
                    status === 'active' || status === 'someday' || status === 'waiting' || status === 'archived'
                        ? status
                        : status === 'completed'
                            ? 'archived'
                            : 'active';
                return normalizedStatus === status ? project : { ...project, status: normalizedStatus };
            });
            const allAreas = rawAreas
                .map((area, index) => ({
                    ...area,
                    order: Number.isFinite(area.order) ? area.order : index,
                }))
                .sort((a, b) => a.order - b.order);
            // Filter out soft-deleted and archived items for day-to-day UI display
            const visibleTasks = allTasks.filter(t => !t.deletedAt && t.status !== 'archived');
            const visibleProjects = allProjects.filter(p => !p.deletedAt);
            set({
                tasks: visibleTasks,
                projects: visibleProjects,
                areas: allAreas,
                settings: rawSettings as AppData['settings'],
                _allTasks: allTasks,
                _allProjects: allProjects,
                _allAreas: allAreas,
                isLoading: false,
                lastDataChangeAt: didAutoArchive ? Date.now() : get().lastDataChangeAt,
            });

            if (didAutoArchive) {
                debouncedSave(
                    { tasks: allTasks, projects: allProjects, areas: allAreas, settings: rawSettings as AppData['settings'] },
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
        };

        const newAllTasks = [...get()._allTasks, newTask];
        const newVisibleTasks = [...get().tasks, newTask];
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
        const oldTask = get()._allTasks.find((t) => t.id === id);

        if (!oldTask) {
            return;
        }

        const { updatedTask, nextRecurringTask } = applyTaskUpdates(oldTask, updates, now);

        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id ? updatedTask : task
        );

        if (nextRecurringTask) newAllTasks.push(nextRecurringTask);

        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt && t.status !== 'archived');
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
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
        // Update in full data (set tombstone)
        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id ? { ...task, deletedAt: now, updatedAt: now } : task
        );
        // Filter for UI state (hide deleted)
        const newVisibleTasks = newAllTasks.filter(t => !t.deletedAt && t.status !== 'archived');
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        // Save with all data including tombstones
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
        };

        const newAllTasks = [...get()._allTasks, newTask];
        const newVisibleTasks = newAllTasks.filter((task) => !task.deletedAt && task.status !== 'archived');
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
        const newVisibleTasks = newAllTasks.filter((task) => !task.deletedAt && task.status !== 'archived');
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

        const newAllTasks = get()._allTasks.map((task) => {
            const updates = updatesById.get(task.id);
            if (!updates) return task;
            const { updatedTask, nextRecurringTask } = applyTaskUpdates(task, updates, now);
            if (nextRecurringTask) nextRecurringTasks.push(nextRecurringTask);
            return updatedTask;
        });

        if (nextRecurringTasks.length > 0) newAllTasks.push(...nextRecurringTasks);

        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt && t.status !== 'archived');
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    batchMoveTasks: async (ids: string[], newStatus: TaskStatus) => {
        await get().batchUpdateTasks(ids.map((id) => ({ id, updates: { status: newStatus } })));
    },

    batchDeleteTasks: async (ids: string[]) => {
        if (ids.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const idSet = new Set(ids);
        const newAllTasks = get()._allTasks.map((task) =>
            idSet.has(task.id) ? { ...task, deletedAt: now, updatedAt: now } : task
        );
        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt && t.status !== 'archived');
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Add a new project.
     * @param title Project title
     * @param color Project color hex code
     */
    addProject: async (title: string, color: string, initialProps?: Partial<Project>) => {
        const changeAt = Date.now();
        const newProject: Project = {
            id: uuidv4(),
            title,
            color,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...initialProps,
        };
        const newAllProjects = [...get()._allProjects, newProject];
        const newVisibleProjects = [...get().projects, newProject];
        set({ projects: newVisibleProjects, _allProjects: newAllProjects, lastDataChangeAt: changeAt });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, areas: get()._allAreas, settings: get().settings },
            (msg) => set({ error: msg })
        );
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

        const finalProjectUpdates: Partial<Project> = {
            ...updates,
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
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const allAreas = get()._allAreas;
        const maxOrder = allAreas.reduce(
            (max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1),
            -1
        );
        const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
        const newArea: Area = {
            id: uuidv4(),
            name,
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
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const nextOrder = Number.isFinite(updates.order) ? (updates.order as number) : area.order;
        const newAllAreas = allAreas
            .map(a => (a.id === id ? { ...a, ...updates, order: nextOrder, updatedAt: now } : a))
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
