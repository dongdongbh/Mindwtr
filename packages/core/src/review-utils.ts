import { addDays, format } from 'date-fns';

import type { ReviewSnapshotItem } from './ai/types';
import type { ExternalCalendarEvent } from './ics';
import type { AppSettings, Area, Project, Task, TaskSortBy } from './types';
import { getWeekStartsOnIndex, hasTimeComponent, isDueForReview, safeParseDate, safeParseDueDate } from './date';
import { timeEstimateToMinutes } from './calendar-scheduling';
import {
    isTaskVisibleInArea,
    type AreaFilterSelection,
    type AreaVisibilityContext,
} from './area-filter';
import { isTaskInActiveProject } from './project-utils';
import { getSequentialFirstTaskIds, isSequentialChainStatus, shouldShowTaskForStart, sortTasksBy } from './task-utils';
import { isTaskActionable } from './task-status';
import { normalizeTimeSpentMinutes } from './time-spent';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_REVIEW_ADVANCE_DAYS = 7;

/**
 * Next review date after marking an item reviewed: `days` from now, preserving
 * the original value's date-only vs datetime shape (time-of-day carries over).
 */
export function getAdvancedReviewDate(
    reviewAt: string | undefined | null,
    now: Date = new Date(),
    days: number = DEFAULT_REVIEW_ADVANCE_DAYS,
): string {
    const target = addDays(now, days);
    if (reviewAt && hasTimeComponent(reviewAt)) {
        const parsed = safeParseDate(reviewAt);
        if (parsed) {
            const withTime = new Date(target);
            withTime.setHours(parsed.getHours(), parsed.getMinutes(), 0, 0);
            return format(withTime, "yyyy-MM-dd'T'HH:mm");
        }
    }
    return format(target, 'yyyy-MM-dd');
}

function isFutureDate(value: string | undefined | null, now: Date): boolean {
    if (!value) return false;
    const date = safeParseDate(value);
    return date ? date.getTime() > now.getTime() : false;
}

export type ReviewSchedulePartition<T> = {
    due: T[];
    scheduled: T[];
    unscheduled: T[];
};

/**
 * Splits reviewable items by review date: `due` (review date reached),
 * `scheduled` (explicitly deferred to a future review date), `unscheduled`
 * (no review date set).
 */
export function partitionByReviewDate<T extends { reviewAt?: string | null }>(
    items: T[],
    now: Date = new Date(),
): ReviewSchedulePartition<T> {
    const due: T[] = [];
    const scheduled: T[] = [];
    const unscheduled: T[] = [];
    items.forEach((item) => {
        if (isDueForReview(item.reviewAt, now)) {
            due.push(item);
        } else if (isFutureDate(item.reviewAt, now)) {
            scheduled.push(item);
        } else {
            unscheduled.push(item);
        }
    });
    return { due, scheduled, unscheduled };
}

export type WeeklyReviewSummary = {
    inboxCount: number;
    activeProjectCount: number;
    projectsWithoutNextAction: number;
    staleWaitingCount: number;
};

/** The review badge's answer to "can this project move?": a live `next` task
 * means yes; otherwise a live `waiting` task means it is delegated — blocked on
 * someone, not stuck (#1086, mirroring the sequential-chain rule where waiting
 * holds a slot); only a project with neither truly needs a next action. */
export type ProjectNextActionState = 'next' | 'waiting' | 'none';

export function getProjectNextActionState(
    tasks: ReadonlyArray<Pick<Task, 'status'>>,
): ProjectNextActionState {
    if (tasks.some((task) => task.status === 'next')) return 'next';
    if (tasks.some((task) => task.status === 'waiting')) return 'waiting';
    return 'none';
}

export type WeeklyReviewProjectEntry = {
    project: Project;
    tasks: Task[];
    nextActionState: ProjectNextActionState;
};

