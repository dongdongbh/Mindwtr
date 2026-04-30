import {
    filterNotDeleted,
    searchAll,
    type Area,
    type AppData,
    type Project,
    type Section,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
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

function isValidIsoTimestamp(value: unknown): boolean {
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}

export function validateAppData(
    value: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid data: expected an object' };
    const tasks = value.tasks;
    const projects = value.projects;
    const sections = value.sections;
    const settings = value.settings;
    const areas = value.areas;

    if (!Array.isArray(tasks)) return { ok: false, error: 'Invalid data: tasks must be an array' };
    if (!Array.isArray(projects)) return { ok: false, error: 'Invalid data: projects must be an array' };
    if (sections !== undefined && !Array.isArray(sections)) return { ok: false, error: 'Invalid data: sections must be an array' };
    if (areas !== undefined && !Array.isArray(areas)) return { ok: false, error: 'Invalid data: areas must be an array' };
    if (settings !== undefined && !isRecord(settings)) return { ok: false, error: 'Invalid data: settings must be an object' };
    if (tasks.length > MAX_ITEMS_PER_COLLECTION) return { ok: false, error: `Invalid data: tasks exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    if (projects.length > MAX_ITEMS_PER_COLLECTION) return { ok: false, error: `Invalid data: projects exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    if (Array.isArray(sections) && sections.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: sections exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }
    if (Array.isArray(areas) && areas.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: areas exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }

    for (const task of tasks) {
        if (!isRecord(task) || typeof task.id !== 'string' || typeof task.title !== 'string') {
            return { ok: false, error: 'Invalid data: each task must be an object with string id and title' };
        }
        if (task.id.trim().length === 0 || task.title.trim().length === 0) {
            return { ok: false, error: 'Invalid data: each task must include non-empty id and title' };
        }
        if (typeof task.status !== 'string' || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(task.status)) {
            return { ok: false, error: 'Invalid data: task status must be a valid value' };
        }
        if (!isValidIsoTimestamp(task.createdAt) || !isValidIsoTimestamp(task.updatedAt)) {
            return { ok: false, error: 'Invalid data: task createdAt/updatedAt must be valid ISO timestamps' };
        }
        if (task.deletedAt != null && !isValidIsoTimestamp(task.deletedAt)) {
            return { ok: false, error: 'Invalid data: task deletedAt must be a valid ISO timestamp when present' };
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

    return { ok: true, data: value };
}

export function asStatus(value: unknown): TaskStatus | null {
    if (typeof value !== 'string') return null;
    const allowed: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
    return allowed.includes(value as TaskStatus) ? (value as TaskStatus) : null;
}

export function validateTaskCreationProps(
    value: unknown
): { ok: true; props: Partial<Task> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid task props' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS.has(key as keyof Task));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported task props: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Task> };
}

export function validateTaskPatchProps(
    value: unknown
): { ok: true; props: Partial<Task> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid task updates' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS.has(key as keyof Task));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported task updates: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Task> };
}

export function validateProjectCreationProps(
    value: unknown
): { ok: true; props: Partial<Project> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid project props' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS.has(key as keyof Project));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported project props: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Project> };
}

export function validateProjectPatchProps(
    value: unknown
): { ok: true; props: Partial<Project> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid project updates' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS.has(key as keyof Project));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported project updates: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Project> };
}

export function validateSectionCreationProps(
    value: unknown
): { ok: true; props: Partial<Section> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid section props' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS.has(key as keyof Section));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported section props: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Section> };
}

export function validateSectionPatchProps(
    value: unknown
): { ok: true; props: Partial<Section> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid section updates' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS.has(key as keyof Section));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported section updates: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Section> };
}

export function validateAreaCreationProps(
    value: unknown
): { ok: true; props: Partial<Area> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid area props' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS.has(key as keyof Area));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported area props: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Area> };
}

export function validateAreaPatchProps(
    value: unknown
): { ok: true; props: Partial<Area> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid area updates' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_AREA_PATCH_ALLOWED_PROP_KEYS.has(key as keyof Area));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported area updates: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Area> };
}

export function pickTaskList(
    data: AppData,
    opts: { includeDeleted: boolean; includeCompleted: boolean; status?: TaskStatus | null; query?: string }
): Task[] {
    let tasks = data.tasks;
    if (!opts.includeDeleted) tasks = tasks.filter((t) => !t.deletedAt);
    if (!opts.includeCompleted) tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
    if (opts.query && opts.query.trim()) {
        tasks = searchAll(tasks, filterNotDeleted(data.projects), opts.query).tasks;
    }
    return tasks;
}
