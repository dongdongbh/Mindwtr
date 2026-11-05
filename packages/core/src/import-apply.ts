


import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { safeParseDate } from './date';
import { ensureDeviceId, getReferenceTaskFieldClears } from './store-helpers';
import { nextRevision } from './sync-revision';
import { isTaskFinished } from './task-status';
import type { AppData, Area, ChecklistItem, Project, Section, Task, TaskEnergyLevel, TaskPriority, TaskStatus } from './types';
import { generateUUID as uuidv4 } from './uuid';

export type ImportAreaSource = {
    color?: string;
    createdAt?: string;
    name: string;
    order: number;
    sourceKey: string;
    updatedAt?: string;
};

export type ImportProjectSource = {
    areaSourceKey?: string;
    color?: string;
    createdAt?: string;
    dueDate?: string;
    name: string;
    order: number;
    sourceKey: string;
    startDate?: string;
    status?: Project['status'];
    supportNotes?: string;
    tagIds?: string[];
    updatedAt?: string;
};

export type ImportSectionSource = {
    createdAt?: string;
    name: string;
    order: number;
    projectSourceKey: string;
    sourceKey: string;
    updatedAt?: string;
};

export type ImportTaskSource = {
    areaSourceKey?: string;
    assignedTo?: string;
    cancelledAt?: string;
    checklist?: ChecklistItem[];
    completedAt?: string;
    contexts?: string[];
    createdAt?: string;
    description?: string;
    dueDate?: string;
    energyLevel?: TaskEnergyLevel;
    location?: string;
    order: number;
    priority?: TaskPriority;
    projectSourceKey?: string;
    recurrence?: Task['recurrence'];
    reviewAt?: string;
    sectionSourceKey?: string;


    sourceKey: string;
    startTime?: string;
    status: TaskStatus;
    tags?: string[];
    title: string;
    updatedAt?: string;
};

export type ImportSource = {
    areas: ImportAreaSource[];
    projects: ImportProjectSource[];


    sections?: ImportSectionSource[];
    tasks: ImportTaskSource[];
    warnings: string[];
};

export type ImportExecutionResult = {
    data: AppData;
    importedAreaCount: number;
    importedChecklistItemCount: number;
    importedProjectCount: number;
    importedSectionCount: number;
    importedStandaloneTaskCount: number;
    importedTaskCount: number;
    warnings: string[];
};


export type ImportParseResult<TData, TPreview> = {
    errors: string[];
    parsedData: TData | null;
    preview: TPreview | null;
    valid: boolean;
    warnings: string[];
};

export type ImportApplyOptions = {
    fallbacks: {
        area: string;
        project: string;
    };
    idFor?: (kind: 'area' | 'project' | 'section' | 'task', sourceKey: string) => string;
    now?: Date | string;
    resolveTaskStatus?: (status: TaskStatus, projectId: string | undefined) => TaskStatus;
    suffix: string;
};


export const resolveUniqueName = (
    title: string,
    usedTitles: Set<string>,
    fallback: string,
    suffix: string
): string => {
    const trimmed = title.trim() || fallback;
    if (!usedTitles.has(trimmed.toLowerCase())) {
        usedTitles.add(trimmed.toLowerCase());
        return trimmed;
    }

    const base = `${trimmed}${suffix}`;
    if (!usedTitles.has(base.toLowerCase())) {
        usedTitles.add(base.toLowerCase());
        return base;
    }

    let suffixIndex = 2;
    while (true) {
        const next = `${base} ${suffixIndex}`;
        const normalized = next.toLowerCase();
        if (!usedTitles.has(normalized)) {
            usedTitles.add(normalized);
            return next;
        }
        suffixIndex += 1;
    }
};


const resolveTimestamp = (value: string | undefined, fallback: string): string => (
    safeParseDate(value) ? (value as string) : fallback
);

const getTaskBucketKey = (projectId?: string, areaId?: string): string => {
    if (projectId) return `project:${projectId}`;
    if (areaId) return `area:${areaId}`;
    return 'inbox';
};

