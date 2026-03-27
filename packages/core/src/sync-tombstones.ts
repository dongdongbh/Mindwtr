import type { AppData, Attachment, Project, Task } from './types';

const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;
const MIN_TOMBSTONE_RETENTION_DAYS = 1;
const MAX_TOMBSTONE_RETENTION_DAYS = 3650;

const resolveTombstoneRetentionDays = (value?: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_TOMBSTONE_RETENTION_DAYS;
    const rounded = Math.floor(value as number);
    return Math.min(MAX_TOMBSTONE_RETENTION_DAYS, Math.max(MIN_TOMBSTONE_RETENTION_DAYS, rounded));
};

const parseTimestampOrInfinity = (value?: string): number => {
    if (!value) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const pruneAttachmentTombstones = (
    attachments: Attachment[] | undefined,
    cutoffMs: number
): { next: Attachment[] | undefined; removed: number } => {
    if (!attachments || attachments.length === 0) return { next: attachments, removed: 0 };
    let removed = 0;
    const next = attachments.filter((attachment) => {
        if (!attachment.deletedAt) return true;
        const deletedMs = parseTimestampOrInfinity(attachment.deletedAt);
        if (deletedMs <= cutoffMs) {
            removed += 1;
            return false;
        }
        return true;
    });
    return {
        next: next.length > 0 ? next : undefined,
        removed,
    };
};

export const purgeExpiredTombstones = (
    data: AppData,
    nowIso: string,
    retentionDays?: number
): {
    data: AppData;
    removedTaskTombstones: number;
    removedAttachmentTombstones: number;
    removedPendingRemoteDeletes: number;
} => {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
        return { data, removedTaskTombstones: 0, removedAttachmentTombstones: 0, removedPendingRemoteDeletes: 0 };
    }
    const keepDays = resolveTombstoneRetentionDays(retentionDays);
    const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;

    let removedTaskTombstones = 0;
    let removedAttachmentTombstones = 0;
    const nextTasks: Task[] = [];
    for (const task of data.tasks) {
        const tombstoneAt = task.purgedAt ? parseTimestampOrInfinity(task.purgedAt) : Number.POSITIVE_INFINITY;
        if (task.deletedAt && task.purgedAt && tombstoneAt <= cutoffMs) {
            removedTaskTombstones += 1;
            continue;
        }
        const pruned = pruneAttachmentTombstones(task.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        if (pruned.removed > 0) {
            nextTasks.push({ ...task, attachments: pruned.next });
            continue;
        }
        nextTasks.push(task);
    }

    const nextProjects: Project[] = data.projects.map((project) => {
        const pruned = pruneAttachmentTombstones(project.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        return pruned.removed > 0 ? { ...project, attachments: pruned.next } : project;
    });
    const previousPendingRemoteDeletes = data.settings.attachments?.pendingRemoteDeletes;
    let removedPendingRemoteDeletes = 0;
    const nextPendingRemoteDeletes = previousPendingRemoteDeletes?.filter((entry) => {
        const lastErrorMs = parseTimestampOrInfinity(entry.lastErrorAt);
        const expired = Number.isFinite(lastErrorMs) && lastErrorMs <= cutoffMs;
        if (expired) {
            removedPendingRemoteDeletes += 1;
            return false;
        }
        return true;
    });
    const hasPendingChanged = removedPendingRemoteDeletes > 0;
    const nextSettings = hasPendingChanged
        ? {
            ...data.settings,
            attachments: {
                ...data.settings.attachments,
                pendingRemoteDeletes: nextPendingRemoteDeletes && nextPendingRemoteDeletes.length > 0
                    ? nextPendingRemoteDeletes
                    : undefined,
            },
        }
        : data.settings;

    return {
        data: {
            ...data,
            tasks: nextTasks,
            projects: nextProjects,
            settings: nextSettings,
        },
        removedTaskTombstones,
        removedAttachmentTombstones,
        removedPendingRemoteDeletes,
    };
};
