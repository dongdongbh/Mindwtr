#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { getMindwtrToolErrorCode, ReadOnlyError, ValidationError } from './errors.js';
import {
  MAX_TASK_QUICK_ADD_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  normalizeNullableTaskTokens,
  normalizeOptionalTaskTokens,
} from './input-validation.js';
import { createService, type MindwtrService } from './service.js';

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
  if (entry.level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

const logError = (message: string, error?: unknown) => {
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

export const parseArgs = (argv: string[]) => {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const keyValue = arg.slice(2);
    const equalsIndex = keyValue.indexOf('=');
    if (equalsIndex > 0) {
      const key = keyValue.slice(0, equalsIndex);
      const value = keyValue.slice(equalsIndex + 1);
      if (key) {
        flags[key] = value;
      }
      continue;
    }
    const key = keyValue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
};

export const parseBooleanFlag = (value: string | boolean | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return true;
};

export const resolveServerModeFlags = (flags: Record<string, string | boolean>) => {
  const allowWrite = parseBooleanFlag(flags.write) ?? false;
  const explicitReadonly = parseBooleanFlag(flags.readonly);
  const keepAlive = !((parseBooleanFlag(flags.nowait) ?? false) || (parseBooleanFlag(flags.noWait) ?? false));
  return {
    allowWrite,
    readonly: explicitReadonly ?? !allowWrite,
    keepAlive,
  };
};

const taskStatusSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']);
const taskStatusOrAllSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived', 'all']);
const projectStatusSchema = z.enum(['active', 'someday', 'waiting', 'archived']);
const taskTokenSchema = z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH);
const isoDateLikeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/,
    'Expected ISO date (YYYY-MM-DD) or ISO datetime'
  );

const listTasksSchema = z.object({
  status: taskStatusOrAllSchema.optional(),
  projectId: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  search: z.string().max(512).optional(),
  dueDateFrom: isoDateLikeSchema.optional(),
  dueDateTo: isoDateLikeSchema.optional(),
  sortBy: z.enum(['updatedAt', 'createdAt', 'dueDate', 'title', 'priority']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

// Note: Don't use .refine() as it breaks MCP SDK's JSON schema conversion
const addTaskSchema = z.object({
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional().describe('Task title'),
  quickAdd: z.string().optional().describe('Quick-add string with natural language parsing (e.g. "Buy milk @errands #shopping /due:tomorrow +ProjectName")'),
  status: taskStatusSchema.optional().describe('Task status: inbox, next, waiting, someday, reference, done, archived'),
  projectId: z.string().optional().describe('Project ID to assign the task to'),
  dueDate: isoDateLikeSchema.optional().describe('Due date in ISO format'),
  startTime: isoDateLikeSchema.optional().describe('Start time in ISO format'),
  contexts: z.array(taskTokenSchema).optional().describe('Context tags (e.g. ["@home", "@work"])'),
  tags: z.array(taskTokenSchema).optional().describe('Tags (e.g. ["#urgent", "#personal"])'),
  description: z.string().optional().describe('Task description/notes'),
  priority: z.string().optional().describe('Priority level'),
  energyLevel: z.enum(['low', 'medium', 'high']).optional().describe('Energy level: low, medium, high'),
  assignedTo: z.string().optional().describe('Person this task is assigned to or waiting for'),
  timeEstimate: z.string().optional().describe('Time estimate (e.g. "30m", "2h")'),
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
  return {
    ...data,
    contexts: normalizeOptionalTaskTokens('contexts', data.contexts),
    tags: normalizeOptionalTaskTokens('tags', data.tags),
  };
};

const completeTaskSchema = z.object({
  id: z.string(),
});
const updateTaskSchema = z.object({
  id: z.string(),
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional(),
  status: taskStatusSchema.optional(),
  projectId: z.string().nullable().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  startTime: isoDateLikeSchema.nullable().optional(),
  contexts: z.array(taskTokenSchema).nullable().optional(),
  tags: z.array(taskTokenSchema).nullable().optional(),
  description: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  energyLevel: z.enum(['low', 'medium', 'high']).nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  timeEstimate: z.string().nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  isFocusedToday: z.boolean().optional(),
});

const normalizeUpdateTaskInput = (data: z.infer<typeof updateTaskSchema>) => ({
  ...data,
  contexts: normalizeNullableTaskTokens('contexts', data.contexts),
  tags: normalizeNullableTaskTokens('tags', data.tags),
});

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
const getProjectSchema = z.object({
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
  reviewAt: isoDateLikeSchema.nullable().optional(),
  supportNotes: z.string().nullable().optional(),
});
const deleteProjectSchema = z.object({
  id: z.string(),
});
const addAreaSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().optional(),
  icon: z.string().optional(),
});
const updateAreaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200).optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});
const deleteAreaSchema = z.object({
  id: z.string(),
});

