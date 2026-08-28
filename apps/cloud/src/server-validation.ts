import {
    filterNotDeleted,
    normalizeRecurrenceForLoad,
    normalizeRelativeStartOffset,
    normalizeRepeatReminderMinutes,
    normalizeTimeSpentMinutes,
    filterTasksBySearch,
    taskMatchesQuery,
    TASK_SORT_BY_VALUE_SET,
    TASK_STATUS_VALUES,
    type Area,
    type AppData,
    type Project,
    type Section,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
// Relative path (not '@mindwtr/core/...'): TASK_RECURRENCE_FIELD_KEYS is the shared home for
// the recurrence object's field-key allowlist (see that file's header). This file isn't part
// of the native-schema CI job's zero-install import chain, but the relative path is harmless
// here and keeps the pattern consistent with task-sync-schema.ts's sibling imports below.
import { TASK_RECURRENCE_FIELD_KEYS } from '../../../packages/core/src/task-recurrence-fields';
import {
    CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_AREA_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS,
    MAX_ITEMS_PER_COLLECTION,
    MAX_PENDING_REMOTE_DELETE_ATTEMPTS,
} from './server-config';
import { normalizeAttachmentRelativePath } from './server-storage';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasOwnField = (value: object, field: PropertyKey): boolean => (
    Object.prototype.hasOwnProperty.call(value, field)
);

const CLOUD_RECURRENCE_ALLOWED_KEYS = new Set(TASK_RECURRENCE_FIELD_KEYS);

function validateTaskRepeatReminderMinutes(value: Record<string, unknown>): string | null {
    if (!hasOwnField(value, 'repeatReminderMinutes')) return null;
    const minutes = value.repeatReminderMinutes;
    if (minutes === undefined || minutes === null || minutes === 0) return null;
    if (normalizeRepeatReminderMinutes(minutes) === minutes) return null;
    return 'Invalid task repeatReminderMinutes';
}

function validateTaskTimeSpentMinutes(value: Record<string, unknown>): string | null {
    if (!hasOwnField(value, 'timeSpentMinutes')) return null;
    const minutes = value.timeSpentMinutes;
    if (minutes === undefined || minutes === null || minutes === 0) return null;
    if (normalizeTimeSpentMinutes(minutes) === minutes) return null;
    return 'Invalid task timeSpentMinutes';
}

function validateTaskRelativeStartOffset(value: Record<string, unknown>): string | null {
    if (!hasOwnField(value, 'relativeStartOffset')) return null;
    const offset = value.relativeStartOffset;
    if (offset === undefined || offset === null) return null;
    if (!isRecord(offset)) return 'Invalid task relativeStartOffset';
    const invalidKeys = Object.keys(offset).filter((key) => key !== 'amount' && key !== 'unit');
    if (invalidKeys.length > 0) return `Unsupported task relativeStartOffset fields: ${invalidKeys.slice(0, 10).join(', ')}`;
    const normalized = normalizeRelativeStartOffset(offset);
    if (!normalized || normalized.amount !== offset.amount || normalized.unit !== offset.unit) {
        return 'Invalid task relativeStartOffset';
    }
    return null;
}

function isSameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function validateTaskRecurrence(value: Record<string, unknown>): string | null {
    if (!hasOwnField(value, 'recurrence')) return null;
    const recurrence = value.recurrence;
    if (recurrence === undefined || recurrence === null) return null;
    if (typeof recurrence === 'string') {
        return normalizeRecurrenceForLoad(recurrence) ? null : 'Invalid task recurrence';
    }
    if (!isRecord(recurrence)) return 'Invalid task recurrence';
    const invalidKeys = Object.keys(recurrence).filter((key) => !CLOUD_RECURRENCE_ALLOWED_KEYS.has(key));
    if (invalidKeys.length > 0) return `Unsupported task recurrence fields: ${invalidKeys.slice(0, 10).join(', ')}`;
    const normalized = normalizeRecurrenceForLoad(recurrence);
    if (!normalized) return 'Invalid task recurrence';
    const normalizedRecord = normalized as unknown as Record<string, unknown>;
    for (const key of Object.keys(recurrence)) {
        if (!isSameJsonValue(recurrence[key], normalizedRecord[key])) return 'Invalid task recurrence';
    }
    return null;
}

function validateTaskViewSectionIds(value: Record<string, unknown>): string | null {
    if (!hasOwnField(value, 'viewSectionIds')) return null;
    const ids = value.viewSectionIds;
    if (ids === undefined || ids === null) return null;
    if (!isRecord(ids)) return 'Invalid task viewSectionIds';
    return Object.values(ids).every((sectionId) => typeof sectionId === 'string')
        ? null
        : 'Invalid task viewSectionIds';
}

function validateTaskPropValues(value: Record<string, unknown>): string | null {
    return validateTaskRepeatReminderMinutes(value)
        ?? validateTaskTimeSpentMinutes(value)
        ?? validateTaskRelativeStartOffset(value)
        ?? validateTaskRecurrence(value)
        ?? validateTaskViewSectionIds(value);
}

function validateProjectPropValues(value: Record<string, unknown>): string | null {
    if (!hasOwnField(value, 'taskSortBy')) return null;
    const taskSortBy = value.taskSortBy;
    if (taskSortBy === undefined || taskSortBy === null) return null;
    if (typeof taskSortBy === 'string'
        && TASK_SORT_BY_VALUE_SET.has(taskSortBy as NonNullable<Project['taskSortBy']>)) {
        return null;
    }
    return 'Invalid project taskSortBy';
}

function isValidIsoTimestamp(value: unknown): boolean {
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}

export function validateAppData(
    value: unknown
): { ok: true; data: AppData } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid data: expected an object' };
    const tasks = value.tasks;
    const projects = value.projects;
    const sections = value.sections;
    const settings = value.settings;
    const areas = value.areas;
    const people = value.people;

    if (!Array.isArray(tasks)) return { ok: false, error: 'Invalid data: tasks must be an array' };
    if (!Array.isArray(projects)) return { ok: false, error: 'Invalid data: projects must be an array' };
    if (sections !== undefined && !Array.isArray(sections)) return { ok: false, error: 'Invalid data: sections must be an array' };
    if (areas !== undefined && !Array.isArray(areas)) return { ok: false, error: 'Invalid data: areas must be an array' };
    if (people !== undefined && !Array.isArray(people)) return { ok: false, error: 'Invalid data: people must be an array' };
    if (settings !== undefined && !isRecord(settings)) return { ok: false, error: 'Invalid data: settings must be an object' };
    if (tasks.length > MAX_ITEMS_PER_COLLECTION) return { ok: false, error: `Invalid data: tasks exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    if (projects.length > MAX_ITEMS_PER_COLLECTION) return { ok: false, error: `Invalid data: projects exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    if (Array.isArray(sections) && sections.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: sections exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }
    if (Array.isArray(areas) && areas.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: areas exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }
    if (Array.isArray(people) && people.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: people exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }

    for (const task of tasks) {
        if (!isRecord(task) || typeof task.id !== 'string' || typeof task.title !== 'string') {
            return { ok: false, error: 'Invalid data: each task must be an object with string id and title' };
        }
        if (task.id.trim().length === 0 || task.title.trim().length === 0) {
            return { ok: false, error: 'Invalid data: each task must include non-empty id and title' };
        }
        if (typeof task.status !== 'string' || !(TASK_STATUS_VALUES as readonly string[]).includes(task.status)) {
            return { ok: false, error: 'Invalid data: task status must be a valid value' };
        }
        if (!isValidIsoTimestamp(task.createdAt) || !isValidIsoTimestamp(task.updatedAt)) {
            return { ok: false, error: 'Invalid data: task createdAt/updatedAt must be valid ISO timestamps' };
        }
        if (task.deletedAt != null && !isValidIsoTimestamp(task.deletedAt)) {
            return { ok: false, error: 'Invalid data: task deletedAt must be a valid ISO timestamp when present' };
        }
        const valueError = validateTaskPropValues(task);
        if (valueError) {
            return { ok: false, error: `Invalid data: task ${String(task.id)}: ${valueError}` };
        }
    }

    for (const project of projects) {
        if (!isRecord(project) || typeof project.id !== 'string' || typeof project.title !== 'string') {
            return { ok: false, error: 'Invalid data: each project must be an object with string id and title' };
        }
        if (project.id.trim().length === 0 || project.title.trim().length === 0) {
            return { ok: false, error: 'Invalid data: each project must include non-empty id and title' };
        }
        if (typeof project.status !== 'string' || !['active', 'someday', 'waiting', 'archived'].includes(project.status)) {
            return { ok: false, error: 'Invalid data: project status must be a valid value' };
        }
        if (!isValidIsoTimestamp(project.createdAt) || !isValidIsoTimestamp(project.updatedAt)) {
            return { ok: false, error: 'Invalid data: project createdAt/updatedAt must be valid ISO timestamps' };
        }
        if (project.deletedAt != null && !isValidIsoTimestamp(project.deletedAt)) {
            return { ok: false, error: 'Invalid data: project deletedAt must be a valid ISO timestamp when present' };
        }
        if (project.purgedAt != null && !isValidIsoTimestamp(project.purgedAt)) {
            return { ok: false, error: 'Invalid data: project purgedAt must be a valid ISO timestamp when present' };
        }
        const valueError = validateProjectPropValues(project);
        if (valueError) {
            return { ok: false, error: `Invalid data: project ${String(project.id)}: ${valueError}` };
        }
    }

    const projectsById = new Map<string, Record<string, unknown>>();
    const activeProjectIds = new Set<string>();
    for (const project of projects) {
        const projectRecord = project as Record<string, unknown>;
        const projectId = String(projectRecord.id);
        projectsById.set(projectId, projectRecord);
        if (projectRecord.deletedAt == null) {
            activeProjectIds.add(projectId);
        }
    }

    if (Array.isArray(sections)) {
        const sectionsById = new Map<string, Record<string, unknown>>();
        const activeSectionIds = new Set<string>();
        for (const section of sections) {
            if (!isRecord(section) || typeof section.id !== 'string' || typeof section.projectId !== 'string' || typeof section.title !== 'string') {
                return { ok: false, error: 'Invalid data: each section must be an object with string id, projectId, and title' };
            }
            if (!isValidIsoTimestamp(section.createdAt) || !isValidIsoTimestamp(section.updatedAt)) {
                return { ok: false, error: 'Invalid data: section createdAt/updatedAt must be valid ISO timestamps' };
            }
            if (section.deletedAt != null && !isValidIsoTimestamp(section.deletedAt)) {
                return { ok: false, error: 'Invalid data: section deletedAt must be a valid ISO timestamp when present' };
            }
            sectionsById.set(section.id, section);
            if (section.deletedAt == null) {
                activeSectionIds.add(section.id);
                if (!activeProjectIds.has(section.projectId)) {
                    return { ok: false, error: `Invalid data: live section ${section.id} references missing or deleted project ${section.projectId}` };
                }
            }
        }

        for (const task of tasks) {
            const taskRecord = task as Record<string, unknown>;
            if (taskRecord.deletedAt != null) continue;
            const projectId = typeof taskRecord.projectId === 'string' ? taskRecord.projectId.trim() : '';
            const sectionId = typeof taskRecord.sectionId === 'string' ? taskRecord.sectionId.trim() : '';
            if (projectId && !activeProjectIds.has(projectId)) {
                return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted project ${projectId}` };
            }
            if (sectionId) {
                if (!projectId) {
                    return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} must include projectId when sectionId is present` };
                }
                if (!activeSectionIds.has(sectionId)) {
                    return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted section ${sectionId}` };
                }
                const section = sectionsById.get(sectionId);
                const sectionProjectId = typeof section?.projectId === 'string' ? section.projectId : '';
                if (sectionProjectId !== projectId) {
                    return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} section ${sectionId} belongs to project ${sectionProjectId}` };
                }
            }
        }
    } else {
        for (const task of tasks) {
            const taskRecord = task as Record<string, unknown>;
            if (taskRecord.deletedAt != null) continue;
            const projectId = typeof taskRecord.projectId === 'string' ? taskRecord.projectId.trim() : '';
            const sectionId = typeof taskRecord.sectionId === 'string' ? taskRecord.sectionId.trim() : '';
            if (projectId && !activeProjectIds.has(projectId)) {
                return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted project ${projectId}` };
            }
            if (sectionId) {
                return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references section ${sectionId} but sections are missing` };
            }
        }
    }

    const activeAreaIds = new Set<string>();
    if (Array.isArray(areas)) {
        for (const area of areas) {
            if (!isRecord(area) || typeof area.id !== 'string' || typeof area.name !== 'string') {
                return { ok: false, error: 'Invalid data: each area must be an object with string id and name' };
            }
            if (!isValidIsoTimestamp(area.createdAt)) {
                return { ok: false, error: 'Invalid data: area createdAt must be a valid ISO timestamp' };
            }
            if (!isValidIsoTimestamp(area.updatedAt)) {
                return { ok: false, error: 'Invalid data: area updatedAt must be a valid ISO timestamp' };
            }
            if (area.deletedAt != null && !isValidIsoTimestamp(area.deletedAt)) {
                return { ok: false, error: 'Invalid data: area deletedAt must be a valid ISO timestamp when present' };
            }
            if (area.deletedAt == null) {
                activeAreaIds.add(area.id);
            }
        }
    }

    if (Array.isArray(people)) {
        for (const person of people) {
            if (!isRecord(person) || typeof person.id !== 'string' || typeof person.name !== 'string') {
                return { ok: false, error: 'Invalid data: each person must be an object with string id and name' };
            }
            if (person.id.trim().length === 0 || person.name.trim().length === 0) {
                return { ok: false, error: 'Invalid data: each person must include non-empty id and name' };
            }
            if (person.note !== undefined && person.note !== null && typeof person.note !== 'string') {
                return { ok: false, error: 'Invalid data: person note must be a string when present' };
            }
            if (person.referenceLink !== undefined && person.referenceLink !== null && typeof person.referenceLink !== 'string') {
                return { ok: false, error: 'Invalid data: person referenceLink must be a string when present' };
            }
            if (!isValidIsoTimestamp(person.createdAt)) {
                return { ok: false, error: 'Invalid data: person createdAt must be a valid ISO timestamp' };
            }
            if (!isValidIsoTimestamp(person.updatedAt)) {
                return { ok: false, error: 'Invalid data: person updatedAt must be a valid ISO timestamp' };
            }
            if (person.deletedAt != null && !isValidIsoTimestamp(person.deletedAt)) {
                return { ok: false, error: 'Invalid data: person deletedAt must be a valid ISO timestamp when present' };
            }
        }
    }

    for (const project of projects) {
        if (!isRecord(project) || project.deletedAt != null) continue;
        const areaId = typeof project.areaId === 'string' ? project.areaId.trim() : '';
        if (areaId && !activeAreaIds.has(areaId)) {
            return { ok: false, error: `Invalid data: live project ${project.id} references missing or deleted area ${areaId}` };
        }
    }

    for (const task of tasks) {
        const taskRecord = task as Record<string, unknown>;
        if (taskRecord.deletedAt != null) continue;
        const areaId = typeof taskRecord.areaId === 'string' ? taskRecord.areaId.trim() : '';
        if (areaId && !activeAreaIds.has(areaId)) {
            return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted area ${areaId}` };
        }
    }

    const attachments = settings && isRecord(settings) ? (settings as Record<string, unknown>).attachments : undefined;
    if (attachments !== undefined) {
        if (!isRecord(attachments)) {
            return { ok: false, error: 'Invalid data: settings.attachments must be an object when present' };
        }
        const pendingRemoteDeletes = (attachments as Record<string, unknown>).pendingRemoteDeletes;
        if (pendingRemoteDeletes !== undefined) {
            if (!Array.isArray(pendingRemoteDeletes)) {
                return { ok: false, error: 'Invalid data: settings.attachments.pendingRemoteDeletes must be an array when present' };
            }
            if (pendingRemoteDeletes.length > MAX_ITEMS_PER_COLLECTION) {
                return { ok: false, error: `Invalid data: pendingRemoteDeletes exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
            }
            for (const item of pendingRemoteDeletes) {
                if (!isRecord(item)) {
                    return { ok: false, error: 'Invalid data: each pendingRemoteDeletes entry must be an object' };
                }
                const cloudKey = typeof item.cloudKey === 'string' ? item.cloudKey.trim() : '';
                if (!cloudKey || !normalizeAttachmentRelativePath(cloudKey)) {
                    return { ok: false, error: 'Invalid data: pendingRemoteDeletes.cloudKey must be a valid relative attachment path' };
                }
                if (item.title !== undefined && typeof item.title !== 'string') {
                    return { ok: false, error: 'Invalid data: pendingRemoteDeletes.title must be a string when present' };
                }
                if (item.attempts !== undefined) {
                    if (typeof item.attempts !== 'number' || !Number.isFinite(item.attempts) || item.attempts < 0 || !Number.isInteger(item.attempts)) {
                        return { ok: false, error: 'Invalid data: pendingRemoteDeletes.attempts must be a non-negative integer when present' };
                    }
                    if (item.attempts > MAX_PENDING_REMOTE_DELETE_ATTEMPTS) {
                        return { ok: false, error: `Invalid data: pendingRemoteDeletes.attempts exceeds ${MAX_PENDING_REMOTE_DELETE_ATTEMPTS}` };
                    }
                }
                if (item.lastErrorAt !== undefined && item.lastErrorAt !== null && !isValidIsoTimestamp(item.lastErrorAt)) {
                    return { ok: false, error: 'Invalid data: pendingRemoteDeletes.lastErrorAt must be a valid ISO timestamp when present' };
                }
            }
        }
    }

    return { ok: true, data: value as unknown as AppData };
}

