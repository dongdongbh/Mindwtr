import type { AppData, Task, TaskStatus } from './types';
import type { StorageAdapter, TaskQueryOptions } from './storage';
import type { StoreActionResult, TaskStore } from './store-types';
import {
    applyTaskUpdates,
    buildSaveSnapshot,
    ensureDeviceId,
    getTaskOrder,
    getReferenceTaskFieldClears,
    isTaskVisible,
    normalizeRevision,
    reserveNextProjectOrder,
    updateVisibleTasks,
} from './store-helpers';
import { logWarn } from './logger';
import { generateUUID as uuidv4 } from './uuid';

const stripAttachmentRemoteMetadata = (attachments: Task['attachments']): Task['attachments'] =>
    attachments?.map((attachment) => (
        attachment.kind === 'file'
            ? {
                ...attachment,
                cloudKey: undefined,
                localStatus: undefined,
            }
            : attachment
    ));

type TaskActions = Pick<
    TaskStore,
    | 'addTask'
    | 'updateTask'
    | 'deleteTask'
    | 'restoreTask'
    | 'purgeTask'
    | 'purgeDeletedTasks'
    | 'duplicateTask'
    | 'resetTaskChecklist'
    | 'moveTask'
    | 'batchUpdateTasks'
    | 'batchMoveTasks'
    | 'batchDeleteTasks'
    | 'queryTasks'
>;

type TaskActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    getStorage: () => StorageAdapter;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
};

const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
const actionFail = (error: string): StoreActionResult => ({ success: false, error });
const MAX_FOCUS_TASKS = 3;
const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);
const normalizeOptionalReferenceId = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);
const normalizeProjectIdInput = normalizeOptionalReferenceId;

const validateExistingProjectId = (
    projectId: unknown,
    allProjects: AppData['projects']
): { ok: true; projectId?: string } | { ok: false; error: string } => {
    const normalizedProjectId = normalizeProjectIdInput(projectId);
    if (!normalizedProjectId) {
        return { ok: true, projectId: undefined };
    }
    const exists = allProjects.some((project) => project.id === normalizedProjectId && !project.deletedAt);
    if (exists) {
        return { ok: true, projectId: normalizedProjectId };
    }
    return { ok: false, error: 'Project not found' };
};

const validateExistingAreaId = (
    areaId: unknown,
    allAreas: AppData['areas']
): { ok: true; areaId?: string } | { ok: false; error: string } => {
    const normalizedAreaId = normalizeOptionalReferenceId(areaId);
    if (!normalizedAreaId) {
        return { ok: true, areaId: undefined };
    }
    const exists = allAreas.some((area) => area.id === normalizedAreaId && !area.deletedAt);
    if (exists) {
        return { ok: true, areaId: normalizedAreaId };
    }
    return { ok: false, error: 'Area not found' };
};

const resolveTaskContainerAssignment = ({
    projectId,
    sectionId,
    areaId,
    allProjects,
    allSections,
    allAreas,
}: {
    projectId: unknown;
    sectionId: unknown;
    areaId: unknown;
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];
}):
    | { ok: true; projectId?: string; sectionId?: string; areaId?: string }
    | { ok: false; error: string } => {
    const projectValidation = validateExistingProjectId(projectId, allProjects);
    if (!projectValidation.ok) return projectValidation;

    let resolvedProjectId = projectValidation.projectId;
    const resolvedSectionId = normalizeOptionalReferenceId(sectionId);
    if (resolvedSectionId) {
        const section = allSections.find((candidate) => candidate.id === resolvedSectionId && !candidate.deletedAt);
        if (!section) {
            return { ok: false, error: 'Section not found' };
        }
        const liveProjectExists = allProjects.some((candidate) => candidate.id === section.projectId && !candidate.deletedAt);
        if (!liveProjectExists) {
            return { ok: false, error: 'Section not found' };
        }
        if (resolvedProjectId && section.projectId !== resolvedProjectId) {
            return { ok: false, error: 'Section does not belong to project' };
        }
        resolvedProjectId = section.projectId;
    }

    if (resolvedProjectId) {
        return {
            ok: true,
            projectId: resolvedProjectId,
            sectionId: resolvedSectionId,
            areaId: undefined,
        };
    }

    const areaValidation = validateExistingAreaId(areaId, allAreas);
    if (!areaValidation.ok) return areaValidation;

    return {
        ok: true,
        projectId: undefined,
        sectionId: undefined,
        areaId: areaValidation.areaId,
    };
};