export const registerMindwtrTools = (server: McpServer, service: MindwtrService, readonly: boolean) => {
  const withReadonlyMcpErrorHandling = <TInput>(
    scope: string,
    handler: (input: TInput) => Promise<McpToolResponse>,
  ) => withMcpErrorHandling(scope, async (input: TInput) => {
    if (readonly) throw new ReadOnlyError();
    return await handler(input);
  });

  server.registerTool(
    'mindwtr_list_tasks',
    {
      description: 'List tasks from the local Mindwtr SQLite database. Supports filtering by status, project, date range, and search. Supports sorting by various fields.',
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
      description: 'List projects from the local Mindwtr SQLite database.',
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
      description: 'Get a single project by ID from the local Mindwtr SQLite database.',
      inputSchema: getProjectSchema,
    },
    withMcpErrorHandling('mindwtr_get_project', async (input) => {
      const project = await service.getProject({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_list_areas',
    {
      description: 'List areas from the local Mindwtr SQLite database.',
      inputSchema: listAreasSchema,
    },
    withMcpErrorHandling('mindwtr_list_areas', async () => {
      const areas = await service.listAreas();
      return createMcpTextResponse({ areas });
    }),
  );

  server.registerTool(
    'mindwtr_add_task',
    {
      description: 'Add a task to the local Mindwtr SQLite database.',
      inputSchema: addTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_task', async (input) => {
      const normalizedInput = normalizeAddTaskInput(input);
      const task = await service.addTask({
        ...normalizedInput,
      });
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_update_task',
    {
      description: 'Update a task in the local Mindwtr SQLite database.',
      inputSchema: updateTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_task', async (input) => {
      const task = await service.updateTask({
        ...normalizeUpdateTaskInput(input),
      });
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_complete_task',
    {
      description: 'Mark a task as done in the local Mindwtr SQLite database.',
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
      description: 'Soft-delete a task in the local Mindwtr SQLite database.',
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
      description: 'Get a single task by ID from the local Mindwtr SQLite database.',
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
      description: 'Restore a soft-deleted task in the local Mindwtr SQLite database.',
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
      description: 'Add a project to the local Mindwtr SQLite database.',
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
      description: 'Update a project in the local Mindwtr SQLite database.',
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
      description: 'Soft-delete a project in the local Mindwtr SQLite database.',
      inputSchema: deleteProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_project', async (input) => {
      const project = await service.deleteProject(input.id);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_add_area',
    {
      description: 'Add an area to the local Mindwtr SQLite database.',
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
      description: 'Update an area in the local Mindwtr SQLite database.',
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
      description: 'Soft-delete an area in the local Mindwtr SQLite database.',
      inputSchema: deleteAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_area', async (input) => {
      const area = await service.deleteArea(input.id);
      return createMcpTextResponse({ area });
    }),
  );
};

const attachLifecycleHandlers = (service: MindwtrService) => {
  const closeService = () => {
    void service.close().catch((error) => {
      logError('Failed to close database connection', error);
    });
  };

  process.on('exit', () => {
    closeService();
  });
  process.on('SIGINT', () => {
    closeService();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeService();
    process.exit(0);
  });
};

export async function startMcpServer(argv: string[] = process.argv.slice(2)) {
  const flags = parseArgs(argv);

  const dbPath = typeof flags.db === 'string' ? flags.db : undefined;
  const { readonly, keepAlive } = resolveServerModeFlags(flags);

  const service = createService({ dbPath, readonly });
  attachLifecycleHandlers(service);

  const server = new McpServer({
    name: 'mindwtr-mcp-server',
    version: '0.1.0',
  });

  registerMindwtrTools(server, service, readonly);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (keepAlive) {
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    setInterval(() => {}, 1 << 30);
  }
}

if (import.meta.main) {
  startMcpServer().catch((error) => {
    logError('Failed to start server', error);
    process.exit(1);
  });
}
