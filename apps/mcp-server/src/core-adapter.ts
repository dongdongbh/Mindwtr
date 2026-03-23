import { existsSync } from 'fs';

import type { Area, Project, Task } from './queries.js';
import type { DbOptions } from './db.js';
import { resolveMindwtrDbPath } from './paths.js';

type CoreStore = {
  getState: () => {
    _allTasks: Task[];
    _allProjects: Project[];
    _allAreas: Area[];
    fetchData: () => Promise<void>;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<void>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
    deleteTask: (id: string) => Promise<void>;
    restoreTask: (id: string) => Promise<void>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
    deleteProject: (id: string) => Promise<void>;
    addArea: (name: string, initialProps?: Partial<Area>) => Promise<Area | null>;
    updateArea: (id: string, updates: Partial<Area>) => Promise<void>;
    deleteArea: (id: string) => Promise<void>;
  };
};

type CoreModule = {
  setStorageAdapter: (adapter: unknown) => void;
  flushPendingSave: () => Promise<void>;
  useTaskStore: CoreStore;
  SqliteAdapter: new (client: unknown) => { ensureSchema: () => Promise<void> };
};

type CoreService = {
  addTask: (input: { title: string; props?: Partial<Task> }) => Promise<Task>;
  updateTask: (input: { id: string; updates: Partial<Task> }) => Promise<Task>;
  completeTask: (id: string) => Promise<Task>;
  deleteTask: (id: string) => Promise<Task>;
  restoreTask: (id: string) => Promise<Task>;
  addProject: (input: { title: string; color: string; props?: Partial<Project> }) => Promise<Project>;
  updateProject: (input: { id: string; updates: Partial<Project> }) => Promise<Project>;
  deleteProject: (id: string) => Promise<Project>;
  addArea: (input: { name: string; props?: Partial<Area> }) => Promise<Area>;
  updateArea: (input: { id: string; updates: Partial<Area> }) => Promise<Area>;
  deleteArea: (id: string) => Promise<Area>;
};

let coreService: CoreService | null = null;
let coreDbPath: string | undefined;
let coreReadonly = false;
let coreReady: Promise<void> | null = null;
let coreQueue: Promise<void> = Promise.resolve();

const isBun = () => typeof (globalThis as any).Bun !== 'undefined';

const createSqliteClient = async (dbPath: string, readonly: boolean) => {
  if (isBun()) {
    const mod = await import('bun:sqlite');
    const db = readonly ? new mod.Database(dbPath, { readonly: true }) : new mod.Database(dbPath);
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
    return { client: { run, all, get, exec }, close: () => db.close() };
  }

  const mod = await import('better-sqlite3');
  const Database = mod.default;
  const db = new Database(dbPath, { readonly, fileMustExist: true });
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
  return { client: { run, all, get, exec }, close: () => db.close() };
};

const loadCoreModules = async (): Promise<CoreModule> => {
  const core = await import('@mindwtr/core');
  return core as CoreModule;
};

const runSerialized = async <T>(fn: () => Promise<T>): Promise<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  coreQueue = coreQueue
    .then(async () => {
      try {
        resolve(await fn());
      } catch (error) {
        reject(error);
      }
    })
    .catch(() => {
      // swallow to keep queue alive
    });
  return result;
};

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isDuplicateColumnError = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('duplicate column name');
};

