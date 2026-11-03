import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = 'packaged-fixture-api-token-1336';


const taskFixture = () => {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const task = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id, title: `Fixture ${id}`, status: 'next', tags: [], contexts: [],
    createdAt: timestamp, updatedAt: timestamp, rev: 1, revBy: 'fixture-device', ...extra,
  });
  const tasks = [
    task('first', { title: 'Needle A', projectId: 'project-a', dueDate: '2026-01-05', isFocusedToday: true }),
    task('second', { title: 'Needle B', projectId: 'project-a', dueDate: '2026-01-06', isFocusedToday: true }),
    task('third', { title: 'Needle C', projectId: 'project-a', dueDate: '2026-01-07', isFocusedToday: true }),
    task('other-project', { title: 'Needle Z', projectId: 'project-b', dueDate: '2026-01-06', isFocusedToday: true }),
    task('not-focused', { title: 'Needle Y', projectId: 'project-a', dueDate: '2026-01-06', isFocusedToday: false }),
    task('outside-dates', { title: 'Needle X', projectId: 'project-a', dueDate: '2026-02-01', isFocusedToday: true }),
    task('done', { title: 'Needle W', status: 'done', projectId: 'project-a', dueDate: '2026-01-06', isFocusedToday: true }),
    task('deleted', { deletedAt: timestamp }),
  ];
  const requests: { method: string; target: string; body?: unknown }[] = [];
  const failures: string[] = [];
  let creates = 0;
  const server = createServer(async (req, res) => {
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      failures.push('Missing expected bearer authentication');
      respond(401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const request: (typeof requests)[number] = { method: req.method ?? '', target: url.pathname + url.search };
    requests.push(request);
    if (req.method === 'GET' && url.pathname === '/projects' && !url.search) {
      respond(200, { projects: [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/tasks') {


      const query = url.searchParams;
      if (query.get('all') !== '1'
        || [...query.keys()].some((key) => !['all', 'deleted', 'status', 'isFocusedToday'].includes(key))) {
        failures.push('Expected GET /tasks?all=1 with only native filters');
        respond(400, { error: 'Unexpected fixture query' });
        return;
      }
      respond(200, { tasks: tasks.filter((row) => (query.get('deleted') === '1' || !row.deletedAt)
        && (!query.get('status') || row.status === query.get('status'))
        && (!query.has('isFocusedToday') || (row.isFocusedToday === true) === (query.get('isFocusedToday') === '1'))) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tasks') {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      try {
        const body = JSON.parse(raw);
        request.body = body;
        if (typeof body.title !== 'string' || !body.title.trim()
          || !body.props || typeof body.props !== 'object' || Array.isArray(body.props)
          || Object.keys(body).some((key) => !['title', 'props'].includes(key))
          || Object.keys(body.props).some((key) => !['status', 'description', 'tags', 'contexts'].includes(key))) {
          failures.push('Unexpected POST title/props envelope');
          respond(400, { error: 'Unsupported task creation fields' });
          return;
        }
        const created = task(`created-${++creates}`, {
          taskMode: 'task', pushCount: 0, status: 'inbox', ...body.props, title: body.title.trim(),
        });
        tasks.push(created);
        respond(201, { task: created });
      } catch {
        failures.push('Invalid POST JSON');
        respond(400, { error: 'Invalid JSON body' });
      }
      return;
    }
    failures.push(`Unexpected fixture route: ${req.method} ${url.pathname}`);
    respond(404, { error: 'Not found' });
  });
  return { server, requests, failures, tasks };
};

const stdioClient = (node: string, cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
  const child = spawn(node, [cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const records: any[] = [];
  const invalidLines: string[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
  const rejectPending = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const end = stdout.indexOf('\n');
      const line = stdout.slice(0, end).trim();
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        records.push(record);
        const entry = pending.get(record.id);
        if (entry) {
          pending.delete(record.id);
          entry.resolve(record);
        }
      } catch {
        invalidLines.push(line);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', rejectPending);
  child.once('close', () => rejectPending(new Error(`Installed MCP CLI exited before responding: ${stderr.replaceAll(token, '[redacted]')}`)));
  const timeout = setTimeout(() => {
    rejectPending(new Error('Installed MCP CLI exceeded 60 seconds'));
    child.kill('SIGKILL');
  }, 60_000);
  const request = async (method: string, params: unknown) => {
    const id = nextId++;
    const response = new Promise<any>((resolveResponse, reject) => pending.set(id, { resolve: resolveResponse, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  return {
    request,
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-package-fixture', version: '1' },
      });
      expect(response.result?.serverInfo).toBeTruthy();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return response.result;
    },
    async stop() {
      child.kill('SIGTERM');
      const shutdown = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await closed; } finally { clearTimeout(shutdown); clearTimeout(timeout); }
    },
    assertProtocol() {
      expect(invalidLines).toEqual([]);
      expect(stdout.trim()).toBe('');
      expect(records.length > 0).toBe(true);
      expect(records.every((record) => record.jsonrpc === '2.0')).toBe(true);
      expect(stderr).not.toContain(token);
    },
  };
};

const toolPayload = (response: any): any => {
  expect(response.error).toBeUndefined();
  expect(response.result?.isError ?? false).toBe(false);
  return JSON.parse(response.result.content[0].text);
};

test('installed npm tarball uses the Local API fixture on Node without SQLite, with safe read/write defaults', async () => {


  const tempRoot = join(homedir(), '.cache', 'mindwtr-mcp-package-tests');
  mkdirSync(tempRoot, { recursive: true });
  const outDir = mkdtempSync(join(tempRoot, 'mindwtr-mcp-package-'));
  const fixture = taskFixture();
  try {
    const staging = join(outDir, 'package');
    const installed = join(outDir, 'installed');
    mkdirSync(join(staging, 'dist'), { recursive: true });
    mkdirSync(installed);
    const environment = { ...process.env, TMPDIR: outDir, npm_config_cache: join(outDir, 'npm-cache') };
    const run = (command: string, args: string[], cwd: string) => {
      const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', timeout: 60_000 });
      if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
      return result.stdout;
    };

    const node = run('node', ['-p', 'process.execPath'], outDir).trim();
    expect(run(node, ['-p', 'typeof globalThis.Bun'], outDir).trim()).toBe('undefined');
    run('bun', [
      'build', join(packageRoot, 'src/index.ts'), '--target', 'node', '--format', 'esm',
      '--outfile', join(staging, 'dist/index.js'), '--define', 'process.env.NODE_ENV="production"',
      '--external=better-sqlite3', '--external=bun:sqlite',
    ], packageRoot);
    for (const filename of ['package.json', 'README.md']) copyFileSync(join(packageRoot, filename), join(staging, filename));
    copyFileSync(join(packageRoot, 'src/cli.ts'), join(staging, 'dist/cli.js'));
    const packOutput = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts'], staging));
    const packed = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0] as any;
    if (!packed?.files) throw new Error(`Unexpected npm pack output: ${JSON.stringify(packOutput)}`);
    const packedFiles = packed.files.map((file: { path: string }) => file.path);
    for (const filename of ['dist/index.js', 'dist/cli.js', 'README.md', 'package.json']) expect(packedFiles).toContain(filename);
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ private: true }));
    run('npm', ['install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', join(staging, packed.filename)], installed);
    const cli = join(installed, 'node_modules/mindwtr-mcp/dist/cli.js');
    expect(existsSync(cli)).toBe(true);
    const absenceProbe = `
      const { createRequire } = require('node:module');
      const requireFromPackage = createRequire(${JSON.stringify(cli)});
      try { requireFromPackage.resolve('better-sqlite3'); process.exit(1); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    `;
    run(node, ['-e', absenceProbe], installed);
    await new Promise<void>((resolveListen, reject) => {
      fixture.server.once('error', reject);
      fixture.server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = fixture.server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not receive a TCP port');
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const bogusDb = join(outDir, 'must-not-open.db');
    const runtimeEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('MINDWTR_')));
    const apiEnvironment = { ...runtimeEnvironment, MINDWTR_MCP_API_TOKEN: token, MINDWTR_DB_PATH: bogusDb };
    const reader = stdioClient(node, cli, ['--api-url', apiUrl], installed, apiEnvironment);
    try {
      const initialized = await reader.initialize();
      expect(initialized.serverInfo.version).toBe(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version);
      const tools = await reader.request('tools/list', {});
      expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('mindwtr_list_tasks');
      const listed = toolPayload(await reader.request('tools/call', {
        name: 'mindwtr_list_tasks', arguments: {
          status: 'next', projectId: 'project-a', search: 'Needle', isFocusedToday: true,
          dueDateFrom: '2026-01-01', dueDateTo: '2026-01-31', sortBy: 'title', sortOrder: 'desc', offset: 1, limit: 1,
        },
      }));
      expect(listed.tasks.map((task: { id: string }) => task.id)).toEqual(['second']);
      const withDeleted = toolPayload(await reader.request('tools/call', {
        name: 'mindwtr_list_tasks', arguments: { status: 'all', includeDeleted: true },
      }));
      expect(withDeleted.tasks.map((task: { id: string }) => task.id)).toContain('deleted');
      expect(fixture.requests.filter((request) => request.target.startsWith('/tasks')).map((request) => request.target))
        .toEqual(['/tasks?all=1&status=next&isFocusedToday=1', '/tasks?all=1&deleted=1']);
      const denied = await reader.request('tools/call', { name: 'mindwtr_add_task', arguments: { title: 'Blocked capture' } });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0].text).toContain('--write');
      expect(fixture.requests.some((request) => request.method === 'POST')).toBe(false);
    } finally { await reader.stop(); }
    reader.assertProtocol();
    const writer = stdioClient(node, cli, ['--api-url', apiUrl, '--write'], installed, apiEnvironment);
    try {
      await writer.initialize();
      const created = toolPayload(await writer.request('tools/call', {
        name: 'mindwtr_add_task', arguments: { title: 'Package capture', status: 'next', description: 'Fixture detail', tags: ['package'], contexts: ['@desk'] },
      }));
      expect(created.task).toMatchObject({ id: 'created-1', title: 'Package capture', status: 'next' });
      const after = toolPayload(await writer.request('tools/call', {
        name: 'mindwtr_list_tasks', arguments: { search: 'Package capture' },
      }));
      expect(after.tasks).toHaveLength(1);
      expect(after.tasks[0]).toMatchObject(created.task);
      expect(fixture.requests.find((request) => request.method === 'POST')?.body as object | undefined).toEqual({
        title: 'Package capture', props: { status: 'next', description: 'Fixture detail', tags: ['package'], contexts: ['@desk'] },
      });
    } finally { await writer.stop(); }
    writer.assertProtocol();
    expect(fixture.failures).toEqual([]);
    expect(existsSync(bogusDb)).toBe(false);


    const db = join(outDir, 'existing.db');
    writeFileSync(db, '');
    const sqlite = stdioClient(node, cli, ['--db', db], installed, runtimeEnvironment);
    try {
      await sqlite.initialize();
      const missingAddon = await sqlite.request('tools/call', { name: 'mindwtr_list_tasks', arguments: {} });
      expect(missingAddon.result.isError).toBe(true);
      const message = missingAddon.result.content[0].text;
      expect(message).toContain('optional better-sqlite3 addon');
      expect(message).toContain('optional dependencies');
      expect(message).toContain('--api-url');
    } finally { await sqlite.stop(); }
    sqlite.assertProtocol();
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolveClose) => fixture.server.close(() => resolveClose()));
    rmSync(outDir, { recursive: true, force: true });
  }
}, 240_000);
