/**
 * Utility functions for task operations
 */

import { Task, TaskStatus, TaskSortBy, TaskPriority, Project, AppData, SortField } from './types';
import { differenceInCalendarDays, startOfDay } from 'date-fns';
import { hasTimeComponent, isDueForReview, safeParseDate, safeParseDueDate } from './date';
import { hasRecurrenceRule } from './recurrence';
import { timeEstimateToMinutes } from './calendar-scheduling';
import { isTaskActionable, TASK_STATUS_ORDER } from './task-status';
import { isTaskInActiveProject } from './project-utils';
import type { Language } from './i18n/i18n-types';

/**
 * Shared collator for the tie-break comparisons below. `localeCompare` resolves
 * its locale and collation options on every call, and these run on a large
 * fraction of the comparisons in an n-log-n sort over the whole task list. One
 * instance with default options sorts identically and is reused everywhere.
 * Deliberately no `numeric`/`sensitivity` options — those change user-visible
 * ordering and are a separate decision.
 */
const textCollator = new Intl.Collator();

/**
 * Shared collators for the comparator sites that pass an options bag. V8 caches only the
 * argless `localeCompare()`, so `localeCompare(b, undefined, opts)` builds a fresh collator
 * per comparison — measurable in the per-mutation derived-state pass.
 *
 * `new Intl.Collator(undefined, opts).compare(a, b)` is equivalent to
 * `a.localeCompare(b, undefined, opts)`, so swapping a site preserves its order exactly.
 *
 * The two are NOT interchangeable: `numeric` makes "item 10" sort after "item 9". Sites that
 * asked for it are user-visible orderings and must keep it.
 */
export const baseTextCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
export const numericTextCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildTasksByProjectId(tasks: readonly Task[]): Map<string, Task[]> {
    const tasksByProjectId = new Map<string, Task[]>();

    tasks.forEach((task) => {
        if (!task.projectId || task.deletedAt) return;

        const projectTasks = tasksByProjectId.get(task.projectId);
        if (projectTasks) {
            projectTasks.push(task);
        } else {
            tasksByProjectId.set(task.projectId, [task]);
        }
    });

    return tasksByProjectId;
}

/**
 * Status sorting order for task list display
 */
/**
 * Standard task colors for each status.
 * Used for badges, borders, and highlights across the app.
 * Owned by theme-scheme.ts (the single "what colors does this theme use" module);
 * re-exported here for compatibility with existing callers.
 */
export { STATUS_COLORS, getStatusColor } from './theme-scheme';

const TASK_PRIORITY_SORT_RANK: Record<TaskPriority, number> = {
    low: 1,
    medium: 2,
    high: 3,
    urgent: 4,
};

/**
 * Canonical priority ordering (higher = more urgent). `priority` is a TEXT column/field
 * everywhere it's persisted, so anything that needs to rank it — SQL `ORDER BY`, JS
 * `.sort()` — must go through this map rather than comparing the string directly
 * (lexicographic order puts 'high' after 'medium' and 'urgent', which is wrong).
 * Shared by the MCP server's local SQLite and cloud REST adapters so they can't drift.
 */
export const PRIORITY_RANK: Record<TaskPriority, number> = TASK_PRIORITY_SORT_RANK;

const TASK_ENERGY_SORT_RANK: Record<NonNullable<Task['energyLevel']>, number> = {
    low: 1,
    medium: 2,
    high: 3,
};

const timeEstimateSortRank = (estimate: Task['timeEstimate']): number => {
    if (!estimate) return Number.POSITIVE_INFINITY;
    if (estimate === '4hr+') return 241;
    return timeEstimateToMinutes(estimate);
};

export const FOCUS_NEXT_DUE_SOON_WINDOW_DAYS = 30;

type TaskStartVisibilityOptions = {
    now?: Date;
    showFutureStarts?: boolean;
    /**
     * 'day' (default): a start today is visible all day — right for planning
     * surfaces like Daily Review, which must offer tonight's tasks in the
     * morning (#867). 'time': a start with an explicit clock time later today
     * stays hidden until that moment — the actionable-now list surfaces
     * (Focus, Next) opt in (#995).
     */
    granularity?: 'day' | 'time';
};

type FocusSequentialOptions = {
    now?: Date;
    sectionScopedProjectIds?: ReadonlySet<string>;
};

export type TaskFocusEligibilityReason = 'eligible' | 'deferred' | 'sequential' | 'clarify';

export type TaskFocusEligibilityResult = {
    eligible: boolean;
    reason: TaskFocusEligibilityReason;
};

export type TaskFocusEligibilityOptions = {
    tasks: readonly Task[];
    projects: readonly Project[] | Map<string, Project>;
    now?: Date;
    sequentialProjectIds?: ReadonlySet<string>;
    sectionScopedProjectIds?: ReadonlySet<string>;
    /** Precomputed by buildTaskFocusEligibilityContext; derived per call when absent. */
    sequentialFirstTaskIds?: ReadonlySet<string>;
};

type SequentialTaskOrderFields = Pick<Task, 'createdAt' | 'order' | 'orderNum'>;
type SequentialGroupingFields = Pick<Task, 'projectId'> & Partial<Pick<Task, 'sectionId'>>;

type SequentialFirstTaskOptions = {
    sectionScopedProjectIds?: ReadonlySet<string>;
};

const NO_SECTION_GROUP = '__no_section__';
export const FOCUS_ELIGIBILITY_ACTIVE_STATUSES: readonly TaskStatus[] = ['inbox', 'next', 'waiting', 'someday'];
const FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET = new Set<TaskStatus>(FOCUS_ELIGIBILITY_ACTIVE_STATUSES);

const safeTime = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const safeDueTime = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = safeParseDueDate(value);
    return parsed ? parsed.getTime() : fallback;
};

const shouldIncrementPushCount = (oldDueDate?: string, newDueDate?: string): boolean => {
    if (!oldDueDate || !newDueDate) return false;
    const oldTime = Date.parse(oldDueDate);
    const newTime = Date.parse(newDueDate);
    if (!Number.isFinite(oldTime) || !Number.isFinite(newTime)) return false;
    return newTime > oldTime;
};

const WAITING_FOR_LINE_REGEX = /^\s*waiting\s+for\s*[:：]\s*(.+?)\s*$/i;

type SortFocusNextActionsOptions = {
    now?: Date;
    dueSoonWindowDays?: number;
    prioritizeByPriority?: boolean;
    projectDeadlineBoosts?: ReadonlyMap<string, ProjectDeadlineBoost>;
    projects?: readonly Project[];
};

type SortTasksBySavedPreferenceOptions = {
    projects?: readonly Project[];
    prioritizeByPriority?: boolean;
    sortOrder?: 'asc' | 'desc';
};

