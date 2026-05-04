import type { AppData, Area, Project, Task } from './types';
import { normalizeTaskForLoad } from './task-status';
import { SYNC_REPAIR_REV_BY } from './sync-types';

export const normalizeAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    settings: data.settings ?? {},
});

export const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

export const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidTimestamp = (value: unknown): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));

const normalizeOptionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const normalizeStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

type RevisionMetadata = {
    rev?: unknown;
    revBy?: unknown;
};

export const normalizeRevisionMetadata = <T extends RevisionMetadata>(item: T): T => {
    const normalized = { ...item };
    const rawRev = normalized.rev;
    if (
        typeof rawRev !== 'number'
        || !Number.isFinite(rawRev)
        || !Number.isInteger(rawRev)
        || rawRev < 0
    ) {
        delete normalized.rev;
    }
    const rawRevBy = normalized.revBy;
    if (typeof rawRevBy === 'string') {
        const trimmed = rawRevBy.trim();
        if (trimmed.length > 0) {
            normalized.revBy = trimmed;
        } else {
            delete normalized.revBy;
        }
    } else {
        delete normalized.revBy;
    }
    return normalized;
};

const normalizeProjectStatusForMerge = (value: unknown): Project['status'] => {
    if (value === 'active' || value === 'someday' || value === 'waiting' || value === 'archived') {
        return value;
    }
    if (typeof value === 'string') {
        const lowered = value.toLowerCase().trim();
        if (lowered === 'active' || lowered === 'someday' || lowered === 'waiting' || lowered === 'archived') {
            return lowered as Project['status'];
        }
    }
    return 'active';
};

export const normalizeTaskForSyncMerge = (task: Task, nowIso: string): Task => {
    const normalized = normalizeTaskForLoad(task, nowIso);
    return {
        ...normalized,
        tags: normalizeStringArray(normalized.tags),
        contexts: normalizeStringArray(normalized.contexts),
        sectionId: normalizeOptionalString(normalized.sectionId),
        isFocusedToday: normalized.isFocusedToday === true,
    };
};

export const normalizeProjectForSyncMerge = (project: Project): Project => {
    return {
        ...project,
        status: normalizeProjectStatusForMerge(project.status),
        color: normalizeOptionalString(project.color) ?? '#6B7280',
        tagIds: normalizeStringArray(project.tagIds),
        isSequential: project.isSequential === true,
        isFocused: project.isFocused === true,
        dueDate: normalizeOptionalString(project.dueDate),
        reviewAt: normalizeOptionalString(project.reviewAt),
        areaId: normalizeOptionalString(project.areaId),
        areaTitle: normalizeOptionalString(project.areaTitle),
    };
};

export type SyncMergeArea = Omit<Area, 'order'> & {
    order?: number;
    createdAt: string;
    updatedAt: string;
};

export const normalizeAreaForSyncMerge = (area: Area, nowIso: string): SyncMergeArea => {
    const createdAt = normalizeOptionalString(area.createdAt) ?? normalizeOptionalString(area.updatedAt) ?? nowIso;
    const updatedAt = normalizeOptionalString(area.updatedAt) ?? normalizeOptionalString(area.createdAt) ?? nowIso;
    return {
        ...area,
        color: normalizeOptionalString(area.color),
        icon: normalizeOptionalString(area.icon),
        order: Number.isFinite(area.order) ? area.order : undefined,
        createdAt,
        updatedAt,
    };
};

const hasDeletedAt = (value: { deletedAt?: string } | undefined): boolean => Boolean(value?.deletedAt);

const normalizeRepairRevision = (value?: number): number => (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : 0
);

const withRepairRevision = <T extends { rev?: number; revBy?: string }>(item: T): T => {
    const rev = normalizeRepairRevision(item.rev);
    return {
        ...item,
        rev: item.revBy === SYNC_REPAIR_REV_BY ? rev : rev + 1,
        revBy: SYNC_REPAIR_REV_BY,
    };
};

