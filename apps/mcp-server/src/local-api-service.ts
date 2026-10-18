import { filterTasksBySearch, PRIORITY_RANK, safeParseDate, TASK_STATUS_VALUES, taskMatchesQuery, TIME_ESTIMATE_OPTIONS } from '@mindwtr/core';
import * as z from 'zod';

import { NotFoundError, ValidationError } from './errors.js';
import {
  isoDateLikeSchema,
  MAX_TASK_LIST_LIMIT,
  MAX_TASK_TITLE_LENGTH,
  MAX_TASK_TOKEN_LENGTH,
  normalizeNullableTaskRecurrence,
  normalizeNullableTaskRelativeStartOffset,
  normalizeNullableTaskRepeatReminderMinutes,
  normalizeNullableTaskTimeSpentMinutes,
  taskRecurrenceInputSchema,
} from './input-validation.js';
import { buildLinkAttachments, linkAttachmentsCreateSchema } from './link-attachments.js';
import type { Area, ListTasksInput, Project, Task, TaskStatus } from './queries.js';
import type { MindwtrService } from './service.js';
import { buildTaskCreateFieldsShape, buildTaskUpdateFieldsShape } from './task-field-schemas.js';

export type LocalApiServiceOptions = {
  url: string;
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  logInfo?: (message: string, context?: Record<string, unknown>) => void;
};

/** Native project writes intentionally expose fewer fields than SQLite/Cloud. */
export const LOCAL_API_UNSUPPORTED_PROJECT_FIELDS = [
  'cancelledAt', 'isFocused', 'dueDate', 'startDate', 'reviewAt', 'supportNotes', 'attachments',
] as const;

export const validateLocalApiUrl = (value: string): string => {
  // Check the spelling before WHATWG URL normalization: it accepts alternate IPv4
  // spellings (127.1, integer/hex hosts) and normalizes them to 127.0.0.1.
  if (typeof value !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value.trim())) {
    throw new ValidationError('Local API URL must be an http(s) origin using literal 127.0.0.1 or [::1], without credentials, path, query, or fragment.');
  }
  try {
    return new URL(value.trim()).origin;
  } catch {
    throw new ValidationError('Invalid Local API URL. Use literal 127.0.0.1 or [::1] and a valid port.');
  }
};

// Keep the actual Rust allowlist explicit. A new generated MCP field must not
// become writable here until local_api.rs implements it.
const TASK_FIELDS = new Set([
  'title', 'status', 'projectId', 'sectionId', 'areaId', 'dueDate', 'startTime',
  'recurrence', 'contexts', 'tags', 'description', 'priority', 'energyLevel',
  'assignedTo', 'timeEstimate', 'taskMode', 'relativeStartOffset', 'showFutureRecurrence',
  'pushCount', 'checklist', 'textDirection', 'location', 'isFocusedToday',
  'timeSpentMinutes', 'suppressMindwtrReminders', 'reminderPolicy', 'repeatReminderMinutes',
  'reviewAt', 'cancelledAt', 'order', 'boardOrder', 'focusOrder', 'attachments',
]);
const taskStatusSchema = z.enum(TASK_STATUS_VALUES as [TaskStatus, ...TaskStatus[]]);
const titleSchema = z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH);
const tokenSchema = z.string().trim().min(1).max(MAX_TASK_TOKEN_LENGTH);
const timeEstimateSchema = z.string().refine((value) => (
  (TIME_ESTIMATE_OPTIONS as readonly string[]).includes(value)
  || (value.startsWith('custom:') && Number.isFinite(Number(value.slice(7))) && Number(value.slice(7)) >= 1)
));
const dedicatedTaskShape = {
  title: titleSchema,
  status: taskStatusSchema,
  projectId: z.string(),
  sectionId: z.string(),
  dueDate: isoDateLikeSchema,
  startTime: isoDateLikeSchema,
  recurrence: taskRecurrenceInputSchema,
  contexts: z.array(tokenSchema),
  tags: z.array(tokenSchema),
  description: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  energyLevel: z.enum(['low', 'medium', 'high']),
  assignedTo: z.string(),
  timeEstimate: timeEstimateSchema,
};

