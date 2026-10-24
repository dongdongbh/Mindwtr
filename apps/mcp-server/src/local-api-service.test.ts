import { describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { NotFoundError, ValidationError } from './errors.js';
import { createLocalApiService, LOCAL_API_UNSUPPORTED_PROJECT_FIELDS, validateLocalApiUrl } from './local-api-service.js';
import type { AddTaskInput, Project, Task, UpdateTaskInput } from './queries.js';
import type { AddProjectInput, UpdateProjectInput } from './service.js';
import { TASK_CREATE_FIELD_NAMES, TASK_PATCH_FIELD_NAMES } from './task-write-fields.js';

const origin = 'http://127.0.0.1:3000';
const secret = 'private-test-token';
const iso = '2026-01-01T00:00:00.000Z';
const task = (id = 'task-1', props: Partial<Task> = {}): Task => ({
  id, title: 'Call mom', status: 'next', tags: ['#family'], contexts: ['@home'],
  createdAt: iso, updatedAt: iso, ...props,
});
const project = (id = 'project-1', props: Partial<Project> = {}): Project => ({
  id, title: 'Family plans', status: 'active', color: '#123456', order: 2,
  tagIds: [], isSequential: false, createdAt: iso, updatedAt: iso, ...props,
});
const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
type CapturedRequest = { url: string; method: string; headers: Headers; body: Record<string, unknown> | undefined; init: RequestInit };
const fixture = (reply: (call: CapturedRequest, index: number) => Response | Promise<Response>, timeoutMs?: number) => {
  const calls: CapturedRequest[] = [];
  const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const fetcher = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const call: CapturedRequest = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined, init };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, logs, service: createLocalApiService({ url: origin, token: secret, fetcher, timeoutMs,
    logInfo: (message, context) => logs.push({ message, context }) }) };
};
const listen = (server: Server): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});
const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

describe('desktop Local API URL and authentication boundary', () => {
  test('forwards explicit Project color and null reset while preserving omitted fields', async () => {
    const { service, calls } = fixture(() => jsonResponse({ project: project() }));
    await service.addProject({ title: 'Project', colorOverride: '#94a3b8' });
    await service.updateProject({ id: 'project-1', colorOverride: null });
    await service.updateProject({ id: 'project-1', title: 'Renamed' });
    expect(calls[0].body).toEqual({ title: 'Project', props: { colorOverride: '#94a3b8' } });
    expect(calls[1].body).toEqual({ colorOverride: null });
    expect(calls[2].body).toEqual({ title: 'Renamed' });
    await expect(service.updateProject({ id: 'project-1', colorOverride: '#fff' })).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(3);
  });
  test('accepts canonical literal loopback origins', () => {
    for (const value of ['http://127.0.0.1:3000', 'https://127.0.0.1:3000/', 'http://[::1]:3000/']) {
      expect(validateLocalApiUrl(value)).toBe(value.replace(/\/$/, ''));
    }
    expect(validateLocalApiUrl('  http://127.0.0.1:3000/  ')).toBe(origin);
  });

  test('rejects DNS names, alternate loopback spellings, remote hosts, credentials and URL suffixes without leaking them', () => {
    for (const value of ['http://localhost:3000', 'http://127.1:3000', 'http://2130706433:3000', 'http://0x7f000001:3000',
      'http://127.0.0.2:3000', 'http://[::ffff:127.0.0.1]:3000', 'http://example.com', 'ftp://127.0.0.1',
      `http://name:${secret}@127.0.0.1:3000`, `http://127.0.0.1:3000/${secret}`, `http://127.0.0.1:3000?token=${secret}`,
      `http://127.0.0.1:3000#${secret}`, 'http://127.0.0.1:3000?', 'http://127.0.0.1:65536', '']) {
      expect(() => validateLocalApiUrl(value)).toThrow(ValidationError);
      try { validateLocalApiUrl(value); } catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });

  test('requires token and never prints invalid token values', () => {
    for (const value of ['', '   ', `${secret}\nBAD`, `${secret} BAD`]) {
      expect(() => createLocalApiService({ url: origin, token: value })).toThrow(ValidationError);
      try { createLocalApiService({ url: origin, token: value }); } catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });

  test('every request authenticates and disables redirects, and proof is logged once', async () => {
    const { service, calls, logs } = fixture(() => jsonResponse({ task: task() }));
    await service.getTask({ id: 'task-1' });
    await service.getTask({ id: 'task-1' });
    expect(calls.map((call) => call.url)).toEqual([`${origin}/tasks/task-1`, `${origin}/tasks/task-1`]);
    for (const call of calls) {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${secret}`);
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal instanceof AbortSignal).toBe(true);
    }
    expect(logs).toEqual([{ message: 'Desktop Local API authenticated connection succeeded',
      context: { extra: { releaseCheck: 'v1.3.4/mcp-local-api' } } }]);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(origin);
    expect(JSON.stringify(logs)).not.toContain('Call mom');
  });

  test('real fetch refuses redirect without forwarding Authorization', async () => {
    let forwarded = 0;
    const target = createServer((_request, response) => { forwarded += 1; response.end('{}'); });
    const targetPort = await listen(target);
    const redirector = createServer((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/tasks` }); response.end();
    });
    const redirectPort = await listen(redirector);
    try {
      const service = createLocalApiService({ url: `http://127.0.0.1:${redirectPort}`, token: secret });
      await expect(service.listTasks({})).rejects.toThrow('Local API is unavailable');
      expect(forwarded).toBe(0);
    } finally {
      await close(redirector);
      await close(target);
    }
  });
});

