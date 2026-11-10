import { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes } from './schedule-utils';
import { normalizeTaskReminderPolicy, shouldSendTaskReminders } from './task-reminder-policy';
import type { ProjectTaskSummary } from './project-row-meta';
import { buildNextRecurringTask, canonicalRecurringFollowUp, createNextRecurringTask, normalizeRecurrenceForLoad, type RecurrenceProjection } from './recurrence';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import {
    createTaskTokenUsageAccumulator,
    getTaskTokenUsageTimestamp,
    getUsedTaskTokensFromUsage,
} from './task-token-usage';
import { resolveRelativeStartUpdates } from './task-relative-start';
import { compareTasksByProjectOrder, getTaskSequencing, isTaskFocusedNow, isTaskFutureFocusCandidate, isTaskFutureFocusCandidateBeforeBoundary, isTaskFutureStart, isTaskFutureStartBeforeBoundary, rescheduleTask, shouldAutoArchiveCompletedTask, baseTextCollator } from './task-utils';
import {
    isTaskActionable,
    isTaskFinished,
    normalizeCancellationTimestamp,
    normalizeTaskLifecycleFields,
} from './task-status';
import {
    isProjectCancelled,
    normalizeProjectLifecycleFields,
    normalizeProjectUpdate,
} from './project-status';
import { safeParseDate } from './date';
import { filterNotDeleted } from './sync-helpers';
import { nextRevision, normalizeRevision } from './sync-revision';
import type { AiSettings, AppData, Area, Attachment, Person, Project, Section, Task, TaskStatus } from './types';
import { generateUUID as uuidv4 } from './uuid';
import type { DerivedState, SaveBaseState, TaskStore } from './store-types';
import { retainRawReadSettingsSnapshot } from './sqlite-raw-snapshot';
import { mapPass, runToEnd, type CooperativePass } from './cooperative';

const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);

export { MAX_SYNC_REVISION, normalizeRevision, nextRevision } from './sync-revision';

type EntityWithId = { id: string };
type EntityWithRevision = EntityWithId & {
    updatedAt?: string;
    rev?: number;
    revBy?: string;
    deletedAt?: string;
    purgedAt?: string;
};

export const getNextDataChangeAt = (previous: number, now = Date.now()): number => (
    Math.max(now, previous + 1)
);

export const ensureDeviceId = (settings: AppData['settings']): { settings: AppData['settings']; deviceId: string; updated: boolean } => {
    if (settings.deviceId) {
        return { settings, deviceId: settings.deviceId, updated: false };
    }
    const deviceId = uuidv4();
    return { settings: { ...settings, deviceId }, deviceId, updated: true };
};

export const ensureAnalyticsProfileId = (settings: AppData['settings']): { settings: AppData['settings']; updated: boolean } => {
    if (typeof settings.analyticsProfileId === 'string' && settings.analyticsProfileId.trim()) {
        return { settings, updated: false };
    }
    return { settings: { ...settings, analyticsProfileId: uuidv4() }, updated: true };
};


export const matchesDuplicateSource = (source: Task, copy: Task, asNextAction = false): boolean => {
    if (source.id === copy.id || source.deletedAt || copy.deletedAt || copy.purgedAt
        || copy.rev !== 1 || copy.createdAt !== copy.updatedAt
        || copy.status !== (asNextAction ? 'next' : isTaskFinished(source) ? 'inbox' : source.status)
        || copy.completedAt !== undefined || copy.cancelledAt !== undefined || copy.isFocusedToday !== false
        || copy.focusOrder !== undefined || copy.statusBeforeProjectArchive !== undefined
        || copy.completedAtBeforeProjectArchive !== undefined || copy.isFocusedTodayBeforeProjectArchive !== undefined
        || copy.projectArchivedAt !== undefined) return false;
    const ignored = new Set(['id', 'status', 'recurrence', 'checklist', 'attachments', 'completedAt', 'cancelledAt',
        'isFocusedToday', 'focusOrder', 'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive',
        'isFocusedTodayBeforeProjectArchive', 'projectArchivedAt', 'deletedAt', 'purgedAt',
        'createdAt', 'updatedAt', 'rev', 'revBy', 'order', 'orderNum', 'boardOrder']);
    for (const key of new Set([...Object.keys(source), ...Object.keys(copy)])) {
        if (!ignored.has(key) && JSON.stringify(source[key as keyof Task]) !== JSON.stringify(copy[key as keyof Task])) return false;
    }
    const recurrence = typeof source.recurrence === 'object' && source.recurrence
        ? normalizeRecurrenceForLoad({ ...source.recurrence, seriesId: copy.id }) : source.recurrence;
    if (JSON.stringify(recurrence) !== JSON.stringify(copy.recurrence)) return false;
    const checklist = (source.checklist ?? []).map((item) => ({ ...item, id: '' }));
    if (JSON.stringify(checklist) !== JSON.stringify((copy.checklist ?? []).map((item) => ({ ...item, id: '' })))) return false;
    const links = (source.attachments ?? []).filter((item) => item.kind !== 'file').map((item) => ({
        ...item, id: '', createdAt: copy.createdAt, updatedAt: copy.createdAt,
        deletedAt: undefined, cloudKey: undefined, fileHash: undefined, localStatus: undefined,
    }));
    return JSON.stringify(links) === JSON.stringify((copy.attachments ?? []).map((item) => ({ ...item, id: '' })));
};

export const getReferenceTaskFieldClears = (dueReminderLeadMinutes?: number, startReminderLeadMinutes?: number): Partial<Task> => ({
    status: 'reference',
    startTime: undefined,
    dueDate: undefined,
    relativeStartOffset: undefined,
    reviewAt: undefined,
    recurrence: undefined,
    priority: undefined,
    timeEstimate: undefined,
    suppressMindwtrReminders: undefined,
    repeatReminderMinutes: undefined,
    dueReminderLeadMinutes: dueReminderLeadMinutes === undefined ? undefined : 0,
    startReminderLeadMinutes: startReminderLeadMinutes === undefined ? undefined : 0,
    showFutureRecurrence: undefined,
    isFocusedToday: false,
    focusOrder: undefined,
    boardOrder: undefined,
    pushCount: 0,
});

export type TaskCompletionSource = 'saved' | 'currentDraft';