export function asStatus(value: unknown): TaskStatus | null {
    if (typeof value !== 'string') return null;
    return (TASK_STATUS_VALUES as readonly string[]).includes(value) ? (value as TaskStatus) : null;
}

type EntityPropsMap = { task: Task; project: Project; section: Section; area: Area };
export type EntityPropsKind = keyof EntityPropsMap;
export type EntityPropsMode = 'create' | 'patch';

type EntityPropsConfigEntry = {
    allowedKeys: Record<EntityPropsMode, ReadonlySet<string>>;
    validateValues?: (value: Record<string, unknown>) => string | null;
};

// One allowlist-plus-value-check config per (entity, create|patch) pair, replacing
// eight near-identical validate{Task,Project,Section,Area}{Creation,Patch}Props
// functions that differed only by this data.
const ENTITY_PROPS_CONFIG: Record<EntityPropsKind, EntityPropsConfigEntry> = {
    task: {
        allowedKeys: {
            create: CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS as ReadonlySet<string>,
            patch: CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS as ReadonlySet<string>,
        },
        validateValues: validateTaskPropValues,
    },
    project: {
        allowedKeys: {
            create: CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS as ReadonlySet<string>,
            patch: CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS as ReadonlySet<string>,
        },
        validateValues: validateProjectPropValues,
    },
    section: {
        allowedKeys: {
            create: CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS as ReadonlySet<string>,
            patch: CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS as ReadonlySet<string>,
        },
    },
    area: {
        allowedKeys: {
            create: CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS as ReadonlySet<string>,
            patch: CLOUD_AREA_PATCH_ALLOWED_PROP_KEYS as ReadonlySet<string>,
        },
    },
};

