import {
  DEFAULT_PROJECT_COLOR,
  TASK_STATUS_SET,
  normalizeTaskStatus as normalizeCoreTaskStatus,
  parseQuickAdd as parseQuickAddCore,
  type Area as CoreArea,
  type Project as CoreProject,
  type Task as CoreTask,
  type TaskStatus as CoreTaskStatus,
} from '@mindwtr/core';
import type { DbClient } from './db.js';
import { parseJson } from './db.js';
import { NotFoundError, ValidationError } from './errors.js';

export type TaskStatus = CoreTaskStatus;
export type Task = CoreTask;
export type Project = CoreProject & { orderNum?: number };
export type Area = CoreArea;
export type ProjectRef = Pick<CoreProject, 'id' | 'title'>;

const normalizeTaskStatus = (value: string): TaskStatus => {
  return normalizeCoreTaskStatus(value);
};

const parseTaskStatusInput = (value: unknown): TaskStatus | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`Invalid task status: ${String(value)}`);
  }
  const normalized = value.toLowerCase().trim();
  if (!TASK_STATUS_SET.has(normalized as TaskStatus)) {
    throw new ValidationError(`Invalid task status: ${value}`);
  }
  return normalized as TaskStatus;
};

const generateUUID = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `mcp_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
};

export const parseQuickAdd = (input: string, projects: ProjectRef[]): { title: string; props: Partial<Task> } => {
  const parsed = parseQuickAddCore(input, projects as CoreProject[]);
  return {
    title: parsed.title,
    props: parsed.props as Partial<Task>,
  };
};

export type ListTasksInput = {
  status?: TaskStatus | 'all';
  projectId?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  search?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  sortBy?: 'updatedAt' | 'createdAt' | 'dueDate' | 'title' | 'priority';
  sortOrder?: 'asc' | 'desc';
};

export type AddTaskInput = {
  title?: string;
  quickAdd?: string;
  status?: TaskStatus;
  projectId?: string;
  dueDate?: string;
  startTime?: string;
  contexts?: string[];
  tags?: string[];
  description?: string;
  priority?: string;
  energyLevel?: string;
  assignedTo?: string;
  timeEstimate?: string;
};

export type CompleteTaskInput = { id: string };

export type TaskRow = Task;

const BASE_TASK_COLUMNS = [
  'id',
  'title',
  'status',
  'priority',
  'energyLevel',
  'assignedTo',
  'taskMode',
  'startTime',
  'dueDate',
  'recurrence',
  'pushCount',
  'tags',
  'contexts',
  'checklist',
  'description',
  'textDirection',
  'attachments',
  'location',
  'projectId',
  'sectionId',
  'areaId',
  'orderNum',
  'isFocusedToday',
  'timeEstimate',
  'reviewAt',
  'completedAt',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'purgedAt',
];

const taskColumnsCache = new WeakMap<DbClient, { hasOrderNum: boolean; selectColumns: string[] }>();
const tasksFtsCache = new WeakMap<DbClient, boolean>();

const getTaskColumns = (db: DbClient) => {
  const cached = taskColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(tasks)').all();
    const names = new Set<string>(columns.map((col: any) => String(col.name)));
    const hasOrderNum = names.has('orderNum');
    const selectColumns = BASE_TASK_COLUMNS.filter((name) => name === 'orderNum' ? hasOrderNum : names.has(name));
    const resolved = { hasOrderNum, selectColumns };
    taskColumnsCache.set(db, resolved);
    return resolved;
  } catch {
    const fallback = { hasOrderNum: true, selectColumns: BASE_TASK_COLUMNS };
    taskColumnsCache.set(db, fallback);
    return fallback;
  }
};

const hasTasksFts = (db: DbClient): boolean => {
  const cached = tasksFtsCache.get(db);
  if (cached !== undefined) return cached;
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks_fts'").all();
    const hasFts = rows.some((row: any) => row?.name === 'tasks_fts');
    tasksFtsCache.set(db, hasFts);
    return hasFts;
  } catch {
    tasksFtsCache.set(db, false);
    return false;
  }
};

const buildTasksFtsQuery = (search: string): string | null => {
  const cleaned = String(search || '')
    .replace(/[^\p{L}\p{N}#@]+/gu, ' ')
    .trim();
  if (!cleaned) return null;
  const reservedTokens = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const tokens = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !reservedTokens.has(token.toUpperCase()));
  if (tokens.length === 0) return null;
  return tokens.map((token) => `${token}*`).join(' ');
};

function mapTaskRow(row: any): TaskRow {
  return {
    id: row.id as string,
    title: row.title as string,
    status: normalizeTaskStatus(row.status as string),
    priority: row.priority ?? undefined,
    energyLevel: row.energyLevel ?? undefined,
    assignedTo: row.assignedTo ?? undefined,
    taskMode: row.taskMode ?? undefined,
    startTime: row.startTime ?? undefined,
    dueDate: row.dueDate ?? undefined,
    recurrence: parseJson(row.recurrence, undefined),
    pushCount: row.pushCount ?? undefined,
    tags: parseJson(row.tags, []),
    contexts: parseJson(row.contexts, []),
    checklist: parseJson(row.checklist, []),
    description: row.description ?? undefined,
    textDirection: row.textDirection ?? undefined,
    attachments: parseJson(row.attachments, []),
    location: row.location ?? undefined,
    projectId: row.projectId ?? undefined,
    sectionId: row.sectionId ?? undefined,
    areaId: row.areaId ?? undefined,
    order: row.orderNum ?? undefined,
    orderNum: row.orderNum ?? undefined,
    isFocusedToday: row.isFocusedToday === 1,
    timeEstimate: row.timeEstimate ?? undefined,
    reviewAt: row.reviewAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    deletedAt: row.deletedAt ?? undefined,
    purgedAt: row.purgedAt ?? undefined,
  };
}

export function listTasks(db: DbClient, input: ListTasksInput): TaskRow[] {
  const where: string[] = [];
  const params: any[] = [];

  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  if (input.status && input.status !== 'all') {
    where.push('status = ?');
    params.push(input.status);
  }
  if (input.projectId) {
    where.push('projectId = ?');
    params.push(input.projectId);
  }
  if (input.search) {
    const ftsQuery = buildTasksFtsQuery(input.search);
    if (ftsQuery && hasTasksFts(db)) {
      where.push("id IN (SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?)");
      params.push(ftsQuery);
    } else {
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      // Escape SQL wildcards (%, _, \) in search input
      const escaped = input.search.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      params.push(pattern, pattern);
    }
  }
  if (input.dueDateFrom) {
    where.push('dueDate >= ?');
    params.push(input.dueDateFrom);
  }
  if (input.dueDateTo) {
    where.push('dueDate <= ?');
    params.push(input.dueDateTo);
  }

  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(500, input.limit as number)) : 200;
  const offset = Number.isFinite(input.offset) ? Math.max(0, input.offset as number) : 0;

  // Validate and apply sorting
  const validSortColumns = ['updatedAt', 'createdAt', 'dueDate', 'title', 'priority'];
  const sortBy = validSortColumns.includes(input.sortBy ?? '') ? input.sortBy : 'updatedAt';
  const sortOrder = input.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const { selectColumns } = getTaskColumns(db);
  const sql = `SELECT ${selectColumns.join(', ')} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset);
  return rows.map(mapTaskRow);
}