const ensureCoreReady = async (options: DbOptions) => {
  const resolvedPath = resolveMindwtrDbPath(options.dbPath);
  if (coreReady && coreDbPath === resolvedPath && coreReadonly === Boolean(options.readonly)) {
    return coreReady;
  }

  coreDbPath = resolvedPath;
  coreReadonly = Boolean(options.readonly);
  if (!existsSync(coreDbPath)) {
    throw new Error(
      `Mindwtr database not found at: ${coreDbPath}\n` +
      `Please ensure the Mindwtr app has been run at least once to create the database, ` +
      `or specify a custom path using --db /path/to/mindwtr.db or MINDWTR_DB_PATH environment variable.`
    );
  }
  coreReady = (async () => {
    const core = await loadCoreModules();
    const { client } = await createSqliteClient(coreDbPath!, coreReadonly);
    const ensureOrderNumColumn = async (tableName: 'tasks' | 'projects') => {
      let columns: Array<{ name?: string }> = [];
      try {
        columns = await client.all<{ name?: string }>(`PRAGMA table_info(${tableName})`);
      } catch (error) {
        throw new Error(`Failed to inspect ${tableName} schema during MCP preflight: ${getErrorMessage(error)}`);
      }
      const hasOrderNum = columns.some((col) => col.name === 'orderNum');
      if (hasOrderNum || coreReadonly) return;
      try {
        await client.run(`ALTER TABLE ${tableName} ADD COLUMN orderNum INTEGER`);
      } catch (error) {
        if (isDuplicateColumnError(error)) return;
        throw new Error(`Failed to add ${tableName}.orderNum during MCP preflight: ${getErrorMessage(error)}`);
      }
    };
    // Preflight for older DBs missing orderNum column.
    await ensureOrderNumColumn('tasks');
    await ensureOrderNumColumn('projects');
    const sqliteAdapter = new core.SqliteAdapter(client);
    await sqliteAdapter.ensureSchema();
    core.setStorageAdapter(sqliteAdapter);
    await core.useTaskStore.getState().fetchData();

    coreService = {
      addTask: async ({ title, props }) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        const before = new Set(state._allTasks.map((t) => t.id));
        await state.addTask(title, props);
        await core.flushPendingSave();
        const after = core.useTaskStore.getState()._allTasks;
        const created = after.find((t) => !before.has(t.id));
        if (!created) throw new Error('Failed to locate newly created task.');
        return created as Task;
      },
      updateTask: async ({ id, updates }) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.updateTask(id, updates);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allTasks.find((t) => t.id === id);
        if (!updated) throw new Error(`Task not found after update: ${id}`);
        return updated as Task;
      },
      completeTask: async (id) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.updateTask(id, { status: 'done' } as Partial<Task>);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allTasks.find((t) => t.id === id);
        if (!updated) throw new Error(`Task not found after complete: ${id}`);
        return updated as Task;
      },
      deleteTask: async (id) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.deleteTask(id);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allTasks.find((t) => t.id === id);
        if (!updated) throw new Error(`Task not found after delete: ${id}`);
        return updated as Task;
      },
      restoreTask: async (id) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.restoreTask(id);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allTasks.find((t) => t.id === id);
        if (!updated) throw new Error(`Task not found after restore: ${id}`);
        return updated as Task;
      },
      addProject: async ({ title, color, props }) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        const created = await state.addProject(title, color, props);
        if (!created) throw new Error('Failed to create project.');
        await core.flushPendingSave();
        const saved = core.useTaskStore.getState()._allProjects.find((project) => project.id === created.id);
        if (!saved) throw new Error(`Project not found after create: ${created.id}`);
        return saved as Project;
      },
      updateProject: async ({ id, updates }) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.updateProject(id, updates);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allProjects.find((project) => project.id === id);
        if (!updated) throw new Error(`Project not found after update: ${id}`);
        return updated as Project;
      },
      deleteProject: async (id) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.deleteProject(id);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allProjects.find((project) => project.id === id);
        if (!updated) throw new Error(`Project not found after delete: ${id}`);
        return updated as Project;
      },
      addArea: async ({ name, props }) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        const created = await state.addArea(name, props);
        if (!created) throw new Error('Failed to create area.');
        await core.flushPendingSave();
        const saved = core.useTaskStore.getState()._allAreas.find((area) => area.id === created.id);
        if (!saved) throw new Error(`Area not found after create: ${created.id}`);
        return saved as Area;
      },
      updateArea: async ({ id, updates }) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.updateArea(id, updates);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allAreas.find((area) => area.id === id);
        if (!updated) throw new Error(`Area not found after update: ${id}`);
        return updated as Area;
      },
      deleteArea: async (id) => {
        const state = core.useTaskStore.getState();
        await state.fetchData();
        await state.deleteArea(id);
        await core.flushPendingSave();
        const updated = core.useTaskStore.getState()._allAreas.find((area) => area.id === id);
        if (!updated) throw new Error(`Area not found after delete: ${id}`);
        return updated as Area;
      },
    };
  })();

  return coreReady;
};

export const getCoreService = async (options: DbOptions): Promise<CoreService> => {
  await ensureCoreReady(options);
  if (!coreService) {
    throw new Error('Core service failed to initialize.');
  }
  return coreService;
};

export const runCoreService = async <T>(options: DbOptions, fn: (service: CoreService) => Promise<T>): Promise<T> => {
  const service = await getCoreService(options);
  return runSerialized(() => fn(service));
};
