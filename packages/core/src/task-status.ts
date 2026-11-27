import type { Task, TaskStatus } from './types';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes, normalizeRepeatReminderMinutes } from './schedule-utils';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { preserveShallowIdentity, sameShallowRecord, sameShallowValue } from './shallow-identity';
import { safeParseDate } from './date';
import type { FocusDateProjection } from './task-utils';

export const TASK_STATUS_VALUES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
export const TASK_STATUS_SET = new Set<TaskStatus>(TASK_STATUS_VALUES);
export const TASK_STATUS_ORDER: Record<TaskStatus, number> = {
    inbox: 0,
    next: 1,
    waiting: 2,
    someday: 3,
    reference: 4,
    done: 5,
    archived: 6,
};


const ISO_DATETIME_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function normalizeCancellationTimestamp(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const match = ISO_DATETIME_WITH_TIMEZONE.exec(value);
    if (!match) return undefined;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
    const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    if (
        month < 1 || month > 12
        || day < 1 || day > daysInMonth
        || hour > 23
        || minute > 59
        || second > 59
        || offsetHour > 23
        || offsetMinute > 59
    ) {
        return undefined;
    }
    return Number.isFinite(Date.parse(value)) ? value : undefined;
}


export function isTaskFinished(taskOrStatus: { status?: TaskStatus } | TaskStatus | undefined): boolean {
    const status = typeof taskOrStatus === 'string' ? taskOrStatus : taskOrStatus?.status;
    return status === 'done' || status === 'archived';
}


export function isTaskCancelled(
    task: Pick<Task, 'status' | 'cancelledAt'> | undefined,
): boolean {
    return task?.status === 'archived'
        && normalizeCancellationTimestamp(task.cancelledAt) !== undefined;
}


export function isTaskCompleted(
    task: Pick<Task, 'status' | 'cancelledAt'> | undefined,
): boolean {
    if (!task) return false;
    return (task.status === 'done' || task.status === 'archived')
        && !isTaskCancelled(task);
}


export function isTaskActionable(taskOrStatus: { status?: TaskStatus } | TaskStatus | undefined): boolean {
    const status = typeof taskOrStatus === 'string' ? taskOrStatus : taskOrStatus?.status;
    return status !== 'done' && status !== 'archived' && status !== 'reference';
}

const LEGACY_STATUS_MAP: Record<string, TaskStatus> = {
    planned: 'next',
    pending: 'next',
    'in-progress': 'next',
    doing: 'next',
};


const hasOwnProperty = Object.prototype.hasOwnProperty;

export type TaskLoadTemporalContext = { futureBoundary: string;
    dates: ReadonlyMap<string, Pick<FocusDateProjection, 'parsedAt'>> };
const isFutureStart = (task: Pick<Task, 'startTime'>, now: Date, temporal?: TaskLoadTemporalContext): boolean => {
    if (temporal) {
        const parsedAt = task.startTime ? temporal.dates.get(task.startTime)?.parsedAt : null;
        return parsedAt != null && parsedAt > Date.parse(temporal.futureBoundary);
    }
    const start = safeParseDate(task.startTime);
    if (!start) return false;
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return start > endOfToday;
};

export function normalizeTaskStatus(value: unknown): TaskStatus {
    if (value === 'inbox' || value === 'next' || value === 'waiting' || value === 'someday' || value === 'reference' || value === 'done' || value === 'archived') {
        return value;
    }

    if (typeof value === 'string') {
        const lowered = value.toLowerCase().trim();
        if (lowered === 'inbox' || lowered === 'next' || lowered === 'waiting' || lowered === 'someday' || lowered === 'reference' || lowered === 'done' || lowered === 'archived') {
            return lowered as TaskStatus;
        }
        const mapped = LEGACY_STATUS_MAP[lowered];
        if (mapped) return mapped;
    }

    return 'inbox';
}


function lifecycleFields(status: TaskStatus, cancelledAt: unknown, completedAt: string | undefined, updatedAt: string, createdAt: string) {
    const cancelled = status === 'archived' ? normalizeCancellationTimestamp(cancelledAt) : undefined;
    const terminal = isTaskFinished(status);
    return {
        cancelledAt: cancelled,
        completedAt: cancelled ? undefined : terminal ? (completedAt || updatedAt || createdAt) : undefined,
        focus: terminal ? { isFocusedToday: false, focusOrder: undefined } : {},
    };
}


export function normalizeTaskLifecycleFields(task: Task): Task {
    const { cancelledAt, completedAt, focus } = lifecycleFields(task.status, task.cancelledAt, task.completedAt, task.updatedAt, task.createdAt);
    const next: Task = {
        ...task,
        cancelledAt,
        completedAt,
        ...focus,
    };
    return sameShallowRecord(task, next) ? task : next;
}

const storedAs = (task: Task, key: keyof Task, value: unknown): boolean =>
    hasOwnProperty.call(task, key) && sameShallowValue(task[key], value);

