import type { Attachment, Project, Section, Task } from './types';
import { nextRevision } from './sync-revision';
import { SYNC_REPAIR_REV_BY } from './sync-types';

const SQLITE_NEUTRAL_FALSE_FIELDS = new Set([
    'showFutureRecurrence',
    'isFocusedToday',
    'suppressMindwtrReminders',
    'reminderPolicy',
    'isSequential',
    'isFocused',
    'isCollapsed',
]);

// normalizeTaskForLoad no longer backfills pushCount: 0 on purged tombstones
// (task-status.ts, fixed by 0642ab52e / #766), but rows persisted before that
// fix still carry a stored 0. Without this neutral-zero carve-out, those
// legacy rows re-flag as uncompacted and take a rev bump on every merge,
// which changes the sync fingerprint and re-triggers the next cycle forever.
const NEUTRAL_ZERO_FIELDS = new Set(['pushCount']);

const hasValuesOutsideCompactedTombstone = (
    value: Record<string, unknown>,
    compacted: Record<string, unknown>,
): boolean => Object.entries(value).some(([key, item]) => (
    item !== undefined
    // The SQLite row codec rehydrates absent columns as explicit null
    // (e.g. completedAtBeforeProjectArchive), and null ≡ missing everywhere
    // in sync. Without this, every SQL-loaded tombstone re-flags as
    // uncompacted and takes an uncounted rev bump per cycle — the #766
    // rev-only rewrite of every purged row that kept sync re-triggering
    // while tombstoneRepairs read 0 (the bump happened in the stats-discarding
    // pre-cycle merge, not the counted one).
    && !(item === null && compacted[key] === undefined)
    && !(item === false && compacted[key] === undefined && SQLITE_NEUTRAL_FALSE_FIELDS.has(key))
    && !(item === 0 && compacted[key] === undefined && NEUTRAL_ZERO_FIELDS.has(key))
    && JSON.stringify(item) !== JSON.stringify(compacted[key])
));

// Keep only conflict metadata plus neutral fields required by each entity schema.
export const compactPurgedTaskTombstone = (task: Task): Task => {
    if (!task.purgedAt) return task;
    return {
        id: task.id,
        title: '(deleted)',
        status: 'inbox',
        tags: [],
        contexts: [],
        rev: task.rev,
        revBy: task.revBy,
        createdAt: task.updatedAt,
        updatedAt: task.updatedAt,
        deletedAt: task.purgedAt,
        purgedAt: task.purgedAt,
    };
};

export const compactPurgedProjectTombstone = (project: Project): Project => {
    if (!project.purgedAt) return project;
    return {
        id: project.id,
        title: '(deleted)',
        status: 'active',
        color: '#6B7280',
        order: 0,
        tagIds: [],
        rev: project.rev,
        revBy: project.revBy,
        createdAt: project.updatedAt,
        updatedAt: project.updatedAt,
        deletedAt: project.purgedAt,
        purgedAt: project.purgedAt,
    };
};

export const compactPurgedProjectSectionTombstone = (
    section: Section,
    purgedAt: string,
): Section => ({
    id: section.id,
    projectId: section.projectId,
    title: '',
    order: 0,
    rev: section.rev,
    revBy: section.revBy,
    createdAt: purgedAt,
    updatedAt: purgedAt,
    deletedAt: purgedAt,
});

export const compactSectionsForPurgedProjects = (
    sections: readonly Section[],
    projects: readonly Project[],
    stampCompactionRevision = false,
): Section[] => {
    const purgedAtByProjectId = new Map(
        projects
            .filter((project): project is Project & { purgedAt: string } => Boolean(project.purgedAt))
            .map((project) => [project.id, project.purgedAt]),
    );
    return sections.map((section) => {
        const purgedAt = purgedAtByProjectId.get(section.projectId);
        if (!purgedAt) return section;
        const compacted = compactPurgedProjectSectionTombstone(section, purgedAt);
        if (!stampCompactionRevision || !hasValuesOutsideCompactedTombstone(
            section as unknown as Record<string, unknown>,
            compacted as unknown as Record<string, unknown>,
        )) return compacted;
        return {
            ...compacted,
            rev: nextRevision(section.rev),
            revBy: SYNC_REPAIR_REV_BY,
        };
    });
};

export const compactAttachmentCleanupMetadata = (
    attachments: readonly Attachment[] | undefined,
): Attachment[] | undefined => {
    const files = attachments
        ?.filter((attachment) => attachment.kind === 'file' && attachment.uri)
        .map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            title: '',
            uri: attachment.uri,
            createdAt: attachment.createdAt,
            updatedAt: attachment.updatedAt,
        }));
    return files?.length ? files : undefined;
};

export const compactPurgedTaskForLocalStorage = (task: Task): Task => (
    task.purgedAt
        ? {
            ...compactPurgedTaskTombstone(task),
            attachments: compactAttachmentCleanupMetadata(task.attachments),
        }
        : task
);

export const compactPurgedProjectForLocalStorage = (project: Project): Project => (
    project.purgedAt
        ? {
            ...compactPurgedProjectTombstone(project),
            attachments: compactAttachmentCleanupMetadata(project.attachments),
        }
        : project
);

export const hasUncompactedPurgedTaskTombstone = (
    task: Task,
    preserveLocalCleanupMetadata = false,
): boolean => {
    if (!task.purgedAt) return false;
    const localCompacted = compactPurgedTaskForLocalStorage(task);
    const compacted = preserveLocalCleanupMetadata
        || JSON.stringify(task.attachments) === JSON.stringify(localCompacted.attachments)
        ? localCompacted
        : compactPurgedTaskTombstone(task);
    return hasValuesOutsideCompactedTombstone(
        task as unknown as Record<string, unknown>,
        compacted as unknown as Record<string, unknown>,
    );
};

export const hasUncompactedPurgedProjectTombstone = (
    project: Project,
    preserveLocalCleanupMetadata = false,
): boolean => {
    if (!project.purgedAt) return false;
    const localCompacted = compactPurgedProjectForLocalStorage(project);
    const compacted = preserveLocalCleanupMetadata
        || JSON.stringify(project.attachments) === JSON.stringify(localCompacted.attachments)
        ? localCompacted
        : compactPurgedProjectTombstone(project);
    return hasValuesOutsideCompactedTombstone(
        project as unknown as Record<string, unknown>,
        compacted as unknown as Record<string, unknown>,
    );
};

export const hasUncompactedPurgedTombstones = (
    data: { tasks: readonly Task[]; projects: readonly Project[]; sections: readonly Section[] },
): boolean => {
    if (data.tasks.some((task) => hasUncompactedPurgedTaskTombstone(task))) return true;
    if (data.projects.some((project) => hasUncompactedPurgedProjectTombstone(project))) return true;

    const compactSections = compactSectionsForPurgedProjects(data.sections, data.projects);
    return data.sections.some((section, index) => (
        section !== compactSections[index]
        && hasValuesOutsideCompactedTombstone(
            section as unknown as Record<string, unknown>,
            compactSections[index] as unknown as Record<string, unknown>,
        )
    ));
};
