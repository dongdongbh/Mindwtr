import {
  buildQuickAddParseOptions,
  DEFAULT_PROJECT_COLOR,
  executeCaptureTransaction,
  parseQuickAdd,
  normalizeTaskStatus,
  TASK_STATUS_SET,
  type Area as CoreArea,
  type Person as CorePerson,
  type Project as CoreProject,
  type Section as CoreSection,
  type RelativeStartOffset,
} from '@mindwtr/core';

import { closeDb, openMindwtrDb, type DbOptions } from './db.js';
import { ValidationError } from './errors.js';
import { filterUndefined } from './filter-undefined.js';
import {
  MAX_AREA_NAME_LENGTH,
  MAX_TASK_QUICK_ADD_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  normalizeNullableTaskRecurrence,
  normalizeNullableTaskRelativeStartOffset,
  normalizeNullableTaskRepeatReminderMinutes,
  normalizeNullableTaskTimeSpentMinutes,
  normalizeNullableTaskTokens,
  normalizeOptionalTaskRecurrence,
  normalizeOptionalTaskRelativeStartOffset,
  normalizeOptionalTaskRepeatReminderMinutes,
  normalizeOptionalTaskTimeSpentMinutes,
  normalizeOptionalTaskTokens,
} from './input-validation.js';
import {
  getTask,
  getProject,
  getSection,
  getPerson,
  listAreas,
  listPeople,
  listProjects,
  listSections,
  listTasks,
  type AddTaskInput,
  type Area,
  type GetSectionInput,
  type GetPersonInput,
  type GetTaskInput,
  type GetProjectInput,
  type ListPeopleInput,
  type ListSectionsInput,
  type ListTasksInput,
  type Person,
  type Project,
  type Section,
  type Task,
  type TaskRow,
  type UpdateTaskInput,
} from './queries.js';
import { applyLinkAttachments, buildLinkAttachments, type LinkAttachmentInput } from './link-attachments.js';
import { closeCoreAdapter, runCoreService } from './core-adapter.js';
import { pickDefinedTaskFields, TASK_CREATE_FIELD_NAMES, TASK_PATCH_FIELD_NAMES } from './task-write-fields.js';

type ServiceDeps = {
  openMindwtrDb: typeof openMindwtrDb;
  closeDb: typeof closeDb;
  listTasks: typeof listTasks;
  listProjects: typeof listProjects;
  listSections: typeof listSections;
  listAreas: typeof listAreas;
  listPeople: typeof listPeople;
  getTask: typeof getTask;
  getProject: typeof getProject;
  getSection: typeof getSection;
  getPerson: typeof getPerson;
  parseQuickAdd: typeof parseQuickAdd;
  runCoreService: typeof runCoreService;
  closeCoreAdapter: typeof closeCoreAdapter;
};

const defaultServiceDeps: ServiceDeps = {
  openMindwtrDb,
  closeDb,
  listTasks,
  listProjects,
  listSections,
  listAreas,
  listPeople,
  getTask,
  getProject,
  getSection,
  getPerson,
  parseQuickAdd,
  runCoreService,
  closeCoreAdapter,
};

const SQLITE_WRITE_RETRY_ATTEMPTS = 7;
const SQLITE_WRITE_RETRY_BASE_DELAY_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableSqliteWriteError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('sqlite_busy')
    || normalized.includes('sqlite_locked')
    || normalized.includes('database is locked')
    || normalized.includes('database is busy')
    || normalized.includes('database schema is locked')
    || normalized.includes('resource busy')
    || normalized.includes('temporarily unavailable')
  );
};

