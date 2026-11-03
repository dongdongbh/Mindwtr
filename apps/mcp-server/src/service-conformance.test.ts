


import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AppData } from '@mindwtr/core';

import { createCloudService } from './cloud-service.js';
import type { ListTasksInput, Task } from './queries.js';
import { createService, type MindwtrService } from './service.js';

const iso = (day: string): string => `2026-03-${day}T00:00:00.000Z`;


const fixtureTasks: Task[] = [
  { id: 't-06', title: 'Alpha', status: 'next', priority: 'urgent', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('03') },
  { id: 't-01', title: 'Bravo', status: 'next', priority: 'urgent', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('07'), isFocusedToday: true },
  { id: 't-05', title: 'Charlie', status: 'next', priority: 'high', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01'), isFocusedToday: 1 as unknown as boolean },
  { id: 't-02', title: 'Delta', status: 'next', priority: 'medium', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('05') },
  { id: 't-04', title: 'Echo', status: 'next', priority: 'low', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('02') },
  { id: 't-03', title: 'Foxtrot', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('06') },
  { id: 't-report', title: 'Reporting', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('04') },
];

const fixtureData: AppData = {
  tasks: fixtureTasks,
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
};

const allIdsByTitleAsc = ['t-06', 't-01', 't-05', 't-02', 't-04', 't-03', 't-report'];

type ConformanceCase = {
  name: string;
  input: ListTasksInput;

  expected: string[];
};

const sharedCases: ConformanceCase[] = [
  {
    name: 'priority desc ranks by urgency (not lexicographically); ties break id asc; missing priority ranks last',
    input: { sortBy: 'priority', sortOrder: 'desc' },
    expected: ['t-01', 't-06', 't-05', 't-02', 't-04', 't-03', 't-report'],
  },
  {
    name: 'priority asc — the id tie-break does not flip with direction',
    input: { sortBy: 'priority', sortOrder: 'asc' },
    expected: ['t-03', 't-report', 't-04', 't-02', 't-05', 't-01', 't-06'],
  },
  {
    name: 'title asc',
    input: { sortBy: 'title', sortOrder: 'asc' },
    expected: allIdsByTitleAsc,
  },
  {
    name: 'updatedAt desc',
    input: { sortBy: 'updatedAt', sortOrder: 'desc' },
    expected: ['t-01', 't-03', 't-02', 't-report', 't-06', 't-04', 't-05'],
  },
  {
    name: 'limit clamps below 1 up to 1',
    input: { sortBy: 'title', sortOrder: 'asc', limit: 0 },
    expected: ['t-06'],
  },
  {
    name: 'limit clamps above 1000 down to 1000 (fixture only has 7 rows)',
    input: { sortBy: 'title', sortOrder: 'asc', limit: 10_000 },
    expected: allIdsByTitleAsc,
  },
  {
    name: 'offset clamps negative to 0',
    input: { sortBy: 'title', sortOrder: 'asc', offset: -5 },
    expected: allIdsByTitleAsc,
  },
  {
    name: 'offset + limit paginate identically',
    input: { sortBy: 'title', sortOrder: 'asc', offset: 3, limit: 10 },
    expected: allIdsByTitleAsc.slice(3),
  },
  {

    name: 'isFocusedToday true returns starred tasks, including ones stored as 1',
    input: { isFocusedToday: true, sortBy: 'title', sortOrder: 'asc' },
    expected: ['t-01', 't-05'],
  },
  {


    name: 'isFocusedToday false returns everything not starred',
    input: { isFocusedToday: false, sortBy: 'title', sortOrder: 'asc' },
    expected: ['t-06', 't-02', 't-04', 't-03', 't-report'],
  },
  {
    name: 'isFocusedToday omitted leaves the list unfiltered',
    input: { sortBy: 'title', sortOrder: 'asc' },
    expected: allIdsByTitleAsc,
  },
  {
    name: 'isFocusedToday composes with other filters rather than replacing them',
    input: { isFocusedToday: true, search: 'Bravo', sortBy: 'title', sortOrder: 'asc' },
    expected: ['t-01'],
  },
];

describe('MindwtrService conformance: local SQLite vs cloud REST', () => {
  let local: MindwtrService;
  let cloud: MindwtrService;
  let tempDir = '';

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-conformance-'));
    writeFileSync(join(tempDir, 'data.json'), JSON.stringify(fixtureData));
    local = createService({ dbPath: join(tempDir, 'mindwtr.db'), readonly: false });
    cloud = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'conformance-test-token',
      fetcher: async () => new Response(JSON.stringify(fixtureData), { status: 200 }),
    });
  });

  afterAll(async () => {
    await local.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  for (const { name, input, expected } of sharedCases) {
    test(`local: ${name}`, async () => {
      expect((await local.listTasks(input)).map((task) => task.id)).toEqual(expected);
    });
    test(`cloud: ${name}`, async () => {
      expect((await cloud.listTasks(input)).map((task) => task.id)).toEqual(expected);
    });
  }

  test('regression guard: priority desc must not fall back to lexicographic order on the raw TEXT column', async () => {


    const ids = (await local.listTasks({ sortBy: 'priority', sortOrder: 'desc' })).map((task) => task.id);
    expect(ids.indexOf('t-05') < ids.indexOf('t-02')).toBeTruthy();
    expect(ids.indexOf('t-05') < ids.indexOf('t-04')).toBeTruthy();
    expect(ids.indexOf('t-05') < ids.indexOf('t-03')).toBeTruthy();
  });


  describe('search matches mid-word on both adapters', () => {

    test('local matches mid-word', async () => {
      const ids = (await local.listTasks({ search: 'port' })).map((task) => task.id);
      expect(ids).toContain('t-report');
    });

    test('cloud matches mid-word', async () => {
      const ids = (await cloud.listTasks({ search: 'port' })).map((task) => task.id);
      expect(ids).toContain('t-report');
    });
  });


  describe('view/search/dueDate-range parity between adapters', () => {
    let viewTempDir = '';
    let viewLocal: MindwtrService;
    let viewCloud: MindwtrService;

    const viewFixtureProjects = [{
      id: 'proj-seq', title: 'Sequential Project', status: 'active' as const, color: '#000000',
      order: 0, tagIds: [], isSequential: true, createdAt: iso('01'), updatedAt: iso('01'),
    }];

    const viewFixtureTasks: Task[] = [
      { id: 'view-available', title: 'Available task', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01') },

      { id: 'view-deferred', title: 'Deferred until 2099', status: 'next', tags: [], contexts: [], startTime: '2099-01-01', createdAt: iso('01'), updatedAt: iso('01') },
      { id: 'view-seq-first', title: 'Sequential first step', status: 'next', projectId: 'proj-seq', order: 0, tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01') },
      { id: 'view-seq-blocked', title: 'Sequential second step', status: 'next', projectId: 'proj-seq', order: 1, tags: [], contexts: [], createdAt: iso('02'), updatedAt: iso('01') },
      { id: 'view-search-meeting', title: 'Schedule a team meeting', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01') },


      { id: 'view-date-boundary', title: 'Late night cutover task', status: 'next', tags: [], contexts: [], dueDate: '2026-03-10T02:00:00+05:00', createdAt: iso('01'), updatedAt: iso('01') },
    ];

    const viewFixtureData: AppData = {
      tasks: viewFixtureTasks,
      projects: viewFixtureProjects,
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    const viewCases: ConformanceCase[] = [
      {
        name: "view:'available' returns eligible tasks (unblocked, not deferred) across the whole set",
        input: { view: 'available', sortBy: 'title', sortOrder: 'asc' },
        expected: ['view-available', 'view-date-boundary', 'view-search-meeting', 'view-seq-first'],
      },
      {
        name: "view:'deferred' returns only tasks whose start is in the future",
        input: { view: 'deferred', sortBy: 'title', sortOrder: 'asc' },
        expected: ['view-deferred'],
      },
      {
        name: "view:'blocked' returns only the non-first task of a sequential project",
        input: { view: 'blocked', sortBy: 'title', sortOrder: 'asc' },
        expected: ['view-seq-blocked'],
      },
      {
        name: 'search runs the operator language (status:/negation), not a literal substring match',
        input: { search: 'status:next -meeting', sortBy: 'title', sortOrder: 'asc' },
        expected: ['view-available', 'view-deferred', 'view-date-boundary', 'view-seq-first', 'view-seq-blocked'],
      },
      {
        name: 'dueDateFrom/dueDateTo bucket an offset-bearing dueDate by its UTC calendar day, not its literal date substring',
        input: { dueDateFrom: '2026-03-09', dueDateTo: '2026-03-09' },
        expected: ['view-date-boundary'],
      },
    ];

    beforeAll(async () => {
      viewTempDir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-conformance-view-'));
      writeFileSync(join(viewTempDir, 'data.json'), JSON.stringify(viewFixtureData));
      viewLocal = createService({ dbPath: join(viewTempDir, 'mindwtr.db'), readonly: false });
      viewCloud = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'conformance-test-token',
        fetcher: async () => new Response(JSON.stringify(viewFixtureData), { status: 200 }),
      });
    });

    afterAll(async () => {
      await viewLocal.close();
      rmSync(viewTempDir, { recursive: true, force: true });
    });

    for (const { name, input, expected } of viewCases) {
      test(`local: ${name}`, async () => {
        expect((await viewLocal.listTasks(input)).map((task) => task.id)).toEqual(expected);
      });
      test(`cloud: ${name}`, async () => {
        expect((await viewCloud.listTasks(input)).map((task) => task.id)).toEqual(expected);
      });
    }
  });


  describe('not-found errors share the same code across both real adapters (core-adapter error taxonomy)', () => {
    test('local: updating a missing task yields code not_found', async () => {
      await expect(local.updateTask({ id: 'does-not-exist', title: 'x' }))
        .rejects.toMatchObject({ code: 'not_found' });
    });

    test('cloud: updating a missing task yields code not_found', async () => {
      const notFoundCloud = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'conformance-test-token',
        fetcher: async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 }),
      });
      await expect(notFoundCloud.updateTask({ id: 'does-not-exist', title: 'x' }))
        .rejects.toMatchObject({ code: 'not_found' });
    });
  });


  describe('a bogus areaId reference on addTask is validation_error on both adapters (not not_found)', () => {
    test('local: addTask with a nonexistent areaId yields code validation_error', async () => {
      await expect(local.addTask({ title: 'Task', areaId: 'does-not-exist' }))
        .rejects.toMatchObject({ code: 'validation_error' });
    });

    test('cloud: addTask with a nonexistent areaId yields code validation_error', async () => {
      const invalidAreaCloud = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'conformance-test-token',
        fetcher: async () => new Response(JSON.stringify({ error: 'Area not found' }), { status: 400 }),
      });
      await expect(invalidAreaCloud.addTask({ title: 'Task', areaId: 'does-not-exist' }))
        .rejects.toMatchObject({ code: 'validation_error' });
    });
  });


  describe('mindwtr_add_task write-surface: checklist + areaId + reviewAt reach both adapters', () => {
    let writeTempDir = '';
    let writeLocal: MindwtrService;

    beforeAll(() => {
      writeTempDir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-write-fixture-'));
      const seedData: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
      writeFileSync(join(writeTempDir, 'data.json'), JSON.stringify(seedData));
      writeLocal = createService({ dbPath: join(writeTempDir, 'mindwtr.db'), readonly: false });
    });

    afterAll(async () => {
      await writeLocal.close();
      rmSync(writeTempDir, { recursive: true, force: true });
    });

    test('local: round-trips checklist, areaId, and reviewAt through the real SQLite-backed core store', async () => {


      const area = await writeLocal.addArea({ name: 'Errands' });
      const task = await writeLocal.addTask({
        title: 'Renew passport',
        checklist: [{ id: 'item-1', title: 'Book appointment', isCompleted: false }],
        areaId: area.id,
        reviewAt: '2026-04-01',
      });
      expect(task.checklist).toEqual([{ id: 'item-1', title: 'Book appointment', isCompleted: false }]);
      expect(task.areaId).toBe(area.id);
      expect(task.reviewAt).toBe('2026-04-01');
    });

    test('local: adding a live area\'s name creates nothing and says so with existing: true', async () => {
      const home = await writeLocal.addArea({ name: 'Home', color: '#22c55e' });
      expect('existing' in home).toBe(false);
      const again = await writeLocal.addArea({ name: ' home ', color: '#ef4444', icon: 'House' });
      expect(again).toMatchObject({ id: home.id, name: 'Home', color: '#22c55e', existing: true });
      expect(again.icon).toBeUndefined();
    });

    test('cloud: forwards checklist, areaId, and reviewAt in the POST /tasks props bag', async () => {
      let capturedBody: { title?: string; props?: Record<string, unknown> } | undefined;
      const writeCloud = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'conformance-test-token',
        fetcher: async (_input, init) => {
          if ((init?.method ?? 'GET') !== 'POST') return new Response(JSON.stringify(fixtureData), { status: 200 });
          capturedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({
            task: {
              id: 'task-new', title: capturedBody?.title, status: 'inbox', tags: [], contexts: [],
              createdAt: iso('01'), updatedAt: iso('01'), ...capturedBody?.props,
            },
          }), { status: 201 });
        },
      });

      const task = await writeCloud.addTask({
        title: 'Renew passport',
        checklist: [{ id: 'item-1', title: 'Book appointment', isCompleted: false }],
        areaId: 'area-fixture',
        reviewAt: '2026-04-01',
      });

      expect(capturedBody?.props).toMatchObject({
        checklist: [{ id: 'item-1', title: 'Book appointment', isCompleted: false }],
        areaId: 'area-fixture',
        reviewAt: '2026-04-01',
      });
      expect(task.checklist).toEqual([{ id: 'item-1', title: 'Book appointment', isCompleted: false }]);
      expect(task.areaId).toBe('area-fixture');
      expect(task.reviewAt).toBe('2026-04-01');
    });
  });


  describe('mindwtr_add_project / mindwtr_update_project write-surface: startDate reaches both adapters like dueDate', () => {
    let writeTempDir = '';
    let writeLocal: MindwtrService;

    beforeAll(() => {
      writeTempDir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-project-write-fixture-'));
      const seedData: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
      writeFileSync(join(writeTempDir, 'data.json'), JSON.stringify(seedData));
      writeLocal = createService({ dbPath: join(writeTempDir, 'mindwtr.db'), readonly: false });
    });

    afterAll(async () => {
      await writeLocal.close();
      rmSync(writeTempDir, { recursive: true, force: true });
    });

    test('local: round-trips startDate alongside dueDate through the real SQLite-backed core store', async () => {
      const project = await writeLocal.addProject({
        title: 'Kitchen remodel',
        dueDate: '2026-05-10',
        startDate: '2026-04-15',
      });
      expect(project.dueDate).toBe('2026-05-10');
      expect(project.startDate).toBe('2026-04-15');

      const updated = await writeLocal.updateProject({ id: project.id, startDate: '2026-04-20' });
      expect(updated.startDate).toBe('2026-04-20');
      expect(updated.dueDate).toBe('2026-05-10');
    });

    test('cloud: forwards startDate in the POST /projects and PATCH /projects/:id props bag', async () => {
      let capturedCreateProps: Record<string, unknown> | undefined;
      let capturedPatchBody: Record<string, unknown> | undefined;
      const writeCloud = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'conformance-test-token',
        fetcher: async (_input, init) => {
          const method = init?.method ?? 'GET';
          if (method === 'POST') {
            const body = JSON.parse(String(init?.body)) as { title?: string; props?: Record<string, unknown> };
            capturedCreateProps = body.props;
            return new Response(JSON.stringify({
              project: {
                id: 'project-new', title: body.title, status: 'active', color: '#6B7280',
                order: 0, tagIds: [], createdAt: iso('01'), updatedAt: iso('01'), ...body.props,
              },
            }), { status: 201 });
          }
          if (method === 'PATCH') {
            capturedPatchBody = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
              project: {
                id: 'project-new', title: 'Kitchen remodel', status: 'active', color: '#6B7280',
                order: 0, tagIds: [], createdAt: iso('01'), updatedAt: iso('01'), ...capturedPatchBody,
              },
            }), { status: 200 });
          }
          return new Response(JSON.stringify(fixtureData), { status: 200 });
        },
      });

      const project = await writeCloud.addProject({
        title: 'Kitchen remodel',
        dueDate: '2026-05-10',
        startDate: '2026-04-15',
      });
      expect(capturedCreateProps).toMatchObject({ dueDate: '2026-05-10', startDate: '2026-04-15' });
      expect(project.dueDate).toBe('2026-05-10');
      expect(project.startDate).toBe('2026-04-15');

      const updated = await writeCloud.updateProject({ id: project.id, startDate: '2026-04-20' });
      expect(capturedPatchBody).toMatchObject({ startDate: '2026-04-20' });
      expect(updated.startDate).toBe('2026-04-20');
    });
  });
});


