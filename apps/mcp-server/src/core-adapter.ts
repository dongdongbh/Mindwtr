import type { Area, Person, Project, Section, Task } from './queries.js';
import { ensureMindwtrDbPath, type DbOptions } from './db.js';
import { withMcpWriteLock } from './db-write-lock.js';
import { NotFoundError, ValidationError } from './errors.js';

type CoreStore = {
  getState: () => {
    _allTasks: Task[];
    _allProjects: Project[];
    _allSections: Section[];
    _allAreas: Area[];
    _allPeople: Person[];
    fetchData: () => Promise<void>;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<CoreActionResult>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<CoreActionResult>;
    deleteTask: (id: string) => Promise<CoreActionResult>;
    restoreTask: (id: string) => Promise<CoreActionResult>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    updateProject: (id: string, updates: Partial<Project>) => Promise<CoreActionResult>;
    deleteProject: (id: string) => Promise<CoreActionResult>;
    addSection: (projectId: string, title: string, initialProps?: Partial<Section>) => Promise<Section | null>;
    updateSection: (id: string, updates: Partial<Section>) => Promise<CoreActionResult>;
    deleteSection: (id: string) => Promise<CoreActionResult>;
    addArea: (name: string, initialProps?: Partial<Area>) => Promise<Area | null>;
    updateArea: (id: string, updates: Partial<Area>) => Promise<CoreActionResult>;
    deleteArea: (id: string) => Promise<CoreActionResult>;
    addPerson: (name: string, initialProps?: Partial<Person>) => Promise<Person | null>;
    updatePerson: (id: string, updates: Partial<Person>) => Promise<CoreActionResult>;
    renamePerson: (id: string, name: string, options?: { updateTasks?: boolean }) => Promise<CoreActionResult>;
    deletePerson: (id: string) => Promise<CoreActionResult>;
  };
};

type CoreActionResult = {
  success: boolean;
  error?: string;
};

type CoreModule = {
  setStorageAdapter: (adapter: unknown) => void;
  flushPendingSave: () => Promise<void>;
  runWithImmediateSaveTracking: <T>(operation: () => Promise<T>) => Promise<{ result: T; saveCount: number }>;
  createSerializedAsyncQueue: () => SerializedAsyncQueue;
  useTaskStore: CoreStore;
  SqliteAdapter: new (
    client: unknown,
    options?: { rejectConcurrentWrites?: boolean },
  ) => { ensureSchema: () => Promise<void> };
};

type SerializedAsyncQueue = {
  run: <T>(fn: () => Promise<T> | T) => Promise<T>;
};

type TaskWriteResult = Task & { storageWarning?: string };

type CoreService = {
  addTask: (input: { title: string; props?: Partial<Task> }) => Promise<TaskWriteResult>;
  updateTask: (input: { id: string; updates: Partial<Task> }) => Promise<TaskWriteResult>;
  completeTask: (id: string) => Promise<TaskWriteResult>;
  deleteTask: (id: string) => Promise<TaskWriteResult>;
  restoreTask: (id: string) => Promise<TaskWriteResult>;
  addProject: (input: { title: string; color: string; props?: Partial<Project> }) => Promise<Project>;
  updateProject: (input: { id: string; updates: Partial<Project> }) => Promise<Project>;
  deleteProject: (id: string) => Promise<Project>;
  addSection: (input: { projectId: string; title: string; props?: Partial<Section> }) => Promise<Section>;
  updateSection: (input: { id: string; updates: Partial<Section> }) => Promise<Section>;
  deleteSection: (id: string) => Promise<Section>;
  addArea: (input: { name: string; props?: Partial<Area> }) => Promise<Area>;
  updateArea: (input: { id: string; updates: Partial<Area> }) => Promise<Area>;
  deleteArea: (id: string) => Promise<Area>;
  addPerson: (input: { name: string; props?: Partial<Person> }) => Promise<Person>;
  updatePerson: (input: { id: string; updates: Partial<Person> }) => Promise<Person>;
  renamePerson: (input: { id: string; name: string; updateTasks?: boolean }) => Promise<Person>;
  deletePerson: (id: string) => Promise<Person>;
};

let coreService: CoreService | null = null;
let coreDbPath: string | undefined;
let coreReadonly = false;
let coreReady: Promise<void> | null = null;
let coreQueue: SerializedAsyncQueue | null = null;
// The write client's close, kept at module scope (unlike the ensureCoreReady-local
// `closeClient`, which is only for closing on an init failure) so closeCoreAdapter can
// actually close it later - this client otherwise stays open for the process's whole
// lifetime with no close path at all (BUG-15).
let coreClientClose: (() => void) | null = null;

