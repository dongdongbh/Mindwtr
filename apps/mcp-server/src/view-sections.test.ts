import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppData } from '@mindwtr/core';

import { createCloudService } from './cloud-service.js';
import { registerMindwtrTools } from './index.js';
import { createLocalApiService } from './local-api-service.js';
import { createService, type MindwtrService } from './service.js';
import { listViewSectionsFromSettings } from './view-sections.js';

const seed: AppData = {
  tasks: [], projects: [], sections: [], areas: [], people: [],
  settings: {
    theme: 'dark',
    gtd: { viewSections: {
      someday: [{ id: 'books', title: 'Books', order: 2 }, { id: 'travel', title: 'Travel', order: 1 }],
      waiting: [{ id: 'people', title: 'People', order: 0 }],
      focus: [{ id: 'deep', title: 'Deep work', order: 0 }],
    } },
  },
};
const first = { someday: 'books', waiting: 'people', futureView: 'future-section' };
const replacement = { someday: 'travel' };

const connectTools = async (service: MindwtrService, readonly = false, localApi = false) => {
  const server = new McpServer({ name: 'view-sections-test', version: '1' });
  registerMindwtrTools(server, service, readonly, { localApi });
  const client = new Client({ name: 'view-sections-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError === true).toBe(false);
      const content = result.content;
      if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected text tool response');
      return JSON.parse(content[0].text);
    },
    close: async () => { await client.close(); await server.close(); },
  };
};

