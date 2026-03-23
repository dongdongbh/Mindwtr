import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { parseArgs, parseBooleanFlag, registerMindwtrTools, resolveServerModeFlags } from './index.js';

type RegisteredTool = {
  name: string;
  handler: (input: any) => Promise<any>;
};

const createMockServer = () => {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, _meta: any, handler: (input: any) => Promise<any>) => {
      tools.set(name, { name, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
};

const createMockService = () => ({
  listTasks: async () => [{ id: 't1' }],
  listProjects: async () => [{ id: 'p1' }],
  listAreas: async () => [{ id: 'a1' }],
  getTask: async () => ({ id: 't1' }),
  getProject: async () => ({ id: 'p1' }),
  addTask: async () => ({ id: 't1' }),
  updateTask: async () => ({ id: 't1' }),
  completeTask: async () => ({ id: 't1' }),
  deleteTask: async () => ({ id: 't1' }),
  restoreTask: async () => ({ id: 't1' }),
  addProject: async () => ({ id: 'p1' }),
  updateProject: async () => ({ id: 'p1' }),
  deleteProject: async () => ({ id: 'p1' }),
  addArea: async () => ({ id: 'a1' }),
  updateArea: async () => ({ id: 'a1' }),
  deleteArea: async () => ({ id: 'a1' }),
  close: async () => undefined,
});

describe('mcp server index', () => {
  test('parses CLI flags', () => {
    const flags = parseArgs(['--db', '/tmp/mindwtr.db', '--write', '--noWait']);
    expect(flags.db).toBe('/tmp/mindwtr.db');
    expect(flags.write).toBe(true);
    expect(flags.noWait).toBe(true);
  });

  test('parses --key=value CLI flags', () => {
    const flags = parseArgs(['--db=/tmp/mindwtr.db', '--write=true']);
    expect(flags.db).toBe('/tmp/mindwtr.db');
    expect(flags.write).toBe('true');
  });

  test('parses boolean flag values explicitly', () => {
    expect(parseBooleanFlag(true)).toBe(true);
    expect(parseBooleanFlag(false)).toBe(false);
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('false')).toBe(false);
    expect(parseBooleanFlag('0')).toBe(false);
    expect(parseBooleanFlag(undefined)).toBeUndefined();
  });

  test('resolves readonly and keepalive modes from CLI flags', () => {
    expect(resolveServerModeFlags(parseArgs(['--write=false']))).toEqual({
      allowWrite: false,
      readonly: true,
      keepAlive: true,
    });
    expect(resolveServerModeFlags(parseArgs(['--write=true', '--readonly=false', '--noWait=false']))).toEqual({
      allowWrite: true,
      readonly: false,
      keepAlive: true,
    });
    expect(resolveServerModeFlags(parseArgs(['--write', '--readonly', '--noWait']))).toEqual({
      allowWrite: true,
      readonly: true,
      keepAlive: false,
    });
  });

  test('registers all mindwtr tools', () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    expect(tools.size).toBe(16);
    expect(tools.has('mindwtr_list_tasks')).toBe(true);
    expect(tools.has('mindwtr_add_task')).toBe(true);
    expect(tools.has('mindwtr_restore_task')).toBe(true);
    expect(tools.has('mindwtr_get_project')).toBe(true);
    expect(tools.has('mindwtr_list_areas')).toBe(true);
    expect(tools.has('mindwtr_add_project')).toBe(true);
    expect(tools.has('mindwtr_delete_area')).toBe(true);
  });

  test('blocks write tools when readonly', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), true);

    const addHandler = tools.get('mindwtr_add_task')?.handler;
    const deleteHandler = tools.get('mindwtr_delete_task')?.handler;
    expect(addHandler).toBeTruthy();
    expect(deleteHandler).toBeTruthy();

    const addResult = await addHandler?.({ title: 'Task' });
    const deleteResult = await deleteHandler?.({ id: 't1' });
    expect(addResult?.isError).toBe(true);
    expect(addResult?.content[0]?.text).toContain('read-only');
    const addPayload = JSON.parse(addResult?.content[0]?.text || '{}');
    expect(addPayload.code).toBe('read_only');
    expect(deleteResult?.isError).toBe(true);
    expect(deleteResult?.content[0]?.text).toContain('read-only');
  });

  test('validates add_task requires title or quickAdd', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();
    const result = await addHandler?.({});
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Either title or quickAdd is required');
    const payload = JSON.parse(result?.content[0]?.text || '{}');
    expect(payload.code).toBe('validation_error');
  });

  test('validates add_task rejects providing both title and quickAdd', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();
    const result = await addHandler?.({ title: 'Task', quickAdd: 'Task /next' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Provide either title or quickAdd, not both');
  });

  test('validates add_task title length', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();
    const longTitle = 'x'.repeat(501);
    const result = await addHandler?.({ title: longTitle });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Task title too long');
  });

  test('wraps service exceptions in MCP error response format', async () => {
    const { server, tools } = createMockServer();
    const failingService = {
      ...createMockService(),
      listTasks: async () => {
        throw new Error('boom');
      },
    };
    registerMindwtrTools(server, failingService, false);
    const listHandler = tools.get('mindwtr_list_tasks')?.handler;
    expect(listHandler).toBeTruthy();
    const result = await listHandler?.({});
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain('boom');
  });
});