export const repairMergedSyncReferences = (data: AppData, nowIso: string): AppData => {
    const liveAreasById = new Map(
        data.areas
            .filter((area) => !hasDeletedAt(area))
            .map((area) => [area.id, area] as const)
    );
    const deletedAreaIds = new Set(
        data.areas
            .filter((area) => hasDeletedAt(area))
            .map((area) => area.id)
    );

    const repairedProjects = data.projects.map((project) => {
        const areaId = normalizeOptionalString(project.areaId);
        if (!areaId) {
            return areaId === project.areaId && project.areaTitle === normalizeOptionalString(project.areaTitle)
                ? project
                : {
                    ...project,
                    areaId,
                    areaTitle: normalizeOptionalString(project.areaTitle),
                };
        }
        const liveArea = liveAreasById.get(areaId);
        if (liveArea) {
            const areaTitle = normalizeOptionalString(liveArea.name);
            if (areaId === project.areaId && project.areaTitle === areaTitle) {
                return project;
            }
            return {
                ...withRepairRevision(project),
                areaId,
                areaTitle,
                updatedAt: nowIso,
            };
        }
        return {
            ...withRepairRevision(project),
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: nowIso,
        };
    });

    const liveProjectIds = new Set(
        repairedProjects
            .filter((project) => !hasDeletedAt(project))
            .map((project) => project.id)
    );
    const deletedProjectIds = new Set(
        repairedProjects
            .filter((project) => hasDeletedAt(project))
            .map((project) => project.id)
    );

    const repairedSections = data.sections.map((section) => {
        if (hasDeletedAt(section) || liveProjectIds.has(section.projectId) || !deletedProjectIds.has(section.projectId)) {
            return section;
        }
        return {
            ...withRepairRevision(section),
            deletedAt: nowIso,
            updatedAt: nowIso,
        };
    });

    const liveSections = new Map(
        repairedSections
            .filter((section) => !hasDeletedAt(section) && liveProjectIds.has(section.projectId))
            .map((section) => [section.id, section] as const)
    );

    const repairedTasks = data.tasks.map((task) => {
        const originalProjectId = normalizeOptionalString(task.projectId);
        const originalSectionId = normalizeOptionalString(task.sectionId);
        const originalAreaId = normalizeOptionalString(task.areaId);
        let nextProjectId = originalProjectId;
        let nextSectionId = originalSectionId;
        let nextAreaId = originalAreaId;
        let changed = false;

        if (nextProjectId && deletedProjectIds.has(nextProjectId)) {
            nextProjectId = undefined;
            nextSectionId = undefined;
            changed = true;
        }

        if (nextSectionId) {
            const section = liveSections.get(nextSectionId);
            if (!section) {
                nextSectionId = undefined;
                changed = true;
            } else if (!nextProjectId) {
                nextProjectId = section.projectId;
                nextAreaId = undefined;
                changed = true;
            } else if (section.projectId !== nextProjectId) {
                nextSectionId = undefined;
                changed = true;
            }
        }

        if (nextAreaId && (nextProjectId || deletedAreaIds.has(nextAreaId))) {
            nextAreaId = undefined;
            changed = true;
        }

        if (!changed) return task;

        return {
            ...withRepairRevision(task),
            projectId: nextProjectId,
            sectionId: nextSectionId,
            areaId: nextAreaId,
            ...(originalProjectId && !nextProjectId
                ? {
                    order: undefined,
                    orderNum: undefined,
                }
                : {}),
            updatedAt: nowIso,
        };
    });

    return {
        ...data,
        tasks: repairedTasks,
        projects: repairedProjects,
        sections: repairedSections,
    };
};

const validateRevisionFields = (
    item: Record<string, unknown>,
    label: string,
    index: number,
    errors: string[]
) => {
    const rev = item.rev;
    if (rev !== undefined) {
        if (typeof rev !== 'number' || !Number.isFinite(rev) || rev < 0 || !Number.isInteger(rev)) {
            errors.push(`${label}[${index}].rev must be a non-negative integer when present`);
        }
    }
    const revBy = item.revBy;
    if (revBy !== undefined && !isNonEmptyString(revBy)) {
        errors.push(`${label}[${index}].revBy must be a non-empty string when present`);
    }
};

