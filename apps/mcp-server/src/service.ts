import {
  DEFAULT_PROJECT_COLOR,
  parseQuickAdd,
  normalizeTaskStatus,
  TASK_STATUS_SET,
  type Area as CoreArea,
  type Project as CoreProject,
} from '@mindwtr/core';

import { closeDb, openMindwtrDb, type DbOptions } from './db.js';
import {
  getTask,
  getProject,
  listAreas,
  listProjects,
  listTasks,
  type AddTaskInput,
  type Area,
  type GetTaskInput,
  type GetProjectInput,
  type ListTasksInput,
  type Project,
  type Task,
  type TaskRow,
  type UpdateTaskInput,
} from './queries.js';
import { runCoreService } from './core-adapter.js';

const filterUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
};

type ServiceDeps = {
  openMindwtrDb: typeof openMindwtrDb;
  closeDb: typeof closeDb;
  listTasks: typeof listTasks;
  listProjects: typeof listProjects;
  listAreas: typeof listAreas;
  getTask: typeof getTask;
  getProject: typeof getProject;
  parseQuickAdd: typeof parseQuickAdd;
  runCoreService: typeof runCoreService;
};

const defaultServiceDeps: ServiceDeps = {
  openMindwtrDb,
  closeDb,
  listTasks,
  listProjects,
  listAreas,
  getTask,
  getProject,
  parseQuickAdd,
  runCoreService,
};

const createDbAccessor = (options: DbOptions, deps: ServiceDeps) => {
  let dbHandlePromise: Promise<Awaited<ReturnType<typeof openMindwtrDb>>> | null = null;
  const getDbHandle = async () => {
    if (!dbHandlePromise) {
      dbHandlePromise = deps.openMindwtrDb(options);
    }
    return await dbHandlePromise;
  };
  const withDb = async <T>(
    fn: (db: Awaited<ReturnType<typeof openMindwtrDb>>['db']) => T | Promise<T>,
  ): Promise<T> => {
    const { db } = await getDbHandle();
    return await fn(db);
  };
  const close = async (): Promise<void> => {
    if (!dbHandlePromise) return;
    const handle = await dbHandlePromise.catch(() => null);
    dbHandlePromise = null;
    if (handle) {
      deps.closeDb(handle.db);
    }
  };
  return { withDb, close };
};

const parseInputStatus = (value: string | undefined): Task['status'] | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeTaskStatus(value);
  if (!TASK_STATUS_SET.has(normalized)) {
    throw new Error(`Invalid task status: ${value}`);
  }
  return normalized;
};

const MAX_TASK_TITLE_LENGTH = 500;
const MAX_AREA_NAME_LENGTH = 200;
const PROJECT_STATUS_SET = new Set<CoreProject['status']>(['active', 'someday', 'waiting', 'archived']);

const parseProjectStatus = (value: string | undefined): CoreProject['status'] | undefined => {
  if (value === undefined) return undefined;
  if (!PROJECT_STATUS_SET.has(value as CoreProject['status'])) {
    throw new Error(`Invalid project status: ${value}`);
  }
  return value as CoreProject['status'];
};

const validateAddTaskInput = (input: AddTaskInput): void => {
  const hasTitle = typeof input.title === 'string' && input.title.trim().length > 0;
  const hasQuickAdd = typeof input.quickAdd === 'string' && input.quickAdd.trim().length > 0;
  if (!hasTitle && !hasQuickAdd) {
    throw new Error('Either title or quickAdd is required');
  }
  if (hasTitle && hasQuickAdd) {
    throw new Error('Provide either title or quickAdd, not both');
  }
  if (hasTitle && input.title!.trim().length > MAX_TASK_TITLE_LENGTH) {
    throw new Error(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
};

const buildTaskUpdates = (input: UpdateTaskInput): Partial<Task> => {
  const updates: Partial<Task> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.status !== undefined) updates.status = parseInputStatus(input.status);
  if (input.projectId !== undefined) updates.projectId = input.projectId ?? undefined;
  if (input.dueDate !== undefined) updates.dueDate = input.dueDate ?? undefined;
  if (input.startTime !== undefined) updates.startTime = input.startTime ?? undefined;
  if (input.contexts !== undefined) updates.contexts = input.contexts ?? [];
  if (input.tags !== undefined) updates.tags = input.tags ?? [];
  if (input.description !== undefined) updates.description = input.description ?? undefined;
  if (input.priority !== undefined) updates.priority = input.priority ?? undefined;
  if (input.timeEstimate !== undefined) updates.timeEstimate = input.timeEstimate ?? undefined;
  if (input.reviewAt !== undefined) updates.reviewAt = input.reviewAt ?? undefined;
  if (input.isFocusedToday !== undefined) updates.isFocusedToday = input.isFocusedToday;
  return updates;
};

export type AddProjectInput = {
  title: string;
  color?: string;
  status?: CoreProject['status'];
  areaId?: string | null;
  isSequential?: boolean;
  isFocused?: boolean;
  reviewAt?: string | null;
  supportNotes?: string | null;
};

export type UpdateProjectInput = {
  id: string;
  title?: string;
  color?: string | null;
  status?: CoreProject['status'];
  areaId?: string | null;
  isSequential?: boolean;
  isFocused?: boolean;
  reviewAt?: string | null;
  supportNotes?: string | null;
};

export type AddAreaInput = {
  name: string;
  color?: string;
  icon?: string;
};

export type UpdateAreaInput = {
  id: string;
  name?: string;
  color?: string | null;
  icon?: string | null;
};

const validateProjectTitle = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error('Project title is required');
  }
  if (trimmed.length > MAX_TASK_TITLE_LENGTH) {
    throw new Error(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
  return trimmed;
};

const validateAreaName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Area name is required');
  }
  if (trimmed.length > MAX_AREA_NAME_LENGTH) {
    throw new Error(`Area name too long (max ${MAX_AREA_NAME_LENGTH} characters)`);
  }
  return trimmed;
};

