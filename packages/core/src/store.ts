import { create } from 'zustand';
import { generateUUID as uuidv4 } from './uuid';
import { Task, TaskStatus, AppData, Project } from './types';
import { StorageAdapter, noopStorage } from './storage';
import { createNextRecurringTask } from './recurrence';
import { getDeferredTaskUpdates, DeferPreset } from './defer-utils';

let storage: StorageAdapter = noopStorage;

function applyTaskUpdates(oldTask: Task, updates: Partial<Task>, now: string): { updatedTask: Task; nextRecurringTask: Task | null } {
    const incomingStatus = updates.status ?? oldTask.status;
    const statusChanged = incomingStatus !== oldTask.status;

    let finalUpdates: Partial<Task> = updates;
    let nextRecurringTask: Task | null = null;

    if (statusChanged && (incomingStatus === 'done' || incomingStatus === 'archived')) {
        finalUpdates = {
            ...updates,
            status: incomingStatus,
            completedAt: now,
            isFocusedToday: false,
        };
        nextRecurringTask = createNextRecurringTask(oldTask, now, oldTask.status);
    } else if (statusChanged && (oldTask.status === 'done' || oldTask.status === 'archived')) {
        finalUpdates = {
            ...updates,
            status: incomingStatus,
            completedAt: undefined,
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
    settings: AppData['settings'];
    isLoading: boolean;
    error: string | null;

    // Internal: full data including tombstones (not exposed to UI)
    _allTasks: Task[];
    _allProjects: Project[];

    // Actions
    /** Load all data from storage */
    fetchData: () => Promise<void>;
    /** Add a new task */
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<void>;
    /** Update an existing task */
    updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
    /** Soft-delete a task */
    deleteTask: (id: string) => Promise<void>;
    /** Move task to a different status */
    moveTask: (id: string, newStatus: TaskStatus) => Promise<void>;
    /** Defer task dates using a preset */
    deferTask: (id: string, preset: DeferPreset) => Promise<void>;
    /** Batch update multiple tasks */
    batchUpdateTasks: (updates: Array<{ id: string; updates: Partial<Task> }>) => Promise<void>;
    /** Batch move tasks to a status */
    batchMoveTasks: (ids: string[], newStatus: TaskStatus) => Promise<void>;
    /** Batch soft-delete tasks */
    batchDeleteTasks: (ids: string[]) => Promise<void>;

    // Project Actions
    /** Add a new project */
    addProject: (title: string, color: string) => Promise<void>;
    /** Update a project */
    updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
    /** Delete a project */
    deleteProject: (id: string) => Promise<void>;
    /** Toggle focus status of a project (max 5) */
    toggleProjectFocus: (id: string) => Promise<void>;

    // Settings Actions
    /** Update application settings */
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
}

// Debounce save helper - captures data snapshot immediately to prevent stale state saves
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingData: AppData | null = null;
let pendingOnError: ((msg: string) => void) | null = null;

/**
 * Save data with a debounce delay.
 * Captures current state snapshot immediately to avoid race conditions.
 * @param data Snapshot of data to save (must include ALL items including tombstones)
 * @param onError Callback for save failures
 */
const debouncedSave = (data: AppData, onError?: (msg: string) => void) => {
    // Capture snapshot of data immediately to prevent stale state saves
    pendingData = { ...data, tasks: [...data.tasks], projects: [...data.projects] };
    if (onError) pendingOnError = onError;

    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (pendingData) {
            const onErrorCallback = pendingOnError;
            storage.saveData(pendingData).catch(e => {
                console.error(e);
                if (onErrorCallback) onErrorCallback('Failed to save data');
            });
            pendingData = null;
            pendingOnError = null;
        }
        saveTimeout = null;
    }, 1000);
};

/**
 * Immediately save any pending debounced data.
 * Call this when the app goes to background or is about to be terminated.
 */
