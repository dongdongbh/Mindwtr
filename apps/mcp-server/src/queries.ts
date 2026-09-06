import {
  PRIORITY_RANK,
  PROJECT_SQLITE_COLUMNS,
  TASK_SQLITE_COLUMNS,
  areaFromSqliteRow,
  buildTaskWhere,
  filterTasksBySearch,
  buildTaskFocusEligibilityContext,
  getTaskFocusEligibility,
  mapSqliteTaskRow,
  parseQuickAdd as parseQuickAddCore,
  personFromSqliteRow,
  projectFromSqliteRow,
  sectionFromSqliteRow,
  type Area as CoreArea,
  type Person as CorePerson,
  type Project as CoreProject,
  type Section as CoreSection,
  type Task as CoreTask,
  type TaskEnergyLevel as CoreTaskEnergyLevel,
  type TaskPriority as CoreTaskPriority,
  type TaskStatus as CoreTaskStatus,
  type TimeEstimate as CoreTimeEstimate,
} from '@mindwtr/core';
import type { DbClient } from './db.js';
import type { LinkAttachmentInput } from './link-attachments.js';
import { NotFoundError } from './errors.js';
import { MAX_TASK_LIST_LIMIT } from './input-validation.js';
import type { TaskRecurrenceInput } from './input-validation.js';

export type TaskStatus = CoreTaskStatus;
export type Task = CoreTask;
export type Project = CoreProject & { orderNum?: number };
export type Area = CoreArea;
export type Person = CorePerson;
export type Section = CoreSection;
export type ProjectRef = Pick<CoreProject, 'id' | 'title'>;

// Deliberately parses without a QuickAddParseOptions bag, unlike every capture
// surface in the apps: building one needs the full task list plus people, which
// here means a whole-library SQLite scan on every call. The cost is that
// multi-word `@Some Context` and `%Jim Smith` tokens split at the space instead
// of resolving against known values — acceptable for a scripted caller that can
// quote or hyphenate, not acceptable for a person typing. Pass a bag through if
// this ever backs an interactive surface.
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
  isFocusedToday?: boolean;
  /** GTD availability, via core getTaskFocusEligibility. */
  view?: 'available' | 'deferred' | 'blocked';
  sortBy?: 'updatedAt' | 'createdAt' | 'dueDate' | 'title' | 'priority';
  sortOrder?: 'asc' | 'desc';
};

// Task fields shared 1:1 between AddTaskInput/UpdateTaskInput and core's own Task type — these
// are exactly the fields task-write-fields.ts derives from TASK_SYNC_FIELD_SCHEMA (everything
// generated, minus the hand-typed ones above that need a different pre-normalization shape:
// recurrence's raw TaskRecurrenceInput vs Task's normalized Recurrence).
export type TaskGeneratedCreateFields = Pick<CoreTask,
  | 'taskMode'
  | 'relativeStartOffset'
  | 'showFutureRecurrence'
  | 'pushCount'
  | 'checklist'
  | 'textDirection'
  | 'location'
  | 'areaId'
  | 'isFocusedToday'
  | 'timeSpentMinutes'
  | 'suppressMindwtrReminders'
  | 'repeatReminderMinutes'
  | 'reviewAt'
>;

export type TaskGeneratedPatchFields = TaskGeneratedCreateFields & Pick<CoreTask, 'order' | 'boardOrder' | 'focusOrder'>;

export type AddTaskInput = {
  title?: string;
  quickAdd?: string;
  status?: TaskStatus;
  projectId?: string;
  sectionId?: string;
  dueDate?: string;
  startTime?: string;
  recurrence?: TaskRecurrenceInput;
  contexts?: string[];
  tags?: string[];
  description?: string;
  priority?: CoreTaskPriority;
  energyLevel?: CoreTaskEnergyLevel;
  assignedTo?: string;
  timeEstimate?: CoreTimeEstimate;
  attachments?: LinkAttachmentInput[];
} & Partial<TaskGeneratedCreateFields>;

