import { unzipSync } from 'fflate';

import type { Task } from '../types';
import { generateUUID as uuidv4 } from '../uuid';

import {
  DGT_AREA_FALLBACK,
  DGT_PROJECT_FALLBACK,
  DGT_STATUS_NONE,
  DGT_TASK_FALLBACK,
  DGT_TYPE_CHECKLIST,
  DGT_TYPE_CHECKLIST_ITEM,
  DGT_TYPE_PROJECT,
  DGT_TYPE_TASK,
  basename,
  buildWarnings,
  createWarningCounters,
  decodeTextBytes,
  dedupeStrings,
  isZipBytes,
  joinDescription,
  normalizeColor,
  normalizeContextName,
  normalizeDateString,
  normalizeOrder,
  normalizePriority,
  normalizeTagName,
  normalizeTitle,
  resolveRepeatPattern,
  resolveTaskStatus,
  sanitizeJsonText,
  toBooleanFlag,
  toIntegerArray,
  toNumberValue,
  toPositiveInt,
  toRecord,
  toStringValue,
  toUint8Array,
  type DgtImportParseResult,
  type DgtImportPreview,
  type DgtWarningCounters,
  type ParsedDgtArea,
  type ParsedDgtImportData,
  type ParsedDgtProject,
  type ParsedDgtTask,
} from './shared';

type DgtFileInput = {
  bytes?: ArrayBuffer | Uint8Array | null;
  fileName: string;
  text?: string | null;
};

type NormalizedFolder = {
  color?: string;
  createdAt?: string;
  order: number;
  sourceId: number;
  title: string;
  updatedAt?: string;
};

type NormalizedContext = {
  sourceId: number;
  title: string;
};

type NormalizedTag = {
  sourceId: number;
  title: string;
};

type NormalizedTaskRecord = {
  color?: string;
  completedAt?: string;
  contextId?: number;
  createdAt?: string;
  dueDate?: string;
  dueTimeSet: boolean;
  folderId?: number;
  note?: string;
  order: number;
  parentId?: number;
  priorityValue: number;
  repeatText?: string;
  sourceId: number;
  sourceIndex: number;
  starred: boolean;
  startDate?: string;
  startTimeSet: boolean;
  statusValue: number;
  tagIds: number[];
  title: string;
  type: number;
  updatedAt?: string;
};

const normalizeFolders = (rawFolders: unknown): NormalizedFolder[] => {
  if (!Array.isArray(rawFolders)) return [];
  return rawFolders.flatMap((value, index) => {
    const record = toRecord(value);
    const sourceId = toPositiveInt(record?.ID);
    if (!record || sourceId === undefined) return [];
    return [
      {
        sourceId,
        title: normalizeTitle(record.TITLE, `${DGT_AREA_FALLBACK} ${index + 1}`),
        color: normalizeColor(record.COLOR),
        order: normalizeOrder(record.ORDINAL, index),
        createdAt: normalizeDateString(record.CREATED, true),
        updatedAt: normalizeDateString(record.MODIFIED, true),
      },
    ];
  });
};

const normalizeContexts = (rawContexts: unknown): NormalizedContext[] => {
  if (!Array.isArray(rawContexts)) return [];
  return rawContexts
    .map((value, index) => {
      const record = toRecord(value);
      const sourceId = toPositiveInt(record?.ID);
      if (!record || sourceId === undefined) return null;
      return {
        sourceId,
        title: normalizeTitle(record.TITLE, `Context ${index + 1}`),
      };
    })
    .filter((entry): entry is NormalizedContext => Boolean(entry));
};

const normalizeTags = (rawTags: unknown): NormalizedTag[] => {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map((value, index) => {
      const record = toRecord(value);
      const sourceId = toPositiveInt(record?.ID);
      if (!record || sourceId === undefined) return null;
      return {
        sourceId,
        title: normalizeTitle(record.TITLE, `Tag ${index + 1}`),
      };
    })
    .filter((entry): entry is NormalizedTag => Boolean(entry));
};

