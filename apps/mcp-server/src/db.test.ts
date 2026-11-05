import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { setTimeout as waitFor } from 'timers/promises';
import { fileURLToPath } from 'url';

import { closeDb, ensureMindwtrDbPath, openMindwtrDb } from './db.js';

const tempDirs: string[] = [];
const originalPlatform = process.platform;
const originalEnv = {
  APPDATA: process.env.APPDATA,
  MINDWTR_DB_PATH: process.env.MINDWTR_DB_PATH,
  MINDWTR_DB: process.env.MINDWTR_DB,
};

const setPlatform = (platform: string) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-db-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  setPlatform(originalPlatform);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('mcp db bootstrap', () => {
  test('bootstraps a missing sqlite database from sibling data.json', async () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'mindwtr.db');
    const dataPath = join(dir, 'data.json');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      writeFileSync(
        dataPath,
        JSON.stringify(
          {
            tasks: [
              {
                id: 'task-1',
                title: 'Bootstrap task',
                status: 'inbox',
                createdAt: '2026-04-13T00:00:00.000Z',
                updatedAt: '2026-04-13T00:00:00.000Z',
              },
            ],
            projects: [],
            sections: [],
            areas: [],
            people: [
              {
                id: 'person-1',
                name: 'Alex',
                note: 'Design lead',
                referenceLink: 'https://example.com/alex',
                createdAt: '2026-04-13T00:00:00.000Z',
                updatedAt: '2026-04-13T00:00:00.000Z',
              },
            ],
            settings: {},
          },
          null,
          2
        )
      );

      const { db, path } = await openMindwtrDb({ dbPath, readonly: true });
      try {
        expect(path).toBe(dbPath);
        expect(existsSync(dbPath)).toBe(true);
        expect(
          db.prepare('SELECT id, title, status FROM tasks ORDER BY id').all()
        ).toEqual([{ id: 'task-1', title: 'Bootstrap task', status: 'inbox' }]);
        expect(
          db.prepare('SELECT id, name, note, referenceLink FROM people ORDER BY id').all()
        ).toEqual([
          {
            id: 'person-1',
            name: 'Alex',
            note: 'Design lead',
            referenceLink: 'https://example.com/alex',
          },
        ]);
      } finally {
        closeDb(db);
      }
      expect(warnSpy).toHaveBeenCalledWith(`[mindwtr-mcp] Bootstrapping SQLite database from fallback data.json: ${dataPath}`);
      expect(warnSpy).toHaveBeenCalledWith(`[mindwtr-mcp] Bootstrapped SQLite database at: ${dbPath}`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('never exposes the canonical database path while the bootstrap is still running', async () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'mindwtr.db');
    const dataPath = join(dir, 'data.json');
    writeFileSync(
      dataPath,
      JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} })
    );

    const core = await import('@mindwtr/core');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    let canonicalPathDuringSave: boolean | null = null;
    const saveSpy = spyOn(core.SqliteAdapter.prototype, 'saveData').mockImplementation(async () => {


      canonicalPathDuringSave = existsSync(dbPath);
      throw new Error('interrupted mid-bootstrap');
    });

    try {
      await expect(ensureMindwtrDbPath({ dbPath })).rejects.toThrow('interrupted mid-bootstrap');
      expect(canonicalPathDuringSave).toBe(false);
      expect(existsSync(dbPath)).toBe(false);
      expect(readdirSync(dir).filter((name) => name.includes('bootstrap'))).toEqual([]);
    } finally {
      saveSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('serializes concurrent bootstrap without corrupting the imported database', async () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'mindwtr.db');
    const dataPath = join(dir, 'data.json');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(
      dataPath,
      JSON.stringify({
        tasks: Array.from({ length: 250 }, (_, index) => ({
          id: `task-concurrent-${index}`,
          title: `Concurrent bootstrap task ${index}`,
          status: 'inbox',
          createdAt: '2026-09-22T00:00:00.000Z',
          updatedAt: '2026-09-22T00:00:00.000Z',
        })),
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      })
    );

    try {
      const gatePath = join(dir, 'start');
      const workerCode = `
        import { existsSync, writeFileSync } from 'fs';
        import { ensureMindwtrDbPath } from './db.ts';
        writeFileSync(process.env.TEST_READY_PATH, 'ready');
        while (!existsSync(process.env.TEST_GATE_PATH)) await new Promise((resolve) => setTimeout(resolve, 1));
        await ensureMindwtrDbPath({ dbPath: process.env.TEST_DB_PATH });
      `;
      const workers = [0, 1].map((index) => spawn(process.execPath, ['-e', workerCode], {
        cwd: dirname(fileURLToPath(import.meta.url)),
        env: {
          ...process.env,
          TEST_DB_PATH: dbPath,
          TEST_GATE_PATH: gatePath,
          TEST_READY_PATH: join(dir, `ready-${index}`),
        },
        stdio: 'ignore',
      }));
      const exits = workers.map((worker) => new Promise<number | null>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', resolve);
      }));
      const readyDeadline = Date.now() + 5_000;
      while (!workers.every((_, index) => existsSync(join(dir, `ready-${index}`)))) {
        if (Date.now() > readyDeadline) {
          workers.forEach((worker) => worker.kill());
          throw new Error('Timed out waiting for bootstrap workers');
        }
        await waitFor(5);
      }
      writeFileSync(gatePath, 'start');
      const exitCodes = await Promise.all(exits);
      expect(exitCodes).toEqual([0, 0]);

      for (let index = 0; index < workers.length; index += 1) {
        const { db } = await openMindwtrDb({ dbPath, readonly: true });
        try {
          expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
          expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 250 });
        } finally {
          closeDb(db);
        }
      }
      expect(readdirSync(dir).filter((name) => name.includes('bootstrap'))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('keeps a canonical database created while bootstrap is in progress', async () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'mindwtr.db');
    const dataPath = join(dir, 'data.json');
    const core = await import('@mindwtr/core');
    const originalSaveData = core.SqliteAdapter.prototype.saveData;
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveSpy = spyOn(core.SqliteAdapter.prototype, 'saveData').mockImplementation(async function(
      this: unknown,
      ...args: unknown[]
    ) {
      await originalSaveData.call(
        this as InstanceType<typeof core.SqliteAdapter>,
        args[0] as Parameters<typeof originalSaveData>[0],
      );
      const winner = new Database(dbPath);
      winner.exec("CREATE TABLE winner (value TEXT NOT NULL); INSERT INTO winner VALUES ('app');");
      winner.close();
    });
    writeFileSync(
      dataPath,
      JSON.stringify({
        tasks: [
          {
            id: 'task-bootstrap',
            title: 'Must not replace the winner',
            status: 'inbox',
            createdAt: '2026-09-22T00:00:00.000Z',
            updatedAt: '2026-09-22T00:00:00.000Z',
          },
        ],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      })
    );

    try {
      expect(await ensureMindwtrDbPath({ dbPath })).toBe(dbPath);
      const persisted = new Database(dbPath, { readonly: true });
      try {
        expect(persisted.prepare('SELECT value FROM winner').get()).toEqual({ value: 'app' });
        expect(persisted.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      } finally {
        persisted.close();
      }
      expect(readdirSync(dir).filter((name) => name.includes('bootstrap'))).toEqual([]);
    } finally {
      saveSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('bootstraps beside the data.json it is built from, not in the data/ candidate', async () => {
    const appData = createTempDir();
    const profile = join(appData, 'mindwtr');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'data.json'),
      JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} })
    );
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      setPlatform('win32');
      process.env.APPDATA = appData;
      delete process.env.MINDWTR_DB_PATH;
      delete process.env.MINDWTR_DB;

      expect(await ensureMindwtrDbPath()).toBe(join(profile, 'mindwtr.db'));
      expect(existsSync(join(profile, 'data', 'mindwtr.db'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('follows a pinned flat --db path into the installed data/ layout', async () => {
    const root = createTempDir();
    const pinnedPath = join(root, 'mindwtr.db');
    const movedPath = join(root, 'data', 'mindwtr.db');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(movedPath, '');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(await ensureMindwtrDbPath({ dbPath: pinnedPath })).toBe(movedPath);
      expect(warnSpy).toHaveBeenCalledWith(
        `[mindwtr-mcp] Using the Mindwtr database at: ${movedPath} (nothing at the configured path: ${pinnedPath})`
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('follows a pinned data/ --db path back to a flat profile an older version still uses', async () => {
    const root = createTempDir();
    const pinnedPath = join(root, 'data', 'mindwtr.db');
    const flatPath = join(root, 'mindwtr.db');
    writeFileSync(flatPath, '');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(await ensureMindwtrDbPath({ dbPath: pinnedPath })).toBe(flatPath);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('keeps the original error when no db or fallback data exists', async () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'mindwtr.db');

    await expect(ensureMindwtrDbPath({ dbPath })).rejects.toThrow(
      `Mindwtr database not found at: ${dbPath}`
    );
  });
});
