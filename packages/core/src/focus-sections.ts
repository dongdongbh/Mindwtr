/**
 * The ONE derivation of which task lands in which Focus section — Today's
 * Focus, Today (schedule), Review Due, Next actions, Upcoming — shared by the
 * desktop Focus screen (`AgendaView.tsx`), the mobile Focus screen
 * (`app/(drawer)/(tabs)/focus.tsx`), the mobile widget payload
 * (`widget-payload.ts`), the Shortcuts snapshot and the macOS widget
 * (`focus-widget-selection.ts`). Three hand copies used to disagree about the
 * equal-time tiebreak; they no longer can.
 *
 * Two steps, so a caller can own its pools without owning the buckets:
 * `buildFocusPools` narrows the store's tasks the way Focus narrows them, and
 * `deriveFocusTaskLists` buckets and sorts what came out. Both are pure and
 * take `now` as a parameter, never `Date.now()`, so one render sees one
 * instant and tests are deterministic.
 */
import { isDueForReview, safeParseDate, safeParseDueDate } from './date';
import { applyFilter } from './saved-filters';
import { isTaskCountedAsFocused } from './store-helpers';
import {
    getFocusSequentialFirstTaskIds,
    getTaskSequencing,
    isTaskSequenceBlocked,
    getProjectDeadlineBoosts,
    getUpcomingDeferredTasks,
    isTaskFocusedNow,
    PRIORITY_RANK,
    shouldShowTaskForStart,
    sortByPrecomputedKey,
    sortFocusNextActions,
    sortTasksByFocusOrder,
    sortTasksBySavedPreference,
    type ProjectDeadlineBoost,
    type UpcomingDeferredTask,
} from './task-utils';
import type { FilterCriteria, Project, Section, SortField, Task, TaskPriority } from './types';

export const DEFAULT_FOCUS_SORT_BY: SortField = 'default';

/** The calendar day `now` falls in, as the half-open pair every Today rule reads. */
export function getTodayBounds(now: Date): { startOfToday: Date; endOfToday: Date } {
    return {
        startOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
        endOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
    };
}

/**
 * "Due today or (when enabled) starting today" — the ONE answer to what belongs in Today, read
 * by the Today bucket below and by the widget selection's starred rule. A change
 * to what counts as today is an edit to this function and nothing else.
 *
 * `bounds` is the same pair `getTodayBounds(now)` returns; a caller testing many
 * tasks against one `now` passes it so the two `Date` objects are built once for
 * the loop instead of once per task. Leaving it out is exactly as before.
 */
export function isTodayScheduleCandidate(
    task: Task,
    now: Date,
    bounds: { startOfToday: Date; endOfToday: Date } = getTodayBounds(now),
    includeStartDates = true,
): boolean {
    const startOfTodayMs = bounds.startOfToday.getTime();
    const endOfTodayMs = bounds.endOfToday.getTime();
    const due = safeParseDueDate(task.dueDate)?.getTime();
    const start = includeStartDates ? safeParseDate(task.startTime)?.getTime() : undefined;
    const startsToday = start !== undefined && start >= startOfTodayMs && start <= endOfTodayMs;
    return (due !== undefined && due <= endOfTodayMs) || startsToday;
}

/**
 * The narrowed task pools every Focus section is cut from. Kept apart from the
 * buckets because each platform reaches its store differently, and because the
 * widget builders hand over pools they narrowed themselves.
 */
export interface FocusPools {
    /**
     * Today's area-visible starred tasks after the user's criteria.
     * Future-start stars remain in Upcoming until ready.
     */
    focused: Task[];
    /** The time-granularity pool after the user's criteria (Next actions, Review Due). */
    active: Task[];
    /** The day-granularity pool after the user's criteria (Today membership). */
    schedule: Task[];
    /** `getUpcomingDeferredTasks` output in reveal-date order; the date rides each entry. */
    upcoming: UpcomingDeferredTask[];
    /**
     * The unfiltered actionable pool a sequential project's one slot is decided
     * on. It must keep the steps that are hidden today, or a step deferred to
     * next week would stop blocking the ones after it.
     */
    base: Task[];
}

export interface BuildFocusPoolsInput {
    /**
     * Actionable, undeleted tasks WITHOUT area narrowing: the global slot
     * count and the starred pool's explicit area-membership projection.
     */
    tasks: Task[];
    /** Normal base visibility; also the starred pool when no area-only predicate is supplied. */
    visibleTasks: Task[];
    projects: Project[];
    criteria: FilterCriteria | undefined;
    now: Date;
    /** An extra caller predicate applied to every pool — desktop's search box. */
    keep?: (task: Task) => boolean;
    /** Area membership alone, excluding unrelated base visibility such as a parked project. */
    isAreaVisible?: (task: Task) => boolean;
}