describe('cancellation writes through the local MCP core adapter', () => {
  let service: MindwtrService;
  let directory: string;
  const cancelledAt = '2026-09-07T16:00:00.000Z';
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'mindwtr-cancellation-mcp-'));
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} }));
    service = createService({ dbPath: join(directory, 'mindwtr.db'), readonly: false });
  });
  afterAll(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('cancels and reactivates a task without losing its notes', async () => {
    const task = await service.addTask({ title: 'Trip booking', status: 'next', description: 'Visa was denied' });
    const cancelled = await service.updateTask({ id: task.id, cancelledAt });
    expect(cancelled.status).toBe('archived');
    expect(cancelled.cancelledAt).toBe(cancelledAt);
    expect(cancelled.completedAt).toBeUndefined();
    expect((await service.getTask({ id: task.id })).description).toBe('Visa was denied');
    const active = await service.updateTask({ id: task.id, status: 'next' });
    expect(active.cancelledAt).toBeUndefined();
    expect(active.completedAt).toBeUndefined();
  });

  test('project cancellation preserves completed children and restores only its cancelled children', async () => {
    const project = await service.addProject({ title: 'Japan trip' });
    const prepared = await service.addTask({ title: 'Research flights', projectId: project.id });
    const remaining = await service.addTask({ title: 'Book hotel', projectId: project.id, status: 'waiting' });
    const done = await service.completeTask(prepared.id);
    const cancelled = await service.updateProject({ id: project.id, cancelledAt });
    expect(cancelled.status).toBe('archived');
    expect(cancelled.cancelledAt).toBe(cancelledAt);
    const doneAfter = await service.getTask({ id: prepared.id });
    expect(doneAfter.status).toBe('done');
    expect(doneAfter.completedAt).toBe(done.completedAt);
    expect(doneAfter.cancelledAt).toBeUndefined();
    const remainingAfter = await service.getTask({ id: remaining.id });
    expect(remainingAfter.status).toBe('archived');
    expect(remainingAfter.cancelledAt).toBeTruthy();
    expect(remainingAfter.completedAt).toBeUndefined();
    await service.updateProject({ id: project.id, status: 'active' });
    expect((await service.getTask({ id: remaining.id })).status).toBe('waiting');
    expect((await service.getTask({ id: prepared.id })).status).toBe('done');
  });
});