const CORE_SQLITE_BUSY_TIMEOUT_MS = 5000;

const isBun = () => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

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
    await exec(`PRAGMA busy_timeout = ${CORE_SQLITE_BUSY_TIMEOUT_MS};`);
    await exec('PRAGMA journal_mode = WAL;');
    await exec('PRAGMA foreign_keys = ON;');
    return { client: { run, all, get, exec }, close: () => db.close() };
  }

  const mod = await import('better-sqlite3');
  const Database = mod.default;
  const db = new Database(dbPath, {
    readonly,
    fileMustExist: true,
  });
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
  await exec(`PRAGMA busy_timeout = ${CORE_SQLITE_BUSY_TIMEOUT_MS};`);
  await exec('PRAGMA journal_mode = WAL;');
  await exec('PRAGMA foreign_keys = ON;');
  return { client: { run, all, get, exec }, close: () => db.close() };
};

const loadCoreModules = async (): Promise<CoreModule> => {
  const core = await import('@mindwtr/core');
  return core as CoreModule;
};

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
// The exact, closed set of messages packages/core's update/delete/rename store actions
// (store-tasks.ts:524, store-projects/*'s mutateEntities/update*/delete* helpers) emit ONLY
// when the id being acted on doesn't exist — a genuine lookup miss. Update actions can also
// fail for OTHER reasons on an id that DOES exist (store-tasks.ts's updateTask: a focus-cap
// hit -> "Maximum of N focused tasks allowed", or preparedUpdates.error for a bad patch) —
// those are user-input mistakes, not not-found, and must not match this set.
//
// The identical strings ('Area not found' etc.) are ALSO produced by task-container-rules.ts
// when addTask references a nonexistent projectId/sectionId/areaId at CREATE time — that's a
// bad-input problem too (nothing exists yet to "not find"), which is why ensureActionSucceeded
// below never checks this set for the 'create task' action regardless of message text.
const LOOKUP_MISS_MESSAGES = new Set([
  'Task not found', 'Project not found', 'Section not found', 'Area not found', 'Person not found',
]);

// isLookupContext defaults to true because every non-writeTask caller below acts on an id that
// must already exist (update/delete/rename — never add*, which uses throwCreateFailed
// instead). writeTask passes false for its 'create task' action explicitly (see below).
const ensureActionSucceeded = (action: string, result: CoreActionResult, isLookupContext = true) => {
  if (result.success) return;
  const message = result.error || `Failed to ${action}.`;
  if (isLookupContext && LOOKUP_MISS_MESSAGES.has(message)) {
    throw new NotFoundError(message);
  }
  throw new ValidationError(message);
};
// add* actions return null/undefined for a validation failure (empty title/name, or a
// reference to a missing parent id) — a user mistake, not a "not found" lookup failure.
// A `function` declaration, not a `const` arrow: only the former's `never` return type is
// recognized by TS's control-flow analysis for narrowing the caller's `if (!created)` check.
function throwCreateFailed(message: string): never {
  throw new ValidationError(message);
}

const isSqliteCorruptError = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : '';
  const message = getErrorMessage(error).toLowerCase();
  return code === 'SQLITE_CORRUPT' || message.includes('database disk image is malformed');
};

