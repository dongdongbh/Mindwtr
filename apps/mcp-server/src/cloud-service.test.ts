import { describe, expect, test } from 'bun:test';
import type { AppData } from '@mindwtr/core';

import { createCloudService } from './cloud-service.js';

const iso = '2026-01-01T00:00:00.000Z';

const cloudData: AppData = {
  tasks: [
    {
      id: 'task-next',
      title: 'Call supplier',
      status: 'next',
      tags: ['#ops'],
      contexts: ['@phone'],
      description: 'Ask about the quote',
      projectId: 'project-1',
      dueDate: '2026-01-10',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    {
      id: 'task-inbox',
      title: 'Inbox note',
      status: 'inbox',
      tags: [],
      contexts: [],
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    // BUG-13: cloud search now runs core's filterTasksBySearch, the same operator language the
    // local adapter and every app surface use - a free-text term matches assignedTo (among
    // other fields) even though the title/description don't contain it, unlike the literal
    // title/description-only substring check this used to run.
    {
      id: 'task-token-only',
      title: 'Call finance',
      status: 'next',
      tags: ['#quote'],
      contexts: ['@quote'],
      assignedTo: 'Quote Owner',
      description: 'No matching body text',
      projectId: 'project-1',
      dueDate: '2026-01-11',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    {
      id: 'task-deleted',
      title: 'Deleted task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: iso,
      updatedAt: iso,
      deletedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  projects: [
    {
      id: 'project-1',
      title: 'Project One',
      status: 'active',
      color: '#6B7280',
      order: 0,
      tagIds: [],
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: 'project-deleted',
      title: 'Deleted Project',
      status: 'active',
      color: '#6B7280',
      order: 1,
      tagIds: [],
      createdAt: iso,
      updatedAt: iso,
      deletedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  sections: [
    {
      id: 'section-1',
      projectId: 'project-1',
      title: 'Section One',
      order: 0,
      createdAt: iso,
      updatedAt: iso,
    },
  ],
  areas: [
    {
      id: 'area-1',
      name: 'Work',
      order: 0,
      createdAt: iso,
      updatedAt: iso,
    },
  ],
  people: [
    {
      id: 'person-1',
      name: 'Alex',
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: 'person-deleted',
      name: 'Deleted Person',
      createdAt: iso,
      updatedAt: iso,
      deletedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  settings: {},
};

describe('cloud-backed MCP service', () => {
  test('reads and filters self-hosted Cloud data through /v1/data', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      return new Response(JSON.stringify(cloudData), { status: 200 });
    };
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher,
    });

    const tasks = await service.listTasks({
      status: 'next',
      projectId: 'project-1',
      search: 'quote',
      dueDateFrom: '2026-01-01',
      dueDateTo: '2026-01-31',
      sortBy: 'title',
      sortOrder: 'asc',
    });
    const task = await service.getTask({ id: 'task-next' });
    const projects = await service.listProjects();
    const sections = await service.listSections({ projectId: 'project-1' });
    const areas = await service.listAreas();
    const people = await service.listPeople();
    const deletedPeople = await service.listPeople({ includeDeleted: true });

    expect(requests[0]).toEqual({
      url: 'https://mindwtr.example.com/v1/data',
      authorization: 'Bearer cloud-token',
    });
    // 'task-token-only' matches via assignedTo ('Quote Owner'); sorted title asc,
    // 'Call finance' < 'Call supplier'.
    expect(tasks.map((item) => item.id)).toEqual(['task-token-only', 'task-next']);
    expect(task.title).toBe('Call supplier');
    expect(projects.map((item) => item.id)).toEqual(['project-1']);
    expect(sections.map((item) => item.id)).toEqual(['section-1']);
    expect(areas.map((item) => item.id)).toEqual(['area-1']);
    expect(people.map((item) => item.id)).toEqual(['person-1']);
    expect(deletedPeople.map((item) => item.id)).toEqual(['person-1', 'person-deleted']);
  });

  test('routes writes through the per-resource REST endpoints', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') return new Response(JSON.stringify(cloudData), { status: 200 });
      if (method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/v1/tasks')) {
        return new Response(JSON.stringify({ task: { ...cloudData.tasks[0], id: 'task-new', title: 'Created' } }), { status: 201 });
      }
      if (url.endsWith('/complete')) {
        return new Response(JSON.stringify({ task: { ...cloudData.tasks[0], status: 'done' } }), { status: 200 });
      }
      if (url.includes('/v1/tasks/')) {
        return new Response(JSON.stringify({ task: { ...cloudData.tasks[0], title: 'Patched' } }), { status: 200 });
      }
      if (url.includes('/v1/projects')) {
        return new Response(JSON.stringify({ project: cloudData.projects[0] }), { status: 200 });
      }
      if (url.includes('/v1/sections')) {
        return new Response(JSON.stringify({ section: cloudData.sections?.[0] }), { status: 200 });
      }
      if (url.includes('/v1/areas')) {
        return new Response(JSON.stringify({ area: cloudData.areas?.[0] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Unexpected route' }), { status: 500 });
    };
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher,
    });

    const created = await service.addTask({
      quickAdd: 'Buy milk @errands',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
    });
    expect(created.id).toBe('task-new');
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://mindwtr.example.com/v1/tasks',
      body: {
        input: 'Buy milk @errands',
        props: {
          recurrence: {
            rule: 'weekly',
            byDay: ['MO'],
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
          },
        },
      },
    });

    const patched = await service.updateTask({
      id: 'task-next',
      title: 'Patched',
      dueDate: null,
      recurrence: null,
    });
    expect(patched.title).toBe('Patched');
    expect(requests[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://mindwtr.example.com/v1/tasks/task-next',
      body: { title: 'Patched', dueDate: null, recurrence: null },
    });

    const completed = await service.completeTask('task-next');
    expect(completed.status).toBe('done');
    expect(requests[2]).toMatchObject({
      method: 'POST',
      url: 'https://mindwtr.example.com/v1/tasks/task-next/complete',
    });

    const deleted = await service.deleteTask('task-deleted');
    expect(deleted.id).toBe('task-deleted');
    expect(requests[3]).toMatchObject({
      method: 'DELETE',
      url: 'https://mindwtr.example.com/v1/tasks/task-deleted',
    });
    expect(requests[4]?.method).toBe('GET');

    await service.addProject({ title: 'New project', areaId: 'area-1' });
    expect(requests[5]).toMatchObject({
      method: 'POST',
      url: 'https://mindwtr.example.com/v1/projects',
      body: { title: 'New project', props: { areaId: 'area-1' } },
    });

    await service.updateArea({ id: 'area-1', color: null });
    expect(requests[6]).toMatchObject({
      method: 'PATCH',
      url: 'https://mindwtr.example.com/v1/areas/area-1',
      body: { color: null },
    });

    await service.addSection({ projectId: 'project-1', title: 'New section' });
    expect(requests[7]).toMatchObject({
      method: 'POST',
      url: 'https://mindwtr.example.com/v1/sections',
      body: { title: 'New section', projectId: 'project-1' },
    });
  });

  test('re-reads and recomputes a task link replacement after a conditional conflict', async () => {
    const originalLink = {
      id: 'link-old', kind: 'link' as const, title: 'Old', uri: 'https://example.com/old', createdAt: iso, updatedAt: iso,
    };
    const originalFile = {
      id: 'file-1', kind: 'file' as const, title: 'Draft.pdf', uri: '', createdAt: iso, updatedAt: iso,
    };
    const changedFile = { ...originalFile, title: 'Final.pdf', updatedAt: '2026-01-02T00:00:00.000Z' };
    const addedFile = {
      id: 'file-2', kind: 'file' as const, title: 'Appendix.pdf', uri: '', createdAt: iso, updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const deletedFile = {
      id: 'file-3', kind: 'file' as const, title: 'Removed.pdf', uri: '', createdAt: iso,
      updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z',
    };
    const afterConflict = {
      ...cloudData.tasks[0],
      attachments: [
        changedFile,
        addedFile,
        deletedFile,
        { ...originalLink, deletedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
    };
    const requests: Array<{ method: string; headers: Headers; body?: any }> = [];
    const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
    let getCount = 0;
    let patchCount = 0;
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      logInfo: (message, context) => logs.push({ message, context }),
      fetcher: async (_input, init) => {
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, headers, body });
        if (method === 'GET') {
          getCount += 1;
          const task = getCount === 1
            ? { ...cloudData.tasks[0], attachments: [originalFile, originalLink] }
            : afterConflict;
          return new Response(JSON.stringify({ task }), {
            status: 200,
            headers: { ETag: `"mindwtr-entity-sha256-${getCount}"` },
          });
        }
        patchCount += 1;
        if (patchCount === 1) {
          return new Response(JSON.stringify({ error: 'Entity changed; refresh and retry' }), { status: 412 });
        }
        return new Response(JSON.stringify({ task: { ...afterConflict, attachments: body.attachments } }), { status: 200 });
      },
    });

    const updated = await service.updateTask({
      id: 'task-next',
      attachments: [{ uri: 'obsidian://open?vault=work&file=notes' }],
    });

    expect(getCount).toBe(2);
    expect(patchCount).toBe(2);
    expect(requests.map((item) => item.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH']);
    expect(requests[0].headers.get('accept-encoding')).toBe('identity');
    expect(requests[1].headers.get('if-match')).toBe('"mindwtr-entity-sha256-1"');
    expect(requests[3].headers.get('if-match')).toBe('"mindwtr-entity-sha256-2"');
    expect(updated.attachments?.slice(0, 3)).toEqual([changedFile, addedFile, deletedFile]);
    expect(updated.attachments?.[3]).toMatchObject({
      id: 'link-old',
      deletedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(updated.attachments?.[4]).toMatchObject({
      kind: 'link',
      uri: 'obsidian://open?vault=work&file=notes',
    });
    expect(logs).toEqual([{
      message: 'MCP attachment link replacement committed',
      context: {
        releaseCheck: 'v1.2.8/mcp-attachment-link-guard',
        backend: 'cloud',
        entity: 'task',
      },
    }]);
  });

  test('re-reads and recomputes a project link replacement after a conditional conflict', async () => {
    const liveLink = {
      id: 'project-link-old', kind: 'link' as const, title: 'Old', uri: 'https://example.com/old', createdAt: iso, updatedAt: iso,
    };
    const deletedFile = {
      id: 'project-file-1', kind: 'file' as const, title: 'Deleted.pdf', uri: '', createdAt: iso,
      updatedAt: '2026-01-02T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z',
    };
    const originalFile = {
      id: 'project-file-2', kind: 'file' as const, title: 'Draft.pdf', uri: '', createdAt: iso, updatedAt: iso,
    };
    const changedFile = { ...originalFile, title: 'Final.pdf', updatedAt: '2026-01-02T00:00:00.000Z' };
    const addedFile = {
      id: 'project-file-3', kind: 'file' as const, title: 'New.pdf', uri: '', createdAt: iso, updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const beforeConflict = { ...cloudData.projects[0], attachments: [originalFile, liveLink] };
    const afterConflict = { ...cloudData.projects[0], attachments: [changedFile, deletedFile, addedFile, liveLink] };
    const requests: Array<{ method: string; headers: Headers; body?: any }> = [];
    let getCount = 0;
    let patchCount = 0;
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher: async (_input, init) => {
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, headers, body });
        if (method === 'GET') {
          getCount += 1;
          return new Response(JSON.stringify({ project: getCount === 1 ? beforeConflict : afterConflict }), {
            status: 200,
            headers: { ETag: `"mindwtr-entity-sha256-project-${getCount}"` },
          });
        }
        patchCount += 1;
        if (patchCount === 1) {
          return new Response(JSON.stringify({ error: 'Entity changed; refresh and retry' }), { status: 412 });
        }
        return new Response(JSON.stringify({ project: { ...afterConflict, attachments: body.attachments } }), { status: 200 });
      },
    });

    const updated = await service.updateProject({
      id: 'project-1',
      attachments: [{ uri: 'obsidian://open?vault=work&file=project' }],
    });

    expect(getCount).toBe(2);
    expect(patchCount).toBe(2);
    expect(requests.map((item) => item.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH']);
    expect(requests[3].headers.get('if-match')).toBe('"mindwtr-entity-sha256-project-2"');
    expect(updated.attachments?.slice(0, 3)).toEqual([changedFile, deletedFile, addedFile]);
    expect(updated.attachments?.[3]?.id).toBe('project-link-old');
    expect(typeof updated.attachments?.[3]?.deletedAt).toBe('string');
    expect(updated.attachments?.[4]).toMatchObject({
      kind: 'link',
      uri: 'obsidian://open?vault=work&file=project',
    });
  });

  test('stops task and project conditional attachment writes after three conflicts', async () => {
    for (const entity of ['task', 'project'] as const) {
      let getCount = 0;
      let patchCount = 0;
      const service = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'cloud-token',
        fetcher: async (_input, init) => {
          const method = init?.method ?? 'GET';
          if (method === 'GET') {
            getCount += 1;
            const value = entity === 'task' ? cloudData.tasks[0] : cloudData.projects[0];
            return new Response(JSON.stringify({ [entity]: value }), {
              status: 200,
              headers: { ETag: `"mindwtr-entity-sha256-${entity}-${getCount}"` },
            });
          }
          patchCount += 1;
          return new Response(JSON.stringify({ error: 'Entity changed; refresh and retry' }), { status: 412 });
        },
      });

      const operation = entity === 'task'
        ? service.updateTask({ id: 'task-next', attachments: [] })
        : service.updateProject({ id: 'project-1', attachments: [] });
      await expect(operation).rejects.toThrow(
        `${entity === 'task' ? 'Task' : 'Project'} changed during attachment link update after 3 attempts; refresh and retry.`,
      );
      expect(getCount).toBe(3);
      expect(patchCount).toBe(3);
    }
  });

  test('rejects task and project attachment writes before PATCH when the server lacks a strong ETag', async () => {
    for (const entity of ['task', 'project'] as const) {
      let patchCount = 0;
      const service = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'cloud-token',
        fetcher: async (_input, init) => {
          const method = init?.method ?? 'GET';
          if (method === 'PATCH') patchCount += 1;
          const value = entity === 'task' ? cloudData.tasks[0] : cloudData.projects[0];
          return new Response(JSON.stringify({ [entity]: value }), {
            status: 200,
            ...(entity === 'project' ? { headers: { ETag: 'W/"old-server"' } } : {}),
          });
        },
      });

      const operation = entity === 'task'
        ? service.updateTask({ id: 'task-next', attachments: [] })
        : service.updateProject({ id: 'project-1', attachments: [] });
      await expect(operation).rejects.toThrow(
        'Attachment link updates require Mindwtr Cloud 1.2.8 or newer; this server did not return a strong entity ETag.',
      );
      expect(patchCount).toBe(0);
    }
  });

  test('keeps scalar task and project updates unconditional', async () => {
    const requests: Array<{ method: string; headers: Headers; body?: any }> = [];
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher: async (input, init) => {
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, headers, body });
        const isProject = String(input).includes('/projects/');
        return new Response(JSON.stringify(isProject
          ? { project: { ...cloudData.projects[0], ...body } }
          : { task: { ...cloudData.tasks[0], ...body } }), { status: 200 });
      },
    });

    await service.updateTask({ id: 'task-next', title: 'Renamed task' });
    await service.updateProject({ id: 'project-1', title: 'Renamed project' });

    expect(requests.map((item) => item.method)).toEqual(['PATCH', 'PATCH']);
    expect(requests.every((item) => item.headers.get('if-match') === null)).toBe(true);
    expect(requests.map((item) => item.body)).toEqual([
      { title: 'Renamed task' },
      { title: 'Renamed project' },
    ]);
  });

  test('accepts null to remove every task and project link while preserving file records', async () => {
    const file = {
      id: 'file-1', kind: 'file' as const, title: 'Plan.pdf', uri: '', createdAt: iso, updatedAt: iso,
    };
    const liveLink = {
      id: 'link-live', kind: 'link' as const, title: 'Live', uri: 'https://example.com/live', createdAt: iso, updatedAt: iso,
    };
    const deletedLink = {
      id: 'link-deleted', kind: 'link' as const, title: 'Deleted', uri: 'https://example.com/deleted',
      createdAt: iso, updatedAt: iso, deletedAt: iso,
    };

    for (const entity of ['task', 'project'] as const) {
      let patchBody: {
        attachments?: Array<{ id: string; deletedAt?: string; [key: string]: unknown }>;
      } | undefined;
      const base = entity === 'task' ? cloudData.tasks[0] : cloudData.projects[0];
      const service = createCloudService({
        url: 'https://mindwtr.example.com',
        token: 'cloud-token',
        fetcher: async (_input, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return new Response(JSON.stringify({
              [entity]: { ...base, attachments: [file, liveLink, deletedLink] },
            }), { status: 200, headers: { ETag: `"mindwtr-entity-sha256-${entity}"` } });
          }
          patchBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({
            [entity]: { ...base, attachments: patchBody?.attachments },
          }), { status: 200 });
        },
      });

      if (entity === 'task') {
        await service.updateTask({ id: 'task-next', attachments: null });
      } else {
        await service.updateProject({ id: 'project-1', attachments: null });
      }

      expect(patchBody?.attachments?.[0]).toEqual(file);
      expect(patchBody?.attachments?.[1]?.id).toBe('link-live');
      expect(typeof patchBody?.attachments?.[1]?.deletedAt).toBe('string');
      expect(patchBody?.attachments?.[2]).toEqual(deletedLink);
    }
  });

  test('maps cloud API errors onto MCP error types', async () => {
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'PATCH') {
          return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 });
        }
        return new Response(JSON.stringify({ error: 'Invalid task status' }), { status: 400 });
      },
    });

    await expect(service.updateTask({ id: 'missing', title: 'x' })).rejects.toMatchObject({
      name: 'NotFoundError',
      message: 'Task not found',
    });
    await expect(service.addTask({ title: 'x', status: 'bogus' as never })).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid task status',
    });
  });

  test('rejects unsupported cloud writes with clear errors', async () => {
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher: async () => new Response(JSON.stringify(cloudData), { status: 200 }),
    });

    await expect(service.addPerson({ name: 'Alex' })).rejects.toThrow('does not support person edits');
    await expect(service.restoreTask('task-deleted')).rejects.toThrow('does not support restoring');
  });

  test('requires either title or quickAdd when adding a task', async () => {
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher: async () => new Response(JSON.stringify(cloudData), { status: 200 }),
    });

    await expect(service.addTask({})).rejects.toThrow('Either title or quickAdd is required');
    await expect(service.addTask({ title: 'a', quickAdd: 'b' })).rejects.toThrow('not both');
  });
});