const prepareTaskUpdatesForStore = ({
    task,
    updates,
    allTasks,
    allProjects,
    allSections,
    allAreas,
}: {
    task: Task;
    updates: Partial<Task>;
    allTasks: Task[];
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];
}): { ok: true; updates: Partial<Task> } | { ok: false; error: string } => {
    const resolveEffectiveContainer = (candidateUpdates: Partial<Task>) => resolveTaskContainerAssignment({
        projectId: hasOwnField(candidateUpdates, 'projectId') ? candidateUpdates.projectId : task.projectId,
        sectionId: hasOwnField(candidateUpdates, 'sectionId') ? candidateUpdates.sectionId : task.sectionId,
        areaId: hasOwnField(candidateUpdates, 'areaId') ? candidateUpdates.areaId : task.areaId,
        allProjects,
        allSections,
        allAreas,
    });

    let adjustedUpdates = normalizeTaskUpdateForStore({
        task,
        updates,
        allTasks,
    });

    const firstResolution = resolveEffectiveContainer(adjustedUpdates);
    if (!firstResolution.ok) return firstResolution;

    adjustedUpdates = normalizeTaskUpdateForStore({
        task,
        updates: {
            ...adjustedUpdates,
            projectId: firstResolution.projectId,
            sectionId: firstResolution.sectionId,
            areaId: firstResolution.areaId,
        },
        allTasks,
    });

    const finalResolution = resolveEffectiveContainer(adjustedUpdates);
    if (!finalResolution.ok) return finalResolution;

    return {
        ok: true,
        updates: {
            ...adjustedUpdates,
            projectId: finalResolution.projectId,
            sectionId: finalResolution.sectionId,
            areaId: finalResolution.areaId,
        },
    };
};

const normalizeTaskUpdateForStore = ({
    task,
    updates,
    allTasks,
}: {
    task: Task;
    updates: Partial<Task>;
    allTasks: Task[];
}): Partial<Task> => {
    let adjustedUpdates = updates;
    const hasOrder = Object.prototype.hasOwnProperty.call(updates, 'order');
    const hasOrderNum = Object.prototype.hasOwnProperty.call(updates, 'orderNum');
    if (hasOrder || hasOrderNum) {
        const normalizedOrder = getTaskOrder(updates);
        adjustedUpdates = {
            ...adjustedUpdates,
            order: normalizedOrder,
            orderNum: normalizedOrder,
        };
    }
    if (!Object.prototype.hasOwnProperty.call(updates, 'projectId')) {
        return adjustedUpdates;
    }

    const rawProjectId = updates.projectId;
    const normalizedProjectId =
        typeof rawProjectId === 'string' && rawProjectId.trim().length > 0
            ? rawProjectId
            : undefined;
    const nextProjectId = normalizedProjectId ?? undefined;
    const projectChanged = (task.projectId ?? undefined) !== nextProjectId;
    if (projectChanged) {
        const shouldClearSection = !Object.prototype.hasOwnProperty.call(updates, 'sectionId');
        const hasTaskOrderOverride = hasOrder || hasOrderNum;
        if (nextProjectId) {
            if (!hasTaskOrderOverride) {
                const nextOrder = reserveNextProjectOrder(nextProjectId, allTasks);
                adjustedUpdates = {
                    ...adjustedUpdates,
                    order: nextOrder,
                    orderNum: nextOrder,
                };
            }
            if (!Object.prototype.hasOwnProperty.call(updates, 'areaId')) {
                adjustedUpdates = {
                    ...adjustedUpdates,
                    areaId: undefined,
                };
            }
            if (shouldClearSection) {
                adjustedUpdates = {
                    ...adjustedUpdates,
                    sectionId: undefined,
                };
            }
        } else {
            adjustedUpdates = {
                ...adjustedUpdates,
                projectId: undefined,
                order: undefined,
                orderNum: undefined,
                sectionId: undefined,
            };
        }
    } else if (normalizedProjectId !== updates.projectId) {
        adjustedUpdates = {
            ...adjustedUpdates,
            projectId: normalizedProjectId,
        };
    }

    return adjustedUpdates;
};