/**
 * Retries the WHOLE callback, which is safe even for multi-write callbacks (quickAdd can mint
 * a project and then a task) because of two invariants. Break either and retries start
 * duplicating:
 *
 *  1. Completed writes are flushed by the end of the capture — core-adapter's addProject and
 *     writeTask both await flushPendingSave (flushCoreSave), and any write still pending when
 *     a later write flushes rides along. So whatever a failed attempt completed is in SQLite
 *     by the time the next attempt re-reads. (This is a per-capture guarantee, not a strict
 *     per-call durability barrier — service.test.ts's fault-injection test is sensitive to
 *     invariant 2, which is the one that actually prevents duplication.)
 *  2. The callback re-derives its plan from storage on EVERY attempt — it reloads the core
 *     snapshot and re-runs parseQuickAdd inside the retried body, never from values captured
 *     outside it. So the retry sees the project attempt 1 created and resolves `+Launch` to
 *     that id instead of minting a second one.
 *
 * Verified against a real database by injecting one retryable SQLITE_BUSY at each write point
 * (R-08, 2026-08-13): failing addProject, failing addTask, or neither all end with exactly one
 * project and one task, correctly linked.
 *
 * NOTE for anyone writing that fault-injection test: `queries.ts` exports its own narrowing
 * `parseQuickAdd` that DROPS `projectTitle`, while this file imports the real one from
 * '@mindwtr/core'. A test whose deps spread `...queries` silently swaps the parser, the
 * capture then never creates the project at all, and the result looks like a persistence bug
 * that isn't one. Always run the no-fault control first.
 */