const createTaskShape: Record<string, z.ZodTypeAny> = buildTaskCreateFieldsShape();
const patchTaskShape: Record<string, z.ZodTypeAny> = buildTaskUpdateFieldsShape();
for (const [name, schema] of Object.entries(dedicatedTaskShape)) {
  createTaskShape[name] = schema.optional();
  patchTaskShape[name] = ['title', 'status'].includes(name) ? schema.optional() : schema.nullable().optional();
}
createTaskShape.title = titleSchema;
createTaskShape.attachments = linkAttachmentsCreateSchema.optional();
patchTaskShape.id = z.string().min(1);
const createTaskSchema = z.object(createTaskShape).strict();
const patchTaskSchema = z.object(patchTaskShape).strict();
const projectFieldsShape = {
  color: z.string().refine((value) => value.trim().length > 0).optional(),
  status: z.enum(['active', 'someday', 'waiting', 'archived']).optional(),
  areaId: z.string().trim().min(1).nullable().optional(),
  isSequential: z.boolean().optional(),
};
const createProjectSchema = z.object({ ...projectFieldsShape, title: titleSchema }).strict();
const patchProjectSchema = z.object({ ...projectFieldsShape, title: titleSchema.optional(), id: z.string().min(1) }).strict();
const listTasksSchema = z.object({
  status: taskStatusSchema.or(z.literal('all')).optional(),
  projectId: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  search: z.string().optional(),
  dueDateFrom: isoDateLikeSchema.optional(),
  dueDateTo: isoDateLikeSchema.optional(),
  isFocusedToday: z.boolean().optional(),
  sortBy: z.enum(['updatedAt', 'createdAt', 'dueDate', 'title', 'priority']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
}).strict();
const getEntitySchema = z.object({ id: z.string().min(1), includeDeleted: z.boolean().optional() }).strict();

const parseInput = <T extends z.ZodTypeAny>(schema: T, input: unknown, label: string): z.infer<T> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError(`Invalid or unsupported ${label} input for the desktop Local API.`);
  return parsed.data;
};
const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);
const assertTaskInputsSupported = (input: unknown, creating: boolean): void => {
  const record = asRecord(input);
  if (!record) throw new ValidationError('Invalid task input for the desktop Local API.');
  if (Object.hasOwn(record, 'quickAdd')) throw new ValidationError('Desktop Local API quickAdd is unsupported. Provide an explicit title.');
  if (!creating && Object.hasOwn(record, 'attachments')) {
    throw new ValidationError('Desktop Local API attachment updates are unsupported because conditional concurrency protection is unavailable.');
  }
  for (const name of Object.keys(record)) {
    if (!TASK_FIELDS.has(name) && !(name === 'id' && !creating)) {
      throw new ValidationError('Unsupported task field for the desktop Local API.');
    }
  }
  if (!creating && (record.status === 'done' || record.status === 'archived')) {
    throw new ValidationError('Desktop Local API task updates cannot set done or archived. Use complete_task for completion; archive the task in the app.');
  }
  if (typeof record.cancelledAt === 'string' && record.status !== undefined && record.status !== 'archived') {
    throw new ValidationError('Task cancelledAt cannot be combined with a non-archived status.');
  }
};
const assertProjectInputsSupported = (input: unknown): void => {
  const record = asRecord(input);
  if (record && LOCAL_API_UNSUPPORTED_PROJECT_FIELDS.some((name) => Object.hasOwn(record, name))) {
    throw new ValidationError('Desktop Local API project writes support only title, color, status, areaId, and isSequential. Other project fields are unsupported.');
  }
};
const normalizeTaskProps = (input: Record<string, unknown>, creating: boolean): Record<string, unknown> => {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || name === 'id' || (creating && name === 'title')) continue;
    // Rust expects arrays, not null, when clearing tags or contexts.
    if (name === 'tags' || name === 'contexts') props[name] = value ?? [];
    else if (name === 'recurrence') props[name] = normalizeNullableTaskRecurrence(value as Parameters<typeof normalizeNullableTaskRecurrence>[0]);
    else if (name === 'relativeStartOffset') props[name] = normalizeNullableTaskRelativeStartOffset(value as Parameters<typeof normalizeNullableTaskRelativeStartOffset>[0]);
    else if (name === 'timeSpentMinutes') props[name] = normalizeNullableTaskTimeSpentMinutes(value as number | null);
    else if (name === 'repeatReminderMinutes') props[name] = normalizeNullableTaskRepeatReminderMinutes(value as number | null);
    else if (name === 'attachments') {
      try { props[name] = buildLinkAttachments(value as Parameters<typeof buildLinkAttachments>[0]); } catch {
        throw new ValidationError('Invalid task link attachments for the desktop Local API.');
      }
    }
    else props[name] = value;
  }
  return props;
};