export type WeeklyReviewLookBack = {
    completedCount: number;
    projectsMovedCount: number;
    estimatedTaskCount: number;
    estimatedMinutes: number;
    trackedMinutes: number;
};

type WeeklyReviewDerivation = {
    inbox: Task[];
    projectEntries: WeeklyReviewProjectEntry[];
    staleItems: ReviewSnapshotItem[];
    summary: WeeklyReviewSummary;
    lookBack: WeeklyReviewLookBack;
};

function deriveWeeklyReview(
    tasks: Task[],
    projects: Project[],
    staleThresholdDays: number,
    now: Date,
    weekStart?: AppSettings['weekStart'],
): WeeklyReviewDerivation {
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const activeProjects = projects.filter((project) => project.status === 'active' && !project.deletedAt);
    const projectTasksById = new Map(activeProjects.map((project) => [project.id, [] as Task[]]));
    const inbox: Task[] = [];
    const staleItems: ReviewSnapshotItem[] = [];
    const lookBack: WeeklyReviewLookBack = {
        completedCount: 0,
        projectsMovedCount: 0,
        estimatedTaskCount: 0,
        estimatedMinutes: 0,
        trackedMinutes: 0,
    };
    const movedProjectIds = new Set<string>();
    const reviewWindowStart = getLocalReviewWindowStart(now, 'weekly', weekStart);
    const reviewWindowEnd = now.getTime();

    tasks.forEach((task) => {
        const completedAt = task.status === 'done' && !task.deletedAt
            ? safeParseDate(task.completedAt)
            : null;
        if (
            completedAt
            && completedAt.getTime() >= reviewWindowStart
            && completedAt.getTime() <= reviewWindowEnd
        ) {
            lookBack.completedCount += 1;
            const completedProject = task.projectId ? projectMap.get(task.projectId) : undefined;
            if (task.projectId && completedProject && !completedProject.deletedAt) {
                movedProjectIds.add(task.projectId);
            }
            if (task.timeEstimate) {
                lookBack.estimatedTaskCount += 1;
                lookBack.estimatedMinutes += timeEstimateToMinutes(task.timeEstimate);
                lookBack.trackedMinutes += normalizeTimeSpentMinutes(task.timeSpentMinutes) ?? 0;
            }
        }

        const belongsToActiveProject = isTaskInActiveProject(task, projectMap);
        if (!task.deletedAt && belongsToActiveProject && task.status === 'inbox') {
            inbox.push(task);
        }
        if (
            task.projectId
            && !task.deletedAt
            && task.status !== 'done'
            && task.status !== 'reference'
        ) {
            projectTasksById.get(task.projectId)?.push(task);
        }
        if (
            task.deletedAt
            || !belongsToActiveProject
            || (task.status !== 'next' && task.status !== 'waiting')
            || isFutureDate(task.reviewAt, now)
            || isFutureDate(task.startTime, now)
        ) return;
        const updated = new Date(task.updatedAt || task.createdAt);
        if (Number.isNaN(updated.getTime())) return;
        const daysStale = Math.ceil((now.getTime() - updated.getTime()) / DAY_MS);
        if (daysStale <= staleThresholdDays) return;
        staleItems.push({
            id: task.id,
            title: task.title,
            daysStale,
            status: task.status === 'waiting' ? 'waiting' : 'next',
            startTime: task.startTime,
            dueDate: task.dueDate,
            reviewAt: task.reviewAt,
        });
    });

    activeProjects.forEach((project) => {
        if (isFutureDate(project.reviewAt, now)) return;
        const updated = new Date(project.updatedAt || project.createdAt);
        if (Number.isNaN(updated.getTime())) return;
        const daysStale = Math.ceil((now.getTime() - updated.getTime()) / DAY_MS);
        if (daysStale <= staleThresholdDays) return;
        staleItems.push({
            id: `project:${project.id}`,
            title: project.title,
            daysStale,
            status: 'project',
            dueDate: project.dueDate,
            reviewAt: project.reviewAt,
        });
    });
    staleItems.sort((left, right) => right.daysStale - left.daysStale);

    const dueProjects = activeProjects.filter((project) => isDueForReview(project.reviewAt, now));
    const futureProjects = activeProjects.filter((project) => !isDueForReview(project.reviewAt, now));
    const projectEntries = [...dueProjects, ...futureProjects].map((project) => {
        const projectTasks = projectTasksById.get(project.id) ?? [];
        return {
            project,
            tasks: projectTasks,
            nextActionState: getProjectNextActionState(projectTasks),
        };
    });
    const summary: WeeklyReviewSummary = {
        inboxCount: inbox.length,
        activeProjectCount: projectEntries.length,
        // A waiting-only project is delegated, not stuck — it does not count as
        // "without next action" (#1086).
        projectsWithoutNextAction: projectEntries.filter((entry) => entry.nextActionState === 'none').length,
        staleWaitingCount: staleItems.filter((item) => item.status === 'waiting').length,
    };
    lookBack.projectsMovedCount = movedProjectIds.size;

    return { inbox, projectEntries, staleItems, summary, lookBack };
}

