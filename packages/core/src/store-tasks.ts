import { mapSqliteTaskRow, rawReadTaskSnapshot } from './sqlite-adapter';
import { rawReadProjectSnapshot } from './sqlite-raw-snapshot';
import { referenceBatchModules, type ReferenceBatchValidator } from './store-reference-batch-modules';
import { buildNewTask } from './task-creation';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import { taskEditValuesEqual } from './json-value-equality';
export { taskEditValuesEqual } from './json-value-equality';
import { PROJECT_SQLITE_COLUMNS, projectToSqliteRow } from './project-sync-schema';
import { sectionToSqliteRow } from './section-sync-schema';
import {
    collectFocusEligibilityTasks,
    resolveFocusStarAction,
    type FocusStarAction,
} from './focus-star';
import type { AppData, Area, Project, Section, Task, TaskStatus } from './types';
import type { NativePreparedArchivedTaskRestore } from './native-host-contract-archive-task-restore';
import { settingsWithPurgedParentAttachmentDeletes } from './attachment-cleanup';
import type { StorageAdapter, TaskQueryOptions } from './storage';
import { taskMatchesQuery } from './task-query';
import type { PreparedAreaAuthority, PreparedCalendarCreate, PreparedCalendarTask, PreparedChecklistEffect, PreparedChecklistWriteOptions, PreparedFocusOrder, PreparedInboxEffect, PreparedTaskEdit, PreparedTaskEditResult, PreparedTaskFocus, PreparedTaskPromotion, StoreActionResult, TaskFocusWitnessRow, TaskStore } from './store-types';
import { buildFocusControlsModel } from './focus-controls';
import {
    applyTaskProjectReactivationTransition,
    applyTaskUpdates,
    buildSaveSnapshot,
    createProjectOrderReserver,
    ensureDeviceId,
    findExistingRecurringFollowUp,
    findTaskProjectReactivationTarget,
    getNextDataChangeAt,
    getNextProjectOrder,
    getTaskOrder,
    isTaskCountedAsFocused,
    matchesDuplicateSource,
    isRestorableProjectArchiveSection,
    nextRevision,
    normalizeTaskUpdate,
    persist,
    replaceEntitiesInArray,
    replaceEntityInArray,
    stampNewRecurringFollowUp,
    type ProjectOrderReserver,
} from './store-helpers';
import { logInfo, logWarn } from './logger';
import {
    isTaskActionable,
    isTaskCancelled,
    isTaskFinished,
    normalizeCancellationTimestamp,
} from './task-status';
import { beginNotifyProfile, endNotifyProfile, type NotifyProfile } from './store-notify-profiler';
import { generateUUID as uuidv4 } from './uuid';
import { buildNextRecurringTask, canSkipRecurringTaskOccurrence, createNextRecurringTask,
    normalizeRecurrenceForLoad, type RecurrenceProjection } from './recurrence';
import { normalizeFocusTaskLimit } from './focus-utils';
import { resolveProcessInboxPlan } from './process-inbox-plan';
import { boardOrderForDuplicate, countFocusedTasksBeforeBoundary, isTaskFutureFocusCandidate,
    type FocusDateLookup } from './task-utils';
import { sameTaskSqliteRow, sameSectionDeleteJson } from './store-projects/section-actions';
import { sameSectionSqliteRow } from './store-projects/section-actions';
import { sameProjectSqliteRow } from './store-projects/project-actions';
import { normalizeTaskForLoad } from './task-status';
import { normalizeProjectLifecycleFields } from './project-status';
import { clearDerivedCache } from './store-settings';
import {
    buildTaskContainerMovePatch,
    normalizeOptionalContainerId,
    reserveTaskContainerProjectOrder,
    resolveTaskContainerAssignment,
    resolveTaskContainerHierarchy,
} from './task-container-rules';
import { findSelectableProjectByTitleAndArea, isSelectableProjectForTaskAssignment } from './project-utils';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { getBulkMoveStatusOptions } from './task-list-bulk-actions';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import { buildNewProject, projectAreaOrderMax } from './store-projects/project-actions';
import {
    compactPurgedTaskForLocalStorage,
} from './tombstone-compaction';

const SLOW_TASK_UPDATE_LOG_THRESHOLD_MS = 500;

type TaskActions = Pick<
    TaskStore,
    | 'addTask'
    | 'addTasks'
    | 'commitPreparedCapture'
    | 'commitPreparedTaskEdit'
    | 'commitPreparedTaskDraftV2'
    | 'commitPreparedArchivedTaskRestore'
    | 'commitPreparedArchivedTasksRestore'
    | 'commitPreparedReferenceTasksMove'
    | 'commitPreparedReferenceTasksAddTag'
    | 'commitPreparedReferenceTasksRemoveTag'
    | 'commitPreparedArchivedTasksMutation'
    | 'commitPreparedTaskFocus'
    | 'commitPreparedFocusOrder'
    | 'commitPreparedBoardTask'
    | 'commitPreparedCalendarTask'
    | 'commitPreparedCalendarCreate'
    | 'commitPreparedInboxEffect'
    | 'commitPreparedChecklistEffect'
    | 'updateTask'
    | 'cancelTask'
    | 'skipRecurringTaskOccurrence'
    | 'deleteTask'
    | 'restoreTask'
    | 'restoreTasks'
    | 'purgeTask'
    | 'purgeTasks'
    | 'purgeDeletedTasks'
    | 'duplicateTask'
    | 'convertTaskToSection'
    | 'promoteTaskToProject'
    | 'commitPreparedTaskPromotion'
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
    flushPendingSave: () => Promise<void>;
    trackImmediateSave: (save: Promise<void>, retrySnapshot?: AppData) => Promise<void>;
    hasQueuedSnapshotSave: () => boolean;
    getSaveGeneration: () => number;
};

const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
const actionFail = (error: string): StoreActionResult => ({ success: false, error });
const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);
const CAPTURE_ID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

const taskPatchIsUnchanged = (task: Task, updates: Partial<Task>): boolean => (
    Object.entries(updates).every(([field, value]) => Object.is(task[field as keyof Task], value))
);

const collectOptimisticReactivationRetryProjectIds = (
    requests: readonly { task: Task; updates: Partial<Task> }[],
    state: Pick<TaskStore, 'persistenceFailure' | '_projectsById'>,
): string[] => {
    if (!state.persistenceFailure || requests.length === 0) return [];
    if (!requests.every(({ task, updates }) => taskPatchIsUnchanged(task, updates))) return [];

    const projectIds = new Set<string>();
    for (const { task, updates } of requests) {
        if (
            task.deletedAt
            || task.purgedAt
            || !hasOwnField(updates, 'status')
            || !updates.status
            || !isTaskActionable(updates.status)
            || !task.projectId
        ) {
            continue;
        }
        const project = state._projectsById.get(task.projectId);
        if (project?.status === 'active' && !project.deletedAt && !project.purgedAt) {
            projectIds.add(project.id);
        }
    }
    return Array.from(projectIds);
};

const logTaskProjectReactivationSaved = (count: number): void => {
    logInfo('Task project reactivation saved', {
        scope: 'store',
        category: 'storage',
        context: {
            releaseCheck: 'v1.3.0/reopen-project-task',
            outcome: 'reactivated',
            count,
        },
    });
    logInfo('Archived task container validation saved', {
        scope: 'store',
        category: 'storage',
        context: {
            releaseCheck: 'v1.3.1/archive-reactivation-validation',
            outcome: 'reactivated',
            count,
        },
    });
};

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

/** The existing mutation row formula, with caller-owned selection and context. */
export const planTaskMutations = <TState,>({
    tasks,
    state,
    buildUpdates,
    now,
    deviceId,
}: {
    tasks: readonly Task[];
    state: TState;
    buildUpdates: (task: Task, context: { now: string; state: TState }) => Partial<Task>;
    now: string;
    deviceId: string;
}): Task[] => tasks.map((task) => {
    const updatedTask: Task = {
        ...task,
        ...buildUpdates(task, { now, state }),
        updatedAt: now,
        rev: nextRevision(task.rev),
        revBy: deviceId,
    };
    return compactPurgedTaskForLocalStorage(updatedTask);
});

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
        const changedTasks = planTaskMutations({
            tasks: selectedTasks,
            state,
            buildUpdates: options.buildUpdates,
            now,
            deviceId: deviceState.deviceId,
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

/** Full visible-row identity, with sorted object keys but untouched array and raw date values. */
export const focusOrderToken = (tasks: readonly Task[]): string => JSON.stringify(tasks, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);

const focusOrderTargets = (orderedIds: readonly string[]) =>
    new Map(Array.from(new Set(orderedIds)).map((id, index) => [id, index]));
const changedFocusOrder = (task: Task, targets: ReadonlyMap<string, number>): number | undefined => {
    const target = targets.get(task.id);
    return target !== undefined && task.focusOrder !== target ? target : undefined;
};

/** Exactly the task stamps used by reorderFocusedTasks through mutateTasks. */
export const focusOrderEffect = (scope: PreparedFocusOrder['scope'], ids: readonly string[],
    deviceId: string, preparedAt: string): PreparedFocusOrder['effect'] => {
    const byId = new Map(scope.tasks.map((task) => [task.id, task]));
    const targets = focusOrderTargets(ids);
    return { tasks: ids.flatMap((id) => {
        const before = byId.get(id);
        const target = before && changedFocusOrder(before, targets);
        return before && target !== undefined ? [{ before, after: compactPurgedTaskForLocalStorage({
            ...before, focusOrder: target, updatedAt: preparedAt,
            rev: nextRevision(before.rev), revBy: deviceId,
        }) }] : [];
    }) };
};

const currentFocusOrder = (state: TaskStore, controls: PreparedFocusOrder['request']['controls']) => {
    const model = buildFocusControlsModel({ state: controls, tasks: state.tasks,
        projects: state.projects, areas: state.areas, sections: state.sections,
        settings: state.settings, now: new Date(), t: (key) => key });
    return { canReorder: model.canReorder, tasks: model.lists.focusedTasks };
};

export const sanitizeRestoredTaskContainerReferences = (
    task: Task,
    state: Pick<TaskStore, '_allProjects' | '_allSections' | '_allAreas'>,
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

export const prepareTaskUpdatesForStore = ({
    task,
    updates,
    allProjects,
    allSections,
    allAreas,
    settings,
    futureBoundary,
    futureDates,
    nowMs,
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
    /** Frozen end of the preparation process's local day, for prepared replay validation. */
    futureBoundary?: string;
    futureDates?: FocusDateLookup;
    /** Frozen preparation clock; ordinary RN callers retain the ambient default. */
    nowMs?: number;
    reserveProjectOrder?: boolean;
    projectOrderReserver?: ProjectOrderReserver;
}): { ok: true; updates: Partial<Task> } | { ok: false; error: string } => {
    const projectReactivationTarget = findTaskProjectReactivationTarget(task, updates, allProjects);
    const containerPatch = buildTaskContainerMovePatch({
        task,
        updates,
        allProjects,
        allSections,
        allAreas,
        isReactivatingProjectSection: projectReactivationTarget
            ? (section) => section.projectId === projectReactivationTarget.id
                && isRestorableProjectArchiveSection(section)
            : undefined,
        reserveProjectOrder,
        projectOrderReserver,
    });
    if (!containerPatch.ok) return containerPatch;

    const adjustedUpdates = normalizeTaskUpdate(task, {
        ...updates,
        ...containerPatch.updates,
    }, { settings, futureBoundary, futureDates, nowMs });

    return {
        ok: true,
        updates: {
            ...adjustedUpdates,
            ...containerPatch.updates,
        },
    };
};

/** Shared batch preflight; save-only optimistic retries precede normalization. */
export const prepareTaskBatchUpdatesForStore = ({
    updatesList,
    state,
    futureBoundary,
    futureDates,
    nowMs,
}: {
    updatesList: readonly { id: string; updates: Partial<Task> }[];
    state: Pick<TaskStore, '_tasksById' | '_projectsById' | '_allProjects' | '_allSections' | '_allAreas' | 'settings' | 'persistenceFailure'>;
    futureBoundary?: string;
    futureDates?: FocusDateLookup;
    nowMs?: number;
}): { ok: false; error: string } | {
    ok: true;
    preparedUpdatesById: Map<string, Partial<Task>>;
    optimisticRetryProjectIds: string[];
} => {
    const hasInvalidCancellationTimestamp = updatesList.some(({ updates }) => (
        hasOwnField(updates, 'cancelledAt')
        && updates.cancelledAt != null
        && normalizeCancellationTimestamp(updates.cancelledAt) === undefined
    ));
    if (hasInvalidCancellationTimestamp) {
        return { ok: false, error: 'Cancellation timestamp must be an ISO datetime with timezone' };
    }
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
        return { ok: false, error: `Duplicate task ids in batch update: ${duplicateTaskIds.join(', ')}` };
    }
    const existingTaskIds = new Set(state._tasksById.keys());
    const missingIds = Array.from(new Set(
        updatesList.map((update) => update.id).filter((id) => !existingTaskIds.has(id))
    ));
    if (missingIds.length > 0) {
        return { ok: false, error: `Tasks not found: ${missingIds.join(', ')}` };
    }
    const optimisticRetryProjectIds = collectOptimisticReactivationRetryProjectIds(
        updatesList.flatMap(({ id, updates }) => {
            const task = state._tasksById.get(id);
            return task ? [{ task, updates }] : [];
        }),
        state,
    );
    const preparedUpdatesById = new Map<string, Partial<Task>>();
    if (optimisticRetryProjectIds.length > 0) {
        return { ok: true, preparedUpdatesById, optimisticRetryProjectIds };
    }
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
            futureBoundary,
            futureDates,
            nowMs,
            reserveProjectOrder: false,
        });
        if (!preparedUpdates.ok) return preparedUpdates;
        preparedUpdatesById.set(id, preparedUpdates.updates);
    }
    return { ok: true, preparedUpdatesById, optimisticRetryProjectIds };
};