const validateEntityShape = (
    items: unknown[],
    label: 'tasks' | 'projects' | 'sections',
    errors: string[]
) => {
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!isObjectRecord(item)) {
            errors.push(`${label}[${index}] must be an object`);
            continue;
        }
        if (!isNonEmptyString(item.id)) {
            errors.push(`${label}[${index}].id must be a non-empty string`);
        }
        if (item.createdAt !== undefined && !isNonEmptyString(item.createdAt)) {
            errors.push(`${label}[${index}].createdAt must be a non-empty string when present`);
        } else if (isNonEmptyString(item.createdAt) && !isValidTimestamp(item.createdAt)) {
            errors.push(`${label}[${index}].createdAt must be a valid ISO timestamp when present`);
        }
        if (!isNonEmptyString(item.updatedAt)) {
            errors.push(`${label}[${index}].updatedAt must be a non-empty string`);
        } else if (!isValidTimestamp(item.updatedAt)) {
            errors.push(`${label}[${index}].updatedAt must be a valid ISO timestamp`);
        }
        if (isValidTimestamp(item.createdAt) && isValidTimestamp(item.updatedAt)) {
            const createdMs = Date.parse(item.createdAt);
            const updatedMs = Date.parse(item.updatedAt);
            if (updatedMs < createdMs) {
                errors.push(`${label}[${index}].updatedAt must be greater than or equal to createdAt`);
            }
        }
        validateRevisionFields(item, label, index, errors);
    }
};