export type TaskRow = Task;

type ColumnInfoRow = { name?: unknown };
type TaskSqliteRow = Record<string, unknown>;
type ProjectSqliteRow = Record<string, unknown> & {
  id: string;
  title: string;
  status?: string | null;
  color?: string | null;
  orderNum?: number | null;
  tagIds?: unknown;
  isSequential?: number | null;
  sequentialScope?: string | null;
  taskSortBy?: string | null;
  isFocused?: number | null;
  supportNotes?: string | null;
  attachments?: unknown;
  dueDate?: string | null;
  startDate?: string | null;
  reviewAt?: string | null;
  areaId?: string | null;
  areaTitle?: string | null;
  rev?: number | null;
  revBy?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  purgedAt?: string | null;
};
type SectionSqliteRow = Record<string, unknown> & {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  orderNum?: number | null;
  isCollapsed?: number | null;
  rev?: number | null;
  revBy?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};
type AreaSqliteRow = Record<string, unknown> & {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  orderNum?: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};
type PersonSqliteRow = Record<string, unknown> & {
  id: string;
  name: string;
  note?: string | null;
  referenceLink?: string | null;
  rev?: number | null;
  revBy?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

// MCP writes go through the core-backed adapter, but reads are intentionally
// kept as direct SQL so list/search tools stay fast and read-only. Row mapping
// is delegated to core; keep this projection in sync with core SQLite columns
// whenever task columns are added or renamed.
const BASE_TASK_COLUMNS = [...TASK_SQLITE_COLUMNS];

const taskColumnsCache = new WeakMap<DbClient, { hasOrderNum: boolean; insertColumns: string[]; selectColumns: string[] }>();

const getTaskColumns = (db: DbClient) => {
  const cached = taskColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(tasks)').all<ColumnInfoRow>();
    const names = new Set<string>(columns.map((col) => String(col.name)));
    const hasOrderNum = names.has('orderNum');
    const selectColumns = BASE_TASK_COLUMNS.filter((name) => name === 'orderNum' ? hasOrderNum : names.has(name));
    const insertColumns = TASK_SQLITE_COLUMNS.filter((name) => names.has(name));
    const resolved = { hasOrderNum, insertColumns, selectColumns };
    taskColumnsCache.set(db, resolved);
    return resolved;
  } catch {
    const fallback = { hasOrderNum: true, insertColumns: [...TASK_SQLITE_COLUMNS], selectColumns: BASE_TASK_COLUMNS };
    taskColumnsCache.set(db, fallback);
    return fallback;
  }
};


// `priority` is a TEXT column, so sorting it directly is lexicographic ('high' sorts after
// 'medium' and 'urgent' descending). Rank it through a CASE built from the shared
// PRIORITY_RANK map so this can't drift from the cloud adapter's JS sort (cloud-service.ts).
// A task with no priority falls through to 0, matching the cloud side's `?? 0`.
const PRIORITY_SQL_CASE = `CASE priority ${Object.entries(PRIORITY_RANK)
  .map(([priority, rank]) => `WHEN '${priority}' THEN ${rank}`)
  .join(' ')} ELSE 0 END`;

function mapTaskRow(row: TaskSqliteRow): TaskRow {
  const task = mapSqliteTaskRow(row);
  return {
    ...task,
    tags: task.tags ?? [],
    contexts: task.contexts ?? [],
    checklist: task.checklist ?? [],
    attachments: task.attachments ?? [],
    orderNum: task.orderNum ?? task.order,
  };
}

