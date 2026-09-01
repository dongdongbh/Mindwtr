import { collectFocusEligibilityTasks, resolveFocusStarAction, type FocusStarAction } from './focus-star';
import type { AppData, PendingRemoteAttachmentDelete, Section, Task, TaskStatus } from './types';
import type { StorageAdapter, TaskQueryOptions } from './storage';
import { taskMatchesQuery } from './task-query';
import type { StoreActionResult, TaskStore } from './store-types';
import {
    applyTaskUpdates,
    buildSaveSnapshot,
    createProjectOrderReserver,
    ensureDeviceId,
    getNextDataChangeAt,
    getNextProjectOrder,
    getTaskOrder,
    getReferenceTaskFieldClears,
    nextRevision,
    normalizeTaskUpdate,
    persist,
    replaceEntitiesInArray,
    replaceEntityInArray,
    resolveCaptureStatusForStart,
    type ProjectOrderReserver,
} from './store-helpers';
import { logInfo, logWarn } from './logger';
import { isTaskFinished } from './task-status';
import { beginNotifyProfile, endNotifyProfile, type NotifyProfile } from './store-notify-profiler';
import { generateUUID as uuidv4 } from './uuid';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeRepeatReminderMinutes } from './schedule-utils';
import { normalizeFocusTaskLimit } from './focus-utils';
import { getTaskFocusEligibility } from './task-utils';
import {
    buildTaskContainerMovePatch,
    normalizeOptionalContainerId,
    reserveTaskContainerProjectOrder,
    resolveTaskContainerAssignment,
    resolveTaskContainerHierarchy,
} from './task-container-rules';
import { resolveDefaultNewTaskAreaId } from './area-utils';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { buildNewProject } from './store-projects/project-actions';
import {
    compactPurgedTaskForLocalStorage,
} from './tombstone-compaction';

const SLOW_TASK_UPDATE_LOG_THRESHOLD_MS = 500;

const collectAttachmentCloudKeysForTasks = (tasks: readonly Task[]): Set<string> => {
    const cloudKeys = new Set<string>();
    for (const task of tasks) {
        if (task.purgedAt) continue;
        for (const attachment of task.attachments || []) {
            if (attachment.kind === 'file' && attachment.cloudKey) {
                cloudKeys.add(attachment.cloudKey);
            }
        }
    }
    return cloudKeys;
};

const collectPendingRemoteDeletesForTasks = (
    tasks: readonly Task[],
    remainingTasks: readonly Task[] = [],
): PendingRemoteAttachmentDelete[] => {
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    const retainedCloudKeys = collectAttachmentCloudKeysForTasks(remainingTasks);
    for (const task of tasks) {
        for (const attachment of task.attachments || []) {
            if (attachment.kind !== 'file' || !attachment.cloudKey) continue;
            if (retainedCloudKeys.has(attachment.cloudKey)) continue;
            if (byCloudKey.has(attachment.cloudKey)) continue;
            byCloudKey.set(attachment.cloudKey, {
                cloudKey: attachment.cloudKey,
            });
        }
    }
    return Array.from(byCloudKey.values());
};

const appendPendingRemoteDeletes = (
    settings: TaskStore['settings'],
    pendingDeletes: readonly PendingRemoteAttachmentDelete[],
): TaskStore['settings'] => {
    if (pendingDeletes.length === 0) return settings;
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const existing of settings.attachments?.pendingRemoteDeletes || []) {
        byCloudKey.set(existing.cloudKey, existing);
    }
    for (const pending of pendingDeletes) {
        if (byCloudKey.has(pending.cloudKey)) continue;
        byCloudKey.set(pending.cloudKey, pending);
    }
    return {
        ...settings,
        attachments: {
            ...settings.attachments,
            pendingRemoteDeletes: Array.from(byCloudKey.values()),
        },
    };
};

const normalizeOptionalTaskField = (value: string | undefined): string => value ?? '';

const recurrenceKeyForDuplicateCheck = (task: Task): string => (
    JSON.stringify(normalizeRecurrenceForLoad(task.recurrence) ?? null)
);

const isExistingRecurringFollowUp = (existing: Task, candidate: Task): boolean => {
    if (existing.id === candidate.id) return false;
    if (existing.deletedAt) return false;
    if (isTaskFinished(existing)) return false;
    if (existing.status !== candidate.status) return false;
    if (existing.title.trim() !== candidate.title.trim()) return false;
    if (normalizeOptionalTaskField(existing.projectId) !== normalizeOptionalTaskField(candidate.projectId)) return false;
    if (normalizeOptionalTaskField(existing.sectionId) !== normalizeOptionalTaskField(candidate.sectionId)) return false;
    if (normalizeOptionalTaskField(existing.areaId) !== normalizeOptionalTaskField(candidate.areaId)) return false;
    if (normalizeOptionalTaskField(existing.startTime) !== normalizeOptionalTaskField(candidate.startTime)) return false;
    if (normalizeOptionalTaskField(existing.dueDate) !== normalizeOptionalTaskField(candidate.dueDate)) return false;
    if (normalizeOptionalTaskField(existing.reviewAt) !== normalizeOptionalTaskField(candidate.reviewAt)) return false;
    return recurrenceKeyForDuplicateCheck(existing) === recurrenceKeyForDuplicateCheck(candidate);
};

// excludeId is the task being completed in this same update. The snapshot being
// scanned is taken before the update lands, so that task still reads as live and
// would match its own follow-up: completing an occurrence and then the one it just
// spawned, on the same day, made the second candidate look like a duplicate of the
// first and silently ended the series (#867).
const findExistingRecurringFollowUp = (
    tasks: readonly Task[],
    candidate: Task | null,
    excludeId?: string,
): Task | null => {
    if (!candidate) return null;
    return tasks.find((task) => task.id !== excludeId && isExistingRecurringFollowUp(task, candidate)) ?? null;
};