describe('desktop Local API task reads', () => {
  const tasks = [task('next', { projectId: 'project-1', dueDate: '2026-01-02', isFocusedToday: true, priority: 'urgent' }),
    task('done', { status: 'done' }), task('archived', { status: 'archived' }), task('deleted', { deletedAt: iso }),
    task('waiting', { status: 'waiting', contexts: ['@work'], title: 'Ask finance', priority: 'high' }),
    task('no-focus', { isFocusedToday: undefined, priority: 'high' })];
  const readFixture = () => fixture((call) => call.url.endsWith('/projects')
    ? jsonResponse({ projects: [project()] }) : jsonResponse({ tasks }));

  test('fetches all native statuses, and tombstones only when the query includes them', async () => {
    const { service, calls } = readFixture();
    expect((await service.listTasks({})).map((row) => row.id)).toEqual(['archived', 'done', 'next', 'no-focus', 'waiting']);
    expect(calls[0].url).toBe(`${origin}/tasks?all=1`);
    expect((await service.listTasks({ includeDeleted: true })).map((row) => row.id)).toContain('deleted');
    expect(calls[1].url).toBe(`${origin}/tasks?all=1&deleted=1`);
    expect((await service.listTasks({ status: 'done' })).map((row) => row.id)).toEqual(['done']);
    expect(calls[2].url).toBe(`${origin}/tasks?all=1&status=done`);
    expect((await service.listTasks({ status: 'all', isFocusedToday: false })).map((row) => row.id)).not.toContain('next');
    expect(calls[3].url).toBe(`${origin}/tasks?all=1&isFocusedToday=0`);
    expect((await service.listTasks({ projectId: 'project-1' })).map((row) => row.id)).toEqual(['next']);
  });

  // The native filter (local_api.rs filter_tasks) runs before the Node filter, so it may only ever drop tasks the
  // Node filter drops too. Same queries, same data: a server that ignores the parameters (the old full fetch) and
  // one that applies them the way Rust does must give identical results.
  test('server-side filtering returns exactly what the full fetch returned', async () => {
    const rows = [...tasks, task('blank-deleted', { deletedAt: '' }), task('focused-done', { status: 'done', isFocusedToday: true }),
      task('focused-deleted', { isFocusedToday: true, deletedAt: iso }), task('numeric-focus', { isFocusedToday: 1 as unknown as boolean })];
    const nativeFocus = (row: Task): boolean => (typeof row.isFocusedToday === 'number' ? row.isFocusedToday !== 0 : row.isFocusedToday === true);
    const nativeFilter = (url: string): Task[] => {
      const query = new URL(url).searchParams;
      const status = query.get('status');
      const focus = query.get('isFocusedToday');
      return rows.filter((row) => (query.get('deleted') === '1' || !row.deletedAt?.trim())
        && (query.get('all') === '1' || (row.status !== 'done' && row.status !== 'archived'))
        && (!status || row.status === status)
        && (focus === null || nativeFocus(row) === (focus === '1' || focus === 'true')));
    };
    const full = fixture((call) => call.url.endsWith('/projects') ? jsonResponse({ projects: [project()] }) : jsonResponse({ tasks: rows }));
    const native = fixture((call) => call.url.endsWith('/projects') ? jsonResponse({ projects: [project()] }) : jsonResponse({ tasks: nativeFilter(call.url) }));
    const queries = [{}, { includeDeleted: true }, { status: 'all' as const }, { status: 'done' as const }, { status: 'archived' as const, includeDeleted: true },
      { isFocusedToday: true }, { isFocusedToday: false }, { isFocusedToday: true, includeDeleted: true }, { status: 'next' as const, isFocusedToday: true },
      { status: 'next' as const, isFocusedToday: false, search: 'Call' }];
    for (const query of queries) {
      const expected = (await full.service.listTasks(query)).map((row) => row.id);
      expect({ query, ids: (await native.service.listTasks(query)).map((row) => row.id) }).toEqual({ query, ids: expected });
    }
    expect(native.calls.filter((call) => !call.url.endsWith('/projects') && !call.url.includes('deleted=1')).length > 0).toBe(true);
  });

  test('uses rich core search operators, quoted text, negation and project names before pagination', async () => {
    const { service, calls } = readFixture();
    expect((await service.listTasks({ search: 'status:next context:@home "Call mom" -project:Missing', limit: 1, offset: 1 })).map((row) => row.id)).toEqual(['no-focus']);
    expect((await service.listTasks({ search: 'project:"Family plans"' })).map((row) => row.id)).toEqual(['next']);
    expect((await service.listTasks({ search: '-context:@work status:waiting' })).map((row) => row.id)).toEqual([]);
    expect(calls.every((call) => !call.url.includes('query='))).toBe(true);
  });

  test('sorts priority by core rank with stable ID ties, clamps limits and offsets', async () => {
    const { service } = readFixture();
    expect((await service.listTasks({ sortBy: 'priority' })).map((row) => row.id)).toEqual(['next', 'no-focus', 'waiting', 'archived', 'done']);
    expect((await service.listTasks({ sortBy: 'priority', sortOrder: 'asc' })).map((row) => row.id)).toEqual(['archived', 'done', 'no-focus', 'waiting', 'next']);
    expect((await service.listTasks({ limit: 0, offset: -5 })).map((row) => row.id)).toEqual(['archived']);
    expect((await service.listTasks({ limit: 9000, offset: 2 })).map((row) => row.id)).toEqual(['next', 'no-focus', 'waiting']);
  });

  test('due windows preserve written calendar days for date-only and no-offset times', async () => {
    const { service } = fixture(() => jsonResponse({ tasks: [
      task('evening', { dueDate: '2026-10-11T23:30' }), task('morning', { dueDate: '2026-10-12T07:00' }),
      task('seconds', { dueDate: '2026-10-11T23:30:00.123' }), task('date-only', { dueDate: '2026-10-11' }),
      task('invalid', { dueDate: '2026-10-11T25:30' }), task('missing'),
    ] }));
    expect((await service.listTasks({ dueDateFrom: '2026-10-11', dueDateTo: '2026-10-11' })).map((row) => row.id))
      .toEqual(['date-only', 'evening', 'seconds']);
  });

  test('due windows convert offset times and bounds to their local calendar days', async () => {
    const early = new Date(2026, 9, 11, 0, 30).toISOString();
    const late = new Date(2026, 9, 11, 23, 30).toISOString().replace('Z', '+00:00');
    const { service } = fixture(() => jsonResponse({ tasks: [task('early', { dueDate: early }),
      task('late', { dueDate: late }), task('earlier', { dueDate: '2026-10-10' }),
      task('later', { dueDate: '2026-10-12' }), task('missing')] }));
    for (const input of [
      { dueDateFrom: '2026-10-11', dueDateTo: '2026-10-11' },
      { dueDateFrom: early, dueDateTo: late },
    ]) {
      expect((await service.listTasks(input)).map((row) => row.id)).toEqual(['early', 'late']);
    }
  });

  test('false focus includes absent flags', async () => {
    expect((await readFixture().service.listTasks({ isFocusedToday: false })).map((row) => row.id)).toEqual(['archived', 'done', 'no-focus', 'waiting']);
  });

  test('get filters deleted rows unless includeDeleted and safely encodes entity IDs', async () => {
    const id = 'legacy id with ?#characters';
    const { service, calls } = fixture(() => jsonResponse({ task: task(id, { deletedAt: iso }) }));
    await expect(service.getTask({ id })).rejects.toThrow(NotFoundError);
    expect((await service.getTask({ id, includeDeleted: true })).id).toBe(id);
    expect(calls[0].url).toBe(`${origin}/tasks/${encodeURIComponent(id)}`);
    for (const value of ['.', '..', '']) await expect(service.getTask({ id: value })).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(2);
  });
});

