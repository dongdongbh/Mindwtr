import type { Task, TaskStatus } from './types';
import { normalizeRecurrenceForLoad } from './recurrence';

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

const LEGACY_STATUS_MAP: Record<string, TaskStatus> = {
    planned: 'next',
    pending: 'next',
    'in-progress': 'next',
    doing: 'next',
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
    const next: Task = {
        ...rest,
        createdAt: createdAtIso,
        updatedAt: updatedAtIso,
        status: normalizedStatus,
        projectId,
        areaId: resolvedAreaId,
        order: normalizedOrder,
        orderNum: normalizedOrder,
        recurrence: normalizeRecurrenceForLoad(task.recurrence),
        rev,
        ...(revBy ? { revBy } : {}),
        ...(textDirection ? { textDirection } : {}),
        ...(hasValidPushCount ? {} : { pushCount: 0 }),
    };

    if (normalizedStatus === 'done' || normalizedStatus === 'archived') {
        next.completedAt = task.completedAt || task.updatedAt || nowIso;
        next.isFocusedToday = false;
    } else if (task.completedAt) {
        next.completedAt = undefined;
    }

    return next;
}