export const buildTaskCompletionSource = (task: Task, updates: Partial<Task>, source: TaskCompletionSource): Task => {
    if (source === 'currentDraft') {
        return { ...task, ...resolveRelativeStartUpdates(task, updates), status: task.status };
    }
    const saved = { ...task, ...(hasOwnField(updates, 'checklist') ? { checklist: updates.checklist } : {}) };
    if (saved.recurrence && updates.recurrence && typeof updates.recurrence === 'object') {
        saved.recurrence = {
            ...(typeof saved.recurrence === 'string' ? { rule: saved.recurrence } : saved.recurrence),
            preserveChecklistOnRepeat: updates.recurrence.preserveChecklistOnRepeat,
        };
    }
    return saved;
};

export function applyTaskUpdates(
    oldTask: Task,
    updates: Partial<Task>,
    now: string,
    createId?: () => string,
    recurrenceProjection?: RecurrenceProjection | null,
    completionSource: TaskCompletionSource = 'saved',
): { updatedTask: Task; nextRecurringTask: Task | null } {

    let normalizedUpdates = { ...updates };
    delete normalizedUpdates.archivedAt;
    if (Object.prototype.hasOwnProperty.call(updates, 'textDirection') && updates.textDirection === undefined) {
        delete normalizedUpdates.textDirection;
    }
    const updatesToApply = normalizedUpdates;
    const incomingStatus = updates.status ?? oldTask.status;
    const statusChanged = incomingStatus !== oldTask.status;

    let finalUpdates: Partial<Task> = updatesToApply;
    let nextRecurringTask: Task | null = null;


    const explicitCompletedAt = typeof updates.completedAt === 'string' && safeParseDate(updates.completedAt)
        ? updates.completedAt
        : undefined;
    const explicitCancelledAt = normalizeCancellationTimestamp(updates.cancelledAt);


    const clearsFocusOrder = oldTask.focusOrder !== undefined && !hasOwnField(updates, 'focusOrder')
        ? { focusOrder: undefined }
        : {};

    if (statusChanged && incomingStatus === 'done') {
        const isReturningFromArchive = oldTask.status === 'archived';
        const completedAt = explicitCompletedAt ?? (isReturningFromArchive ? (oldTask.completedAt || now) : now);
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt,
            cancelledAt: undefined,
            isFocusedToday: false,
            ...clearsFocusOrder,
        };


        const recurrenceSource = buildTaskCompletionSource(oldTask, updatesToApply, completionSource);
        nextRecurringTask = isReturningFromArchive
            ? null
            : recurrenceProjection === undefined
                ? createNextRecurringTask(recurrenceSource, completedAt, oldTask.status, createId ? { createId } : undefined)
                : buildNextRecurringTask(recurrenceSource, completedAt, oldTask.status, recurrenceProjection, createId);
    } else if (statusChanged && incomingStatus === 'archived') {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            archivedAt: now,
            completedAt: explicitCancelledAt
                ? undefined
                : explicitCompletedAt ?? (oldTask.completedAt || now),
            cancelledAt: explicitCancelledAt,
            isFocusedToday: false,
            ...clearsFocusOrder,
        };
    } else if (statusChanged && isTaskFinished(oldTask.status) && !isTaskFinished(incomingStatus)) {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: undefined,
            cancelledAt: undefined,
        };
    }

    if (statusChanged && oldTask.status === 'archived' && incomingStatus !== 'archived') {
        finalUpdates = { ...finalUpdates, archivedAt: undefined };
    }

    if (incomingStatus !== 'reference') {
        finalUpdates = resolveRelativeStartUpdates(oldTask, finalUpdates);
    }

    if (Object.prototype.hasOwnProperty.call(finalUpdates, 'dueDate') && incomingStatus !== 'reference') {
        const rescheduled = rescheduleTask(oldTask, finalUpdates.dueDate);
        finalUpdates = {
            ...finalUpdates,
            dueDate: rescheduled.dueDate,
            pushCount: hasOwnField(finalUpdates, 'pushCount')
                ? finalUpdates.pushCount
                : rescheduled.pushCount,
        };
    }


    if (incomingStatus === 'reference') {
        finalUpdates = {
            ...finalUpdates,
            ...getReferenceTaskFieldClears(finalUpdates.dueReminderLeadMinutes ?? oldTask.dueReminderLeadMinutes,
                finalUpdates.startReminderLeadMinutes ?? oldTask.startReminderLeadMinutes),
            ...(statusChanged ? { dueReminderLeadMinutes: 0, startReminderLeadMinutes: 0 } : {}),
        };
    }

    if (hasOwnField(finalUpdates, 'suppressMindwtrReminders') && finalUpdates.suppressMindwtrReminders === undefined) {
        finalUpdates = { ...finalUpdates, suppressMindwtrReminders: false };
    }

    return {
        updatedTask: normalizeTaskLifecycleFields({ ...oldTask, ...finalUpdates, updatedAt: now }),
        nextRecurringTask,
    };
}

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


export const findExistingRecurringFollowUp = (
    tasks: readonly Task[],
    candidate: Task | null,
    excludeId?: string,
): Task | null => {
    if (!candidate) return null;
    return tasks.find((task) => task.id !== excludeId && isExistingRecurringFollowUp(task, candidate)) ?? null;
};


export const stampNewRecurringFollowUp = (
    task: Task | null,
    deviceId: string,
    sourceOrder: number | undefined,
    reserveProjectOrder: ProjectOrderReserver,
): Task | null => {
    if (!task) return null;
    const order = sourceOrder ?? reserveProjectOrder(task.projectId);
    return {
        ...canonicalRecurringFollowUp(task),
        rev: nextRevision(undefined),
        revBy: deviceId,
        ...(order !== undefined ? { order, orderNum: order } : {}),
    };
};