export const createTaskActions = ({ set, get, getStorage, debouncedSave }: TaskActionContext): TaskActions => ({
    /**
     * Add a new task to the store and persist to storage.
     * @param title Task title
     * @param initialProps Optional initial properties
     */
    addTask: async (title: string, initialProps?: Partial<Task>) => {
        const changeAt = Date.now();
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            const message = 'Task title is required';
            set({ error: message });
            return actionFail(message);
        }
        const currentState = get();
        const containerResolution = resolveTaskContainerAssignment({
            projectId: initialProps?.projectId,
            sectionId: initialProps?.sectionId,
            areaId: initialProps?.areaId,
            allProjects: currentState._allProjects,
            allSections: currentState._allSections,
            allAreas: currentState._allAreas,
        });
        if (!containerResolution.ok) {
            set({ error: containerResolution.error });
            return actionFail(containerResolution.error);
        }
        const resolvedStatus = (initialProps?.status ?? 'inbox') as TaskStatus;
        const hasTaskOrder = Object.prototype.hasOwnProperty.call(initialProps ?? {}, 'order')
            || Object.prototype.hasOwnProperty.call(initialProps ?? {}, 'orderNum');
        const resolvedProjectId = containerResolution.projectId;
        const resolvedSectionId = containerResolution.sectionId;
        const resolvedAreaId = containerResolution.areaId;
        const referenceClears = resolvedStatus === 'reference'
            ? getReferenceTaskFieldClears()
            : {};
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let createdTaskId = '';

        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const deviceId = deviceState.deviceId;
            const explicitOrder = getTaskOrder(initialProps ?? {});
            const resolvedOrder = !hasTaskOrder && resolvedProjectId
                ? reserveNextProjectOrder(resolvedProjectId, state._allTasks)
                : explicitOrder;
            createdTaskId = uuidv4();
            const newTask: Task = {
                ...initialProps,
                id: createdTaskId,
                title: trimmedTitle,
                status: resolvedStatus,
                taskMode: initialProps?.taskMode ?? 'task',
                tags: initialProps?.tags ?? [],
                contexts: initialProps?.contexts ?? [],
                pushCount: initialProps?.pushCount ?? 0,
                rev: 1,
                revBy: deviceId,
                createdAt: now,
                updatedAt: now,
                ...referenceClears,
                areaId: resolvedAreaId,
                projectId: resolvedProjectId,
                sectionId: resolvedSectionId,
                order: resolvedOrder,
                orderNum: resolvedOrder,
            };

            const newAllTasks = [...state._allTasks, newTask];
            const newVisibleTasks = updateVisibleTasks(state.tasks, null, newTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk({ id: createdTaskId });
    },

    /**
     * Update an existing task.
     * @param id Task ID
     * @param updates Properties to update
     */
    updateTask: async (id: string, updates: Partial<Task>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const currentState = get();
        const existingTask = currentState._allTasks.find((task) => task.id === id);
        if (!existingTask) {
            const message = 'Task not found';
            logWarn('updateTask skipped: task not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        const preparedUpdates = prepareTaskUpdatesForStore({
            task: existingTask,
            updates,
            allTasks: currentState._allTasks,
            allProjects: currentState._allProjects,
            allSections: currentState._allSections,
            allAreas: currentState._allAreas,
        });
        if (!preparedUpdates.ok) {
            set({ error: preparedUpdates.error });
            return actionFail(preparedUpdates.error);
        }
        const isPromotingTaskFocus = preparedUpdates.updates.isFocusedToday === true && existingTask.isFocusedToday !== true;
        if (isPromotingTaskFocus) {
            const focusedCount = currentState._allTasks.filter(
                (task) => task.isFocusedToday === true && !task.deletedAt
            ).length;
            if (focusedCount >= MAX_FOCUS_TASKS) {
                const message = `Maximum of ${MAX_FOCUS_TASKS} focused tasks allowed`;
                set({ error: message });
                return actionFail(message);
            }
        }
        let snapshot: AppData | null = null;
        set((state) => {
            const oldTask = state._allTasks.find((t) => t.id === id);
            if (!oldTask) {
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const nextRevision = {
                rev: normalizeRevision(oldTask.rev) + 1,
                revBy: deviceState.deviceId,
            };

            const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                oldTask,
                { ...preparedUpdates.updates, ...nextRevision },
                now
            );

            const updatedAllTasksBase = state._allTasks.map((task) =>
                task.id === id ? updatedTask : task
            );
            const updatedAllTasks = nextRecurringTask
                ? [...updatedAllTasksBase, nextRecurringTask]
                : updatedAllTasksBase;

            let updatedVisibleTasks = updateVisibleTasks(state.tasks, oldTask, updatedTask);
            if (nextRecurringTask) {
                updatedVisibleTasks = updateVisibleTasks(updatedVisibleTasks, null, nextRecurringTask);
            }
            snapshot = buildSaveSnapshot(state, {
                tasks: updatedAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: updatedVisibleTasks,
                _allTasks: updatedAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    /**
     * Soft-delete a task by setting deletedAt.
     * @param id Task ID
     */
    deleteTask: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        set((state) => {
            const oldTask = state._allTasks.find((task) => task.id === id);
            if (!oldTask) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const updatedTask = {
                ...oldTask,
                deletedAt: now,
                updatedAt: now,
                rev: normalizeRevision(oldTask.rev) + 1,
                revBy: deviceState.deviceId,
            };
            // Update in full data (set tombstone)
            const newAllTasks = state._allTasks.map((task) =>
                task.id === id ? updatedTask : task
            );
            // Filter for UI state (hide deleted)
            const newVisibleTasks = updateVisibleTasks(state.tasks, oldTask, updatedTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingTask ? actionFail('Task not found') : actionOk();
    },

    /**
     * Restore a soft-deleted task.
     */
    restoreTask: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        set((state) => {
            const oldTask = state._allTasks.find((task) => task.id === id);
            if (!oldTask) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const updatedTask = {
                ...oldTask,
                deletedAt: undefined,
                purgedAt: undefined,
                updatedAt: now,
                rev: normalizeRevision(oldTask.rev) + 1,
                revBy: deviceState.deviceId,
            };
            const newAllTasks = state._allTasks.map((task) =>
                task.id === id ? updatedTask : task
            );
            const newVisibleTasks = updateVisibleTasks(state.tasks, oldTask, updatedTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingTask ? actionFail('Task not found') : actionOk();
    },

    /**
     * Permanently delete a task (removes from storage).
     */
    purgeTask: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        set((state) => {
            const oldTask = state._allTasks.find((task) => task.id === id);
            if (!oldTask) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const updatedTask = {
                ...oldTask,
                deletedAt: oldTask.deletedAt ?? now,
                purgedAt: now,
                attachments: stripAttachmentRemoteMetadata(oldTask.attachments),
                updatedAt: now,
                rev: normalizeRevision(oldTask.rev) + 1,
                revBy: deviceState.deviceId,
            };
            const newAllTasks = state._allTasks.map((task) =>
                task.id === id ? updatedTask : task
            );
            const newVisibleTasks = updateVisibleTasks(state.tasks, oldTask, updatedTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingTask ? actionFail('Task not found') : actionOk();
    },

    /**
     * Permanently delete all soft-deleted tasks.
     */
    purgeDeletedTasks: async () => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) =>
                task.deletedAt
                    ? {
                        ...task,
                        purgedAt: now,
                        attachments: stripAttachmentRemoteMetadata(task.attachments),
                        updatedAt: now,
                        rev: normalizeRevision(task.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: state.tasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    /**
     * Duplicate a task for reusable lists/templates.
     */
    duplicateTask: async (id: string, asNextAction?: boolean) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        set((state) => {
            const sourceTask = state._allTasks.find((task) => task.id === id && !task.deletedAt);
            if (!sourceTask) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

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
            const duplicatedOrder = sourceTask.projectId
                ? reserveNextProjectOrder(sourceTask.projectId, state._allTasks)
                : undefined;

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
                rev: 1,
                revBy: deviceState.deviceId,
                order: duplicatedOrder,
                orderNum: duplicatedOrder,
            };

            const newAllTasks = [...state._allTasks, newTask];
            const newVisibleTasks = updateVisibleTasks(state.tasks, null, newTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingTask ? actionFail('Task not found') : actionOk();
    },

    /**
     * Reset checklist items to unchecked (useful for reusable lists).
     */
    resetTaskChecklist: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        set((state) => {
            const sourceTask = state._allTasks.find((task) => task.id === id && !task.deletedAt);
            if (!sourceTask || !sourceTask.checklist || sourceTask.checklist.length === 0) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

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
                rev: normalizeRevision(sourceTask.rev) + 1,
                revBy: deviceState.deviceId,
            };

            const newAllTasks = state._allTasks.map((task) => (task.id === id ? updatedTask : task));
            const newVisibleTasks = updateVisibleTasks(state.tasks, sourceTask, updatedTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingTask ? actionFail('Task not found') : actionOk();
    },

    /**
     * Move a task to a different status.
     * @param id Task ID
     * @param newStatus New status
     */
    moveTask: async (id: string, newStatus: TaskStatus) => {
        // Delegate to updateTask to ensure recurrence/metadata logic is applied
        return get().updateTask(id, { status: newStatus });
    },

    /**
     * Batch update tasks in a single save cycle.
     */
    batchUpdateTasks: async (updatesList: Array<{ id: string; updates: Partial<Task> }>) => {
        if (updatesList.length === 0) return actionOk();
        const state = get();
        const seenIds = new Set<string>();
        const duplicateIds = new Set<string>();
        for (const { id } of updatesList) {
            if (seenIds.has(id)) {
                duplicateIds.add(id);
                continue;
            }
            seenIds.add(id);
        }
        const duplicateTaskIds = Array.from(duplicateIds);
        if (duplicateTaskIds.length > 0) {
            const message = `Duplicate task ids in batch update: ${duplicateTaskIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const existingTaskIds = new Set(state._allTasks.map((task) => task.id));
        const missingIds = updatesList
            .map((update) => update.id)
            .filter((id, index, ids) => !existingTaskIds.has(id) && ids.indexOf(id) === index);
        if (missingIds.length > 0) {
            const message = `Tasks not found: ${missingIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const tasksById = new Map(state._allTasks.map((task) => [task.id, task] as const));
        const preparedUpdatesById = new Map<string, Partial<Task>>();
        for (const { id, updates } of updatesList) {
            const task = tasksById.get(id);
            if (!task) continue;
            const preparedUpdates = prepareTaskUpdatesForStore({
                task,
                updates,
                allTasks: state._allTasks,
                allProjects: state._allProjects,
                allSections: state._allSections,
                allAreas: state._allAreas,
            });
            if (!preparedUpdates.ok) {
                set({ error: preparedUpdates.error });
                return actionFail(preparedUpdates.error);
            }
            preparedUpdatesById.set(id, preparedUpdates.updates);
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;

        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            let newVisibleTasks = state.tasks;
            let nextRecurringTasks: Task[] = [];
            const newAllTasksBase = [...state._allTasks];
            for (let index = 0; index < state._allTasks.length; index += 1) {
                const task = newAllTasksBase[index];
                const preparedUpdates = preparedUpdatesById.get(task.id);
                if (!preparedUpdates) continue;
                const adjustedUpdates = normalizeTaskUpdateForStore({
                    task,
                    updates: preparedUpdates,
                    allTasks: newAllTasksBase,
                });
                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                    task,
                    {
                        ...adjustedUpdates,
                        rev: normalizeRevision(task.rev) + 1,
                        revBy: deviceState.deviceId,
                    },
                    now
                );
                if (nextRecurringTask) nextRecurringTasks = [...nextRecurringTasks, nextRecurringTask];
                newVisibleTasks = updateVisibleTasks(newVisibleTasks, task, updatedTask);
                newAllTasksBase[index] = updatedTask;
            }

            const newAllTasks = nextRecurringTasks.length > 0
                ? [...newAllTasksBase, ...nextRecurringTasks]
                : newAllTasksBase;
            if (nextRecurringTasks.length > 0) {
                nextRecurringTasks.forEach((task) => {
                    newVisibleTasks = updateVisibleTasks(newVisibleTasks, null, task);
                });
            }

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });

            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    batchMoveTasks: async (ids: string[], newStatus: TaskStatus) => {
        return get().batchUpdateTasks(ids.map((id) => ({ id, updates: { status: newStatus } })));
    },

    batchDeleteTasks: async (ids: string[]) => {
        if (ids.length === 0) return actionOk();
        const state = get();
        const existingTaskIds = new Set(state._allTasks.map((task) => task.id));
        const missingIds = ids.filter((id, index) => !existingTaskIds.has(id) && ids.indexOf(id) === index);
        if (missingIds.length > 0) {
            const message = `Tasks not found: ${missingIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const idSet = new Set(ids);
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            let newVisibleTasks = state.tasks;
            const newAllTasks = state._allTasks.map((task) => {
                if (!idSet.has(task.id)) return task;
                const updatedTask = {
                    ...task,
                    deletedAt: now,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
                newVisibleTasks = updateVisibleTasks(newVisibleTasks, task, updatedTask);
                return updatedTask;
            });
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    queryTasks: async (options: TaskQueryOptions) => {
        const storage = getStorage();
        if (storage.queryTasks) {
            return storage.queryTasks(options);
        }
        const tasks = get()._allTasks;
        const statusFilter = options.status;
        const excludeStatuses = options.excludeStatuses ?? [];
        const includeArchived = options.includeArchived === true;
        const includeDeleted = options.includeDeleted === true;
        return tasks.filter((task) => {
            if (!isTaskVisible(task, { includeArchived, includeDeleted })) return false;
            if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
            if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
            if (options.projectId && task.projectId !== options.projectId) return false;
            return true;
        });
    },
});
