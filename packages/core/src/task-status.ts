import type { Task, TaskStatus } from './types';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes, normalizeRepeatReminderMinutes } from './schedule-utils';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { preserveShallowIdentity, sameShallowRecord } from './shallow-identity';
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

export function normalizeTaskForLoad(task: Task, nowIso: string = new Date().toISOString(), temporal?: TaskLoadTemporalContext): Task {
    const normalizedStatus = normalizeTaskStatus((task as any).status);
    const { rev: _legacyRev, revBy: _legacyRevBy, ...rest } = task as Task & { rev?: unknown; revBy?: unknown };

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
    const lifecycle = lifecycleFields(normalizedStatus, rest.cancelledAt, rest.completedAt, updatedAtIso, createdAtIso);


    const next: Task = {
        ...rest,
        createdAt: createdAtIso,
        updatedAt: updatedAtIso,
        status: normalizedStatus,
        projectId,
        areaId: resolvedAreaId,
        order: normalizedOrder,
        orderNum: normalizedOrder,
        recurrence: preserveShallowIdentity(task.recurrence, normalizeRecurrenceForLoad(task.recurrence)),
        repeatReminderMinutes: normalizeRepeatReminderMinutes(task.repeatReminderMinutes),
        dueReminderLeadMinutes: normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes),
        startReminderLeadMinutes: normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes),
        timeSpentMinutes: normalizeTimeSpentMinutes(task.timeSpentMinutes),
        relativeStartOffset,
        rev,
        ...(revBy ? { revBy } : {}),
        ...(textDirection ? { textDirection } : {}),


        ...(hasValidPushCount || task.purgedAt ? {} : { pushCount: 0 }),
        cancelledAt: lifecycle.cancelledAt,
        completedAt: lifecycle.completedAt,
        ...lifecycle.focus,
    };


    if (next.isFocusedToday && isFutureStart(next, new Date(nowIso), temporal)) {
        if (next.status !== 'next') next.isFocusedToday = false;
        next.focusOrder = undefined;
    }


    return sameShallowRecord(task, next) ? task : next;
}
