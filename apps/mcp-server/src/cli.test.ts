import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const buildArgs = (entry: string, outfile: string): string[] => [
  'build', entry,
  '--target', 'node',
  '--format', 'esm',
  '--outfile', outfile,
  '--define', 'process.env.NODE_ENV="production"',
  '--external=better-sqlite3',
  '--external=bun:sqlite',
];


const runsToCompletion = (scriptPath: string, args: string[], cwd: string, timeoutMs: number): Promise<boolean> => (
  new Promise((resolvePromise) => {


    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.on('exit', () => finish(true));
    child.on('error', () => finish(false));
  })
);


describe('published library entry has no import-time side effect (BUG-14)', () => {
  test('importing the built dist/index.js does not start a server or hang the process', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-cli-guard-'));
    try {
      const outfile = join(outDir, 'index.js');
      const build = spawnSync('bun', buildArgs(join(packageRoot, 'src/index.ts'), outfile), {
        cwd: packageRoot,
        timeout: 60_000,
      });
      expect(build.status).toBe(0);

      const importerPath = join(outDir, 'importer.mjs');
      writeFileSync(importerPath, `import ${JSON.stringify(outfile)};\n`);
      const dbPath = join(outDir, 'probe.db');

      const exitedOnItsOwn = await runsToCompletion(importerPath, ['--db', dbPath], outDir, 15000);

      expect(exitedOnItsOwn).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

test('a real MCP write forwards core retention diagnostics to stderr without corrupting JSON-RPC stdout', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-core-stdio-'));
  const dbPath = join(outDir, 'mindwtr.db');
  const archivedAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(join(outDir, 'data.json'), JSON.stringify({
    tasks: [],
    projects: [{ id: 'archived', title: 'Synthetic archived project', status: 'archived', color: '#000000', order: 0, tagIds: [], createdAt: archivedAt, updatedAt: archivedAt, rev: 1 }],
    sections: [{ id: 'section', title: 'Synthetic section', projectId: 'archived', order: 0, createdAt: archivedAt, updatedAt: archivedAt, deletedAt: archivedAt, projectArchivedAt: archivedAt, rev: 1 }],
    areas: [], people: [], settings: { deviceId: 'stdio-probe', migrations: { version: 1, lastTombstoneCleanupAt: archivedAt } },
  }));
  const child = spawn(process.execPath, [join(packageRoot, 'src/cli.ts'), '--db', dbPath, '--write', '--nowait'], {
    cwd: packageRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
  const responses = new Map<number, { resolve: (response: any) => void; reject: (error: Error) => void }>();
  const stdoutRecords: any[] = [];
  const invalidStdoutLines: string[] = [];
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes('\n')) {
      const end = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, end).trim();
      stdoutBuffer = stdoutBuffer.slice(end + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        stdoutRecords.push(record);
        const pending = responses.get(record.id);
        if (pending) {
          responses.delete(record.id);
          pending.resolve(record);
        }
      } catch {
        invalidStdoutLines.push(line);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', (error) => {
    for (const pending of responses.values()) pending.reject(error);
  });
  child.on('exit', () => {
    for (const pending of responses.values()) pending.reject(new Error('MCP exited before responding'));
  });
  const request = (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolveResponse, reject) => {
      responses.set(id, { resolve: resolveResponse, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1.0' },
    });
    expect(initialized.result).toBeTruthy();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const added = await request('tools/call', { name: 'mindwtr_add_task', arguments: { title: 'Synthetic capture' } });
    expect(added.result?.isError ?? false).toBe(false);
    child.kill('SIGTERM');
    expect(await closed).toBe(0);
    expect(invalidStdoutLines).toEqual([]);
    expect(stdoutRecords.length >= 2).toBe(true);
    expect(stdoutRecords.every((record) => record.jsonrpc === '2.0')).toBe(true);
    expect(stderr).toContain('v1.3.1/archive-section-retention');
    expect(stderr).toContain('v1.3.1/mcp-core-log-stderr');
    expect(stderr.match(/v1\.3\.1\/mcp-core-log-stderr/g)).toHaveLength(1);
    expect(stdoutBuffer.trim()).toBe('');

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT title FROM tasks WHERE title = ?').get('Synthetic capture'))
        .toMatchObject({ title: 'Synthetic capture' });
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(outDir, { recursive: true, force: true });
  }
}, 20_000);

test('core logs keep severity and sanitized metadata only after MCP startup', () => {
  const script = `
    import { startMcpServer } from './src/index.ts';
    import { logError, logInfo, logWarn } from '@mindwtr/core';
    logInfo('Before MCP startup');
    await startMcpServer(['--cloud-url', 'https://example.invalid', '--cloud-token', 'fixture-token', '--nowait']);
    logInfo('Core info after startup', {
      scope: 'sync', category: 'storage',
      context: { releaseCheck: 'v1.3.1/original-core-event', title: 'Private capture', token: 'secret' },
    });
    logWarn('Core warning token=secret', { scope: 'storage', category: 'validation' });
    logError('Core error Authorization: Bearer secret', {
      scope: 'storage', category: 'storage', error: new Error('password=secret'),
    });
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: packageRoot,
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(child.status).toBe(0);
  expect(child.stdout).toContain('Before MCP startup');
  expect(child.stdout).not.toContain('Core info after startup');
  expect(child.stdout).not.toContain('Core warning');
  expect(child.stdout).not.toContain('Core error');
  const records = child.stderr.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const core = records.filter((record) => record.scope !== 'mcp');
  expect(core.map((record) => record.level)).toEqual(['info', 'warn', 'error']);
  expect(core.map((record) => record.scope)).toEqual(['sync', 'storage', 'storage']);
  expect(core[0].category).toBe('storage');
  expect(core[0].context).toMatchObject({
    releaseCheck: 'v1.3.1/original-core-event', title: '[redacted]', token: '[redacted]',
  });
  expect(core[1].message).toContain('token=[redacted]');
  expect(core[2].message).toContain('Bearer [redacted]');
  expect(core[2].context.error).toContain('password=[redacted]');
  expect(child.stderr).not.toContain('Private capture');
  expect(child.stderr).not.toContain('password=secret');
  expect(records.filter((record) => record.context?.releaseCheck === 'v1.3.1/mcp-core-log-stderr')).toHaveLength(1);
});