function getFocusNextActionBucket(
    task: Pick<Task, 'dueDate'>,
    nowMs: number,
    dueSoonWindowMs: number,
): number {
    const dueMs = safeDueTime(task.dueDate, Number.NaN);
    if (!Number.isFinite(dueMs)) return 1;
    if (dueMs <= nowMs + dueSoonWindowMs) return 0;
    return 2;
}

export type ProjectDeadlineBoost = {
    projectDueDate: string;
    projectDueTime: number;
    projectId: string;
    projectOrder: number;
    projectTitle: string;
    isOverdue: boolean;
};

type ProjectDeadlineBoostProjectInfo = ProjectDeadlineBoost;

const getProjectOrder = (project: Pick<Project, 'order'>): number => (
    Number.isFinite(project.order) ? project.order : Number.POSITIVE_INFINITY
);

const getTaskOrder = (task: Pick<Task, 'order' | 'orderNum'>): number => (
    Number.isFinite(task.order)
        ? task.order as number
        : Number.isFinite(task.orderNum)
            ? task.orderNum as number
            : Number.POSITIVE_INFINITY
);

const compareProjectDeadlineBoostTasks = (
    a: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
    b: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
): number => {
    const orderA = getTaskOrder(a);
    const orderB = getTaskOrder(b);
    if (orderA !== orderB) return orderA - orderB;

    const createdDiff = safeTime(a.createdAt, Number.POSITIVE_INFINITY) - safeTime(b.createdAt, Number.POSITIVE_INFINITY);
    if (createdDiff !== 0) return createdDiff;

    const titleDiff = textCollator.compare(a.title, b.title);
    if (titleDiff !== 0) return titleDiff;

    return textCollator.compare(a.id, b.id);
};

const compareProjectDeadlineBoosts = (
    boostA: ProjectDeadlineBoost | undefined,
    boostB: ProjectDeadlineBoost | undefined,
    taskA: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
    taskB: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
): number => {
    if (boostA && !boostB) return -1;
    if (!boostA && boostB) return 1;
    if (!boostA || !boostB) return 0;

    if (boostA.projectDueTime !== boostB.projectDueTime) {
        return boostA.projectDueTime - boostB.projectDueTime;
    }
    if (boostA.projectOrder !== boostB.projectOrder) {
        return boostA.projectOrder - boostB.projectOrder;
    }

    const projectTitleDiff = textCollator.compare(boostA.projectTitle, boostB.projectTitle);
    if (projectTitleDiff !== 0) return projectTitleDiff;

    return compareProjectDeadlineBoostTasks(taskA, taskB);
};

export function getProjectDeadlineBoosts(
    tasks: readonly Task[],
    projects: readonly Project[],
    options: { now?: Date } = {},
): Map<string, ProjectDeadlineBoost> {
    const now = options.now ?? new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const projectInfoById = new Map<string, ProjectDeadlineBoostProjectInfo>();

    projects.forEach((project) => {
        if (project.deletedAt) return;
        if (project.status !== 'active' && project.isFocused !== true) return;
        const projectDue = safeParseDueDate(project.dueDate);
        if (!projectDue) return;
        const projectDueTime = projectDue.getTime();
        if (projectDueTime > endOfToday.getTime()) return;
        projectInfoById.set(project.id, {
            projectDueDate: project.dueDate as string,
            projectDueTime,
            projectId: project.id,
            projectOrder: getProjectOrder(project),
            projectTitle: project.title,
            isOverdue: projectDueTime < startOfToday.getTime(),
        });
    });

    if (projectInfoById.size === 0) return new Map();

    const selectedTaskByProjectId = new Map<string, Task>();
    tasks.forEach((task) => {
        if (task.status !== 'next') return;
        if (task.deletedAt) return;
        if (!task.projectId) return;
        if (task.dueDate || task.startTime) return;
        if (!projectInfoById.has(task.projectId)) return;

        const selectedTask = selectedTaskByProjectId.get(task.projectId);
        if (!selectedTask || compareProjectDeadlineBoostTasks(task, selectedTask) < 0) {
            selectedTaskByProjectId.set(task.projectId, task);
        }
    });

    const boosts = new Map<string, ProjectDeadlineBoost>();
    selectedTaskByProjectId.forEach((task, projectId) => {
        const info = projectInfoById.get(projectId);
        if (!info) return;
        boosts.set(task.id, info);
    });
    return boosts;
}

