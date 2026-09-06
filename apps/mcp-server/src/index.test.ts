import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { NotFoundError } from './errors.js';
import { addTaskSchema, parseArgs, parseBooleanFlag, registerMindwtrTools, resolveServerConfig, resolveServerModeFlags, updateTaskSchema } from './index.js';
import type { Area, Person, Project, Section, Task } from './queries.js';
import type { MindwtrService } from './service.js';

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

const iso = '2026-01-01T00:00:00.000Z';

const mockTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Task 1',
  status: 'inbox',
  tags: [],
  contexts: [],
  createdAt: iso,
  updatedAt: iso,
  ...overrides,
});

const mockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  title: 'Project 1',
  status: 'active',
  color: '#6B7280',
  order: 0,
  tagIds: [],
  createdAt: iso,
  updatedAt: iso,
  ...overrides,
});

const mockSection = (overrides: Partial<Section> = {}): Section => ({
  id: 's1',
  projectId: 'p1',
  title: 'Section 1',
  order: 0,
  createdAt: iso,
  updatedAt: iso,
  ...overrides,
});

const mockArea = (overrides: Partial<Area> = {}): Area => ({
  id: 'a1',
  name: 'Area 1',
  order: 0,
  createdAt: iso,
  updatedAt: iso,
  ...overrides,
});

const mockPerson = (overrides: Partial<Person> = {}): Person => ({
  id: 'person1',
  name: 'Alex',
  createdAt: iso,
  updatedAt: iso,
  ...overrides,
});