export function applyImport(
    currentData: AppData,
    parsed: ImportSource,
    opts: ImportApplyOptions
): ImportExecutionResult {
    const resolvedNow = opts.now instanceof Date
        ? opts.now
        : typeof opts.now === 'string' && opts.now.trim()
            ? new Date(opts.now)
            : new Date();
    const nowIso = Number.isFinite(resolvedNow.getTime()) ? resolvedNow.toISOString() : new Date().toISOString();
    const deviceState = ensureDeviceId(currentData.settings ?? {});
    const settings = deviceState.settings;
    const nextData: AppData = {
        tasks: [...currentData.tasks],
        projects: [...currentData.projects],
        sections: [...currentData.sections],
        areas: [...currentData.areas],
        people: [...(currentData.people ?? [])],
        settings,
    };

    const idFor = opts.idFor ?? (() => uuidv4());
    const resolveTaskStatus = opts.resolveTaskStatus ?? ((status: TaskStatus) => status);

    const usedAreaNames = new Set(
        nextData.areas.filter((area) => !area.deletedAt).map((area) => area.name.trim().toLowerCase())
    );
    const usedProjectTitlesByAreaId = new Map<string | undefined, Set<string>>();
    nextData.projects.filter((project) => !project.deletedAt).forEach((project) => {
        const areaId = project.areaId ?? undefined;
        const usedTitles = usedProjectTitlesByAreaId.get(areaId) ?? new Set<string>();
        usedTitles.add(project.title.trim().toLowerCase());
        usedProjectTitlesByAreaId.set(areaId, usedTitles);
    });
    const warnings = [...parsed.warnings];


    const existingAreaById = new Map(nextData.areas.map((area) => [area.id, area]));
    const existingProjectById = new Map(nextData.projects.map((project) => [project.id, project]));
    const existingSectionById = new Map(nextData.sections.map((section) => [section.id, section]));
    const existingTaskIds = new Set(nextData.tasks.map((task) => task.id));


    const liveTaskById = new Map(nextData.tasks.map((task) => [task.id, task] as const));
    const carriedProjectIds = new Map<string, Set<string>>();
    const carriedSectionIds = new Map<string, Set<string>>();
    const carriedAreaIds = new Map<string, Set<string>>();
    const recordCarry = (map: Map<string, Set<string>>, sourceKey: string, id: string) => {
        const seen = map.get(sourceKey) ?? new Set<string>();
        seen.add(id);
        map.set(sourceKey, seen);
    };
    const isLive = (entity?: { deletedAt?: string; purgedAt?: string }): boolean => (
        Boolean(entity) && !entity!.deletedAt && !entity!.purgedAt
    );
    parsed.tasks.forEach((task) => {
        const liveTask = liveTaskById.get(idFor('task', task.sourceKey));
        if (!isLive(liveTask)) return;
        const liveProject = liveTask!.projectId ? existingProjectById.get(liveTask!.projectId) : undefined;
        if (task.projectSourceKey && isLive(liveProject)) {
            recordCarry(carriedProjectIds, task.projectSourceKey, liveProject!.id);
        }
        const liveSection = liveTask!.sectionId ? existingSectionById.get(liveTask!.sectionId) : undefined;
        if (task.sectionSourceKey && isLive(liveSection)) {
            recordCarry(carriedSectionIds, task.sectionSourceKey, liveSection!.id);
        }
        const liveAreaId = isLive(liveProject) ? liveProject!.areaId : liveTask!.areaId;
        if (task.areaSourceKey && liveAreaId && isLive(existingAreaById.get(liveAreaId))) {
            recordCarry(carriedAreaIds, task.areaSourceKey, liveAreaId);
        }
    });

    const settle = (map: Map<string, Set<string>>): Map<string, string> => new Map(
        Array.from(map, ([sourceKey, ids]) => [sourceKey, ids.size === 1 ? [...ids][0] : ''] as const)
            .filter((entry): entry is readonly [string, string] => entry[1] !== '')
    );
    const liveProjectIdBySourceKey = settle(carriedProjectIds);
    const liveSectionIdBySourceKey = settle(carriedSectionIds);
    const liveAreaIdBySourceKey = settle(carriedAreaIds);

    const deletedTaskIds = new Set(nextData.tasks.filter((task) => task.deletedAt || task.purgedAt).map((task) => task.id));

    const areaIdBySourceKey = new Map<string, string>();
    const projectIdBySourceKey = new Map<string, string>();
    const sectionIdBySourceKey = new Map<string, string>();

    let importedAreaCount = 0;
    let importedProjectCount = 0;
    let importedSectionCount = 0;
    let importedTaskCount = 0;
    let importedChecklistItemCount = 0;
    let importedStandaloneTaskCount = 0;

    const nextAreaOrder = nextData.areas
        .filter((area) => !area.deletedAt)
        .reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;

    parsed.areas.forEach((area, index) => {
        const areaId = idFor('area', area.sourceKey);
        const existingArea = existingAreaById.get(areaId);
        if (existingArea) {
            if (!existingArea.deletedAt) areaIdBySourceKey.set(area.sourceKey, existingArea.id);
            return;
        }
        const carriedAreaId = liveAreaIdBySourceKey.get(area.sourceKey);
        if (carriedAreaId) {
            areaIdBySourceKey.set(area.sourceKey, carriedAreaId);
            return;
        }
        const areaName = resolveUniqueName(area.name, usedAreaNames, opts.fallbacks.area, opts.suffix);
        if (areaName !== area.name) {
            warnings.push(`Imported area "${area.name}" was renamed to "${areaName}" to avoid a name conflict.`);
        }
        const createdAt = resolveTimestamp(area.createdAt, nowIso);
        const updatedAt = resolveTimestamp(area.updatedAt, createdAt);
        const nextArea: Area = {
            id: areaId,
            name: areaName,
            color: area.color ?? DEFAULT_AREA_COLOR,
            order: nextAreaOrder + index,
            createdAt,
            updatedAt,
            rev: nextRevision(),
            revBy: deviceState.deviceId,
        };
        nextData.areas.push(nextArea);
        areaIdBySourceKey.set(area.sourceKey, nextArea.id);
        importedAreaCount += 1;
    });

    parsed.projects.forEach((project) => {
        const projectId = idFor('project', project.sourceKey);
        const existingProject = existingProjectById.get(projectId);
        if (existingProject) {
            if (!existingProject.deletedAt) projectIdBySourceKey.set(project.sourceKey, existingProject.id);
            return;
        }
        const carriedProjectId = liveProjectIdBySourceKey.get(project.sourceKey);
        if (carriedProjectId) {
            projectIdBySourceKey.set(project.sourceKey, carriedProjectId);
            return;
        }
        const areaId = project.areaSourceKey ? areaIdBySourceKey.get(project.areaSourceKey) : undefined;
        const usedProjectTitles = usedProjectTitlesByAreaId.get(areaId) ?? new Set<string>();
        usedProjectTitlesByAreaId.set(areaId, usedProjectTitles);
        const projectTitle = resolveUniqueName(project.name, usedProjectTitles, opts.fallbacks.project, opts.suffix);
        if (projectTitle !== project.name) {
            warnings.push(`Imported project "${project.name}" was renamed to "${projectTitle}" to avoid a title conflict.`);
        }
        const siblingMaxOrder = nextData.projects
            .filter((item) => !item.deletedAt && (item.areaId ?? undefined) === areaId)
            .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1);
        const createdAt = resolveTimestamp(project.createdAt, nowIso);
        const updatedAt = resolveTimestamp(project.updatedAt, createdAt);
        const nextProject: Project = {
            id: projectId,
            title: projectTitle,
            status: project.status ?? 'active',
            color: project.color ?? DEFAULT_PROJECT_COLOR,
            order: siblingMaxOrder + 1,
            tagIds: project.tagIds ?? [],
            supportNotes: project.supportNotes,
            dueDate: project.dueDate,
            startDate: project.startDate,
            createdAt,
            updatedAt,
            rev: nextRevision(),
            revBy: deviceState.deviceId,
            ...(areaId ? { areaId } : {}),
        };
        nextData.projects.push(nextProject);
        projectIdBySourceKey.set(project.sourceKey, nextProject.id);
        importedProjectCount += 1;
    });


    (parsed.sections ?? []).forEach((section) => {
        const projectId = projectIdBySourceKey.get(section.projectSourceKey);
        if (!projectId) return;
        const sectionId = idFor('section', section.sourceKey);
        const existingSection = existingSectionById.get(sectionId);
        if (existingSection) {
            if (!existingSection.deletedAt) sectionIdBySourceKey.set(section.sourceKey, existingSection.id);
            return;
        }


        const carriedSectionId = liveSectionIdBySourceKey.get(section.sourceKey);
        if (carriedSectionId && existingSectionById.get(carriedSectionId)?.projectId === projectId) {
            sectionIdBySourceKey.set(section.sourceKey, carriedSectionId);
            return;
        }
        const siblingMaxOrder = nextData.sections
            .filter((item) => !item.deletedAt && item.projectId === projectId)
            .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1);
        const createdAt = resolveTimestamp(section.createdAt, nowIso);
        const updatedAt = resolveTimestamp(section.updatedAt, createdAt);
        const nextSection: Section = {
            id: sectionId,
            projectId,
            title: section.name,
            order: siblingMaxOrder + 1,
            createdAt,
            updatedAt,
            rev: nextRevision(),
            revBy: deviceState.deviceId,
        };
        nextData.sections.push(nextSection);
        sectionIdBySourceKey.set(section.sourceKey, nextSection.id);
        importedSectionCount += 1;
    });

    const nextTaskOrderByBucket = new Map<string, number>();
    nextData.tasks.forEach((task) => {
        if (task.deletedAt) return;
        const bucket = getTaskBucketKey(task.projectId, task.areaId);
        const candidate = typeof task.order === 'number'
            ? task.order
            : typeof task.orderNum === 'number'
                ? task.orderNum
                : -1;
        nextTaskOrderByBucket.set(bucket, Math.max(nextTaskOrderByBucket.get(bucket) ?? -1, candidate));
    });
    nextTaskOrderByBucket.forEach((maxOrder, bucket) => {
        nextTaskOrderByBucket.set(bucket, maxOrder + 1);
    });
    const allocateTaskOrder = (projectId?: string, areaId?: string): number => {
        const bucket = getTaskBucketKey(projectId, areaId);
        const cached = nextTaskOrderByBucket.get(bucket);
        if (cached !== undefined) {
            nextTaskOrderByBucket.set(bucket, cached + 1);
            return cached;
        }
        nextTaskOrderByBucket.set(bucket, 1);
        return 0;
    };


    let skippedExistingTaskCount = 0;
    let skippedDeletedTaskCount = 0;
    parsed.tasks.forEach((task) => {
        const taskId = idFor('task', task.sourceKey);
        if (existingTaskIds.has(taskId)) {
            if (deletedTaskIds.has(taskId)) skippedDeletedTaskCount += 1;
            else skippedExistingTaskCount += 1;
            return;
        }
        const projectId = task.projectSourceKey ? projectIdBySourceKey.get(task.projectSourceKey) : undefined;
        const areaId = !projectId && task.areaSourceKey ? areaIdBySourceKey.get(task.areaSourceKey) : undefined;
        const sectionId = task.sectionSourceKey ? sectionIdBySourceKey.get(task.sectionSourceKey) : undefined;
        const order = allocateTaskOrder(projectId, areaId);
        const checklist = task.checklist && task.checklist.length > 0
            ? task.checklist.map((item) => ({
                id: uuidv4(),
                title: item.title,
                isCompleted: item.isCompleted,
            }))
            : undefined;
        const createdAt = resolveTimestamp(task.createdAt, nowIso);
        const updatedAt = resolveTimestamp(task.updatedAt, createdAt);
        const status = resolveTaskStatus(task.status, projectId);
        const cancelledAt = status === 'archived' ? task.cancelledAt : undefined;
        const completedAt = !cancelledAt && isTaskFinished(status)
            ? task.completedAt ?? updatedAt
            : undefined;
        const nextTask: Task = {
            id: taskId,
            title: task.title,
            status,
            taskMode: checklist ? 'list' : 'task',
            priority: task.priority,
            energyLevel: task.energyLevel,
            assignedTo: task.assignedTo,
            contexts: task.contexts ?? [],
            tags: task.tags ?? [],
            checklist,
            description: task.description,
            location: task.location,
            startTime: task.startTime,
            dueDate: task.dueDate,
            reviewAt: task.reviewAt,
            recurrence: task.recurrence,
            completedAt,
            cancelledAt,
            pushCount: 0,
            createdAt,
            updatedAt,
            rev: nextRevision(),
            revBy: deviceState.deviceId,
            order,
            orderNum: order,


            ...(status === 'reference' ? getReferenceTaskFieldClears() : {}),
            ...(projectId ? { projectId } : {}),
            ...(sectionId ? { sectionId } : {}),
            ...(areaId ? { areaId } : {}),
        };
        nextData.tasks.push(nextTask);
        existingTaskIds.add(taskId);
        importedTaskCount += 1;
        importedChecklistItemCount += checklist?.length ?? 0;
        if (!projectId) importedStandaloneTaskCount += 1;
    });

    if (skippedExistingTaskCount > 0) {
        warnings.push(skippedExistingTaskCount === 1
            ? '1 task was skipped because it was already imported earlier.'
            : `${skippedExistingTaskCount} tasks were skipped because they were already imported earlier.`);
    }
    if (skippedDeletedTaskCount > 0) {
        warnings.push(skippedDeletedTaskCount === 1
            ? '1 task was skipped because it was imported earlier and then deleted here; deletions are kept on re-import.'
            : `${skippedDeletedTaskCount} tasks were skipped because they were imported earlier and then deleted here; deletions are kept on re-import.`);
    }

    return {
        data: nextData,
        importedAreaCount,
        importedChecklistItemCount,
        importedProjectCount,
        importedSectionCount,
        importedStandaloneTaskCount,
        importedTaskCount,
        warnings,
    };
}