export const normalizeTaskUpdate = (
    task: Task,
    updates: Partial<Task>,


    context?: { settings?: AppData['settings']; nowMs?: number; futureBoundary?: string;
        futureDates?: import('./task-utils').FocusDateLookup },
): Partial<Task> => {
    let adjustedUpdates = updates;
    if (hasOwnField(updates, 'dueReminderLeadMinutes')) {
        adjustedUpdates = { ...adjustedUpdates, dueReminderLeadMinutes: updates.dueReminderLeadMinutes === undefined
            && task.dueReminderLeadMinutes === undefined ? undefined
            : updates.dueReminderLeadMinutes == null ? 0 : normalizeDueReminderLeadMinutes(updates.dueReminderLeadMinutes) };
    }
    if (hasOwnField(updates, 'startReminderLeadMinutes')) {
        adjustedUpdates = { ...adjustedUpdates, startReminderLeadMinutes: updates.startReminderLeadMinutes === undefined
            && task.startReminderLeadMinutes === undefined ? undefined
            : updates.startReminderLeadMinutes == null ? 0 : normalizeStartReminderLeadMinutes(updates.startReminderLeadMinutes) };
    }
    if (hasOwnField(updates, 'reminderPolicy')) {
        const policy = normalizeTaskReminderPolicy(updates.reminderPolicy);
        if (policy) {
            adjustedUpdates = { ...adjustedUpdates, reminderPolicy: policy,
                suppressMindwtrReminders: !shouldSendTaskReminders({ reminderPolicy: policy }, context?.settings) };
        } else {
            adjustedUpdates = { ...adjustedUpdates };
            delete adjustedUpdates.reminderPolicy;
        }
    } else if (hasOwnField(updates, 'suppressMindwtrReminders')) {

        adjustedUpdates = { ...adjustedUpdates,
            reminderPolicy: updates.suppressMindwtrReminders === true ? 'skip' : 'send' };
    }

    if (hasOwnField(updates, 'cancelledAt')) {
        const cancelledAt = normalizeCancellationTimestamp(updates.cancelledAt);
        adjustedUpdates = {
            ...adjustedUpdates,
            cancelledAt,
            ...(cancelledAt && !hasOwnField(updates, 'status') ? { status: 'archived' as const } : {}),
        };
    }
    const resolvedLifecycleStatus = hasOwnField(adjustedUpdates, 'status')
        ? adjustedUpdates.status
        : task.status;
    if (resolvedLifecycleStatus !== 'archived') {
        adjustedUpdates = {
            ...adjustedUpdates,
            cancelledAt: undefined,
        };
    }
    if (hasOwnField(updates, 'recurrence')) {
        const recurrence = normalizeRecurrenceForLoad(updates.recurrence);
        const existingRecurrence = normalizeRecurrenceForLoad(task.recurrence);
        const existingSeriesId = existingRecurrence?.seriesId ?? task.id;
        const seriesId = recurrence?.seriesId ?? existingSeriesId;
        const completedOccurrences = recurrence?.completedOccurrences
            ?? (recurrence?.count && seriesId === existingSeriesId
                ? existingRecurrence?.completedOccurrences
                : undefined);
        adjustedUpdates = {
            ...adjustedUpdates,


            recurrence: recurrence
                ? normalizeRecurrenceForLoad({
                    ...recurrence,
                    seriesId,
                    ...(completedOccurrences !== undefined ? { completedOccurrences } : {}),
                })
                : undefined,
        };
    }
    const hasOrder = hasOwnField(updates, 'order');
    const hasOrderNum = hasOwnField(updates, 'orderNum');
    if (hasOrder || hasOrderNum) {
        const normalizedOrder = getTaskOrder(updates);
        adjustedUpdates = {
            ...adjustedUpdates,
            order: normalizedOrder,
            orderNum: normalizedOrder,
        };
    }
    const editsSchedule = hasOwnField(updates, 'startTime')
        || hasOwnField(updates, 'dueDate')
        || hasOwnField(updates, 'reviewAt')
        || hasOwnField(updates, 'recurrence');


    const startPromotingInbox = hasOwnField(updates, 'startTime')
        && !hasOwnField(updates, 'status')
        && updates.startTime != null
        && updates.startTime !== ''
        && updates.startTime !== task.startTime
        && task.status === 'inbox';
    const starTurningOn = adjustedUpdates.isFocusedToday === true && task.isFocusedToday !== true;
    const statusBecomingInbox = hasOwnField(updates, 'status') && updates.status === 'inbox' && task.status !== 'inbox';
    if (statusBecomingInbox && !starTurningOn) {
        if ((hasOwnField(adjustedUpdates, 'isFocusedToday') ? adjustedUpdates.isFocusedToday : task.isFocusedToday) === true) {
            adjustedUpdates = {
                ...adjustedUpdates,
                isFocusedToday: false,
            };
        }
    } else if (
        (starTurningOn && (hasOwnField(updates, 'status') ? updates.status : task.status) === 'inbox')
        || startPromotingInbox
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            status: 'next',
        };
    }


    const scheduledTask = { ...task, ...adjustedUpdates };
    const futureStart = (candidate: Task) => context?.futureBoundary
        ? isTaskFutureStartBeforeBoundary(candidate, context.futureBoundary, context.futureDates) : isTaskFutureStart(candidate);
    const futureFocusCandidate = (candidate: Task) => context?.futureBoundary
        ? isTaskFutureFocusCandidateBeforeBoundary(candidate, context.futureBoundary, context.futureDates) : isTaskFutureFocusCandidate(candidate);
    if ((editsSchedule || hasOwnField(updates, 'status'))
        && futureStart(scheduledTask)
        && !futureFocusCandidate(scheduledTask)) {
        adjustedUpdates = { ...adjustedUpdates, isFocusedToday: false };
    }
    if (
        hasOwnField(adjustedUpdates, 'status')
        && adjustedUpdates.status !== task.status
        && !hasOwnField(updates, 'boardOrder')
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            boardOrder: undefined,
        };
    }


    const resolvedIsFocusedToday = hasOwnField(adjustedUpdates, 'isFocusedToday')
        ? adjustedUpdates.isFocusedToday
        : task.isFocusedToday;
    if (
        ((task.isFocusedToday === true && resolvedIsFocusedToday !== true)
        || (resolvedIsFocusedToday === true && futureFocusCandidate({ ...task, ...adjustedUpdates })))
        && !hasOwnField(updates, 'focusOrder')
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            focusOrder: undefined,
        };
    }


    const archiveEditNowMs = context?.nowMs ?? Date.now();
    if (
        context?.settings
        && hasOwnField(updates, 'completedAt')
        && (!hasOwnField(updates, 'status') || updates.status === task.status)
        && task.status === 'done'
        && shouldAutoArchiveCompletedTask(


            { ...task, ...adjustedUpdates, updatedAt: new Date(archiveEditNowMs).toISOString() },
            context.settings,
            archiveEditNowMs,
        )
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            status: 'archived',
            isFocusedToday: false,
        };
    }
    const resolvedFinalStatus = hasOwnField(adjustedUpdates, 'status')
        ? adjustedUpdates.status
        : task.status;
    if (isTaskFinished(resolvedFinalStatus)) {
        adjustedUpdates = {
            ...adjustedUpdates,
            isFocusedToday: false,
            ...(!hasOwnField(updates, 'focusOrder') ? { focusOrder: undefined } : {}),
        };
    }


    if (task.projectArchivedAt) {
        adjustedUpdates = {
            ...adjustedUpdates,
            statusBeforeProjectArchive: undefined,
            completedAtBeforeProjectArchive: undefined,
            isFocusedTodayBeforeProjectArchive: undefined,
            projectArchivedAt: undefined,
        };
    }
    return adjustedUpdates;
};