const malformedResponse = (): never => { throw new Error('Desktop Local API returned an invalid response.'); };
const validateEntity = <T extends Task | Project | Area>(value: unknown, kind: 'task' | 'project' | 'area', expectedId?: string): T => {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || !record.id || (expectedId !== undefined && record.id !== expectedId)
    || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || typeof record[kind === 'area' ? 'name' : 'title'] !== 'string') return malformedResponse();
  if (kind === 'task' && (!taskStatusSchema.safeParse(record.status).success
    || !Array.isArray(record.tags) || !record.tags.every((item) => typeof item === 'string')
    || !Array.isArray(record.contexts) || !record.contexts.every((item) => typeof item === 'string'))) return malformedResponse();
  if (kind === 'project' && !z.enum(['active', 'someday', 'waiting', 'archived']).safeParse(record.status).success) return malformedResponse();
  for (const name of ['deletedAt', 'dueDate', 'startTime', 'reviewAt', 'description', 'projectId', 'sectionId']) {
    if (record[name] !== undefined && record[name] !== null && typeof record[name] !== 'string') return malformedResponse();
  }
  return record as T;
};
const localDateKey = (value: string | undefined | null): string => {
  const parsed = safeParseDate(value);
  if (!parsed) return '';
  const year = String(parsed.getFullYear()).padStart(4, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const sortTasks = (tasks: Task[], input: ListTasksInput): Task[] => {
  const sortBy = input.sortBy ?? 'updatedAt';
  const direction = input.sortOrder === 'asc' ? 1 : -1;
  const sortValue = (task: Task): string | number => (
    sortBy === 'priority' ? (task.priority ? PRIORITY_RANK[task.priority] ?? 0 : 0) : task[sortBy] ?? ''
  );
  return [...tasks].sort((left, right) => {
    const a = sortValue(left);
    const b = sortValue(right);
    return a < b ? -direction : a > b ? direction : left.id.localeCompare(right.id);
  });
};
const unsupported = (label: string): never => { throw new ValidationError(`Desktop Local API does not support ${label}.`); };

// This private class distinguishes sanitized errors we produced from fetch/JSON
// errors whose message may include credentials, a raw URL, or response content.
class LocalApiRequestError extends Error {
  constructor(message: string, readonly toolCode?: 'validation_error' | 'not_found') {
    super(message);
  }
}

export const createLocalApiService = (options: LocalApiServiceOptions): MindwtrService => {
  const baseUrl = validateLocalApiUrl(options.url);
  if (typeof options.token !== 'string' || !options.token.trim() || /\s/.test(options.token.trim())) {
    throw new ValidationError('Local API token is required and must not contain whitespace.');
  }
  const authorization = `Bearer ${options.token.trim()}`;
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ValidationError('Local API timeout must be positive.');
  let loggedConnection = false;

  const request = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const writing = method !== 'GET';
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcomeWarning = writing ? ' The write outcome is unknown; check the desktop app before retrying.' : '';
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new LocalApiRequestError(`Desktop Local API request timed out.${outcomeWarning}`));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([fetcher(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), timeout]);
      if (response.status >= 300 && response.status < 400) throw new LocalApiRequestError('Desktop Local API redirects are unsupported.', 'validation_error');
      if (response.status === 401 || response.status === 403) throw new LocalApiRequestError('Desktop Local API token is invalid or expired. Check the token in desktop settings.', 'validation_error');
      if (response.status === 404) throw new LocalApiRequestError('Desktop Local API entity or endpoint not found.', 'not_found');
      if (!response.ok) {
        // Only inspect the known machine code, never put a server body in an error.
        if (response.status === 409) {
          let code: unknown;
          try { code = asRecord(await Promise.race([response.json(), timeout]))?.code; } catch { /* generic conflict below */ }
          if (code === 'recurrence_requires_app') throw new LocalApiRequestError('This recurrence requires completion in the desktop app.', 'validation_error');
          throw new LocalApiRequestError('Desktop Local API rejected a lifecycle conflict. Check the task or project in the app.', 'validation_error');
        }
        if (response.status === 400 || response.status === 422) throw new LocalApiRequestError('Desktop Local API rejected invalid or unsupported input.', 'validation_error');
        if (response.status === 405 || response.status === 501) throw new LocalApiRequestError('This operation is unsupported by the desktop Local API.', 'validation_error');
        throw new LocalApiRequestError(`Desktop Local API rejected the request.${outcomeWarning}`);
      }
      let json: unknown;
      try { json = await Promise.race([response.json(), timeout]); } catch {
        if (timedOut) throw new LocalApiRequestError(`Desktop Local API request timed out.${outcomeWarning}`);
        throw new LocalApiRequestError(`Desktop Local API returned an invalid response.${outcomeWarning}`);
      }
      const result = asRecord(json);
      if (!result) throw new LocalApiRequestError(`Desktop Local API returned an invalid response.${outcomeWarning}`);
      if (!loggedConnection) {
        loggedConnection = true;
        try { options.logInfo?.('Desktop Local API authenticated connection succeeded', { extra: { releaseCheck: 'v1.3.4/mcp-local-api' } }); } catch { /* logging cannot change a completed request */ }
      }
      return result;
    } catch (error) {
      if (timedOut) throw new Error(`Desktop Local API request timed out.${outcomeWarning}`);
      // Preserve only errors constructed here, never fetch errors carrying a URL/token.
      if (error instanceof LocalApiRequestError) {
        if (error.toolCode === 'validation_error') throw new ValidationError(error.message);
        if (error.toolCode === 'not_found') throw new NotFoundError(error.message);
        throw error;
      }
      throw new Error(`Desktop Local API is unavailable. Open the desktop app and enable Local API.${outcomeWarning}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const entity = async <T extends Task | Project | Area>(method: string, path: string, kind: 'task' | 'project' | 'area', body?: unknown, expectedId?: string): Promise<T> => {
    const result = await request(method, path, body);
    try { return validateEntity<T>(result[kind], kind, expectedId); } catch {
      throw new Error(`Desktop Local API returned an invalid response.${method === 'GET' ? '' : ' The write outcome is unknown; check the desktop app before retrying.'}`);
    }
  };
  const entities = async <T extends Task | Project | Area>(path: string, key: 'tasks' | 'projects' | 'areas', kind: 'task' | 'project' | 'area'): Promise<T[]> => {
    const result = await request('GET', path);
    if (!Array.isArray(result[key])) return malformedResponse();
    return result[key].map((value) => validateEntity<T>(value, kind));
  };
  const entityPath = (kind: 'tasks' | 'projects', id: string): string => {
    parseInput(z.string().min(1), id, 'entity ID');
    // Native parse_request_target decodes the entire path before path_segments
    // splits and decodes again. Slashes/percent sequences can alias another ID;
    // '+' also becomes a space on that second decode. Reject them before any
    // request instead of discovering a wrong target after a completed write.
    if (id === '.' || id === '..' || /[/\\%+\p{Cc}]/u.test(id)) {
      throw new ValidationError('Invalid Local API entity ID: path separators, percent escapes, plus signs, and control characters are unsupported.');
    }
    try {
      return `/${kind}/${encodeURIComponent(id)}`;
    } catch {
      throw new ValidationError('Invalid Local API entity ID.');
    }
  };
  const deleteEntity = async <T extends Task | Project>(kind: 'tasks' | 'projects', id: string): Promise<T> => {
    const path = entityPath(kind, id);
    const result = await request('DELETE', path);
    if (result.ok !== true) throw new Error('Desktop Local API returned an invalid deletion response. The write outcome is unknown; check the desktop app before retrying.');
    try { return await entity<T>('GET', path, kind === 'tasks' ? 'task' : 'project', undefined, id); } catch {
      throw new Error('Desktop Local API deletion succeeded, but the deleted entity could not be read. Check the desktop app before retrying.');
    }
  };

  return {
    listTasks: async (input) => {
      if (asRecord(input) && Object.hasOwn(input, 'view')) return unsupported('availability views because section and settings data are unavailable');
      parseInput(listTasksSchema, input, 'task list');
      // The native filter (local_api.rs filter_tasks) only narrows what the Node filter below keeps; it never widens it.
      // Projects and search stay here: the native API has no project filter, and its text query is not core search.
      const query = new URLSearchParams({ all: '1' });
      if (input.includeDeleted) query.set('deleted', '1');
      if (input.status && input.status !== 'all') query.set('status', input.status);
      if (input.isFocusedToday !== undefined) query.set('isFocusedToday', input.isFocusedToday ? '1' : '0');
      const tasks = await entities<Task>(`/tasks?${query}`, 'tasks', 'task');
      const from = localDateKey(input.dueDateFrom);
      const to = localDateKey(input.dueDateTo);
      const filtered = tasks.filter((task) => {
        if (!taskMatchesQuery(task, { status: input.status, projectId: input.projectId, includeDeleted: input.includeDeleted, includeArchived: true, isFocusedToday: input.isFocusedToday })) return false;
        const due = localDateKey(task.dueDate);
        return (!from || Boolean(due && due >= from)) && (!to || Boolean(due && due <= to));
      });
      const searched = input.search ? filterTasksBySearch(filtered, await entities<Project>('/projects', 'projects', 'project'), input.search) : filtered;
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(MAX_TASK_LIST_LIMIT, input.limit as number)) : 200;
      const offset = Number.isFinite(input.offset) ? Math.max(0, input.offset as number) : 0;
      return sortTasks(searched, input).slice(offset, offset + limit);
    },
    listProjects: async () => (await entities<Project>('/projects', 'projects', 'project')).filter((project) => !project.deletedAt).map((project) => ({ ...project, orderNum: project.orderNum ?? project.order })),
    listAreas: async () => (await entities<Area>('/areas', 'areas', 'area')).filter((area) => !area.deletedAt).sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || right.updatedAt.localeCompare(left.updatedAt)),
    getTask: async (input) => {
      parseInput(getEntitySchema, input, 'task');
      const task = await entity<Task>('GET', entityPath('tasks', input.id), 'task', undefined, input.id);
      if (!input.includeDeleted && task.deletedAt) throw new NotFoundError('Task not found.');
      return task;
    },
    getProject: async (input) => {
      parseInput(getEntitySchema, input, 'project');
      const project = await entity<Project>('GET', entityPath('projects', input.id), 'project', undefined, input.id);
      if (!input.includeDeleted && project.deletedAt) throw new NotFoundError('Project not found.');
      return { ...project, orderNum: project.orderNum ?? project.order };
    },
    addTask: async (input) => {
      assertTaskInputsSupported(input, true);
      const parsed = parseInput(createTaskSchema, input, 'task creation');
      return entity<Task>('POST', '/tasks', 'task', { title: parsed.title, props: normalizeTaskProps(parsed, true) });
    },
    updateTask: async (input) => {
      assertTaskInputsSupported(input, false);
      const parsed = parseInput(patchTaskSchema, input, 'task update');
      return entity<Task>('PATCH', entityPath('tasks', input.id), 'task', normalizeTaskProps(parsed, false), input.id);
    },
    completeTask: async (id) => entity<Task>('POST', `${entityPath('tasks', id)}/complete`, 'task', undefined, id),
    restoreTask: async (id) => entity<Task>('POST', `${entityPath('tasks', id)}/restore`, 'task', undefined, id),
    deleteTask: async (id) => deleteEntity<Task>('tasks', id),
    addProject: async (input) => {
      assertProjectInputsSupported(input);
      const { title, ...props } = parseInput(createProjectSchema, input, 'project creation');
      return entity<Project>('POST', '/projects', 'project', { title, props });
    },
    updateProject: async (input) => {
      assertProjectInputsSupported(input);
      const { id, ...patch } = parseInput(patchProjectSchema, input, 'project update');
      return entity<Project>('PATCH', entityPath('projects', id), 'project', patch, id);
    },
    deleteProject: async (id) => deleteEntity<Project>('projects', id),
    listSections: async () => unsupported('section tools'),
    getSection: async () => unsupported('section tools'),
    addSection: async () => unsupported('section tools'),
    updateSection: async () => unsupported('section tools'),
    deleteSection: async () => unsupported('section tools'),
    listPeople: async () => unsupported('people tools'),
    getPerson: async () => unsupported('people tools'),
    addPerson: async () => unsupported('people tools'),
    updatePerson: async () => unsupported('people tools'),
    renamePerson: async () => unsupported('people tools'),
    deletePerson: async () => unsupported('people tools'),
    addArea: async () => unsupported('area writes'),
    updateArea: async () => unsupported('area writes'),
    deleteArea: async () => unsupported('area writes'),
    close: async () => {},
  };
};