export const flushPendingSave = async (): Promise<void> => {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
    }
    if (pendingData) {
        try {
            await storage.saveData(pendingData);
            pendingData = null;
            pendingOnError = null;
        } catch (e) {
            console.error('Failed to flush pending save:', e);
            if (pendingOnError) {
                pendingOnError('Failed to save data on exit');
                pendingOnError = null;
            }
        }
    }
};

export const useTaskStore = create<TaskStore>((set, get) => ({
    tasks: [],
    projects: [],
    settings: {},
    isLoading: false,
    error: null,
    // Internal: full data including tombstones
    _allTasks: [],
    _allProjects: [],

    /**
     * Fetch all data from the configured storage adapter.
     * Stores full data internally, filters for UI display.
     */
    fetchData: async () => {
        set({ isLoading: true, error: null });
        try {
            const data = await storage.getData();
            // Store ALL data including tombstones for persistence
            const allTasks = data.tasks || [];
            const allProjects = data.projects || [];
            // Filter out soft-deleted items for UI display
            const visibleTasks = allTasks.filter(t => !t.deletedAt);
            const visibleProjects = allProjects.filter(p => !p.deletedAt);
            set({
                tasks: visibleTasks,
                projects: visibleProjects,
                settings: data.settings || {},
                _allTasks: allTasks,
                _allProjects: allProjects,
                isLoading: false
            });
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
        const newTask: Task = {
            id: uuidv4(),
            title,
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...initialProps,
        };

        const newAllTasks = [...get()._allTasks, newTask];
        const newVisibleTasks = [...get().tasks, newTask];
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Update an existing task.
     * @param id Task ID
     * @param updates Properties to update
     */
    updateTask: async (id: string, updates: Partial<Task>) => {
        const now = new Date().toISOString();
        const oldTask = get()._allTasks.find((t) => t.id === id);

        if (!oldTask) {
            const newAllTasks = get()._allTasks.map((task) =>
                task.id === id ? { ...task, ...updates, updatedAt: now } : task
            );
            const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt);
            set({ tasks: newVisibleTasks, _allTasks: newAllTasks });
            debouncedSave(
                { tasks: newAllTasks, projects: get()._allProjects, settings: get().settings },
                (msg) => set({ error: msg })
            );
            return;
        }

        const { updatedTask, nextRecurringTask } = applyTaskUpdates(oldTask, updates, now);

        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id ? updatedTask : task
        );

        if (nextRecurringTask) newAllTasks.push(nextRecurringTask);

        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Soft-delete a task by setting deletedAt.
     * @param id Task ID
     */
    deleteTask: async (id: string) => {
        const now = new Date().toISOString();
        // Update in full data (set tombstone)
        const newAllTasks = get()._allTasks.map((task) =>
            task.id === id ? { ...task, deletedAt: now, updatedAt: now } : task
        );
        // Filter for UI state (hide deleted)
        const newVisibleTasks = newAllTasks.filter(t => !t.deletedAt);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks });
        // Save with all data including tombstones
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, settings: get().settings },
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
     * Defer a task's scheduled dates using a preset.
     * Updates any existing start/due/review dates, or creates a due date if none exist.
     */
    deferTask: async (id: string, preset: DeferPreset) => {
        const task = get()._allTasks.find((t) => t.id === id);
        if (!task) return;
        const updates = getDeferredTaskUpdates(task, preset, new Date());
        await get().updateTask(id, updates);
    },

    /**
     * Batch update tasks in a single save cycle.
     */
    batchUpdateTasks: async (updatesList: Array<{ id: string; updates: Partial<Task> }>) => {
        if (updatesList.length === 0) return;
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

        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    batchMoveTasks: async (ids: string[], newStatus: TaskStatus) => {
        await get().batchUpdateTasks(ids.map((id) => ({ id, updates: { status: newStatus } })));
    },

    batchDeleteTasks: async (ids: string[]) => {
        if (ids.length === 0) return;
        const now = new Date().toISOString();
        const idSet = new Set(ids);
        const newAllTasks = get()._allTasks.map((task) =>
            idSet.has(task.id) ? { ...task, deletedAt: now, updatedAt: now } : task
        );
        const newVisibleTasks = newAllTasks.filter((t) => !t.deletedAt);
        set({ tasks: newVisibleTasks, _allTasks: newAllTasks });
        debouncedSave(
            { tasks: newAllTasks, projects: get()._allProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Add a new project.
     * @param title Project title
     * @param color Project color hex code
     */
    addProject: async (title: string, color: string) => {
        const newProject: Project = {
            id: uuidv4(),
            title,
            color,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const newAllProjects = [...get()._allProjects, newProject];
        const newVisibleProjects = [...get().projects, newProject];
        set({ projects: newVisibleProjects, _allProjects: newAllProjects });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Update an existing project.
     * @param id Project ID
     * @param updates Properties to update
     */
    updateProject: async (id: string, updates: Partial<Project>) => {
        const now = new Date().toISOString();
        const allProjects = get()._allProjects;
        const oldProject = allProjects.find(p => p.id === id);

        const incomingStatus = updates.status ?? oldProject?.status;
        const statusChanged = !!oldProject && !!incomingStatus && incomingStatus !== oldProject.status;

        let newAllTasks = get()._allTasks;

        if (statusChanged && (incomingStatus === 'completed' || incomingStatus === 'archived')) {
            const taskStatus = incomingStatus === 'completed' ? 'done' : 'archived';
            newAllTasks = newAllTasks.map(task => {
                if (
                    task.projectId === id &&
                    !task.deletedAt &&
                    task.status !== 'done' &&
                    task.status !== 'archived'
                ) {
                    return {
                        ...task,
                        status: taskStatus,
                        completedAt: now,
                        isFocusedToday: false,
                        updatedAt: now,
                    };
                }
                return task;
            });
        }

        const finalProjectUpdates: Partial<Project> = {
            ...updates,
            ...(statusChanged && (incomingStatus === 'completed' || incomingStatus === 'archived')
                ? { isFocused: false }
                : {}),
        };

        const newAllProjects = allProjects.map(project =>
            project.id === id ? { ...project, ...finalProjectUpdates, updatedAt: now } : project
        );

        const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
        const newVisibleTasks = newAllTasks.filter(t => !t.deletedAt);

        set({
            projects: newVisibleProjects,
            _allProjects: newAllProjects,
            tasks: newVisibleTasks,
            _allTasks: newAllTasks,
        });

        debouncedSave(
            { tasks: newAllTasks, projects: newAllProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Soft-delete a project and all its tasks.
     * @param id Project ID
     */
    deleteProject: async (id: string) => {
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
        const newVisibleTasks = newAllTasks.filter(t => !t.deletedAt);
        set({
            projects: newVisibleProjects,
            tasks: newVisibleTasks,
            _allProjects: newAllProjects,
            _allTasks: newAllTasks
        });
        // Save with all data including tombstones
        debouncedSave(
            { tasks: newAllTasks, projects: newAllProjects, settings: get().settings },
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

        // If turning on focus, check if we already have 5 focused
        const focusedCount = allProjects.filter(p => p.isFocused && !p.deletedAt).length;
        const isCurrentlyFocused = project.isFocused;

        // Don't allow more than 5 focused projects
        if (!isCurrentlyFocused && focusedCount >= 5) {
            return;
        }

        const now = new Date().toISOString();
        const newAllProjects = allProjects.map(p =>
            p.id === id ? { ...p, isFocused: !p.isFocused, updatedAt: now } : p
        );
        const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
        set({ projects: newVisibleProjects, _allProjects: newAllProjects });
        debouncedSave(
            { tasks: get()._allTasks, projects: newAllProjects, settings: get().settings },
            (msg) => set({ error: msg })
        );
    },

    /**
     * Update application settings.
     * @param updates Settings to update
     */
    updateSettings: async (updates: Partial<AppData['settings']>) => {
        const newSettings = { ...get().settings, ...updates };
        set({ settings: newSettings });
        debouncedSave(
            { tasks: get()._allTasks, projects: get()._allProjects, settings: newSettings },
            (msg) => set({ error: msg })
        );
    },
}));