const toStorageError = (error: unknown): Error => {
  if (isSqliteCorruptError(error)) {
    return new Error(
      `The database file appears damaged (${getErrorMessage(error)}). Run PRAGMA integrity_check to assess it.`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new Error(getErrorMessage(error));
};

const getTaskStorageWarning = (error: unknown): string => {
  const failure = isSqliteCorruptError(error)
    ? `the database file appears damaged (${getErrorMessage(error)})`
    : getErrorMessage(error);
  const guidance = isSqliteCorruptError(error) ? ' Run PRAGMA integrity_check to assess it.' : '';
  return `The task change was saved, but a full-database save failed: ${failure}. `
    + `Other pending changes, such as settings, may not have persisted.${guidance}`;
};

const flushCoreSave = async (core: Pick<CoreModule, 'flushPendingSave'>): Promise<void> => {
  try {
    await core.flushPendingSave();
  } catch (error) {
    throw toStorageError(error);
  }
};

type PersistenceContractService = Pick<
  CoreService,
  'addTask' | 'updateTask' | 'completeTask' | 'deleteTask' | 'restoreTask' | 'updateProject'
>;

export type WriteTransactionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const runDirectly: WriteTransactionRunner = (operation) => operation();

export const createCorePersistenceService = (
  core: CoreModule,
  runWriteTransaction: WriteTransactionRunner = runDirectly,
): PersistenceContractService => {
  const writeTask = async (
    action: string,
    mutate: (state: ReturnType<CoreStore['getState']>) => Promise<CoreActionResult>,
    findTask: () => Task | undefined,
    notFoundMessage: string,
  ): Promise<TaskWriteResult> => {
    return runWriteTransaction(async () => {
      const initialState = core.useTaskStore.getState();
      try {
        await initialState.fetchData();
      } catch (error) {
        throw toStorageError(error);
      }

      let tracked: { result: CoreActionResult; saveCount: number };
      try {
        const state = core.useTaskStore.getState();
        tracked = await core.runWithImmediateSaveTracking(() => mutate(state));
      } catch (error) {
        throw toStorageError(error);
      }
      ensureActionSucceeded(action, tracked.result, action !== 'create task');

      const task = findTask();
      if (!task) throw new NotFoundError(notFoundMessage);
      try {
        await core.flushPendingSave();
        return task;
      } catch (error) {
        if (tracked.saveCount === 0) throw toStorageError(error);
        return { ...task, storageWarning: getTaskStorageWarning(error) };
      }
    });
  };

  return {
    addTask: async ({ title, props }) => {
      let before = new Set<string>();
      return writeTask(
        'create task',
        async (state) => {
          before = new Set(state._allTasks.map((task) => task.id));
          return state.addTask(title, props);
        },
        () => core.useTaskStore.getState()._allTasks.find((task) => !before.has(task.id)),
        'Failed to locate newly created task.',
      );
    },
    updateTask: async ({ id, updates }) => writeTask(
      'update task',
      (state) => state.updateTask(id, updates),
      () => core.useTaskStore.getState()._allTasks.find((task) => task.id === id),
      `Task not found after update: ${id}`,
    ),
    completeTask: async (id) => writeTask(
      'complete task',
      (state) => state.updateTask(id, { status: 'done' } as Partial<Task>),
      () => core.useTaskStore.getState()._allTasks.find((task) => task.id === id),
      `Task not found after complete: ${id}`,
    ),
    deleteTask: async (id) => writeTask(
      'delete task',
      (state) => state.deleteTask(id),
      () => core.useTaskStore.getState()._allTasks.find((task) => task.id === id),
      `Task not found after delete: ${id}`,
    ),
    restoreTask: async (id) => writeTask(
      'restore task',
      (state) => state.restoreTask(id),
      () => core.useTaskStore.getState()._allTasks.find((task) => task.id === id),
      `Task not found after restore: ${id}`,
    ),
    updateProject: async ({ id, updates }) => runWriteTransaction(async () => {
      const state = core.useTaskStore.getState();
      await state.fetchData();
      ensureActionSucceeded('update project', await state.updateProject(id, updates));
      await flushCoreSave(core);
      const updated = core.useTaskStore.getState()._allProjects.find((project) => project.id === id);
      if (!updated) throw new NotFoundError(`Project not found after update: ${id}`);
      return updated as Project;
    }),
  };
};

const isDuplicateColumnError = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('duplicate column name');
};

const ensureCoreReady = async (options: DbOptions) => {
  const resolvedPath = await ensureMindwtrDbPath(options);
  if (coreReady && coreDbPath === resolvedPath && coreReadonly === Boolean(options.readonly)) {
    return coreReady;
  }

  coreDbPath = resolvedPath;
  coreReadonly = Boolean(options.readonly);
  coreReady = (async () => {
    const core = await loadCoreModules();
    coreQueue ??= core.createSerializedAsyncQueue();
    let closeClient: (() => void) | null = null;
    try {
      const { client, close } = await createSqliteClient(coreDbPath!, coreReadonly);
      closeClient = close;
      coreClientClose = close;
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
      const sqliteAdapter = new core.SqliteAdapter(client, { rejectConcurrentWrites: !coreReadonly });
      await sqliteAdapter.ensureSchema();
      core.setStorageAdapter(sqliteAdapter);
      await core.useTaskStore.getState().fetchData();
      const runWriteTransaction: WriteTransactionRunner = coreReadonly
        ? runDirectly
        : (operation) => withMcpWriteLock(resolvedPath, operation);

      coreService = {
        ...createCorePersistenceService(core, runWriteTransaction),
        addProject: async ({ title, color, props }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          const created = await state.addProject(title, color, props);
          if (!created) throwCreateFailed('Failed to create project.');
          await flushCoreSave(core);
          const saved = core.useTaskStore.getState()._allProjects.find((project) => project.id === created.id);
          if (!saved) throw new NotFoundError(`Project not found after create: ${created.id}`);
          return saved as Project;
        }),
        deleteProject: async (id) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('delete project', await state.deleteProject(id));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allProjects.find((project) => project.id === id);
          if (!updated) throw new NotFoundError(`Project not found after delete: ${id}`);
          return updated as Project;
        }),
        addSection: async ({ projectId, title, props }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          const created = await state.addSection(projectId, title, props);
          if (!created) throwCreateFailed('Failed to create section.');
          await flushCoreSave(core);
          const saved = core.useTaskStore.getState()._allSections.find((section) => section.id === created.id);
          if (!saved) throw new NotFoundError(`Section not found after create: ${created.id}`);
          return saved as Section;
        }),
        updateSection: async ({ id, updates }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('update section', await state.updateSection(id, updates));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allSections.find((section) => section.id === id);
          if (!updated) throw new NotFoundError(`Section not found after update: ${id}`);
          return updated as Section;
        }),
        deleteSection: async (id) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('delete section', await state.deleteSection(id));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allSections.find((section) => section.id === id);
          if (!updated) throw new NotFoundError(`Section not found after delete: ${id}`);
          return updated as Section;
        }),
        addArea: async ({ name, props }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          const created = await state.addArea(name, props);
          if (!created) throwCreateFailed('Failed to create area.');
          await flushCoreSave(core);
          const saved = core.useTaskStore.getState()._allAreas.find((area) => area.id === created.id);
          if (!saved) throw new NotFoundError(`Area not found after create: ${created.id}`);
          return saved as Area;
        }),
        updateArea: async ({ id, updates }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('update area', await state.updateArea(id, updates));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allAreas.find((area) => area.id === id);
          if (!updated) throw new NotFoundError(`Area not found after update: ${id}`);
          return updated as Area;
        }),
        deleteArea: async (id) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('delete area', await state.deleteArea(id));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allAreas.find((area) => area.id === id);
          if (!updated) throw new NotFoundError(`Area not found after delete: ${id}`);
          return updated as Area;
        }),
        addPerson: async ({ name, props }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          const created = await state.addPerson(name, props);
          if (!created) throwCreateFailed('Failed to create person.');
          await flushCoreSave(core);
          const saved = core.useTaskStore.getState()._allPeople.find((person) => person.id === created.id);
          if (!saved) throw new NotFoundError(`Person not found after create: ${created.id}`);
          return saved as Person;
        }),
        updatePerson: async ({ id, updates }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('update person', await state.updatePerson(id, updates));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allPeople.find((person) => person.id === id);
          if (!updated) throw new NotFoundError(`Person not found after update: ${id}`);
          return updated as Person;
        }),
        renamePerson: async ({ id, name, updateTasks }) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('rename person', await state.renamePerson(id, name, { updateTasks }));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allPeople.find((person) => person.id === id);
          if (!updated) throw new NotFoundError(`Person not found after rename: ${id}`);
          return updated as Person;
        }),
        deletePerson: async (id) => runWriteTransaction(async () => {
          const state = core.useTaskStore.getState();
          await state.fetchData();
          ensureActionSucceeded('delete person', await state.deletePerson(id));
          await flushCoreSave(core);
          const updated = core.useTaskStore.getState()._allPeople.find((person) => person.id === id);
          if (!updated) throw new NotFoundError(`Person not found after delete: ${id}`);
          return updated as Person;
        }),
      };
      closeClient = null;
    } finally {
      closeClient?.();
    }
  })().catch((error) => {
    if (coreDbPath === resolvedPath && coreReadonly === Boolean(options.readonly)) {
      coreReady = null;
      coreService = null;
      coreClientClose = null;
    }
    throw error;
  });

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
  if (!coreQueue) {
    throw new Error('Core service queue failed to initialize.');
  }
  return coreQueue.run(() => fn(service));
};

/**
 * Closes the module-level write client (BUG-15: it otherwise never closes, so its WAL
 * checkpoint never runs and its -wal/-shm files linger - locked open on Windows). Waits for
 * any in-flight write to finish first so a shutdown can't close out from under one. Safe to
 * call when the adapter was never initialized (e.g. a cloud-backend process).
 */
export const closeCoreAdapter = async (): Promise<void> => {
  if (coreReady) {
    await coreReady.catch(() => undefined);
  }
  if (coreQueue) {
    await coreQueue.run(() => undefined).catch(() => undefined);
  }
  const close = coreClientClose;
  coreClientClose = null;
  coreReady = null;
  coreService = null;
  coreDbPath = undefined;
  coreQueue = null;
  close?.();
};