const ENTITY_PROPS_NOUN: Record<EntityPropsMode, string> = { create: 'props', patch: 'updates' };

export function validateEntityProps<K extends EntityPropsKind>(
    kind: K,
    mode: EntityPropsMode,
    value: unknown
): { ok: true; props: Partial<EntityPropsMap[K]> } | { ok: false; error: string } {
    const noun = ENTITY_PROPS_NOUN[mode];
    if (!isRecord(value)) return { ok: false, error: `Invalid ${kind} ${noun}` };
    const config = ENTITY_PROPS_CONFIG[kind];
    const invalidKeys = Object.keys(value).filter((key) => !config.allowedKeys[mode].has(key));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported ${kind} ${noun}: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    const valueError = config.validateValues?.(value);
    if (valueError) return { ok: false, error: valueError };
    return { ok: true, props: value as Partial<EntityPropsMap[K]> };
}

export function pickTaskList(
    data: AppData,
    opts: { includeDeleted: boolean; includeCompleted: boolean; status?: TaskStatus | null; query?: string; isFocusedToday?: boolean }
): Task[] {
    // "not completed" means neither done nor archived (isTaskFinished) - expressed here as
    // the two descriptor fields that together mean the same thing (includeArchived covers
    // archived, excludeStatuses covers done), rather than a bespoke isTaskFinished filter.
    let tasks = data.tasks.filter((t) => taskMatchesQuery(t, {
        status: opts.status ?? undefined,
        includeDeleted: opts.includeDeleted,
        includeArchived: opts.includeCompleted,
        excludeStatuses: opts.includeCompleted ? undefined : ['done'],
        isFocusedToday: opts.isFocusedToday,
    }));
    if (opts.query && opts.query.trim()) {
        // filterTasksBySearch, not searchAll: searchAll slices to SEARCH_RESULT_LIMIT (200)
        // before this route paginates, silently capping totals — same fix as /v1/search.
        const matchingTaskIds = new Set(filterTasksBySearch(tasks, filterNotDeleted(data.projects), opts.query).map((task) => task.id));
        tasks = tasks.filter((task) => matchingTaskIds.has(task.id));
    }
    return tasks;
}
