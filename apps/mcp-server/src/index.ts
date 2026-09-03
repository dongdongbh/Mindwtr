import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TASK_STATUS_VALUES } from '@mindwtr/core';
import * as z from 'zod';

import { createCloudService } from './cloud-service.js';
import { getMindwtrToolErrorCode, ReadOnlyError, ValidationError } from './errors.js';
import { parseArgs, parseBooleanFlag, readStringFlag, type FlagEnv, type FlagMap } from './flags.js';
import {
  createMindwtrHttpServer,
  resolveHttpConfig,
  startHttpServer,
  type HttpServerConfig,
} from './http-server.js';
import {
  isoDateLikeSchema,
  MAX_AREA_NAME_LENGTH,
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
  taskRecurrenceInputSchema,
} from './input-validation.js';
import { createService, type MindwtrService } from './service.js';
import type {
  AddTaskInput,
  TaskGeneratedCreateFields,
  TaskGeneratedPatchFields,
  TaskStatus,
  UpdateTaskInput,
} from './queries.js';
import { buildTaskCreateFieldsShape, buildTaskUpdateFieldsShape } from './task-field-schemas.js';

export { parseArgs, parseBooleanFlag } from './flags.js';
export { isAuthorizedBearerToken, resolveHttpConfig, type HttpServerConfig } from './http-server.js';

const resolvePackageVersion = (): string => {
  try {
    const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version;
    }
  } catch {
    // Fall back to a valid implementation version if package metadata is unavailable.
  }
  return '0.0.0';
};

type LogLevel = 'info' | 'error';
type LogEntry = {
  ts: string;
  level: LogLevel;
  scope: 'mcp';
  message: string;
  context?: Record<string, unknown>;
};

const writeLog = (entry: LogEntry) => {
  const line = `${JSON.stringify(entry)}\n`;
  process.stderr.write(line);
};

export const logError = (message: string, error?: unknown) => {
  const context: Record<string, unknown> = {};
  if (error instanceof Error) {
    context.error = error.message;
    if (error.stack) context.stack = error.stack;
  } else if (error !== undefined) {
    context.error = String(error);
  }
  writeLog({
    ts: new Date().toISOString(),
    level: 'error',
    scope: 'mcp',
    message,
    context: Object.keys(context).length ? context : undefined,
  });
};

const logInfo = (message: string, context?: Record<string, unknown>) => {
  writeLog({
    ts: new Date().toISOString(),
    level: 'info',
    scope: 'mcp',
    message,
    context,
  });
};

type McpTextContent = { type: 'text'; text: string };
type McpToolResponse = { content: McpTextContent[]; isError?: boolean };

const createMcpTextResponse = (payload: Record<string, unknown>): McpToolResponse => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const createMcpErrorResponse = (error: unknown): McpToolResponse => {
  const message = error instanceof Error ? error.message : String(error);
  const code = getMindwtrToolErrorCode(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }],
    isError: true,
  };
};

const withMcpErrorHandling = <TInput>(
  scope: string,
  handler: (input: TInput) => Promise<McpToolResponse>,
) => async (input: TInput): Promise<McpToolResponse> => {
  try {
    return await handler(input);
  } catch (error) {
    logError(`Tool execution failed: ${scope}`, error);
    return createMcpErrorResponse(error);
  }
};

export const resolveServerModeFlags = (flags: FlagMap) => {
  const allowWrite = parseBooleanFlag(flags.write, 'write') ?? false;
  const explicitReadonly = parseBooleanFlag(flags.readonly, 'readonly');
  const keepAlive = !(
    (parseBooleanFlag(flags.nowait, 'nowait') ?? false)
    || (parseBooleanFlag(flags.noWait, 'nowait') ?? false)
  );
  return {
    allowWrite,
    readonly: explicitReadonly ?? !allowWrite,
    keepAlive,
  };
};

type LocalServerConfig = {
  backend: 'local';
  dbPath?: string;
  readonly: boolean;
  keepAlive: boolean;
  http?: HttpServerConfig;
};

type CloudServerConfig = {
  backend: 'cloud';
  cloudUrl: string;
  cloudToken: string;
  allowInsecureHttp: boolean;
  readonly: boolean;
  keepAlive: boolean;
  http?: HttpServerConfig;
};

export type ServerConfig = LocalServerConfig | CloudServerConfig;