/** Applies a shared batch in source-array order, with one parent transition. */
export const planTaskBatchUpdateEffects = ({
    preparedUpdatesById,
    allTasks,
    allProjects,
    allSections,
    now,
    deviceId,
    createId,
    recurrenceProjections,
}: {
    preparedUpdatesById: ReadonlyMap<string, Partial<Task>>;
    allTasks: Task[];
    allProjects: AppData['projects'];
    allSections: Section[];
    now: string;
    deviceId: string;
    createId?: () => string;
    recurrenceProjections?: ReadonlyMap<string, RecurrenceProjection | null>;
}): {
    tasks: Task[];
    projects: AppData['projects'];
    sections: Section[];
    reactivatedProjectIds: string[];
    createdTasks: Task[];
} => {
    const createdTasks: Task[] = [];
    const reactivationRequests: Array<{ task: Task; updates: Partial<Task> }> = [];
    const newAllTasksBase = [...allTasks];
    const projectOrderReserver = createProjectOrderReserver(newAllTasksBase);
    for (let index = 0; index < allTasks.length; index += 1) {
        const task = newAllTasksBase[index];
        const preparedUpdates = preparedUpdatesById.get(task.id);
        if (!preparedUpdates) continue;
        const adjustedUpdates = reserveTaskContainerProjectOrder({
            task,
            updates: preparedUpdates,
            projectOrderReserver,
        }) as Partial<Task>;
        reactivationRequests.push({ task, updates: adjustedUpdates });
        const { updatedTask, nextRecurringTask } = applyTaskUpdates(
            task,
            { ...adjustedUpdates, rev: nextRevision(task.rev), revBy: deviceId },
            now,
            createId,
            recurrenceProjections?.get(task.id),
        );
        const stampedNextRecurringTask = stampNewRecurringFollowUp(
            nextRecurringTask,
            deviceId,
            getTaskOrder(task),
            projectOrderReserver,
        );
        // Keep argument construction lazy: copying the collection once per
        // non-recurring selection makes ordinary bulk moves quadratic.
        if (stampedNextRecurringTask) {
            const duplicateFollowUp = findExistingRecurringFollowUp(
                [...newAllTasksBase, ...createdTasks],
                stampedNextRecurringTask,
                task.id,
            );
            if (!duplicateFollowUp) createdTasks.push(stampedNextRecurringTask);
        }
        newAllTasksBase[index] = updatedTask;
    }
    const newAllTasks = createdTasks.length > 0
        ? [...newAllTasksBase, ...createdTasks]
        : newAllTasksBase;
    const projectReactivation = applyTaskProjectReactivationTransition(
        reactivationRequests,
        newAllTasks,
        allProjects,
        allSections,
        now,
        deviceId,
    );
    return { ...projectReactivation, createdTasks };
};

/** Calculates the exact rows affected by one already-prepared task update. */
export const planTaskUpdateEffects = ({
    task,
    preparedUpdates,
    allTasks,
    allProjects,
    allSections,
    now,
    deviceId,
    createId,
    recurrenceProjection,
}: {
    task: Task;
    preparedUpdates: Partial<Task>;
    allTasks: Task[];
    allProjects: AppData['projects'];
    allSections: Section[];
    now: string;
    deviceId: string;
    createId?: () => string;
    recurrenceProjection?: RecurrenceProjection | null;
}): {
    updatedTask: Task;
    recurringFollowUpTask: Task | null;
    recurringCandidateTask: Task | null;
    recurringDuplicateTask: Task | null;
    tasks: Task[];
    projects: AppData['projects'];
    sections: Section[];
    reactivatedProjectIds: string[];
} => {
    const { updatedTask, nextRecurringTask } = applyTaskUpdates(
        task,
        { ...preparedUpdates, rev: nextRevision(task.rev), revBy: deviceId },
        now,
        createId,
        recurrenceProjection,
    );
    const stampedNextRecurringTask = stampNewRecurringFollowUp(
        nextRecurringTask,
        deviceId,
        getTaskOrder(task),
        // This collection scan remains lazy for updates without a follow-up.
        (projectId) => getNextProjectOrder(projectId, allTasks),
    );
    const recurringDuplicateTask = findExistingRecurringFollowUp(allTasks, stampedNextRecurringTask, task.id);
    const recurringFollowUpTask = recurringDuplicateTask
        ? null
        : stampedNextRecurringTask;
    const updatedAllTasksBase = replaceEntityInArray(allTasks, task.id, updatedTask);
    const updatedAllTasks = recurringFollowUpTask
        ? [...updatedAllTasksBase, recurringFollowUpTask]
        : updatedAllTasksBase;
    const projectReactivation = applyTaskProjectReactivationTransition(
        [{ task, updates: preparedUpdates }],
        updatedAllTasks,
        allProjects,
        allSections,
        now,
        deviceId,
    );
    return { updatedTask, recurringFollowUpTask, recurringCandidateTask: stampedNextRecurringTask,
        recurringDuplicateTask, ...projectReactivation };
};

/** The relevant complete membership for Archive Restore, including legacy Section-only children. */
export const archiveRestoreScope = (task: Task,
    data: { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] }): NativePreparedArchivedTaskRestore['scope'] => {
    const sourceSection = data.sections.find((row) => row.id === task.sectionId);
    const parentProject = data.projects.find((row) => row.id === (task.projectId ?? sourceSection?.projectId)) ?? null;
    // A legacy Section-only Task can infer this archived Project during the
    // shared container normalization, then reopen it. Freeze all of its owned
    // rows before that single Task action, just as a direct Project child does.
    const fullParent = Boolean(parentProject?.status === 'archived'
        && (task.projectId === parentProject.id || sourceSection?.projectId === parentProject.id));
    const parentSections = parentProject
        ? data.sections.filter((row) => row.projectId === parentProject.id && (fullParent || row.id === task.sectionId))
        : [];
    const sectionIds = new Set(parentSections.map((row) => row.id));
    const parentTasks = fullParent && parentProject
        ? data.tasks.filter((row) => row.projectId === parentProject.id
            || (!row.projectId && row.sectionId !== undefined && sectionIds.has(row.sectionId)))
        : [task];
    return { task, parentProject, parentTasks, parentSections,
        // Shared container resolution clears Area whenever Project/Section wins,
        // even if a legacy raw areaId names a deleted or missing Area.
        sourceArea: parentProject ? null : data.areas.find((row) => row.id === task.areaId) ?? null,
        fullParent };
};

/** RN's one `updateTask({status:'inbox'})`, including implicit archived-parent reactivation. */
export const archiveRestoreEffect = (scope: NativePreparedArchivedTaskRestore['scope'],
    deviceId: string, updateAt: string, futureBoundary: string,
    dates: FocusDateLookup): NativePreparedArchivedTaskRestore['effect'] | null => {
    const task = scope.task;
    const prepared = prepareTaskUpdatesForStore({ task, updates: { status: 'inbox' },
        allProjects: scope.parentProject ? [scope.parentProject] : [],
        allSections: scope.parentSections, allAreas: scope.sourceArea ? [scope.sourceArea] : [],
        nowMs: Date.parse(updateAt), futureBoundary, futureDates: dates });
    if (!prepared.ok) return null;
    const planned = planTaskUpdateEffects({ task, preparedUpdates: prepared.updates,
        allTasks: scope.parentTasks, allProjects: scope.parentProject ? [scope.parentProject] : [],
        allSections: scope.parentSections, now: updateAt, deviceId });
    if (planned.recurringCandidateTask || planned.recurringDuplicateTask || planned.recurringFollowUpTask) return null;
    const beforeTasks = new Map(scope.parentTasks.map((row) => [row.id, row]));
    const beforeSections = new Map(scope.parentSections.map((row) => [row.id, row]));
    const afterTask = planned.tasks.find((row) => row.id === task.id);
    if (!afterTask || afterTask.status !== 'inbox') return null;
    const tasks = planned.tasks.flatMap((after) => {
        const before = beforeTasks.get(after.id);
        return before && !taskEditValuesEqual(before, after) ? [{ before, after }] : [];
    });
    const sections = planned.sections.flatMap((after) => {
        const before = beforeSections.get(after.id);
        return before && !taskEditValuesEqual(before, after) ? [{ before, after }] : [];
    });
    const projectAfter = scope.parentProject ? planned.projects.find((row) => row.id === scope.parentProject?.id) : null;
    return { tasks, sections, project: projectAfter && scope.parentProject && !taskEditValuesEqual(scope.parentProject, projectAfter)
        ? { before: scope.parentProject, after: projectAfter } : null };
};

/** Archive one already-resolved occurrence and plan its frozen next instance. */
export const planSkippedRecurringOccurrence = ({ task, allTasks, now, deviceId, projection, createId }: {
    task: Task;
    allTasks: Task[];
    now: string;
    deviceId: string;
    /** Native prepared writes pass this frozen value; RN computes at the action boundary. */
    projection?: RecurrenceProjection | null;
    createId?: () => string;
}): { updatedTask: Task; recurringCandidateTask: Task | null; recurringDuplicateTask: Task | null;
    recurringFollowUpTask: Task | null; tasks: Task[] } => {
    if (!canSkipRecurringTaskOccurrence(task)) throw new Error('Task cannot skip an occurrence');
    const { updatedTask } = applyTaskUpdates(task, {
        status: 'archived', cancelledAt: now, rev: nextRevision(task.rev), revBy: deviceId,
    }, now);
    const recurringCandidateTask = stampNewRecurringFollowUp(
        projection === undefined
            ? createNextRecurringTask(task, now, task.status, { advanceOne: true, createId })
            : buildNextRecurringTask(task, now, task.status, projection, createId),
        deviceId, getTaskOrder(task), (projectId) => getNextProjectOrder(projectId, allTasks),
    );
    const recurringDuplicateTask = findExistingRecurringFollowUp(allTasks, recurringCandidateTask, task.id);
    const recurringFollowUpTask = recurringDuplicateTask ? null : recurringCandidateTask;
    const updatedTasks = replaceEntityInArray(allTasks, task.id, updatedTask);
    return { updatedTask, recurringCandidateTask, recurringDuplicateTask, recurringFollowUpTask,
        tasks: recurringFollowUpTask ? [...updatedTasks, recurringFollowUpTask] : updatedTasks };
};

/** The bounded Focus witness contains only columns consulted by eligibility and the cap. */
export const taskFocusWitnessRow = (task: Task): TaskFocusWitnessRow => ({
    id: task.id, status: task.status, createdAt: task.createdAt,
    projectId: task.projectId ?? null, sectionId: task.sectionId ?? null,
    startTime: task.startTime ?? null, dueDate: task.dueDate ?? null, reviewAt: task.reviewAt ?? null,
    order: task.order ?? null, orderNum: task.orderNum ?? null,
    isFocusedToday: task.isFocusedToday === true, recurrence: task.recurrence ?? null,
});

const asFocusTask = (row: TaskFocusWitnessRow): Task => ({
    id: row.id, title: '', status: row.status, createdAt: row.createdAt, updatedAt: row.createdAt,
    tags: [], contexts: [], projectId: row.projectId ?? undefined, sectionId: row.sectionId ?? undefined,
    startTime: row.startTime ?? undefined, dueDate: row.dueDate ?? undefined,
    reviewAt: row.reviewAt ?? undefined, order: row.order ?? undefined, orderNum: row.orderNum ?? undefined,
    isFocusedToday: row.isFocusedToday, recurrence: row.recurrence ?? undefined,
});

export const taskFocusScope = (state: TaskStore, task: Task): PreparedTaskFocus['scope'] => {
    const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const project = task.projectId ? state._allProjects.find((row) => row.id === task.projectId) ?? null : null;
    return {
        task, project,
        sections: byId(state._allSections.filter((row) => !row.deletedAt && row.projectId === task.projectId)),
        area: !task.projectId && task.areaId
            ? state._allAreas.find((row) => row.id === task.areaId) ?? null : null,
        peers: byId(state._allTasks.filter((row) => project && !row.deletedAt && row.projectId === task.projectId
            && ['inbox', 'next', 'waiting', 'someday'].includes(row.status)).map(taskFocusWitnessRow)),
        focused: byId(state._allTasks.filter((row) => !row.deletedAt && row.isFocusedToday === true)
            .map(taskFocusWitnessRow)),
        focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
    };
};