describe('MCP view sections (#1439)', () => {
  for (const backend of ['sqlite', 'cloud'] as const) {
    test(`${backend}: registered tools persist task/project create, replace, omit and clear maps`, async () => {
      const scratchRoot = join(homedir(), '.cache', 'mindwtr-mcp-tests');
      mkdirSync(scratchRoot, { recursive: true });
      const dir = mkdtempSync(join(scratchRoot, 'view-sections-'));
      const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = (message: string, context?: Record<string, unknown>) => logs.push({ message, context });
      let child: ChildProcess | undefined;
      let childErrors = "";
      let service: MindwtrService | undefined;
      let tools: Awaited<ReturnType<typeof connectTools>> | undefined;
      let readonlyTools: Awaited<ReturnType<typeof connectTools>> | undefined;
      let readPersisted: () => Promise<AppData>;
      try {
        if (backend === 'sqlite') {
          writeFileSync(join(dir, 'data.json'), JSON.stringify(seed));
          service = createService({ dbPath: join(dir, 'mindwtr.db'), readonly: false }, undefined, logger);
          readPersisted = async () => ({ ...seed, tasks: await service!.listTasks({}), projects: await service!.listProjects() });
        } else {
          const ready = join(dir, 'ready');
          child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../../cloud/src/test-fixtures/cloud-server-worker.ts'), dir, ready], { stdio: ['ignore', 'ignore', 'pipe'] });
          child.stderr?.on('data', (data) => { childErrors += data.toString(); });
          const deadline = Date.now() + 15_000;
          while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
          if (!existsSync(ready)) throw new Error(`Cloud worker failed: ${childErrors}`);
          const url = `http://127.0.0.1:${readFileSync(ready, 'utf8')}`;
          const headers = { Authorization: 'Bearer view-section-test-token', 'Content-Type': 'application/json' };
          const seeded = await fetch(`${url}/v1/data`, { method: 'PUT', headers, body: JSON.stringify(seed) });
          expect(seeded.status).toBe(200);
          service = createCloudService({ url, token: 'view-section-test-token', allowInsecureHttp: true, logInfo: logger });
          readPersisted = async () => (await fetch(`${url}/v1/data`, { headers })).json();
        }
        tools = await connectTools(service);
        readonlyTools = await connectTools(service, true);
        const advertised = await readonlyTools.client.listTools();
        expect(advertised.tools.some((tool) => tool.name === 'mindwtr_list_view_sections')).toBe(true);
        const catalogue = await readonlyTools.call('mindwtr_list_view_sections', {});
        expect(catalogue).toEqual({ viewSections: [
          { view: 'someday', id: 'travel', title: 'Travel', order: 1 },
          { view: 'someday', id: 'books', title: 'Books', order: 2 },
          { view: 'waiting', id: 'people', title: 'People', order: 0 },
          { view: 'focus', id: 'deep', title: 'Deep work', order: 0 },
        ] });
        expect(await readonlyTools.call('mindwtr_list_view_sections', { view: 'waiting' })).toEqual({ viewSections: [catalogue.viewSections[2]] });
        const denied = await readonlyTools.client.callTool({ name: 'mindwtr_add_task', arguments: { title: 'Denied', viewSectionIds: first } });
        expect(denied.isError === true).toBe(true);
        expect((await readPersisted()).tasks).toHaveLength(0);

        for (const entityType of ['task', 'project'] as const) {
          const create = `mindwtr_add_${entityType}`;
          const update = `mindwtr_update_${entityType}`;
          const created = (await tools.call(create, { title: 'Section assignment', status: 'someday', viewSectionIds: first }))[entityType];
          const collection = entityType === 'task' ? 'tasks' : 'projects';
          const persisted = async () => (await readPersisted())[collection].find((entity) => entity.id === created.id)!;
          expect(created.viewSectionIds).toEqual(first);
          expect((await persisted()).viewSectionIds).toEqual(first);
          const rev = (await persisted()).rev;
          await tools.call(update, { id: created.id, title: 'Renamed' });
          expect((await persisted()).viewSectionIds).toEqual(first);
          await tools.call(update, { id: created.id, viewSectionIds: replacement });
          expect((await persisted()).viewSectionIds).toEqual(replacement);
          expect((await persisted()).status).toBe('someday');
          expect(((await persisted()).rev ?? 0) > (rev ?? 0)).toBe(true);
          for (const clear of [null, {}]) {
            await tools.call(update, { id: created.id, viewSectionIds: first });
            await tools.call(update, { id: created.id, viewSectionIds: clear });
            expect((await persisted()).viewSectionIds).toEqual({});
          }
          const logCount = logs.length;
          for (const invalid of [[], 'books', { someday: 42 }, { someday: ' ' }, { someday: null }]) {
            const result = await tools.client.callTool({ name: update, arguments: { id: created.id, viewSectionIds: invalid } });
            expect(result.isError === true).toBe(true);
            const badCreate = await tools.client.callTool({ name: create, arguments: { title: 'Invalid map', viewSectionIds: invalid } });
            expect(badCreate.isError === true).toBe(true);
            await expect(entityType === 'task'
              ? service.addTask({ title: 'Invalid map', viewSectionIds: invalid as never })
              : service.addProject({ title: 'Invalid map', viewSectionIds: invalid as never })).rejects.toThrow('viewSectionIds');
            await expect(entityType === 'task'
              ? service.updateTask({ id: created.id, viewSectionIds: invalid as never })
              : service.updateProject({ id: created.id, viewSectionIds: invalid as never })).rejects.toThrow('viewSectionIds');
          }
          expect((await persisted()).viewSectionIds).toEqual({});
          expect(logs).toHaveLength(logCount);
        }
        expect(logs).toHaveLength(12);
        expect(logs.every(({ message, context }) => message === 'MCP view section assignment committed'
          && JSON.stringify(context).includes('v1.3.8/mcp-view-sections')
          && !JSON.stringify(context).includes('books'))).toBe(true);
      } finally {
        await readonlyTools?.close();
        await tools?.close();
        await service?.close();
        if (child && child.exitCode === null) {
          const exited = new Promise((resolve) => child!.once('exit', resolve));
          child.kill();
          await exited;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('catalogue filters removed and malformed definitions without leaking settings', () => {
    const settings = JSON.parse(JSON.stringify(seed.settings));
    settings.gtd.viewSections.someday.push(null, 42, 'bad', {}, { id: 'deleted', title: 'Removed', order: 0, deletedAt: '2026-01-01' },
      { id: 'legacy', title: 'Legacy', order: { privateMetadata: 'must not leak' } });
    expect(listViewSectionsFromSettings(settings, { view: 'someday' })).toEqual([
      { view: 'someday', id: 'travel', title: 'Travel', order: 1 },
      { view: 'someday', id: 'books', title: 'Books', order: 2 },
      { view: 'someday', id: 'legacy', title: 'Legacy' },
    ]);
    expect(listViewSectionsFromSettings({})).toEqual([]);
  });

  test('Local API tasks forward maps, projects reject maps, and catalogue is hidden', async () => {
    const bodies: unknown[] = [];
    const service = createLocalApiService({ url: 'http://127.0.0.1:3000', token: 'test-token', fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({ task: { id: 'task', title: 'Task', status: 'inbox', tags: [], contexts: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...(body.props ?? body) } });
    } });
    const tools = await connectTools(service, false, true);
    try {
      expect((await tools.client.listTools()).tools.some((tool) => tool.name === 'mindwtr_list_view_sections')).toBe(false);
      await tools.call('mindwtr_add_task', { title: 'Task', viewSectionIds: first });
      await tools.call('mindwtr_update_task', { id: 'task', viewSectionIds: null });
      expect(bodies).toEqual([{ title: 'Task', props: { viewSectionIds: first } }, { viewSectionIds: {} }]);
      const rejected = await tools.client.callTool({ name: 'mindwtr_add_project', arguments: { title: 'Project', viewSectionIds: first } });
      expect(rejected.isError === true).toBe(true);
      await expect(service.addProject({ title: 'Project', viewSectionIds: first })).rejects.toThrow('unsupported');
      await expect(service.listViewSections()).rejects.toThrow('does not support');
      expect(bodies).toHaveLength(2);
    } finally { await tools.close(); }
  });
});