export const resolveCaptureStatusForStart = (
    initialProps: Partial<Task>,
    resolvedStatus: TaskStatus,
): TaskStatus => {
    const startPromotesToNext = !hasOwnField(initialProps, 'status')
        && resolvedStatus === 'inbox'
        && initialProps.startTime != null
        && initialProps.startTime !== '';
    return startPromotesToNext ? 'next' : resolvedStatus;
};

export type TaskVisibilityOptions = {
    includeArchived?: boolean;
    includeDeleted?: boolean;
};

export const isTaskVisible = (task?: Task | null, options?: TaskVisibilityOptions): boolean => {
    if (!task) return false;
    const includeArchived = options?.includeArchived === true;
    const includeDeleted = options?.includeDeleted === true;
    if (!includeDeleted && task.deletedAt) return false;
    if (!includeArchived && task.status === 'archived') return false;
    return true;
};

export const toVisibleTask = (task: Task): Task => {
    const attachments = task.attachments;
    if (!attachments || attachments.length === 0) return task;
    const visibleAttachments = filterNotDeleted(attachments);
    return visibleAttachments.length === attachments.length
        ? task
        : { ...task, attachments: visibleAttachments };
};

export const selectVisibleTasks = (tasks: Task[]): Task[] =>
    tasks.filter((task) => isTaskVisible(task)).map(toVisibleTask);

export const selectVisibleProjects = (projects: Project[]): Project[] =>
    filterNotDeleted(projects);

export const selectVisibleSections = (sections: Section[]): Section[] =>
    filterNotDeleted(sections);

export const selectVisibleAreas = (areas: Area[]): Area[] =>
    filterNotDeleted(areas);

export const selectVisiblePeople = (people: Person[]): Person[] =>
    filterNotDeleted(people).sort((a, b) => baseTextCollator.compare(a.name, b.name));

export const completeTaskForProjectArchive = (task: Task, archivedAt: string, deviceId?: string): Task => ({
    ...task,
    status: 'done',
    completedAt: archivedAt,
    archivedAt,
    cancelledAt: undefined,
    isFocusedToday: false,
    focusOrder: undefined,
    statusBeforeProjectArchive: task.status,
    completedAtBeforeProjectArchive: task.completedAt,
    isFocusedTodayBeforeProjectArchive: task.isFocusedToday,
    projectArchivedAt: archivedAt,
    updatedAt: archivedAt,
    rev: nextRevision(task.rev),
    revBy: deviceId,
});


export const cancelTaskForProjectArchive = (
    task: Task,
    cancelledAt: string,
    deviceId?: string,
    operationAt: string = cancelledAt,
): Task => ({
    ...task,
    status: 'archived',
    archivedAt: operationAt,
    completedAt: undefined,
    cancelledAt,
    isFocusedToday: false,
    focusOrder: undefined,
    statusBeforeProjectArchive: task.status,
    completedAtBeforeProjectArchive: task.completedAt,
    isFocusedTodayBeforeProjectArchive: task.isFocusedToday,
    projectArchivedAt: operationAt,
    updatedAt: operationAt,
    rev: nextRevision(task.rev),
    revBy: deviceId,
});

export const restoreTaskFromProjectArchive = (task: Task, restoredAt: string, deviceId?: string): Task => {
    const previousStatus = task.statusBeforeProjectArchive;
    const archivedAt = task.projectArchivedAt;
    const wasCompletedByProject = task.status === 'done'
        && task.cancelledAt === undefined
        && task.completedAt === archivedAt;
    const wasCancelledByProject = task.status === 'archived'
        && normalizeCancellationTimestamp(task.cancelledAt) !== undefined
        && task.completedAt === undefined;
    const shouldRestore =
        !task.deletedAt &&
        Boolean(previousStatus) &&
        !isTaskFinished(previousStatus) &&
        Boolean(archivedAt) &&
        task.updatedAt === archivedAt &&
        (wasCompletedByProject || wasCancelledByProject);

    if (!shouldRestore) {
        return task;
    }

    return {
        ...task,
        status: previousStatus!,
        archivedAt: undefined,
        completedAt: task.completedAtBeforeProjectArchive ?? undefined,
        cancelledAt: undefined,
        isFocusedToday: task.isFocusedTodayBeforeProjectArchive ?? false,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: restoredAt,
        rev: nextRevision(task.rev),
        revBy: deviceId,
    };
};

const hasTaskProjectArchiveMetadata = (task: Task): boolean => (
    task.projectArchivedAt !== undefined
    || task.statusBeforeProjectArchive !== undefined
    || task.completedAtBeforeProjectArchive !== undefined
    || task.isFocusedTodayBeforeProjectArchive !== undefined
);

export const findTaskProjectReactivationTarget = (
    task: Task,
    updates: Partial<Task>,
    projects: readonly Project[],
): Project | undefined => {
    if (!hasOwnField(updates, 'status')) return undefined;
    const requestedStatus = updates.status;
    if (!requestedStatus || !isTaskActionable(requestedStatus)) return undefined;

    const finalDeletedAt = hasOwnField(updates, 'deletedAt') ? updates.deletedAt : task.deletedAt;
    const finalPurgedAt = hasOwnField(updates, 'purgedAt') ? updates.purgedAt : task.purgedAt;
    if (finalDeletedAt || finalPurgedAt) return undefined;

    const finalProjectId = hasOwnField(updates, 'projectId')
        ? (typeof updates.projectId === 'string' && updates.projectId.trim()
            ? updates.projectId.trim()
            : undefined)
        : task.projectId;
    if (!finalProjectId) return undefined;

    return projects.find((project) => (
        project.id === finalProjectId
        && project.status === 'archived'
        && !project.deletedAt
        && !project.purgedAt
    ));
};