export type GetTaskInput = { id: string; includeDeleted?: boolean };

export function getTask(db: DbClient, input: GetTaskInput): TaskRow {
  const where = ['id = ?'];
  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  const { selectColumns } = getTaskColumns(db);
  const sql = `SELECT ${selectColumns.join(', ')} FROM tasks WHERE ${where.join(' AND ')}`;
  const row = db.prepare(sql).get(input.id);
  if (!row) {
    throw new NotFoundError(`Task not found: ${input.id}`);
  }
  return mapTaskRow(row);
}

const BASE_PROJECT_COLUMNS = [
  'id',
  'title',
  'status',
  'areaId',
  'areaTitle',
  'color',
  'orderNum',
  'tagIds',
  'isSequential',
  'isFocused',
  'supportNotes',
  'attachments',
  'dueDate',
  'reviewAt',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

const projectColumnsCache = new WeakMap<DbClient, { hasOrderNum: boolean; selectColumns: string[] }>();

const getProjectColumns = (db: DbClient) => {
  const cached = projectColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(projects)').all();
    const names = new Set<string>(columns.map((col: any) => String(col.name)));
    const hasOrderNum = names.has('orderNum');
    const hasDueDate = names.has('dueDate');
    const selectColumns = BASE_PROJECT_COLUMNS.filter(
      (name) => (hasOrderNum || name !== 'orderNum') && (hasDueDate || name !== 'dueDate')
    );
    const resolved = { hasOrderNum, selectColumns };
    projectColumnsCache.set(db, resolved);
    return resolved;
  } catch {
    const fallback = { hasOrderNum: true, selectColumns: BASE_PROJECT_COLUMNS };
    projectColumnsCache.set(db, fallback);
    return fallback;
  }
};

