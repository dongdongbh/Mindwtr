import type { AppData, Attachment, Area, Project, Section, Task } from './types';

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

const getTaskTombstoneTimestamp = (task: Task): number => {
    if (!task.deletedAt) return Number.POSITIVE_INFINITY;
    const purgedMs = parseTimestampOrInfinity(task.purgedAt);
    if (Number.isFinite(purgedMs)) return purgedMs;
    return parseTimestampOrInfinity(task.deletedAt);
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
    removedProjectTombstones: number;
    removedSectionTombstones: number;
    removedAreaTombstones: number;
    removedAttachmentTombstones: number;
    removedPendingRemoteDeletes: number;
} => {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
        return {
            data,
            removedTaskTombstones: 0,
            removedProjectTombstones: 0,
            removedSectionTombstones: 0,
            removedAreaTombstones: 0,
            removedAttachmentTombstones: 0,
            removedPendingRemoteDeletes: 0,
        };
    }
    const keepDays = resolveTombstoneRetentionDays(retentionDays);
    const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;

    let removedTaskTombstones = 0;
    let removedProjectTombstones = 0;
    let removedSectionTombstones = 0;
    let removedAreaTombstones = 0;
    let removedAttachmentTombstones = 0;
    const nextTasks: Task[] = [];
    for (const task of data.tasks) {
        const tombstoneAt = getTaskTombstoneTimestamp(task);
        if (task.deletedAt && tombstoneAt <= cutoffMs) {
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

    const nextProjects: Project[] = [];
    for (const project of data.projects) {
        const deletedMs = parseTimestampOrInfinity(project.deletedAt);
        if (project.deletedAt && deletedMs <= cutoffMs) {
            removedProjectTombstones += 1;
            continue;
        }
        const pruned = pruneAttachmentTombstones(project.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        nextProjects.push(pruned.removed > 0 ? { ...project, attachments: pruned.next } : project);
    }
    const nextSections: Section[] = [];
    for (const section of data.sections) {
        const deletedMs = parseTimestampOrInfinity(section.deletedAt);
        if (section.deletedAt && deletedMs <= cutoffMs) {
            removedSectionTombstones += 1;
            continue;
        }
        nextSections.push(section);
    }
    const nextAreas: Area[] = [];
    for (const area of data.areas) {
        const deletedMs = parseTimestampOrInfinity(area.deletedAt);
        if (area.deletedAt && deletedMs <= cutoffMs) {
            removedAreaTombstones += 1;
            continue;
        }
        nextAreas.push(area);
    }
    return {
        data: {
            ...data,
            tasks: nextTasks,
            projects: nextProjects,
            sections: nextSections,
            areas: nextAreas,
            settings: data.settings,
        },
        removedTaskTombstones,
        removedProjectTombstones,
        removedSectionTombstones,
        removedAreaTombstones,
        removedAttachmentTombstones,
        removedPendingRemoteDeletes: 0,
    };
};