export function buildFocusPools({
    tasks,
    visibleTasks,
    projects,
    criteria,
    now,
    keep,
    isAreaVisible,
}: BuildFocusPoolsInput): FocusPools & { selection: FocusSelection } {
    const narrow = (pool: Task[]) => applyFilter(
        keep ? pool.filter(keep) : pool,
        criteria,
        { projects, now, tokenMatchMode: 'all' },
    );
    return {
        selection: getFocusSelection(tasks, visibleTasks, now, isAreaVisible),
        focused: narrow((isAreaVisible ? tasks.filter(isAreaVisible) : visibleTasks)
            .filter((task) => isTaskFocusedNow(task, now))),
        active: narrow(visibleTasks.filter((task) => shouldShowTaskForStart(task, { now, granularity: 'time' }))),
        // Today membership is decided at day granularity (a later-today start
        // belongs there, by its time). A task deferred to another day must
        // still be excluded, or a due-today row with a future-day start would
        // double up in both Today and Upcoming.
        schedule: narrow(visibleTasks.filter((task) => shouldShowTaskForStart(task, { now }))),
        // A future-start star stays in Upcoming until its start day. Today's
        // stars cannot enter this pool because they are no longer deferred.
        upcoming: getUpcomingDeferredTasks(narrow(visibleTasks), { now }),
        base: visibleTasks,
    };
}

export type FocusSelection = { globalCount: number; hiddenByAreaCount: number };

/** Counts precede search and criteria: only the area selector can hide an area slot. */
export function getFocusSelection(tasks: readonly Task[], visibleTasks: readonly Task[], now: Date,
    isAreaVisible?: (task: Task) => boolean): FocusSelection {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    let globalCount = 0;
    let hiddenByAreaCount = 0;
    for (const task of tasks) {
        if (!isTaskCountedAsFocused(task, now)) continue;
        globalCount += 1;
        if (!(isAreaVisible ? isAreaVisible(task) : visibleIds.has(task.id))) hiddenByAreaCount += 1;
    }
    return { globalCount, hiddenByAreaCount };
}

export interface FocusTaskLists {
    focusedTasks: Task[];
    schedule: Task[];
    reviewDue: Task[];
    nextActions: Task[];
    upcoming: Task[];
    projectDeadlineBoosts: Map<string, ProjectDeadlineBoost>;
    /**
     * The steps the sequential gate holds back: in a sequential project and not
     * the one holding its slot. Today and Next actions already exclude them;
     * Review Due deliberately does not, so a caller that folds Review Due into
     * another list (the widget) can apply the gate itself.
     */
    sequentialBlockedIds: Set<string>;
}

export interface FocusListContext {
    now: Date;
    projects: Project[];
    sections: Section[];
    sortBy: SortField;
    prioritiesEnabled: boolean;
    focusIncludeStartDates?: boolean;
    /** The saved filter's direction, honoured by a non-default sort. */
    sortOrder?: 'asc' | 'desc';
}

