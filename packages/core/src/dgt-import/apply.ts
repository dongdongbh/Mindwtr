import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from '../color-constants';
import { ensureDeviceId } from '../store-helpers';
import type { AppData, Area, Project, Task } from '../types';
import { generateUUID as uuidv4 } from '../uuid';

import {
  DGT_AREA_FALLBACK,
  DGT_PROJECT_FALLBACK,
  resolveTimestamp,
  resolveUniqueName,
  type DgtImportExecutionResult,
  type ParsedDgtImportData,
} from './shared';

export const applyDgtImport = (
  currentData: AppData,
  parsedData: ParsedDgtImportData,
  options: { now?: Date | string } = {}
): DgtImportExecutionResult => {
  const resolvedNow =
    options.now instanceof Date
      ? options.now
      : typeof options.now === 'string' && options.now.trim()
        ? new Date(options.now)
        : new Date();
  const nowIso = Number.isFinite(resolvedNow.getTime()) ? resolvedNow.toISOString() : new Date().toISOString();
  const deviceState = ensureDeviceId(currentData.settings ?? {});
  const settings = deviceState.settings;
  const nextData: AppData = {
    tasks: [...currentData.tasks],
    projects: [...currentData.projects],
    sections: [...currentData.sections],
    areas: [...currentData.areas],
    settings,
  };

  const usedAreaNames = new Set(
    nextData.areas.filter((area) => !area.deletedAt).map((area) => area.name.trim().toLowerCase())
  );
  const usedProjectTitles = new Set(
    nextData.projects.filter((project) => !project.deletedAt).map((project) => project.title.trim().toLowerCase())
  );

  const warnings = [...parsedData.warnings];
  let importedAreaCount = 0;
  let importedProjectCount = 0;
  let importedTaskCount = 0;
  let importedChecklistItemCount = 0;

  const areaIdBySourceId = new Map<number, string>();
  const projectIdBySourceId = new Map<number, string>();

  const nextAreaOrder =
    nextData.areas
      .filter((area) => !area.deletedAt)
      .reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;
  parsedData.areas
    .slice()
    .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
    .forEach((area, index) => {
      const areaName = resolveUniqueName(area.name, usedAreaNames, DGT_AREA_FALLBACK);
      if (areaName !== area.name) {
        warnings.push(`Imported area "${area.name}" was renamed to "${areaName}" to avoid a name conflict.`);
      }
      const createdAt = resolveTimestamp(area.createdAt, nowIso);
      const updatedAt = resolveTimestamp(area.updatedAt, createdAt);
      const nextArea: Area = {
        id: uuidv4(),
        name: areaName,
        color: area.color ?? DEFAULT_AREA_COLOR,
        order: nextAreaOrder + index,
        createdAt,
        updatedAt,
        rev: 1,
        revBy: deviceState.deviceId,
      };
      nextData.areas.push(nextArea);
      areaIdBySourceId.set(area.sourceId, nextArea.id);
      importedAreaCount += 1;
    });

  parsedData.projects
    .slice()
    .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
    .forEach((project) => {
      const areaId = project.areaSourceId ? areaIdBySourceId.get(project.areaSourceId) : undefined;
      const projectTitle = resolveUniqueName(project.name, usedProjectTitles, DGT_PROJECT_FALLBACK);
      if (projectTitle !== project.name) {
        warnings.push(`Imported project "${project.name}" was renamed to "${projectTitle}" to avoid a title conflict.`);
      }
      const siblingMaxOrder = nextData.projects
        .filter((item) => !item.deletedAt && (item.areaId ?? undefined) === areaId)
        .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1);
      const createdAt = resolveTimestamp(project.createdAt, nowIso);
      const updatedAt = resolveTimestamp(project.updatedAt, createdAt);
      const nextProject: Project = {
        id: uuidv4(),
        title: projectTitle,
        status: project.isArchived ? 'archived' : 'active',
        color: project.color ?? DEFAULT_PROJECT_COLOR,
        order: siblingMaxOrder + 1,
        tagIds: [],
        dueDate: project.dueDate,
        supportNotes: project.supportNotes,
        createdAt,
        updatedAt,
        rev: 1,
        revBy: deviceState.deviceId,
        ...(areaId ? { areaId } : {}),
      };
      nextData.projects.push(nextProject);
      projectIdBySourceId.set(project.sourceId, nextProject.id);
      importedProjectCount += 1;
    });

  const nextTaskOrderByBucket = new Map<string, number>();
  const getTaskBucketKey = (projectId?: string, areaId?: string): string => {
    if (projectId) return `project:${projectId}`;
    if (areaId) return `area:${areaId}`;
    return 'inbox';
  };
  const allocateTaskOrder = (projectId?: string, areaId?: string): number => {
    const bucket = getTaskBucketKey(projectId, areaId);
    const cached = nextTaskOrderByBucket.get(bucket);
    if (cached !== undefined) {
      nextTaskOrderByBucket.set(bucket, cached + 1);
      return cached;
    }
    const currentMax = nextData.tasks
      .filter((task) => !task.deletedAt && (task.projectId ?? undefined) === projectId && (task.areaId ?? undefined) === areaId)
      .reduce((max, task) => {
        const candidate =
          typeof task.order === 'number'
            ? task.order
            : typeof task.orderNum === 'number'
              ? task.orderNum
              : -1;
        return Math.max(max, candidate);
      }, -1);
    const nextOrder = currentMax + 1;
    nextTaskOrderByBucket.set(bucket, nextOrder + 1);
    return nextOrder;
  };

  parsedData.tasks
    .slice()
    .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
    .forEach((task) => {
      const projectId = task.projectSourceId ? projectIdBySourceId.get(task.projectSourceId) : undefined;
      const areaId = !projectId && task.areaSourceId ? areaIdBySourceId.get(task.areaSourceId) : undefined;
      const order = allocateTaskOrder(projectId, areaId);
      const createdAt = resolveTimestamp(task.createdAt, nowIso);
      const updatedAt = resolveTimestamp(task.updatedAt, createdAt);
      const checklist =
        task.checklist.length > 0
          ? task.checklist.map((item) => ({
              id: uuidv4(),
              title: item.title,
              isCompleted: item.isCompleted,
            }))
          : undefined;
      const nextTask: Task = {
        id: uuidv4(),
        title: task.title,
        status: task.status,
        taskMode: checklist ? 'list' : 'task',
        priority: task.priority,
        contexts: task.contexts,
        tags: task.tags,
        description: task.description,
        startTime: task.startTime,
        dueDate: task.dueDate,
        recurrence: task.recurrence,
        completedAt: task.completedAt,
        checklist,
        pushCount: 0,
        createdAt,
        updatedAt,
        rev: 1,
        revBy: deviceState.deviceId,
        order,
        orderNum: order,
        ...(projectId ? { projectId } : {}),
        ...(areaId ? { areaId } : {}),
      };
      nextData.tasks.push(nextTask);
      importedTaskCount += 1;
      importedChecklistItemCount += checklist?.length ?? 0;
    });

  return {
    data: nextData,
    importedAreaCount,
    importedProjectCount,
    importedTaskCount,
    importedChecklistItemCount,
    warnings,
  };
};
