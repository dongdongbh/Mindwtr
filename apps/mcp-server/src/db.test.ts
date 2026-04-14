import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeDb, ensureMindwtrDbPath, openMindwtrDb } from './db.js';

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-db-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
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
      } finally {
        closeDb(db);
      }
      expect(warnSpy).toHaveBeenCalledWith(`[mindwtr-mcp] Bootstrapping SQLite database from fallback data.json: ${dataPath}`);
      expect(warnSpy).toHaveBeenCalledWith(`[mindwtr-mcp] Bootstrapped SQLite database at: ${dbPath}`);
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
