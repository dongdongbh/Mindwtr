import type { Project, Section, Task } from './types';
import { nextRevision } from './sync-revision';
import { normalizeCancellationTimestamp } from './task-status';

export const isArchiveRetentionDays = (days: unknown): days is number =>
    typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 36500;

const DAY_MS = 24 * 60 * 60 * 1000;

const archiveTime = (value: unknown): number => {
    const timestamp = normalizeCancellationTimestamp(value);
    return timestamp ? Date.parse(timestamp) : NaN;
};

export const hasValidArchiveClock = (value: unknown): boolean => Number.isFinite(archiveTime(value));

export type ArchiveRetentionPreview = {
    taskIds: string[];
    projectIds: string[];
    sectionIds: string[];
    legacyTaskIds: string[];
    legacyProjectIds: string[];
};

const emptyPreview = (): ArchiveRetentionPreview => ({
    taskIds: [], projectIds: [], sectionIds: [], legacyTaskIds: [], legacyProjectIds: [],
});

/** IDs are only a preview. The store recomputes this selection inside its write. */
export const getArchiveRetentionPreview = (
    data: { tasks: Task[]; projects: Project[]; sections: Section[] },
    days: number,
    nowMs = Date.now(),
): ArchiveRetentionPreview => {
    const result = emptyPreview();
    if (!isArchiveRetentionDays(days) || days === 0 || !Number.isFinite(nowMs)) return result;
    const cutoff = nowMs - days * DAY_MS;
    const sectionsById = new Map(data.sections.map((section) => [section.id, section]));
    const sectionsByProject = new Map<string, Section[]>();
    for (const section of data.sections) {
        const group = sectionsByProject.get(section.projectId) ?? [];
        group.push(section);
        sectionsByProject.set(section.projectId, group);
    }
    const tasksByProject = new Map<string, Task[]>();
    const standalone: Task[] = [];
    for (const task of data.tasks) {
        if (task.purgedAt) continue;
        const sectionProjectId = task.sectionId ? sectionsById.get(task.sectionId)?.projectId : undefined;
        const ownerIds = new Set([task.projectId, sectionProjectId].filter((id): id is string => Boolean(id)));
        if (ownerIds.size) {
            for (const ownerId of ownerIds) {
                const group = tasksByProject.get(ownerId) ?? [];
                group.push(task);
                tasksByProject.set(ownerId, group);
            }
        } else if (!task.projectId && !task.sectionId) {
            standalone.push(task);
        }
    }
    const oldEnough = (record: { archivedAt?: string; updatedAt: string }): boolean =>
        archiveTime(record.archivedAt) <= cutoff && archiveTime(record.updatedAt) <= cutoff;

    for (const task of data.tasks) {
        if (!task.deletedAt && !task.purgedAt && task.status === 'archived'
            && !hasValidArchiveClock(task.archivedAt)) result.legacyTaskIds.push(task.id);
    }

    for (const task of standalone) {
        if (task.status !== 'archived' || task.deletedAt) continue;
        if (oldEnough(task)) result.taskIds.push(task.id);
    }
    for (const project of data.projects) {
        if (project.status !== 'archived' || project.deletedAt || project.purgedAt) continue;
        if (!hasValidArchiveClock(project.archivedAt)) result.legacyProjectIds.push(project.id);
        const sections = sectionsByProject.get(project.id) ?? [];
        const children = tasksByProject.get(project.id) ?? [];
        for (const child of children) {
            if (!child.deletedAt && ['archived', 'done', 'reference'].includes(child.status)
                && !hasValidArchiveClock(child.archivedAt)) result.legacyTaskIds.push(child.id);
        }
        if (!oldEnough(project) || sections.some((section) =>
            !section.deletedAt || !section.projectArchivedAt || !(archiveTime(section.updatedAt) <= cutoff)
        ) || children.some((child) =>
            child.deletedAt || (child.projectId && child.projectId !== project.id)
            || (child.sectionId && sectionsById.get(child.sectionId)?.projectId !== project.id)
            || !['archived', 'done', 'reference'].includes(child.status) || !oldEnough(child)
        )) continue;
        result.projectIds.push(project.id);
        // One push per id: QuickJS (native Android) refuses a call with more than 65535 arguments.
        for (const section of sections) result.sectionIds.push(section.id);
        for (const child of children) result.taskIds.push(child.id);
    }
    result.taskIds = [...new Set(result.taskIds)];
    result.legacyTaskIds = [...new Set(result.legacyTaskIds)];
    return result;
};

export const backfillArchiveClocks = (
    data: { tasks: Task[]; projects: Project[] },
    preview: ArchiveRetentionPreview,
    now: string,
    deviceId: string,
): { tasks: Task[]; projects: Project[] } => {
    const taskIds = new Set(preview.legacyTaskIds);
    const projectIds = new Set(preview.legacyProjectIds);
    return {
        tasks: taskIds.size ? data.tasks.map((task) => taskIds.has(task.id)
            ? { ...task, archivedAt: now, updatedAt: now, rev: nextRevision(task.rev), revBy: deviceId }
            : task) : data.tasks,
        projects: projectIds.size ? data.projects.map((project) => projectIds.has(project.id)
            ? { ...project, archivedAt: now, updatedAt: now, rev: nextRevision(project.rev), revBy: deviceId }
            : project) : data.projects,
    };
};