export function normalizeTaskForLoad(task: Task, nowIso: string = new Date().toISOString(), temporal?: TaskLoadTemporalContext): Task {
    const normalizedStatus = normalizeTaskStatus((task as any).status);

    let createdAtIso = typeof task.createdAt === 'string' ? task.createdAt : nowIso;
    let createdAtMs = Date.parse(createdAtIso);
    if (!Number.isFinite(createdAtMs)) {
        createdAtIso = nowIso;
        createdAtMs = Date.parse(createdAtIso);
    }
    let updatedAtIso = typeof task.updatedAt === 'string' ? task.updatedAt : createdAtIso;
    const updatedAtMs = Date.parse(updatedAtIso);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs < createdAtMs) {
        updatedAtIso = createdAtIso;
    }

    const hasValidPushCount = typeof task.pushCount === 'number' && Number.isFinite(task.pushCount);
    const projectId =
        typeof task.projectId === 'string' && task.projectId.trim().length > 0
            ? task.projectId
            : undefined;
    const areaId =
        typeof task.areaId === 'string' && task.areaId.trim().length > 0
            ? task.areaId
            : undefined;
    const resolvedAreaId = projectId ? undefined : areaId;
    const textDirection =
        typeof task.textDirection === 'string' && ['auto', 'ltr', 'rtl'].includes(task.textDirection)
            ? task.textDirection
            : undefined;
    const rawRev = (task as any).rev;
    const rev = typeof rawRev === 'number'
        && Number.isFinite(rawRev)
        && Number.isInteger(rawRev)
        && rawRev >= 0
        ? rawRev
        : 0;
    const rawRevBy = (task as any).revBy;
    const revBy = typeof rawRevBy === 'string' && rawRevBy.trim().length > 0
        ? rawRevBy.trim()
        : undefined;
    const normalizedOrder = Number.isFinite(task.order)
        ? (task.order as number)
        : Number.isFinite((task as Task & { orderNum?: unknown }).orderNum)
            ? ((task as Task & { orderNum?: number }).orderNum as number)
            : undefined;
    const relativeStartOffset = task.dueDate
        ? preserveShallowIdentity(task.relativeStartOffset, normalizeRelativeStartOffset(task.relativeStartOffset))
        : undefined;
    const recurrence = preserveShallowIdentity(task.recurrence, normalizeRecurrenceForLoad(task.recurrence));
    const repeatReminderMinutes = normalizeRepeatReminderMinutes(task.repeatReminderMinutes);
    const dueReminderLeadMinutes = normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes);
    const startReminderLeadMinutes = normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes);
    const timeSpentMinutes = normalizeTimeSpentMinutes(task.timeSpentMinutes);
    const addsPushCount = !(hasValidPushCount || task.purgedAt);
    const { cancelledAt, completedAt } = lifecycleFields(normalizedStatus, task.cancelledAt, task.completedAt, updatedAtIso, createdAtIso);
    const terminal = isTaskFinished(normalizedStatus);
    const unfocusesFutureStart = !terminal && Boolean(task.isFocusedToday) && isFutureStart(task, new Date(nowIso), temporal);
    const clearsFocusFlag = terminal || (unfocusesFutureStart && normalizedStatus !== 'next');
    const clearsFocusOrder = terminal || unfocusesFutureStart;

    const unchanged = storedAs(task, 'rev', rev)
        && (revBy ? storedAs(task, 'revBy', revBy) : !hasOwnProperty.call(task, 'revBy'))
        && (!addsPushCount || storedAs(task, 'pushCount', 0))
        && storedAs(task, 'createdAt', createdAtIso)
        && storedAs(task, 'updatedAt', updatedAtIso)
        && storedAs(task, 'status', normalizedStatus)
        && storedAs(task, 'projectId', projectId)
        && storedAs(task, 'areaId', resolvedAreaId)
        && storedAs(task, 'order', normalizedOrder)
        && storedAs(task, 'orderNum', normalizedOrder)
        && storedAs(task, 'recurrence', recurrence)
        && storedAs(task, 'repeatReminderMinutes', repeatReminderMinutes)
        && storedAs(task, 'dueReminderLeadMinutes', dueReminderLeadMinutes)
        && storedAs(task, 'startReminderLeadMinutes', startReminderLeadMinutes)
        && storedAs(task, 'timeSpentMinutes', timeSpentMinutes)
        && storedAs(task, 'relativeStartOffset', relativeStartOffset)
        && storedAs(task, 'cancelledAt', cancelledAt)
        && storedAs(task, 'completedAt', completedAt)
        && (!clearsFocusFlag || storedAs(task, 'isFocusedToday', false))
        && (!clearsFocusOrder || storedAs(task, 'focusOrder', undefined));
    if (unchanged) return task;

    const { rev: _legacyRev, revBy: _legacyRevBy, ...rest } = task as Task & { rev?: unknown; revBy?: unknown };
    const next = rest as Task;
    next.createdAt = createdAtIso;
    next.updatedAt = updatedAtIso;
    next.status = normalizedStatus;
    next.projectId = projectId;
    next.areaId = resolvedAreaId;
    next.order = normalizedOrder;
    next.orderNum = normalizedOrder;
    next.recurrence = recurrence;
    next.repeatReminderMinutes = repeatReminderMinutes;
    next.dueReminderLeadMinutes = dueReminderLeadMinutes;
    next.startReminderLeadMinutes = startReminderLeadMinutes;
    next.timeSpentMinutes = timeSpentMinutes;
    next.relativeStartOffset = relativeStartOffset;
    next.rev = rev;
    if (revBy) next.revBy = revBy;
    if (textDirection) next.textDirection = textDirection;
    if (addsPushCount) next.pushCount = 0;
    next.cancelledAt = cancelledAt;
    next.completedAt = completedAt;
    if (terminal) {
        next.isFocusedToday = false;
        next.focusOrder = undefined;
    }
    if (unfocusesFutureStart) {
        if (normalizedStatus !== 'next') next.isFocusedToday = false;
        next.focusOrder = undefined;
    }
    return next;
}