/**
 * Factual snapshot for the weekly review's completed step. Every count mirrors
 * the filter a review step itself uses, so the summary can never disagree with
 * what the user just saw:
 * - `inboxCount` matches the inbox step's `inboxTasks` filter.
 * - `projectsWithoutNextAction` matches the projects step's next-action predicate.
 * - `staleWaitingCount` shares the stale-items derivation, including its
 *   future-reviewAt/startTime exemption.
 */
export function getWeeklyReviewSummary(
    tasks: Task[],
    projects: Project[],
    now: Date = new Date(),
): WeeklyReviewSummary {
    return deriveWeeklyReview(tasks, projects, 14, now).summary;
}

export function getStaleItems(
    tasks: Task[],
    projects: Project[],
    staleThresholdDays = 14,
    now: Date = new Date(),
): ReviewSnapshotItem[] {
    return deriveWeeklyReview(tasks, projects, staleThresholdDays, now).staleItems;
}

// ---------------------------------------------------------------------------
// Daily Review / Weekly Review candidate + step derivation.
//
// Both platforms independently filtered the same task/project lists for the
// same review steps. Desktop's Daily Review additionally kept a pre-#867 raw
// `startTime > now` check instead of `shouldShowTaskForStart`, hiding a task
// starting later today all morning and ignoring recurrence deferral (#843).
// This is the single home for both rules (ADR 0021: "candidate logic stays a
// core predicate... no per-platform copies").
// ---------------------------------------------------------------------------

export type ReviewBucketOptions = {
    now?: Date;
    weekStart?: AppSettings['weekStart'];
    showFutureStarts?: boolean;
    sortBy?: TaskSortBy;
    /**
     * Opt-in area narrowing, read by `getDailyReviewBuckets` only —
     * `getWeeklyReviewBuckets` ignores it. Currently unused: no caller passes
     * it, so every review spans every area; see `getDailyReviewBuckets` for
     * why. Kept as the seam so scoping a review is a one-argument change at the
     * call site rather than a rewrite of the predicate.
     */
    areaVisibility?: Pick<AreaVisibilityContext, 'areaById' | 'resolvedAreaFilter'>;
};

function isSameLocalDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export type DailyReviewBuckets = {
    inbox: Task[];
    focused: Task[];
    waiting: Task[];
    dueToday: Task[];
    overdue: Task[];
    focusCandidates: Task[];
};