const retireTaskProjectArchiveMetadata = (
    task: Task,
    retiredAt: string,
    deviceId?: string,
): Task => {
    if (!hasTaskProjectArchiveMetadata(task)) return task;
    return {
        ...task,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: retiredAt,
        rev: nextRevision(task.rev),
        revBy: deviceId,
    };
};

export const clearDeletedTaskProjectArchiveMetadata = (task: Task): Task => {
    if (!task.deletedAt || !hasTaskProjectArchiveMetadata(task)) return task;
    return {
        ...task,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
    };
};

export const archiveSectionForProjectArchive = (section: Section, archivedAt: string, deviceId?: string): Section => ({
    ...section,
    deletedAt: archivedAt,
    deletedAtBeforeProjectArchive: section.deletedAt,
    projectArchivedAt: archivedAt,
    updatedAt: archivedAt,
    rev: nextRevision(section.rev),
    revBy: deviceId,
});


export const isTaskSectionProjectArchiveReference = (
    task: Task,
    section: Section | undefined,
    project: Project | undefined,
): boolean => {
    if (!section || !project || project.deletedAt || project.purgedAt || project.status !== 'archived') return false;
    const sectionArchivedAt = section.projectArchivedAt;
    if (!sectionArchivedAt || section.deletedAt !== sectionArchivedAt) return false;
    if (task.projectId !== project.id || section.projectId !== project.id) return false;
    return isTaskFinished(task) || task.status === 'reference';
};

export const isRestorableProjectArchiveSection = (section: Section): boolean => {
    const archivedAt = section.projectArchivedAt;
    return (
        Boolean(archivedAt) &&
        section.updatedAt === archivedAt &&
        section.deletedAt === archivedAt &&


        section.deletedAtBeforeProjectArchive == null
    );
};

export const restoreSectionFromProjectArchive = (section: Section, restoredAt: string, deviceId?: string): Section => {
    const shouldRestore = isRestorableProjectArchiveSection(section);

    if (!shouldRestore) {
        return section;
    }

    return {
        ...section,
        deletedAt: undefined,
        deletedAtBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: restoredAt,
        rev: nextRevision(section.rev),
        revBy: deviceId,
    };
};

export const applyTaskProjectReactivationTransition = (
    requests: readonly { task: Task; updates: Partial<Task> }[],
    tasks: Task[],
    projects: Project[],
    sections: Section[],
    now: string,
    deviceId?: string,
): { tasks: Task[]; projects: Project[]; sections: Section[]; reactivatedProjectIds: string[] } => {
    const targetByProjectId = new Map<string, Project>();
    const reopenedTaskIds = new Set<string>();
    for (const request of requests) {
        const target = findTaskProjectReactivationTarget(request.task, request.updates, projects);
        if (!target) continue;
        targetByProjectId.set(target.id, target);
        reopenedTaskIds.add(request.task.id);
    }

    const reactivatedProjectIds = Array.from(targetByProjectId.keys());
    if (reactivatedProjectIds.length === 0) {
        return { tasks, projects, sections, reactivatedProjectIds };
    }

    const reactivatedProjectIdSet = new Set(reactivatedProjectIds);
    const nextTasks = mapChanged(tasks, (task) => (
        task.projectId
        && reactivatedProjectIdSet.has(task.projectId)
        && !reopenedTaskIds.has(task.id)
            ? retireTaskProjectArchiveMetadata(task, now, deviceId)
            : task
    ));
    const nextProjects = mapChanged(projects, (project) => {
        if (!reactivatedProjectIdSet.has(project.id)) return project;
        const projectUpdates = normalizeProjectUpdate(project, { status: 'active' });
        return normalizeProjectLifecycleFields({
            ...project,
            ...projectUpdates,
            updatedAt: now,
            rev: nextRevision(project.rev),
            revBy: deviceId,
        });
    });
    const nextSections = mapChanged(sections, (section) => (
        reactivatedProjectIdSet.has(section.projectId)
            ? restoreSectionFromProjectArchive(section, now, deviceId)
            : section
    ));

    return {
        tasks: nextTasks,
        projects: nextProjects,
        sections: nextSections,
        reactivatedProjectIds,
    };
};

export type ProjectLifecycleTransition = {
    projectUpdates: Partial<Project>;
    tasks: Task[];
    sections: Section[];
};

const mapChanged = <T>(items: T[], mapper: (item: T) => T): T[] => {
    let changed = false;
    const next = items.map((item) => {
        const mapped = mapper(item);
        if (mapped !== item) changed = true;
        return mapped;
    });
    return changed ? next : items;
};