export function listTasks(db: DbClient, input: ListTasksInput): TaskRow[] {
  const { selectColumns } = getTaskColumns(db);

  // A database predating this column cannot contain a focused row. Keep `true`
  // narrow while treating every pre-column row as not focused for `false`.
  if (input.isFocusedToday === true && !selectColumns.includes('isFocusedToday')) {
    return [];
  }
  // mindwtr_list_tasks has no default done/archived hiding (unlike the cloud REST
  // API's GET /v1/tasks) - opt out of buildTaskWhere's archived default explicitly
  // via includeArchived rather than special-casing this surface's own default.
  const { sql: coreWhere, params: coreParams } = buildTaskWhere({
    status: input.status,
    projectId: input.projectId,
    includeDeleted: input.includeDeleted,
    includeArchived: true,
    isFocusedToday: selectColumns.includes('isFocusedToday') ? input.isFocusedToday : undefined,
  });
  const where: string[] = coreWhere ? [coreWhere] : [];
  const params: unknown[] = [...coreParams];

  if (input.dueDateFrom) {
    where.push('date(dueDate) >= date(?)');
    params.push(input.dueDateFrom);
  }
  if (input.dueDateTo) {
    where.push('date(dueDate) <= date(?)');
    params.push(input.dueDateTo);
  }

  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(MAX_TASK_LIST_LIMIT, input.limit as number)) : 200;
  const offset = Number.isFinite(input.offset) ? Math.max(0, input.offset as number) : 0;

  // Validate and apply sorting
  const validSortColumns = ['updatedAt', 'createdAt', 'dueDate', 'title', 'priority'];
  const sortBy = validSortColumns.includes(input.sortBy ?? '') ? input.sortBy : 'updatedAt';
  const sortOrder = input.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const orderExpr = sortBy === 'priority' ? PRIORITY_SQL_CASE : sortBy;
  // `id ASC` is a stable tie-break for equal sort keys and, like the cloud adapter's
  // `id.localeCompare`, never flips direction with sortOrder.
  const selectSql = `SELECT ${selectColumns.join(', ')} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderExpr} ${sortOrder}, id ASC`;

  if (input.search || input.view) {
    // The documented operator language (status:/context:/due:<=7d/negation/quotes) lives in
    // core and cannot be expressed in SQL, so the non-search filters run in the database and
    // the query runs over that result. filterTasksBySearch, NOT searchAll: searchAll caps at
    // SEARCH_RESULT_LIMIT (200) before any caller paginates, which would silently strand
    // every match past the 200th. Here limit/offset apply to the whole match set.
    // ponytail: reads the pre-search matches into memory; push down only if a real database
    // ever grows enough for it to show up.
    const projects = listProjects(db) as unknown as CoreProject[];
    const rows = db.prepare(selectSql).all<TaskSqliteRow>(...params).map(mapTaskRow) as unknown as CoreTask[];
    let matched = input.search ? filterTasksBySearch(rows, projects, input.search) : rows;

    if (input.view) {
      // GTD availability is core's, not re-derived here: getTaskFocusEligibility already
      // answers eligible / deferred (start date in the future) / sequential (an earlier step
      // in a sequential project still holds the slot).
      //
      // Which task holds a sequential project's slot depends on the WHOLE library, so the base
      // set must be every task — not a listTasks() page, whose 200 default (and 1000 cap) made
      // step 1 invisible on big libraries and reported blocked tasks as available (D2).
      const allWhere = buildTaskWhere({ includeDeleted: input.includeDeleted, includeArchived: true });
      const all = db
        .prepare(`SELECT ${selectColumns.join(', ')} FROM tasks${allWhere.sql ? ` WHERE ${allWhere.sql}` : ''}`)
        .all<TaskSqliteRow>(...allWhere.params)
        .map(mapTaskRow) as unknown as CoreTask[];
      // Once, not per candidate: the sequential-chain scan is O(all), so deriving it inside the
      // filter was O(matched x all) — 10s at 10k tasks, minutes at 50k (V2).
      const context = buildTaskFocusEligibilityContext({ tasks: all, projects });
      const wanted = input.view === 'blocked' ? 'sequential' : input.view === 'deferred' ? 'deferred' : 'eligible';
      matched = matched.filter((task) => getTaskFocusEligibility(task, { tasks: all, ...context }).reason === wanted);
    }

    return matched.slice(offset, offset + limit) as unknown as TaskRow[];
  }

  const rows = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all<TaskSqliteRow>(...params, limit, offset);
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
  const row = db.prepare(sql).get<TaskSqliteRow>(input.id);
  if (!row) {
    throw new NotFoundError(`Task not found: ${input.id}`);
  }
  return mapTaskRow(row);
}

