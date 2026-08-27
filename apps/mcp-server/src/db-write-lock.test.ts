import { describe, expect, test } from 'bun:test';
import { SqliteAdapter, type SqliteClient } from '@mindwtr/core';
import { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForPath = async (path: string, timeoutMs = 5_000): Promise<void> => {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${path}`);
    await delay(10);
  }
};

const waitForChildExit = async (child: ChildProcess, timeoutMs: number): Promise<number | null> => {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      resolve(code);
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for MCP write lock worker'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
};

describe('MCP cross-process database write lock', () => {
  test('serializes two process clients around a read-modify-write barrier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-lock-'));
    const workerPath = join(testDirectory, 'test-fixtures', 'mcp-write-lock-worker.ts');
    const dbPath = join(dir, 'mindwtr.db');
    const counterPath = join(dir, 'counter.txt');
    const holderReadyPath = join(dir, 'holder-ready');
    const contenderEnteredPath = join(dir, 'contender-entered');
    const releasePath = join(dir, 'release-holder');
    const children: ChildProcess[] = [];

    try {
      const holder = spawn(process.execPath, [
        workerPath,
        'hold',
        dbPath,
        holderReadyPath,
        counterPath,
        releasePath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(holder);
      await waitForPath(holderReadyPath);

      const contender = spawn(process.execPath, [
        workerPath,
        'increment',
        dbPath,
        contenderEnteredPath,
        counterPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(contender);

      await delay(100);
      expect(existsSync(contenderEnteredPath)).toBe(false);
      writeFileSync(releasePath, 'release');

      expect(await Promise.all(children.map((child) => waitForChildExit(child, 5_000))))
        .toEqual([0, 0]);
      expect(existsSync(contenderEnteredPath)).toBe(true);
      expect(readFileSync(counterPath, 'utf8')).toBe('2');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects an MCP snapshot after a desktop-style process changes the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-cas-'));
    const workerPath = join(testDirectory, 'test-fixtures', 'mcp-guarded-write-worker.ts');
    const dbPath = join(dir, 'mindwtr.db');
    const readyPath = join(dir, 'worker-ready');
    const releasePath = join(dir, 'release-worker');
    const outcomePath = join(dir, 'worker-outcome');
    const db = new Database(dbPath);
    const client: SqliteClient = {
      run: async (sql, params = []) => { db.prepare(sql).run(params); },
      all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(params) as T[],
      get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(params) as T | undefined,
      exec: async (sql) => { db.exec(sql); },
    };
    const seedAdapter = new SqliteAdapter(client);
    await seedAdapter.ensureSchema();
    await seedAdapter.saveData({
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: { theme: 'light' },
    });
    db.close();

    const worker = spawn(process.execPath, [workerPath, dbPath, readyPath, releasePath, outcomePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      await waitForPath(readyPath);
      const desktopDb = new Database(dbPath);
      try {
        desktopDb.exec('BEGIN IMMEDIATE;');
        desktopDb.prepare('UPDATE settings SET data = ? WHERE id = 1')
          .run(JSON.stringify({ theme: 'dark' }));
        desktopDb.exec('COMMIT;');
      } finally {
        desktopDb.close();
      }
      writeFileSync(releasePath, 'release');

      expect(await waitForChildExit(worker, 5_000)).toBe(0);
      expect(readFileSync(outcomePath, 'utf8'))
        .toContain('SQLITE_BUSY: database changed after the automation snapshot was loaded (external commit)');

      const verificationDb = new Database(dbPath, { readonly: true });
      try {
        const settings = verificationDb.prepare('SELECT data FROM settings WHERE id = 1')
          .get() as { data: string };
        const projectCount = verificationDb.prepare('SELECT COUNT(*) AS count FROM projects')
          .get() as { count: number };
        expect(JSON.parse(settings.data)).toEqual({ theme: 'dark' });
        expect(projectCount.count).toBe(0);
      } finally {
        verificationDb.close();
      }
    } finally {
      worker.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
