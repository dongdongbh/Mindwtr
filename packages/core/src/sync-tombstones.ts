import type { AppData, Attachment, Area, Person, Project, SavedFilter, Section, Task } from './types';
import { prunePendingRemoteAttachmentDeletes } from './attachment-cleanup';
import { isRestorableProjectArchiveSection } from './store-helpers';
import { logInfo } from './logger';

export const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;
const MIN_TOMBSTONE_RETENTION_DAYS = 1;
const MAX_TOMBSTONE_RETENTION_DAYS = 3650;

const resolveTombstoneRetentionDays = (value?: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_TOMBSTONE_RETENTION_DAYS;
    const rounded = Math.floor(value as number);
    return Math.min(MAX_TOMBSTONE_RETENTION_DAYS, Math.max(MIN_TOMBSTONE_RETENTION_DAYS, rounded));
};

const parseTimestampOrInfinity = (value?: unknown): number => {
    if (typeof value !== 'string' || !value) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export type EntityTombstoneKind = 'task' | 'project' | 'section' | 'area' | 'person';

export const isEntityTombstoneExpired = (
    kind: EntityTombstoneKind,
    entity: { deletedAt?: unknown; purgedAt?: unknown },
    cutoffMs: number,
): boolean => {
    if (typeof entity.deletedAt !== 'string' || !entity.deletedAt) return false;
    const deletedMs = parseTimestampOrInfinity(entity.deletedAt);
    if (kind === 'task' || kind === 'project') {
        const purgedMs = parseTimestampOrInfinity(entity.purgedAt);
        return (Number.isFinite(purgedMs) ? purgedMs : deletedMs) <= cutoffMs;
    }
    return deletedMs <= cutoffMs;
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

const pruneSavedFilterTombstones = (
    savedFilters: SavedFilter[] | undefined,
    cutoffMs: number
): { next: SavedFilter[] | undefined; removed: number } => {
    if (!savedFilters || savedFilters.length === 0) return { next: savedFilters, removed: 0 };
    let removed = 0;
    const next = savedFilters.filter((filter) => {
        if (!filter.deletedAt) return true;
        const deletedMs = parseTimestampOrInfinity(filter.deletedAt);
        if (deletedMs <= cutoffMs) {
            removed += 1;
            return false;
        }
        return true;
    });
    return {
        next,
        removed,
    };
};


export const ENTITY_FOREIGN_KEY_CHILDREN = {
    sections: [['tasks', 'sectionId']],
    projects: [['tasks', 'projectId'], ['sections', 'projectId']],
    areas: [['tasks', 'areaId'], ['projects', 'areaId']],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

type ReferencingCollections = { tasks: readonly Task[]; sections?: readonly Section[]; projects?: readonly Project[] };

const collectReferencedIds = (
    parent: keyof typeof ENTITY_FOREIGN_KEY_CHILDREN,
    remaining: ReferencingCollections,
): Set<string> => {
    const ids = new Set<string>();
    for (const [child, field] of ENTITY_FOREIGN_KEY_CHILDREN[parent]) {
        for (const item of remaining[child] ?? []) {
            const value = (item as unknown as Record<string, unknown>)[field];
            if (typeof value === 'string' && value) ids.add(value);
        }
    }
    return ids;
};

export type PurgeExpiredTombstonesOptions = {


    peerPurgedSectionIds?: ReadonlySet<string>;
};

export const purgeExpiredTombstones = (
    data: AppData,
    nowIso: string,
    retentionDays?: number,
    options: PurgeExpiredTombstonesOptions = {}
): {
    data: AppData;
    removedTaskTombstones: number;
    removedProjectTombstones: number;
    removedSectionTombstones: number;
    removedAreaTombstones: number;
    removedPersonTombstones: number;
    removedAttachmentTombstones: number;
    removedSavedFilterTombstones: number;
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
            removedPersonTombstones: 0,
            removedAttachmentTombstones: 0,
            removedSavedFilterTombstones: 0,
            removedPendingRemoteDeletes: 0,
        };
    }
    const keepDays = resolveTombstoneRetentionDays(retentionDays);
    const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;

    let removedTaskTombstones = 0;
    let removedProjectTombstones = 0;
    let removedSectionTombstones = 0;
    let removedAreaTombstones = 0;
    let removedPersonTombstones = 0;
    let removedAttachmentTombstones = 0;
    let removedSavedFilterTombstones = 0;
    let retainedExpiredArchiveSections = 0;
    const nextTasks: Task[] = [];
    for (const task of data.tasks) {
        if (isEntityTombstoneExpired('task', task, cutoffMs)) {
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


    const restorableArchivedProjectIds = new Set(
        data.projects.filter((project) => (
            project.status === 'archived'
            && !project.purgedAt
            && !isEntityTombstoneExpired('project', project, cutoffMs)
        )).map((project) => project.id),
    );
    const referencedSectionIds = collectReferencedIds('sections', { tasks: nextTasks });
    const nextSections: Section[] = [];
    for (const section of data.sections) {
        if (isEntityTombstoneExpired('section', section, cutoffMs)) {
            if (restorableArchivedProjectIds.has(section.projectId)
                && isRestorableProjectArchiveSection(section)
                && !options.peerPurgedSectionIds?.has(section.id)) {
                retainedExpiredArchiveSections += 1;
                nextSections.push(section);
                continue;
            }
            if (!referencedSectionIds.has(section.id)) {
                removedSectionTombstones += 1;
                continue;
            }
        }
        nextSections.push(section);
    }
    if (retainedExpiredArchiveSections > 0) {
        logInfo('Expired archived project sections retained during tombstone cleanup', {
            scope: 'sync',
            category: 'storage',
            context: {
                releaseCheck: 'v1.3.1/archive-section-retention',
                retainedSectionCount: retainedExpiredArchiveSections,
            },
        });
    }

    const referencedProjectIds = collectReferencedIds('projects', { tasks: nextTasks, sections: nextSections });
    const nextProjects: Project[] = [];
    for (const project of data.projects) {
        if (isEntityTombstoneExpired('project', project, cutoffMs) && !referencedProjectIds.has(project.id)) {
            removedProjectTombstones += 1;
            continue;
        }
        const pruned = pruneAttachmentTombstones(project.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        nextProjects.push(pruned.removed > 0 ? { ...project, attachments: pruned.next } : project);
    }

    const referencedAreaIds = collectReferencedIds('areas', { tasks: nextTasks, projects: nextProjects });
    const nextAreas: Area[] = [];
    for (const area of data.areas) {
        if (isEntityTombstoneExpired('area', area, cutoffMs) && !referencedAreaIds.has(area.id)) {
            removedAreaTombstones += 1;
            continue;
        }
        nextAreas.push(area);
    }
    const nextPeople: Person[] = [];
    for (const person of data.people ?? []) {
        if (isEntityTombstoneExpired('person', person, cutoffMs)) {
            removedPersonTombstones += 1;
            continue;
        }
        nextPeople.push(person);
    }

    let nextSettings = data.settings;
    const savedFilterPrune = pruneSavedFilterTombstones(data.settings.savedFilters, cutoffMs);
    removedSavedFilterTombstones = savedFilterPrune.removed;
    if (removedSavedFilterTombstones > 0) {
        nextSettings = {
            ...data.settings,
            savedFilters: savedFilterPrune.next,
        };
    }
    const pendingRemoteDeletes = data.settings.attachments?.pendingRemoteDeletes;
    const nextPendingRemoteDeletes = prunePendingRemoteAttachmentDeletes(pendingRemoteDeletes, nowIso);
    const removedPendingRemoteDeletes = Math.max(
        0,
        (pendingRemoteDeletes?.length ?? 0) - nextPendingRemoteDeletes.length,
    );
    if (removedPendingRemoteDeletes > 0) {
        nextSettings = {
            ...nextSettings,
            attachments: {
                ...nextSettings.attachments,
                pendingRemoteDeletes: nextPendingRemoteDeletes.length > 0
                    ? nextPendingRemoteDeletes
                    : undefined,
            },
        };
    }

    return {
        data: {
            ...data,
            tasks: nextTasks,
            projects: nextProjects,
            sections: nextSections,
            areas: nextAreas,
            people: nextPeople,
            settings: nextSettings,
        },
        removedTaskTombstones,
        removedProjectTombstones,
        removedSectionTombstones,
        removedAreaTombstones,
        removedPersonTombstones,
        removedAttachmentTombstones,
        removedSavedFilterTombstones,
        removedPendingRemoteDeletes,
    };
};