const BASE_PROJECT_COLUMNS = [...PROJECT_SQLITE_COLUMNS];

const projectColumnsCache = new WeakMap<DbClient, { hasOrderNum: boolean; selectColumns: string[] }>();

const getProjectColumns = (db: DbClient) => {
  const cached = projectColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(projects)').all<ColumnInfoRow>();
    const names = new Set<string>(columns.map((col) => String(col.name)));
    const hasOrderNum = names.has('orderNum');
    const hasDueDate = names.has('dueDate');
    const hasStartDate = names.has('startDate');
    const selectColumns = BASE_PROJECT_COLUMNS.filter(
      (name) => names.has(name)
        && (hasOrderNum || name !== 'orderNum')
        && (hasDueDate || name !== 'dueDate')
        && (hasStartDate || name !== 'startDate')
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

export function listProjects(db: DbClient): Project[] {
  const { selectColumns } = getProjectColumns(db);
  const rows = db.prepare(`SELECT ${selectColumns.join(', ')} FROM projects WHERE deletedAt IS NULL`).all<ProjectSqliteRow>();
  return rows.map((row) => projectFromSqliteRow(row));
}

export type GetProjectInput = { id: string; includeDeleted?: boolean };

export function getProject(db: DbClient, input: GetProjectInput): Project {
  const { selectColumns } = getProjectColumns(db);
  const where = ['id = ?'];
  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM projects WHERE ${where.join(' AND ')}`).get<ProjectSqliteRow>(input.id);
  if (!row) {
    throw new NotFoundError(`Project not found: ${input.id}`);
  }
  return projectFromSqliteRow(row);
}

const BASE_SECTION_COLUMNS = [
  'id',
  'projectId',
  'title',
  'description',
  'orderNum',
  'isCollapsed',
  'rev',
  'revBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

const sectionColumnsCache = new WeakMap<DbClient, { hasOrderNum: boolean; selectColumns: string[] }>();

const getSectionColumns = (db: DbClient) => {
  const cached = sectionColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(sections)').all<ColumnInfoRow>();
    const names = new Set<string>(columns.map((col) => String(col.name)));
    const hasOrderNum = names.has('orderNum');
    const selectColumns = BASE_SECTION_COLUMNS.filter((name) => hasOrderNum || name !== 'orderNum');
    const resolved = { hasOrderNum, selectColumns };
    sectionColumnsCache.set(db, resolved);
    return resolved;
  } catch {
    const fallback = { hasOrderNum: true, selectColumns: BASE_SECTION_COLUMNS };
    sectionColumnsCache.set(db, fallback);
    return fallback;
  }
};

export type ListSectionsInput = {
  projectId?: string;
  includeDeleted?: boolean;
};

export function listSections(db: DbClient, input: ListSectionsInput = {}): Section[] {
  const { hasOrderNum, selectColumns } = getSectionColumns(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.projectId) {
    where.push('projectId = ?');
    params.push(input.projectId);
  }
  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const orderSql = hasOrderNum ? 'projectId ASC, orderNum ASC, title ASC' : 'projectId ASC, title ASC';
  const rows = db
    .prepare(`SELECT ${selectColumns.join(', ')} FROM sections${whereSql} ORDER BY ${orderSql}`)
    .all<SectionSqliteRow>(...params);
  return rows.map((row) => sectionFromSqliteRow(row));
}

export type GetSectionInput = { id: string; includeDeleted?: boolean };

export function getSection(db: DbClient, input: GetSectionInput): Section {
  const { selectColumns } = getSectionColumns(db);
  const where = ['id = ?'];
  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM sections WHERE ${where.join(' AND ')}`).get<SectionSqliteRow>(input.id);
  if (!row) {
    throw new NotFoundError(`Section not found: ${input.id}`);
  }
  return sectionFromSqliteRow(row);
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
    const columns = db.prepare('PRAGMA table_info(areas)').all<ColumnInfoRow>();
    const names = new Set<string>(columns.map((col) => String(col.name)));
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

export function listAreas(db: DbClient): Area[] {
  const { selectColumns } = getAreaColumns(db);
  const rows = db.prepare(`SELECT ${selectColumns.join(', ')} FROM areas WHERE deletedAt IS NULL ORDER BY orderNum ASC, updatedAt DESC`).all<AreaSqliteRow>();
  return rows.map((row) => areaFromSqliteRow(row));
}

const BASE_PERSON_COLUMNS = [
  'id',
  'name',
  'note',
  'referenceLink',
  'rev',
  'revBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
];

const peopleColumnsCache = new WeakMap<DbClient, { exists: boolean; selectColumns: string[] }>();

const getPeopleColumns = (db: DbClient) => {
  const cached = peopleColumnsCache.get(db);
  if (cached) return cached;
  try {
    const columns = db.prepare('PRAGMA table_info(people)').all<ColumnInfoRow>();
    const names = new Set<string>(columns.map((col) => String(col.name)));
    const exists = names.size > 0;
    const selectColumns = BASE_PERSON_COLUMNS.filter((name) => names.has(name));
    const resolved = { exists, selectColumns: selectColumns.length > 0 ? selectColumns : BASE_PERSON_COLUMNS };
    peopleColumnsCache.set(db, resolved);
    return resolved;
  } catch {
    const fallback = { exists: false, selectColumns: BASE_PERSON_COLUMNS };
    peopleColumnsCache.set(db, fallback);
    return fallback;
  }
};

export type ListPeopleInput = {
  includeDeleted?: boolean;
};

export function listPeople(db: DbClient, input: ListPeopleInput = {}): Person[] {
  const { exists, selectColumns } = getPeopleColumns(db);
  if (!exists) return [];
  const where = input.includeDeleted ? '' : ' WHERE deletedAt IS NULL';
  const rows = db
    .prepare(`SELECT ${selectColumns.join(', ')} FROM people${where} ORDER BY lower(name) ASC, updatedAt DESC`)
    .all<PersonSqliteRow>();
  return rows.map((row) => personFromSqliteRow(row));
}

export type GetPersonInput = { id: string; includeDeleted?: boolean };

export function getPerson(db: DbClient, input: GetPersonInput): Person {
  const { exists, selectColumns } = getPeopleColumns(db);
  if (!exists) {
    throw new NotFoundError(`Person not found: ${input.id}`);
  }
  const where = ['id = ?'];
  if (!input.includeDeleted) {
    where.push('deletedAt IS NULL');
  }
  const row = db.prepare(`SELECT ${selectColumns.join(', ')} FROM people WHERE ${where.join(' AND ')}`).get<PersonSqliteRow>(input.id);
  if (!row) {
    throw new NotFoundError(`Person not found: ${input.id}`);
  }
  return personFromSqliteRow(row);
}

// Booleans have no "clear it" state distinct from false (see task-field-schemas.ts), so they
// stay plain-optional here rather than nullable like every other generated patch field.
type NullableExceptBooleans<T> = { [K in keyof T]?: T[K] extends boolean | undefined ? T[K] : T[K] | null };

export type UpdateTaskInput = {
  id: string;
  title?: string;
  status?: TaskStatus;
  projectId?: string | null;
  sectionId?: string | null;
  dueDate?: string | null;
  startTime?: string | null;
  recurrence?: TaskRecurrenceInput | null;
  contexts?: string[] | null;
  tags?: string[] | null;
  description?: string | null;
  priority?: CoreTaskPriority | null;
  energyLevel?: CoreTaskEnergyLevel | null;
  assignedTo?: string | null;
  timeEstimate?: CoreTimeEstimate | null;
  attachments?: LinkAttachmentInput[] | null;
} & NullableExceptBooleans<TaskGeneratedPatchFields>;