// Orders tasks the way a project lists them: manual order first (tasks without
// one sort last), creation time as the tie-break, task id as the final one.
// This is the order project views render, so anything surfacing "the project's
// next action" must use it too or it will contradict what the user arranged
// (#873). The id tie-break is load-bearing (#784): imported duplicates can
// carry the SAME order and createdAt, and a comparator that returns 0 leaves
// stable sort at the mercy of array order — which every sync merge rebuild
// reshuffles, so tied rows visibly swapped positions after each sync and made
// drags around them look like they reverted.
export function compareTasksByProjectOrder<T extends SequentialTaskOrderFields & Pick<Task, 'id'>>(a: T, b: T): number {
    const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.isFinite(a.orderNum) ? (a.orderNum as number) : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.isFinite(b.orderNum) ? (b.orderNum as number) : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aCreated = safeParseDate(a.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY;
    const bCreated = safeParseDate(b.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Ranks projects the way the sidebar and project-grouped views arrange them:
// manual order first (projects without one sort last), title as the tie-break.
export function compareProjectsByOrder(
    a: Pick<Project, 'order' | 'title'>,
    b: Pick<Project, 'order' | 'title'>,
): number {
    const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return textCollator.compare(a.title, b.title);
}

// Builds the projectId -> rank map that project-grouped views sort tasks by.
// Deleted projects are dropped; the survivors are ranked by compareProjectsByOrder.
export function buildProjectOrderMap(
    projects: readonly (Pick<Project, 'id' | 'order' | 'title'> & Partial<Pick<Project, 'deletedAt'>>)[],
): Map<string, number> {
    const map = new Map<string, number>();
    [...projects]
        .filter((project) => !project.deletedAt)
        .sort(compareProjectsByOrder)
        .forEach((project, index) => map.set(project.id, index));
    return map;
}

// Orders tasks first by their project's rank in the given order map (tasks with
// no project, or in a project missing from the map, sort last), then by
// compareTasksByProjectOrder within a project. This is the combined default
// order the Next and Board views render.
export function compareTasksByProjectThenOrder(
    orderMap: ReadonlyMap<string, number>,
): <T extends SequentialTaskOrderFields & Pick<Task, 'id' | 'projectId'>>(a: T, b: T) => number {
    return (a, b) => {
        const aProjectOrder = a.projectId ? (orderMap.get(a.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        const bProjectOrder = b.projectId ? (orderMap.get(b.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        if (aProjectOrder !== bProjectOrder) return aProjectOrder - bProjectOrder;
        return compareTasksByProjectOrder(a, b);
    };
}

function getSequentialTaskOrderKey<T extends SequentialTaskOrderFields>(task: T, hasOrder: boolean): number {
    const taskOrder = Number.isFinite(task.order)
        ? (task.order as number)
        : Number.isFinite(task.orderNum)
            ? (task.orderNum as number)
            : Number.POSITIVE_INFINITY;
    return hasOrder
        ? taskOrder
        : (safeParseDate(task.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY);
}

function getSequentialTaskGroupKey<T extends SequentialGroupingFields>(
    task: T,
    sectionScopedProjectIds?: ReadonlySet<string>,
): string | null {
    if (!task.projectId) return null;
    if (sectionScopedProjectIds?.has(task.projectId)) {
        return `${task.projectId}:${task.sectionId || NO_SECTION_GROUP}`;
    }
    return task.projectId;
}

export function rescheduleTask(task: Task, newDueDate?: string): Task {
    const next: Task = { ...task, dueDate: newDueDate };
    if (shouldIncrementPushCount(task.dueDate, newDueDate)) {
        next.pushCount = (task.pushCount ?? 0) + 1;
    } else if (typeof task.pushCount === 'number') {
        next.pushCount = task.pushCount;
    }
    return next;
}

export function extractWaitingPerson(description?: string): string | null {
    if (!description) return null;
    const lines = description.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(WAITING_FOR_LINE_REGEX);
        if (!match) continue;
        const person = match[1]?.trim();
        if (person) return person;
    }
    return null;
}

export function getWaitingPerson(task: Pick<Task, 'assignedTo' | 'description'>): string | null {
    const assignedTo = task.assignedTo?.trim();
    if (assignedTo) return assignedTo;
    return extractWaitingPerson(task.description);
}

function earliestDate(a: Date | null, b: Date | null): Date | null {
    if (!a) return b;
    if (!b) return a;
    return a <= b ? a : b;
}

export function getTaskDeferUntil(
    task: Pick<Task, 'startTime'> & Partial<Pick<Task, 'dueDate' | 'recurrence' | 'reviewAt'>>,
): Date | null {
    const start = safeParseDate(task.startTime);
    // A recurring task without a start date defers on its next remaining
    // schedule field (the earlier of due/review); otherwise the next instance
    // spawned on completion reappears in Next/Focus immediately,
    // indistinguishable from the instance just completed (#843).
    return start ?? (hasRecurrenceRule(task.recurrence)
        ? earliestDate(safeParseDate(task.dueDate), safeParseDate(task.reviewAt))
        : null);
}

export function isTaskFutureStart(
    task: Pick<Task, 'startTime'> & Partial<Pick<Task, 'dueDate' | 'recurrence' | 'reviewAt'>>,
    now: Date = new Date(),
): boolean {
    const deferUntil = getTaskDeferUntil(task);
    if (!deferUntil) return false;

    const endOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999,
    );
    return deferUntil > endOfToday;
}

export type UpcomingDeferredTask = {
    task: Task;
    /** The defer-until date the task will surface on. */
    appearsAt: Date;
};

export const UPCOMING_DEFERRED_WINDOW_DAYS = 7;

/**
 * The Focus "Upcoming" preview (#1061): next-status tasks the start/recurrence
 * deferral currently hides but which surface within the window, sorted by the
 * date they will appear. Derives the date via getTaskDeferUntil — the same
 * derivation isTaskFutureStart uses — so the preview cannot disagree with the
 * actual reveal. Includes tasks that start later *today*, which are hidden
 * until their time arrives and so belong here rather than nowhere.
 */
export function getUpcomingDeferredTasks(
    tasks: readonly Task[],
    options: { now?: Date; windowDays?: number } = {},
): UpcomingDeferredTask[] {
    const now = options.now ?? new Date();
    const windowDays = options.windowDays ?? UPCOMING_DEFERRED_WINDOW_DAYS;
    const windowEnd = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + windowDays,
        23,
        59,
        59,
        999,
    );
    const upcoming: UpcomingDeferredTask[] = [];
    for (const task of tasks) {
        if (task.status !== 'next') continue;
        const deferUntil = getTaskDeferUntil(task);
        if (!deferUntil || deferUntil > windowEnd) continue;
        // Membership is exactly "hidden right now", asked of the same predicate
        // Focus filters Next Actions with. The bound used to be "later than
        // today", which left a start *time* later today in neither section — it
        // is hidden from Next Actions by time granularity and was too early for
        // Upcoming — so it could not be seen, and therefore could not be starred
        // for today either. Asking the predicate instead of comparing dates also
        // keeps a recurring task due later today out: that one is already
        // visible, so it must not be listed twice.
        if (shouldShowTaskForStart(task, { now, granularity: 'time' })) continue;
        upcoming.push({ task, appearsAt: deferUntil });
    }
    return upcoming.sort((a, b) => (
        (a.appearsAt.getTime() - b.appearsAt.getTime())
        || a.task.title.localeCompare(b.task.title)
    ));
}

export function shouldShowTaskForStart(
    task: Pick<Task, 'startTime'> & Partial<Pick<Task, 'dueDate' | 'recurrence' | 'reviewAt'>>,
    options: TaskStartVisibilityOptions = {},
): boolean {
    if (options.showFutureStarts === true) return true;
    const now = options.now ?? new Date();
    if (isTaskFutureStart(task, now)) return false;
    if (options.granularity !== 'time') return true;
    // A date-only start stays visible all day. The unstar-on-defer rule
    // (store-helpers) deliberately keeps day granularity via
    // isTaskFutureStart, so a Today star set on a task that starts later
    // today survives to resurface when the task does.
    const start = safeParseDate(task.startTime);
    return !(start && start > now && hasTimeComponent(task.startTime));
}

/**
 * The earliest upcoming timed start today among the given tasks, as an epoch
 * timestamp — the moment a view filtering with shouldShowTaskForStart next
 * needs to re-render to reveal a task (#995). Starts beyond today are the
 * day-key tick's job.
 */
export function getNextFutureStartRevealAt(
    tasks: ReadonlyArray<Pick<Task, 'startTime'>>,
    now: Date = new Date(),
): number | null {
    const nowMs = now.getTime();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    let next: number | null = null;
    for (const task of tasks) {
        if (!hasTimeComponent(task.startTime)) continue;
        const start = safeParseDate(task.startTime)?.getTime();
        if (start === undefined || start <= nowMs || start > endOfToday) continue;
        if (next === null || start < next) next = start;
    }
    return next;
}

/**
 * Statuses that occupy a slot in a sequential project's chain. `next` is the
 * actionable step; `waiting` is a committed step blocked on someone else, so
 * it holds its place and keeps later steps out of Focus/Next until it clears
 * — deferring by person blocks the chain exactly like deferring by date
 * already does. Inbox (unclarified) and someday (uncommitted) deliberately do
 * NOT hold a slot: they are not steps of the sequence yet.
 */
export function isSequentialChainStatus(status: TaskStatus | undefined): boolean {
    return status === 'next' || status === 'waiting';
}

export function getSequentialFirstTaskIds<T extends Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'projectId'> & Partial<Pick<Task, 'sectionId'>>>(
    tasks: T[],
    sequentialProjectIds: ReadonlySet<string>,
    options: SequentialFirstTaskOptions = {},
): Set<string> {
    const tasksByGroup = new Map<string, T[]>();
    for (const task of tasks) {
        const groupKey = getSequentialTaskGroupKey(task, options.sectionScopedProjectIds);
        if (!groupKey || !task.projectId) continue;
        if (!sequentialProjectIds.has(task.projectId)) continue;
        const list = tasksByGroup.get(groupKey) ?? [];
        list.push(task);
        tasksByGroup.set(groupKey, list);
    }

    const firstTaskIds = new Set<string>();
    tasksByGroup.forEach((tasksForProject) => {
        const hasOrder = tasksForProject.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
        let firstTaskId: string | null = null;
        let bestKey = Number.POSITIVE_INFINITY;

        tasksForProject.forEach((task) => {
            const key = getSequentialTaskOrderKey(task, hasOrder);
            if (!firstTaskId || key < bestKey) {
                firstTaskId = task.id;
                bestKey = key;
            }
        });

        if (firstTaskId) firstTaskIds.add(firstTaskId);
    });

    return firstTaskIds;
}

export function isFocusSequentialCandidate(
    task: Pick<Task, 'isFocusedToday' | 'reviewAt' | 'status'>,
    options: FocusSequentialOptions = {},
): boolean {
    if (task.isFocusedToday === true) return true;
    if (isSequentialChainStatus(task.status)) return true;
    return isDueForReview(task.reviewAt, options.now);
}

function getFocusSequentialScheduleKey(
    task: Pick<Task, 'dueDate' | 'isFocusedToday' | 'reviewAt' | 'status'>,
    now: Date,
): { rank: number; time: number } {
    if (task.isFocusedToday === true) {
        return { rank: 0, time: 0 };
    }

    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const endOfTodayMs = endOfToday.getTime();
    const dueMs = safeDueTime(task.dueDate, Number.NaN);
    const reviewMs = safeParseDate(task.reviewAt)?.getTime() ?? Number.NaN;
    let scheduledTime = Number.POSITIVE_INFINITY;

    // A due date or due review earns the project's one Focus slot; a start
    // date deliberately does not — a later task becoming available today only
    // gates that task, it must not displace an earlier task in the sequence
    // (#1015: the displaced winner can even be hidden by its own start time,
    // leaving the whole project missing from Focus). A waiting task's due
    // date earns nothing either: it is not actionable, and letting it outrank
    // an earlier actionable step would hide real work. Waiting tasks hold
    // their slot by order alone (review-due keeps its rank — those surface in
    // Focus's review section regardless of status).
    if (Number.isFinite(dueMs) && dueMs <= endOfTodayMs && task.status !== 'waiting') {
        scheduledTime = Math.min(scheduledTime, dueMs);
    }
    if (isDueForReview(task.reviewAt, now) && Number.isFinite(reviewMs)) {
        scheduledTime = Math.min(scheduledTime, reviewMs);
    }

    return Number.isFinite(scheduledTime)
        ? { rank: 1, time: scheduledTime }
        : { rank: 2, time: Number.POSITIVE_INFINITY };
}

export function getFocusSequentialFirstTaskIds<
    T extends Pick<Task, 'createdAt' | 'dueDate' | 'id' | 'isFocusedToday' | 'order' | 'orderNum' | 'projectId' | 'reviewAt' | 'status'> & Partial<Pick<Task, 'sectionId'>>
>(
    tasks: T[],
    sequentialProjectIds: ReadonlySet<string>,
    options: FocusSequentialOptions = {},
): Set<string> {
    const now = options.now ?? new Date();
    const tasksByGroup = new Map<string, T[]>();
    for (const task of tasks) {
        const groupKey = getSequentialTaskGroupKey(task, options.sectionScopedProjectIds);
        if (!groupKey || !task.projectId) continue;
        if (!sequentialProjectIds.has(task.projectId)) continue;
        if (!isFocusSequentialCandidate(task, { now })) continue;
        const list = tasksByGroup.get(groupKey) ?? [];
        list.push(task);
        tasksByGroup.set(groupKey, list);
    }

    const firstTaskIds = new Set<string>();
    tasksByGroup.forEach((tasksForProject) => {
        const hasOrder = tasksForProject.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
        let firstTaskId: string | null = null;
        let bestScheduleRank = Number.POSITIVE_INFINITY;
        let bestScheduleTime = Number.POSITIVE_INFINITY;
        let bestOrderKey = Number.POSITIVE_INFINITY;

        tasksForProject.forEach((task) => {
            const scheduleKey = getFocusSequentialScheduleKey(task, now);
            const orderKey = getSequentialTaskOrderKey(task, hasOrder);
            const isBetter = !firstTaskId
                || scheduleKey.rank < bestScheduleRank
                || (
                    scheduleKey.rank === bestScheduleRank
                    && (
                        scheduleKey.time < bestScheduleTime
                        || (
                            scheduleKey.time === bestScheduleTime
                            && orderKey < bestOrderKey
                        )
                    )
                );

            if (isBetter) {
                firstTaskId = task.id;
                bestScheduleRank = scheduleKey.rank;
                bestScheduleTime = scheduleKey.time;
                bestOrderKey = orderKey;
            }
        });

        if (firstTaskId) firstTaskIds.add(firstTaskId);
    });

    return firstTaskIds;
}

const getFocusEligibilityProjectMap = (
    projects: readonly Project[] | Map<string, Project>,
): Map<string, Project> => {
    if (Array.isArray(projects)) {
        return new Map(projects.map((project) => [project.id, project]));
    }
    return projects as Map<string, Project>;
};

export const getFocusEligibilitySequentialProjectIds = (
    projectMap: ReadonlyMap<string, Project>,
): { sequentialProjectIds: Set<string>; sectionScopedProjectIds: Set<string> } => {
    const sequentialProjectIds = new Set<string>();
    const sectionScopedProjectIds = new Set<string>();
    projectMap.forEach((project) => {
        if (!project.isSequential) return;
        sequentialProjectIds.add(project.id);
        if (project.sequentialScope === 'section') {
            sectionScopedProjectIds.add(project.id);
        }
    });
    return { sequentialProjectIds, sectionScopedProjectIds };
};

/**
 * Everything getTaskFocusEligibility derives from the whole task set, computed once. Pass the
 * result as options when classifying more than one task against the same library.
 */
export function buildTaskFocusEligibilityContext(options: {
    tasks: readonly Task[];
    projects: readonly Project[] | Map<string, Project>;
    now?: Date;
}): Required<Pick<TaskFocusEligibilityOptions,
    'projects' | 'sequentialProjectIds' | 'sectionScopedProjectIds' | 'sequentialFirstTaskIds'>> {
    const now = options.now ?? new Date();
    const projectMap = getFocusEligibilityProjectMap(options.projects);
    const { sequentialProjectIds, sectionScopedProjectIds } = getFocusEligibilitySequentialProjectIds(projectMap);
    return {
        projects: projectMap,
        sequentialProjectIds,
        sectionScopedProjectIds,
        sequentialFirstTaskIds: getFocusSequentialFirstTaskIds(
            options.tasks.filter((candidate) => (
                !candidate.deletedAt
                && FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET.has(candidate.status)
                && isTaskInActiveProject(candidate, projectMap)
            )),
            sequentialProjectIds,
            { now, sectionScopedProjectIds },
        ),
    };
}

export function getTaskFocusEligibility(
    task: Task,
    options: TaskFocusEligibilityOptions,
): TaskFocusEligibilityResult {
    const now = options.now ?? new Date();
    const projectMap = getFocusEligibilityProjectMap(options.projects);
    const derivedSequential = options.sequentialProjectIds && options.sectionScopedProjectIds
        ? null
        : getFocusEligibilitySequentialProjectIds(projectMap);
    const sequentialProjectIds = options.sequentialProjectIds ?? derivedSequential?.sequentialProjectIds ?? new Set<string>();
    const sectionScopedProjectIds = options.sectionScopedProjectIds
        ?? derivedSequential?.sectionScopedProjectIds
        ?? new Set<string>();
    // Scanning every task to find each sequential chain's head is O(all) — fine for one call,
    // quadratic when a caller filters a whole library. Callers that ask repeatedly should pass
    // buildTaskFocusEligibilityContext's result instead.
    const sequentialFirstTaskIds = options.sequentialFirstTaskIds
        ?? getFocusSequentialFirstTaskIds(
            options.tasks.filter((candidate) => (
                !candidate.deletedAt
                && FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET.has(candidate.status)
                && isTaskInActiveProject(candidate, projectMap)
            )),
            sequentialProjectIds,
            { now, sectionScopedProjectIds },
        );
    const isSequentialBlocked = Boolean(
        task.projectId
        && sequentialProjectIds.has(task.projectId)
        && !sequentialFirstTaskIds.has(task.id),
    );
    const isVisibleForStart = shouldShowTaskForStart(task, { now });
    const isVisibleActiveTask = isTaskInActiveProject(task, projectMap) && isVisibleForStart;
    const isReviewDueEligible = task.status !== 'inbox' && isDueForReview(task.reviewAt, now);
    const eligible = isVisibleActiveTask
        && !isSequentialBlocked
        && (task.status === 'next' || isReviewDueEligible);

    if (eligible) {
        return { eligible: true, reason: 'eligible' };
    }
    if (!isVisibleForStart) {
        return { eligible: false, reason: 'deferred' };
    }
    if (isSequentialBlocked) {
        return { eligible: false, reason: 'sequential' };
    }
    return { eligible: false, reason: 'clarify' };
}

/**
 * Sorts on keys read once per task instead of once per comparison. These
 * comparators parse date strings, and at a few thousand tasks the O(n log n)
 * parses — not the sort — were the cost (#766). The comparison itself is
 * unchanged, and `sort` stays stable, so the resulting order is identical.
 */
function sortByPrecomputedKey<T, K>(
    tasks: readonly T[],
    toKey: (task: T) => K,
    compare: (a: K, b: K) => number
): T[] {
    const decorated = tasks.map((task) => ({ task, key: toKey(task) }));
    decorated.sort((a, b) => compare(a.key, b.key));
    return decorated.map((entry) => entry.task);
}

/**
 * Sort tasks by status, due date, and creation time.
 * Order: inbox → next → waiting → someday → reference → done → archived
 * Within same status: tasks with due dates first (sorted by date), then by creation time (FIFO)
 */
export function sortTasks(tasks: Task[]): Task[] {
    return sortByPrecomputedKey(
        tasks,
        (task) => ({
            status: TASK_STATUS_ORDER[task.status] ?? 99,
            due: safeDueTime(task.dueDate, Number.NaN),
            created: safeTime(task.createdAt, 0),
        }),
        (a, b) => {
            // 1. Sort by Status
            if (a.status !== b.status) {
                return a.status - b.status;
            }

            // 2. Sort by Due Date (tasks with valid due dates first)
            const hasDueA = Number.isFinite(a.due);
            const hasDueB = Number.isFinite(b.due);
            if (hasDueA && !hasDueB) return -1;
            if (!hasDueA && hasDueB) return 1;
            if (hasDueA && hasDueB && a.due !== b.due) return a.due - b.due;

            // 3. Created At (oldest first for FIFO)
            return a.created - b.created;
        }
    );
}

function compareDeletedAtDesc(
    left: { id: string; deletedAt?: string },
    right: { id: string; deletedAt?: string }
): number {
    const leftDeletedAt = safeTime(left.deletedAt, Number.NEGATIVE_INFINITY);
    const rightDeletedAt = safeTime(right.deletedAt, Number.NEGATIVE_INFINITY);
    if (leftDeletedAt !== rightDeletedAt) {
        return rightDeletedAt > leftDeletedAt ? 1 : -1;
    }
    return textCollator.compare(left.id, right.id);
}

export type TrashTimelineItem =
    | { type: 'project'; project: Project }
    | { type: 'task'; task: Task };

const getTrashTimelineEntity = (item: TrashTimelineItem): Project | Task => (
    item.type === 'project' ? item.project : item.task
);

export function buildTrashTimeline(
    tasks: readonly Task[],
    projects: readonly Project[]
): TrashTimelineItem[] {
    const items: TrashTimelineItem[] = [
        ...projects
            .filter((project) => project.deletedAt && !project.purgedAt)
            .map((project) => ({ type: 'project' as const, project })),
        ...tasks
            .filter((task) => task.deletedAt && !task.purgedAt)
            .map((task) => ({ type: 'task' as const, task })),
    ];
    return items.sort((left, right) => compareDeletedAtDesc(
        getTrashTimelineEntity(left),
        getTrashTimelineEntity(right)
    ));
}

/**
 * Sort tasks by a user-selected sort option.
 * Falls back to default sortTasks when sortBy is 'default' or undefined.
 */
export function sortTasksBy(tasks: Task[], sortBy: TaskSortBy = 'default'): Task[] {
    if (!sortBy || sortBy === 'default') {
        return sortTasks(tasks);
    }

    const timeOrInfinity = (value?: string) => safeTime(value, Infinity);
    const dueOrInfinity = (value?: string) => safeDueTime(value, Infinity);
    const timeOrZero = (value?: string) => safeTime(value, 0);
    const byDateThenCreated = (read: (task: Task) => number) => sortByPrecomputedKey(
        tasks,
        (task) => ({ date: read(task), created: timeOrZero(task.createdAt) }),
        (a, b) => (a.date !== b.date ? a.date - b.date : a.created - b.created)
    );

    switch (sortBy) {
        case 'title':
            return sortByPrecomputedKey(
                tasks,
                (task) => ({ title: task.title, created: safeTime(task.createdAt, 0) }),
                (a, b) => {
                    const cmp = textCollator.compare(a.title, b.title);
                    if (cmp !== 0) return cmp;
                    return a.created - b.created;
                }
            );
        case 'due':
            return byDateThenCreated((task) => dueOrInfinity(task.dueDate));
        case 'start':
            return byDateThenCreated((task) => timeOrInfinity(task.startTime));
        case 'review':
            return byDateThenCreated((task) => timeOrInfinity(task.reviewAt));
        case 'created':
            return sortByPrecomputedKey(tasks, (task) => timeOrZero(task.createdAt), (a, b) => a - b);
        case 'created-desc':
            return sortByPrecomputedKey(tasks, (task) => timeOrZero(task.createdAt), (a, b) => b - a);
        case 'completed':
            // Deliberately keyed on completedAt alone, unlike the Done list's
            // default order (sortDoneTasksForListView), which falls back to
            // updatedAt/createdAt so every done task gets a position. Archive
            // holds archived-but-never-completed tasks, and those belong at the
            // end rather than sorted in by when they were last touched (#945).
            return sortByPrecomputedKey(
                tasks,
                (task) => ({ completed: safeTime(task.completedAt, -Infinity), title: task.title }),
                (a, b) => {
                    if (a.completed !== b.completed) return b.completed - a.completed;
                    return textCollator.compare(a.title, b.title);
                }
            );
        default:
            return sortTasks(tasks);
    }
}

/**
 * Stable sort for Board columns: tasks with a manual boardOrder come first
 * in ascending order; tasks without one keep their incoming relative order.
 */
export function sortTasksByBoardOrder<T extends Pick<Task, 'boardOrder'>>(tasks: T[]): T[] {
    return [...tasks].sort((a, b) => {
        const aOrder = Number.isFinite(a.boardOrder) ? (a.boardOrder as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.boardOrder) ? (b.boardOrder as number) : Number.POSITIVE_INFINITY;
        if (aOrder === bOrder) return 0;
        return aOrder - bOrder;
    });
}

/**
 * Stable sort for Today's Focus: tasks with a manual focusOrder come first
 * in ascending order; tasks without one keep their incoming relative order.
 */
export function sortTasksByFocusOrder<T extends Pick<Task, 'focusOrder'>>(tasks: T[]): T[] {
    return [...tasks].sort((a, b) => {
        const aOrder = Number.isFinite(a.focusOrder) ? (a.focusOrder as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.focusOrder) ? (b.focusOrder as number) : Number.POSITIVE_INFINITY;
        if (aOrder === bOrder) return 0;
        return aOrder - bOrder;
    });
}

export function splitCompletedTasks<T extends Pick<Task, 'status'>>(tasks: T[]): {
    activeTasks: T[];
    completedTasks: T[];
} {
    const activeTasks: T[] = [];
    const completedTasks: T[] = [];

    tasks.forEach((task) => {
        if (task.status === 'done') {
            completedTasks.push(task);
        } else {
            activeTasks.push(task);
        }
    });

    return { activeTasks, completedTasks };
}

function getCompletionListTime(task: Pick<Task, 'completedAt' | 'updatedAt' | 'createdAt'>): number {
    const completedAt = safeParseDate(task.completedAt)?.getTime();
    if (Number.isFinite(completedAt)) return completedAt as number;
    const updatedAt = safeParseDate(task.updatedAt)?.getTime();
    if (Number.isFinite(updatedAt)) return updatedAt as number;
    return safeParseDate(task.createdAt)?.getTime() ?? 0;
}

export function sortDoneTasksForListView<T extends Pick<Task, 'completedAt' | 'updatedAt' | 'createdAt' | 'title'>>(tasks: T[]): T[] {
    return sortByPrecomputedKey(
        tasks,
        (task) => ({ completion: getCompletionListTime(task), title: task.title }),
        (a, b) => {
            const completionDiff = b.completion - a.completion;
            if (completionDiff !== 0) return completionDiff;
            return textCollator.compare(a.title, b.title);
        }
    );
}

export function groupCompletedTasksLast<T extends Pick<Task, 'status'>>(tasks: T[]): T[] {
    const { activeTasks, completedTasks } = splitCompletedTasks(tasks);
    return [...activeTasks, ...completedTasks];
}

export function sortTasksBySavedPreference<T extends Task>(
    tasks: T[],
    sortBy: SortField | undefined,
    options: SortTasksBySavedPreferenceOptions = {},
): T[] {
    if (!sortBy || sortBy === 'default') {
        return [...tasks];
    }

    const projectOrder = new Map<string, number>();
    const projectTitle = new Map<string, string>();
    [...(options.projects ?? [])]
        .filter((project) => !project.deletedAt)
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return textCollator.compare(a.title, b.title);
        })
        .forEach((project, index) => {
            projectOrder.set(project.id, index);
            projectTitle.set(project.id, project.title);
        });

    const direction = options.sortOrder === 'desc' ? -1 : 1;
    const compare = (a: T, b: T): number => {
        const byCreatedAsc = () => safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
        const byCreatedDesc = () => safeTime(b.createdAt, 0) - safeTime(a.createdAt, 0);
        const byTitle = () => textCollator.compare(a.title, b.title);
        const byId = () => textCollator.compare(a.id, b.id);
        const byDue = () => safeDueTime(a.dueDate, Number.POSITIVE_INFINITY) - safeDueTime(b.dueDate, Number.POSITIVE_INFINITY);
        const byStart = () => safeTime(a.startTime, Number.POSITIVE_INFINITY) - safeTime(b.startTime, Number.POSITIVE_INFINITY);
        const byReview = () => safeTime(a.reviewAt, Number.POSITIVE_INFINITY) - safeTime(b.reviewAt, Number.POSITIVE_INFINITY);
        const byUpdated = () => safeTime(b.updatedAt, 0) - safeTime(a.updatedAt, 0);
        const byPriority = () => (TASK_PRIORITY_SORT_RANK[b.priority as TaskPriority] || 0)
            - (TASK_PRIORITY_SORT_RANK[a.priority as TaskPriority] || 0);
        const byEnergy = () => (TASK_ENERGY_SORT_RANK[b.energyLevel as NonNullable<Task['energyLevel']>] || 0)
            - (TASK_ENERGY_SORT_RANK[a.energyLevel as NonNullable<Task['energyLevel']>] || 0);
        const byTimeEstimate = () => timeEstimateSortRank(a.timeEstimate) - timeEstimateSortRank(b.timeEstimate);
        const byProject = () => {
            const orderA = a.projectId ? (projectOrder.get(a.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            const orderB = b.projectId ? (projectOrder.get(b.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            if (orderA !== orderB) return orderA - orderB;
            const titleA = a.projectId ? (projectTitle.get(a.projectId) ?? '') : '';
            const titleB = b.projectId ? (projectTitle.get(b.projectId) ?? '') : '';
            return textCollator.compare(titleA, titleB);
        };
        const withFallbacks = (...comparers: Array<() => number>) => {
            for (const comparer of comparers) {
                const result = comparer();
                if (result !== 0) return result;
            }
            return byId();
        };

        switch (sortBy) {
            case 'due':
                return withFallbacks(byDue, byCreatedAsc);
            case 'start':
                return options.prioritizeByPriority
                    ? withFallbacks(byStart, byPriority, byCreatedAsc)
                    : withFallbacks(byStart, byCreatedAsc);
            case 'review':
                return withFallbacks(byReview, byCreatedAsc);
            case 'title':
                return withFallbacks(byTitle, byCreatedAsc);
            case 'created':
                return withFallbacks(byCreatedAsc);
            case 'created-desc':
                return withFallbacks(byCreatedDesc);
            case 'priority':
                return withFallbacks(byPriority, byDue, byStart, byCreatedAsc);
            case 'energy':
                return withFallbacks(byEnergy, byDue, byStart, byCreatedAsc);
            case 'timeEstimate':
                return withFallbacks(byTimeEstimate, byDue, byStart, byCreatedAsc);
            case 'project':
                return withFallbacks(byProject, byCreatedAsc);
            case 'updated':
                return withFallbacks(byUpdated, byCreatedAsc);
            default:
                return withFallbacks(byCreatedAsc);
        }
    };

    return [...tasks].sort((a, b) => direction * compare(a, b));
}

export function sortFocusNextActions(tasks: Task[], options: SortFocusNextActionsOptions = {}): Task[] {
    const nowMs = (options.now ?? new Date()).getTime();
    const dueSoonWindowDays = Number.isFinite(options.dueSoonWindowDays)
        ? Math.max(0, Math.floor(options.dueSoonWindowDays as number))
        : FOCUS_NEXT_DUE_SOON_WINDOW_DAYS;
    const dueSoonWindowMs = dueSoonWindowDays * 24 * 60 * 60 * 1000;
    const prioritizeByPriority = options.prioritizeByPriority === true;
    const projectDeadlineBoosts = options.projectDeadlineBoosts
        ?? (options.projects ? getProjectDeadlineBoosts(tasks, options.projects, { now: options.now }) : new Map());

    return [...tasks].sort((a, b) => {
        const bucketA = getFocusNextActionBucket(a, nowMs, dueSoonWindowMs);
        const bucketB = getFocusNextActionBucket(b, nowMs, dueSoonWindowMs);
        if (bucketA !== bucketB) return bucketA - bucketB;

        if (bucketA !== 1) {
            const dueA = safeDueTime(a.dueDate, Number.POSITIVE_INFINITY);
            const dueB = safeDueTime(b.dueDate, Number.POSITIVE_INFINITY);
            if (dueA !== dueB) return dueA - dueB;
        }

        if (bucketA === 1) {
            const projectBoostDiff = compareProjectDeadlineBoosts(
                projectDeadlineBoosts.get(a.id),
                projectDeadlineBoosts.get(b.id),
                a,
                b,
            );
            if (projectBoostDiff !== 0) return projectBoostDiff;
        }

        if (prioritizeByPriority) {
            const priorityDiff = (TASK_PRIORITY_SORT_RANK[b.priority as TaskPriority] || 0)
                - (TASK_PRIORITY_SORT_RANK[a.priority as TaskPriority] || 0);
            if (priorityDiff !== 0) return priorityDiff;
        }

        const startA = safeTime(a.startTime, Number.POSITIVE_INFINITY);
        const startB = safeTime(b.startTime, Number.POSITIVE_INFINITY);
        if (startA !== startB) return startA - startB;

        const createdDiff = safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
        if (createdDiff !== 0) return createdDiff;

        const titleDiff = textCollator.compare(a.title, b.title);
        if (titleDiff !== 0) return titleDiff;

        return textCollator.compare(a.id, b.id);
    });
}

export type CalendarPlanningCandidateOptions = {
    limit?: number;
    now?: Date;
    prioritizeByPriority?: boolean;
    projects?: readonly Project[] | Map<string, Project>;
    sectionScopedProjectIds?: ReadonlySet<string>;
    sequentialProjectIds?: ReadonlySet<string>;
};

export function getCalendarPlanningCandidates<T extends Task>(
    tasks: readonly T[],
    options: CalendarPlanningCandidateOptions = {},
): T[] {
    const now = options.now ?? new Date();
    const projectMap = options.projects ? getFocusEligibilityProjectMap(options.projects) : null;
    const derivedSequential = projectMap && (!options.sequentialProjectIds || !options.sectionScopedProjectIds)
        ? getFocusEligibilitySequentialProjectIds(projectMap)
        : null;
    const sequentialProjectIds = options.sequentialProjectIds
        ?? derivedSequential?.sequentialProjectIds
        ?? new Set<string>();
    const sectionScopedProjectIds = options.sectionScopedProjectIds
        ?? derivedSequential?.sectionScopedProjectIds
        ?? new Set<string>();

    const activeFocusTasks = tasks.filter((task) => (
        !task.deletedAt
        && FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET.has(task.status)
        && (!projectMap || isTaskInActiveProject(task, projectMap))
    ));
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(
        activeFocusTasks,
        sequentialProjectIds,
        { now, sectionScopedProjectIds },
    );

    const candidates = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (task.status !== 'next') return false;
        if (task.isFocusedToday) return false;
        if (task.startTime) return false;
        if (projectMap && !isTaskInActiveProject(task, projectMap)) return false;
        if (task.projectId && sequentialProjectIds.has(task.projectId) && !sequentialFirstTaskIds.has(task.id)) return false;
        return true;
    });

    const sortProjects = Array.isArray(options.projects) ? options.projects : undefined;
    const sorted = sortFocusNextActions(candidates as Task[], {
        now,
        prioritizeByPriority: options.prioritizeByPriority,
        projects: sortProjects,
    }) as T[];
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit as number)) : sorted.length;
    return sorted.slice(0, limit);
}

/**
 * Calculate the age of a task in days
 */
export function getTaskAgeDays(createdAt: string): number {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - created.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Get a human-readable age string for a task
 * Returns null for tasks < 1 day old (to avoid clutter)
 */
export function getTaskAgeLabel(createdAt: string, lang: Language = 'en'): string | null {
    const days = getTaskAgeDays(createdAt);
    const isChinese = lang === 'zh' || lang === 'zh-Hant';

    if (days < 1) return null;
    if (isChinese) {
        if (days === 1) return '1天前';
        if (days < 7) return `${days}天前`;
        if (days < 14) return '1周前';
        if (days < 30) return `${Math.floor(days / 7)}周前`;
        if (days < 60) return '1个月前';
        return `${Math.floor(days / 30)}个月前`;
    }

    if (days === 1) return '1 day old';
    if (days < 7) return `${days} days old`;
    if (days < 14) return '1 week old';
    if (days < 30) return `${Math.floor(days / 7)} weeks old`;
    if (days < 60) return '1 month old';
    return `${Math.floor(days / 30)} months old`;
}

/**
 * Get the staleness level of a task (for color coding)
 * Returns: 'fresh' | 'aging' | 'stale' | 'very-stale'
 */
export function getTaskStaleness(createdAt: string): 'fresh' | 'aging' | 'stale' | 'very-stale' {
    const days = getTaskAgeDays(createdAt);

    if (days < 7) return 'fresh';
    if (days < 14) return 'aging';
    if (days < 30) return 'stale';
    return 'very-stale';
}

/**
 * Get the urgency level of a task based on due date
 * Returns: 'overdue' | 'urgent' (24h) | 'upcoming' (72h) | 'normal' | 'done'
 */
export function getTaskUrgency(task: Partial<Task>): 'overdue' | 'urgent' | 'upcoming' | 'normal' | 'done' {
    if (!isTaskActionable(task)) return 'done';
    if (!task.dueDate) return 'normal';

    const now = new Date();
    const due = safeParseDueDate(task.dueDate);
    if (!due) return 'normal';
    const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (diffHours < 0) return 'overdue';
    if (diffHours < 24) return 'urgent';
    if (diffHours < 72) return 'upcoming';
    return 'normal';
}

export function getTaskAreaId(
    task: Pick<Task, 'areaId' | 'projectId'>,
    projectMap?: Map<string, Project> | Record<string, Project>,
): string | undefined {
    if (task.projectId && projectMap) {
        const project = projectMap instanceof Map ? projectMap.get(task.projectId) : projectMap[task.projectId];
        if (project?.areaId) return project.areaId;
    }
    return task.areaId;
}

/**
 * Get checklist progress for display.
 * Returns null if no checklist or checklist is empty.
 */
export function getChecklistProgress(task: Pick<Task, 'checklist'>): { completed: number; total: number; percent: number } | null {
    const list = task.checklist || [];
    if (list.length === 0) return null;
    const completed = list.filter((i) => i.isCompleted).length;
    const total = list.length;
    const percent = total === 0 ? 0 : completed / total;
    return { completed, total, percent };
}

export interface TaskLifecycleCounts {
    total: number;
    live: number;
    trashed: number;
    tombstones: number;
    createdLast7d: number;
}

/**
 * Content-free composition of a stored task array for diagnostic logs (#766):
 * how many tasks are live, sitting in Trash, or retained purely as sync
 * tombstones, plus recent creation volume so unexplained growth between two
 * shared logs can be attributed without another instrumentation round.
 */
export function summarizeTaskLifecycleCounts(
    tasks: readonly Pick<Task, 'deletedAt' | 'purgedAt' | 'createdAt'>[],
    nowMs: number = Date.now(),
): TaskLifecycleCounts {
    const weekAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    let live = 0;
    let trashed = 0;
    let tombstones = 0;
    let createdLast7d = 0;
    for (const task of tasks) {
        if (task.purgedAt) {
            tombstones += 1;
        } else if (task.deletedAt) {
            trashed += 1;
        } else {
            live += 1;
        }
        const createdAtMs = task.createdAt ? Date.parse(task.createdAt) : Number.NaN;
        if (Number.isFinite(createdAtMs) && createdAtMs >= weekAgoMs && createdAtMs <= nowMs) {
            createdLast7d += 1;
        }
    }
    return { total: tasks.length, live, trashed, tombstones, createdLast7d };
}

export const DEFAULT_AUTO_ARCHIVE_DAYS = 7;

export const getAutoArchiveDays = (settings: AppData['settings']): number => {
    const configured = settings.gtd?.autoArchiveDays;
    return Number.isFinite(configured)
        ? Math.max(0, Math.floor(configured as number))
        : DEFAULT_AUTO_ARCHIVE_DAYS;
};

/**
 * Whether one finished task is old enough to file itself away.
 *
 * Shared by the load-time sweep and the update path, because those run on
 * different clocks: the sweep is throttled to twice a day, so a completion time
 * edited to last year sat in Done until the next window and read as a bug
 * (#959). Keyed on completedAt, falling back to updatedAt for rows that predate
 * the field.
 */
export function shouldAutoArchiveCompletedTask(
    task: Pick<Task, 'status' | 'completedAt' | 'updatedAt' | 'deletedAt'>,
    settings: AppData['settings'],
    nowMs: number,
): boolean {
    if (task.deletedAt) return false;
    if (task.status !== 'done') return false;
    const archiveDays = getAutoArchiveDays(settings);
    if (archiveDays <= 0) return false;
    const completedAtMs = safeParseDate(task.completedAt)?.getTime() ?? Number.NaN;
    const updatedAtMs = safeParseDate(task.updatedAt)?.getTime() ?? Number.NaN;
    const resolvedMs = Number.isFinite(completedAtMs) ? completedAtMs : updatedAtMs;
    if (!Number.isFinite(resolvedMs) || resolvedMs <= 0) return false;
    return resolvedMs < nowMs - archiveDays * 24 * 60 * 60 * 1000;
}

/**
 * Buckets for grouping a completed list by when the work was finished (#945).
 * Ordered oldest-last, which is the order the groups are shown in.
 */
export const COMPLETION_DATE_GROUPS = ['today', 'yesterday', 'previous7Days', 'earlier', 'notCompleted'] as const;
export type CompletionDateGroup = typeof COMPLETION_DATE_GROUPS[number];

/**
 * Which bucket a task falls in, on local calendar-day boundaries rather than
 * rolling 24-hour windows — "yesterday" has to mean the previous calendar day
 * however close to midnight the task was finished.
 *
 * Keyed on completedAt alone, matching the 'completed' sort: a task with no
 * completion time is 'notCompleted' rather than being placed by when it last
 * changed. Archive holds archived-but-never-completed tasks; a done task can
 * also predate completedAt being recorded.
 */
export function getCompletionDateGroup(
    task: Pick<Task, 'completedAt'>,
    now: Date = new Date(),
): CompletionDateGroup {
    const completedAt = safeParseDate(task.completedAt);
    if (!completedAt) return 'notCompleted';
    const daysAgo = differenceInCalendarDays(startOfDay(now), startOfDay(completedAt));
    // A completion stamped later today than `now` (clock skew, or a sync from a
    // device running ahead) is still today's work, not the future.
    if (daysAgo <= 0) return 'today';
    if (daysAgo === 1) return 'yesterday';
    if (daysAgo <= 7) return 'previous7Days';
    return 'earlier';
}