export const applyProjectLifecycleTransition = (
    project: Project,
    updates: Partial<Project>,
    tasks: Task[],
    sections: Section[],
    now: string,
    deviceId?: string,
): ProjectLifecycleTransition => {
    const projectUpdates = normalizeProjectUpdate(project, updates);
    const normalizedProject = normalizeProjectLifecycleFields({ ...project, ...projectUpdates });
    const incomingStatus = normalizedProject.status;
    const enteredArchive = project.status !== 'archived' && incomingStatus === 'archived';
    const activatedCancellation = isProjectCancelled(normalizedProject)
        && (!isProjectCancelled(project) || project.cancelledAt !== normalizedProject.cancelledAt);
    const reactivated = project.status === 'archived' && incomingStatus !== 'archived';
    if (enteredArchive) projectUpdates.archivedAt = now;
    else if (reactivated) projectUpdates.archivedAt = undefined;

    let nextTasks = tasks;
    let nextSections = sections;
    const projectSectionIds = new Set(sections.filter((section) => section.projectId === project.id).map((section) => section.id));
    const isProjectChild = (task: Task): boolean => task.projectId === project.id
        || (!task.projectId && !!task.sectionId && projectSectionIds.has(task.sectionId));
    const repairSectionOnlyOwner = (original: Task, changed: Task): Task => original.projectId
        ? changed
        : changed === original
            ? { ...changed, projectId: project.id, updatedAt: now, rev: nextRevision(changed.rev), revBy: deviceId }
            : { ...changed, projectId: project.id };
    if (enteredArchive || activatedCancellation) {
        const cancelledAt = normalizedProject.cancelledAt;
        nextTasks = mapChanged(tasks, (task) => {
            if (!isProjectChild(task) || task.deletedAt) return task;
            let changed: Task;
            if (isProjectCancelled(normalizedProject)) {
                changed = isTaskActionable(task)
                    ? cancelTaskForProjectArchive(task, cancelledAt!, deviceId, now)
                    : enteredArchive && !task.archivedAt
                        ? { ...task, archivedAt: now, updatedAt: now, rev: nextRevision(task.rev), revBy: deviceId }
                        : task;
            } else {
                changed = !isTaskFinished(task) && task.status !== 'reference'
                    ? completeTaskForProjectArchive(task, now, deviceId)
                    : enteredArchive && !task.archivedAt
                        ? { ...task, archivedAt: now, updatedAt: now, rev: nextRevision(task.rev), revBy: deviceId }
                        : task;
            }
            return repairSectionOnlyOwner(task, changed);
        });
        if (enteredArchive) {
            nextSections = mapChanged(sections, (section) => (
                section.projectId === project.id && !section.deletedAt
                    ? archiveSectionForProjectArchive(section, now, deviceId)
                    : section
            ));
        }
    } else if (reactivated) {
        nextTasks = mapChanged(tasks, (task) => {
            if (!isProjectChild(task) || task.deletedAt) return task;
            const changed = task.projectArchivedAt
                ? restoreTaskFromProjectArchive(task, now, deviceId)
                : task.status !== 'archived' && task.archivedAt
                    ? { ...task, archivedAt: undefined, updatedAt: now, rev: nextRevision(task.rev), revBy: deviceId }
                    : task;
            return repairSectionOnlyOwner(task, changed);
        });
        nextSections = mapChanged(sections, (section) => (
            section.projectId === project.id && section.projectArchivedAt
                ? restoreSectionFromProjectArchive(section, now, deviceId)
                : section
        ));
    }

    return { projectUpdates, tasks: nextTasks, sections: nextSections };
};

export const buildEntityMap = <T extends EntityWithId>(items: readonly T[]): Map<string, T> =>
    new Map(items.map((item) => [item.id, item] as const));

export const replaceEntityInArray = <T extends EntityWithId>(items: readonly T[], id: string, nextItem: T): T[] => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return items as T[];
    if (items[index] === nextItem) return items as T[];
    const nextItems = items.slice();
    nextItems[index] = nextItem;
    return nextItems;
};

export const replaceEntitiesInArray = <T extends EntityWithId>(
    items: readonly T[],
    nextItems: readonly T[]
): T[] => {
    if (nextItems.length === 0) return items as T[];
    const replacementsById = new Map(nextItems.map((item) => [item.id, item] as const));
    let patchedItems: T[] | null = null;
    for (let index = 0; index < items.length; index += 1) {
        const currentItem = items[index];
        const nextItem = replacementsById.get(currentItem.id);
        if (!nextItem || nextItem === currentItem) continue;
        if (!patchedItems) patchedItems = items.slice();
        patchedItems[index] = nextItem;
    }
    return patchedItems ?? items as T[];
};

export const replaceEntityInMap = <T extends EntityWithId>(
    itemsById: Map<string, T>,
    nextItem: T
): Map<string, T> => {
    if (itemsById.get(nextItem.id) === nextItem) return itemsById;
    const nextItemsById = new Map(itemsById);
    nextItemsById.set(nextItem.id, nextItem);
    return nextItemsById;
};

export const reuseArrayIfShallowEqual = <T>(previous: T[], next: T[]): T[] => (
    previous.length === next.length && previous.every((item, index) => item === next[index])
        ? previous
        : next
);


const haveSameAttachments = (left?: Attachment[], right?: Attachment[]): boolean => {
    if (left === right) return true;
    const leftItems = left ?? [];
    const rightItems = right ?? [];
    if (leftItems.length !== rightItems.length) return false;
    for (let index = 0; index < leftItems.length; index += 1) {
        if (leftItems[index] === rightItems[index]) continue;
        if (JSON.stringify(leftItems[index]) !== JSON.stringify(rightItems[index])) return false;
    }
    return true;
};

const withoutAttachmentEquality = <T extends EntityWithRevision>(existing: T, incoming: T): boolean => (
    existing.updatedAt === incoming.updatedAt
    && normalizeRevision(existing.rev) === normalizeRevision(incoming.rev)
    && existing.revBy === incoming.revBy
    && existing.deletedAt === incoming.deletedAt
    && existing.purgedAt === incoming.purgedAt
);

export const hasSameEntityIdentity = <T extends EntityWithRevision>(existing: T, incoming: T): boolean => (
    withoutAttachmentEquality(existing, incoming)
    && haveSameAttachments(
        (existing as { attachments?: Attachment[] }).attachments,
        (incoming as { attachments?: Attachment[] }).attachments,
    )
);


const isAttachmentOnlyDivergence = <T extends EntityWithRevision>(existing: T, incoming: T): boolean => (
    withoutAttachmentEquality(existing, incoming)
    && !haveSameAttachments(
        (existing as { attachments?: Attachment[] }).attachments,
        (incoming as { attachments?: Attachment[] }).attachments,
    )
);

type ReconciledCollection<T> = { items: T[]; byId: Map<string, T>; replacedCount: number; attachmentOnlyReplacedCount: number };

export const reconcileEntityCollection = <T extends EntityWithRevision>(
    previousItems: readonly T[],
    previousById: Map<string, T>,
    incomingItems: readonly T[]
): ReconciledCollection<T> => runToEnd(reconcileEntityCollectionPass(previousItems, previousById, incomingItems));


export function* reconcileEntityCollectionPass<T extends EntityWithRevision>(
    previousItems: readonly T[],
    previousById: Map<string, T>,
    incomingItems: readonly T[]
): CooperativePass<ReconciledCollection<T>> {
    let changed = previousItems.length !== incomingItems.length;
    let replacedCount = 0;
    let attachmentOnlyReplacedCount = 0;
    const nextItems = yield* mapPass(incomingItems, (incoming, index) => {
        const existing = previousById.get(incoming.id);
        const reuseExisting = existing != null && hasSameEntityIdentity(existing, incoming);
        if (!reuseExisting) {
            replacedCount += 1;
            if (existing != null && isAttachmentOnlyDivergence(existing, incoming)) {
                attachmentOnlyReplacedCount += 1;
            }
        }
        const resolved = reuseExisting ? existing : incoming;
        if (!changed && previousItems[index] !== resolved) {
            changed = true;
        }
        return resolved;
    });

    if (!changed) {
        return {
            items: previousItems as T[],
            byId: previousById,
            replacedCount,
            attachmentOnlyReplacedCount,
        };
    }

    return {
        items: nextItems,
        byId: buildEntityMap(nextItems),
        replacedCount,
        attachmentOnlyReplacedCount,
    };
}