// The follow-up is a fresh task, so it needs what every other creation path
// stamps: a project order (missing sorts as +Infinity in
// compareTasksByProjectOrder, dumping the next occurrence below its siblings)
// and a zeroed push count. It inherits the completed instance's place — that
// instance leaves the active list and a series only ever has one active
// instance, so there is nothing to collide with — and only falls back to a
// fresh reservation when the completed task had no order to inherit.
const stampNewRecurringFollowUp = (
    task: Task | null,
    deviceId: string,
    sourceOrder: number | undefined,
    reserveProjectOrder: ProjectOrderReserver,
): Task | null => {
    if (!task) return null;
    const order = sourceOrder ?? reserveProjectOrder(task.projectId);
    return {
        ...task,
        rev: nextRevision(undefined),
        revBy: deviceId,
        pushCount: 0,
        ...(order !== undefined ? { order, orderNum: order } : {}),
    };
};

type TaskActions = Pick<
    TaskStore,
    | 'addTask'
    | 'addTasks'
    | 'updateTask'
    | 'deleteTask'
    | 'restoreTask'
    | 'restoreTasks'
    | 'purgeTask'
    | 'purgeTasks'
    | 'purgeDeletedTasks'
    | 'duplicateTask'
    | 'convertTaskToSection'
    | 'promoteTaskToProject'
    | 'resetTaskChecklist'
    | 'moveTask'
    | 'batchUpdateTasks'
    | 'batchMoveTasks'
    | 'batchDeleteTasks'
    | 'reorderFocusedTasks'
    | 'queryTasks'
    | 'getFocusStarAction'
>;

type TaskActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    getStorage: () => StorageAdapter;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    trackImmediateSave: (save: Promise<void>, retrySnapshot?: AppData) => Promise<void>;
    hasQueuedSnapshotSave: () => boolean;
};

const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
const actionFail = (error: string): StoreActionResult => ({ success: false, error });
const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);

// `tasks` and `_tasksById` are derived from `_allTasks` by
// prepareStoreStateUpdate (store.ts) on every write, so producers below only
// ever write `_allTasks`.
export type MutateTasksOptions = {
    selectTasks: (state: TaskStore) => Task[];
    buildUpdates: (task: Task, context: { now: string; state: TaskStore }) => Partial<Task>;
    buildSettings?: (state: TaskStore, selectedTasks: readonly Task[], context: { now: string; settings: TaskStore['settings'] }) => TaskStore['settings'] | undefined;
    missingMessage?: string;
    ensureDeviceIdWhenEmpty?: boolean;
};

export const mutateTasks = async (
    { set, debouncedSave }: Pick<TaskActionContext, 'set' | 'debouncedSave'>,
    options: MutateTasksOptions
): Promise<StoreActionResult> => {
    const changeAt = Date.now();
    const now = new Date().toISOString();
    let missing = false;
    set((state) => {
        const selectedTasks = options.selectTasks(state);
        if (selectedTasks.length === 0 && !options.ensureDeviceIdWhenEmpty) {
            missing = Boolean(options.missingMessage);
            return state;
        }
        const deviceState = ensureDeviceId(state.settings);
        if (selectedTasks.length === 0 && !deviceState.updated) {
            return state;
        }
        const changedTasks = selectedTasks.map((task) => {
            const updatedTask: Task = {
                ...task,
                ...options.buildUpdates(task, { now, state }),
                updatedAt: now,
                rev: nextRevision(task.rev),
                revBy: deviceState.deviceId,
            };
            return compactPurgedTaskForLocalStorage(updatedTask);
        });
        const nextAllTasks = changedTasks.length > 0
            ? replaceEntitiesInArray(state._allTasks, changedTasks)
            : state._allTasks;
        const updatedSettings = options.buildSettings?.(state, selectedTasks, {
            now,
            settings: deviceState.settings,
        });
        const nextSettings = updatedSettings ?? deviceState.settings;
        const settingsChanged = Boolean(updatedSettings) || deviceState.updated;
        persist(set, debouncedSave, state, {
            tasks: nextAllTasks,
            ...(settingsChanged ? { settings: nextSettings } : {}),
        });
        return {
            _allTasks: nextAllTasks,
            lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
            ...(settingsChanged ? { settings: nextSettings } : {}),
        };
    });
    return missing ? actionFail(options.missingMessage ?? 'Task not found') : actionOk();
};

export const sanitizeRestoredTaskContainerReferences = (
    task: Task,
    state: TaskStore,
): Pick<Task, 'projectId' | 'sectionId' | 'areaId'> => {
    let projectId = normalizeOptionalContainerId(task.projectId);
    let sectionId = normalizeOptionalContainerId(task.sectionId);
    let areaId = normalizeOptionalContainerId(task.areaId);

    const liveProjectIds = new Set(
        state._allProjects
            .filter((project) => !project.deletedAt && !project.purgedAt)
            .map((project) => project.id),
    );
    const liveSection = sectionId
        ? state._allSections.find((section) => section.id === sectionId && !section.deletedAt)
        : undefined;
    const sectionProjectId = liveSection && liveProjectIds.has(liveSection.projectId)
        ? liveSection.projectId
        : undefined;

    if (projectId && !liveProjectIds.has(projectId)) {
        projectId = undefined;
    }
    if (sectionId && !sectionProjectId) {
        sectionId = undefined;
    }

    const resolved = resolveTaskContainerHierarchy({
        projectId,
        sectionId,
        areaId,
        sectionProjectId,
    });

    if (resolved.areaId && !state._allAreas.some((area) => area.id === resolved.areaId && !area.deletedAt)) {
        resolved.areaId = undefined;
    }

    return resolved;
};