/**
 * Daily Review's per-step task lists. `done` is excluded once, at the base —
 * every bucket below is a further filter of that same active set.
 *
 * A review deliberately ignores the app-wide area filter and sweeps the whole
 * system. The point of the review is to find what you have not looked at, and
 * an area filter is a browsing device — a way to narrow what you are reading
 * right now — not a statement about which commitments still count. Honouring it
 * here would let an inbox item quietly sit unreviewed for as long as its area
 * stayed filtered out, which is the exact failure the review exists to prevent.
 * `opts.areaVisibility` is the seam if this is ever revisited; nothing passes it
 * today.
 */
export function getDailyReviewBuckets(
    tasks: Task[],
    projects: Project[],
    opts: ReviewBucketOptions = {},
): DailyReviewBuckets {
    const now = opts.now ?? new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const visibility: AreaVisibilityContext = {
        areaById: opts.areaVisibility?.areaById,
        projectById: projectMap,
        // No selection means no area filtering — see `areaVisibility` above.
        resolvedAreaFilter: opts.areaVisibility?.resolvedAreaFilter ?? { included: [], excluded: [] },
    };

    const activeTasks = tasks.filter((task) => (
        isTaskVisibleInArea(task, visibility)
        && task.status !== 'reference'
        && task.status !== 'done'
    ));

    const sequentialProjectIds = new Set(
        projects.filter((project) => project.isSequential && !project.deletedAt).map((project) => project.id),
    );
    // Waiting tasks hold their chain slot: a waiting first step keeps a
    // sequential project's later next tasks out of the review candidates too
    // ("later steps aren't actionable yet" applies while waiting on someone).
    const sequentialFirstTaskIds = getSequentialFirstTaskIds(
        activeTasks.filter((task) => isSequentialChainStatus(task.status)),
        sequentialProjectIds,
    );

    const inbox = activeTasks.filter((task) => task.status === 'inbox');
    const focused = activeTasks.filter((task) => task.isFocusedToday && shouldShowTaskForStart(task, opts));
    const waiting = sortTasksBy(activeTasks.filter((task) => task.status === 'waiting'), opts.sortBy);

    const dueToday = sortTasksBy(activeTasks.filter((task) => {
        const due = safeParseDueDate(task.dueDate);
        return due ? isSameLocalDay(due, now) : false;
    }), opts.sortBy);

    const overdue = sortTasksBy(activeTasks.filter((task) => {
        const due = safeParseDueDate(task.dueDate);
        return due ? due < startOfToday : false;
    }), opts.sortBy);

    const todayStr = now.toDateString();
    const candidatesById = new Map<string, Task>();
    const addCandidate = (task: Task) => {
        if (!candidatesById.has(task.id)) candidatesById.set(task.id, task);
    };
    activeTasks.forEach((task) => {
        if (task.isFocusedToday && shouldShowTaskForStart(task, opts)) addCandidate(task);
        const due = safeParseDueDate(task.dueDate);
        if (due && (due < now || due.toDateString() === todayStr)) {
            addCandidate(task);
            return;
        }
        if (task.status === 'next') {
            // Same deferral rule as Focus: a recurring chore carrying only a
            // due date is not reviewable until it starts (#843, #867).
            if (!shouldShowTaskForStart(task, opts)) return;
            // Sequential projects surface only their first remaining task;
            // later steps aren't actionable yet.
            if (task.projectId && sequentialProjectIds.has(task.projectId) && !sequentialFirstTaskIds.has(task.id)) {
                return;
            }
            addCandidate(task);
            return;
        }
        if ((task.status === 'waiting' || task.status === 'someday') && isDueForReview(task.reviewAt, now)) {
            addCandidate(task);
        }
    });
    const focusCandidates = sortTasksBy(Array.from(candidatesById.values()), opts.sortBy);

    return { inbox, focused, waiting, dueToday, overdue, focusCandidates };
}

export type CalendarReviewEntry = {
    task: Task;
    date: Date;
    kind: 'due' | 'start';
};

export type ContextReviewGroup = {
    context: string;
    tasks: Task[];
};

export type ExternalCalendarDaySummary = {
    dayStart: Date;
    events: ExternalCalendarEvent[];
    totalCount: number;
};