const VOLATILE_SYNC_STATUS_SETTINGS_KEYS = [
    'lastSyncAt',
    'lastSyncStatus',
    'lastSyncError',
    'lastSyncStats',
    'lastSyncHistory',
] as const;

const withoutVolatileSyncStatus = (settings: AppData['settings']): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...(settings ?? {}) };
    for (const key of VOLATILE_SYNC_STATUS_SETTINGS_KEYS) {
        delete copy[key];
    }
    return copy;
};


export const reuseSettingsIfEquivalent = (
    previous: AppData['settings'] | undefined,
    next: AppData['settings']
): AppData['settings'] => {
    if (!previous) return next;
    if (previous === next) return previous;
    try {
        return JSON.stringify(withoutVolatileSyncStatus(previous)) === JSON.stringify(withoutVolatileSyncStatus(next))
            ? previous
            : next;
    } catch {
        return next;
    }
};

const assertCollectionSnapshotIncludesExistingItems = <T extends EntityWithId>(
    label: string,
    nextItems: T[],
    previousItems: T[]
): void => {
    if (nextItems === previousItems) return;


    const nextIds = new Set(nextItems.map((item) => item.id));
    const missingIds = previousItems
        .filter((item) => !nextIds.has(item.id))
        .slice(0, 10)
        .map((item) => item.id);
    if (missingIds.length === 0) return;
    throw new Error(
        `Refusing to save a partial ${label} snapshot; missing existing ids: ${missingIds.join(', ')}`
    );
};

export const buildSaveSnapshot = (state: SaveBaseState, overrides?: Partial<AppData>): AppData => {
    const tasks = overrides?.tasks ?? state._allTasks;
    const projects = overrides?.projects ?? state._allProjects;
    const sections = overrides?.sections ?? state._allSections;
    const areas = overrides?.areas ?? state._allAreas;
    const people = overrides?.people ?? state._allPeople;
    if (overrides?.tasks) {
        assertCollectionSnapshotIncludesExistingItems<Task>('task', tasks, state._allTasks);
    }
    if (overrides?.projects) {
        assertCollectionSnapshotIncludesExistingItems<Project>('project', projects, state._allProjects);
    }
    if (overrides?.sections) {
        assertCollectionSnapshotIncludesExistingItems<Section>('section', sections, state._allSections);
    }
    if (overrides?.areas) {
        assertCollectionSnapshotIncludesExistingItems<Area>('area', areas, state._allAreas);
    }
    if (overrides?.people) {
        assertCollectionSnapshotIncludesExistingItems<Person>('person', people, state._allPeople);
    }
    return {
        tasks,
        projects,
        sections,
        areas,
        people,
        settings: overrides?.settings ?? state.settings,
    };
};