/** Re-evaluate the RN star policy against the frozen local day and compact rows. */
export const taskFocusAction = (scope: PreparedTaskFocus['scope'], preparedAt: string,
    futureBoundary: string, dates: FocusDateLookup): FocusStarAction => resolveFocusStarAction(scope.task, {
    tasks: scope.peers.map(asFocusTask), projects: scope.project ? [scope.project] : [],
    sections: scope.sections,
    focusedCount: countFocusedTasksBeforeBoundary(scope.focused.map(asFocusTask), futureBoundary, dates),
    focusTaskLimit: scope.focusLimit, now: new Date(preparedAt),
    endOfTodayIso: futureBoundary, frozenDates: dates,
});

/** Derive the complete Task receipt through the same normalizer/effect planner as RN updateTask. */
export const taskFocusEffect = (scope: PreparedTaskFocus['scope'], focused: boolean,
    deviceId: string, preparedAt: string, futureBoundary: string, dates: FocusDateLookup): PreparedTaskFocus['effect'] | null => {
    const action = taskFocusAction(scope, preparedAt, futureBoundary, dates);
    if (!action.canToggle || action.patch.isFocusedToday !== focused || !isTaskActionable(scope.task)
        || scope.task.deletedAt || scope.task.purgedAt
        || isStatusListTaskReadOnly(scope.task, scope.project ? [scope.project] : [])) return null;
    const normalized = prepareTaskUpdatesForStore({ task: scope.task, updates: action.patch,
        allProjects: scope.project ? [scope.project] : [], allSections: scope.sections,
        allAreas: scope.area ? [scope.area] : [], futureBoundary,
        futureDates: dates, nowMs: Date.parse(preparedAt), reserveProjectOrder: false });
    if (!normalized.ok) return null;
    const planned = planTaskUpdateEffects({ task: scope.task, preparedUpdates: normalized.updates,
        allTasks: [scope.task], allProjects: scope.project ? [scope.project] : [],
        allSections: scope.sections, now: preparedAt, deviceId });
    if (planned.recurringFollowUpTask || planned.reactivatedProjectIds.length
        || !sameSectionDeleteJson(planned.projects, scope.project ? [scope.project] : [])
        || !sameSectionDeleteJson(planned.sections, scope.sections)
        || sameTaskSqliteRow(planned.updatedTask, scope.task)) return null;
    return { task: { before: scope.task, after: planned.updatedTask } };
};

/** RN Reset's exact one-row field change, including the already-open write. */
export const buildResetTaskChecklistUpdates = (task: Task): Partial<Task> => {
    const wasDone = task.status === 'done';
    return {
        checklist: task.checklist?.map((item) => ({ ...item, isCompleted: false })),
        status: wasDone ? 'next' : task.status,
        completedAt: wasDone ? undefined : task.completedAt,
        isFocusedToday: wasDone ? false : task.isFocusedToday,
    };
};

const TASK_EDIT_REVISION_FIELDS = new Set(['rev', 'revBy', 'updatedAt']);
const INDEPENDENT_TASK_EDIT_FIELDS = new Set([
    'title', 'description', 'contexts', 'tags', 'priority', 'energyLevel', 'timeEstimate',
    'location', 'assignedTo', 'attachments', 'checklist', 'timeSpentMinutes', 'viewSectionIds', 'textDirection',
]);

type PreparedAffectedRows = Pick<PreparedInboxEffect, 'tasks' | 'projects' | 'sections'>;

/** The SQLite representation, including every revision/stamp, is the durable receipt. */
const samePreparedSqliteRow = (columns: readonly string[], jsonColumns: ReadonlySet<string>, left: unknown[], right: unknown[]) => (
    left.length === right.length && left.every((value, index) => {
        const other = right[index];
        if (!jsonColumns.has(columns[index]) || typeof value !== 'string' || typeof other !== 'string') {
            return Object.is(value, other);
        }
        return taskEditValuesEqual(JSON.parse(value), JSON.parse(other));
    })
);
const taskJsonColumns = new Set(['relativeStartOffset', 'recurrence', 'tags', 'contexts',
    'checklist', 'attachments', 'viewSectionIds']);
const projectJsonColumns = new Set(['tagIds', 'attachments']);
export const samePreparedTask = (left: Task, right: Task) => samePreparedSqliteRow(TASK_SQLITE_COLUMNS, taskJsonColumns,
    taskToSqliteRow(left), taskToSqliteRow(right));
const samePreparedProject = (left: AppData['projects'][number], right: AppData['projects'][number]) =>
    samePreparedSqliteRow(PROJECT_SQLITE_COLUMNS, projectJsonColumns, projectToSqliteRow(left), projectToSqliteRow(right));
const samePreparedSection = (left: Section, right: Section) =>
    JSON.stringify(sectionToSqliteRow(left)) === JSON.stringify(sectionToSqliteRow(right));

const inspectPreparedAffectedRows = (state: Pick<TaskStore, '_tasksById' | '_projectsById' | '_sectionsById'>, input: PreparedAffectedRows): 'after' | 'before' | 'conflict' => {
    const rows = [
        ...input.tasks.map((row) => ({ ...row, current: state._tasksById.get(row.after.id), same: samePreparedTask })),
        ...input.projects.map((row) => ({ ...row, current: state._projectsById.get(row.after.id), same: samePreparedProject })),
        ...input.sections.map((row) => ({ ...row, current: state._sectionsById.get(row.after.id), same: samePreparedSection })),
    ];
    if (rows.length === 0) return 'conflict';
    const afterMatches = rows.map(({ current, after, same }) => Boolean(current && same(current as never, after as never)));
    if (afterMatches.every(Boolean)) return 'after';
    if (afterMatches.some(Boolean) || rows.some(({ current, before, same }) => (
        before ? !current || !same(current as never, before as never) : Boolean(current)
    ))) return 'conflict';
    return 'before';
};

const applyPreparedAffectedRows = (state: Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections'>, input: PreparedAffectedRows) => ({
    tasks: [...replaceEntitiesInArray(state._allTasks, input.tasks.filter((row) => row.before).map((row) => row.after)),
        ...input.tasks.filter((row) => !row.before).map((row) => row.after)],
    projects: [...replaceEntitiesInArray(state._allProjects, input.projects.filter((row) => row.before).map((row) => row.after)),
        ...input.projects.filter((row) => !row.before).map((row) => row.after)],
    sections: [...replaceEntitiesInArray(state._allSections, input.sections.filter((row) => row.before).map((row) => row.after)),
        ...input.sections.filter((row) => !row.before).map((row) => row.after)],
});

/** The RN action and native journal share the same saved-source promotion policy. */
export const planTaskPromotion = ({ sourceTask, title, color, areaId, allTasks, allProjects, allSections,
    allAreas, settings, deviceId, now, projectId }: {
    sourceTask: Task; title?: string; color?: string; areaId?: string;
    allTasks: Task[]; allProjects: AppData['projects']; allSections: Section[]; allAreas: AppData['areas'];
    settings: AppData['settings']; deviceId: string; now: string; projectId?: string;
}): { ok: true; taskAfter: Task; targetProject: AppData['projects'][number];
    createdProject: AppData['projects'][number] | null; targetAreaId: string | undefined }
    | { ok: false; error: string } => {
    const trimmedTitle = (typeof title === 'string' ? title : sourceTask.title).trim();
    if (!trimmedTitle) return { ok: false, error: 'Project title is required' };
    const explicitAreaId = normalizeOptionalContainerId(areaId);
    const sourceProject = sourceTask.projectId ? allProjects.find((project) => project.id === sourceTask.projectId) : undefined;
    const inheritedAreaId = explicitAreaId ?? sourceTask.areaId ?? sourceProject?.areaId;
    const targetAreaId = inheritedAreaId && allAreas.some((area) => area.id === inheritedAreaId && !area.deletedAt)
        ? inheritedAreaId : undefined;
    if (explicitAreaId && !targetAreaId) return { ok: false, error: 'Area not found' };
    const existingProject = findSelectableProjectByTitleAndArea(allProjects, trimmedTitle, targetAreaId);
    const projectSupportNotes = typeof sourceTask.description === 'string' && sourceTask.description.trim()
        ? sourceTask.description.trim() : undefined;
    const projectTagIds = Array.from(new Set((sourceTask.tags || [])
        .map((tag) => typeof tag === 'string' ? tag.trim() : '').filter(Boolean)));
    const createdProject = existingProject ? null : buildNewProject({
        title: trimmedTitle, color,
        initialProps: {
            ...(targetAreaId ? { areaId: targetAreaId } : {}),
            ...(projectSupportNotes ? { supportNotes: projectSupportNotes } : {}),
            tagIds: projectTagIds,
        },
        existingProjects: allProjects, existingAreas: allAreas, settings, deviceId, now, id: projectId,
    });
    const targetProject = existingProject ?? createdProject!;
    const preparedUpdates = prepareTaskUpdatesForStore({
        task: sourceTask,
        updates: { projectId: targetProject.id, sectionId: undefined, areaId: undefined },
        allProjects: createdProject ? [...allProjects, createdProject] : allProjects,
        allSections, allAreas,
        projectOrderReserver: createProjectOrderReserver(allTasks),
    });
    if (!preparedUpdates.ok) return preparedUpdates;
    const { updatedTask } = applyTaskUpdates(sourceTask, {
        ...preparedUpdates.updates, rev: nextRevision(sourceTask.rev), revBy: deviceId,
    }, now);
    return { ok: true, taskAfter: updatedTask, targetProject, createdProject, targetAreaId };
};

export const applyPreparedTaskEditChanges = ({ before, changes }: PreparedTaskEdit): Task => ({
    ...before,
    ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value === null ? undefined : value])),
});

export const buildPreparedTaskEditChanges = (before: Task, after: Task): PreparedTaskEdit['changes'] => Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((field) => !TASK_EDIT_REVISION_FIELDS.has(field)
            && !taskEditValuesEqual(before[field as keyof Task], after[field as keyof Task]))
        .map((field) => [field, after[field as keyof Task] ?? null]),
);

const matchesPreparedTaskEdit = (current: Task, expected: Task, changes: PreparedTaskEdit['changes']): boolean => (
    [...new Set([...Object.keys(current), ...Object.keys(expected)])].every((field) => (
        TASK_EDIT_REVISION_FIELDS.has(field)
        || (INDEPENDENT_TASK_EDIT_FIELDS.has(field) && !Object.prototype.hasOwnProperty.call(changes, field))
        || taskEditValuesEqual(current[field as keyof Task], expected[field as keyof Task])
    ))
);

/** The existing duplicate row construction, shared with native preparation.
 * Generated IDs and order reservations may be supplied from an immutable journal. */
export function buildDuplicateTask({ sourceTask, asNextAction, copyId, now, deviceId, projectOrder, boardOrder, generateId = uuidv4 }: {
    sourceTask: Task;
    asNextAction?: boolean;
    copyId?: string;
    now: string;
    deviceId: string;
    projectOrder?: number;
    boardOrder?: number;
    generateId?: () => string;
}): Task {
    const duplicatedChecklist = (sourceTask.checklist || []).map((item) => ({
        ...item,
        id: generateId(),
        isCompleted: false,
    }));
    const duplicatedAttachments = (sourceTask.attachments || []).flatMap((attachment) => {
        if (attachment.kind === 'file') {
            return [];
        }
        return [{
            ...attachment,
            id: generateId(),
            createdAt: now,
            updatedAt: now,
            deletedAt: undefined,
            cloudKey: undefined,
            fileHash: undefined,
            localStatus: undefined,
        }];
    });
    const newTaskId = copyId ?? generateId();

    const newTask: Task = {
        ...sourceTask,
        id: newTaskId,
        title: sourceTask.title,
        status: asNextAction
            ? 'next'
            : isTaskFinished(sourceTask)
                ? 'inbox'
                : sourceTask.status,
        // Normalized so the rrule's series stamp names the new series too.
        recurrence: typeof sourceTask.recurrence === 'object'
            ? normalizeRecurrenceForLoad({ ...sourceTask.recurrence, seriesId: newTaskId })
            : sourceTask.recurrence,
        checklist: duplicatedChecklist.length > 0 ? duplicatedChecklist : undefined,
        attachments: duplicatedAttachments.length > 0 ? duplicatedAttachments : undefined,
        completedAt: undefined,
        cancelledAt: undefined,
        archivedAt: undefined,
        isFocusedToday: false,
        // A copy is not in Today's Focus and was never archived with a
        // project, so neither the focus position nor the restore
        // metadata of the source belongs to it.
        focusOrder: undefined,
        boardOrder: undefined,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        deletedAt: undefined,
        purgedAt: undefined,
        createdAt: now,
        updatedAt: now,
        rev: 1,
        revBy: deviceId,
        order: projectOrder,
        orderNum: projectOrder,
    };
    if (newTask.status === sourceTask.status) {
        newTask.boardOrder = boardOrder;
    }
    return newTask;
}

