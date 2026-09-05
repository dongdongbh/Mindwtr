import {
  buildTaskFocusEligibilityContext,
  CloudHttpError,
  cloudGetJson,
  cloudGetJsonWithMetadata,
  cloudRequestJson,
  filterTasksBySearch,
  getTaskFocusEligibility,
  normalizeCloudUrl,
  PRIORITY_RANK,
  taskMatchesQuery,
  type AppData,
  type RelativeStartOffset,
} from '@mindwtr/core';

import { NotFoundError, ValidationError } from './errors.js';
import { filterUndefined } from './filter-undefined.js';
import {
  MAX_TASK_LIST_LIMIT,
  MAX_TASK_QUICK_ADD_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  normalizeNullableTaskRecurrence,
  normalizeNullableTaskRelativeStartOffset,
  normalizeNullableTaskRepeatReminderMinutes,
  normalizeNullableTaskTimeSpentMinutes,
  normalizeNullableTaskTokens,
  normalizeOptionalTaskRecurrence,
  normalizeOptionalTaskRelativeStartOffset,
  normalizeOptionalTaskRepeatReminderMinutes,
  normalizeOptionalTaskTimeSpentMinutes,
  normalizeOptionalTaskTokens,
} from './input-validation.js';
import type {
  AddAreaInput,
  AddPersonInput,
  AddProjectInput,
  AddSectionInput,
  MindwtrService,
  RenamePersonInput,
  UpdateAreaInput,
  UpdatePersonInput,
  UpdateProjectInput,
  UpdateSectionInput,
} from './service.js';
import type {
  AddTaskInput,
  Area,
  GetPersonInput,
  GetProjectInput,
  GetSectionInput,
  GetTaskInput,
  ListPeopleInput,
  ListSectionsInput,
  ListTasksInput,
  Person,
  Project,
  Section,
  Task,
  TaskRow,
  UpdateTaskInput,
} from './queries.js';
import { pickDefinedTaskFields, TASK_CREATE_FIELD_NAMES, TASK_PATCH_FIELD_NAMES } from './task-write-fields.js';
import { applyLinkAttachments, buildLinkAttachments } from './link-attachments.js';

export type CloudServiceOptions = {
  url: string;
  token: string;
  allowInsecureHttp?: boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  logInfo?: (message: string, context?: Record<string, unknown>) => void;
};

type CloudData = AppData & { people: NonNullable<AppData['people']> };

const emptyAppData = (): CloudData => ({
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
});

type SoftDeleted = { deletedAt?: string | null };

const CLOUD_ATTACHMENT_PATCH_ATTEMPTS = 3;
const CLOUD_ENTITY_ETAG_REQUIRED_ERROR = 'Attachment link updates require Mindwtr Cloud 1.2.8 or newer; this server did not return a strong entity ETag.';

const isLive = <T extends SoftDeleted>(item: T): boolean => !item.deletedAt;

const normalizeCloudData = (data: AppData | null): CloudData => ({
  ...emptyAppData(),
  ...(data ?? {}),
  tasks: Array.isArray(data?.tasks) ? data.tasks : [],
  projects: Array.isArray(data?.projects) ? data.projects : [],
  sections: Array.isArray(data?.sections) ? data.sections : [],
  areas: Array.isArray(data?.areas) ? data.areas : [],
  people: Array.isArray(data?.people) ? data.people : [],
  settings: data?.settings && typeof data.settings === 'object' ? data.settings : {},
});

const normalizeLimit = (value: number | undefined): number => (
  Number.isFinite(value) ? Math.max(1, Math.min(MAX_TASK_LIST_LIMIT, value as number)) : 200
);

const normalizeOffset = (value: number | undefined): number => (
  Number.isFinite(value) ? Math.max(0, value as number) : 0
);

// Matches the local adapter's `date(dueDate)` (queries.ts), which normalizes to the UTC
// calendar day rather than slicing the string as written - an offset-bearing dueDate
// (e.g. a time zone behind/ahead of UTC near midnight) can name a different day than its
// first 10 characters. Falls back to the raw prefix only when the value doesn't parse.
const dateKey = (value: string | undefined | null): string => {
  if (typeof value !== 'string' || value.length < 10) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : value.slice(0, 10);
};

const taskSortValue = (task: Task, sortBy: NonNullable<ListTasksInput['sortBy']>): string | number => {
  if (sortBy === 'priority') return task.priority ? PRIORITY_RANK[task.priority] ?? 0 : 0;
  const value = task[sortBy];
  return typeof value === 'string' ? value : '';
};