const listProjectRefsForQuickAdd = (db: DbClient): ProjectRef[] => {
  const rows = db.prepare('SELECT id, title FROM projects WHERE deletedAt IS NULL').all();
  return rows
    .filter((row: any) => typeof row.id === 'string' && typeof row.title === 'string')
    .map((row: any) => ({ id: row.id, title: row.title }));
};

export function listProjects(db: DbClient): Project[] {
  const { selectColumns } = getProjectColumns(db);
  const rows = db.prepare(`SELECT ${selectColumns.join(', ')} FROM projects WHERE deletedAt IS NULL`).all();
  return rows.map(mapProjectRow);
}

const mapProjectRow = (row: any): Project => ({
  id: row.id,
  title: row.title,
  status: row.status === 'someday' || row.status === 'waiting' || row.status === 'archived' ? row.status : 'active',
  color: row.color ?? DEFAULT_PROJECT_COLOR,
  order: row.orderNum ?? 0,
  orderNum: row.orderNum ?? undefined,
  tagIds: parseJson(row.tagIds, []),
  isSequential: row.isSequential === 1,
  isFocused: row.isFocused === 1,
  supportNotes: row.supportNotes ?? undefined,
  attachments: parseJson(row.attachments, []),
  dueDate: row.dueDate ?? undefined,
  reviewAt: row.reviewAt ?? undefined,
  areaId: row.areaId ?? undefined,
  areaTitle: row.areaTitle ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? undefined,
});

export type GetProjectInput = { id: string; includeDeleted?: boolean };