const normalizeTasks = (rawTasks: unknown): NormalizedTaskRecord[] => {
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks.flatMap((value, index) => {
    const record = toRecord(value);
    const sourceId = toPositiveInt(record?.ID);
    if (!record || sourceId === undefined) return [];
    return [
      {
        sourceId,
        sourceIndex: index,
        type: Math.trunc(toNumberValue(record.TYPE, DGT_TYPE_TASK)),
        parentId: toPositiveInt(record.PARENT),
        title: normalizeTitle(record.TITLE, `${DGT_TASK_FALLBACK} ${index + 1}`),
        note: toStringValue(record.NOTE) || undefined,
        startDate: normalizeDateString(record.START_DATE, toBooleanFlag(record.START_TIME_SET)),
        startTimeSet: toBooleanFlag(record.START_TIME_SET),
        dueDate: normalizeDateString(record.DUE_DATE, toBooleanFlag(record.DUE_TIME_SET)),
        dueTimeSet: toBooleanFlag(record.DUE_TIME_SET),
        repeatText: toStringValue(record.REPEAT_NEW) || undefined,
        statusValue: Math.trunc(toNumberValue(record.STATUS, DGT_STATUS_NONE)),
        contextId: toPositiveInt(record.CONTEXT),
        folderId: toPositiveInt(record.FOLDER),
        tagIds: toIntegerArray(record.TAG),
        starred: toBooleanFlag(record.STARRED),
        priorityValue: Math.trunc(toNumberValue(record.PRIORITY, 0)),
        completedAt: normalizeDateString(record.COMPLETED, true),
        color: normalizeColor(record.COLOR),
        order: normalizeOrder(record.ORDINAL, index),
        createdAt: normalizeDateString(record.CREATED, true),
        updatedAt: normalizeDateString(record.MODIFIED, true),
      },
    ];
  });
};