describe('desktop Local API writes and lifecycle envelopes', () => {
  test('task creation uses explicit title plus props and stamps link metadata before one write', async () => {
    const { service, calls } = fixture(() => jsonResponse({ task: task() }, 201));
    await service.addTask({ title: '  Capture  ', status: 'next', projectId: 'project-1', sectionId: 'section-1',
      dueDate: '2026-01-02', startTime: '2026-01-01', contexts: ['  @home  '], tags: ['  #family  '],
      recurrence: { rule: 'weekly' }, relativeStartOffset: { amount: -1, unit: 'day' }, timeSpentMinutes: 0,
      attachments: [{ id: 'link-1', title: 'Reference', uri: 'https://example.com/reference' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${origin}/tasks`);
    expect(calls[0].body).toMatchObject({ title: 'Capture', props: { status: 'next', projectId: 'project-1', sectionId: 'section-1',
      dueDate: '2026-01-02', startTime: '2026-01-01', contexts: ['@home'], tags: ['#family'],
      recurrence: { rule: 'weekly' }, relativeStartOffset: { amount: -1, unit: 'day' }, timeSpentMinutes: 0 } });
    const props = calls[0].body?.props as Record<string, unknown>;
    expect(props.attachments as object).toMatchObject([{ id: 'link-1', kind: 'link', title: 'Reference', uri: 'https://example.com/reference' }]);
    expect(typeof (props.attachments as Array<Record<string, unknown>>)[0].createdAt).toBe('string');
    expect(Object.hasOwn(calls[0].body!, 'input')).toBe(false);
  });

  test('all current generated fields are transmitted without silent omission', async () => {
    const generated: Record<string, unknown> = { viewSectionIds: { someday: 'books' }, cancelledAt: iso, taskMode: 'task', relativeStartOffset: { amount: -2, unit: 'day' },
      showFutureRecurrence: true, pushCount: 2, checklist: [{ id: 'check-1', title: 'Step', isCompleted: false }],
      textDirection: 'rtl', location: 'Office', areaId: 'area-1', isFocusedToday: true,
      timeSpentMinutes: 30, suppressMindwtrReminders: true, reminderPolicy: 'skip', repeatReminderMinutes: 15, dueReminderLeadMinutes: 1440, reviewAt: '2026-01-02',
      order: 2, boardOrder: 3, focusOrder: 4 };
    const { service, calls } = fixture(() => jsonResponse({ task: task() }));
    const createFields = Object.fromEntries(TASK_CREATE_FIELD_NAMES.map((name) => [name, generated[name]]));
    expect(Object.values(createFields).every((value) => value !== undefined)).toBe(true);
    await service.addTask({ title: 'All', status: 'archived', ...createFields } as AddTaskInput);
    expect(calls[0].body?.props as object).toEqual({ status: 'archived', ...createFields });
    const patchFields = Object.fromEntries(TASK_PATCH_FIELD_NAMES.map((name) => [name, generated[name]]));
    expect(Object.values(patchFields).every((value) => value !== undefined)).toBe(true);
    await service.updateTask({ id: 'task-1', ...patchFields } as UpdateTaskInput);
    expect(calls[1].body).toEqual(patchFields);
  });

  test('task patch is flat and clears nullable tokens with arrays, other fields with null', async () => {
    const { service, calls } = fixture(() => jsonResponse({ task: task() }));
    await service.updateTask({ id: 'task-1', title: 'Rename', status: 'waiting', projectId: null, sectionId: null,
      tags: null, contexts: null, recurrence: null, dueDate: null, description: null, priority: null, reviewAt: null, dueReminderLeadMinutes: null });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(`${origin}/tasks/task-1`);
    expect(calls[0].body).toEqual({ title: 'Rename', status: 'waiting', projectId: null, sectionId: null,
      tags: [], contexts: [], recurrence: null, dueDate: null, description: null, priority: null, reviewAt: null, dueReminderLeadMinutes: 0 });
  });

  test('completion and restore use dedicated endpoints and deletion reads the actual persisted tombstone', async () => {
    const deleted = task('task-1', { deletedAt: iso });
    const { service, calls } = fixture((call) => call.method === 'DELETE' ? jsonResponse({ ok: true }) : jsonResponse({ task: deleted }));
    await service.completeTask('task-1');
    await service.restoreTask('task-1');
    expect(await service.deleteTask('task-1')).toEqual(deleted);
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', `${origin}/tasks/task-1/complete`, undefined], ['POST', `${origin}/tasks/task-1/restore`, undefined],
      ['DELETE', `${origin}/tasks/task-1`, undefined], ['GET', `${origin}/tasks/task-1`, undefined],
    ]);
  });

  test('project read/create/patch/delete and area reads use native envelopes and filtering', async () => {
    const deleted = project('deleted', { deletedAt: iso });
    const { service, calls } = fixture((call) => {
      if (call.url.endsWith('/areas')) return jsonResponse({ areas: [
        { id: 'area-2', name: 'Second', order: 2, createdAt: iso, updatedAt: iso },
        { id: 'area-1', name: 'First', order: 1, createdAt: iso, updatedAt: iso },
      ] });
      if (call.method === 'DELETE') return jsonResponse({ ok: true });
      if (call.url.endsWith('/projects') && call.method === 'GET') return jsonResponse({ projects: [project(), deleted] });
      return jsonResponse({ project: call.url.endsWith('/deleted') ? deleted : project() });
    });
    expect((await service.listProjects()).map((row) => row.id)).toEqual(['project-1']);
    expect((await service.listProjects())[0].orderNum).toBe(2);
    await expect(service.getProject({ id: 'deleted' })).rejects.toThrow(NotFoundError);
    expect((await service.getProject({ id: 'deleted', includeDeleted: true })).id).toBe('deleted');
    await service.addProject({ title: '  Project  ', color: '#123456', status: 'active', areaId: 'area-1', isSequential: true });
    await service.updateProject({ id: 'project-1', title: 'Renamed', status: 'archived', areaId: null, isSequential: false });
    expect((await service.deleteProject('project-1')).id).toBe('project-1');
    expect((await service.listAreas()).map((row) => row.id)).toEqual(['area-1', 'area-2']);
    expect(calls[4].body).toEqual({ title: 'Project', props: { color: '#123456', status: 'active', areaId: 'area-1', isSequential: true } });
    expect(calls[5].body).toEqual({ title: 'Renamed', status: 'archived', areaId: null, isSequential: false });
    expect(calls[6].method).toBe('DELETE');
    expect(calls[7].method).toBe('GET');
  });
});

describe('desktop Local API capability rejection before requests', () => {
  test('ambiguous path IDs are rejected before every task/project request', async () => {
    const { service, calls } = fixture(() => jsonResponse({ task: task(), project: project(), ok: true }));
    const validId = 'a29b1a28-39c2-4c81-9987-aa54af928d1e';
    const aliases = [`/${validId}`, `${validId}/`, `//${validId}//`, `prefix/${validId}`, `\\${validId}`, `${validId}\\`,
      `%2f${validId}`, `${validId}%2F`, `%252f${validId}`, `%25252F${validId}`, '%2e', '%2E%2e', '%252e%252e',
      '.', '..', `${validId}%`, `${validId}+`, `${validId}\n`, `${validId}\r`, `${validId}\0`, '\uD800'];
    for (const id of aliases) {
      for (const operation of [
        () => service.getTask({ id }), () => service.updateTask({ id, title: 'Rename' }),
        () => service.completeTask(id), () => service.deleteTask(id), () => service.restoreTask(id),
        () => service.getProject({ id }), () => service.updateProject({ id, title: 'Rename' }), () => service.deleteProject(id),
      ]) {
        await expect(operation()).rejects.toThrow(ValidationError);
      }
    }
    expect(calls).toHaveLength(0);
  });

  test('task quickAdd, missing titles, attachments replacement, terminal status and unknown fields are rejected', async () => {
    const { service, calls } = fixture(() => jsonResponse({ task: task() }));
    for (const input of [{ quickAdd: 'Call mom #family' }, { title: 'Literal', quickAdd: 'Ignored?' }, {}, { title: '  ' },
      { title: 'Secret', unsupported: 'not supported' }, { title: 'Task', status: 'next', cancelledAt: iso },
      { title: 'Task', attachments: [{ uri: `file://name:${secret}@host/share` }] }, { title: 'Task', recurrence: 'FREQ=HOURLY' },
      { title: 'Task', repeatReminderMinutes: 17 }, { title: 'Task', relativeStartOffset: { amount: 1, unit: 'day' } }]) {
      await expect(service.addTask(input as AddTaskInput)).rejects.toThrow(ValidationError);
    }
    for (const input of [{ id: 'task-1', attachments: [] }, { id: 'task-1', attachments: null },
      { id: 'task-1', status: 'done' }, { id: 'task-1', status: 'archived' }, { id: 'task-1', unsupported: true },
      { id: 'task-1', isFocusedToday: null }, { id: 'task-1', status: 'waiting', cancelledAt: iso }]) {
      await expect(service.updateTask(input as UpdateTaskInput)).rejects.toThrow(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  test('every unsupported project field is rejected on create and update before a request', async () => {
    const { service, calls } = fixture(() => jsonResponse({ project: project() }));
    for (const name of LOCAL_API_UNSUPPORTED_PROJECT_FIELDS) {
      await expect(service.addProject({ title: 'Project', [name]: null } as unknown as AddProjectInput)).rejects.toThrow(ValidationError);
      await expect(service.updateProject({ id: 'project-1', [name]: null } as unknown as UpdateProjectInput)).rejects.toThrow(ValidationError);
    }
    await expect(service.addProject({ title: 'Project', unknown: true } as AddProjectInput)).rejects.toThrow(ValidationError);
    await expect(service.updateProject({ id: 'project-1', color: null })).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test('availability, section, people and area write tools fail without any network activity', async () => {
    const { service, calls } = fixture(() => jsonResponse({}));
    for (const view of ['available', 'deferred', 'blocked'] as const) await expect(service.listTasks({ view })).rejects.toThrow('section and settings');
    for (const operation of [() => service.listSections(), () => service.getSection({ id: 's' }),
      () => service.addSection({ title: 'S', projectId: 'p' }), () => service.updateSection({ id: 's', title: 'S' }), () => service.deleteSection('s'),
      () => service.listPeople(), () => service.getPerson({ id: 'p' }), () => service.addPerson({ name: 'P' }),
      () => service.updatePerson({ id: 'p', name: 'P' }), () => service.renamePerson({ id: 'p', name: 'P' }), () => service.deletePerson('p'),
      () => service.addArea({ name: 'A' }), () => service.updateArea({ id: 'a', name: 'A' }), () => service.deleteArea('a')]) {
      await expect(operation()).rejects.toThrow(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('desktop Local API failure safety', () => {
  test('invalid token, unsupported input, conflicts and missing entities return sanitized distinctions', async () => {
    for (const [status, message] of [[401, 'token is invalid'], [403, 'token is invalid'], [400, 'invalid or unsupported input'],
      [404, 'entity or endpoint not found'], [409, 'lifecycle conflict'], [405, 'operation is unsupported'], [500, 'rejected the request']] as const) {
      const { service, calls, logs } = fixture(() => jsonResponse({ error: `${secret} ${origin}` }, status));
      await expect(service.updateTask({ id: 'task-1', title: 'Change' })).rejects.toThrow(message);
      expect(calls).toHaveLength(1);
      expect(logs).toHaveLength(0);
      try { await service.getTask({ id: 'task-1' }); } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain(origin);
      }
    }
    const { service } = fixture(() => jsonResponse({ error: secret, code: 'recurrence_requires_app' }, 409));
    await expect(service.completeTask('task-1')).rejects.toThrow('requires completion in the desktop app');
  });

  test('fetch failures cannot smuggle URLs/tokens through safe-looking messages and writes are never retried', async () => {
    for (const error of [new Error(`${secret} ${origin}`), new Error(`Desktop Local API ${secret} ${origin}`),
      new ValidationError(`${secret} ${origin}`), new NotFoundError(`${secret} ${origin}`)]) {
      const { service, calls, logs } = fixture(() => { throw error; });
      await expect(service.addTask({ title: 'Capture' })).rejects.toThrow('write outcome is unknown');
      expect(calls).toHaveLength(1);
      expect(logs).toHaveLength(0);
      try { await service.listTasks({}); } catch (failure) {
        expect(String(failure)).not.toContain(secret);
        expect(String(failure)).not.toContain(origin);
        expect(String(failure)).toContain('Open the desktop app');
      }
    }
  });

  test('timeouts abort requests, bound even an uncooperative fetcher, and warn about ambiguous write outcomes', async () => {
    const { service, calls } = fixture(() => new Promise<Response>(() => {}), 10);
    await expect(service.updateTask({ id: 'task-1', title: 'Change' })).rejects.toThrow('write outcome is unknown');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal?.aborted).toBe(true);
    await expect(service.getTask({ id: 'task-1' })).rejects.toThrow('request timed out');
    expect(calls).toHaveLength(2);
  });

  test('timeout also bounds response body reads, with no write retry', async () => {
    const response = jsonResponse({});
    response.json = () => new Promise(() => {});
    const { service, calls } = fixture(() => response, 10);
    await expect(service.addTask({ title: 'Capture' })).rejects.toThrow('write outcome is unknown');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  test('redirect responses are rejected even when an injected fetcher ignores redirect:error', async () => {
    const { service, calls } = fixture(() => new Response(null, { status: 302, headers: { Location: `https://${secret}.example/` } }));
    await expect(service.completeTask('task-1')).rejects.toThrow('redirects are unsupported');
    expect(calls).toHaveLength(1);
  });

  test('malformed envelopes/entities fail clearly without returning raw response content', async () => {
    for (const body of [{}, { task: {} }, { task: task('other') }, { task: { ...task(), contexts: secret } }, secret]) {
      const { service } = fixture(() => jsonResponse(body));
      await expect(service.getTask({ id: 'task-1' })).rejects.toThrow('invalid response');
    }
    const { service } = fixture(() => jsonResponse({ tasks: [{}] }));
    await expect(service.listTasks({})).rejects.toThrow('invalid response');
    const malformed = fixture(() => new Response(`not json ${secret}`, { status: 200 }));
    await expect(malformed.service.addTask({ title: 'Capture' })).rejects.toThrow('write outcome is unknown');
    expect(malformed.calls).toHaveLength(1);
  });

  test('successful deletion followed by read failure is explicitly reported without another write', async () => {
    const { service, calls } = fixture((_call, index) => index === 0 ? jsonResponse({ ok: true }) : jsonResponse({ error: secret }, 404));
    await expect(service.deleteTask('task-1')).rejects.toThrow('deletion succeeded');
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'GET']);
  });
});