export function getProject(db: DbClient, input: GetProjectInput): Project {
  const { selectColumns } = getProjectColumns(db);
  const where = ['id = ?'];
  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM projects WHERE ${where.join(' AND ')}`).get(input.id);
  if (!row) {
    throw new NotFoundError(`Project not found: ${input.id}`);
  }
  return mapProjectRow(row);
}

const BASE_AREA_COLUMNS = [
  'id',
  'name',
  'color',
  'icon',
  'orderNum',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

const areaColumnsCache = new WeakMap<DbClient, { hasOrderNum: boolean; selectColumns: string[] }>();

const getAreaColumns = (db: DbClient) => {
  const cached = areaColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(areas)').all();
    const names = new Set<string>(columns.map((col: any) => String(col.name)));
    const hasOrderNum = names.has('orderNum');
    const selectColumns = BASE_AREA_COLUMNS.filter((name) => hasOrderNum || name !== 'orderNum');
    const resolved = { hasOrderNum, selectColumns };
    areaColumnsCache.set(db, resolved);
    return resolved;
  } catch {
    const fallback = { hasOrderNum: true, selectColumns: BASE_AREA_COLUMNS };
    areaColumnsCache.set(db, fallback);
    return fallback;
  }
};

const mapAreaRow = (row: any): Area => ({
  id: row.id,
  name: row.name,
  color: row.color ?? undefined,
  icon: row.icon ?? undefined,
  order: row.orderNum ?? 0,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt ?? undefined,
});

export function listAreas(db: DbClient): Area[] {
  const { selectColumns } = getAreaColumns(db);
  const rows = db.prepare(`SELECT ${selectColumns.join(', ')} FROM areas WHERE deletedAt IS NULL ORDER BY orderNum ASC, updatedAt DESC`).all();
  return rows.map(mapAreaRow);
}

const runInTransaction = <T>(db: DbClient, fn: () => T): T => {
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const result = fn();
    db.prepare('COMMIT').run();
    return result;
  } catch (error) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      // Best effort rollback.
    }
    throw error;
  }
};

export function addTask(db: DbClient, input: AddTaskInput): TaskRow {
  return runInTransaction(db, () => {
    const now = new Date().toISOString();
    let title = (input.title || '').trim();
    let props: Partial<Task> = {};

    if (input.quickAdd) {
      const projects = listProjectRefsForQuickAdd(db);
      const quick = parseQuickAdd(input.quickAdd, projects);
      title = quick.title || title || input.quickAdd;
      props = quick.props;
    }

    if (!title) {
      throw new ValidationError('Task title is required.');
    }

    const status = parseTaskStatusInput(input.status) ?? parseTaskStatusInput(props.status) ?? 'inbox';
    const task: Task = {
      id: generateUUID(),
      title,
      status,
      priority: (input.priority ?? props.priority) as Task['priority'],
      energyLevel: (input.energyLevel ?? props.energyLevel) as Task['energyLevel'],
      assignedTo: (input.assignedTo ?? props.assignedTo) as Task['assignedTo'],
      taskMode: props.taskMode,
      startTime: input.startTime ?? props.startTime,
      dueDate: input.dueDate ?? props.dueDate,
      recurrence: props.recurrence,
      pushCount: props.pushCount,
      tags: input.tags ?? (props.tags as string[] | undefined) ?? [],
      contexts: input.contexts ?? (props.contexts as string[] | undefined) ?? [],
      checklist: props.checklist,
      description: input.description ?? props.description,
      attachments: props.attachments,
      location: props.location,
      projectId: input.projectId ?? props.projectId,
      order: props.order ?? props.orderNum ?? undefined,
      orderNum: props.orderNum ?? props.order ?? undefined,
      isFocusedToday: props.isFocusedToday ?? false,
      timeEstimate: input.timeEstimate ?? props.timeEstimate,
      reviewAt: props.reviewAt,
      completedAt: props.completedAt,
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
      purgedAt: undefined,
    };

    const { hasOrderNum } = getTaskColumns(db);
    const insertColumns = [
      'id',
      'title',
      'status',
      'priority',
      'energyLevel',
      'assignedTo',
      'taskMode',
      'startTime',
      'dueDate',
      'recurrence',
      'pushCount',
      'tags',
      'contexts',
      'checklist',
      'description',
      'attachments',
      'location',
      'projectId',
      ...(hasOrderNum ? ['orderNum'] : []),
      'isFocusedToday',
      'timeEstimate',
      'reviewAt',
      'completedAt',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'purgedAt',
    ];
    const insert = db.prepare(`
      INSERT INTO tasks (
        ${insertColumns.join(', ')}
      ) VALUES (
        ${insertColumns.map((col) => `@${col}`).join(', ')}
      )
    `);

    insert.run({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority ?? null,
      energyLevel: task.energyLevel ?? null,
      assignedTo: task.assignedTo ?? null,
      taskMode: task.taskMode ?? null,
      startTime: task.startTime ?? null,
      dueDate: task.dueDate ?? null,
      recurrence: task.recurrence ? JSON.stringify(task.recurrence) : null,
      pushCount: task.pushCount ?? null,
      tags: JSON.stringify(task.tags ?? []),
      contexts: JSON.stringify(task.contexts ?? []),
      checklist: task.checklist ? JSON.stringify(task.checklist) : null,
      description: task.description ?? null,
      attachments: task.attachments ? JSON.stringify(task.attachments) : null,
      location: task.location ?? null,
      projectId: task.projectId ?? null,
      ...(hasOrderNum ? { orderNum: task.orderNum ?? null } : {}),
      isFocusedToday: task.isFocusedToday ? 1 : 0,
      timeEstimate: task.timeEstimate ?? null,
      reviewAt: task.reviewAt ?? null,
      completedAt: task.completedAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      deletedAt: task.deletedAt ?? null,
      purgedAt: task.purgedAt ?? null,
    });

    return task as TaskRow;
  });
}

export function completeTask(db: DbClient, input: CompleteTaskInput): TaskRow {
  return runInTransaction(db, () => {
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE tasks
      SET status = 'done', completedAt = ?, updatedAt = ?
      WHERE id = ? AND deletedAt IS NULL
    `);
    const info = update.run(now, now, input.id);
    if (!info.changes || info.changes === 0) {
      throw new NotFoundError(`Task not found: ${input.id}`);
    }

    const { selectColumns } = getTaskColumns(db);
    const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM tasks WHERE id = ?`).get(input.id);
    if (!row) {
      throw new NotFoundError(`Task not found after update: ${input.id}`);
    }
    return mapTaskRow(row);
  });
}

export type UpdateTaskInput = {
  id: string;
  title?: string;
  status?: TaskStatus;
  projectId?: string | null;
  dueDate?: string | null;
  startTime?: string | null;
  contexts?: string[] | null;
  tags?: string[] | null;
  description?: string | null;
  priority?: string | null;
  energyLevel?: string | null;
  assignedTo?: string | null;
  timeEstimate?: string | null;
  reviewAt?: string | null;
  isFocusedToday?: boolean;
};

export function updateTask(db: DbClient, input: UpdateTaskInput): TaskRow {
  return runInTransaction(db, () => {
    const { selectColumns } = getTaskColumns(db);
    const existing = db.prepare(`SELECT ${selectColumns.join(', ')} FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(input.id);
    if (!existing) {
      throw new NotFoundError(`Task not found: ${input.id}`);
    }
    const current = mapTaskRow(existing);
    const now = new Date().toISOString();

    const updated: TaskRow = {
      ...current,
      title: input.title ?? current.title,
      status: parseTaskStatusInput(input.status) ?? current.status,
      projectId: input.projectId === null ? undefined : input.projectId ?? current.projectId,
      dueDate: input.dueDate === null ? undefined : input.dueDate ?? current.dueDate,
      startTime: input.startTime === null ? undefined : input.startTime ?? current.startTime,
      contexts: input.contexts === null ? [] : input.contexts ?? current.contexts ?? [],
      tags: input.tags === null ? [] : input.tags ?? current.tags ?? [],
      description: input.description === null ? undefined : input.description ?? current.description,
      priority: input.priority === null ? undefined : input.priority ?? current.priority,
      energyLevel: input.energyLevel === null ? undefined : input.energyLevel ?? current.energyLevel,
      assignedTo: input.assignedTo === null ? undefined : input.assignedTo ?? current.assignedTo,
      timeEstimate: input.timeEstimate === null ? undefined : input.timeEstimate ?? current.timeEstimate,
      reviewAt: input.reviewAt === null ? undefined : input.reviewAt ?? current.reviewAt,
      isFocusedToday: input.isFocusedToday ?? current.isFocusedToday,
      updatedAt: now,
    };

    const update = db.prepare(`
      UPDATE tasks
      SET title = @title,
          status = @status,
          projectId = @projectId,
          dueDate = @dueDate,
          startTime = @startTime,
          contexts = @contexts,
          tags = @tags,
          description = @description,
          priority = @priority,
          energyLevel = @energyLevel,
          assignedTo = @assignedTo,
          timeEstimate = @timeEstimate,
          reviewAt = @reviewAt,
          isFocusedToday = @isFocusedToday,
          updatedAt = @updatedAt
      WHERE id = @id
    `);

    update.run({
      id: updated.id,
      title: updated.title,
      status: updated.status,
      projectId: updated.projectId ?? null,
      dueDate: updated.dueDate ?? null,
      startTime: updated.startTime ?? null,
      contexts: JSON.stringify(updated.contexts ?? []),
      tags: JSON.stringify(updated.tags ?? []),
      description: updated.description ?? null,
      priority: updated.priority ?? null,
      energyLevel: updated.energyLevel ?? null,
      assignedTo: updated.assignedTo ?? null,
      timeEstimate: updated.timeEstimate ?? null,
      reviewAt: updated.reviewAt ?? null,
      isFocusedToday: updated.isFocusedToday ? 1 : 0,
      updatedAt: updated.updatedAt,
    });

    const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM tasks WHERE id = ?`).get(input.id);
    if (!row) {
      throw new NotFoundError(`Task not found after update: ${input.id}`);
    }
    return mapTaskRow(row);
  });
}

export type DeleteTaskInput = { id: string };

export function deleteTask(db: DbClient, input: DeleteTaskInput): TaskRow {
  return runInTransaction(db, () => {
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE tasks
      SET deletedAt = ?, updatedAt = ?
      WHERE id = ? AND deletedAt IS NULL
    `);
    const info = update.run(now, now, input.id);
    if (!info.changes || info.changes === 0) {
      throw new NotFoundError(`Task not found or already deleted: ${input.id}`);
    }
    const { selectColumns } = getTaskColumns(db);
    const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM tasks WHERE id = ?`).get(input.id);
    if (!row) {
      throw new NotFoundError(`Task not found after delete: ${input.id}`);
    }
    return mapTaskRow(row);
  });
}

export type RestoreTaskInput = { id: string };

export function restoreTask(db: DbClient, input: RestoreTaskInput): TaskRow {
  return runInTransaction(db, () => {
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE tasks
      SET deletedAt = NULL, updatedAt = ?
      WHERE id = ? AND deletedAt IS NOT NULL
    `);
    const info = update.run(now, input.id);
    if (!info.changes || info.changes === 0) {
      throw new NotFoundError(`Task not found or not deleted: ${input.id}`);
    }
    const { selectColumns } = getTaskColumns(db);
    const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM tasks WHERE id = ?`).get(input.id);
    if (!row) {
      throw new NotFoundError(`Task not found after restore: ${input.id}`);
    }
    return mapTaskRow(row);
  });
}
