// MindwtrService documents 28 method signatures but no semantics. This suite is where the
// semantics actually live: one fixture table, run through BOTH real adapters (the local
// SQLite path in queries.ts and the cloud REST path in cloud-service.ts), asserting the same
// result. Adding a new sort/filter rule to the contract means adding a row here, not a
// one-off test on one side — a row that only one adapter satisfies is the bug this suite
// exists to catch (see the priority-sort regression this task fixes).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AppData } from '@mindwtr/core';

import { createCloudService } from './cloud-service.js';
import type { ListTasksInput, Task } from './queries.js';
import { createService, type MindwtrService } from './service.js';

const iso = (day: string): string => `2026-03-${day}T00:00:00.000Z`;

// Ids are deliberately NOT in title/priority/updatedAt order, so a test that passes by
// accident (adapter happens to return rows in id/insertion order) would be caught.
// t-05 stores the focus flag as numeric 1 rather than `true` on purpose: synced payloads
// round-trip booleans as 1/0 (core's toBool), so an adapter that filters with `=== true`
// drops it. Both adapters must still return it for `isFocusedToday: true`.
const fixtureTasks: Task[] = [
  { id: 't-06', title: 'Alpha', status: 'next', priority: 'urgent', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('03') },
  { id: 't-01', title: 'Bravo', status: 'next', priority: 'urgent', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('07'), isFocusedToday: true }, // ties t-06 on priority
  { id: 't-05', title: 'Charlie', status: 'next', priority: 'high', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01'), isFocusedToday: 1 as unknown as boolean },
  { id: 't-02', title: 'Delta', status: 'next', priority: 'medium', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('05') },
  { id: 't-04', title: 'Echo', status: 'next', priority: 'low', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('02') },
  { id: 't-03', title: 'Foxtrot', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('06') }, // no priority
  { id: 't-report', title: 'Reporting', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('04') }, // no priority; ties t-03 on priority
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
  // Expected ids, in order, for BOTH adapters.
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
    // t-05 stores the flag as 1, not true — a `=== true` filter returns only t-01 here.
    name: 'isFocusedToday true returns starred tasks, including ones stored as 1',
    input: { isFocusedToday: true, sortBy: 'title', sortOrder: 'asc' },
    expected: ['t-01', 't-05'],
  },
  {
    // The unstarred rows carry no isFocusedToday key at all, so this also pins that a
    // missing/NULL flag counts as false rather than being dropped from both sides.
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
    // Lexicographically, 'high' > 'medium' > 'low' but 'high' < 'urgent', so a naive
    // `ORDER BY priority DESC` puts 'high' LAST of the four — this is exactly the bug this
    // task fixes. Assert the actual rank order survives on the local adapter.
    const ids = (await local.listTasks({ sortBy: 'priority', sortOrder: 'desc' })).map((task) => task.id);
    expect(ids.indexOf('t-05') < ids.indexOf('t-02')).toBeTruthy(); // high before medium
    expect(ids.indexOf('t-05') < ids.indexOf('t-04')).toBeTruthy(); // high before low
    expect(ids.indexOf('t-05') < ids.indexOf('t-03')).toBeTruthy(); // high before none
  });

  // Was "a stated capability difference": local used FTS prefix matching, cloud used
  // substrings, so the same query returned different sets. Local now runs the same core
  // search the desktop, mobile and CLI surfaces run, which is substring-based — the
  // divergence is gone rather than documented.
  describe('search matches mid-word on both adapters', () => {
    // "Reporting" contains "port" as a substring but does not START with it.
    test('local matches mid-word', async () => {
      const ids = (await local.listTasks({ search: 'port' })).map((task) => task.id);
      expect(ids).toContain('t-report');
    });

    test('cloud matches mid-word', async () => {
      const ids = (await cloud.listTasks({ search: 'port' })).map((task) => task.id);
      expect(ids).toContain('t-report');
    });
  });

  // BUG-13/BUG-25: the cloud adapter used to ignore `view` entirely, matched `search` with a
  // literal substring instead of core's operator language, and bucketed dueDate by slicing the
  // raw string instead of the UTC calendar day. Own fixture (not `fixtureTasks`/`sharedCases`
  // above) so a project with an isSequential chain and a future-dated task don't change any of
  // the existing sort/pagination fixture's expected id lists.
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
      // Far future so this stays "deferred" regardless of when the suite runs.
      { id: 'view-deferred', title: 'Deferred until 2099', status: 'next', tags: [], contexts: [], startTime: '2099-01-01', createdAt: iso('01'), updatedAt: iso('01') },
      { id: 'view-seq-first', title: 'Sequential first step', status: 'next', projectId: 'proj-seq', order: 0, tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01') },
      { id: 'view-seq-blocked', title: 'Sequential second step', status: 'next', projectId: 'proj-seq', order: 1, tags: [], contexts: [], createdAt: iso('02'), updatedAt: iso('01') },
      { id: 'view-search-meeting', title: 'Schedule a team meeting', status: 'next', tags: [], contexts: [], createdAt: iso('01'), updatedAt: iso('01') },
      // 2026-03-10T02:00+05:00 is 2026-03-09T21:00Z - a naive first-10-characters read names
      // the 10th; the correct UTC calendar day is the 9th (BUG-25).
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

  // core-adapter.ts used to throw a plain Error for a missing id on update/delete/rename,
  // which fell through getMindwtrToolErrorCode to 'internal_error' — while cloud-service.ts's
  // mapCloudError already mapped its own 404s to NotFoundError ('not_found'). Same user
  // mistake (editing a task that doesn't exist), two different reported codes. This pins both
  // adapters returning the same code now.
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

  // core-adapter.ts used to map this the same wrong way: a bogus areaId reference on addTask
  // is an input-validation mistake (nothing about the NEW task is "not found"), and cloud
  // already reported that as validation_error via its 400 response. Pins both adapters
  // agreeing now.
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

  // Before this task, service.ts's addTask only forwarded a fixed, hand-written field list to
  // core.addTask — checklist/areaId/reviewAt weren't in it, so they were silently dropped even
  // though nothing in the type system stopped a caller from passing them. This is the concrete
  // fixture the handoff's acceptance criteria names: a task created with these three fields
  // must land correctly through BOTH the local core adapter and the cloud adapter. Uses its
  // own services (not the shared `local`/`cloud` above) so writing a task here can't leak
  // state into the read-only listTasks fixtures elsewhere in this file.
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
      // addTask's container resolution checks a referenced areaId against the live store, so
      // the area has to exist through the same service instance first — a bootstrap-JSON area
      // isn't guaranteed visible by the time this runs.
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

  // Project.startDate (mirrors dueDate everywhere it's persisted/synced): pins that
  // mindwtr_add_project/mindwtr_update_project carry it through both the local core-backed
  // adapter and the cloud REST adapter's props bag, the same way dueDate already does. Own
  // services (not the shared `local`/`cloud` above) so writing here can't leak state into the
  // read-only listTasks fixtures elsewhere in this file.
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