const prepareTaskUpdatesForStore = ({
    task,
    updates,
    allProjects,
    allSections,
    allAreas,
    settings,
    reserveProjectOrder,
    projectOrderReserver,
}: {
    task: Task;
    updates: Partial<Task>;
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];
    /** Enables the settings-driven update rules (auto-archive on a completion edit). */
    settings?: AppData['settings'];
    reserveProjectOrder?: boolean;
    projectOrderReserver?: ProjectOrderReserver;
}): { ok: true; updates: Partial<Task> } | { ok: false; error: string } => {
    const containerPatch = buildTaskContainerMovePatch({
        task,
        updates,
        allProjects,
        allSections,
        allAreas,
        reserveProjectOrder,
        projectOrderReserver,
    });
    if (!containerPatch.ok) return containerPatch;

    const adjustedUpdates = normalizeTaskUpdate(task, {
        ...updates,
        ...containerPatch.updates,
    }, { settings });

    return {
        ok: true,
        updates: {
            ...adjustedUpdates,
            ...containerPatch.updates,
        },
    };
};

export const createTaskActions = ({ set, get, getStorage, debouncedSave, trackImmediateSave, hasQueuedSnapshotSave }: TaskActionContext): TaskActions => ({
    /**
     * Add a new task to the store and persist to storage.
     * @param title Task title
     * @param initialProps Optional initial properties
     */
    addTask: async (title: string, initialProps?: Partial<Task>) => {
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            const message = 'Task title is required';
            set({ error: message });
            return actionFail(message);
        }
        const result = await get().addTasks([{ title: trimmedTitle, initialProps }]);
        if (!result.success) return result;
        return actionOk({ id: result.ids?.[0] });
    },

    /**
     * Add multiple tasks in one store update and persistence snapshot.
     */
    addTasks: async (items: Array<{ title: string; initialProps?: Partial<Task> }>) => {
        const changeAt = Date.now();
        const normalizedItems = items.map((item) => ({
            title: typeof item.title === 'string' ? item.title.trim() : '',
            initialProps: item.initialProps ?? {},
        })).filter((item) => item.title.length > 0);
        if (normalizedItems.length === 0) return actionOk({ ids: [] });

        const currentState = get();
        const deviceState = ensureDeviceId(currentState.settings);
        const deviceId = deviceState.deviceId;
        const now = new Date().toISOString();
        const projectOrderReserver = createProjectOrderReserver(currentState._allTasks);
        const focusTaskLimit = normalizeFocusTaskLimit(currentState.settings.gtd?.focusTaskLimit);
        let focusedCount = currentState.getFocusedCount();
        const nextAllTasks = [...currentState._allTasks];
        const newTasks: Task[] = [];

        for (const item of normalizedItems) {
            const initialTaskProps = item.initialProps;
            const hasExplicitAreaId = hasOwnField(initialTaskProps, 'areaId');
            const shouldApplyDefaultArea = !hasExplicitAreaId
                && !normalizeOptionalContainerId(initialTaskProps.projectId)
                && !normalizeOptionalContainerId(initialTaskProps.sectionId);
            const defaultAreaId = shouldApplyDefaultArea
                ? resolveDefaultNewTaskAreaId(currentState.settings, currentState._allAreas)
                : undefined;
            const containerResolution = resolveTaskContainerAssignment({
                projectId: initialTaskProps.projectId,
                sectionId: initialTaskProps.sectionId,
                areaId: defaultAreaId ?? initialTaskProps.areaId,
                allProjects: currentState._allProjects,
                allSections: currentState._allSections,
                allAreas: currentState._allAreas,
            });
            if (!containerResolution.ok) {
                set({ error: containerResolution.error });
                return actionFail(containerResolution.error);
            }

            const resolvedStatus = (initialTaskProps.status ?? 'inbox') as TaskStatus;
            // Unlike the star creation path below there is no focus cap or
            // eligibility gate here: nothing is being starred. See
            // resolveCaptureStatusForStart for the shared promotion rule.
            const effectiveStatus: TaskStatus = resolveCaptureStatusForStart(initialTaskProps, resolvedStatus);
            const hasTaskOrder = hasOwnField(initialTaskProps, 'order') || hasOwnField(initialTaskProps, 'orderNum');
            const resolvedProjectId = containerResolution.projectId;
            const resolvedSectionId = containerResolution.sectionId;
            const resolvedAreaId = containerResolution.areaId;
            const referenceClears = resolvedStatus === 'reference'
                ? getReferenceTaskFieldClears()
                : {};
            const explicitOrder = getTaskOrder(initialTaskProps);
            const resolvedOrder = !hasTaskOrder && resolvedProjectId
                ? projectOrderReserver(resolvedProjectId)
                : explicitOrder;
            const newTask: Task = {
                ...initialTaskProps,
                id: uuidv4(),
                title: item.title,
                status: effectiveStatus,
                taskMode: initialTaskProps.taskMode ?? 'task',
                tags: initialTaskProps.tags ?? [],
                contexts: initialTaskProps.contexts ?? [],
                pushCount: initialTaskProps.pushCount ?? 0,
                recurrence: normalizeRecurrenceForLoad(initialTaskProps.recurrence),
                repeatReminderMinutes: normalizeRepeatReminderMinutes(initialTaskProps.repeatReminderMinutes),
                rev: 1,
                revBy: deviceId,
                createdAt: now,
                updatedAt: now,
                deletedAt: undefined,
                purgedAt: undefined,
                ...referenceClears,
                areaId: resolvedAreaId,
                projectId: resolvedProjectId,
                sectionId: resolvedSectionId,
                order: resolvedOrder,
                orderNum: resolvedOrder,
            };

            if (newTask.isFocusedToday === true) {
                // Starring at capture is an explicit "this is an actionable next action I'm
                // doing today" decision, which is incompatible with the unprocessed Inbox
                // default. Evaluate (and, if focus sticks, commit) the task as Next so the
                // star can take effect — focus eligibility requires status 'next'. The
                // promotion is committed only when focus actually lands, so a refused star
                // (cap full / ineligible) never silently reclassifies an Inbox task.
                const promotedStatus: TaskStatus = newTask.status === 'inbox' ? 'next' : newTask.status;
                const focusCandidate: Task = { ...newTask, status: promotedStatus, isFocusedToday: false };
                const focusEligibility = getTaskFocusEligibility(focusCandidate, {
                    tasks: [...nextAllTasks, focusCandidate],
                    projects: currentState._allProjects,
                });
                if (!focusEligibility.eligible || focusedCount >= focusTaskLimit) {
                    newTask.isFocusedToday = false;
                } else {
                    newTask.status = promotedStatus;
                    focusedCount += 1;
                }
            }

            newTasks.push(newTask);
            nextAllTasks.push(newTask);
        }

        set((state) => {
            persist(set, debouncedSave, state, {
                tasks: nextAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allTasks: nextAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        return actionOk({ id: newTasks[0]?.id, ids: newTasks.map((task) => task.id) });
    },

    /**
     * Update an existing task.
     * @param id Task ID
     * @param updates Properties to update
     */
    updateTask: async (id: string, updates: Partial<Task>) => {
        const updateStartedAt = Date.now();
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const currentState = get();
        const existingTask = currentState._tasksById.get(id);
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
            allProjects: currentState._allProjects,
            allSections: currentState._allSections,
            allAreas: currentState._allAreas,
            settings: currentState.settings,
        });
        if (!preparedUpdates.ok) {
            set({ error: preparedUpdates.error });
            return actionFail(preparedUpdates.error);
        }
        const isPromotingTaskFocus = preparedUpdates.updates.isFocusedToday === true && existingTask.isFocusedToday !== true;
        if (isPromotingTaskFocus) {
            const focusTaskLimit = normalizeFocusTaskLimit(currentState.settings.gtd?.focusTaskLimit);
            const focusedCount = currentState.getFocusedCount();
            if (focusedCount >= focusTaskLimit) {
                const message = `Focus limit of ${focusTaskLimit} reached`;
                set({ error: message });
                return actionFail(message);
            }
        }
        const prepareMs = Date.now() - updateStartedAt;
        let snapshot: AppData | null = null;
        const incrementalPersistence: { task?: Task; hasRecurringFollowUp: boolean; mintedDeviceId: boolean } = {
            hasRecurringFollowUp: false,
            mintedDeviceId: false,
        };
        let setProducerMs = 0;
        let notifyProfile: NotifyProfile | null = null;
        const notifyProfilingEnabled = currentState.settings.diagnostics?.loggingEnabled === true;
        const setStateStartedAt = Date.now();
        if (notifyProfilingEnabled) beginNotifyProfile();
        try {
            set((state) => {
                const producerStartedAt = Date.now();
                const oldTask = state._tasksById.get(id);
                if (!oldTask) {
                    setProducerMs = Date.now() - producerStartedAt;
                    return state;
                }
                const deviceState = ensureDeviceId(state.settings);
                const revisionPatch = {
                    rev: nextRevision(oldTask.rev),
                    revBy: deviceState.deviceId,
                };

                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                    oldTask,
                    { ...preparedUpdates.updates, ...revisionPatch },
                    now
                );
                const stampedNextRecurringTask = stampNewRecurringFollowUp(
                    nextRecurringTask,
                    deviceState.deviceId,
                    getTaskOrder(oldTask),
                    // Scans the collection only when there is a follow-up in a
                    // project and no order to inherit; this producer runs on
                    // every single-task update.
                    (projectId) => getNextProjectOrder(projectId, state._allTasks),
                );
                const recurringFollowUpTask = findExistingRecurringFollowUp(state._allTasks, stampedNextRecurringTask, oldTask.id)
                    ? null
                    : stampedNextRecurringTask;
                incrementalPersistence.task = updatedTask;
                incrementalPersistence.hasRecurringFollowUp = recurringFollowUpTask !== null;
                incrementalPersistence.mintedDeviceId = deviceState.updated;

                const updatedAllTasksBase = replaceEntityInArray(state._allTasks, id, updatedTask);
                const updatedAllTasks = recurringFollowUpTask
                    ? [...updatedAllTasksBase, recurringFollowUpTask]
                    : updatedAllTasksBase;
                snapshot = buildSaveSnapshot(state, {
                    tasks: updatedAllTasks,
                    ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                });
                setProducerMs = Date.now() - producerStartedAt;
                return {
                    _allTasks: updatedAllTasks,
                    lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                    ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                };
            });
        } finally {
            if (notifyProfilingEnabled) notifyProfile = endNotifyProfile();
        }
        const setStateMs = Date.now() - setStateStartedAt;
        const persistenceStartedAt = Date.now();
        const storage = getStorage();
        // A queued (not yet dispatched) full-state save can hold rows this task
        // now references — e.g. Process Inbox creates the project through the
        // debounced path and immediately points the task at it. A focused task
        // save dispatched now would reach SQLite before the project row and
        // fail its FOREIGN KEY check (#1024), so fold the task into the queued
        // snapshot instead. Saves already in flight are safe: both platform
        // adapters run writes through one FIFO queue.
        //
        // A deviceId minted in this update lives only in the snapshot's settings,
        // which the single-row write cannot carry: dropping it would let the next
        // launch mint another id and churn revBy.
        if (
            incrementalPersistence.task
            && !incrementalPersistence.hasRecurringFollowUp
            && !incrementalPersistence.mintedDeviceId
            && storage.saveTask
            && !hasQueuedSnapshotSave()
        ) {
            const taskToPersist = incrementalPersistence.task;
            void trackImmediateSave(
                storage.saveTask(taskToPersist, snapshot ?? undefined),
                snapshot ?? undefined,
            ).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logWarn('Incremental task save failed', {
                    scope: 'store',
                    category: 'storage',
                    context: { taskId: taskToPersist.id },
                    error,
                });
                set({ error: `Failed to save task: ${message}` });
            });
        } else if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        const persistenceDispatchMs = Date.now() - persistenceStartedAt;
        const totalMs = Date.now() - updateStartedAt;
        if (notifyProfilingEnabled && totalMs >= SLOW_TASK_UPDATE_LOG_THRESHOLD_MS) {
            logInfo('Slow task update pipeline', {
                scope: 'store',
                category: 'storage',
                context: {
                    totalMs,
                    prepareMs,
                    setStateMs,
                    setProducerMs,
                    setNotifyMs: Math.max(0, setStateMs - setProducerMs),
                    persistenceDispatchMs,
                    taskCount: currentState._allTasks.length,
                    updateFieldCount: Object.keys(preparedUpdates.updates).length,
                    recurringFollowUp: incrementalPersistence.hasRecurringFollowUp,
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
                },
            });
        }
        return actionOk();
    },

    /**
     * Soft-delete a task by setting deletedAt.
     * @param id Task ID
     */
    deleteTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task ? [task] : [];
            },
            buildUpdates: (_task, { now }) => ({ deletedAt: now }),
            missingMessage: 'Task not found',
        });
    },

    /**
     * Restore a soft-deleted task.
     */
    restoreTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task ? [task] : [];
            },
            buildUpdates: (task, { state }) => ({
                deletedAt: undefined,
                purgedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(task, state),
            }),
            missingMessage: 'Task not found',
        });
    },

    /**
     * Permanently delete a task (removes from storage).
     */
    purgeTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task ? [task] : [];
            },
            buildUpdates: (task, { now }) => ({
                deletedAt: task.deletedAt ?? now,
                purgedAt: now,
            }),
            buildSettings: (state, selectedTasks, { settings }) => {
                const selectedIds = new Set(selectedTasks.map((task) => task.id));
                const remainingTasks = state._allTasks.filter((task) => !selectedIds.has(task.id));
                const pendingDeletes = collectPendingRemoteDeletesForTasks(selectedTasks, remainingTasks);
                return pendingDeletes.length > 0
                    ? appendPendingRemoteDeletes(settings, pendingDeletes)
                    : undefined;
            },
            missingMessage: 'Task not found',
        });
    },

    /**
     * Restore multiple soft-deleted tasks in a single store update.
     */
    restoreTasks: async (ids: string[]) => {
        const idSet = new Set(ids);
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => idSet.has(task.id) && task.deletedAt && !task.purgedAt),
            buildUpdates: (task, { state }) => ({
                deletedAt: undefined,
                purgedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(task, state),
            }),
            missingMessage: 'Tasks not found',
        });
    },

    /**
     * Permanently delete multiple soft-deleted tasks in a single store update.
     * Only already-trashed tasks are purged, so the visible list is untouched.
     */
    purgeTasks: async (ids: string[]) => {
        const idSet = new Set(ids);
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => idSet.has(task.id) && task.deletedAt && !task.purgedAt),
            buildUpdates: (_task, { now }) => ({
                purgedAt: now,
            }),
            buildSettings: (state, selectedTasks, { settings }) => {
                const selectedIds = new Set(selectedTasks.map((task) => task.id));
                const remainingTasks = state._allTasks.filter((task) => !selectedIds.has(task.id));
                const pendingDeletes = collectPendingRemoteDeletesForTasks(selectedTasks, remainingTasks);
                return pendingDeletes.length > 0
                    ? appendPendingRemoteDeletes(settings, pendingDeletes)
                    : undefined;
            },
            missingMessage: 'Tasks not found',
        });
    },

    /**
     * Permanently delete all soft-deleted tasks.
     */
    purgeDeletedTasks: async () => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => task.deletedAt && !task.purgedAt),
            buildUpdates: (_task, { now }) => ({
                purgedAt: now,
            }),
            buildSettings: (state, selectedTasks, { settings }) => {
                const selectedIds = new Set(selectedTasks.map((task) => task.id));
                const remainingTasks = state._allTasks.filter((task) => !selectedIds.has(task.id));
                const pendingDeletes = collectPendingRemoteDeletesForTasks(selectedTasks, remainingTasks);
                return pendingDeletes.length > 0
                    ? appendPendingRemoteDeletes(settings, pendingDeletes)
                    : undefined;
            },
            ensureDeviceIdWhenEmpty: true,
        });
    },

    /**
     * Duplicate a task as a fresh, re-doable copy: clones the details (title, dates,
     * recurrence, tags, project) but resets completion — unchecks the checklist and
     * clears completedAt.
     *
     * The copy keeps the source's status, which done/archived cannot do (a
     * pre-completed copy is useless). Those land in the Inbox instead of straight
     * on the actionable list: work finished once is not automatically still worth
     * doing, so it gets clarified again like any other capture (#950).
     */
    duplicateTask: async (id: string, asNextAction?: boolean) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingTask = false;
        let duplicatedTaskId: string | undefined;
        set((state) => {
            const sourceTask = state._tasksById.get(id);
            if (!sourceTask || sourceTask.deletedAt) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

            const duplicatedChecklist = (sourceTask.checklist || []).map((item) => ({
                ...item,
                id: uuidv4(),
                isCompleted: false,
            }));
            const duplicatedAttachments = (sourceTask.attachments || []).flatMap((attachment) => {
                if (attachment.kind === 'file') {
                    return [];
                }
                return [{
                    ...attachment,
                    id: uuidv4(),
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: undefined,
                    cloudKey: undefined,
                    fileHash: undefined,
                    localStatus: undefined,
                }];
            });
            const projectOrderReserver = createProjectOrderReserver(state._allTasks);
            const duplicatedOrder = sourceTask.projectId
                ? projectOrderReserver(sourceTask.projectId)
                : undefined;
            const newTaskId = uuidv4();
            duplicatedTaskId = newTaskId;

            const newTask: Task = {
                ...sourceTask,
                id: newTaskId,
                title: sourceTask.title,
                status: asNextAction
                    ? 'next'
                    : isTaskFinished(sourceTask)
                        ? 'inbox'
                        : sourceTask.status,
                recurrence: typeof sourceTask.recurrence === 'object'
                    ? { ...sourceTask.recurrence, seriesId: newTaskId }
                    : sourceTask.recurrence,
                checklist: duplicatedChecklist.length > 0 ? duplicatedChecklist : undefined,
                attachments: duplicatedAttachments.length > 0 ? duplicatedAttachments : undefined,
                completedAt: undefined,
                isFocusedToday: false,
                // A copy is not in Today's Focus and was never archived with a
                // project, so neither the focus position nor the restore
                // metadata of the source belongs to it.
                focusOrder: undefined,
                statusBeforeProjectArchive: undefined,
                completedAtBeforeProjectArchive: undefined,
                isFocusedTodayBeforeProjectArchive: undefined,
                projectArchivedAt: undefined,
                deletedAt: undefined,
                purgedAt: undefined,
                createdAt: now,
                updatedAt: now,
                rev: 1,
                revBy: deviceState.deviceId,
                order: duplicatedOrder,
                orderNum: duplicatedOrder,
            };

            const newAllTasks = [...state._allTasks, newTask];
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return missingTask ? actionFail('Task not found') : actionOk({ id: duplicatedTaskId });
    },

    /**
     * Turn a task into a section of the project it already lives in: the title
     * becomes the section, its checklist items become tasks inside it (completed
     * ones stay done), and the original task is soft-deleted so its notes and
     * attachments remain recoverable from Trash (#1106).
     *
     * Every entity is validated and built before one store mutation publishes
     * the complete task/section snapshot. No partial conversion is observable or
     * persistable, and retry sees the source tombstone instead of duplicating it.
     */
    convertTaskToSection: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let errorMessage: string | undefined;
        let convertedSectionId: string | undefined;
        set((state) => {
            const sourceTask = state._tasksById.get(id);
            if (!sourceTask || sourceTask.deletedAt) {
                errorMessage = 'Task not found';
                return state;
            }
            const projectId = normalizeOptionalContainerId(sourceTask.projectId);
            if (!projectId) {
                errorMessage = 'Task is not in a project';
                return state;
            }
            const projectExists = state._allProjects.some((project) => project.id === projectId && !project.deletedAt);
            const sectionTitle = typeof sourceTask.title === 'string' ? sourceTask.title.trim() : '';
            if (!projectExists || !sectionTitle) {
                errorMessage = 'Section could not be created';
                return state;
            }

            const deviceState = ensureDeviceId(state.settings);
            const sectionOrder = state._allSections
                .filter((section) => section.projectId === projectId && !section.deletedAt)
                .reduce((max, section) => Math.max(max, Number.isFinite(section.order) ? section.order : -1), -1) + 1;
            const description = typeof sourceTask.description === 'string' ? sourceTask.description.trim() : '';
            const section: Section = {
                id: uuidv4(),
                projectId,
                title: sectionTitle,
                ...(description ? { description } : {}),
                order: sectionOrder,
                isCollapsed: false,
                rev: 1,
                revBy: deviceState.deviceId,
                createdAt: now,
                updatedAt: now,
            };
            const nextAllSections = [...state._allSections, section];
            const projectOrderReserver = createProjectOrderReserver(state._allTasks);
            const checklistTasks: Task[] = [];

            for (const item of sourceTask.checklist || []) {
                const title = typeof item.title === 'string' ? item.title.trim() : '';
                if (!title) continue;
                const containerResolution = resolveTaskContainerAssignment({
                    projectId,
                    sectionId: section.id,
                    areaId: undefined,
                    allProjects: state._allProjects,
                    allSections: nextAllSections,
                    allAreas: state._allAreas,
                });
                if (!containerResolution.ok) {
                    errorMessage = containerResolution.error;
                    return state;
                }
                const order = projectOrderReserver(containerResolution.projectId);
                checklistTasks.push({
                    id: uuidv4(),
                    title,
                    status: item.isCompleted ? 'done' : 'next',
                    taskMode: 'task',
                    tags: [],
                    contexts: [],
                    pushCount: 0,
                    projectId: containerResolution.projectId,
                    sectionId: containerResolution.sectionId,
                    areaId: containerResolution.areaId,
                    ...(item.isCompleted ? { completedAt: now } : {}),
                    order,
                    orderNum: order,
                    rev: 1,
                    revBy: deviceState.deviceId,
                    createdAt: now,
                    updatedAt: now,
                });
            }

            const deletedSource: Task = {
                ...sourceTask,
                deletedAt: now,
                updatedAt: now,
                rev: nextRevision(sourceTask.rev),
                revBy: deviceState.deviceId,
            };
            const nextAllTasks = [
                ...replaceEntityInArray(state._allTasks, deletedSource.id, deletedSource),
                ...checklistTasks,
            ];
            convertedSectionId = section.id;
            persist(set, debouncedSave, state, {
                tasks: nextAllTasks,
                sections: nextAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allTasks: nextAllTasks,
                _allSections: nextAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (errorMessage) return actionFail(errorMessage);
        return convertedSectionId
            ? actionOk({ id: convertedSectionId })
            : actionFail('Task not found');
    },

    /**
     * Create or reuse a project from a task while keeping the task as the first action.
     */
    promoteTaskToProject: async (id: string, options?: { title?: string; color?: string; areaId?: string }) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingTask = false;
        let errorMessage: string | undefined;
        let promotedProjectId: string | undefined;
        let reusedExistingProject = false;
        set((state) => {
            const sourceTask = state._tasksById.get(id);
            if (!sourceTask || sourceTask.deletedAt) {
                missingTask = true;
                return state;
            }

            const trimmedTitle = (typeof options?.title === 'string' ? options.title : sourceTask.title).trim();
            if (!trimmedTitle) {
                errorMessage = 'Project title is required';
                return { error: errorMessage };
            }

            const explicitAreaId = normalizeOptionalContainerId(options?.areaId);
            const sourceProject = sourceTask.projectId ? state._projectsById.get(sourceTask.projectId) : undefined;
            const inheritedAreaId = explicitAreaId ?? sourceTask.areaId ?? sourceProject?.areaId;
            const targetAreaId = inheritedAreaId && state._allAreas.some((area) => area.id === inheritedAreaId && !area.deletedAt)
                ? inheritedAreaId
                : undefined;
            if (explicitAreaId && !targetAreaId) {
                errorMessage = 'Area not found';
                return { error: errorMessage };
            }

            const existingProject = findSelectableProjectByTitleAndArea(
                state._allProjects,
                trimmedTitle,
                targetAreaId
            );
            reusedExistingProject = Boolean(existingProject);
            const projectSupportNotes = typeof sourceTask.description === 'string' && sourceTask.description.trim()
                ? sourceTask.description.trim()
                : undefined;
            const projectTagIds = Array.from(new Set((sourceTask.tags || [])
                .map((tag) => typeof tag === 'string' ? tag.trim() : '')
                .filter(Boolean)));
            const deviceState = ensureDeviceId(state.settings);
            let targetProject = existingProject;
            let nextAllProjects = state._allProjects;
            if (!targetProject) {
                const newProject = buildNewProject({
                    title: trimmedTitle,
                    color: options?.color,
                    initialProps: {
                        ...(targetAreaId ? { areaId: targetAreaId } : {}),
                        ...(projectSupportNotes ? { supportNotes: projectSupportNotes } : {}),
                        tagIds: projectTagIds,
                    },
                    existingProjects: state._allProjects,
                    settings: state.settings,
                    deviceId: deviceState.deviceId,
                    now,
                });
                targetProject = newProject;
                nextAllProjects = [...state._allProjects, newProject];
            }

            promotedProjectId = targetProject.id;
            const projectOrderReserver = createProjectOrderReserver(state._allTasks);
            const preparedUpdates = prepareTaskUpdatesForStore({
                task: sourceTask,
                updates: {
                    projectId: targetProject.id,
                    sectionId: undefined,
                    areaId: undefined,
                },
                allProjects: nextAllProjects,
                allSections: state._allSections,
                allAreas: state._allAreas,
                projectOrderReserver,
            });
            if (!preparedUpdates.ok) {
                errorMessage = preparedUpdates.error;
                return { error: errorMessage };
            }

            const { updatedTask } = applyTaskUpdates(
                sourceTask,
                {
                    ...preparedUpdates.updates,
                    rev: nextRevision(sourceTask.rev),
                    revBy: deviceState.deviceId,
                },
                now
            );
            const nextAllTasks = replaceEntityInArray(state._allTasks, id, updatedTask);
            persist(set, debouncedSave, state, {
                tasks: nextAllTasks,
                projects: nextAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allTasks: nextAllTasks,
                _allProjects: nextAllProjects,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingTask) return actionFail('Task not found');
        if (errorMessage) return actionFail(errorMessage);
        return actionOk({ id: promotedProjectId, reused: reusedExistingProject });
    },

    /**
     * Reset checklist items to unchecked (useful for reusable lists).
     */
    resetTaskChecklist: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task && !task.deletedAt && task.checklist && task.checklist.length > 0 ? [task] : [];
            },
            buildUpdates: (task) => {
                const wasDone = task.status === 'done';
                return {
                    checklist: task.checklist?.map((item) => ({
                        ...item,
                        isCompleted: false,
                    })),
                    status: wasDone ? 'next' : task.status,
                    completedAt: wasDone ? undefined : task.completedAt,
                    isFocusedToday: wasDone ? false : task.isFocusedToday,
                };
            },
            missingMessage: 'Task not found',
        });
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
        const existingTaskIds = new Set(state._tasksById.keys());
        const missingIds = Array.from(new Set(
            updatesList.map((update) => update.id).filter((id) => !existingTaskIds.has(id))
        ));
        if (missingIds.length > 0) {
            const message = `Tasks not found: ${missingIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const preparedUpdatesById = new Map<string, Partial<Task>>();
        for (const { id, updates } of updatesList) {
            const task = state._tasksById.get(id);
            if (!task) continue;
            const preparedUpdates = prepareTaskUpdatesForStore({
                task,
                updates,
                allProjects: state._allProjects,
                allSections: state._allSections,
                allAreas: state._allAreas,
                settings: state.settings,
                reserveProjectOrder: false,
            });
            if (!preparedUpdates.ok) {
                set({ error: preparedUpdates.error });
                return actionFail(preparedUpdates.error);
            }
            preparedUpdatesById.set(id, preparedUpdates.updates);
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();

        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const nextRecurringTasks: Task[] = [];
            const changedTasks: Task[] = [];
            const newAllTasksBase = [...state._allTasks];
            const projectOrderReserver = createProjectOrderReserver(newAllTasksBase);
            for (let index = 0; index < state._allTasks.length; index += 1) {
                const task = newAllTasksBase[index];
                const preparedUpdates = preparedUpdatesById.get(task.id);
                if (!preparedUpdates) continue;
                const adjustedUpdates = reserveTaskContainerProjectOrder({
                    task,
                    updates: preparedUpdates,
                    projectOrderReserver,
                }) as Partial<Task>;
                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                    task,
                    {
                        ...adjustedUpdates,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    },
                    now
                );
                const stampedNextRecurringTask = stampNewRecurringFollowUp(
                    nextRecurringTask,
                    deviceState.deviceId,
                    getTaskOrder(task),
                    projectOrderReserver,
                );
                // Guard before the call: its arguments copy the whole collection,
                // and evaluating them once per updated task made "select all ->
                // move" quadratic even though almost nothing recurs.
                if (stampedNextRecurringTask) {
                    const duplicateFollowUp = findExistingRecurringFollowUp(
                        [...newAllTasksBase, ...nextRecurringTasks],
                        stampedNextRecurringTask,
                        task.id
                    );
                    if (!duplicateFollowUp) {
                        nextRecurringTasks.push(stampedNextRecurringTask);
                    }
                }
                newAllTasksBase[index] = updatedTask;
                changedTasks.push(updatedTask);
            }

            const newAllTasks = nextRecurringTasks.length > 0
                ? [...newAllTasksBase, ...nextRecurringTasks]
                : newAllTasksBase;

            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });

            return {
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        return actionOk();
    },

    batchMoveTasks: async (ids: string[], newStatus: TaskStatus) => {
        return get().batchUpdateTasks(ids.map((id) => ({ id, updates: { status: newStatus } })));
    },

    batchDeleteTasks: async (ids: string[]) => {
        if (ids.length === 0) return actionOk();
        const state = get();
        const existingTaskIds = new Set(
            state._allTasks
                .filter((task) => !task.deletedAt)
                .map((task) => task.id)
        );
        const missingIds = Array.from(new Set(ids.filter((id) => !existingTaskIds.has(id))));
        if (missingIds.length > 0) {
            const message = `Tasks not found: ${missingIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const idSet = new Set(ids);
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => idSet.has(task.id)),
            buildUpdates: (_task, { now }) => ({ deletedAt: now }),
        });
    },

    reorderFocusedTasks: async (orderedIds: string[]) => {
        if (orderedIds.length === 0) return actionOk();
        const targetOrderById = new Map(Array.from(new Set(orderedIds)).map((id, index) => [id, index]));
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => {
                if (task.deletedAt) return false;
                const targetOrder = targetOrderById.get(task.id);
                return targetOrder !== undefined && task.focusOrder !== targetOrder;
            }),
            buildUpdates: (task) => ({ focusOrder: targetOrderById.get(task.id) as number }),
        });
    },

    getFocusStarAction: (task: Task, options?: { allowUnclarified?: boolean }): FocusStarAction => {
        const state = get();
        const derived = state.getDerivedState();
        return resolveFocusStarAction(task, {
            tasks: collectFocusEligibilityTasks(derived.activeTasksByStatus),
            projects: derived.projectMap,
            focusedCount: derived.focusedCount,
            focusTaskLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
            sequentialProjectIds: derived.sequentialProjectIds,
            sectionScopedProjectIds: derived.sequentialWithinSectionProjectIds,
            allowUnclarified: options?.allowUnclarified,
        });
    },

    queryTasks: async (options: TaskQueryOptions) => {
        const storage = getStorage();
        if (storage.queryTasks) {
            return storage.queryTasks(options);
        }
        const includeArchived = options.includeArchived === true;
        const includeDeleted = options.includeDeleted === true;
        if (!includeArchived && !includeDeleted) {
            const statusFilter = options.status;
            const state = get();
            const derived = state.getDerivedState();
            const indexedTasks = options.projectId
                ? derived.tasksByProjectId.get(options.projectId) ?? []
                : statusFilter && statusFilter !== 'all'
                    ? derived.activeTasksByStatus.get(statusFilter) ?? []
                    : state.tasks;
            // indexedTasks are already visible (deleted/archived excluded by whichever
            // derived index produced them), so taskMatchesQuery's own visibility check
            // here is redundant but harmless - cheaper than a second matcher variant.
            return indexedTasks.filter((task) => taskMatchesQuery(task, options));
        }
        return get()._allTasks.filter((task) => taskMatchesQuery(task, options));
    },
});
