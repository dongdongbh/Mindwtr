import { existsSync, mkdirSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname } from 'path';

import type { AppData, SqliteClient } from '@mindwtr/core';

import { resolveMindwtrDataJsonPath, resolveMindwtrDbPath } from './paths.js';

export type DbOptions = {
  dbPath?: string;
  readonly?: boolean;
};

export type DbClient = {
  prepare: (sql: string) => {
    all: (...args: any[]) => any[];
    get: (...args: any[]) => any;
    run: (...args: any[]) => { changes?: number };
  };
  pragma?: (sql: string) => void;
  close: () => void;
};

type CoreModule = {
  SqliteAdapter: new (client: SqliteClient) => {
    ensureSchema: () => Promise<void>;
    saveData: (data: AppData) => Promise<void>;
  };
  normalizeAppData: (data: AppData) => AppData;
};

const isBun = () => typeof (globalThis as any).Bun !== 'undefined';
const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeBootstrapData = (core: CoreModule, raw: unknown): AppData => {
  const record = isRecord(raw) ? raw : {};
  return core.normalizeAppData({
    tasks: Array.isArray(record.tasks) ? (record.tasks as AppData['tasks']) : [],
    projects: Array.isArray(record.projects) ? (record.projects as AppData['projects']) : [],
    sections: Array.isArray(record.sections) ? (record.sections as AppData['sections']) : [],
    areas: Array.isArray(record.areas) ? (record.areas as AppData['areas']) : [],
    settings: isRecord(record.settings) ? (record.settings as AppData['settings']) : {},
  });
};

const createBootstrapSqliteClient = async (dbPath: string) => {
  if (isBun()) {
    const mod = await import('bun:sqlite');
    const db = new mod.Database(dbPath);
    const run = async (sql: string, params: unknown[] = []) => {
      db.prepare(sql).run(params);
    };
    const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(params) as T[];
    const get = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(params) as T | undefined;
    const exec = async (sql: string) => {
      db.exec(sql);
    };
    await exec('PRAGMA journal_mode = WAL;');
    await exec('PRAGMA foreign_keys = ON;');
    await exec('PRAGMA busy_timeout = 5000;');
    return {
      client: { run, all, get, exec } satisfies SqliteClient,
      close: () => db.close(),
    };
  }

  const mod = await import('better-sqlite3');
  const Database = mod.default;
  const db = new Database(dbPath);
  const run = async (sql: string, params: unknown[] = []) => {
    db.prepare(sql).run(params);
  };
  const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    db.prepare(sql).all(params) as T[];
  const get = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    db.prepare(sql).get(params) as T | undefined;
  const exec = async (sql: string) => {
    db.exec(sql);
  };
  await exec('PRAGMA journal_mode = WAL;');
  await exec('PRAGMA foreign_keys = ON;');
  await exec('PRAGMA busy_timeout = 5000;');
  return {
    client: { run, all, get, exec } satisfies SqliteClient,
    close: () => db.close(),
  };
};

async function bootstrapMindwtrDbFromJson(dbPath: string, dataJsonPath: string): Promise<void> {
  const raw = await readFile(dataJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const core = (await import('@mindwtr/core')) as CoreModule;
  const data = normalizeBootstrapData(core, parsed);

  mkdirSync(dirname(dbPath), { recursive: true });
  const createdDb = !existsSync(dbPath);
  const { client, close } = await createBootstrapSqliteClient(dbPath);
  try {
    const adapter = new core.SqliteAdapter(client);
    await adapter.ensureSchema();
    await adapter.saveData(data);
  } catch (error) {
    if (createdDb) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    throw error;
  } finally {
    close();
  }
}

export async function ensureMindwtrDbPath(options: DbOptions = {}): Promise<string> {
  const path = resolveMindwtrDbPath(options.dbPath);
  if (existsSync(path)) return path;

  const dataJsonPath = resolveMindwtrDataJsonPath(options.dbPath);
  if (existsSync(dataJsonPath)) {
    try {
      console.warn(`[mindwtr-mcp] Bootstrapping SQLite database from fallback data.json: ${dataJsonPath}`);
      await bootstrapMindwtrDbFromJson(path, dataJsonPath);
      if (existsSync(path)) {
        console.warn(`[mindwtr-mcp] Bootstrapped SQLite database at: ${path}`);
        return path;
      }
    } catch (error) {
      throw new Error(
        `Mindwtr database not found at: ${path}\n` +
        `Found fallback data at: ${dataJsonPath}\n` +
        `Failed to bootstrap SQLite from data.json: ${getErrorMessage(error)}`
      );
    }
  }

  throw new Error(
    `Mindwtr database not found at: ${path}\n` +
    `Please ensure the Mindwtr app has been run at least once to create the database, ` +
    `or specify a custom path using --db /path/to/mindwtr.db or MINDWTR_DB_PATH environment variable.`
  );
}

export async function openMindwtrDb(options: DbOptions = {}) {
  const path = await ensureMindwtrDbPath(options);

  let db: DbClient;
  if (isBun()) {
    const mod = await import('bun:sqlite');
    // bun:sqlite doesn't accept { readonly: false }, only omit or { readonly: true }
    db = options.readonly
      ? new mod.Database(path, { readonly: true })
      : new mod.Database(path);
  } else {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    db = new Database(path, {
      readonly: options.readonly ?? false,
      fileMustExist: true,
    });
  }

  // Configure pragmas - use pragma method if available, otherwise fall back to exec
  const runPragma = (sql: string) => {
    if (db.pragma) {
      db.pragma(sql);
    } else {
      db.prepare(`PRAGMA ${sql}`).run();
    }
  };
  runPragma('journal_mode = WAL');
  runPragma('foreign_keys = ON');
  runPragma('busy_timeout = 5000');

  return { db, path };
}

export function closeDb(db: DbClient) {
  try {
    db.close();
  } catch {
    // ignore close errors
  }
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
