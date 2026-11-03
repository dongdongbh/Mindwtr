import { randomUUID } from 'crypto';
import { existsSync, linkSync, mkdirSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, dirname, join } from 'path';

import type { AppData, SqliteClient } from '@mindwtr/core';

import { withMcpWriteLock } from './db-write-lock.js';
import { resolveMindwtrDataJsonPath, resolveMindwtrDbPath } from './paths.js';

export type DbOptions = {
  dbPath?: string;
  readonly?: boolean;
};

export type DbClient = {
  prepare: (sql: string) => {
    all: <T = Record<string, unknown>>(...args: unknown[]) => T[];
    get: <T = Record<string, unknown>>(...args: unknown[]) => T | undefined;
    run: (...args: unknown[]) => { changes?: number };
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

const isBun = () => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isAlreadyExistsError = (error: unknown): boolean =>
  isRecord(error) && error.code === 'EEXIST';

type BootstrapOutcome = 'created' | 'existing';

const logBootstrapDiagnostic = (outcome: BootstrapOutcome): void => {
  process.stderr.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    scope: 'mcp',
    message: 'MCP SQLite fallback bootstrap resolved',
    context: { releaseCheck: 'v1.3.2/mcp-bootstrap-serialized', outcome },
  })}\n`);
};

const normalizeBootstrapData = (core: CoreModule, raw: unknown): AppData => {
  const record = isRecord(raw) ? raw : {};
  return core.normalizeAppData({
    tasks: Array.isArray(record.tasks) ? (record.tasks as AppData['tasks']) : [],
    projects: Array.isArray(record.projects) ? (record.projects as AppData['projects']) : [],
    sections: Array.isArray(record.sections) ? (record.sections as AppData['sections']) : [],
    areas: Array.isArray(record.areas) ? (record.areas as AppData['areas']) : [],
    people: Array.isArray(record.people) ? (record.people as AppData['people']) : [],
    settings: isRecord(record.settings) ? (record.settings as AppData['settings']) : {},
  });
};

const loadNodeSqlite = async () => {
  try {
    return await import('better-sqlite3');
  } catch {
    throw new Error('Node SQLite mode requires the optional better-sqlite3 addon. Install mindwtr-mcp with optional dependencies and enable the better-sqlite3 install script, use Bun, or select --api-url with MINDWTR_MCP_API_TOKEN for addon-free Local API access.');
  }
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

  const mod = await loadNodeSqlite();
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

async function bootstrapMindwtrDbFromJson(dbPath: string, dataJsonPath: string): Promise<BootstrapOutcome> {
  const raw = await readFile(dataJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const core = (await import('@mindwtr/core')) as CoreModule;
  const data = normalizeBootstrapData(core, parsed);

  mkdirSync(dirname(dbPath), { recursive: true });


  const tempPath = `${dbPath}.bootstrap-${randomUUID()}.tmp`;
  const removeTemp = () => {
    rmSync(tempPath, { force: true });
    rmSync(`${tempPath}-shm`, { force: true });
    rmSync(`${tempPath}-wal`, { force: true });
  };
  const { client, close } = await createBootstrapSqliteClient(tempPath);
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    close();
  };
  try {
    const adapter = new core.SqliteAdapter(client);
    await adapter.ensureSchema();
    await adapter.saveData(data);


    await client.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    closeOnce();
    try {
      linkSync(tempPath, dbPath);
      return 'created';
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      return 'existing';
    }
  } finally {
    closeOnce();
    removeTemp();
  }
}


function findSiblingLayoutDbPath(dbPath: string): string | null {
  const dir = dirname(dbPath);
  const sibling = basename(dir) === 'data'
    ? join(dirname(dir), basename(dbPath))
    : join(dir, 'data', basename(dbPath));
  return existsSync(sibling) ? sibling : null;
}

export async function ensureMindwtrDbPath(options: DbOptions = {}): Promise<string> {
  const path = resolveMindwtrDbPath(options.dbPath);
  if (existsSync(path)) return path;

  const siblingPath = findSiblingLayoutDbPath(path);
  if (siblingPath) {

    console.warn(
      `[mindwtr-mcp] Using the Mindwtr database at: ${siblingPath} (nothing at the configured path: ${path})`
    );
    return siblingPath;
  }

  const dataJsonPath = resolveMindwtrDataJsonPath(options.dbPath);
  if (existsSync(dataJsonPath)) {


    const bootstrapPath = join(dirname(dataJsonPath), basename(path));
    try {
      const outcome = await withMcpWriteLock(bootstrapPath, async () => {
        if (existsSync(bootstrapPath)) return 'existing';
        console.warn(`[mindwtr-mcp] Bootstrapping SQLite database from fallback data.json: ${dataJsonPath}`);
        return bootstrapMindwtrDbFromJson(bootstrapPath, dataJsonPath);
      });
      if (existsSync(bootstrapPath)) {
        if (outcome === 'created') {
          console.warn(`[mindwtr-mcp] Bootstrapped SQLite database at: ${bootstrapPath}`);
        }
        logBootstrapDiagnostic(outcome);
        return bootstrapPath;
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

    db = options.readonly
      ? new mod.Database(path, { readonly: true })
      : new mod.Database(path);
  } else {
    const mod = await loadNodeSqlite();
    const Database = mod.default;
    db = new Database(path, {
      readonly: options.readonly ?? false,
      fileMustExist: true,
    });
  }


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