type PersistSet = (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
type PersistDebouncedSave = (data: AppData, onError?: (msg: string) => void) => void;


export const persist = (
    set: PersistSet,
    debouncedSave: PersistDebouncedSave,
    state: SaveBaseState,
    overrides?: Partial<AppData>,
): void => {
    const snapshot = buildSaveSnapshot(state, overrides);
    debouncedSave(snapshot, (msg) => set({ error: msg }));
};

export const computeDerivedState = (tasks: Task[], projects: Project[], sections?: readonly Section[]): DerivedState => {
    const projectDerived = computeProjectDerivedState(projects, undefined, sections);
    const taskDerived = computeTaskDerivedState(tasks);

    return {
        ...projectDerived,
        ...taskDerived,
    };
};

export const computeProjectDerivedState = (
    projects: Iterable<Project>,
    projectMap?: Map<string, Project>,
    sections?: readonly Section[],
): Pick<DerivedState, 'projectMap' | 'sequentialProjectIds' | 'sequentialWithinSectionProjectIds' | 'sequentialSectionKeys' | 'focusedProjectCount'> => {
    const resolvedProjectMap = projectMap ?? new Map<string, Project>();
    const liveProjects: Project[] = [];
    let focusedProjectCount = 0;

    for (const project of projects) {
        if (!projectMap) {
            resolvedProjectMap.set(project.id, project);
        }
        if (project.deletedAt) continue;
        liveProjects.push(project);
        if (project.isFocused) {
            focusedProjectCount += 1;
        }
    }
    const sequencing = getTaskSequencing(liveProjects, sections);

    return {
        projectMap: resolvedProjectMap,
        sequentialProjectIds: sequencing.sequentialProjectIds as Set<string>,
        sequentialWithinSectionProjectIds: sequencing.sectionScopedProjectIds as Set<string>,
        sequentialSectionKeys: sequencing.sequentialSectionKeys as Set<string>,
        focusedProjectCount,
    };
};


export const isTaskCountedAsFocused = (task: Task, now: Date): boolean => (
    !task.deletedAt
    && isTaskFocusedNow(task, now)
    && task.status !== 'done' && task.status !== 'reference' && task.status !== 'archived'
);

let focusedCountCache: { tasks: Task[]; day: string; count: number } | null = null;


export const selectFocusedCount = (tasks: Task[]): number => {
    const now = new Date();
    const day = now.toDateString();
    if (focusedCountCache && focusedCountCache.tasks === tasks && focusedCountCache.day === day) {
        return focusedCountCache.count;
    }
    let count = 0;
    for (const task of tasks) {
        if (isTaskCountedAsFocused(task, now)) count += 1;
    }
    focusedCountCache = { tasks, day, count };
    return count;
};

export const computeTaskDerivedState = (
    tasks: Task[],
    tasksById?: Map<string, Task>,
    now: Date = new Date(),
): Pick<DerivedState, 'tasksById' | 'activeTasksByStatus' | 'tasksByProjectId' | 'tasksByContext' | 'tasksByTag' | 'focusedTasks' | 'projectTaskSummaryById' | 'allContexts' | 'allTags' | 'contextTokenUsage' | 'tagTokenUsage' | 'dateCoherenceIssuesByTaskId' | 'focusedCount'> => {
    const resolvedTasksById = tasksById ?? new Map<string, Task>();
    const activeTasksByStatus = new Map<TaskStatus, Task[]>();
    const tasksByProjectId = new Map<string, Task[]>();
    const tasksByContext = new Map<string, Task[]>();
    const tasksByTag = new Map<string, Task[]>();
    const focusedTasks: Task[] = [];
    const projectTaskSummaryById = new Map<string, ProjectTaskSummary>();
    const dateCoherenceIssuesByTaskId = new Map<string, ReturnType<typeof getTaskDateCoherenceIssues>>();


    const contextTokens = createTaskTokenUsageAccumulator({ prefix: '@' });
    const tagTokens = createTaskTokenUsageAccumulator({ prefix: '#' });
    let focusedCount = 0;

    tasks.forEach((task) => {
        if (!tasksById) {
            resolvedTasksById.set(task.id, task);
        }
        if (task.deletedAt) return;
        const list = activeTasksByStatus.get(task.status) ?? [];
        list.push(task);
        activeTasksByStatus.set(task.status, list);
        if (task.projectId) {
            const projectTasks = tasksByProjectId.get(task.projectId) ?? [];
            projectTasks.push(task);
            tasksByProjectId.set(task.projectId, projectTasks);

            if (isTaskActionable(task)) {
                const summary = projectTaskSummaryById.get(task.projectId) ?? { activeTaskCount: 0 };
                summary.activeTaskCount += 1;
                if (task.status === 'waiting') summary.hasWaitingAction = true;
                if (task.status === 'next' && (!summary.nextAction || compareTasksByProjectOrder(task, summary.nextAction) < 0)) {
                    summary.nextAction = task;
                }
                projectTaskSummaryById.set(task.projectId, summary);
            }
        }
        const hasContextTokens = (task.contexts?.length ?? 0) > 0;
        const hasTagTokens = (task.tags?.length ?? 0) > 0;
        const taskTokenTimestamp = hasContextTokens || hasTagTokens
            ? getTaskTokenUsageTimestamp(task)
            : undefined;
        contextTokens.add(task, (candidate) => candidate.contexts, taskTokenTimestamp);
        tagTokens.add(task, (candidate) => candidate.tags, taskTokenTimestamp);
        (task.contexts ?? []).forEach((context) => {
            const contextTasks = tasksByContext.get(context) ?? [];
            contextTasks.push(task);
            tasksByContext.set(context, contextTasks);
        });
        (task.tags ?? []).forEach((tag) => {
            const tagTasks = tasksByTag.get(tag) ?? [];
            tagTasks.push(task);
            tasksByTag.set(tag, tagTasks);
        });
        const dateCoherenceIssues = getTaskDateCoherenceIssues(task);
        if (dateCoherenceIssues.length > 0) {
            dateCoherenceIssuesByTaskId.set(task.id, dateCoherenceIssues);
        }
        if (isTaskCountedAsFocused(task, now)) {
            focusedCount += 1;
            focusedTasks.push(task);
        }
    });

    const contextTokenUsage = contextTokens.toUsage();
    const tagTokenUsage = tagTokens.toUsage();

    return {
        tasksById: resolvedTasksById,
        activeTasksByStatus,
        tasksByProjectId,
        tasksByContext,
        tasksByTag,
        focusedTasks,
        projectTaskSummaryById,
        allContexts: getUsedTaskTokensFromUsage(contextTokenUsage),
        allTags: getUsedTaskTokensFromUsage(tagTokenUsage),
        contextTokenUsage,
        tagTokenUsage,
        dateCoherenceIssuesByTaskId,
        focusedCount,
    };
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
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

export const normalizeTagId = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const withPrefix = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return withPrefix.toLowerCase();
};

export const stripSensitiveSettings = (settings: AppData['settings']): AppData['settings'] => {
    if (!settings?.ai || !settings.ai.apiKey) return settings;
    return {
        ...settings,
        ai: {
            ...settings.ai,
            apiKey: undefined,
        },
    };
};

export const normalizeAiSettingsForSync = (ai?: AiSettings): AiSettings | undefined => {
    if (!ai) return ai;


    const { apiKey: _apiKey, baseUrl: _baseUrl, openAIExtraBodyParams: _extraBody, ...rest } = ai;
    if (!rest.speechToText) return rest;
    return {
        ...rest,
        speechToText: {
            ...rest.speechToText,
            offlineModelPath: undefined,
            baseUrl: undefined,
        },
    };
};

export const cloneSettings = (settings: AppData['settings']): AppData['settings'] => {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(settings);
        }
    } catch {

    }
    return JSON.parse(JSON.stringify(settings)) as AppData['settings'];
};

export const sanitizeAppDataForStorage = (data: AppData): AppData => {
    const settings = stripSensitiveSettings(cloneSettings(data.settings));
    retainRawReadSettingsSnapshot(data.settings, settings);
    return { ...data, settings };
};

export const getTaskOrder = (task: Pick<Task, 'order' | 'orderNum'>): number | undefined => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return undefined;
};

const getProjectOrderIndex = (tasks: Task[]): Map<string, number> => {
    const nextCache = new Map<string, number>();
    for (const task of tasks) {
        if (task.deletedAt || !task.projectId) continue;
        const order = getTaskOrder(task) ?? -1;
        const previous = nextCache.get(task.projectId) ?? -1;
        if (order > previous) {
            nextCache.set(task.projectId, order);
        }
    }
    return nextCache;
};

export const getNextProjectOrder = (
    projectId: string | undefined,
    tasks: Task[]
): number | undefined => {
    if (!projectId) return undefined;
    return (getProjectOrderIndex(tasks).get(projectId) ?? -1) + 1;
};

export type ProjectOrderReserver = (projectId: string | undefined) => number | undefined;

export const createProjectOrderReserver = (tasks: Task[]): ProjectOrderReserver => {
    const nextOrders = getProjectOrderIndex(tasks);
    return (projectId: string | undefined): number | undefined => {
        if (!projectId) return undefined;
        const nextOrder = (nextOrders.get(projectId) ?? -1) + 1;
        nextOrders.set(projectId, nextOrder);
        return nextOrder;
    };
};