export type WeeklyReviewBuckets = {
    inbox: Task[];
    waitingGroups: ReviewSchedulePartition<Task>;
    somedayGroups: ReviewSchedulePartition<Task>;
    projectEntries: WeeklyReviewProjectEntry[];
    staleItems: ReviewSnapshotItem[];
    summary: WeeklyReviewSummary;
    lookBack: WeeklyReviewLookBack;
    contextGroups: ContextReviewGroup[];
    calendarItems: CalendarReviewEntry[];
};

/**
 * Weekly Review's complete per-step task/project model (ADR 0021's stale-item
 * and candidate surfaces), including the completion summary. Standalone stale
 * and summary helpers delegate to the same derivation for compatibility.
 */
export function getWeeklyReviewBuckets(
    tasks: Task[],
    projects: Project[],
    opts: ReviewBucketOptions = {},
): WeeklyReviewBuckets {
    const now = opts.now ?? new Date();
    const weekly = deriveWeeklyReview(tasks, projects, 14, now, opts.weekStart);
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const upcomingEnd = new Date(startOfToday);
    upcomingEnd.setDate(upcomingEnd.getDate() + 7);

    // Contexts and the upcoming-calendar list both want "still live, not yet
    // resolved" tasks: not deleted/done/archived/reference, in an active project.
    const isReviewable = (task: Task) => (
        !task.deletedAt
        && isTaskActionable(task)
        && isTaskInActiveProject(task, projectMap)
    );

    const inboxTasks = weekly.inbox;
    const waitingTasks = tasks.filter((task) => task.status === 'waiting' && !task.deletedAt && isTaskInActiveProject(task, projectMap));
    const somedayTasks = tasks.filter((task) => task.status === 'someday' && !task.deletedAt && isTaskInActiveProject(task, projectMap));
    const waitingGroups = partitionByReviewDate(waitingTasks, now);
    const somedayGroups = partitionByReviewDate(somedayTasks, now);

    const contextGroupsByName = new Map<string, Task[]>();
    tasks.forEach((task) => {
        if (!isReviewable(task)) return;
        (task.contexts ?? []).forEach((contextValue) => {
            const normalized = contextValue.trim();
            if (!normalized) return;
            const existing = contextGroupsByName.get(normalized) ?? [];
            existing.push(task);
            contextGroupsByName.set(normalized, existing);
        });
    });
    const contextGroups: ContextReviewGroup[] = Array.from(contextGroupsByName.entries())
        .map(([context, contextTasks]) => ({
            context,
            tasks: contextTasks.slice().sort((a, b) => a.title.localeCompare(b.title)),
        }))
        .sort((a, b) => (b.tasks.length - a.tasks.length) || a.context.localeCompare(b.context));

    const calendarEntries: CalendarReviewEntry[] = [];
    tasks.forEach((task) => {
        if (!isReviewable(task)) return;
        const dueDate = safeParseDueDate(task.dueDate);
        if (dueDate) calendarEntries.push({ task, date: dueDate, kind: 'due' });
        const startTime = safeParseDate(task.startTime);
        if (startTime) calendarEntries.push({ task, date: startTime, kind: 'start' });
    });
    const calendarItems = calendarEntries
        .filter((entry) => entry.date >= startOfToday && entry.date < upcomingEnd)
        .sort((a, b) => a.date.getTime() - b.date.getTime());

    return {
        inbox: inboxTasks,
        waitingGroups,
        somedayGroups,
        projectEntries: weekly.projectEntries,
        staleItems: weekly.staleItems,
        summary: weekly.summary,
        lookBack: weekly.lookBack,
        contextGroups,
        calendarItems,
    };
}

export type ReviewOverviewProjectGroup = {
    project?: Project;
    tasks: Task[];
    nextActionState: ProjectNextActionState;
};