export const createTaskActions = ({ set, get, getStorage, debouncedSave, flushPendingSave, trackImmediateSave, hasQueuedSnapshotSave, getSaveGeneration }: TaskActionContext): TaskActions => {
    // The family-specific full envelope and raw authority checks remain caller-owned.
    const commitPreparedRawReferenceBatch = async (input: {
        request: { taskIds: string[] }; effect: { tasks: { before: Task; after: Task }[];
            projects: { before: Project; after: Project }[]; sections: { before: Section; after: Section }[];
            createdTasks?: Task[] }; deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    }, authority: PreparedAreaAuthority, family: ((input: unknown) => ReferenceBatchValidator) | undefined,
    conflictMessage: string): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: conflictMessage };
        const adapter = getStorage();
        // These modules import the store, so they register themselves (store-reference-batch-modules.ts). Capture the
        // adapter, yield once as the module load did, then retain every guard after the await.
        await Promise.resolve();
        const shared = referenceBatchModules.shared;
        try {
            logInfo('Reference bulk action validators read', {
                scope: 'store', category: 'storage',
                context: { releaseCheck: 'v1.3.5/reference-batch-registry', outcome: family && shared ? 'registered' : 'missing' },
            });
        } catch { /* Diagnostics must not affect the guarded action. */ }
        if (!family || !shared) return result;
        const { validateEnvelope, authorityMatches } = family(input);
        const { historyRowLoadProjection, NativeReceiptSqliteAdapter } = shared;
        if (getStorage() !== adapter || !(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded
            || !validateEnvelope()) return result;
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            try { if (!authorityMatches(durable)) return memory; } catch { return memory; }
            const bindRows = <T extends { id: string }>(rows: T[], pairs: { before: T; after: T }[],
                snapshot: (row: T) => T | null): Map<string, T> | null => {
                const current = new Map(rows.map((row) => [row.id, row])); const after = new Map<string, T>();
                for (const pair of pairs) {
                    const saved = current.get(pair.before.id);
                    if (!saved || pair.after.id !== pair.before.id || after.has(pair.before.id)
                        || !taskEditValuesEqual(snapshot(saved), pair.before)) return null;
                    after.set(pair.before.id, pair.after);
                }
                return after;
            };
            const taskAfter = bindRows(durable.tasks, input.effect.tasks, rawReadTaskSnapshot);
            const projectAfter = bindRows(durable.projects, input.effect.projects, rawReadProjectSnapshot);
            const sectionAfter = bindRows(durable.sections, input.effect.sections, (row) => row);
            if (!taskAfter || !projectAfter || !sectionAfter) return memory;
            const tasks = [...durable.tasks.map((row) => taskAfter.get(row.id) ?? row), ...(input.effect.createdTasks ?? [])];
            const projects = durable.projects.map((row) => projectAfter.get(row.id) ?? row);
            const sections = durable.sections.map((row) => sectionAfter.get(row.id) ?? row);
            const settings = input.deviceIdToInitialize ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            const freshTasks = tasks.map((row) => historyRowLoadProjection(row, input.updateAt));
            const freshProjects = projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks, _allProjects: durable.projects,
                _allSections: durable.sections, _allAreas: durable.areas, _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, tasks, projects, sections, settings });
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, ids: [...input.request.taskIds], outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects, _allSections: sections,
                _allAreas: durable.areas, _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    };
    return ({

    /**
     * Add a new task to the store and persist to storage.
     * @param title Task title
     * @param initialProps Optional initial properties
     */
    addTask: async (
        title: string,
        initialProps?: Partial<Task>,
        options?: { captureId: string },
    ) => {
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            const message = 'Task title is required';
            set({ error: message });
            return actionFail(message);
        }
        const result = await get().addTasks([{
            title: trimmedTitle,
            initialProps,
            ...(options ? { captureId: options.captureId } : {}),
        }]);
        if (!result.success) return result;
        return actionOk({ id: result.ids?.[0] });
    },

    /**
     * Add multiple tasks in one store update and persistence snapshot.
     */
    addTasks: async (items: Array<{
        title: string;
        initialProps?: Partial<Task>;
        captureId?: string;
    }>) => {
        const changeAt = Date.now();
        const hasInvalidCaptureId = items.some(({ captureId }) => (
            captureId !== undefined
            && (typeof captureId !== 'string' || !CAPTURE_ID_PATTERN.test(captureId))
        ));
        if (hasInvalidCaptureId) {
            return actionFail('Capture ID must be a UUID');
        }
        const normalizedItems = items.map((item) => ({
            title: typeof item.title === 'string' ? item.title.trim() : '',
            initialProps: item.initialProps ?? {},
            captureId: item.captureId?.toLowerCase(),
        })).filter((item) => item.title.length > 0);
        if (normalizedItems.length === 0) return actionOk({ ids: [] });

        const currentState = get();
        const plannedTaskIds = new Set(currentState._allTasks.map((task) => task.id));
        const hasInvalidCancellationTimestamp = normalizedItems.some((item) => {
            const isReplay = item.captureId !== undefined && plannedTaskIds.has(item.captureId);
            if (item.captureId !== undefined) plannedTaskIds.add(item.captureId);
            if (isReplay) return false;
            const { initialProps } = item;
            return hasOwnField(initialProps, 'cancelledAt')
                && initialProps.cancelledAt != null
                && normalizeCancellationTimestamp(initialProps.cancelledAt) === undefined;
        });
        if (hasInvalidCancellationTimestamp) {
            const message = 'Cancellation timestamp must be an ISO datetime with timezone';
            set({ error: message });
            return actionFail(message);
        }
        const now = new Date().toISOString();
        const nextAllTasks = [...currentState._allTasks];
        const knownTaskIds = new Set(currentState._allTasks.map((task) => task.id));
        const newTasks: Task[] = [];
        const resultIds: string[] = [];
        let creationContext: {
            deviceState: ReturnType<typeof ensureDeviceId>;
            focusTaskLimit: number;
            focusedCount: number;
            projectOrderReserver: ProjectOrderReserver;
        } | null = null;

        for (const item of normalizedItems) {
            if (item.captureId && knownTaskIds.has(item.captureId)) {
                resultIds.push(item.captureId);
                continue;
            }

            const initialTaskProps = item.initialProps;
            if (!creationContext) {
                creationContext = {
                    deviceState: ensureDeviceId(currentState.settings),
                    focusTaskLimit: normalizeFocusTaskLimit(currentState.settings.gtd?.focusTaskLimit),
                    focusedCount: currentState.getFocusedCount(),
                    projectOrderReserver: createProjectOrderReserver(currentState._allTasks),
                };
            }
            const built = buildNewTask({
                title: item.title,
                initialTaskProps,
                id: item.captureId ?? uuidv4(),
                now,
                deviceId: creationContext.deviceState.deviceId,
                state: currentState,
                tasks: nextAllTasks,
                focusedCount: creationContext.focusedCount,
                focusTaskLimit: creationContext.focusTaskLimit,
                projectOrderReserver: creationContext.projectOrderReserver,
            });
            if (!built.ok) {
                set({ error: built.error });
                return actionFail(built.error);
            }
            const newTask = built.task;
            creationContext.focusedCount = built.focusedCount;

            newTasks.push(newTask);
            nextAllTasks.push(newTask);
            knownTaskIds.add(newTask.id);
            resultIds.push(newTask.id);
        }

        if (newTasks.length === 0) {
            if (currentState.persistenceFailure) {
                try {
                    // A terminal flush dequeues its exhausted snapshot. Replay
                    // must durably retry the unchanged optimistic capture
                    // before native ingress is allowed to acknowledge it.
                    await get().persistSnapshot();
                    await flushPendingSave();
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    const message = `Failed to save captured task: ${detail}`;
                    set({ error: message });
                    return actionFail(message);
                }
            }
            return actionOk({ id: resultIds[0], ids: resultIds });
        }
        const completedCreationContext = creationContext;
        if (!completedCreationContext) {
            return actionFail('Failed to initialize task creation');
        }

        set((state) => {
            persist(set, debouncedSave, state, {
                tasks: nextAllTasks,
                ...(completedCreationContext.deviceState.updated
                    ? { settings: completedCreationContext.deviceState.settings }
                    : {}),
            });
            return {
                _allTasks: nextAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(completedCreationContext.deviceState.updated
                    ? { settings: completedCreationContext.deviceState.settings }
                    : {}),
            };
        });

        const queuedCount = newTasks.filter((task) => task.isFocusedToday && isTaskFutureFocusCandidate(task)).length;
        if (queuedCount > 0) logInfo('Scheduled Focus queued', {
            scope: 'store',
            category: 'storage',
            context: { releaseCheck: 'v1.3.3/scheduled-focus-queue', operation: 'create', count: queuedCount },
        });

        return actionOk({ id: resultIds[0], ids: resultIds });
    },

    commitPreparedCapture: async ({ task, project, deviceIdToInitialize, deviceIdBefore }, raw) => {
        if (raw) {
            let result = actionFail('Prepared capture conflicts with current saved data');
            set((memory) => {
                const before = raw.authority.state; const durable = raw.authority.snapshot;
                if (raw.requireBefore !== true || project !== null
                    || memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                    || memory._allSections !== before._allSections || memory._allAreas !== before._allAreas
                    || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                    || memory.lastDataChangeAt !== before.lastDataChangeAt
                    || raw.rawBefore.tasks.length !== 1 || raw.rawBefore.tasks[0].id !== task.id
                    || raw.rawBefore.tasks[0].before !== null || raw.rawBefore.projects.length || raw.rawBefore.sections.length
                    || durable.tasks.some((row) => row.id === task.id)
                    || (durable.settings.deviceId ?? null) !== deviceIdBefore
                    || (deviceIdBefore === null ? !deviceIdToInitialize : deviceIdToInitialize !== null)) return memory;
                const container = resolveTaskContainerAssignment({ projectId: task.projectId, sectionId: task.sectionId,
                    areaId: task.areaId, allProjects: durable.projects, allSections: durable.sections ?? [], allAreas: durable.areas ?? [] });
                if (!container.ok || container.projectId !== task.projectId || container.sectionId !== task.sectionId
                    || container.areaId !== task.areaId || task.projectId && !durable.projects.some((row) => row.id === task.projectId
                        && isSelectableProjectForTaskAssignment(row))) return memory;
                const tasks = [...durable.tasks, task];
                const settings = deviceIdToInitialize ? { ...durable.settings, deviceId: deviceIdToInitialize } : durable.settings;
                const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
                const projects = durable.projects.map(normalizeProjectLifecycleFields);
                clearDerivedCache();
                persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks, _allProjects: durable.projects,
                    _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [],
                    settings: durable.settings }, { ...durable, tasks, settings });
                const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
                raw.authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                    generation: getSaveGeneration(), failure: memory.persistenceFailure };
                result = actionOk({ id: task.id });
                return { _allTasks: freshTasks, _allProjects: projects, _allSections: durable.sections ?? [],
                    _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings, lastDataChangeAt };
            });
            return result;
        }
        let result = actionFail('Prepared capture conflicts with current data');
        set((state) => {
            const existingTask = state._allTasks.find((entry) => entry.id === task.id);
            const existingProject = project && state._allProjects.find((entry) => entry.id === project.id);
            const sameTask = existingTask && !existingTask.deletedAt && !existingTask.purgedAt
                && JSON.stringify(taskToSqliteRow(existingTask)) === JSON.stringify(taskToSqliteRow(task));
            const sameProject = existingProject && !existingProject.deletedAt && !existingProject.purgedAt
                && JSON.stringify(projectToSqliteRow(existingProject)) === JSON.stringify(projectToSqliteRow(project!));
            if ((existingTask && !sameTask) || (existingProject && !sameProject)) return state;
            // A matching receipt precedes mutable container/creation checks. Never
            // resurrect an operation-created project missing from an existing task.
            if (existingTask) {
                if (project && !sameProject) return state;
                result = actionOk({ id: task.id });
                return state;
            }
            if (project && !existingProject && findSelectableProjectByTitleAndArea(state._allProjects, project.title, project.areaId)) return state;
            const projects = project && !existingProject ? [...state._allProjects, project] : state._allProjects;
            if (task.projectId && !projects.some((entry) => entry.id === task.projectId && isSelectableProjectForTaskAssignment(entry))) return state;
            if (project?.areaId && !state._allAreas.some((entry) => entry.id === project.areaId && !entry.deletedAt)) return state;
            const container = resolveTaskContainerAssignment({
                projectId: task.projectId, sectionId: task.sectionId, areaId: task.areaId,
                allProjects: projects, allSections: state._allSections, allAreas: state._allAreas,
            });
            if (!container.ok || container.projectId !== task.projectId || container.sectionId !== task.sectionId || container.areaId !== task.areaId) return state;
            const tasks = [...state._allTasks, task];
            const settings = !state.settings.deviceId && deviceIdToInitialize
                ? { ...state.settings, deviceId: deviceIdToInitialize }
                : state.settings;
            persist(set, debouncedSave, state, { tasks, projects, ...(settings !== state.settings ? { settings } : {}) });
            result = actionOk({ id: task.id });
            return {
                _allTasks: tasks,
                _allProjects: projects,
                settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt),
            };
        });
        return result;
    },

    // The contract validates action authority before this guarded one-row commit.
    commitPreparedBoardTask: async ({ kind, before, after, deviceIdBefore, deviceIdToInitialize, respectReadOnly, strictBefore }) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Board action conflicts with current data' };
        const persisted = (task: Task) => {
            // Normal loading adds pushCount: 0 without saving it. A raw recovery
            // row must match that default while retaining every other CAS field.
            const values = taskToSqliteRow({ ...task, pushCount: task.pushCount ?? 0 });
            return taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]])));
        };
        const matches = (left: Task, right: Task) => taskEditValuesEqual(persisted(left), persisted(right));
        set((state) => {
            const target = state._tasksById.get(after.id);
            // An unchanged durable copy is a receipt even if its source was
            // subsequently edited, deleted or moved to another container.
            if (!strictBefore && target && matches(target, after)) {
                result = { success: true, id: after.id, outcome: 'replayed' };
                return state;
            }
            const source = state._tasksById.get(before.id);
            if (!source || !matches(source, before) || source.purgedAt
                || (kind === 'restoreTask' ? !source.deletedAt : Boolean(source.deletedAt))
                || (kind === 'restoreTask' && (state.settings.deviceId ?? null) !== deviceIdBefore)
                || (kind === 'duplicateTask' && target)) return state;
            if (respectReadOnly && kind === 'trashTask' && isStatusListTaskReadOnly(source, state._allProjects)) return state;
            if (kind === 'restoreTask') {
                const sanitized = sanitizeRestoredTaskContainerReferences(source, state);
                if (after.deletedAt || after.purgedAt || !taskEditValuesEqual(sanitized, {
                    projectId: after.projectId, sectionId: after.sectionId, areaId: after.areaId,
                })) return state;
            }
            if (kind === 'duplicateTask') {
                // Recheck only the scalar reservations the pure builder read.
                // Exact target replay above deliberately precedes these guards.
                const projectOrder = before.projectId ? createProjectOrderReserver(state._allTasks)(before.projectId) : undefined;
                const boardOrder = after.status === before.status ? boardOrderForDuplicate(before.boardOrder,
                    state._allTasks.filter((task) => task.status === before.status && !task.deletedAt)) : undefined;
                if (projectOrder !== after.order || boardOrder !== after.boardOrder) return state;
                const container = resolveTaskContainerAssignment({
                    projectId: after.projectId, sectionId: after.sectionId, areaId: after.areaId,
                    allProjects: state._allProjects, allSections: state._allSections, allAreas: state._allAreas,
                });
                if (!container.ok || container.projectId !== after.projectId || container.sectionId !== after.sectionId
                    || container.areaId !== after.areaId || (after.projectId && !state._allProjects.some((project) =>
                        project.id === after.projectId && isSelectableProjectForTaskAssignment(project)))) {
                    result = { success: false, reason: 'invalid', error: 'Prepared duplicate destination is no longer available' };
                    return state;
                }
            }
            const tasks = kind === 'duplicateTask' ? [...state._allTasks, after] : replaceEntityInArray(state._allTasks, before.id, after);
            const settings = !state.settings.deviceId && deviceIdToInitialize
                ? { ...state.settings, deviceId: deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks, ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: after.id, outcome: 'applied' };
            return { _allTasks: tasks, settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedCalendarTask: async ({ before, after, deviceIdBefore, deviceIdToInitialize }: PreparedCalendarTask) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Calendar schedule conflicts with current data' };
        const persisted = (task: Task) => {
            const values = taskToSqliteRow(task);
            return taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]])));
        };
        const matches = (left: Task, right: Task) => taskEditValuesEqual(persisted(left), persisted(right));
        set((state) => {
            const current = state._tasksById.get(after.id);
            if (!current) {
                result = { success: false, reason: 'missing', error: 'Task not found' };
                return state;
            }
            // The complete stamped row is the receipt. Subsequent task and
            // container edits have no power to invalidate an already saved result.
            if (matches(current, after)) {
                result = { success: true, id: after.id, outcome: 'replayed' };
                return state;
            }
            if (!matches(current, before) || before.id !== after.id
                || (state.settings.deviceId ?? null) !== deviceIdBefore
                || (deviceIdToInitialize !== null && (deviceIdBefore !== null || after.revBy !== deviceIdToInitialize))
                || current.deletedAt || current.purgedAt || current.status === 'reference'
                || isStatusListTaskReadOnly(current, state._allProjects)) return state;
            const container = resolveTaskContainerAssignment({
                projectId: after.projectId, sectionId: after.sectionId, areaId: after.areaId,
                allProjects: state._allProjects, allSections: state._allSections, allAreas: state._allAreas,
            });
            if (!container.ok || container.projectId !== after.projectId
                || container.sectionId !== after.sectionId || container.areaId !== after.areaId) return state;
            const tasks = replaceEntityInArray(state._allTasks, before.id, after);
            const settings = deviceIdToInitialize && !state.settings.deviceId
                ? { ...state.settings, deviceId: deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks, ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: after.id, outcome: 'applied' };
            return { _allTasks: tasks, settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedCalendarCreate: async ({ task, project, intent, creation, deviceIdBefore, deviceIdToInitialize, defaultAreaWitness }: PreparedCalendarCreate) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Calendar creation conflicts with current data' };
        const sameTask = (left: Task, right: Task) => JSON.stringify(taskToSqliteRow(left)) === JSON.stringify(taskToSqliteRow(right));
        set((state) => {
            const existingTask = state._tasksById.get(task.id);
            // The full durable task row answers a lost reply before any mutable
            // project, setting, area, order or Focus input is inspected.
            if (existingTask) {
                if (sameTask(existingTask, task)) result = { success: true, id: task.id, outcome: 'replayed' };
                return state;
            }
            if (defaultAreaWitness) {
                const current = state._allAreas.find((area) => area.id === defaultAreaWitness.id);
                if (defaultAreaWitness.before === null ? Boolean(current)
                    : !current || (current.deletedAt ?? null) !== defaultAreaWitness.before.deletedAt) return state;
            }
            // This command publishes task and optional project together. An
            // occupied generated project ID with no task is a conflict, never
            // a partial-commit recovery or an overwrite.
            if (project && state._projectsById.has(project.id)) return state;
            const usesDefaultArea = !intent.projectToCreate && !intent.props.projectId
                && !Object.prototype.hasOwnProperty.call(intent.props, 'areaId');
            if ((state.settings.deviceId ?? null) !== deviceIdBefore
                || (deviceIdBefore === null ? !deviceIdToInitialize : deviceIdToInitialize !== null)
                || (usesDefaultArea && (state.settings.gtd?.defaultAreaMode !== (creation.defaultAreaMode ?? undefined)
                    || state.settings.gtd?.defaultAreaId !== (creation.defaultAreaId ?? undefined)))
                || (project && state.settings.gtd?.defaultProjectFlowMode !== (creation.defaultProjectFlowMode ?? undefined))) return state;
            const currentAreas = state._allAreas.filter((area) => creation.areas.some((frozen) => frozen.id === area.id));
            if (currentAreas.length !== creation.areas.length
                || creation.areas.some((frozen) => {
                    const current = currentAreas.find((area) => area.id === frozen.id);
                    return !current || current.name !== frozen.name || current.deletedAt !== frozen.deletedAt;
                })) return state;
            if (creation.selectedProject) {
                const current = state._projectsById.get(creation.selectedProject.id);
                if (!current || current.status !== creation.selectedProject.status
                    || current.deletedAt !== creation.selectedProject.deletedAt
                    || current.purgedAt !== creation.selectedProject.purgedAt
                    || current.areaId !== creation.selectedProject.areaId
                    || current.isSequential !== creation.selectedProject.isSequential
                    || current.sequentialScope !== creation.selectedProject.sequentialScope
                    || !isSelectableProjectForTaskAssignment(current)) return state;
            }
            if (project) {
                const targetArea = intent.projectToCreate?.areaId ?? null;
                const currentMax = state._allProjects.filter((item) => (item.areaId ?? null) === targetArea)
                    .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1);
                if (currentMax !== creation.projectOrderMax
                    || findSelectableProjectByTitleAndArea(state._allProjects, project.title, project.areaId)) return state;
            }
            const projects = project ? [...state._allProjects, project] : state._allProjects;
            const container = resolveTaskContainerAssignment({
                projectId: task.projectId, sectionId: task.sectionId, areaId: task.areaId,
                allProjects: projects, allSections: state._allSections, allAreas: state._allAreas,
            });
            if (!container.ok || container.projectId !== task.projectId || container.sectionId !== task.sectionId
                || container.areaId !== task.areaId || (task.projectId && !projects.some((item) =>
                    item.id === task.projectId && isSelectableProjectForTaskAssignment(item)))) return state;
            const currentOrderMax = task.projectId ? (getNextProjectOrder(task.projectId, state._allTasks) ?? 0) - 1 : null;
            if (currentOrderMax !== creation.taskOrderMax) return state;
            if (creation.focusRequested) {
                if (!creation.focusEndOfTodayIso
                    || countFocusedTasksBeforeBoundary(state.tasks, creation.focusEndOfTodayIso) !== creation.focusCount
                    || normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit) !== creation.focusLimit
                    || (creation.sequentialEmpty && task.projectId
                        && state._allTasks.some((entry) => entry.projectId === task.projectId))) return state;
            }
            const tasks = [...state._allTasks, task];
            const settings = deviceIdToInitialize && !state.settings.deviceId
                ? { ...state.settings, deviceId: deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks, projects, ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: task.id, outcome: 'applied' };
            return { _allTasks: tasks, _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    /** One guarded Process Inbox publication; the native contract proves the effect first. */
    commitPreparedInboxEffect: async (input: PreparedInboxEffect) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Process Inbox change conflicts with current data' };
        set((state) => {
            const receipt = inspectPreparedAffectedRows(state, input);
            // Every target row is the complete durable receipt. It precedes all
            // settings, source, membership and order guards that may later change.
            if (receipt === 'after') {
                result = { success: true, id: input.sourceBefore.id, outcome: 'replayed' };
                return state;
            }
            if (receipt !== 'before') return state;
            const source = state._tasksById.get(input.sourceBefore.id);
            if (!source || !samePreparedTask(source, input.sourceBefore)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return state;
            const { guards } = input;
            if (guards.selectedProject && !input.projects.some((row) => row.after.id === guards.selectedProject!.id)) {
                const selected = state._projectsById.get(guards.selectedProject.id);
                if (!selected || !samePreparedProject(selected, guards.selectedProject)
                    || !isSelectableProjectForTaskAssignment(selected)) return state;
            }
            if (guards.selectedArea) {
                const selected = state._areasById.get(guards.selectedArea.id);
                if (!selected || selected.deletedAt || selected.name !== guards.selectedArea.name
                    || selected.deletedAt !== guards.selectedArea.deletedAt) return state;
            }
            if (guards.defaultScheduleTime !== null
                && (state.settings.gtd?.defaultScheduleTime ?? '') !== guards.defaultScheduleTime) return state;
            if (guards.creationSettings && ((state.settings.gtd?.defaultAreaMode ?? null) !== guards.creationSettings.defaultAreaMode
                || (state.settings.gtd?.defaultAreaId ?? null) !== guards.creationSettings.defaultAreaId
                || (state.settings.gtd?.defaultProjectFlowMode ?? null) !== guards.creationSettings.defaultProjectFlowMode)) return state;
            if (!taskEditValuesEqual(resolveProcessInboxPlan(state.settings), guards.plan)
                || (guards.defaultProjectFlowMode !== null
                    && (state.settings.gtd?.defaultProjectFlowMode ?? null) !== guards.defaultProjectFlowMode)) return state;
            if (guards.projectOrder) {
                const max = state._allProjects.filter((project) => (project.areaId ?? null) === guards.projectOrder!.areaId)
                    .reduce((highest, project) => Math.max(highest, Number.isFinite(project.order) ? project.order : -1), -1);
                if (max !== guards.projectOrder.max) return state;
            }
            for (const guard of guards.taskOrders) {
                const max = (getNextProjectOrder(guard.projectId, state._allTasks) ?? 0) - 1;
                if (max !== guard.max) return state;
            }
            if (guards.reactivation) {
                const currentTaskIds = state._allTasks.filter((task) => task.projectId === guards.reactivation!.projectId)
                    .map((task) => task.id).sort();
                const currentSectionIds = state._allSections.filter((section) => section.projectId === guards.reactivation!.projectId)
                    .map((section) => section.id).sort();
                if (JSON.stringify(currentTaskIds) !== JSON.stringify(guards.reactivation.taskIds)
                    || JSON.stringify(currentSectionIds) !== JSON.stringify(guards.reactivation.sectionIds)) return state;
            }
            if (guards.recurringCandidate) {
                const duplicate = findExistingRecurringFollowUp(state._allTasks, guards.recurringCandidate, input.sourceBefore.id);
                if (guards.recurringDuplicate
                    ? !duplicate || !samePreparedTask(duplicate, guards.recurringDuplicate)
                    : Boolean(duplicate)) return state;
            }
            if (guards.focusCount !== null) {
                if (!guards.focusBoundary || guards.focusLimit === null
                    || countFocusedTasksBeforeBoundary(state.tasks, guards.focusBoundary) !== guards.focusCount
                    || normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit) !== guards.focusLimit) return state;
            }
            const { tasks, projects, sections } = applyPreparedAffectedRows(state, input);
            if (input.projects.some((row) => !row.before && findSelectableProjectByTitleAndArea(
                state._allProjects, row.after.title, row.after.areaId,
            ))) return state;
            for (const row of input.tasks) {
                if (row.after.deletedAt || row.after.purgedAt) continue;
                const container = resolveTaskContainerAssignment({ projectId: row.after.projectId,
                    sectionId: row.after.sectionId, areaId: row.after.areaId,
                    allProjects: projects, allSections: sections, allAreas: state._allAreas });
                if (!container.ok || container.projectId !== row.after.projectId
                    || container.sectionId !== row.after.sectionId || container.areaId !== row.after.areaId) return state;
            }
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks, projects, sections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: input.sourceBefore.id, outcome: 'applied' };
            return { _allTasks: tasks, _allProjects: projects, _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    /** A frozen checklist/editor Save or saved-list Reset, including induced rows. */
    commitPreparedChecklistEffect: async (input: PreparedChecklistEffect, options?: PreparedChecklistWriteOptions) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared checklist change conflicts with current data' };
        set((memory) => {
            const raw = options && 'authority' in options ? options : null;
            let durable: AppData | null = null;
            let state: Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | '_tasksById'
                | '_projectsById' | '_sectionsById' | '_areasById' | 'tasks' | 'settings'> = memory;
            if (raw) {
                if (raw.requireBefore !== true) return memory;
                const before = raw.authority.state;
                if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                    || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                    || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                    || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
                durable = raw.authority.snapshot;
                const binds = <T extends { id: string }>(rows: T[], effects: Array<{ before: T | null; after: T }>,
                    bound: Array<{ id: string; before: T | null }>): boolean => bound.length === effects.length
                    && new Set(bound.map((row) => row.id)).size === bound.length
                    && effects.every((effect) => {
                        const captured = bound.find((row) => row.id === effect.after.id);
                        const current = rows.filter((row) => row.id === effect.after.id);
                        return captured !== undefined && (effect.before === null
                            ? captured.before === null && current.length === 0
                            : captured.before !== null && current.length === 1
                                && sameSectionDeleteJson(current[0], captured.before));
                    });
                const boundTasks = durable.tasks.map(rawReadTaskSnapshot);
                if (boundTasks.some((row) => row === null) || !binds(boundTasks.filter((row): row is Task => row !== null), input.tasks, raw.rawBefore.tasks)
                    || !binds(durable.projects, input.projects, raw.rawBefore.projects)
                    || !binds(durable.sections ?? [], input.sections, raw.rawBefore.sections)) return memory;
                const at = input.tasks.find((row) => row.after.id === input.sourceBefore.id)?.after.updatedAt;
                if (!at) return memory;
                const tasks = durable.tasks.map((task) => {
                    const values = taskToSqliteRow(task);
                    return normalizeTaskForLoad(mapSqliteTaskRow(Object.fromEntries(
                        TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]))), at);
                });
                const projects = durable.projects.map(normalizeProjectLifecycleFields);
                const sections = durable.sections ?? []; const areas = durable.areas ?? [];
                state = { _allTasks: tasks, _allProjects: projects, _allSections: sections, _allAreas: areas,
                    _tasksById: new Map(tasks.map((row) => [row.id, row])),
                    _projectsById: new Map(projects.map((row) => [row.id, row])),
                    _sectionsById: new Map(sections.map((row) => [row.id, row])),
                    _areasById: new Map(areas.map((row) => [row.id, row])), tasks,
                    settings: durable.settings };
            }
            // A complete target receipt takes precedence over every mutable
            // setting, source, membership, and order guard on cold recovery.
            const receipt = inspectPreparedAffectedRows(state, input);
            if (receipt === 'after') {
                // A new receipted completion UUID must never claim another request's
                // already-applied effect. Only its own durable receipt can replay.
                if (options?.requireBefore) return memory;
                result = { success: true, id: input.sourceBefore.id, outcome: 'replayed' };
                return memory;
            }
            if (receipt !== 'before') return memory;
            const source = state._tasksById.get(input.sourceBefore.id);
            if (!source || !samePreparedTask(source, input.sourceBefore)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return memory;
            const { guards } = input;
            if (guards.selectedProject && !input.projects.some((row) => row.after.id === guards.selectedProject!.id)) {
                const selected = state._projectsById.get(guards.selectedProject.id);
                if (!selected || !samePreparedProject(selected, guards.selectedProject)
                    || !isSelectableProjectForTaskAssignment(selected)) return memory;
            }
            if (guards.selectedArea) {
                const selected = state._areasById.get(guards.selectedArea.id);
                if (!selected || selected.deletedAt || selected.name !== guards.selectedArea.name
                    || selected.deletedAt !== guards.selectedArea.deletedAt) return memory;
            }
            for (const guard of guards.taskOrders) {
                const max = (getNextProjectOrder(guard.projectId, state._allTasks) ?? 0) - 1;
                if (max !== guard.max) return memory;
            }
            if (guards.reactivation) {
                const ids = state._allTasks.filter((task) => task.projectId === guards.reactivation!.projectId).map((task) => task.id).sort();
                const sections = state._allSections.filter((section) => section.projectId === guards.reactivation!.projectId)
                    .map((section) => section.id).sort();
                if (JSON.stringify(ids) !== JSON.stringify(guards.reactivation.taskIds)
                    || JSON.stringify(sections) !== JSON.stringify(guards.reactivation.sectionIds)) return memory;
            }
            if (guards.recurringCandidate) {
                const duplicate = findExistingRecurringFollowUp(state._allTasks, guards.recurringCandidate, input.sourceBefore.id);
                if (guards.recurringDuplicate
                    ? !duplicate || !samePreparedTask(duplicate, guards.recurringDuplicate)
                    : Boolean(duplicate)) return memory;
            }
            if (guards.focusCount !== null) {
                if (!guards.focusBoundary || guards.focusLimit === null
                    || countFocusedTasksBeforeBoundary(state.tasks, guards.focusBoundary) !== guards.focusCount
                    || normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit) !== guards.focusLimit) return memory;
            }
            if (guards.autoArchiveDays !== null && (state.settings.gtd?.autoArchiveDays ?? null) !== guards.autoArchiveDays) return memory;
            const { tasks, projects, sections } = applyPreparedAffectedRows(state, input);
            for (const row of input.tasks) {
                if (row.after.deletedAt || row.after.purgedAt) continue;
                const container = resolveTaskContainerAssignment({ projectId: row.after.projectId,
                    sectionId: row.after.sectionId, areaId: row.after.areaId,
                    allProjects: projects, allSections: sections, allAreas: state._allAreas });
                if (!container.ok || container.projectId !== row.after.projectId
                    || container.sectionId !== row.after.sectionId || container.areaId !== row.after.areaId) return memory;
            }
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            if (raw && durable) {
                // The guards inspect the actual normal-load view; the save overlays
                // only affected rows over the complete original durable snapshot.
                const overlay = <T extends { id: string }>(rows: T[], effects: Array<{ before: T | null; after: T }>) =>
                    [...replaceEntitiesInArray(rows, effects.filter((row) => row.before).map((row) => row.after)),
                        ...effects.filter((row) => !row.before).map((row) => row.after)];
                const savedTasks = overlay(durable.tasks, input.tasks);
                const savedProjects = overlay(durable.projects, input.projects);
                const savedSections = overlay(durable.sections ?? [], input.sections);
                const freshTasks = savedTasks.map((row) => normalizeTaskForLoad(row));
                const freshProjects = savedProjects.map(normalizeProjectLifecycleFields);
                clearDerivedCache();
                persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks, _allProjects: durable.projects,
                    _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [],
                    settings: durable.settings }, { ...durable, tasks: savedTasks, projects: savedProjects,
                    sections: savedSections, settings });
                const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
                raw.authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                    generation: getSaveGeneration(), failure: memory.persistenceFailure };
                result = { success: true, id: input.sourceBefore.id, outcome: 'applied' };
                return { _allTasks: freshTasks, _allProjects: freshProjects, _allSections: savedSections,
                    _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings, lastDataChangeAt };
            }
            persist(set, debouncedSave, memory, { tasks, projects, sections,
                ...(settings !== memory.settings ? { settings } : {}) });
            result = { success: true, id: input.sourceBefore.id, outcome: 'applied' };
            return { _allTasks: tasks, _allProjects: projects, _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(memory.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedTaskEdit: async ({ before, changes }) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared task edit conflicts with current data' };
        const after = applyPreparedTaskEditChanges({ before, changes });
        if (['id', 'createdAt', 'rev', 'revBy', 'updatedAt', 'deletedAt', 'purgedAt'].some((field) => Object.prototype.hasOwnProperty.call(changes, field))) {
            return { success: false, reason: 'invalid', error: 'Prepared task edit changes protected fields' };
        }
        set((state) => {
            const current = state._allTasks.find((entry) => entry.id === before.id);
            if (!current) {
                result = { success: false, reason: 'missing', error: 'Task not found' };
                return state;
            }
            // The complete applied state precedes mutable container checks. A
            // content match still needs the contract's durable-save barrier.
            if (matchesPreparedTaskEdit(current, after, changes)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!matchesPreparedTaskEdit(current, before, changes)) return state;
            if (current.deletedAt || current.purgedAt || current.status === 'reference'
                || isStatusListTaskReadOnly(current, state._allProjects)) {
                result = { success: false, reason: 'invalid', error: 'Task is not editable' };
                return state;
            }
            const container = resolveTaskContainerAssignment({
                projectId: after.projectId, sectionId: after.sectionId, areaId: after.areaId,
                allProjects: state._allProjects, allSections: state._allSections, allAreas: state._allAreas,
            });
            if (!container.ok || !taskEditValuesEqual(container.projectId, after.projectId)
                || !taskEditValuesEqual(container.sectionId, after.sectionId) || !taskEditValuesEqual(container.areaId, after.areaId)
                || (after.projectId && !state._allProjects.some((project) => project.id === after.projectId && isSelectableProjectForTaskAssignment(project)))) {
                result = { success: false, reason: 'invalid', error: 'Prepared task destination is no longer available' };
                return state;
            }
            const device = ensureDeviceId(state.settings);
            const updated = {
                ...applyPreparedTaskEditChanges({ before: current, changes }),
                rev: nextRevision(current.rev), revBy: device.deviceId, updatedAt: new Date().toISOString(),
            };
            const tasks = replaceEntityInArray(state._allTasks, current.id, updated);
            persist(set, debouncedSave, state, { tasks, ...(device.updated ? { settings: device.settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allTasks: tasks, ...(device.updated ? { settings: device.settings } : {}), lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedArchivedTaskRestore: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Archived Task restore conflicts with saved data' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const currentRows = durable.tasks.filter((row) => row.id === input.request.taskId);
            const current = currentRows.length === 1 ? currentRows[0] : null;
            if (!current || current.status !== 'archived' || current.deletedAt || current.purgedAt
                || (durable.settings.deviceId ?? null) !== input.deviceIdBefore) return memory;
            const scope = archiveRestoreScope(current, durable);
            const sameRows = <T extends { id: string }>(left: T[], right: T[], sameRow: (a: T, b: T) => boolean) => {
                if (left.length !== right.length || new Set(left.map((row) => row.id)).size !== left.length) return false;
                const byId = new Map(left.map((row) => [row.id, row]));
                return right.every((row) => {
                    const saved = byId.get(row.id);
                    return saved !== undefined && sameRow(saved, row);
                });
            };
            if (scope.fullParent !== input.scope.fullParent
                || !sameTaskSqliteRow(current, input.scope.task)
                || (scope.parentProject === null) !== (input.scope.parentProject === null)
                || scope.parentProject && input.scope.parentProject
                    && !sameProjectSqliteRow(scope.parentProject, input.scope.parentProject)
                || (scope.sourceArea === null) !== (input.scope.sourceArea === null)
                || scope.sourceArea && input.scope.sourceArea
                    && !taskEditValuesEqual(scope.sourceArea, input.scope.sourceArea)
                || !sameRows(scope.parentTasks, input.scope.parentTasks, sameTaskSqliteRow)
                || !sameRows(scope.parentSections, input.scope.parentSections, sameSectionSqliteRow)) return memory;
            const effect = archiveRestoreEffect(input.scope,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt,
                input.futureBoundary, new Map(input.dates.map((row) => [row.value, row])));
            if (!effect || !taskEditValuesEqual(effect, input.effect)) return memory;
            const taskAfter = new Map(effect.tasks.map((pair) => [pair.before.id, pair.after]));
            const sectionAfter = new Map(effect.sections.map((pair) => [pair.before.id, pair.after]));
            const tasks = durable.tasks.map((row) => taskAfter.get(row.id) ?? row);
            const projects = durable.projects.map((row) => row.id === effect.project?.before.id
                ? effect.project.after : row);
            const sections = durable.sections.map((row) => sectionAfter.get(row.id) ?? row);
            const settings = input.deviceIdToInitialize
                ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections,
                _allAreas: durable.areas, _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, tasks, projects, sections, settings });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects, _allSections: sections,
                _allAreas: durable.areas, _allPeople: durable.people ?? [], settings,
                lastDataChangeAt: getNextDataChangeAt(memory.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedArchivedTasksRestore: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: input.request.source === 'done' ? input.request.action === 'addTag' ? 'Done Add tag conflicts with saved data'
                : input.request.action === 'removeTag' ? 'Done Remove tag conflicts with saved data' : 'Done Move conflicts with saved data' : 'Archive Restore conflicts with saved data' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            if ((durable.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return memory;
            const bindRows = <T extends { id: string }>(rows: T[], pairs: { before: T; after: T }[],
                sameRow: (left: T, right: T) => boolean): Map<string, T> | null => {
                const current = new Map(rows.map((row) => [row.id, row]));
                const after = new Map<string, T>();
                for (const pair of pairs) {
                    const saved = current.get(pair.before.id);
                    if (!saved || pair.after.id !== pair.before.id || after.has(pair.before.id)
                        || !sameRow(saved, pair.before)) return null;
                    after.set(pair.before.id, pair.after);
                }
                return after;
            };
            const taskAfter = bindRows(durable.tasks, input.effect.tasks, (left, right) =>
                sameTaskSqliteRow(left, right) && sameSectionDeleteJson(left, right));
            const projectAfter = bindRows(durable.projects, input.effect.projects, (left, right) =>
                sameProjectSqliteRow(left, right) && sameSectionDeleteJson(left, right));
            const sectionAfter = bindRows(durable.sections, input.effect.sections, (left, right) =>
                sameSectionSqliteRow(left, right) && sameSectionDeleteJson(left, right));
            if (!taskAfter || !projectAfter || !sectionAfter) return memory;
            const addTag = input.request.source === 'done' && input.request.action === 'addTag' && input.request.tags === undefined
                && typeof input.request.tag === 'string' && input.request.tag.trim() && input.request.tag.length <= 2000;
            const removeTag = input.request.source === 'done' && input.request.action === 'removeTag' && input.request.tag === undefined
                && Array.isArray(input.request.tags) && input.request.tags.length > 0 && input.request.tags.length <= 10_000
                && input.request.tags.every((tag) => typeof tag === 'string' && tag.trim() && tag.length <= 2_000_000)
                && new Set(input.request.tags).size === input.request.tags.length;
            if ((addTag || removeTag) && input.request.status === undefined && Object.keys(input.request).length === 6) {
                const sources = new Map(durable.tasks.map((row) => [row.id, row]));
                if (!input.request.taskIds.every((id) => {
                    const row = sources.get(id);
                    return row?.status === 'done' && !row.deletedAt && !row.purgedAt && !isStatusListTaskReadOnly(row, durable.projects);
                })) return memory;
                const updates = buildBulkTaskTokenUpdates(input.request.taskIds, sources, 'tags',
                    addTag ? input.request.tag! : input.request.tags!, addTag ? 'add' : 'remove');
                const selected = new Set(input.request.taskIds);
                if (!updates.length || [...taskAfter.keys()].filter((id) => selected.has(id)).length !== updates.length
                    || updates.some(({ id, updates: patch }) => taskAfter.get(id)?.status !== 'done'
                        || !taskEditValuesEqual(taskAfter.get(id)?.tags, patch.tags))) return memory;
            } else {
                const target = input.request.source === undefined && input.request.status === undefined
                    && input.request.action === undefined && input.request.tag === undefined && input.request.tags === undefined ? 'inbox'
                    : input.request.source === 'done' && input.request.action === undefined && input.request.tag === undefined
                        && input.request.tags === undefined
                        && getBulkMoveStatusOptions('done').includes(input.request.status) ? input.request.status : null;
                if (!target || !input.request.taskIds.every((id) => taskAfter.get(id)?.status === target)) return memory;
            }
            // Only exact BEFORE can apply. Equal AFTER without this request's
            // durable receipt is never evidence that the batch already ran.
            const tasks = durable.tasks.map((row) => taskAfter.get(row.id) ?? row);
            const projects = durable.projects.map((row) => projectAfter.get(row.id) ?? row);
            const sections = durable.sections.map((row) => sectionAfter.get(row.id) ?? row);
            const settings = input.deviceIdToInitialize
                ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks, _allProjects: durable.projects,
                _allSections: durable.sections, _allAreas: durable.areas, _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, tasks, projects, sections, settings });
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, ids: [...input.request.taskIds], outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects, _allSections: sections,
                _allAreas: durable.areas, _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    commitPreparedReferenceTasksMove: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> =>
        commitPreparedRawReferenceBatch(input, authority, referenceBatchModules.move, 'Reference Move conflicts with saved data'),

    commitPreparedReferenceTasksAddTag: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> =>
        commitPreparedRawReferenceBatch(input, authority, referenceBatchModules.addTag, 'Reference Add tag conflicts with saved data'),

    commitPreparedReferenceTasksRemoveTag: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> =>
        commitPreparedRawReferenceBatch(input, authority, referenceBatchModules.removeTag, 'Reference Remove tag conflicts with saved data'),

    commitPreparedArchivedTasksMutation: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Archive Trash conflicts with saved data' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            if ((durable.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !input.before.length || input.before.length !== input.after.length) return memory;
            const current = new Map(durable.tasks.map((row) => [row.id, row]));
            const after = new Map<string, Task>();
            for (let index = 0; index < input.before.length; index += 1) {
                const old = input.before[index]; const next = input.after[index]; const saved = current.get(old.id);
                if (!saved || next.id !== old.id || after.has(old.id) || saved.purgedAt || next.purgedAt
                    || !sameTaskSqliteRow(saved, old) || !sameSectionDeleteJson(saved, old)
                    || (input.operation === 'delete' ? Boolean(old.deletedAt) || !next.deletedAt : !old.deletedAt || Boolean(next.deletedAt))) return memory;
                after.set(old.id, next);
            }
            // Exact BEFORE is required; equal AFTER alone never acknowledges a UUID.
            const tasks = durable.tasks.map((row) => after.get(row.id) ?? row);
            const settings = input.deviceIdToInitialize ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks, _allProjects: durable.projects,
                _allSections: durable.sections, _allAreas: durable.areas, _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, tasks, settings });
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt, generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, ids: input.before.map((row) => row.id), outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects, _allSections: durable.sections,
                _allAreas: durable.areas, _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    commitPreparedTaskDraftV2: async (input, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Task edit conflicts with saved data' };
        set((memory) => {
            const before = authority.state;
            if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
            const durable = authority.snapshot;
            const matches = durable.tasks.filter((row) => row.id === input.request.id);
            const current = matches.length === 1 ? matches[0] : null;
            if (!current) {
                result = { success: false, reason: 'missing', error: 'Task not found or duplicated' };
                return memory;
            }
            const sameRaw = (left: Task, right: Task) => sameTaskSqliteRow(left, right)
                && sameSectionDeleteJson(left, right);
            // Full result receipt wins before mutable parent/order eligibility.
            if (sameRaw(current, input.effect.task.after)
                && (input.deviceIdToInitialize === null
                    || (durable.settings.deviceId ?? null) === input.deviceIdToInitialize)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return memory;
            }
            if (!sameRaw(current, input.effect.task.before)
                || (durable.settings.deviceId ?? null) !== input.deviceIdBefore) return memory;
            const tasks = durable.tasks.map((row) => row.id === current.id ? input.effect.task.after : row);
            const settings = input.deviceIdToInitialize
                ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
            const freshProjects = durable.projects.map(normalizeProjectLifecycleFields);
            clearDerivedCache();
            persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                _allProjects: durable.projects, _allSections: durable.sections ?? [],
                _allAreas: durable.areas ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
            { ...durable, tasks, settings });
            const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
            authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                generation: getSaveGeneration(), failure: memory.persistenceFailure };
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allTasks: freshTasks, _allProjects: freshProjects,
                _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                _allPeople: durable.people ?? [], settings, lastDataChangeAt };
        });
        return result;
    },

    commitPreparedTaskFocus: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared task Focus conflicts with current data' };
        set((state) => {
            const current = state._allTasks.find((row) => row.id === input.request.taskId);
            // A full durable Task receipt wins before mutable eligibility, parent or clock checks.
            if (current && sameTaskSqliteRow(current, input.effect.task.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || !sameTaskSqliteRow(current, input.scope.task)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameSectionDeleteJson(taskFocusScope(state, current), input.scope)) return state;
            const planned = taskFocusEffect(input.scope, input.request.focused,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.preparedAt,
                input.futureBoundary, new Map(input.dates.map((row) => [row.value, row])));
            if (!planned || !sameTaskSqliteRow(planned.task.before, input.effect.task.before)
                || !sameTaskSqliteRow(planned.task.after, input.effect.task.after)) return state;
            const tasks = replaceEntityInArray(state._allTasks, current.id, planned.task.after);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allTasks: tasks, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedFocusOrder: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Focus order conflicts with current data' };
        set((state) => {
            const affected = input.effect.tasks;
            const currentById = new Map(state._allTasks.map((task) => [task.id, task]));
            if (affected.length === 0 || currentById.size !== state._allTasks.length
                || new Set(input.request.ids).size !== input.request.ids.length
                || new Set(affected.map(({ before }) => before.id)).size !== affected.length) return state;
            // A complete durable receipt wins before mutable membership, parent, or clock checks.
            if (affected.every(({ after }) => {
                const current = currentById.get(after.id);
                return current && sameTaskSqliteRow(current, after) && sameSectionDeleteJson(current, after);
            })) {
                result = { success: true, outcome: 'replayed' };
                return state;
            }
            const live = currentFocusOrder(state, input.request.controls);
            if (!live.canReorder || live.tasks.length > 100
                || focusOrderToken(live.tasks) !== input.request.expectedOrder
                || !sameSectionDeleteJson(live.tasks, input.scope.tasks)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || affected.some(({ before }) => {
                    const current = currentById.get(before.id);
                    return !current || !sameTaskSqliteRow(current, before) || !sameSectionDeleteJson(current, before);
                })) return state;
            const planned = focusOrderEffect(input.scope, input.request.ids,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.preparedAt);
            if (!sameSectionDeleteJson(planned, input.effect)) return state;
            const tasks = replaceEntitiesInArray(state._allTasks, affected.map(({ after }) => after));
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, outcome: 'applied' };
            return { _allTasks: tasks, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
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
        if (
            hasOwnField(updates, 'cancelledAt')
            && updates.cancelledAt != null
            && normalizeCancellationTimestamp(updates.cancelledAt) === undefined
        ) {
            const message = 'Cancellation timestamp must be an ISO datetime with timezone';
            set({ error: message });
            return actionFail(message);
        }
        const optimisticRetryProjectIds = collectOptimisticReactivationRetryProjectIds(
            [{ task: existingTask, updates }],
            currentState,
        );
        if (optimisticRetryProjectIds.length > 0) {
            try {
                await get().persistSnapshot();
                await flushPendingSave();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                const message = `Failed to save task and project reactivation: ${detail}`;
                set({ error: message });
                return actionFail(message);
            }
            return actionOk();
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
        const focusNow = new Date();
        const isFillingFocusSlot = !isTaskCountedAsFocused(existingTask, focusNow)
            && isTaskCountedAsFocused({ ...existingTask, ...preparedUpdates.updates }, focusNow);
        if (isFillingFocusSlot) {
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
        const incrementalPersistence: {
            task?: Task;
            hasRecurringFollowUp: boolean;
            mintedDeviceId: boolean;
            reactivatedProjectIds: string[];
        } = {
            hasRecurringFollowUp: false,
            mintedDeviceId: false,
            reactivatedProjectIds: [],
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
                const effects = planTaskUpdateEffects({
                    task: oldTask,
                    preparedUpdates: preparedUpdates.updates,
                    allTasks: state._allTasks,
                    allProjects: state._allProjects,
                    allSections: state._allSections,
                    now,
                    deviceId: deviceState.deviceId,
                });
                const { updatedTask, recurringFollowUpTask } = effects;
                incrementalPersistence.task = updatedTask;
                incrementalPersistence.hasRecurringFollowUp = recurringFollowUpTask !== null;
                incrementalPersistence.mintedDeviceId = deviceState.updated;
                incrementalPersistence.reactivatedProjectIds = effects.reactivatedProjectIds;
                snapshot = buildSaveSnapshot(state, {
                    tasks: effects.tasks,
                    projects: effects.projects,
                    sections: effects.sections,
                    ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                });
                setProducerMs = Date.now() - producerStartedAt;
                return {
                    _allTasks: effects.tasks,
                    _allProjects: effects.projects,
                    _allSections: effects.sections,
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
            && incrementalPersistence.reactivatedProjectIds.length === 0
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
        if (incrementalPersistence.reactivatedProjectIds.length > 0) {
            try {
                await flushPendingSave();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                const message = `Failed to save task and project reactivation: ${detail}`;
                set({ error: message });
                return actionFail(message);
            }
            logTaskProjectReactivationSaved(incrementalPersistence.reactivatedProjectIds.length);
        }
        if (isPromotingTaskFocus && incrementalPersistence.task?.isFocusedToday
            && isTaskFutureFocusCandidate(incrementalPersistence.task)) {
            logInfo('Scheduled Focus queued', {
                scope: 'store',
                category: 'storage',
                context: { releaseCheck: 'v1.3.3/scheduled-focus-queue', operation: 'update' },
            });
        }
        if (isFillingFocusSlot && isTaskFutureFocusCandidate(existingTask, focusNow)) {
            logInfo('Queued Focus activated', {
                scope: 'store', category: 'storage',
                context: { releaseCheck: 'v1.3.3/editor-focus-star' },
            });
        }
        return actionOk();
    },

    /** Archive one occurrence and durably create the next without a completion. */
    skipRecurringTaskOccurrence: async (id: string) => {
        const task = get()._tasksById.get(id);
        if (!task || !canSkipRecurringTaskOccurrence(task)) {
            const message = 'Only an active fixed-schedule recurring task can be skipped';
            set({ error: message });
            return actionFail(message);
        }
        const now = new Date().toISOString();
        const changeAt = Date.now();
        set((state) => {
            const currentTask = state._tasksById.get(id)!;
            const deviceState = ensureDeviceId(state.settings);
            const tasks = planSkippedRecurringOccurrence({ task: currentTask, allTasks: state._allTasks,
                now, deviceId: deviceState.deviceId,
                createId: uuidv4 }).tasks;
            persist(set, debouncedSave, state, {
                tasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allTasks: tasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        try {
            await flushPendingSave();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const message = `Failed to save skipped occurrence: ${detail}`;
            set({ error: message });
            return actionFail(message);
        }
        logInfo('Recurring occurrence skipped', {
            scope: 'store',
            category: 'storage',
            context: { releaseCheck: 'v1.3.3/skip-recurring-occurrence' },
        });
        return actionOk();
    },

    /** Archive a task as cancelled without completing or advancing recurrence. */
    cancelTask: async (id: string) => {
        const task = get()._tasksById.get(id);
        if (!task || task.deletedAt || task.purgedAt) {
            const message = 'Task not found';
            set({ error: message });
            return actionFail(message);
        }
        const alreadyCancelled = isTaskCancelled(task);
        const retryingFailedCancellation = alreadyCancelled && Boolean(get().persistenceFailure);
        if (!alreadyCancelled) {
            const result = await get().updateTask(id, {
                status: 'archived',
                cancelledAt: new Date().toISOString(),
            });
            if (!result.success) return result;
        } else if (retryingFailedCancellation) {
            // A terminal flush dequeues its exhausted snapshot. The in-memory
            // cancellation still needs a fresh durable retry on the next user
            // acknowledgement attempt, without changing its revision or time.
            await get().persistSnapshot();
        }
        try {
            await flushPendingSave();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const message = `Failed to save task cancellation: ${detail}`;
            set({ error: message });
            return actionFail(message);
        }
        if (!alreadyCancelled || retryingFailedCancellation) {
            logInfo('Commitment cancellation saved', {
                scope: 'store',
                category: 'storage',
                context: {
                    releaseCheck: 'v1.3.0/commitment-cancelled',
                    kind: 'task',
                    outcome: 'cancelled',
                    count: 1,
                },
            });
        }
        return actionOk({ id });
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
     * Restore a soft-deleted task. A purged task is the compacted tombstone of
     * a permanent delete, so it counts as missing: reviving it would resurrect
     * an emptied row and sync it back to every device.
     */
    restoreTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task && !task.purgedAt ? [task] : [];
            },
            buildUpdates: (task, { state }) => ({
                deletedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(task, state),
            }),
            missingMessage: 'Task not found',
        });
    },

    /**
     * Permanently delete a task (removes from storage).
     */
    purgeTask: async (id: string) => {
        // Only a task still in Trash may be deleted forever: sync can restore it between the
        // Trash confirmation and the tap, and then this must not purge a live task.
        const current = get()._tasksById.get(id);
        if (current && (!current.deletedAt || current.purgedAt)) {
            logWarn('Purge refused for a task not in Trash', {
                scope: 'store',
                category: 'storage',
                context: { releaseCheck: 'v1.3.3/purge-refused-outside-trash', purged: Boolean(current.purgedAt) },
            });
            return actionFail('Task is not in Trash');
        }
        // The mutation checks again on the state it writes, as purgeTasks does, so a
        // purge that waited behind a document restore never compacts a live task.
        const refusal = { purged: null as boolean | null };
        const result = await mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                if (task && (!task.deletedAt || task.purgedAt)) {
                    refusal.purged = Boolean(task.purgedAt);
                    return [];
                }
                return task ? [task] : [];
            },
            buildUpdates: (task, { now }) => ({
                deletedAt: task.deletedAt ?? now,
                purgedAt: now,
            }),
            buildSettings: (state, selectedTasks, { settings }) => {
                const selectedIds = new Set(selectedTasks.map((task) => task.id));
                const next = settingsWithPurgedParentAttachmentDeletes(settings,
                    state._allTasks, state._allProjects, selectedIds, new Set());
                return next === settings ? undefined : next;
            },
            missingMessage: 'Task not found',
        });
        if (refusal.purged === null) return result;
        logWarn('Purge refused for a task not in Trash', {
            scope: 'store',
            category: 'storage',
            context: { releaseCheck: 'v1.3.3/purge-refused-outside-trash', purged: refusal.purged },
        });
        return actionFail('Task is not in Trash');
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
                const next = settingsWithPurgedParentAttachmentDeletes(settings,
                    state._allTasks, state._allProjects, selectedIds, new Set());
                return next === settings ? undefined : next;
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
                const next = settingsWithPurgedParentAttachmentDeletes(settings,
                    state._allTasks, state._allProjects, selectedIds, new Set());
                return next === settings ? undefined : next;
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
    duplicateTask: async (id: string, asNextAction?: boolean, copyId?: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingTask = false;
        let refusedCopyId = false;
        let duplicatedTaskId: string | undefined;
        set((state) => {
            const sourceTask = state._tasksById.get(id);
            if (!sourceTask || sourceTask.deletedAt) {
                missingTask = true;
                return state;
            }
            const existing = copyId ? state._tasksById.get(copyId) : undefined;
            if (existing) {
                if (!matchesDuplicateSource(sourceTask, existing, asNextAction)) {
                    refusedCopyId = true;
                } else {
                    duplicatedTaskId = copyId;
                }
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

            const newTask = buildDuplicateTask({
                sourceTask, asNextAction, copyId, now, deviceId: deviceState.deviceId,
                projectOrder: sourceTask.projectId ? createProjectOrderReserver(state._allTasks)(sourceTask.projectId) : undefined,
                boardOrder: boardOrderForDuplicate(sourceTask.boardOrder,
                    state._allTasks.filter((task) => task.status === sourceTask.status && !task.deletedAt)),
            });
            duplicatedTaskId = newTask.id;
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
        return missingTask ? actionFail('Task not found') : refusedCopyId ? actionFail('Duplicate id does not match source') : actionOk({ id: duplicatedTaskId });
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
                    isFocusedToday: false,
                    suppressMindwtrReminders: false,
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
        if (!convertedSectionId) return actionFail('Task not found');
        return actionOk({ id: convertedSectionId });
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

            const deviceState = ensureDeviceId(state.settings);
            const plan = planTaskPromotion({ sourceTask, title: options?.title, color: options?.color,
                areaId: options?.areaId, allTasks: state._allTasks, allProjects: state._allProjects,
                allSections: state._allSections, allAreas: state._allAreas,
                settings: state.settings, deviceId: deviceState.deviceId, now });
            if (!plan.ok) {
                errorMessage = plan.error;
                return { error: errorMessage };
            }
            promotedProjectId = plan.targetProject.id;
            reusedExistingProject = !plan.createdProject;
            const nextAllProjects = plan.createdProject ? [...state._allProjects, plan.createdProject] : state._allProjects;
            const nextAllTasks = replaceEntityInArray(state._allTasks, id, plan.taskAfter);
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

    /** Atomic saved-task move and optional project creation for the native journal. */
    commitPreparedTaskPromotion: async (input: PreparedTaskPromotion & { request: { requestId: string;
        taskId: string; taskRevision: string; title: string }; result: { id: string; reused: boolean } }) => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared task promotion conflicts with current data' };
        set((state) => {
            const receipt = inspectPreparedAffectedRows(state, input);
            if (receipt === 'after') {
                result = { success: true, id: input.result.id, reused: input.result.reused, outcome: 'replayed' };
                return state;
            }
            if (receipt !== 'before') return state;
            const source = state._tasksById.get(input.sourceBefore.id);
            if (!source || !samePreparedTask(source, input.sourceBefore)
                || source.deletedAt || source.purgedAt
                || isStatusListTaskReadOnly(source, state._allProjects)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return state;
            const sourceProject = source.projectId ? state._projectsById.get(source.projectId) : undefined;
            if (input.sourceProject
                ? !sourceProject || sourceProject.areaId !== input.sourceProject.areaId
                : Boolean(sourceProject)) return state;
            if (input.selectedArea) {
                const current = state._areasById.get(input.selectedArea.id);
                if (!current || !taskEditValuesEqual(current, input.selectedArea) || current.deletedAt) return state;
            } else {
                // A missing/deleted inherited Area is a decision too. If it
                // becomes live before the write, the shared planner would now
                // assign the project to it instead of creating an unassigned one.
                const inheritedAreaId = input.sourceBefore.areaId ?? input.sourceProject?.areaId;
                const current = inheritedAreaId ? state._areasById.get(inheritedAreaId) : undefined;
                if (current && !current.deletedAt) return state;
            }
            const destination = input.selectedProject;
            const expectedMatch = findSelectableProjectByTitleAndArea(state._allProjects,
                input.request.title, input.selectedArea?.id);
            if (destination) {
                const current = state._projectsById.get(destination.id);
                if (!current || !samePreparedProject(current, destination)
                    || !isSelectableProjectForTaskAssignment(current) || expectedMatch?.id !== destination.id) return state;
            } else if (expectedMatch) return state;
            if (input.projectOrderMax !== null
                && projectAreaOrderMax(state._allProjects, input.selectedArea?.id ?? null) !== input.projectOrderMax) return state;
            if (input.taskOrderMax !== null
                && ((getNextProjectOrder(input.result.id, state._allTasks) ?? 0) - 1) !== input.taskOrderMax) return state;
            if (input.projects.length && (state.settings.gtd?.defaultProjectFlowMode ?? null) !== input.defaultProjectFlowMode) return state;
            const { tasks, projects } = applyPreparedAffectedRows(state, input);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks, projects,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: input.result.id, reused: input.result.reused, outcome: 'applied' };
            return { _allTasks: tasks, _allProjects: projects, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
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
            buildUpdates: buildResetTaskChecklistUpdates,
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
        const prepared = prepareTaskBatchUpdatesForStore({ updatesList, state: get() });
        if (!prepared.ok) {
            set({ error: prepared.error });
            return actionFail(prepared.error);
        }
        if (prepared.optimisticRetryProjectIds.length > 0) {
            try {
                await get().persistSnapshot();
                await flushPendingSave();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                const message = `Failed to save tasks and project reactivation: ${detail}`;
                set({ error: message });
                return actionFail(message);
            }
            return actionOk();
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let reactivatedProjectCount = 0;

        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const projectReactivation = planTaskBatchUpdateEffects({
                preparedUpdatesById: prepared.preparedUpdatesById,
                allTasks: state._allTasks,
                allProjects: state._allProjects,
                allSections: state._allSections,
                now,
                deviceId: deviceState.deviceId,
            });
            reactivatedProjectCount = projectReactivation.reactivatedProjectIds.length;

            persist(set, debouncedSave, state, {
                tasks: projectReactivation.tasks,
                projects: projectReactivation.projects,
                sections: projectReactivation.sections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });

            return {
                _allTasks: projectReactivation.tasks,
                _allProjects: projectReactivation.projects,
                _allSections: projectReactivation.sections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (reactivatedProjectCount > 0) {
            try {
                await flushPendingSave();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                const message = `Failed to save tasks and project reactivation: ${detail}`;
                set({ error: message });
                return actionFail(message);
            }
            logTaskProjectReactivationSaved(reactivatedProjectCount);
        }
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
        const targetOrderById = focusOrderTargets(orderedIds);
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => {
                if (task.deletedAt) return false;
                return changedFocusOrder(task, targetOrderById) !== undefined;
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
            sections: state.sections,
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
};