export const resolveServerConfig = (
  flags: FlagMap,
  env: FlagEnv = process.env,
): ServerConfig => {
  const { readonly, keepAlive } = resolveServerModeFlags(flags);
  const cloudUrl = readStringFlag(flags, 'cloud-url', 'cloudUrl') ?? env.MINDWTR_MCP_CLOUD_URL;
  const cloudToken = readStringFlag(flags, 'cloud-token', 'cloudToken') ?? env.MINDWTR_MCP_CLOUD_TOKEN;
  const http = resolveHttpConfig(flags, env);

  if (cloudUrl || cloudToken) {
    if (!cloudUrl) throw new ValidationError('Cloud URL is required for Cloud MCP mode');
    if (!cloudToken) throw new ValidationError('Cloud token is required for Cloud MCP mode');
    return {
      backend: 'cloud',
      cloudUrl,
      cloudToken,
      allowInsecureHttp: parseBooleanFlag(
        flags['cloud-allow-insecure-http']
        ?? flags.cloudAllowInsecureHttp
        ?? env.MINDWTR_MCP_CLOUD_ALLOW_INSECURE_HTTP,
        'cloud-allow-insecure-http'
      ) ?? false,
      readonly,
      keepAlive,
      ...(http ? { http } : {}),
    };
  }

  return {
    backend: 'local',
    dbPath: readStringFlag(flags, 'db'),
    readonly,
    keepAlive,
    ...(http ? { http } : {}),
  };
};

// Derived from core's own TASK_STATUS_VALUES (task-status.ts) rather than hand-written, so
// this can't drift from the status list core, the cloud API, and every other status check
// share (server-validation.ts's asStatus/validateAppData use the same export).
const taskStatusSchema = z.enum(TASK_STATUS_VALUES as [TaskStatus, ...TaskStatus[]]);
const taskStatusOrAllSchema = z.enum(
  [...TASK_STATUS_VALUES, 'all'] as unknown as [TaskStatus | 'all', ...(TaskStatus | 'all')[]]
);
const projectStatusSchema = z.enum(['active', 'someday', 'waiting', 'archived']);
const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
const timeEstimateSchema = z.union([
  z.enum(['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+']),
  z.string().refine((value) => {
    const minutes = value.startsWith('custom:') ? value.slice('custom:'.length) : '';
    const parsed = Number(minutes);
    return /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(minutes)
      && Number.isFinite(parsed)
      && parsed >= 1;
  }, 'Custom time estimates must use custom:<positive minutes>'),
]);
const taskTokenSchema = z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH);