export type ReviewOverviewAreaGroup = {
    areaId?: string;
    projectGroups: ReviewOverviewProjectGroup[];
    taskCount: number;
    projectCount: number;
    needsActionCount: number;
};

export type GetReviewOverviewGroupsParams = {
    tasks: Task[];
    projects: Project[];
    orderedAreas: Area[];
    areaFilter: AreaFilterSelection;
    sortBy: TaskSortBy;
};

/**
 * The Review overview's complete task hierarchy. Core owns visibility,
 * sorting, container resolution, ordering, and health counts; callers add
 * platform labels, colors, and rendering ids only.
 */
export function getReviewOverviewGroups({
    tasks,
    projects,
    orderedAreas,
    areaFilter,
    sortBy,
}: GetReviewOverviewGroupsParams): ReviewOverviewAreaGroup[] {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const areaById = new Map(orderedAreas.map((area) => [area.id, area]));
    const areaOrderById = new Map(orderedAreas.map((area, index) => [area.id, index]));
    const visibleTasks = sortTasksBy(
        tasks.filter((task) => (
            isTaskVisibleInArea(task, {
                areaById,
                projectById,
                resolvedAreaFilter: areaFilter,
            })
            && task.status !== 'done'
            && task.status !== 'reference'
        )),
        sortBy,
    );
    type MutableAreaGroup = {
        areaId?: string;
        firstSeen: number;
        projectGroups: Map<string, ReviewOverviewProjectGroup>;
        taskCount: number;
    };
    const areaGroups = new Map<string, MutableAreaGroup>();

    visibleTasks.forEach((task) => {
        const project = task.projectId ? projectById.get(task.projectId) : undefined;
        const areaId = project?.areaId || task.areaId;
        const areaKey = areaId ?? '';
        const areaGroup = areaGroups.get(areaKey) ?? {
            areaId,
            firstSeen: areaGroups.size,
            projectGroups: new Map<string, ReviewOverviewProjectGroup>(),
            taskCount: 0,
        };
        const projectKey = project?.id ?? '';
        const projectGroup = areaGroup.projectGroups.get(projectKey) ?? {
            project,
            tasks: [],
            nextActionState: 'none' as ProjectNextActionState,
        };
        projectGroup.tasks.push(task);
        projectGroup.nextActionState = getProjectNextActionState(projectGroup.tasks);
        areaGroup.projectGroups.set(projectKey, projectGroup);
        areaGroup.taskCount += 1;
        areaGroups.set(areaKey, areaGroup);
    });

    return Array.from(areaGroups.values())
        .sort((left, right) => {
            if (!left.areaId) return right.areaId ? -1 : left.firstSeen - right.firstSeen;
            if (!right.areaId) return 1;
            const leftOrder = areaOrderById.get(left.areaId) ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = areaOrderById.get(right.areaId) ?? Number.MAX_SAFE_INTEGER;
            return (leftOrder - rightOrder) || (left.firstSeen - right.firstSeen);
        })
        .map((areaGroup) => {
            const projectGroups = Array.from(areaGroup.projectGroups.values())
                .sort((left, right) => {
                    if (!left.project) return right.project ? 1 : 0;
                    if (!right.project) return -1;
                    return (left.project.order - right.project.order)
                        || left.project.title.localeCompare(right.project.title);
                });
            const projectCount = projectGroups.filter((group) => Boolean(group.project)).length;
            const needsActionCount = projectGroups.filter(
                (group) => Boolean(group.project) && group.nextActionState === 'none',
            ).length;
            return {
                areaId: areaGroup.areaId,
                projectGroups,
                taskCount: areaGroup.taskCount,
                projectCount,
                needsActionCount,
            };
        });
}

/**
 * The Weekly Review calendar step's external-calendar day summaries: a
 * 7-day window over the already-fetched events, non-empty days only.
 * Fetching stays a platform concern; this grouping does not.
 */