const sortTasks = (tasks: Task[], input: ListTasksInput): Task[] => {
  const sortBy = input.sortBy ?? 'updatedAt';
  const direction = input.sortOrder === 'asc' ? 1 : -1;
  return [...tasks].sort((left, right) => {
    const leftValue = taskSortValue(left, sortBy);
    const rightValue = taskSortValue(right, sortBy);
    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return direction;
    return left.id.localeCompare(right.id);
  });
};

const mapProject = (project: AppData['projects'][number]): Project => ({
  ...project,
  orderNum: (project as Project).orderNum ?? project.order,
});

const mapArea = (area: AppData['areas'][number]): Area => area;
const mapSection = (section: AppData['sections'][number]): Section => section;
const mapPerson = (person: CloudData['people'][number]): Person => person;
const mapTask = (task: AppData['tasks'][number]): TaskRow => task;

const mapCloudError = (error: unknown): unknown => {
  if (error instanceof CloudHttpError) {
    if (error.status === 404) return new NotFoundError(error.message);
    if (error.status === 400 || error.status === 413 || error.status === 422) {
      return new ValidationError(error.message);
    }
  }
  return error;
};

const personWritesUnsupported = (): never => {
  throw new ValidationError('The Mindwtr cloud API does not support person edits yet. Use the local database backend for person changes.');
};