const runCoreWriteWithRetries = async <T>(
  options: DbOptions,
  deps: ServiceDeps,
  fn: Parameters<typeof runCoreService<T>>[1],
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < SQLITE_WRITE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await deps.runCoreService(options, fn);
    } catch (error) {
      lastError = error;
      if (!isRetryableSqliteWriteError(error) || attempt + 1 >= SQLITE_WRITE_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(SQLITE_WRITE_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
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
    throw new ValidationError(`Invalid task status: ${value}`);
  }
  return normalized;
};

const PROJECT_STATUS_SET = new Set<CoreProject['status']>(['active', 'someday', 'waiting', 'archived']);

const parseProjectStatus = (value: string | undefined): CoreProject['status'] | undefined => {
  if (value === undefined) return undefined;
  if (!PROJECT_STATUS_SET.has(value as CoreProject['status'])) {
    throw new ValidationError(`Invalid project status: ${value}`);
  }
  return value as CoreProject['status'];
};

const validateAddTaskInput = (input: AddTaskInput): AddTaskInput => {
  const hasTitle = typeof input.title === 'string' && input.title.trim().length > 0;
  const hasQuickAdd = typeof input.quickAdd === 'string' && input.quickAdd.trim().length > 0;
  if (!hasTitle && !hasQuickAdd) {
    throw new ValidationError('Either title or quickAdd is required');
  }
  if (hasTitle && hasQuickAdd) {
    throw new ValidationError('Provide either title or quickAdd, not both');
  }
  if (hasTitle && input.title!.trim().length > MAX_TASK_TITLE_LENGTH) {
    throw new ValidationError(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
  if (hasQuickAdd && input.quickAdd!.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
    throw new ValidationError(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`);
  }
  return {
    ...input,
    contexts: normalizeOptionalTaskTokens('contexts', input.contexts),
    tags: normalizeOptionalTaskTokens('tags', input.tags),
    relativeStartOffset: normalizeOptionalTaskRelativeStartOffset(input.relativeStartOffset),
    timeSpentMinutes: normalizeOptionalTaskTimeSpentMinutes(input.timeSpentMinutes),
    repeatReminderMinutes: normalizeOptionalTaskRepeatReminderMinutes(input.repeatReminderMinutes),
  };
};

// Fields already normalized onto `normalizedInput` by validateAddTaskInput (contexts, tags,
// relativeStartOffset, timeSpentMinutes, repeatReminderMinutes) plus every other
// create-writable field TASK_CREATE_FIELD_NAMES derives (checklist, areaId, reviewAt,
// isFocusedToday, taskMode, ...) — recurrence is handled by its own call site above since it
// needs `core`-scoped normalization timing the others don't. Adding a synced field to
// TASK_CREATE_FIELD_NAMES needs no edit here.
const generatedCreateTaskProps = (input: AddTaskInput): Partial<Task> => (
  pickDefinedTaskFields(TASK_CREATE_FIELD_NAMES, input)
);

const buildTaskUpdates = (input: UpdateTaskInput): Partial<Task> => {
  const updates: Partial<Task> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.status !== undefined) updates.status = parseInputStatus(input.status);
  if (input.projectId !== undefined) updates.projectId = input.projectId ?? undefined;
  if (input.sectionId !== undefined) updates.sectionId = input.sectionId ?? undefined;
  if (input.dueDate !== undefined) updates.dueDate = input.dueDate ?? undefined;
  if (input.startTime !== undefined) updates.startTime = input.startTime ?? undefined;
  if (input.recurrence !== undefined) {
    updates.recurrence = normalizeNullableTaskRecurrence(input.recurrence) ?? undefined;
  }
  if (input.contexts !== undefined) updates.contexts = normalizeNullableTaskTokens('contexts', input.contexts) ?? [];
  if (input.tags !== undefined) updates.tags = normalizeNullableTaskTokens('tags', input.tags) ?? [];
  if (input.description !== undefined) updates.description = input.description ?? undefined;
  if (input.priority !== undefined) updates.priority = input.priority ?? undefined;
  if (input.energyLevel !== undefined) updates.energyLevel = input.energyLevel ?? undefined;
  if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo ?? undefined;
  if (input.timeEstimate !== undefined) updates.timeEstimate = input.timeEstimate ?? undefined;
  // Every other patch-writable Task field (reviewAt, isFocusedToday, checklist, areaId,
  // order, boardOrder, focusOrder, ...) is derived from TASK_PATCH_FIELD_NAMES — see
  // task-write-fields.ts. Adding a synced field there needs no edit here.
  for (const name of TASK_PATCH_FIELD_NAMES) {
    const value = input[name as keyof UpdateTaskInput];
    if (value === undefined) continue;
    if (name === 'relativeStartOffset') {
      updates.relativeStartOffset = normalizeNullableTaskRelativeStartOffset(value as RelativeStartOffset | null) ?? undefined;
    } else if (name === 'timeSpentMinutes') {
      updates.timeSpentMinutes = normalizeNullableTaskTimeSpentMinutes(value as number | null) ?? undefined;
    } else if (name === 'repeatReminderMinutes') {
      updates.repeatReminderMinutes = normalizeNullableTaskRepeatReminderMinutes(value as number | null) ?? undefined;
    } else if (typeof value === 'boolean') {
      // Booleans (showFutureRecurrence/isFocusedToday/suppressMindwtrReminders) have no
      // "clear it" state distinct from false, so — unlike every other generated field —
      // they're never nullable on input (see task-field-schemas.ts) and pass through as-is.
      (updates as Record<string, unknown>)[name] = value;
    } else {
      (updates as Record<string, unknown>)[name] = value ?? undefined;
    }
  }
  return updates;
};

export type AddProjectInput = {
  title: string;
  color?: string;
  status?: CoreProject['status'];
  areaId?: string | null;
  isSequential?: boolean;
  isFocused?: boolean;
  dueDate?: string | null;
  startDate?: string | null;
  reviewAt?: string | null;
  supportNotes?: string | null;
  attachments?: LinkAttachmentInput[];
};

export type UpdateProjectInput = {
  id: string;
  title?: string;
  color?: string | null;
  status?: CoreProject['status'];
  areaId?: string | null;
  isSequential?: boolean;
  isFocused?: boolean;
  dueDate?: string | null;
  startDate?: string | null;
  reviewAt?: string | null;
  supportNotes?: string | null;
  attachments?: LinkAttachmentInput[] | null;
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

export type AddPersonInput = {
  name: string;
  note?: string | null;
  referenceLink?: string | null;
};

export type UpdatePersonInput = {
  id: string;
  name?: string;
  note?: string | null;
  referenceLink?: string | null;
};

export type RenamePersonInput = {
  id: string;
  name: string;
  updateTasks?: boolean;
};

export type AddSectionInput = {
  projectId: string;
  title: string;
  description?: string | null;
  order?: number;
  isCollapsed?: boolean;
};

export type UpdateSectionInput = {
  id: string;
  title?: string;
  description?: string | null;
  order?: number;
  isCollapsed?: boolean;
};

const validateProjectTitle = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new ValidationError('Project title is required');
  }
  if (trimmed.length > MAX_TASK_TITLE_LENGTH) {
    throw new ValidationError(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
  return trimmed;
};

const validateAreaName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ValidationError('Area name is required');
  }
  if (trimmed.length > MAX_AREA_NAME_LENGTH) {
    throw new ValidationError(`Area name too long (max ${MAX_AREA_NAME_LENGTH} characters)`);
  }
  return trimmed;
};

const validatePersonName = (name: string): string => {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    throw new ValidationError('Person name is required');
  }
  if (trimmed.length > MAX_AREA_NAME_LENGTH) {
    throw new ValidationError(`Person name too long (max ${MAX_AREA_NAME_LENGTH} characters)`);
  }
  return trimmed;
};

const validateSectionTitle = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new ValidationError('Section title is required');
  }
  if (trimmed.length > MAX_TASK_TITLE_LENGTH) {
    throw new ValidationError(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
  return trimmed;
};

export type MindwtrService = {
  /**
   * Both adapters (local SQLite in queries.ts, cloud REST in cloud-service.ts) must satisfy
   * the same sort/filter semantics — see `service-conformance.test.ts`, which runs one
   * fixture table against both. Stated rules:
   * - `sortBy: 'priority'` ranks by @mindwtr/core's `PRIORITY_RANK` (urgent > high > medium >
   *   low), never the raw text column. A task with no priority ranks as 0 (below 'low') in
   *   both directions.
   * - Equal sort keys break ties by `id` ascending, and that tie-break does not flip with
   *   `sortOrder` (a stable sort shouldn't reverse just because the primary key did).
   * - `limit`/`offset` clamp to 1..1000 / >=0 identically on both adapters.
   * - `search` runs @mindwtr/core's `filterTasksBySearch` operator language (status:/context:/
   *   due:<=7d/negation/quotes/free text) identically on both adapters.
   * - `view` (`available`/`deferred`/`blocked`) runs @mindwtr/core's `getTaskFocusEligibility`
   *   against the whole task/project set on both adapters, not a paginated slice.
   */
  listTasks: (input: ListTasksInput) => Promise<TaskRow[]>;
  listProjects: () => Promise<Project[]>;
  listSections: (input?: ListSectionsInput) => Promise<Section[]>;
  listAreas: () => Promise<Area[]>;
  listPeople: (input?: ListPeopleInput) => Promise<Person[]>;
  getTask: (input: GetTaskInput) => Promise<TaskRow>;
  getProject: (input: GetProjectInput) => Promise<Project>;
  getSection: (input: GetSectionInput) => Promise<Section>;
  getPerson: (input: GetPersonInput) => Promise<Person>;
  addTask: (input: AddTaskInput) => Promise<Task>;
  updateTask: (input: UpdateTaskInput) => Promise<Task>;
  completeTask: (id: string) => Promise<Task>;
  deleteTask: (id: string) => Promise<Task>;
  restoreTask: (id: string) => Promise<Task>;
  addProject: (input: AddProjectInput) => Promise<Project>;
  updateProject: (input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<Project>;
  addSection: (input: AddSectionInput) => Promise<Section>;
  updateSection: (input: UpdateSectionInput) => Promise<Section>;
  deleteSection: (id: string) => Promise<Section>;
  addArea: (input: AddAreaInput) => Promise<Area>;
  updateArea: (input: UpdateAreaInput) => Promise<Area>;
  deleteArea: (id: string) => Promise<Area>;
  addPerson: (input: AddPersonInput) => Promise<Person>;
  updatePerson: (input: UpdatePersonInput) => Promise<Person>;
  renamePerson: (input: RenamePersonInput) => Promise<Person>;
  deletePerson: (id: string) => Promise<Person>;
  close: () => Promise<void>;
};

export const createService = (options: DbOptions, deps: ServiceDeps = defaultServiceDeps): MindwtrService => {
  const { withDb, close } = createDbAccessor(options, deps);
  return {
    listTasks: async (input) => withDb((db) => deps.listTasks(db, input)),
    listProjects: async () => withDb((db) => deps.listProjects(db)),
    listSections: async (input = {}) => withDb((db) => deps.listSections(db, input)),
    listAreas: async () => withDb((db) => deps.listAreas(db)),
    listPeople: async (input = {}) => withDb((db) => deps.listPeople(db, input)),
    getTask: async (input) => withDb((db) => deps.getTask(db, input)),
    getProject: async (input) => withDb((db) => deps.getProject(db, input)),
    getSection: async (input) => withDb((db) => deps.getSection(db, input)),
    getPerson: async (input) => withDb((db) => deps.getPerson(db, input)),
    addTask: async (input) => {
      const normalizedInput = validateAddTaskInput(input);
      const recurrence = normalizeOptionalTaskRecurrence(normalizedInput.recurrence);
      return await runCoreWriteWithRetries(options, deps, async (core) => {
        if (normalizedInput.quickAdd) {
          const snapshot = await core.getQuickAddSnapshot();
          const { projects, areas, tasks, people, settings } = snapshot;
          const quick = deps.parseQuickAdd(
            normalizedInput.quickAdd,
            projects as CoreProject[],
            undefined,
            areas as CoreArea[],
            buildQuickAddParseOptions(settings, { tasks, people }),
          );
          let createdTask: Task | undefined;
          const capture = await executeCaptureTransaction({
            parsed: {
              ...quick,
              title: normalizedInput.title ?? quick.title,
            },
            rawInput: normalizedInput.quickAdd,
            projects,
            extraProps: filterUndefined({
              status: parseInputStatus(normalizedInput.status),
              projectId: normalizedInput.projectId,
              sectionId: normalizedInput.sectionId,
              dueDate: normalizedInput.dueDate,
              startTime: normalizedInput.startTime,
              recurrence,
              contexts: normalizedInput.contexts,
              tags: normalizedInput.tags,
              description: normalizedInput.description,
              priority: normalizedInput.priority,
              energyLevel: normalizedInput.energyLevel,
              assignedTo: normalizedInput.assignedTo,
              timeEstimate: normalizedInput.timeEstimate,
              attachments: buildLinkAttachments(normalizedInput.attachments),
              ...generatedCreateTaskProps(normalizedInput),
            }),
          }, {
            addProject: (title, color, initialProps) => core.addProject({
              title,
              color,
              props: initialProps,
            }),
            addTask: async (title, initialProps) => {
              createdTask = await core.addTask({ title, props: initialProps });
              return { success: true, id: createdTask.id };
            },
          });
          if (!capture.success) {
            if (capture.reason === 'invalid-date-command') {
              throw new ValidationError(`Invalid date command: ${capture.invalidDateCommands.join(', ')}`);
            }
            throw new Error('error' in capture ? capture.error : `Capture failed: ${capture.reason}`);
          }
          if (!createdTask) throw new Error('Capture completed without creating a task');
          return createdTask;
        }
        const status = parseInputStatus(normalizedInput.status);
        return core.addTask({
          title: normalizedInput.title ?? '',
          props: filterUndefined({
            status,
            projectId: normalizedInput.projectId,
            sectionId: normalizedInput.sectionId,
            dueDate: normalizedInput.dueDate,
            startTime: normalizedInput.startTime,
            recurrence,
            contexts: normalizedInput.contexts,
            tags: normalizedInput.tags,
            description: normalizedInput.description,
            priority: normalizedInput.priority,
            energyLevel: normalizedInput.energyLevel,
            assignedTo: normalizedInput.assignedTo,
            timeEstimate: normalizedInput.timeEstimate,
            attachments: buildLinkAttachments(normalizedInput.attachments),
            ...generatedCreateTaskProps(normalizedInput),
          }),
        });
      });
    },
    updateTask: async (input) => {
      const updates = buildTaskUpdates(input);
      if (input.attachments !== undefined) {
        // Read the SQLite row, not the store's visible list: it carries tombstoned
        // attachment records, which the written list must keep (see link-attachments.ts).
        const existing = await withDb((db) => deps.getTask(db, { id: input.id }));
        updates.attachments = applyLinkAttachments(existing.attachments, input.attachments);
      }
      return runCoreWriteWithRetries(options, deps, async (core) => {
        return core.updateTask({ id: input.id, updates });
      });
    },
    completeTask: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.completeTask(id)),
    deleteTask: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.deleteTask(id)),
    restoreTask: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.restoreTask(id)),
    addProject: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
        const title = validateProjectTitle(input.title);
        return core.addProject({
          title,
          color: input.color ?? DEFAULT_PROJECT_COLOR,
          props: filterUndefined({
            status: parseProjectStatus(input.status),
            areaId: input.areaId ?? undefined,
            isSequential: input.isSequential,
            isFocused: input.isFocused,
            dueDate: input.dueDate ?? undefined,
            startDate: input.startDate ?? undefined,
            reviewAt: input.reviewAt ?? undefined,
            supportNotes: input.supportNotes ?? undefined,
            attachments: buildLinkAttachments(input.attachments),
          }) as Partial<CoreProject>,
        });
      }),
    updateProject: async (input) => {
      const attachments = input.attachments === undefined
        ? undefined
        // Same reason as updateTask: the row keeps tombstoned attachment records.
        : applyLinkAttachments(
          (await withDb((db) => deps.getProject(db, { id: input.id }))).attachments,
          input.attachments,
        );
      return runCoreWriteWithRetries(options, deps, async (core) => {
        const updates: Partial<CoreProject> = {};
        if (attachments !== undefined) updates.attachments = attachments;
        if (input.title !== undefined) updates.title = validateProjectTitle(input.title);
        if (input.color !== undefined) updates.color = input.color ?? undefined;
        if (input.status !== undefined) updates.status = parseProjectStatus(input.status);
        if (input.areaId !== undefined) updates.areaId = input.areaId ?? undefined;
        if (input.isSequential !== undefined) updates.isSequential = input.isSequential;
        if (input.isFocused !== undefined) updates.isFocused = input.isFocused;
        if (input.dueDate !== undefined) updates.dueDate = input.dueDate ?? undefined;
        if (input.startDate !== undefined) updates.startDate = input.startDate ?? undefined;
        if (input.reviewAt !== undefined) updates.reviewAt = input.reviewAt ?? undefined;
        if (input.supportNotes !== undefined) updates.supportNotes = input.supportNotes ?? undefined;
        return core.updateProject({ id: input.id, updates });
      });
    },
    deleteProject: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.deleteProject(id)),
    addSection: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
        const projectId = input.projectId.trim();
        if (!projectId) throw new ValidationError('Section projectId is required');
        const title = validateSectionTitle(input.title);
        const props: Partial<CoreSection> = {};
        if (input.description !== undefined) props.description = input.description ?? undefined;
        if (input.order !== undefined) props.order = input.order;
        if (input.isCollapsed !== undefined) props.isCollapsed = input.isCollapsed;
        return core.addSection({ projectId, title, props });
      }),
    updateSection: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
        const updates: Partial<CoreSection> = {};
        if (input.title !== undefined) updates.title = validateSectionTitle(input.title);
        if (input.description !== undefined) updates.description = input.description ?? undefined;
        if (input.order !== undefined) updates.order = input.order;
        if (input.isCollapsed !== undefined) updates.isCollapsed = input.isCollapsed;
        return core.updateSection({ id: input.id, updates });
      }),
    deleteSection: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.deleteSection(id)),
    addArea: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
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
      runCoreWriteWithRetries(options, deps, async (core) => {
        const updates: Partial<CoreArea> = {};
        if (input.name !== undefined) updates.name = validateAreaName(input.name);
        if (input.color !== undefined) updates.color = input.color ?? undefined;
        if (input.icon !== undefined) updates.icon = input.icon ?? undefined;
        return core.updateArea({ id: input.id, updates });
      }),
    deleteArea: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.deleteArea(id)),
    addPerson: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
        const name = validatePersonName(input.name);
        const props: Partial<CorePerson> = {};
        if (input.note !== undefined) props.note = input.note ?? undefined;
        if (input.referenceLink !== undefined) props.referenceLink = input.referenceLink ?? undefined;
        return core.addPerson({
          name,
          props,
        });
      }),
    updatePerson: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
        const updates: Partial<CorePerson> = {};
        if (input.name !== undefined) updates.name = validatePersonName(input.name);
        if (input.note !== undefined) updates.note = input.note ?? undefined;
        if (input.referenceLink !== undefined) updates.referenceLink = input.referenceLink ?? undefined;
        return core.updatePerson({ id: input.id, updates });
      }),
    renamePerson: async (input) =>
      runCoreWriteWithRetries(options, deps, async (core) => {
        return core.renamePerson({
          id: input.id,
          name: validatePersonName(input.name),
          updateTasks: input.updateTasks,
        });
      }),
    deletePerson: async (id) => runCoreWriteWithRetries(options, deps, (core) => core.deletePerson(id)),
    // `close` above only closes the read-path db accessor (createDbAccessor/openMindwtrDb);
    // writes go through core-adapter's separate module-level write client, which needs its
    // own close call too (BUG-15) or its WAL checkpoint never runs at shutdown.
    close: async () => {
      await close();
      await deps.closeCoreAdapter();
    },
  };
};
