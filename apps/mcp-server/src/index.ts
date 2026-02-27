#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

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
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
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
    const key = arg.slice(2);
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

const taskStatusSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']);
const taskStatusOrAllSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived', 'all']);
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
  title: z.string().optional().describe('Task title'),
  quickAdd: z.string().optional().describe('Quick-add string with natural language parsing (e.g. "Buy milk @errands #shopping /due:tomorrow +ProjectName")'),
  status: taskStatusSchema.optional().describe('Task status: inbox, next, waiting, someday, reference, done, archived'),
  projectId: z.string().optional().describe('Project ID to assign the task to'),
  dueDate: isoDateLikeSchema.optional().describe('Due date in ISO format'),
  startTime: isoDateLikeSchema.optional().describe('Start time in ISO format'),
  contexts: z.array(z.string()).optional().describe('Context tags (e.g. ["@home", "@work"])'),
  tags: z.array(z.string()).optional().describe('Tags (e.g. ["#urgent", "#personal"])'),
  description: z.string().optional().describe('Task description/notes'),
  priority: z.string().optional().describe('Priority level'),
  timeEstimate: z.string().optional().describe('Time estimate (e.g. "30m", "2h")'),
});
const validateAddTask = (data: z.infer<typeof addTaskSchema>) => {
  if (!data.title && !data.quickAdd) {
    throw new Error('Either title or quickAdd is required');
  }
};

const completeTaskSchema = z.object({
  id: z.string(),
});
const updateTaskSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  status: taskStatusSchema.optional(),
  projectId: z.string().nullable().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  startTime: isoDateLikeSchema.nullable().optional(),
  contexts: z.array(z.string()).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  timeEstimate: z.string().nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  isFocusedToday: z.boolean().optional(),
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

export const registerMindwtrTools = (server: McpServer, service: MindwtrService, readonly: boolean) => {
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
    'mindwtr_add_task',
    {
      description: 'Add a task to the local Mindwtr SQLite database.',
      inputSchema: addTaskSchema,
    },
    withMcpErrorHandling('mindwtr_add_task', async (input) => {
      if (readonly) throw new Error('Database opened read-only. Start the server with --write to enable edits.');
      validateAddTask(input);
      const task = await service.addTask({
        ...input,
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
    withMcpErrorHandling('mindwtr_update_task', async (input) => {
      if (readonly) throw new Error('Database opened read-only. Start the server with --write to enable edits.');
      const task = await service.updateTask({
        ...input,
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
    withMcpErrorHandling('mindwtr_complete_task', async (input) => {
      if (readonly) throw new Error('Database opened read-only. Start the server with --write to enable edits.');
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
    withMcpErrorHandling('mindwtr_delete_task', async (input) => {
      if (readonly) throw new Error('Database opened read-only. Start the server with --write to enable edits.');
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
    withMcpErrorHandling('mindwtr_restore_task', async (input) => {
      if (readonly) throw new Error('Database opened read-only. Start the server with --write to enable edits.');
      const task = await service.restoreTask(input.id);
      return createMcpTextResponse({ task });
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
  const allowWrite = Boolean(flags.write);
  const readonly = Boolean(flags.readonly) || !allowWrite;
  const keepAlive = !(flags.nowait || flags.noWait);

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