const parseDgtPayload = (payload: Record<string, unknown>, counters: DgtWarningCounters): ParsedDgtImportData => {
  const folders = normalizeFolders(payload.FOLDER);
  const contexts = normalizeContexts(payload.CONTEXT);
  const tags = normalizeTags(payload.TAG);
  const records = normalizeTasks(payload.TASK);

  const contextMap = new Map<number, string>(
    contexts
      .map((context) => [context.sourceId, normalizeContextName(context.title)] as const)
      .filter((entry): entry is readonly [number, string] => Boolean(entry[1]))
  );
  const tagMap = new Map<number, string>(
    tags
      .map((tag) => [tag.sourceId, normalizeTagName(tag.title)] as const)
      .filter((entry): entry is readonly [number, string] => Boolean(entry[1]))
  );
  const recordMap = new Map<number, NormalizedTaskRecord>(records.map((record) => [record.sourceId, record]));
  const projectRecords = records.filter((record) => record.type === DGT_TYPE_PROJECT);
  const checklistItemIds = new Set<number>();
  const parsedAreas: ParsedDgtArea[] = folders
    .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
    .map((folder) => ({
      sourceId: folder.sourceId,
      name: folder.title,
      order: folder.order,
      color: folder.color,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    }));

  const buildRecordTags = (record: NormalizedTaskRecord): string[] => dedupeStrings(record.tagIds.map((tagId) => tagMap.get(tagId)));

  const buildRecordContexts = (record: NormalizedTaskRecord): string[] =>
    dedupeStrings(record.contextId ? [contextMap.get(record.contextId)] : []);

  const buildRepeatMetadata = (record: NormalizedTaskRecord): { descriptionSuffix?: string; recurrence?: Task['recurrence'] } => {
    if (!record.repeatText) return {};
    const repeatResolution = resolveRepeatPattern(record.repeatText, record.dueDate || record.startDate);
    if (repeatResolution.recurrence) {
      return { recurrence: repeatResolution.recurrence };
    }
    counters.unsupportedRepeats += 1;
    return {
      descriptionSuffix: `Original DGT repeat: ${record.repeatText}`,
    };
  };

  const buildTaskBase = (record: NormalizedTaskRecord): Omit<ParsedDgtTask, 'checklist' | 'projectSourceId'> => {
    const priority = normalizePriority(record.priorityValue, record.starred);
    const status = resolveTaskStatus(record.statusValue, record.completedAt, counters);
    const repeatMetadata = buildRepeatMetadata(record);
    return {
      sourceId: record.sourceId,
      title: record.title,
      order: record.order,
      areaSourceId: record.folderId,
      status: status.status,
      completedAt: status.completedAt,
      priority,
      contexts: buildRecordContexts(record),
      tags: buildRecordTags(record),
      description: joinDescription([record.note, repeatMetadata.descriptionSuffix]),
      dueDate: record.dueDate,
      startTime: record.startDate,
      recurrence: repeatMetadata.recurrence,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  };

  const parsedProjects: ParsedDgtProject[] = projectRecords
    .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
    .map((record) => {
      const repeatMetadata = buildRepeatMetadata(record);
      const contexts = buildRecordContexts(record);
      const recordTags = buildRecordTags(record);
      const supportNotes = joinDescription([
        record.note,
        contexts.length > 0 ? `Contexts: ${contexts.join(', ')}` : undefined,
        recordTags.length > 0 ? `Tags: ${recordTags.join(', ')}` : undefined,
        repeatMetadata.descriptionSuffix,
      ]);
      return {
        sourceId: record.sourceId,
        name: record.title || DGT_PROJECT_FALLBACK,
        order: record.order,
        areaSourceId: record.folderId,
        color: record.color,
        dueDate: record.dueDate,
        supportNotes,
        isArchived: Boolean(record.completedAt),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });

  const parsedTasks: ParsedDgtTask[] = [];
  const checklistChildrenByParent = new Map<number, NormalizedTaskRecord[]>();
  records
    .filter((record) => record.type === DGT_TYPE_CHECKLIST_ITEM)
    .forEach((record) => {
      if (!record.parentId) return;
      const existing = checklistChildrenByParent.get(record.parentId) ?? [];
      existing.push(record);
      checklistChildrenByParent.set(record.parentId, existing);
    });

  const sortableNonProjectRecords = records
    .filter((record) => record.type !== DGT_TYPE_PROJECT && record.type !== DGT_TYPE_CHECKLIST_ITEM)
    .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex);

  sortableNonProjectRecords.forEach((record) => {
    const isTaskLike = record.type === DGT_TYPE_TASK || record.type === DGT_TYPE_CHECKLIST;
    if (!isTaskLike) {
      counters.unknownTaskTypes += 1;
    }
    const checklistItems = (checklistChildrenByParent.get(record.sourceId) ?? [])
      .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
      .map((item) => {
        checklistItemIds.add(item.sourceId);
        return {
          id: uuidv4(),
          title: item.title || DGT_TASK_FALLBACK,
          isCompleted: Boolean(item.completedAt),
        };
      });
    const parentRecord = record.parentId ? recordMap.get(record.parentId) : undefined;
    const projectSourceId = parentRecord?.type === DGT_TYPE_PROJECT ? parentRecord.sourceId : undefined;
    const baseTask = buildTaskBase(record);
    parsedTasks.push({
      ...baseTask,
      projectSourceId,
      checklist: checklistItems,
    });
  });

  records
    .filter((record) => record.type === DGT_TYPE_CHECKLIST_ITEM && !checklistItemIds.has(record.sourceId))
    .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
    .forEach((record) => {
      counters.orphanChecklistItems += 1;
      const parentRecord = record.parentId ? recordMap.get(record.parentId) : undefined;
      const projectSourceId = parentRecord?.type === DGT_TYPE_PROJECT ? parentRecord.sourceId : undefined;
      parsedTasks.push({
        ...buildTaskBase(record),
        projectSourceId,
        checklist: [],
      });
    });

  if (parsedProjects.length === 0 && parsedTasks.length === 0) {
    counters.emptyExports += 1;
  }

  return {
    areas: parsedAreas,
    projects: parsedProjects,
    tasks: parsedTasks,
    warnings: buildWarnings(counters),
  };
};

const buildPreview = (fileName: string, parsedData: ParsedDgtImportData): DgtImportPreview => {
  const taskCountByProject = new Map<number, number>();
  parsedData.tasks.forEach((task) => {
    if (!task.projectSourceId) return;
    taskCountByProject.set(task.projectSourceId, (taskCountByProject.get(task.projectSourceId) ?? 0) + 1);
  });
  const areaNameById = new Map(parsedData.areas.map((area) => [area.sourceId, area.name]));
  const projects = parsedData.projects.map((project) => ({
    name: project.name,
    areaName: project.areaSourceId ? areaNameById.get(project.areaSourceId) : undefined,
    taskCount: taskCountByProject.get(project.sourceId) ?? 0,
  }));
  const checklistItemCount = parsedData.tasks.reduce((sum, task) => sum + task.checklist.length, 0);
  const recurringCount = parsedData.tasks.reduce((sum, task) => sum + (task.recurrence ? 1 : 0), 0);
  const standaloneTaskCount = parsedData.tasks.filter((task) => !task.projectSourceId).length;
  return {
    fileName,
    areaCount: parsedData.areas.length,
    projectCount: parsedData.projects.length,
    taskCount: parsedData.tasks.length,
    checklistItemCount,
    recurringCount,
    standaloneTaskCount,
    projects,
    warnings: parsedData.warnings,
  };
};

const parseRawDgtExport = (text: string, counters: DgtWarningCounters): ParsedDgtImportData => {
  const payload = JSON.parse(sanitizeJsonText(text));
  const record = toRecord(payload);
  if (!record) {
    throw new Error('The selected DGT export is not a JSON object.');
  }
  return parseDgtPayload(record, counters);
};

export const parseDgtImportSource = (input: DgtFileInput): DgtImportParseResult => {
  const fileName = basename(input.fileName);
  const counters = createWarningCounters();
  const bytes = toUint8Array(input.bytes);

  try {
    let parsedData: ParsedDgtImportData | null = null;
    if (bytes && isZipBytes(bytes)) {
      const entries = unzipSync(bytes);
      for (const [entryName, entryBytes] of Object.entries(entries)) {
        const lowerName = entryName.toLowerCase();
        if (!entryName || entryName.endsWith('/')) continue;
        if (lowerName.endsWith('.zip')) {
          counters.nestedZipFiles += 1;
          continue;
        }
        if (!lowerName.endsWith('.json')) {
          counters.nonJsonEntries += 1;
          continue;
        }
        if (parsedData) continue;
        try {
          parsedData = parseRawDgtExport(decodeTextBytes(entryBytes), counters);
        } catch {
          counters.invalidJsonFiles += 1;
        }
      }
      if (!parsedData) {
        const warnings = buildWarnings(counters);
        return {
          valid: false,
          parsedData: null,
          preview: null,
          warnings,
          errors: ['No importable DGT JSON export was found in the selected archive.'],
        };
      }
      const warnings = buildWarnings(counters);
      parsedData.warnings = warnings;
      if (parsedData.projects.length === 0 && parsedData.tasks.length === 0) {
        return {
          valid: false,
          parsedData: null,
          preview: null,
          warnings,
          errors: ['No importable DGT tasks or projects were found in the selected file.'],
        };
      }
      return {
        valid: true,
        parsedData,
        preview: buildPreview(fileName, parsedData),
        warnings,
        errors: [],
      };
    }

    const text = input.text ?? (bytes ? decodeTextBytes(bytes) : '');
    const parsedTextResult = parseRawDgtExport(text, counters);
    const warnings = buildWarnings(counters);
    parsedTextResult.warnings = warnings;
    if (parsedTextResult.projects.length === 0 && parsedTextResult.tasks.length === 0) {
      return {
        valid: false,
        parsedData: null,
        preview: null,
        warnings,
        errors: ['No importable DGT tasks or projects were found in the selected file.'],
      };
    }
    return {
      valid: true,
      parsedData: parsedTextResult,
      preview: buildPreview(fileName, parsedTextResult),
      warnings,
      errors: [],
    };
  } catch (error) {
    const warnings = buildWarnings(counters);
    return {
      valid: false,
      parsedData: null,
      preview: null,
      warnings,
      errors: [error instanceof Error && error.message ? error.message : 'Failed to parse the DGT export.'],
    };
  }
};