export const createCloudService = (options: CloudServiceOptions): MindwtrService => {
  const url = options.url.trim();
  const token = options.token.trim();
  if (!url) throw new ValidationError('Cloud URL is required');
  if (!token) throw new ValidationError('Cloud token is required');
  const dataUrl = normalizeCloudUrl(url);
  // normalizeCloudUrl always yields a URL ending in /data; the REST resources live beside it.
  const apiBase = dataUrl.replace(/\/data$/i, '');
  const requestOptions = {
    token,
    allowInsecureHttp: options.allowInsecureHttp,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  };

  const readData = async (): Promise<CloudData> => normalizeCloudData(await cloudGetJson<AppData>(dataUrl, requestOptions));

  const request = async <T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> => {
    try {
      return await cloudRequestJson<T>(method, `${apiBase}${path}`, body, {
        ...requestOptions,
        ...(headers ? { headers } : {}),
      }) as T;
    } catch (error) {
      throw mapCloudError(error);
    }
  };

  const readEntityForConditionalPatch = async <T>(
    path: string,
    itemKey: 'task' | 'project',
    label: string,
  ): Promise<{ entity: T; etag: string }> => {
    try {
      const result = await cloudGetJsonWithMetadata<Record<'task' | 'project', T>>(
        `${apiBase}${path}`,
        { ...requestOptions, headers: { 'Accept-Encoding': 'identity' } },
      );
      const entity = result.data?.[itemKey];
      if (!entity) throw new NotFoundError(`${label} not found`);
      const etag = result.metadata.etag;
      if (!etag || !/^"[^"]*"$/.test(etag)) {
        throw new Error(CLOUD_ENTITY_ETAG_REQUIRED_ERROR);
      }
      return { entity, etag };
    } catch (error) {
      throw mapCloudError(error);
    }
  };

  const conditionalAttachmentPatch = async <T extends SoftDeleted>(
    path: string,
    itemKey: 'task' | 'project',
    label: string,
    staticPatch: Record<string, unknown>,
    links: Exclude<UpdateTaskInput['attachments'], undefined>,
  ): Promise<T> => {
    for (let attempt = 1; attempt <= CLOUD_ATTACHMENT_PATCH_ATTEMPTS; attempt += 1) {
      const current = await readEntityForConditionalPatch<T & { attachments?: Task['attachments'] }>(
        path,
        itemKey,
        label,
      );
      try {
        const result = await request<Record<'task' | 'project', T>>(
          'PATCH',
          path,
          {
            ...staticPatch,
            attachments: applyLinkAttachments(current.entity.attachments, links),
          },
          { 'If-Match': current.etag },
        );
        options.logInfo?.('MCP attachment link replacement committed', {
          releaseCheck: 'v1.2.8/mcp-attachment-link-guard',
          backend: 'cloud',
          entity: itemKey,
        });
        return result[itemKey];
      } catch (error) {
        if (!(error instanceof CloudHttpError) || error.status !== 412) throw error;
        if (attempt === CLOUD_ATTACHMENT_PATCH_ATTEMPTS) {
          throw new Error(`${label} changed during attachment link update after ${CLOUD_ATTACHMENT_PATCH_ATTEMPTS} attempts; refresh and retry.`);
        }
      }
    }
    throw new Error(`${label} attachment link update failed`);
  };

  const deleteEntity = async <T extends SoftDeleted & { id: string }>(
    path: string,
    id: string,
    pickCollection: (data: CloudData) => T[],
    label: string,
  ): Promise<T> => {
    await request('DELETE', `${path}/${encodeURIComponent(id)}`);
    const data = await readData();
    const entity = pickCollection(data).find((item) => item.id === id);
    if (!entity) throw new NotFoundError(`${label} not found: ${id}`);
    return entity;
  };

  const findTask = async (input: GetTaskInput): Promise<TaskRow> => {
    const data = await readData();
    const task = data.tasks.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!task) throw new NotFoundError(`Task not found: ${input.id}`);
    return mapTask(task);
  };

  const findProject = async (input: GetProjectInput): Promise<Project> => {
    const data = await readData();
    const project = data.projects.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!project) throw new NotFoundError(`Project not found: ${input.id}`);
    return mapProject(project);
  };

  const findSection = async (input: GetSectionInput): Promise<Section> => {
    const data = await readData();
    const section = data.sections.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!section) throw new NotFoundError(`Section not found: ${input.id}`);
    return mapSection(section);
  };

  const findPerson = async (input: GetPersonInput): Promise<Person> => {
    const data = await readData();
    const person = data.people.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!person) throw new NotFoundError(`Person not found: ${input.id}`);
    return mapPerson(person);
  };

  return {
    listTasks: async (input) => {
      const data = await readData();
      const dueDateFrom = dateKey(input.dueDateFrom);
      const dueDateTo = dateKey(input.dueDateTo);
      // mindwtr_list_tasks has no default done/archived hiding (unlike the cloud REST
      // API's GET /v1/tasks) - opt out of taskMatchesQuery's archived default explicitly
      // via includeArchived rather than special-casing this surface's own default.
      const filtered = data.tasks.filter((task) => {
        if (!taskMatchesQuery(task, {
          status: input.status,
          projectId: input.projectId,
          includeDeleted: input.includeDeleted,
          includeArchived: true,
          isFocusedToday: input.isFocusedToday,
        })) return false;
        const due = dateKey(task.dueDate);
        if (dueDateFrom && (!due || due < dueDateFrom)) return false;
        if (dueDateTo && (!due || due > dueDateTo)) return false;
        return true;
      });
      // Same operator language (status:/context:/due:<=7d/negation/quotes) as the local
      // adapter (queries.ts) - both route through core's filterTasksBySearch.
      const searched = input.search ? filterTasksBySearch(filtered, data.projects, input.search) : filtered;
      // GTD availability, same as the local adapter: derived from the WHOLE task/project
      // set (a sequential project's slot depends on tasks outside this page/filter), not
      // re-derived per platform - see getTaskFocusEligibility's own doc comment.
      const viewed = input.view ? (() => {
        const context = buildTaskFocusEligibilityContext({ tasks: data.tasks, projects: data.projects });
        const wanted = input.view === 'blocked' ? 'sequential' : input.view === 'deferred' ? 'deferred' : 'eligible';
        return searched.filter((task) => getTaskFocusEligibility(task, { tasks: data.tasks, ...context }).reason === wanted);
      })() : searched;
      const offset = normalizeOffset(input.offset);
      return sortTasks(viewed, input).slice(offset, offset + normalizeLimit(input.limit)).map(mapTask);
    },
    listProjects: async () => {
      const data = await readData();
      return data.projects.filter(isLive).map(mapProject);
    },
    listSections: async (input: ListSectionsInput = {}) => {
      const data = await readData();
      return data.sections
        .filter((section) => (input.includeDeleted || isLive(section)) && (!input.projectId || section.projectId === input.projectId))
        .sort((left, right) => (
          left.projectId.localeCompare(right.projectId)
          || (left.order ?? 0) - (right.order ?? 0)
          || left.title.localeCompare(right.title)
        ))
        .map(mapSection);
    },
    listAreas: async () => {
      const data = await readData();
      return data.areas
        .filter(isLive)
        .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || right.updatedAt.localeCompare(left.updatedAt))
        .map(mapArea);
    },
    listPeople: async (input: ListPeopleInput = {}) => {
      const data = await readData();
      return data.people
        .filter((person) => input.includeDeleted || isLive(person))
        .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || right.updatedAt.localeCompare(left.updatedAt))
        .map(mapPerson);
    },
    getTask: findTask,
    getProject: findProject,
    getSection: findSection,
    getPerson: findPerson,
    addTask: async (input: AddTaskInput) => {
      const hasTitle = typeof input.title === 'string' && input.title.trim().length > 0;
      const hasQuickAdd = typeof input.quickAdd === 'string' && input.quickAdd.trim().length > 0;
      if (!hasTitle && !hasQuickAdd) throw new ValidationError('Either title or quickAdd is required');
      if (hasTitle && hasQuickAdd) throw new ValidationError('Provide either title or quickAdd, not both');
      if (hasTitle && input.title!.trim().length > MAX_TASK_TITLE_LENGTH) {
        throw new ValidationError(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
      }
      if (hasQuickAdd && input.quickAdd!.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
        throw new ValidationError(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`);
      }
      const props = filterUndefined({
        // Every other create-writable Task field (checklist, areaId, reviewAt,
        // isFocusedToday, taskMode, ...) is derived from TASK_CREATE_FIELD_NAMES — see
        // task-write-fields.ts. Spread first so the explicit, semantically-normalized
        // overrides below win for the three fields that need more than a raw pass-through.
        ...pickDefinedTaskFields(TASK_CREATE_FIELD_NAMES, input),
        status: input.status,
        projectId: input.projectId,
        sectionId: input.sectionId,
        dueDate: input.dueDate,
        startTime: input.startTime,
        recurrence: normalizeOptionalTaskRecurrence(input.recurrence),
        contexts: normalizeOptionalTaskTokens('contexts', input.contexts),
        tags: normalizeOptionalTaskTokens('tags', input.tags),
        description: input.description,
        priority: input.priority,
        energyLevel: input.energyLevel,
        assignedTo: input.assignedTo,
        timeEstimate: input.timeEstimate,
        relativeStartOffset: normalizeOptionalTaskRelativeStartOffset(input.relativeStartOffset),
        timeSpentMinutes: normalizeOptionalTaskTimeSpentMinutes(input.timeSpentMinutes),
        repeatReminderMinutes: normalizeOptionalTaskRepeatReminderMinutes(input.repeatReminderMinutes),
        attachments: buildLinkAttachments(input.attachments),
      });
      const body = hasQuickAdd ? { input: input.quickAdd, props } : { title: input.title, props };
      const result = await request<{ task: AppData['tasks'][number] }>('POST', '/tasks', body);
      return mapTask(result.task);
    },
    updateTask: async (input: UpdateTaskInput) => {
      // null clears a field on the cloud API (undefined keys are dropped by JSON), so pass nulls through.
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.status !== undefined) patch.status = input.status;
      if (input.projectId !== undefined) patch.projectId = input.projectId;
      if (input.sectionId !== undefined) patch.sectionId = input.sectionId;
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
      if (input.startTime !== undefined) patch.startTime = input.startTime;
      if (input.recurrence !== undefined) {
        patch.recurrence = normalizeNullableTaskRecurrence(input.recurrence);
      }
      if (input.contexts !== undefined) patch.contexts = normalizeNullableTaskTokens('contexts', input.contexts) ?? [];
      if (input.tags !== undefined) patch.tags = normalizeNullableTaskTokens('tags', input.tags) ?? [];
      if (input.description !== undefined) patch.description = input.description;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.energyLevel !== undefined) patch.energyLevel = input.energyLevel;
      if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo;
      if (input.timeEstimate !== undefined) patch.timeEstimate = input.timeEstimate;
      // Every other patch-writable Task field (reviewAt, isFocusedToday, checklist, areaId,
      // order, boardOrder, focusOrder, ...) is derived from TASK_PATCH_FIELD_NAMES — see
      // task-write-fields.ts. Adding a synced field there needs no edit here.
      for (const name of TASK_PATCH_FIELD_NAMES) {
        const value = (input as Record<string, unknown>)[name];
        if (value === undefined) continue;
        if (name === 'relativeStartOffset') {
          patch.relativeStartOffset = normalizeNullableTaskRelativeStartOffset(value as RelativeStartOffset | null);
        } else if (name === 'timeSpentMinutes') {
          patch.timeSpentMinutes = normalizeNullableTaskTimeSpentMinutes(value as number | null);
        } else if (name === 'repeatReminderMinutes') {
          patch.repeatReminderMinutes = normalizeNullableTaskRepeatReminderMinutes(value as number | null);
        } else {
          patch[name] = value;
        }
      }
      if (input.attachments !== undefined) {
        const task = await conditionalAttachmentPatch<AppData['tasks'][number]>(
          `/tasks/${encodeURIComponent(input.id)}`,
          'task',
          'Task',
          patch,
          input.attachments,
        );
        return mapTask(task);
      }
      const result = await request<{ task: AppData['tasks'][number] }>('PATCH', `/tasks/${encodeURIComponent(input.id)}`, patch);
      return mapTask(result.task);
    },
    completeTask: async (id: string) => {
      const result = await request<{ task: AppData['tasks'][number] }>('POST', `/tasks/${encodeURIComponent(id)}/complete`);
      return mapTask(result.task);
    },
    deleteTask: async (id: string) => deleteEntity('/tasks', id, (data) => data.tasks, 'Task'),
    restoreTask: async (_id: string) => {
      throw new ValidationError('The Mindwtr cloud API does not support restoring deleted tasks. Restore it from a Mindwtr app or use the local database backend.');
    },
    addProject: async (input: AddProjectInput) => {
      const result = await request<{ project: AppData['projects'][number] }>('POST', '/projects', {
        title: input.title,
        props: filterUndefined({
          color: input.color,
          status: input.status,
          areaId: input.areaId ?? undefined,
          isSequential: input.isSequential,
          isFocused: input.isFocused,
          dueDate: input.dueDate ?? undefined,
          startDate: input.startDate ?? undefined,
          reviewAt: input.reviewAt ?? undefined,
          supportNotes: input.supportNotes ?? undefined,
          attachments: buildLinkAttachments(input.attachments),
        }),
      });
      return mapProject(result.project);
    },
    updateProject: async (input: UpdateProjectInput) => {
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.color !== undefined) patch.color = input.color;
      if (input.status !== undefined) patch.status = input.status;
      if (input.areaId !== undefined) patch.areaId = input.areaId;
      if (input.isSequential !== undefined) patch.isSequential = input.isSequential;
      if (input.isFocused !== undefined) patch.isFocused = input.isFocused;
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
      if (input.startDate !== undefined) patch.startDate = input.startDate;
      if (input.reviewAt !== undefined) patch.reviewAt = input.reviewAt;
      if (input.supportNotes !== undefined) patch.supportNotes = input.supportNotes;
      if (input.attachments !== undefined) {
        const project = await conditionalAttachmentPatch<AppData['projects'][number]>(
          `/projects/${encodeURIComponent(input.id)}`,
          'project',
          'Project',
          patch,
          input.attachments,
        );
        return mapProject(project);
      }
      const result = await request<{ project: AppData['projects'][number] }>('PATCH', `/projects/${encodeURIComponent(input.id)}`, patch);
      return mapProject(result.project);
    },
    deleteProject: async (id: string) => mapProject(await deleteEntity('/projects', id, (data) => data.projects, 'Project')),
    addSection: async (input: AddSectionInput) => {
      const result = await request<{ section: AppData['sections'][number] }>('POST', '/sections', {
        title: input.title,
        projectId: input.projectId,
        props: filterUndefined({
          description: input.description ?? undefined,
          order: input.order,
          isCollapsed: input.isCollapsed,
        }),
      });
      return mapSection(result.section);
    },
    updateSection: async (input: UpdateSectionInput) => {
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.order !== undefined) patch.order = input.order;
      if (input.isCollapsed !== undefined) patch.isCollapsed = input.isCollapsed;
      const result = await request<{ section: AppData['sections'][number] }>('PATCH', `/sections/${encodeURIComponent(input.id)}`, patch);
      return mapSection(result.section);
    },
    deleteSection: async (id: string) => deleteEntity('/sections', id, (data) => data.sections, 'Section'),
    addArea: async (input: AddAreaInput) => {
      const result = await request<{ area: AppData['areas'][number] }>('POST', '/areas', {
        name: input.name,
        props: filterUndefined({
          color: input.color,
          icon: input.icon,
        }),
      });
      return mapArea(result.area);
    },
    updateArea: async (input: UpdateAreaInput) => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color;
      if (input.icon !== undefined) patch.icon = input.icon;
      const result = await request<{ area: AppData['areas'][number] }>('PATCH', `/areas/${encodeURIComponent(input.id)}`, patch);
      return mapArea(result.area);
    },
    deleteArea: async (id: string) => deleteEntity('/areas', id, (data) => data.areas, 'Area'),
    addPerson: async (_input: AddPersonInput) => personWritesUnsupported(),
    updatePerson: async (_input: UpdatePersonInput) => personWritesUnsupported(),
    renamePerson: async (_input: RenamePersonInput) => personWritesUnsupported(),
    deletePerson: async (_id: string) => personWritesUnsupported(),
    close: async () => undefined,
  };
};
