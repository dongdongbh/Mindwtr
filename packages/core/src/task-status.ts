import type { Task, TaskStatus } from './types';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeRepeatReminderMinutes } from './schedule-utils';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { preserveShallowIdentity, sameShallowRecord } from './shallow-identity';
import { safeParseDate } from './date';

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

/**
 * A task is "finished" once it is done or archived — the two statuses a
 * completed task can settle into (#968: a gate checking only 'done' misses
 * archived rows). Accepts either a task-like object or a bare status so
 * callers can pass whichever they already have in hand.
 */
export function isTaskFinished(taskOrStatus: { status?: TaskStatus } | TaskStatus | undefined): boolean {
    const status = typeof taskOrStatus === 'string' ? taskOrStatus : taskOrStatus?.status;
    return status === 'done' || status === 'archived';
}

/**
 * A task is "actionable" unless it is done, archived, or reference — the
 * three statuses that take a task out of active GTD workflow lists.
 */
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

const isFutureStart = (task: Pick<Task, 'startTime'>, now: Date): boolean => {
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

export function normalizeTaskForLoad(task: Task, nowIso: string = new Date().toISOString()): Task {
    const normalizedStatus = normalizeTaskStatus((task as any).status);
    const { rev: _legacyRev, revBy: _legacyRevBy, ...rest } = task as Task & { rev?: unknown; revBy?: unknown };

    let createdAtIso = typeof task.createdAt === 'string' ? task.createdAt : nowIso;
    const createdAtMs = Date.parse(createdAtIso);
    if (!Number.isFinite(createdAtMs)) {
        createdAtIso = nowIso;
    }
    let updatedAtIso = typeof task.updatedAt === 'string' ? task.updatedAt : createdAtIso;
    const updatedAtMs = Date.parse(updatedAtIso);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs < Date.parse(createdAtIso)) {
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
        timeSpentMinutes: normalizeTimeSpentMinutes(task.timeSpentMinutes),
        relativeStartOffset,
        rev,
        ...(revBy ? { revBy } : {}),
        ...(textDirection ? { textDirection } : {}),
        // Purged tombstones stay in their compacted shape: backfilling
        // pushCount: 0 here while the merge normalizers strip it again made
        // every loaded tombstone differ from its merged twin, so each sync
        // cycle rewrote every purged row and requeued itself (#766 — the
        // content-oscillation sibling of the rev-bump loop fixed earlier;
        // stats.tombstoneRepairs stayed 0 because rev never changed).
        ...(hasValidPushCount || task.purgedAt ? {} : { pushCount: 0 }),
    };

    // focusOrder only means something while a task is in Today's Focus
    // (types.ts: "cleared when the task leaves Today's Focus"). Both branches
    // below force isFocusedToday false, so focusOrder must be cleared with it
    // — this runs on every load/merge without a rev bump (the established
    // pattern for isFocusedToday here), so it must stay idempotent.
    if (normalizedStatus === 'done' || normalizedStatus === 'archived') {
        next.completedAt = task.completedAt || task.updatedAt || nowIso;
        next.isFocusedToday = false;
        next.focusOrder = undefined;
    } else if (next.isFocusedToday && isFutureStart(next, new Date(nowIso))) {
        next.isFocusedToday = false;
        next.focusOrder = undefined;
    } else if (task.completedAt) {
        next.completedAt = undefined;
    }

    // Hand back the input when nothing actually changed, so an already-normalized
    // task keeps its identity through the merge normalizers (#766 — see
    // shallow-identity.ts). The time-dependent branches above naturally produce a
    // differing object on the cycle they fire, so this stays a pure no-change check.
    return sameShallowRecord(task, next) ? task : next;
}
