import { getTaskReminderPolicy, normalizeTaskReminderPolicy, suppressLegacyTaskReminders } from './task-reminder-policy';
import type { Task, TaskStatus } from './types';
import type { TaskStore } from './store-types';
import { getReferenceTaskFieldClears, getTaskOrder, resolveCaptureStatusForStart, type ProjectOrderReserver } from './store-helpers';
import { normalizeOptionalContainerId, resolveTaskContainerAssignment } from './task-container-rules';
import { resolveDefaultNewTaskAreaId } from './area-utils';
import { normalizeCancellationTimestamp, normalizeTaskLifecycleFields } from './task-status';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes, normalizeRepeatReminderMinutes } from './schedule-utils';
import { resolveTaskFocusCreation } from './focus-star';
import { isTaskFutureFocusCandidate, isTaskFutureFocusCandidateBeforeBoundary, type FocusDateLookup } from './task-utils';

const hasOwnField = (value: object, field: PropertyKey) => Object.prototype.hasOwnProperty.call(value, field);


export function buildNewTask({
    title, initialTaskProps, id, now, deviceId, state, tasks, focusedCount, focusTaskLimit, projectOrderReserver, endOfTodayIso, frozenDates,
}: {
    title: string;
    initialTaskProps: Partial<Task>;
    id: string;
    now: string;
    deviceId: string;
    state: Pick<TaskStore, 'settings' | '_allProjects' | '_allSections' | '_allAreas'>;
    tasks: Task[];
    focusedCount: number;
    focusTaskLimit: number;
    projectOrderReserver: ProjectOrderReserver;

    endOfTodayIso?: string;
    frozenDates?: FocusDateLookup;
}): { ok: true; task: Task; focusedCount: number } | { ok: false; error: string } {
    const hasExplicitAreaId = hasOwnField(initialTaskProps, 'areaId');
    const shouldApplyDefaultArea = !hasExplicitAreaId
        && !normalizeOptionalContainerId(initialTaskProps.projectId)
        && !normalizeOptionalContainerId(initialTaskProps.sectionId);
    const defaultAreaId = shouldApplyDefaultArea
        ? resolveDefaultNewTaskAreaId(state.settings, state._allAreas)
        : undefined;
    const containerResolution = resolveTaskContainerAssignment({
        projectId: initialTaskProps.projectId,
        sectionId: initialTaskProps.sectionId,
        areaId: defaultAreaId ?? initialTaskProps.areaId,
        allProjects: state._allProjects,
        allSections: state._allSections,
        allAreas: state._allAreas,
    });
    if (!containerResolution.ok) {
        return containerResolution;
    }

    const resolvedStatus = (initialTaskProps.status ?? 'inbox') as TaskStatus;


    const cancellationTimestamp = normalizeCancellationTimestamp(initialTaskProps.cancelledAt);
    const effectiveStatus: TaskStatus = cancellationTimestamp && !hasOwnField(initialTaskProps, 'status')
        ? 'archived'
        : resolveCaptureStatusForStart(initialTaskProps, resolvedStatus);
    const hasTaskOrder = hasOwnField(initialTaskProps, 'order') || hasOwnField(initialTaskProps, 'orderNum');
    const resolvedProjectId = containerResolution.projectId;
    const resolvedSectionId = containerResolution.sectionId;
    const resolvedAreaId = containerResolution.areaId;
    const referenceClears = resolvedStatus === 'reference'
        ? getReferenceTaskFieldClears(initialTaskProps.dueReminderLeadMinutes, initialTaskProps.startReminderLeadMinutes)
        : {};
    const explicitOrder = getTaskOrder(initialTaskProps);
    const resolvedOrder = !hasTaskOrder && resolvedProjectId
        ? projectOrderReserver(resolvedProjectId)
        : explicitOrder;
    const reminderPolicy = normalizeTaskReminderPolicy(initialTaskProps.reminderPolicy)
        ?? (typeof initialTaskProps.suppressMindwtrReminders === 'boolean'
            ? getTaskReminderPolicy(initialTaskProps) : 'inherit');
    let newTask: Task = {
        ...initialTaskProps,
        id,
        title,
        status: effectiveStatus,
        taskMode: initialTaskProps.taskMode ?? 'task',
        tags: initialTaskProps.tags ?? [],
        contexts: initialTaskProps.contexts ?? [],
        pushCount: initialTaskProps.pushCount ?? 0,
        recurrence: normalizeRecurrenceForLoad(initialTaskProps.recurrence),
        repeatReminderMinutes: normalizeRepeatReminderMinutes(initialTaskProps.repeatReminderMinutes),
        dueReminderLeadMinutes: normalizeDueReminderLeadMinutes(initialTaskProps.dueReminderLeadMinutes),
        startReminderLeadMinutes: normalizeStartReminderLeadMinutes(initialTaskProps.startReminderLeadMinutes),
        rev: 1,
        revBy: deviceId,
        createdAt: now,
        updatedAt: now,
        deletedAt: undefined,
        purgedAt: undefined,
        archivedAt: effectiveStatus === 'archived' ? now : undefined,


        isFocusedToday: initialTaskProps.isFocusedToday ?? false,
        reminderPolicy,
        suppressMindwtrReminders: suppressLegacyTaskReminders({ reminderPolicy }, state.settings),
        ...referenceClears,
        areaId: resolvedAreaId,
        projectId: resolvedProjectId,
        sectionId: resolvedSectionId,
        order: resolvedOrder,
        orderNum: resolvedOrder,
    };

    if (newTask.isFocusedToday === true) {
        const creationTime = new Date(now);
        const focusDecision = resolveTaskFocusCreation(newTask, {
            tasks,
            projects: state._allProjects,
            sections: state._allSections,
            focusedCount,
            focusTaskLimit,
            now: creationTime,
            endOfTodayIso,
            frozenDates,
        });
        newTask.status = focusDecision.status;
        newTask.isFocusedToday = focusDecision.isFocusedToday;
        if (focusDecision.outcome === 'focused' && !(endOfTodayIso
            ? isTaskFutureFocusCandidateBeforeBoundary(newTask, endOfTodayIso, frozenDates)
            : isTaskFutureFocusCandidate(newTask, creationTime))) {
            focusedCount += 1;
        }
    }

    newTask = normalizeTaskLifecycleFields(newTask);
    return { ok: true, task: newTask, focusedCount };
}