describe('cancellation forwarding through the cloud MCP adapter', () => {
  test('preserves task/project timestamps and explicit null clearing in create and patch bodies', async () => {
    const writes: Array<{ method: string; path: string; body: Record<string, any> }> = [];
    const service = createCloudService({
      url: 'https://mindwtr.example.com', token: 'conformance-test-token',
      fetcher: async (input, init) => {
        const method = init?.method ?? 'GET';
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
        writes.push({ method, path, body });
        const entity = path.includes('/projects') ? 'project' : 'task';
        return new Response(JSON.stringify({ [entity]: {
          id: `${entity}-1`, title: 'Cancelled commitment', status: 'archived',
          createdAt: iso('01'), updatedAt: iso('01'), ...(body.props ?? body),
        } }), { status: method === 'POST' ? 201 : 200 });
      },
    });
    const cancelledAt = '2026-09-07T12:00:00.000Z';
    await service.addTask({ title: 'Cancelled action', cancelledAt });
    await service.updateTask({ id: 'task-1', cancelledAt });
    await service.updateTask({ id: 'task-1', cancelledAt: null });
    await service.addProject({ title: 'Cancelled project', cancelledAt });
    await service.updateProject({ id: 'project-1', cancelledAt });
    await service.updateProject({ id: 'project-1', cancelledAt: null });
    expect(writes.map(({ method, path, body }) => ({
      method, path, cancelledAt: body.props?.cancelledAt ?? body.cancelledAt,
    }))).toEqual([
      { method: 'POST', path: '/v1/tasks', cancelledAt },
      { method: 'PATCH', path: '/v1/tasks/task-1', cancelledAt },
      { method: 'PATCH', path: '/v1/tasks/task-1', cancelledAt: null },
      { method: 'POST', path: '/v1/projects', cancelledAt },
      { method: 'PATCH', path: '/v1/projects/project-1', cancelledAt },
      { method: 'PATCH', path: '/v1/projects/project-1', cancelledAt: null },
    ]);
  });
});