const listTasksSchema = z.object({
  status: taskStatusOrAllSchema.optional(),
  projectId: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_TASK_LIST_LIMIT).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  search: z.string().max(512).optional(),
  dueDateFrom: isoDateLikeSchema.optional(),
  dueDateTo: isoDateLikeSchema.optional(),
  isFocusedToday: z.boolean().optional(),
  view: z.enum(['available', 'deferred', 'blocked']).optional().describe(
    "GTD availability: 'available' = actionable right now (a next action, or a task whose review date has come due, in an active project, past any start date, and not waiting behind an earlier step of a sequential project); 'deferred' = start date still in the future; 'blocked' = an earlier step in a sequential project holds the slot.",
  ),
  sortBy: z.enum(['updatedAt', 'createdAt', 'dueDate', 'title', 'priority']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

// Note: Don't use .refine() as it breaks MCP SDK's JSON schema conversion
export const addTaskSchema = z.object({
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional().describe('Task title'),
  quickAdd: z.string().optional().describe('Quick-add string with natural language parsing (e.g. "Buy milk @errands #shopping /due:tomorrow +ProjectName")'),
  status: taskStatusSchema.optional().describe('Task status: inbox, next, waiting, someday, reference, done, archived'),
  projectId: z.string().optional().describe('Project ID to assign the task to'),
  sectionId: z.string().optional().describe('Project section ID to assign the task to'),
  dueDate: isoDateLikeSchema.optional().describe('Due date in ISO format'),
  startTime: isoDateLikeSchema.optional().describe('Start time in ISO format'),
  recurrence: taskRecurrenceInputSchema.optional().describe('Recurrence object or RFC 5545 RRULE string'),
  contexts: z.array(taskTokenSchema).optional().describe('Context tags (e.g. ["@home", "@work"])'),
  tags: z.array(taskTokenSchema).optional().describe('Tags (e.g. ["#urgent", "#personal"])'),
  description: z.string().optional().describe('Task description/notes'),
  priority: taskPrioritySchema.optional().describe('Priority level: low, medium, high, urgent'),
  energyLevel: z.enum(['low', 'medium', 'high']).optional().describe('Energy level: low, medium, high'),
  assignedTo: z.string().optional().describe('Person this task is assigned to or waiting for'),
  timeEstimate: timeEstimateSchema.optional().describe('Time estimate preset or custom:<positive minutes>'),
  // Every other create-writable Task field (checklist, areaId, reviewAt, isFocusedToday,
  // taskMode, relativeStartOffset, location, ...) is derived from TASK_SYNC_FIELD_SCHEMA —
  // see task-write-fields.ts/task-field-schemas.ts. Adding a synced field there needs no
  // edit here.
  ...buildTaskCreateFieldsShape(),
});
const normalizeAddTaskInput = (data: z.infer<typeof addTaskSchema>) => {
  const hasTitle = typeof data.title === 'string' && data.title.trim().length > 0;
  const hasQuickAdd = typeof data.quickAdd === 'string' && data.quickAdd.trim().length > 0;
  if (!hasTitle && !hasQuickAdd) {
    throw new ValidationError('Either title or quickAdd is required');
  }
  if (hasTitle && hasQuickAdd) {
    throw new ValidationError('Provide either title or quickAdd, not both');
  }
  if (hasTitle && data.title!.trim().length > MAX_TASK_TITLE_LENGTH) {
    throw new ValidationError(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
  if (hasQuickAdd && data.quickAdd!.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
    throw new ValidationError(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`);
  }
  // buildTaskCreateFieldsShape() returns a generic Record<string, ZodTypeAny>, so z.infer
  // can't see the specific generated field names/types it spreads into addTaskSchema — cast
  // once to the explicit parallel TS type (queries.ts) that names them. Zod validates these
  // fields correctly at runtime regardless; this only restores static typing for the access
  // below.
  const generated = data as unknown as Partial<TaskGeneratedCreateFields>;
  return {
    ...data,
    recurrence: normalizeOptionalTaskRecurrence(data.recurrence),
    contexts: normalizeOptionalTaskTokens('contexts', data.contexts),
    tags: normalizeOptionalTaskTokens('tags', data.tags),
    relativeStartOffset: normalizeOptionalTaskRelativeStartOffset(generated.relativeStartOffset),
    timeSpentMinutes: normalizeOptionalTaskTimeSpentMinutes(generated.timeSpentMinutes),
    repeatReminderMinutes: normalizeOptionalTaskRepeatReminderMinutes(generated.repeatReminderMinutes),
  };
};

const completeTaskSchema = z.object({
  id: z.string(),
});
export const updateTaskSchema = z.object({
  id: z.string(),
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional(),
  status: taskStatusSchema.optional(),
  projectId: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  startTime: isoDateLikeSchema.nullable().optional(),
  recurrence: taskRecurrenceInputSchema.nullable().optional().describe('Recurrence object or RFC 5545 RRULE string; null clears it'),
  contexts: z.array(taskTokenSchema).nullable().optional(),
  tags: z.array(taskTokenSchema).nullable().optional(),
  description: z.string().nullable().optional(),
  priority: taskPrioritySchema.nullable().optional(),
  energyLevel: z.enum(['low', 'medium', 'high']).nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  timeEstimate: timeEstimateSchema.nullable().optional(),
  // Every other patch-writable Task field (reviewAt, isFocusedToday, checklist, areaId,
  // order, boardOrder, focusOrder, ...) is derived from TASK_SYNC_FIELD_SCHEMA — see
  // task-write-fields.ts/task-field-schemas.ts. Adding a synced field there needs no edit
  // here.
  ...buildTaskUpdateFieldsShape(),
});

const normalizeUpdateTaskInput = (data: z.infer<typeof updateTaskSchema>) => {
  // See the matching comment in normalizeAddTaskInput.
  const generated = data as unknown as Partial<{ [K in keyof TaskGeneratedPatchFields]: TaskGeneratedPatchFields[K] | null }>;
  return {
    ...data,
    recurrence: normalizeNullableTaskRecurrence(data.recurrence),
    contexts: normalizeNullableTaskTokens('contexts', data.contexts),
    tags: normalizeNullableTaskTokens('tags', data.tags),
    relativeStartOffset: normalizeNullableTaskRelativeStartOffset(generated.relativeStartOffset),
    timeSpentMinutes: normalizeNullableTaskTimeSpentMinutes(generated.timeSpentMinutes),
    repeatReminderMinutes: normalizeNullableTaskRepeatReminderMinutes(generated.repeatReminderMinutes),
  };
};

const deleteTaskSchema = z.object({
  id: z.string(),
});

const getTaskSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});

const restoreTaskSchema = z.object({
  id: z.string(),
});

const listProjectsSchema = z.object({});
const listAreasSchema = z.object({});
const listPeopleSchema = z.object({
  includeDeleted: z.boolean().optional(),
});
const getProjectSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});
const getPersonSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});

const listSectionsSchema = z.object({
  projectId: z.string().optional(),
  includeDeleted: z.boolean().optional(),
});

const getSectionSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});

const addProjectSchema = z.object({
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH),
  color: z.string().optional(),
  status: projectStatusSchema.optional(),
  areaId: z.string().nullable().optional(),
  isSequential: z.boolean().optional(),
  isFocused: z.boolean().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  startDate: isoDateLikeSchema.nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  supportNotes: z.string().nullable().optional(),
});
const updateProjectSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  color: z.string().nullable().optional(),
  status: projectStatusSchema.optional(),
  areaId: z.string().nullable().optional(),
  isSequential: z.boolean().optional(),
  isFocused: z.boolean().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  startDate: isoDateLikeSchema.nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  supportNotes: z.string().nullable().optional(),
});
const deleteProjectSchema = z.object({
  id: z.string(),
});

const addSectionSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH),
  description: z.string().nullable().optional(),
  order: z.number().int().optional(),
  isCollapsed: z.boolean().optional(),
});

const updateSectionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  description: z.string().nullable().optional(),
  order: z.number().int().optional(),
  isCollapsed: z.boolean().optional(),
});

const deleteSectionSchema = z.object({
  id: z.string(),
});
const addAreaSchema = z.object({
  name: z.string().min(1).max(MAX_AREA_NAME_LENGTH),
  color: z.string().optional(),
  icon: z.string().optional(),
});
const updateAreaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(MAX_AREA_NAME_LENGTH).optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});
const deleteAreaSchema = z.object({
  id: z.string(),
});
const addPersonSchema = z.object({
  name: z.string().min(1).max(MAX_AREA_NAME_LENGTH),
  note: z.string().nullable().optional(),
  referenceLink: z.string().nullable().optional(),
});
const updatePersonSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(MAX_AREA_NAME_LENGTH).optional(),
  note: z.string().nullable().optional(),
  referenceLink: z.string().nullable().optional(),
});
const renamePersonSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(MAX_AREA_NAME_LENGTH),
  updateTasks: z.boolean().optional(),
});
const deletePersonSchema = z.object({
  id: z.string(),
});

export const registerMindwtrTools = (
  server: McpServer,
  service: MindwtrService,
  readonly: boolean,
  options: { readonlyMessage?: string } = {},
) => {
  const withReadonlyMcpErrorHandling = <TInput>(
    scope: string,
    handler: (input: TInput) => Promise<McpToolResponse>,
  ) => withMcpErrorHandling(scope, async (input: TInput) => {
    if (readonly) throw new ReadOnlyError(options.readonlyMessage);
    return await handler(input);
  });

  server.registerTool(
    'mindwtr_list_tasks',
    {
      description: "List tasks from the configured Mindwtr backend. Filter by status, project, date range, today's focus (isFocusedToday), and GTD availability (view). `search` accepts the documented operator language (status:, context:, tag:, project:, due:<=7d, \"quoted phrases\", -negation) as well as plain text; note that a search always excludes deleted tasks, so includeDeleted has no effect when search is set. Supports sorting by various fields.",
      inputSchema: listTasksSchema,
    },
    withMcpErrorHandling('mindwtr_list_tasks', async (input) => {
      const tasks = await service.listTasks({
        ...input,
      });
      return createMcpTextResponse({ tasks });
    }),
  );

  server.registerTool(
    'mindwtr_list_projects',
    {
      description: 'List projects from the configured Mindwtr backend.',
      inputSchema: listProjectsSchema,
    },
    withMcpErrorHandling('mindwtr_list_projects', async () => {
      const projects = await service.listProjects();
      return createMcpTextResponse({ projects });
    }),
  );

  server.registerTool(
    'mindwtr_get_project',
    {
      description: 'Get a single project by ID from the configured Mindwtr backend.',
      inputSchema: getProjectSchema,
    },
    withMcpErrorHandling('mindwtr_get_project', async (input) => {
      const project = await service.getProject({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_list_sections',
    {
      description: 'List project sections from the configured Mindwtr backend. Optionally filter by projectId.',
      inputSchema: listSectionsSchema,
    },
    withMcpErrorHandling('mindwtr_list_sections', async (input) => {
      const sections = await service.listSections(input);
      return createMcpTextResponse({ sections });
    }),
  );

  server.registerTool(
    'mindwtr_get_section',
    {
      description: 'Get a single project section by ID from the configured Mindwtr backend.',
      inputSchema: getSectionSchema,
    },
    withMcpErrorHandling('mindwtr_get_section', async (input) => {
      const section = await service.getSection({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_list_areas',
    {
      description: 'List areas from the configured Mindwtr backend.',
      inputSchema: listAreasSchema,
    },
    withMcpErrorHandling('mindwtr_list_areas', async () => {
      const areas = await service.listAreas();
      return createMcpTextResponse({ areas });
    }),
  );

  server.registerTool(
    'mindwtr_list_people',
    {
      description: 'List managed people from the configured Mindwtr backend.',
      inputSchema: listPeopleSchema,
    },
    withMcpErrorHandling('mindwtr_list_people', async (input) => {
      const people = await service.listPeople(input);
      return createMcpTextResponse({ people });
    }),
  );

  server.registerTool(
    'mindwtr_get_person',
    {
      description: 'Get a single managed person by ID from the configured Mindwtr backend.',
      inputSchema: getPersonSchema,
    },
    withMcpErrorHandling('mindwtr_get_person', async (input) => {
      const person = await service.getPerson({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_add_task',
    {
      description: 'Add a task to the configured Mindwtr backend.',
      inputSchema: addTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_task', async (input) => {
      const normalizedInput = normalizeAddTaskInput(input);
      // buildTaskCreateFieldsShape()'s generic Record<string, ZodTypeAny> return type erases
      // the specific generated field names from z.infer (see normalizeAddTaskInput above), so
      // the merged object needs one cast back to the real shape at this boundary. Zod already
      // validated every field's runtime shape.
      const task = await service.addTask({
        ...normalizedInput,
      } as AddTaskInput);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_update_task',
    {
      description: 'Update a task in the configured Mindwtr backend.',
      inputSchema: updateTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_task', async (input) => {
      // See the matching comment on mindwtr_add_task above.
      const task = await service.updateTask({
        ...normalizeUpdateTaskInput(input),
      } as UpdateTaskInput);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_complete_task',
    {
      description: 'Mark a task as done in the configured Mindwtr backend.',
      inputSchema: completeTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_complete_task', async (input) => {
      const task = await service.completeTask(input.id);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_delete_task',
    {
      description: 'Soft-delete a task in the configured Mindwtr backend.',
      inputSchema: deleteTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_task', async (input) => {
      const task = await service.deleteTask(input.id);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_get_task',
    {
      description: 'Get a single task by ID from the configured Mindwtr backend.',
      inputSchema: getTaskSchema,
    },
    withMcpErrorHandling('mindwtr_get_task', async (input) => {
      const task = await service.getTask({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_restore_task',
    {
      description: 'Restore a soft-deleted task in the configured Mindwtr backend.',
      inputSchema: restoreTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_restore_task', async (input) => {
      const task = await service.restoreTask(input.id);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_add_project',
    {
      description: 'Add a project to the configured Mindwtr backend.',
      inputSchema: addProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_project', async (input) => {
      const project = await service.addProject(input);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_update_project',
    {
      description: 'Update a project in the configured Mindwtr backend.',
      inputSchema: updateProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_project', async (input) => {
      const project = await service.updateProject(input);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_delete_project',
    {
      description: 'Soft-delete a project in the configured Mindwtr backend.',
      inputSchema: deleteProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_project', async (input) => {
      const project = await service.deleteProject(input.id);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_add_section',
    {
      description: 'Add a project-scoped section to the configured Mindwtr backend.',
      inputSchema: addSectionSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_section', async (input) => {
      const section = await service.addSection(input);
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_update_section',
    {
      description: 'Update a project section in the configured Mindwtr backend.',
      inputSchema: updateSectionSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_section', async (input) => {
      const section = await service.updateSection(input);
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_delete_section',
    {
      description: 'Soft-delete a project section in the configured Mindwtr backend. Tasks in the section are kept and moved to no section by core.',
      inputSchema: deleteSectionSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_section', async (input) => {
      const section = await service.deleteSection(input.id);
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_add_area',
    {
      description: 'Add an area to the configured Mindwtr backend.',
      inputSchema: addAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_area', async (input) => {
      const area = await service.addArea(input);
      return createMcpTextResponse({ area });
    }),
  );

  server.registerTool(
    'mindwtr_update_area',
    {
      description: 'Update an area in the configured Mindwtr backend.',
      inputSchema: updateAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_area', async (input) => {
      const area = await service.updateArea(input);
      return createMcpTextResponse({ area });
    }),
  );

  server.registerTool(
    'mindwtr_delete_area',
    {
      description: 'Soft-delete an area in the configured Mindwtr backend.',
      inputSchema: deleteAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_area', async (input) => {
      const area = await service.deleteArea(input.id);
      return createMcpTextResponse({ area });
    }),
  );

  server.registerTool(
    'mindwtr_add_person',
    {
      description: 'Add a managed person to the configured Mindwtr backend.',
      inputSchema: addPersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_person', async (input) => {
      const person = await service.addPerson(input);
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_update_person',
    {
      description: 'Update managed person metadata in the configured Mindwtr backend.',
      inputSchema: updatePersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_person', async (input) => {
      const person = await service.updatePerson(input);
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_rename_person',
    {
      description: 'Rename a managed person. By default, matching task assignees are updated too.',
      inputSchema: renamePersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_rename_person', async (input) => {
      const person = await service.renamePerson(input);
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_delete_person',
    {
      description: 'Soft-delete a managed person in the configured Mindwtr backend.',
      inputSchema: deletePersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_person', async (input) => {
      const person = await service.deletePerson(input.id);
      return createMcpTextResponse({ person });
    }),
  );
};

/**
 * Builds the McpServer + registered tool set shared by both the stdio path and the
 * per-request stateless HTTP path. Each HTTP POST /mcp request gets its own McpServer
 * instance (per the SDK's stateless pattern); the MindwtrService is shared across requests.
 */
export const createMindwtrMcpServer = (service: MindwtrService, config: ServerConfig): McpServer => {
  const server = new McpServer({
    name: 'mindwtr-mcp',
    version: resolvePackageVersion(),
  });

  registerMindwtrTools(server, service, config.readonly, {
    readonlyMessage: config.backend === 'cloud'
      ? 'Cloud MCP mode is read-only by default. Start the server with --write to enable edits.'
      : undefined,
  });

  return server;
};

const attachLifecycleHandlers = (service: MindwtrService, onShutdown?: () => void) => {
  const closeService = async () => {
    onShutdown?.();
    try {
      await service.close();
    } catch (error) {
      logError('Failed to close database connection', error);
    }
  };

  process.on('exit', () => {
    // 'exit' handlers must run synchronously - Node stops the event loop right after this
    // callback returns, so an awaited close here would never actually finish. This is only a
    // best-effort backstop for a process.exit() called from somewhere else; SIGINT/SIGTERM
    // below are what actually wait for the close (and its WAL checkpoint) before exiting.
    void closeService();
  });
  process.on('SIGINT', () => {
    void closeService().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void closeService().finally(() => process.exit(0));
  });
};

export async function startMcpServer(argv: string[] = process.argv.slice(2)) {
  const flags = parseArgs(argv);

  const config = resolveServerConfig(flags);

  const service = config.backend === 'cloud'
    ? createCloudService({
      url: config.cloudUrl,
      token: config.cloudToken,
      allowInsecureHttp: config.allowInsecureHttp,
    })
    : createService({ dbPath: config.dbPath, readonly: config.readonly });

  const httpConfig = config.http;
  if (httpConfig) {
    const httpServer = createMindwtrHttpServer({
      createServer: () => createMindwtrMcpServer(service, config),
      token: httpConfig.token,
      host: httpConfig.host,
      logError,
    });
    attachLifecycleHandlers(service, () => {
      httpServer.close();
    });
    await startHttpServer(httpServer, httpConfig);
    if (httpConfig.weakTokenWarning) {
      logInfo(`Warning: ${httpConfig.weakTokenWarning}`);
    }
    logInfo('HTTP MCP transport listening', {
      host: httpConfig.host,
      port: httpConfig.port,
      backend: config.backend,
      readonly: config.readonly,
    });
    return;
  }

  attachLifecycleHandlers(service);

  const server = createMindwtrMcpServer(service, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (config.keepAlive) {
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    setInterval(() => {}, 1 << 30);
  }
}