const createMockService = (): MindwtrService => ({
  listTasks: async () => [mockTask()],
  listProjects: async () => [mockProject()],
  listSections: async () => [mockSection()],
  listAreas: async () => [mockArea()],
  listPeople: async () => [mockPerson()],
  getTask: async () => mockTask(),
  getProject: async () => mockProject(),
  getSection: async () => mockSection(),
  getPerson: async () => mockPerson(),
  addTask: async () => mockTask(),
  updateTask: async () => mockTask(),
  completeTask: async () => mockTask(),
  deleteTask: async () => mockTask(),
  restoreTask: async () => mockTask(),
  addProject: async () => mockProject(),
  updateProject: async () => mockProject(),
  deleteProject: async () => mockProject(),
  addSection: async () => mockSection(),
  updateSection: async () => mockSection(),
  deleteSection: async () => mockSection({ deletedAt: iso }),
  addArea: async () => mockArea(),
  updateArea: async () => mockArea(),
  deleteArea: async () => mockArea(),
  addPerson: async () => mockPerson(),
  updatePerson: async () => mockPerson(),
  renamePerson: async () => mockPerson(),
  deletePerson: async () => mockPerson({ deletedAt: iso }),
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
    expect(parseBooleanFlag(true, 'write')).toBe(true);
    expect(parseBooleanFlag(false, 'write')).toBe(false);
    expect(parseBooleanFlag('true', 'write')).toBe(true);
    expect(parseBooleanFlag('false', 'write')).toBe(false);
    expect(parseBooleanFlag('0', 'write')).toBe(false);
    expect(parseBooleanFlag(undefined, 'write')).toBeUndefined();
  });

  // SEC-11: an unrecognized string value used to silently parse as `true` - the OPPOSITE of
  // what a typo like `--write=disabled` looks like it should mean. It must fail closed (throw,
  // naming the flag) instead of guessing.
  test('rejects an unrecognized boolean flag value instead of defaulting to true', () => {
    expect(() => parseBooleanFlag('nope', 'write')).toThrow(/--write/);
    expect(() => parseBooleanFlag('disabled', 'write')).toThrow(/--write/);
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

  // SEC-11: `--write=nope` used to silently parse `write` as true (parseBooleanFlag's
  // fail-open default) - enabling edits from a typo that reads like it should mean the
  // opposite. Startup must now fail loudly instead.
  test('rejects an unrecognized --write value at startup instead of silently enabling writes', () => {
    expect(() => resolveServerModeFlags(parseArgs(['--write=nope']))).toThrow(/--write/);
  });

  test('resolves self-hosted Cloud backend as read-only by default and writable with --write', () => {
    expect(resolveServerConfig(
      parseArgs(['--cloud-url', 'https://mindwtr.example.com', '--cloud-token', 'secret', '--cloud-allow-insecure-http=false']),
      {}
    )).toEqual({
      backend: 'cloud',
      cloudUrl: 'https://mindwtr.example.com',
      cloudToken: 'secret',
      allowInsecureHttp: false,
      keepAlive: true,
      readonly: true,
    });
    expect(resolveServerConfig(
      parseArgs(['--cloud-url', 'https://mindwtr.example.com', '--write']),
      { MINDWTR_MCP_CLOUD_TOKEN: 'secret' }
    )).toEqual({
      backend: 'cloud',
      cloudUrl: 'https://mindwtr.example.com',
      cloudToken: 'secret',
      allowInsecureHttp: false,
      keepAlive: true,
      readonly: false,
    });
  });

  test('registers all mindwtr tools', () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    expect(tools.size).toBe(27);
    expect(tools.has('mindwtr_list_tasks')).toBe(true);
    expect(tools.has('mindwtr_add_task')).toBe(true);
    expect(tools.has('mindwtr_restore_task')).toBe(true);
    expect(tools.has('mindwtr_get_project')).toBe(true);
    expect(tools.has('mindwtr_list_sections')).toBe(true);
    expect(tools.has('mindwtr_get_section')).toBe(true);
    expect(tools.has('mindwtr_add_section')).toBe(true);
    expect(tools.has('mindwtr_update_section')).toBe(true);
    expect(tools.has('mindwtr_delete_section')).toBe(true);
    expect(tools.has('mindwtr_list_areas')).toBe(true);
    expect(tools.has('mindwtr_list_people')).toBe(true);
    expect(tools.has('mindwtr_get_person')).toBe(true);
    expect(tools.has('mindwtr_add_project')).toBe(true);
    expect(tools.has('mindwtr_delete_area')).toBe(true);
    expect(tools.has('mindwtr_add_person')).toBe(true);
    expect(tools.has('mindwtr_update_person')).toBe(true);
    expect(tools.has('mindwtr_rename_person')).toBe(true);
    expect(tools.has('mindwtr_delete_person')).toBe(true);
  });

  test('delegates section tools to the service', async () => {
    const { server, tools } = createMockServer();
    let listInput: unknown;
    let addInput: unknown;
    let updateInput: unknown;
    let deletedId = '';
    registerMindwtrTools(
      server,
      {
        ...createMockService(),
        listSections: async (input) => {
          listInput = input;
          return [mockSection()];
        },
        addSection: async (input) => {
          addInput = input;
          return mockSection({ projectId: input.projectId, title: input.title });
        },
        updateSection: async (input) => {
          updateInput = input;
          return mockSection({ id: input.id, title: input.title ?? 'Section 1' });
        },
        deleteSection: async (id) => {
          deletedId = id;
          return mockSection({ id, deletedAt: iso });
        },
      },
      false
    );

    await tools.get('mindwtr_list_sections')?.handler({ projectId: 'p1' });
    expect(listInput as Record<string, unknown>).toMatchObject({ projectId: 'p1' });

    const addResult = await tools.get('mindwtr_add_section')?.handler({ projectId: 'p1', title: 'Phase A' });
    expect(addInput as Record<string, unknown>).toMatchObject({ projectId: 'p1', title: 'Phase A' });
    const addPayload = JSON.parse(addResult?.content[0]?.text || '{}');
    expect(addPayload.section).toMatchObject({ projectId: 'p1', title: 'Phase A' });

    await tools.get('mindwtr_update_section')?.handler({ id: 's1', title: 'Phase B' });
    expect(updateInput as Record<string, unknown>).toMatchObject({ id: 's1', title: 'Phase B' });

    await tools.get('mindwtr_delete_section')?.handler({ id: 's1' });
    expect(deletedId).toBe('s1');
  });

  test('delegates people tools to the service', async () => {
    const { server, tools } = createMockServer();
    let listInput: unknown;
    let getInput: unknown;
    let addInput: unknown;
    let updateInput: unknown;
    let renameInput: unknown;
    let deletedId = '';
    registerMindwtrTools(
      server,
      {
        ...createMockService(),
        listPeople: async (input) => {
          listInput = input;
          return [mockPerson()];
        },
        getPerson: async (input) => {
          getInput = input;
          return mockPerson({ id: input.id });
        },
        addPerson: async (input) => {
          addInput = input;
          return mockPerson({ name: input.name, note: input.note ?? undefined });
        },
        updatePerson: async (input) => {
          updateInput = input;
          return mockPerson({ id: input.id, note: input.note ?? undefined });
        },
        renamePerson: async (input) => {
          renameInput = input;
          return mockPerson({ id: input.id, name: input.name });
        },
        deletePerson: async (id) => {
          deletedId = id;
          return mockPerson({ id, deletedAt: iso });
        },
      },
      false
    );

    await tools.get('mindwtr_list_people')?.handler({ includeDeleted: true });
    expect(listInput as Record<string, unknown>).toMatchObject({ includeDeleted: true });

    await tools.get('mindwtr_get_person')?.handler({ id: 'person1', includeDeleted: true });
    expect(getInput as Record<string, unknown>).toMatchObject({ id: 'person1', includeDeleted: true });

    const addResult = await tools.get('mindwtr_add_person')?.handler({ name: 'Alex', note: 'Design lead' });
    expect(addInput as Record<string, unknown>).toMatchObject({ name: 'Alex', note: 'Design lead' });
    const addPayload = JSON.parse(addResult?.content[0]?.text || '{}');
    expect(addPayload.person).toMatchObject({ name: 'Alex', note: 'Design lead' });

    await tools.get('mindwtr_update_person')?.handler({ id: 'person1', note: null, referenceLink: 'https://example.com/alex' });
    expect(updateInput as Record<string, unknown>).toMatchObject({
      id: 'person1',
      note: null,
      referenceLink: 'https://example.com/alex',
    });

    await tools.get('mindwtr_rename_person')?.handler({ id: 'person1', name: 'Alexandra', updateTasks: false });
    expect(renameInput as Record<string, unknown>).toMatchObject({
      id: 'person1',
      name: 'Alexandra',
      updateTasks: false,
    });

    await tools.get('mindwtr_delete_person')?.handler({ id: 'person1' });
    expect(deletedId).toBe('person1');
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

  test('validates add_task quickAdd length', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();
    const longQuickAdd = `Task ${'x'.repeat(1997)}`;
    const result = await addHandler?.({ quickAdd: longQuickAdd });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Quick-add input too long');
  });

  test('validates add_task rejects blank token values', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();
    const result = await addHandler?.({ title: 'Task', contexts: ['   '] });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Context values must be non-empty strings');
  });

  test('validates update_task rejects overlong token values', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const updateHandler = tools.get('mindwtr_update_task')?.handler;
    expect(updateHandler).toBeTruthy();
    const result = await updateHandler?.({ id: 't1', tags: [`#${'x'.repeat(500)}`] });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Tag values must be at most 500 characters');
  });

  test('validates task recurrence inputs', async () => {
    const { server, tools } = createMockServer();
    registerMindwtrTools(server, createMockService(), false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();

    for (const recurrence of [
      'FREQ=HOURLY',
      'FREQ=DAILY;COUNT=nope',
      'FREQ=WEEKLY;BYDAY=MON',
      'FREQ=WEEKLY;BYDAY=1MO',
      'FREQ=DAILY;BYMONTHDAY=31',
      'FREQ=DAILY;UNTIL=20261340',
      'FREQ=DAILY;UNTIL=20260230',
      'FREQ=DAILY;UNTIL=20260230T100000Z',
      { rule: 'daily', until: '2026-13-40' },
      { rule: 'daily', rrule: 'FREQ=WEEKLY' },
      { rule: 'monthly', byMonthDay: [10], rrule: 'FREQ=MONTHLY;BYMONTHDAY=20' },
      { rule: 'weekly', byDay: ['MO'], rrule: 'FREQ=WEEKLY;BYDAY=TU' },
      { rule: 'daily', count: 2, rrule: 'FREQ=DAILY;COUNT=5' },
    ]) {
      const result = await addHandler?.({ title: 'Task', recurrence });
      expect(result?.isError).toBe(true);
      expect(result?.content[0]?.text).toContain('Invalid task recurrence');
    }
  });

  test('normalizes task token values before delegating to the service', async () => {
    const { server, tools } = createMockServer();
    let receivedInput: any = null;
    registerMindwtrTools(server, {
      ...createMockService(),
      addTask: async (input: any) => {
        receivedInput = input;
        return mockTask();
      },
      updateTask: async (input: any) => {
        receivedInput = input;
        return mockTask();
      },
    }, false);

    const addHandler = tools.get('mindwtr_add_task')?.handler;
    const updateHandler = tools.get('mindwtr_update_task')?.handler;
    expect(addHandler).toBeTruthy();
    expect(updateHandler).toBeTruthy();

    await addHandler?.({
      title: 'Task',
      projectId: 'p1',
      sectionId: 's1',
      contexts: [' @home '],
      tags: [' #urgent '],
      recurrence: 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260810T100000',
      energyLevel: 'high',
      assignedTo: 'Dana',
    });
    expect(receivedInput).toMatchObject({
      projectId: 'p1',
      sectionId: 's1',
      contexts: ['@home'],
      tags: ['#urgent'],
      recurrence: {
        rule: 'weekly',
        byDay: ['MO', 'WE'],
        until: '2026-08-10T10:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260810T100000',
      },
      energyLevel: 'high',
      assignedTo: 'Dana',
    });

    const roundTripRecurrence = receivedInput.recurrence;
    await updateHandler?.({ id: 't1', recurrence: roundTripRecurrence });
    expect(receivedInput.recurrence).toEqual(roundTripRecurrence);

    await updateHandler?.({
      id: 't1',
      recurrence: {
        rule: 'daily',
        until: '2026-08-10T10:00:00+09:00',
        rrule: 'FREQ=DAILY;UNTIL=20260810T010000Z',
      },
    });
    expect(receivedInput.recurrence.until).toBe('2026-08-10T10:00:00+09:00');

    await updateHandler?.({
      id: 't1',
      sectionId: null,
      contexts: [' @desk '],
      tags: [' #ops '],
      recurrence: {
        rule: 'monthly',
        strategy: 'fluid',
        byMonthDay: [10],
      },
      energyLevel: 'low',
      assignedTo: null,
    });
    expect(receivedInput).toMatchObject({
      id: 't1',
      sectionId: null,
      contexts: ['@desk'],
      tags: ['#ops'],
      recurrence: {
        rule: 'monthly',
        strategy: 'fluid',
        byMonthDay: [10],
      },
      energyLevel: 'low',
      assignedTo: null,
    });
  });

  test('accepts padded quickAdd input when trimmed length is within the limit', async () => {
    const { server, tools } = createMockServer();
    let receivedInput: any = null;
    registerMindwtrTools(server, {
      ...createMockService(),
      addTask: async (input: any) => {
        receivedInput = input;
        return mockTask();
      },
    }, false);
    const addHandler = tools.get('mindwtr_add_task')?.handler;
    expect(addHandler).toBeTruthy();
    const paddedQuickAdd = `   ${'x'.repeat(1998)}   `;
    const result = await addHandler?.({ quickAdd: paddedQuickAdd });

    expect(result?.isError).not.toBe(true);
    expect(receivedInput?.quickAdd).toBe(paddedQuickAdd);
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

  test('maps typed not-found errors without relying on message matching', async () => {
    const { server, tools } = createMockServer();
    const failingService = {
      ...createMockService(),
      getTask: async () => {
        throw new NotFoundError('Invalid request but found resource issue: t1');
      },
    };
    registerMindwtrTools(server, failingService, false);
    const getTaskHandler = tools.get('mindwtr_get_task')?.handler;
    expect(getTaskHandler).toBeTruthy();

    const result = await getTaskHandler?.({ id: 't1' });
    const payload = JSON.parse(result?.content?.[0]?.text || '{}');

    expect(result?.isError).toBe(true);
    expect(payload.code).toBe('not_found');
  });
});

describe('link attachment tool inputs', () => {
  test('accepts a link item and rejects a file-kind one', () => {
    expect(addTaskSchema.safeParse({ title: 'T', attachments: [{ uri: 'obsidian://open?vault=v&file=n' }] }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ id: 't', attachments: [{ title: 'Note', uri: 'https://example.com/a' }] }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ id: 't', attachments: null }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ id: 't', attachments: [{ kind: 'file', uri: 'x' }] }).success).toBe(false);
  });
});