export type MindwtrService = {
  listTasks: (input: ListTasksInput) => Promise<TaskRow[]>;
  listProjects: () => Promise<Project[]>;
  listAreas: () => Promise<Area[]>;
  getTask: (input: GetTaskInput) => Promise<TaskRow>;
  getProject: (input: GetProjectInput) => Promise<Project>;
  addTask: (input: AddTaskInput) => Promise<Task>;
  updateTask: (input: UpdateTaskInput) => Promise<Task>;
  completeTask: (id: string) => Promise<Task>;
  deleteTask: (id: string) => Promise<Task>;
  restoreTask: (id: string) => Promise<Task>;
  addProject: (input: AddProjectInput) => Promise<Project>;
  updateProject: (input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<Project>;
  addArea: (input: AddAreaInput) => Promise<Area>;
  updateArea: (input: UpdateAreaInput) => Promise<Area>;
  deleteArea: (id: string) => Promise<Area>;
  close: () => Promise<void>;
};

export const createService = (options: DbOptions, deps: ServiceDeps = defaultServiceDeps): MindwtrService => {
  const { withDb, close } = createDbAccessor(options, deps);
  return {
    listTasks: async (input) => withDb((db) => deps.listTasks(db, input)),
    listProjects: async () => withDb((db) => deps.listProjects(db)),
    listAreas: async () => withDb((db) => deps.listAreas(db)),
    getTask: async (input) => withDb((db) => deps.getTask(db, input)),
    getProject: async (input) => withDb((db) => deps.getProject(db, input)),
    addTask: async (input) => {
      validateAddTaskInput(input);
      return await deps.runCoreService(options, async (core) => {
        if (input.quickAdd) {
          const projects = await withDb((db) => deps.listProjects(db));
          const quick = deps.parseQuickAdd(input.quickAdd, projects as CoreProject[]);
          const title = input.title ?? quick.title ?? input.quickAdd;
          const status = parseInputStatus(input.status);
          const props = filterUndefined({
            ...quick.props,
            status: status ?? quick.props.status,
            projectId: input.projectId ?? quick.props.projectId,
            dueDate: input.dueDate ?? quick.props.dueDate,
            startTime: input.startTime ?? quick.props.startTime,
            contexts: input.contexts ?? quick.props.contexts,
            tags: input.tags ?? quick.props.tags,
            description: input.description ?? quick.props.description,
            priority: input.priority ?? quick.props.priority,
            timeEstimate: input.timeEstimate ?? quick.props.timeEstimate,
          });
          return core.addTask({ title, props });
        }
        const status = parseInputStatus(input.status);
        return core.addTask({
          title: input.title ?? '',
          props: filterUndefined({
            status,
            projectId: input.projectId,
            dueDate: input.dueDate,
            startTime: input.startTime,
            contexts: input.contexts,
            tags: input.tags,
            description: input.description,
            priority: input.priority,
            timeEstimate: input.timeEstimate,
          }),
        });
      });
    },
    updateTask: async (input) =>
      deps.runCoreService(options, async (core) => {
        return core.updateTask({
          id: input.id,
          updates: buildTaskUpdates(input),
        });
      }),
    completeTask: async (id) => deps.runCoreService(options, (core) => core.completeTask(id)),
    deleteTask: async (id) => deps.runCoreService(options, (core) => core.deleteTask(id)),
    restoreTask: async (id) => deps.runCoreService(options, (core) => core.restoreTask(id)),
    addProject: async (input) =>
      deps.runCoreService(options, async (core) => {
        const title = validateProjectTitle(input.title);
        return core.addProject({
          title,
          color: input.color ?? DEFAULT_PROJECT_COLOR,
          props: filterUndefined({
            status: parseProjectStatus(input.status),
            areaId: input.areaId ?? undefined,
            isSequential: input.isSequential,
            isFocused: input.isFocused,
            reviewAt: input.reviewAt ?? undefined,
            supportNotes: input.supportNotes ?? undefined,
          }) as Partial<CoreProject>,
        });
      }),
    updateProject: async (input) =>
      deps.runCoreService(options, async (core) => {
        const updates = filterUndefined({
          title: input.title !== undefined ? validateProjectTitle(input.title) : undefined,
          color: input.color ?? undefined,
          status: parseProjectStatus(input.status),
          areaId: input.areaId ?? undefined,
          isSequential: input.isSequential,
          isFocused: input.isFocused,
          reviewAt: input.reviewAt ?? undefined,
          supportNotes: input.supportNotes ?? undefined,
        }) as Partial<CoreProject>;
        return core.updateProject({ id: input.id, updates });
      }),
    deleteProject: async (id) => deps.runCoreService(options, (core) => core.deleteProject(id)),
    addArea: async (input) =>
      deps.runCoreService(options, async (core) => {
        const name = validateAreaName(input.name);
        return core.addArea({
          name,
          props: filterUndefined({
            color: input.color,
            icon: input.icon,
          }) as Partial<CoreArea>,
        });
      }),
    updateArea: async (input) =>
      deps.runCoreService(options, async (core) => {
        const updates = filterUndefined({
          name: input.name !== undefined ? validateAreaName(input.name) : undefined,
          color: input.color ?? undefined,
          icon: input.icon ?? undefined,
        }) as Partial<CoreArea>;
        return core.updateArea({ id: input.id, updates });
      }),
    deleteArea: async (id) => deps.runCoreService(options, (core) => core.deleteArea(id)),
    close,
  };
};