export const validateMergedSyncData = (data: AppData): string[] => {
    const errors: string[] = [];
    if (!Array.isArray(data.tasks)) errors.push('tasks must be an array');
    if (!Array.isArray(data.projects)) errors.push('projects must be an array');
    if (!Array.isArray(data.sections)) errors.push('sections must be an array');
    if (!Array.isArray(data.areas)) errors.push('areas must be an array');
    if (!isObjectRecord(data.settings)) errors.push('settings must be an object');

    if (Array.isArray(data.tasks)) validateEntityShape(data.tasks as unknown[], 'tasks', errors);
    if (Array.isArray(data.projects)) validateEntityShape(data.projects as unknown[], 'projects', errors);
    if (Array.isArray(data.sections)) validateEntityShape(data.sections as unknown[], 'sections', errors);
    if (Array.isArray(data.areas)) {
        for (let index = 0; index < data.areas.length; index += 1) {
            const area = data.areas[index] as unknown;
            if (!isObjectRecord(area)) {
                errors.push(`areas[${index}] must be an object`);
                continue;
            }
            if (!isNonEmptyString(area.id)) {
                errors.push(`areas[${index}].id must be a non-empty string`);
            }
            if (!isNonEmptyString(area.name)) {
                errors.push(`areas[${index}].name must be a non-empty string`);
            }
            if (!isNonEmptyString(area.createdAt)) {
                errors.push(`areas[${index}].createdAt must be a non-empty string`);
            } else if (!isValidTimestamp(area.createdAt)) {
                errors.push(`areas[${index}].createdAt must be a valid ISO timestamp`);
            }
            if (!isNonEmptyString(area.updatedAt)) {
                errors.push(`areas[${index}].updatedAt must be a non-empty string`);
            } else if (!isValidTimestamp(area.updatedAt)) {
                errors.push(`areas[${index}].updatedAt must be a valid ISO timestamp`);
            }
            if (isValidTimestamp(area.createdAt) && isValidTimestamp(area.updatedAt)) {
                const createdMs = Date.parse(area.createdAt);
                const updatedMs = Date.parse(area.updatedAt);
                if (updatedMs < createdMs) {
                    errors.push(`areas[${index}].updatedAt must be greater than or equal to createdAt`);
                }
            }
            validateRevisionFields(area, 'areas', index, errors);
        }
    }

    const deletedAreaIds = new Set(
        Array.isArray(data.areas)
            ? data.areas.filter((area) => isObjectRecord(area) && isNonEmptyString(area.deletedAt)).map((area) => String(area.id))
            : []
    );
    const deletedProjectIds = new Set(
        Array.isArray(data.projects)
            ? data.projects.filter((project) => isObjectRecord(project) && isNonEmptyString(project.deletedAt)).map((project) => String(project.id))
            : []
    );
    const liveSections = new Map(
        Array.isArray(data.sections)
            ? data.sections
                .filter((section) => isObjectRecord(section) && !isNonEmptyString(section.deletedAt))
                .map((section) => [String(section.id), section] as const)
            : []
    );
    const deletedSectionIds = new Set(
        Array.isArray(data.sections)
            ? data.sections
                .filter((section) => isObjectRecord(section) && isNonEmptyString(section.deletedAt))
                .map((section) => String(section.id))
            : []
    );

    if (Array.isArray(data.projects)) {
        data.projects.forEach((project, index) => {
            if (!isObjectRecord(project) || isNonEmptyString(project.deletedAt)) return;
            if (isNonEmptyString(project.areaId) && deletedAreaIds.has(project.areaId)) {
                errors.push(`projects[${index}].areaId must not reference a deleted area`);
            }
        });
    }

    if (Array.isArray(data.sections)) {
        data.sections.forEach((section, index) => {
            if (!isObjectRecord(section) || isNonEmptyString(section.deletedAt)) return;
            if (deletedProjectIds.has(String(section.projectId))) {
                errors.push(`sections[${index}].projectId must not reference a deleted project`);
            }
        });
    }

    if (Array.isArray(data.tasks)) {
        data.tasks.forEach((task, index) => {
            if (!isObjectRecord(task) || isNonEmptyString(task.deletedAt)) return;
            if (isNonEmptyString(task.projectId) && deletedProjectIds.has(task.projectId)) {
                errors.push(`tasks[${index}].projectId must not reference a deleted project`);
            }
            if (isNonEmptyString(task.areaId) && deletedAreaIds.has(task.areaId)) {
                errors.push(`tasks[${index}].areaId must not reference a deleted area`);
            }
            if (isNonEmptyString(task.sectionId)) {
                if (deletedSectionIds.has(task.sectionId)) {
                    errors.push(`tasks[${index}].sectionId must not reference a deleted section`);
                    return;
                }
                const section = liveSections.get(task.sectionId);
                if (!section) return;
                if (!isNonEmptyString(task.projectId)) {
                    errors.push(`tasks[${index}].projectId is required when sectionId is present`);
                    return;
                }
                if (String(section.projectId) !== task.projectId) {
                    errors.push(`tasks[${index}].sectionId must belong to the same projectId`);
                }
            }
        });
    }

    return errors;
};

export const validateSyncPayloadShape = (data: unknown, source: 'local' | 'remote'): string[] => {
    const errors: string[] = [];
    if (!isObjectRecord(data)) {
        errors.push(`${source} payload must be an object`);
        return errors;
    }
    const record = data as Record<string, unknown>;
    if (record.tasks !== undefined && !Array.isArray(record.tasks)) {
        errors.push(`${source} payload field "tasks" must be an array when present`);
    }
    if (record.projects !== undefined && !Array.isArray(record.projects)) {
        errors.push(`${source} payload field "projects" must be an array when present`);
    }
    if (record.sections !== undefined && !Array.isArray(record.sections)) {
        errors.push(`${source} payload field "sections" must be an array when present`);
    }
    if (record.areas !== undefined && !Array.isArray(record.areas)) {
        errors.push(`${source} payload field "areas" must be an array when present`);
    }
    if (record.settings !== undefined && !isObjectRecord(record.settings)) {
        errors.push(`${source} payload field "settings" must be an object when present`);
    }
    return errors;
};
