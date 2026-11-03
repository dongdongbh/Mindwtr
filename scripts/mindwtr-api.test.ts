import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const BUN_BIN = Bun.which('bun') || process.execPath;
const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindwtr-api-'));
  tempDirs.push(dir);
  return dir;
};

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Failed to allocate a test port'));
        }
      });
    });
  });

const waitForHealth = async (baseUrl: string, token?: string) => {
  let lastError: unknown = null;


  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw lastError instanceof Error ? lastError : new Error('Local API did not become ready');
};

type SpawnApiOptions = {
  corsOrigin?: string;
  dangerouslyDisableAuth?: boolean;
  token?: string;
};


const SPAWN_TEST_TIMEOUT_MS = 60_000;

const spawnApi = (
  port: number,
  dataPath: string,
  options: SpawnApiOptions = { dangerouslyDisableAuth: true },
) => {
  const cmd = [
      BUN_BIN,
      'scripts/mindwtr-api.ts',
      '--',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--data',
      dataPath,
  ];
  if (options.dangerouslyDisableAuth !== false) {
    cmd.push('--dangerously-disable-auth');
  }
  return Bun.spawn({
    cmd,
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MINDWTR_API_CORS_ORIGIN: options.corsOrigin ?? '',
      MINDWTR_API_TOKEN: options.token ?? '',
    },
  });
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('mindwtr-api', () => {
  test('refuses to start without a bearer token unless auth is dangerously disabled', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const server = spawnApi(port, dataPath, { dangerouslyDisableAuth: false });

    const exitCode = await Promise.race([
      server.exited,
      Bun.sleep(5_000).then(() => null),
    ]);
    if (exitCode === null) {
      server.kill();
      await server.exited.catch(() => undefined);
    }
    const stderr = await new Response(server.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('MINDWTR_API_TOKEN');
    expect(stderr).toContain('--dangerously-disable-auth');
  }, SPAWN_TEST_TIMEOUT_MS);

  test('refuses wildcard CORS configuration', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const server = spawnApi(port, dataPath, { corsOrigin: '*' });

    const exitCode = await Promise.race([
      server.exited,
      Bun.sleep(5_000).then(() => null),
    ]);
    if (exitCode === null) {
      server.kill();
      await server.exited.catch(() => undefined);
    }
    const stderr = await new Response(server.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('MINDWTR_API_CORS_ORIGIN');
    expect(stderr).toContain('exact http(s) origin');
  }, SPAWN_TEST_TIMEOUT_MS);

  test('requires the configured bearer token for API requests', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = 'test-only-strong-local-api-token';
    const server = spawnApi(port, dataPath, {
      dangerouslyDisableAuth: false,
      token,
    });

    try {
      await waitForHealth(baseUrl, token);

      expect((await fetch(`${baseUrl}/areas`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/areas`, {
        headers: { Authorization: 'Bearer wrong-token' },
      })).status).toBe(401);
      expect((await fetch(`${baseUrl}/areas`, {
        headers: { Authorization: `Bearer ${token}` },
      })).status).toBe(200);
    } finally {
      server.kill();
      await server.exited.catch(() => undefined);
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test('does not expose CORS headers unless an origin is configured', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = spawnApi(port, dataPath);

    try {
      await waitForHealth(baseUrl);

      const response = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://untrusted.example' },
      });
      const preflight = await fetch(`${baseUrl}/tasks`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://untrusted.example',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      server.kill();
      await server.exited.catch(() => undefined);
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test('returns CORS headers only to the exact configured origin', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const trustedOrigin = 'https://automation.example';
    const server = spawnApi(port, dataPath, { corsOrigin: trustedOrigin });

    try {
      await waitForHealth(baseUrl);

      const trustedPreflight = await fetch(`${baseUrl}/tasks`, {
        method: 'OPTIONS',
        headers: {
          Origin: trustedOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      const untrustedResponse = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://untrusted.example' },
      });
      const untrustedPreflight = await fetch(`${baseUrl}/tasks`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://untrusted.example',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(trustedPreflight.headers.get('access-control-allow-origin')).toBe(trustedOrigin);
      expect(trustedPreflight.headers.get('vary')).toContain('Origin');
      expect(untrustedResponse.headers.get('access-control-allow-origin')).toBeNull();
      expect(untrustedPreflight.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      server.kill();
      await server.exited.catch(() => undefined);
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test('lists active areas from the Local API', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const now = '2026-04-27T12:00:00.000Z';

    writeFileSync(
      dataPath,
      JSON.stringify(
        {
          tasks: [],
          projects: [],
          sections: [],
          areas: [
            {
              id: 'area-work',
              name: 'Work',
              color: '#2563eb',
              icon: 'briefcase',
              order: 2,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: 'area-deleted',
              name: 'Deleted',
              color: '#64748b',
              order: 3,
              createdAt: now,
              updatedAt: now,
              deletedAt: now,
            },
          ],
          settings: {},
        },
        null,
        2
      )
    );

    const server = spawnApi(port, dataPath);

    try {
      await waitForHealth(baseUrl);

      const response = await fetch(`${baseUrl}/areas`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        areas: Array<Record<string, unknown>>;
      };
      expect(body.areas).toHaveLength(1);
      expect(body.areas[0]).toMatchObject({
        id: 'area-work',
        name: 'Work',
        color: '#2563eb',
        icon: 'briefcase',
        order: 2,
        createdAt: now,
        updatedAt: now,
      });

      const aliasResponse = await fetch(`${baseUrl}/v1/areas`);
      expect(aliasResponse.status).toBe(200);
      const aliasBody = (await aliasResponse.json()) as {
        areas: Array<Record<string, unknown>>;
      };
      expect(aliasBody.areas[0]?.id).toBe('area-work');
    } finally {
      server.kill();
      await server.exited.catch(() => undefined);
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test('filters tasks by isFocusedToday from the Local API', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const now = '2026-04-27T12:00:00.000Z';

    writeFileSync(
      dataPath,
      JSON.stringify(
        {


          tasks: [
            { id: 'starred', title: 'Starred', status: 'next', isFocusedToday: true, createdAt: now, updatedAt: now },
            { id: 'starred-numeric', title: 'Starred numeric', status: 'next', isFocusedToday: 1, createdAt: now, updatedAt: now },
            { id: 'plain', title: 'Plain', status: 'next', createdAt: now, updatedAt: now },
          ],
          projects: [],
          sections: [],
          areas: [],
          settings: {},
        },
        null,
        2
      )
    );

    const server = spawnApi(port, dataPath);

    try {
      await waitForHealth(baseUrl);

      const ids = async (queryString: string): Promise<string[]> => {
        const response = await fetch(`${baseUrl}/tasks${queryString}`);
        expect(response.status).toBe(200);
        return ((await response.json()) as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);
      };

      expect((await ids('?isFocusedToday=true')).sort()).toEqual(['starred', 'starred-numeric']);
      expect((await ids('?isFocusedToday=1')).sort()).toEqual(['starred', 'starred-numeric']);
      expect(await ids('?isFocusedToday=false')).toEqual(['plain']);
      expect((await ids('')).sort()).toEqual(['plain', 'starred', 'starred-numeric']);


      const invalid = await fetch(`${baseUrl}/tasks?isFocusedToday=yes`);
      expect(invalid.status).toBe(400);
    } finally {
      server.kill();
      await server.exited.catch(() => undefined);
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test('manages project sections and task sectionId from the Local API', async () => {
    const dir = makeTempDir();
    const dataPath = join(dir, 'data.json');
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const now = '2026-04-27T12:00:00.000Z';

    writeFileSync(
      dataPath,
      JSON.stringify(
        {
          tasks: [],
          projects: [
            {
              id: 'project-build',
              title: 'Build',
              status: 'active',
              color: '#2563eb',
              order: 1,
              tagIds: [],
              isSequential: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
          sections: [],
          areas: [],
          settings: {},
        },
        null,
        2
      )
    );

    const server = spawnApi(port, dataPath);

    try {
      await waitForHealth(baseUrl);

      const createSectionResponse = await fetch(`${baseUrl}/sections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-build', title: 'Phase A', description: 'First pass' }),
      });
      expect(createSectionResponse.status).toBe(201);
      const createSectionBody = (await createSectionResponse.json()) as { section: Record<string, any> };
      expect(createSectionBody.section).toMatchObject({
        projectId: 'project-build',
        title: 'Phase A',
        description: 'First pass',
      });
      const sectionId = String(createSectionBody.section.id);

      const createTaskResponse = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Scoped task', sectionId }),
      });
      expect(createTaskResponse.status).toBe(201);
      const createTaskBody = (await createTaskResponse.json()) as { task: Record<string, any> };
      expect(createTaskBody.task.projectId).toBe('project-build');
      expect(createTaskBody.task.sectionId).toBe(sectionId);
      const taskId = String(createTaskBody.task.id);

      const listResponse = await fetch(`${baseUrl}/v1/sections?projectId=project-build`);
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as { sections: Array<Record<string, any>> };
      expect(listBody.sections.map((section) => section.id)).toContain(sectionId);

      const updateSectionResponse = await fetch(`${baseUrl}/sections/${encodeURIComponent(sectionId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Phase B', isCollapsed: true }),
      });
      expect(updateSectionResponse.status).toBe(200);
      const updateSectionBody = (await updateSectionResponse.json()) as { section: Record<string, any> };
      expect(updateSectionBody.section).toMatchObject({ id: sectionId, title: 'Phase B', isCollapsed: true });

      const clearTaskSectionResponse = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sectionId: null }),
      });
      expect(clearTaskSectionResponse.status).toBe(200);
      const clearTaskSectionBody = (await clearTaskSectionResponse.json()) as { task: Record<string, any> };
      expect(clearTaskSectionBody.task.sectionId).toBeUndefined();

      const deleteSectionResponse = await fetch(`${baseUrl}/sections/${encodeURIComponent(sectionId)}`, {
        method: 'DELETE',
      });
      expect(deleteSectionResponse.status).toBe(200);

      const listAfterDeleteResponse = await fetch(`${baseUrl}/sections?projectId=project-build`);
      expect(listAfterDeleteResponse.status).toBe(200);
      const listAfterDeleteBody = (await listAfterDeleteResponse.json()) as { sections: Array<Record<string, any>> };
      expect(listAfterDeleteBody.sections.map((section) => section.id)).not.toContain(sectionId);
    } finally {
      server.kill();
      await server.exited.catch(() => undefined);
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});