export function deriveFocusTaskLists(pools: FocusPools, ctx: FocusListContext): FocusTaskLists {
    const { now, projects, sections, sortBy, prioritiesEnabled } = ctx;
    const isDefaultSort = sortBy === DEFAULT_FOCUS_SORT_BY;
    const sortBySavedPerspective = (items: Task[]) => (isDefaultSort ? items : sortTasksBySavedPreference(items, sortBy, {
        projects,
        prioritizeByPriority: prioritiesEnabled,
        sortOrder: ctx.sortOrder,
    }));

    // Equal times fall back to priority (when the feature is on) and then to
    // creation order — one rule for Today and Review Due on every surface.
    // The three values are read once per task, not once per comparison: the
    // comparator used to parse `createdAt` (and, through `getTime`, the due and
    // start strings) on every one of the O(n log n) comparisons, which was the
    // cost here — the same finding as #766, and the same fix.
    const sortWith = (items: Task[], getTime: (task: Task) => number) => sortByPrecomputedKey(
        items,
        (task) => ({
            time: getTime(task),
            priority: PRIORITY_RANK[task.priority as TaskPriority] || 0,
            created: safeParseDate(task.createdAt)?.getTime() ?? 0,
        }),
        (a, b) => {
            const timeDiff = a.time - b.time;
            if (timeDiff !== 0) return timeDiff;
            if (prioritiesEnabled) {
                const priorityDiff = b.priority - a.priority;
                if (priorityDiff !== 0) return priorityDiff;
            }
            return a.created - b.created;
        },
    );

    // Per section projects (#1429) add one sequence per Sequential section; their
    // Parallel sections and section-less tasks are never held back.
    const sequencing = getTaskSequencing(projects, sections);
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(pools.base, sequencing.sequentialProjectIds, {
        now,
        sectionScopedProjectIds: sequencing.sectionScopedProjectIds,
        sequentialSectionKeys: sequencing.sequentialSectionKeys,
        sections,
    });
    const isSequentialBlocked = (task: Task) => isTaskSequenceBlocked(task, sequencing, sequentialFirstTaskIds);

    // One pair of Date objects for the whole loop, not one pair per task.
    const todayBounds = getTodayBounds(now);
    const scheduleItems = pools.schedule.filter((task) => {
        if (task.isFocusedToday) return false;
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        return isTodayScheduleCandidate(task, now, todayBounds, ctx.focusIncludeStartDates !== false);
    });
    const scheduleIds = new Set(scheduleItems.map((task) => task.id));

    const reviewDueItems = pools.active.filter((task) => (
        !task.isFocusedToday
        && !scheduleIds.has(task.id)
        && isDueForReview(task.reviewAt, now)
    ));
    const reviewDueIds = new Set(reviewDueItems.map((task) => task.id));

    const nextItems = pools.active.filter((task) => {
        if (task.status !== 'next' || task.isFocusedToday) return false;
        if (isSequentialBlocked(task)) return false;
        return !scheduleIds.has(task.id) && !reviewDueIds.has(task.id);
    });
    const projectDeadlineBoosts = isDefaultSort
        ? getProjectDeadlineBoosts(nextItems, projects, { now })
        : new Map<string, ProjectDeadlineBoost>();

    // The earlier of due and start, so a 09:00 start sorts ahead of a 17:00 due.
    const scheduleSortTime = (task: Task) => {
        const due = safeParseDueDate(task.dueDate)?.getTime();
        const start = safeParseDate(task.startTime)?.getTime();
        if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
        if (typeof due === 'number') return due;
        if (typeof start === 'number') return start;
        return Number.POSITIVE_INFINITY;
    };

    return {
        // The default sort honours the manual Today's Focus order (focusOrder);
        // an explicit or saved sort wins and hides the reorder affordance.
        focusedTasks: isDefaultSort ? sortTasksByFocusOrder(pools.focused) : sortBySavedPerspective(pools.focused),
        schedule: isDefaultSort ? sortWith(scheduleItems, scheduleSortTime) : sortBySavedPerspective(scheduleItems),
        reviewDue: isDefaultSort
            ? sortWith(reviewDueItems, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY)
            : sortBySavedPerspective(reviewDueItems),
        nextActions: isDefaultSort
            ? sortFocusNextActions(nextItems, { now, prioritizeByPriority: prioritiesEnabled, projectDeadlineBoosts })
            : sortBySavedPerspective(nextItems),
        // The forecast keeps reveal-date order even under a custom sort — the
        // date a task appears is the only ordering that means anything here.
        upcoming: pools.upcoming.map((entry) => entry.task).filter((task) => !isSequentialBlocked(task)),
        projectDeadlineBoosts,
        sequentialBlockedIds: new Set(
            pools.base.filter(isSequentialBlocked).map((task) => task.id),
        ),
    };
}

export type FocusTaskSectionKey = 'focus' | 'schedule' | 'reviewDue' | 'next' | 'upcoming';

export interface FocusTaskSection {
    key: FocusTaskSectionKey;
    title: string;
    items: Task[];
}

/**
 * The Focus screen's task sections in screen order with the screen's titles:
 * Today's Focus (only when starred tasks exist), Today, Next actions, Review
 * Due, Upcoming (only when non-empty). `translate` returns undefined for a
 * missing key so both `t()` and a raw dictionary lookup fit.
 */
export function buildFocusTaskSections(
    lists: Pick<FocusTaskLists, 'focusedTasks' | 'schedule' | 'reviewDue' | 'nextActions' | 'upcoming'>,
    translate: (key: string) => string | undefined,
    globalFocusedCount = lists.focusedTasks.length,
): FocusTaskSection[] {
    const sections: FocusTaskSection[] = [];
    if (globalFocusedCount > 0) {
        sections.push({ key: 'focus', title: translate('agenda.todaysFocus') ?? "Today's Focus", items: lists.focusedTasks });
    }
    sections.push(
        { key: 'schedule', title: translate('focus.schedule') ?? 'Today', items: lists.schedule },
        { key: 'next', title: translate('focus.nextActions') ?? translate('list.next') ?? 'Next actions', items: lists.nextActions },
        { key: 'reviewDue', title: translate('agenda.reviewDue') ?? 'Review Due', items: lists.reviewDue },
    );
    if (lists.upcoming.length > 0) {
        sections.push({ key: 'upcoming', title: translate('agenda.upcoming') ?? 'Upcoming', items: lists.upcoming });
    }
    return sections;
}

/**
 * Focus's "Projects to review" list, shown after the task sections: live,
 * non-archived projects whose review date has come, earliest review first,
 * then by title. Pass the projects the screen's area filter keeps.
 */
export function getReviewDueProjects(projects: readonly Project[], now: Date): Project[] {
    return projects
        .filter((project) => project.status !== 'archived' && isDueForReview(project.reviewAt, now))
        .sort((a, b) => {
            const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
            const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
            if (aReview !== bReview) return aReview - bReview;
            return a.title.localeCompare(b.title);
        });
}