export function getExternalCalendarDaySummaries(
    events: ExternalCalendarEvent[],
    days: number = 7,
    now: Date = new Date(),
): ExternalCalendarDaySummary[] {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const summaries: ExternalCalendarDaySummary[] = [];
    for (let offset = 0; offset < days; offset += 1) {
        const dayStart = new Date(startOfToday);
        dayStart.setDate(dayStart.getDate() + offset);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const dayEvents = events
            .filter((event) => {
                const start = safeParseDate(event.start);
                const end = safeParseDate(event.end);
                if (!start || !end) return false;
                return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
            })
            .sort((a, b) => {
                const aStart = safeParseDate(a.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                const bStart = safeParseDate(b.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                return aStart - bStart;
            });
        if (dayEvents.length > 0) {
            summaries.push({ dayStart, events: dayEvents, totalCount: dayEvents.length });
        }
    }
    return summaries;
}

export type ReviewStepId =
    | 'today' | 'focus' | 'inbox' | 'waiting' | 'completed'
    | 'stale' | 'calendar' | 'contexts' | 'projects' | 'someday';

export type ReviewStepFlags = {
    id: ReviewStepId;
    hasWork: boolean;
};

export type ReviewStepSession<Step extends ReviewStepFlags> = {
    activeSteps: Step[];
    displayedStep: Step['id'];
    currentStepIndex: number;
    activeStepIndex: number;
    progress: number;
    nextStep: Step['id'] | null;
    previousStep: Step['id'] | null;
};

export type StoredReviewStepSession<Step extends ReviewStepId = ReviewStepId> = {
    step: Step;
    startedAt: string;
};

export type ReviewSessionCadence = 'daily' | 'weekly';

function getLocalReviewWindowStart(
    date: Date,
    cadence: ReviewSessionCadence,
    weekStart?: string | null,
): number {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (cadence === 'weekly') {
        const daysSinceWeekStart = (start.getDay() - getWeekStartsOnIndex(weekStart) + 7) % 7;
        start.setDate(start.getDate() - daysSinceWeekStart);
    }
    return start.getTime();
}

/**
 * Parses a device-local Review checkpoint and rejects malformed, future, or
 * expired values. Daily checkpoints share a local date; weekly checkpoints
 * share the local calendar week selected by the user's week-start setting.
 */
export function parseStoredReviewStepSession<Step extends ReviewStepId>(
    serialized: string | null | undefined,
    validSteps: ReadonlySet<Step>,
    options: {
        cadence: ReviewSessionCadence;
        now?: Date;
        weekStart?: string | null;
    },
): StoredReviewStepSession<Step> | null {
    if (!serialized) return null;
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.step !== 'string' || !validSteps.has(candidate.step as Step)) return null;
    if (typeof candidate.startedAt !== 'string') return null;

    const startedAt = new Date(candidate.startedAt);
    const now = options.now ?? new Date();
    if (!Number.isFinite(startedAt.getTime()) || startedAt.getTime() > now.getTime()) return null;
    if (getLocalReviewWindowStart(startedAt, options.cadence, options.weekStart)
        !== getLocalReviewWindowStart(now, options.cadence, options.weekStart)) {
        return null;
    }
    return { step: candidate.step as Step, startedAt: candidate.startedAt };
}

/** Resolves skipped steps, progress, and navigation for either review flow. */
export function resolveReviewStepSession<Step extends ReviewStepFlags>(
    steps: readonly Step[],
    requestedStep: Step['id'],
): ReviewStepSession<Step> {
    const activeSteps = steps.filter((step) => step.hasWork || step.id === 'completed');
    const displayedStep = activeSteps.some((step) => step.id === requestedStep)
        ? requestedStep
        : activeSteps[0]?.id ?? requestedStep;
    const currentStepIndex = Math.max(0, steps.findIndex((step) => step.id === displayedStep));
    const activeStepIndex = activeSteps.findIndex((step) => step.id === displayedStep);

    return {
        activeSteps,
        displayedStep,
        currentStepIndex,
        activeStepIndex,
        progress: (currentStepIndex / Math.max(1, steps.length - 1)) * 100,
        nextStep: activeStepIndex >= 0 && activeStepIndex < activeSteps.length - 1
            ? activeSteps[activeStepIndex + 1].id
            : null,
        previousStep: activeStepIndex > 0 ? activeSteps[activeStepIndex - 1].id : null,
    };
}

export type DailyReviewStepsOptions = {
    kind: 'daily';
    includeFocusStep?: boolean;
    todayCalendarEventCount?: number;
    tomorrowCalendarEventCount?: number;
    externalCalendarHasError?: boolean;
};

export type WeeklyReviewStepsOptions = {
    kind: 'weekly';
    includeContextStep?: boolean;
    externalCalendarDayCount?: number;
    externalCalendarHasError?: boolean;
};

/**
 * Canonical step order + "does this step have anything to show" for Daily or
 * Weekly Review. Titles, descriptions, icons and `t()` stay in the modals —
 * those are platform/i18n concerns, not part of the review rule.
 */
export function buildReviewSteps(
    buckets: DailyReviewBuckets,
    opts: DailyReviewStepsOptions,
): ReviewStepFlags[];
export function buildReviewSteps(
    buckets: WeeklyReviewBuckets,
    opts: WeeklyReviewStepsOptions,
): ReviewStepFlags[];
export function buildReviewSteps(
    buckets: DailyReviewBuckets | WeeklyReviewBuckets,
    opts: DailyReviewStepsOptions | WeeklyReviewStepsOptions,
): ReviewStepFlags[] {
    if (opts.kind === 'daily') {
        const b = buckets as DailyReviewBuckets;
        const todayHasWork = b.overdue.length > 0
            || b.dueToday.length > 0
            || (opts.todayCalendarEventCount ?? 0) > 0
            || (opts.tomorrowCalendarEventCount ?? 0) > 0
            || Boolean(opts.externalCalendarHasError);
        const steps: ReviewStepFlags[] = [
            { id: 'today', hasWork: todayHasWork },
            { id: 'inbox', hasWork: b.inbox.length > 0 },
            // Waiting For comes before focus selection: items unblocked today
            // can be switched to Next here and picked up in the focus step.
            { id: 'waiting', hasWork: b.waiting.length > 0 },
        ];
        if (opts.includeFocusStep !== false) {
            steps.push({ id: 'focus', hasWork: b.focusCandidates.length > 0 });
        }
        steps.push({ id: 'completed', hasWork: true });
        return steps;
    }

    const b = buckets as WeeklyReviewBuckets;
    const calendarHasWork = b.calendarItems.length > 0
        || (opts.externalCalendarDayCount ?? 0) > 0
        || Boolean(opts.externalCalendarHasError);
    // "Not due yet" (scheduled) items don't count as work: nothing to act on today.
    const waitingHasWork = b.waitingGroups.due.length + b.waitingGroups.unscheduled.length > 0;
    const somedayHasWork = b.somedayGroups.due.length + b.somedayGroups.unscheduled.length > 0;
    const steps: ReviewStepFlags[] = [
        { id: 'inbox', hasWork: b.inbox.length > 0 },
        { id: 'stale', hasWork: b.staleItems.length > 0 },
        { id: 'calendar', hasWork: calendarHasWork },
        { id: 'waiting', hasWork: waitingHasWork },
    ];
    if (opts.includeContextStep !== false) {
        steps.push({ id: 'contexts', hasWork: b.contextGroups.length > 0 });
    }
    steps.push(
        { id: 'projects', hasWork: b.projectEntries.length > 0 },
        { id: 'someday', hasWork: somedayHasWork },
        { id: 'completed', hasWork: true },
    );
    return steps;
}
