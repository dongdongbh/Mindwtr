


import { hasTimeComponent, isDueForReview, safeParseDate, safeParseDueDate } from './date';
import { applyFilter } from './saved-filters';
import { isTaskCountedAsFocused } from './store-helpers';
import {
    getFocusSequentialFirstTaskIds,
    getTaskSequencing,
    isTaskSequenceBlocked,
    getProjectDeadlineBoosts,
    FOCUS_NEXT_DUE_SOON_WINDOW_DAYS,
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


export function getTodayBounds(now: Date): { startOfToday: Date; endOfToday: Date } {
    return {
        startOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
        endOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
    };
}


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


export interface FocusPools {


    focused: Task[];

    active: Task[];

    schedule: Task[];

    upcoming: UpcomingDeferredTask[];


    base: Task[];
}

export interface BuildFocusPoolsInput {


    tasks: Task[];

    visibleTasks: Task[];
    projects: Project[];
    criteria: FilterCriteria | undefined;
    now: Date;

    keep?: (task: Task) => boolean;

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


        schedule: narrow(visibleTasks.filter((task) => shouldShowTaskForStart(task, { now }))),


        upcoming: getUpcomingDeferredTasks(narrow(visibleTasks), { now }),
        base: visibleTasks,
    };
}

export type FocusSelection = { globalCount: number; hiddenByAreaCount: number };


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


    sequentialBlockedIds: Set<string>;
}

export interface FocusListContext {
    now: Date;
    projects: Project[];
    sections: Section[];
    sortBy: SortField;
    prioritiesEnabled: boolean;
    focusIncludeStartDates?: boolean;

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


    const sequencing = getTaskSequencing(projects, sections);
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(pools.base, sequencing.sequentialProjectIds, {
        now,
        sectionScopedProjectIds: sequencing.sectionScopedProjectIds,
        sequentialSectionKeys: sequencing.sequentialSectionKeys,
        sections,
    });
    const isSequentialBlocked = (task: Task) => isTaskSequenceBlocked(task, sequencing, sequentialFirstTaskIds);


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


    const scheduleSortTime = (task: Task) => {
        const due = safeParseDueDate(task.dueDate)?.getTime();
        const start = safeParseDate(task.startTime)?.getTime();
        if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
        if (typeof due === 'number') return due;
        if (typeof start === 'number') return start;
        return Number.POSITIVE_INFINITY;
    };

    return {


        focusedTasks: isDefaultSort ? sortTasksByFocusOrder(pools.focused) : sortBySavedPerspective(pools.focused),
        schedule: isDefaultSort ? sortWith(scheduleItems, scheduleSortTime) : sortBySavedPerspective(scheduleItems),
        reviewDue: isDefaultSort
            ? sortWith(reviewDueItems, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY)
            : sortBySavedPerspective(reviewDueItems),
        nextActions: isDefaultSort
            ? sortFocusNextActions(nextItems, { now, prioritizeByPriority: prioritiesEnabled, projectDeadlineBoosts })
            : sortBySavedPerspective(nextItems),


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


export const FOCUS_MODEL_CLOCK_READERS: Record<string, 'midnight' | 'timed start' | 'due' | 'review'> = {


    isTaskFutureStart: 'midnight',
    isTaskFocusedNow: 'midnight',
    isTaskCountedAsFocused: 'midnight',
    getFocusSelection: 'midnight',
    getUpcomingDeferredTasks: 'midnight',
    getTodayBounds: 'midnight',
    isTodayScheduleCandidate: 'midnight',
    getProjectDeadlineBoosts: 'midnight',
    getFocusSequentialScheduleKey: 'midnight',
    matchesDateRange: 'midnight',

    shouldShowTaskForStart: 'timed start',
    splitTodayTasksByStartTime: 'timed start',

    sortFocusNextActions: 'due',

    isDueForReview: 'review',
    getReviewDueProjects: 'review',
};


export function getFocusModelValidUntil(input: { tasks: readonly Task[]; projects: readonly Project[]; now: Date }): number | null {
    const nowMs = input.now.getTime();
    if (!Number.isFinite(nowMs)) return null;

    let next = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() + 1).getTime();
    const dueSoonWindowMs = FOCUS_NEXT_DUE_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const consider = (at: number | undefined) => {
        if (at !== undefined && at > nowMs && at < next) next = at;
    };
    for (const task of input.tasks) {
        if (hasTimeComponent(task.startTime)) consider(safeParseDate(task.startTime)?.getTime());
        const due = safeParseDueDate(task.dueDate)?.getTime();
        if (due !== undefined) {
            consider(due - dueSoonWindowMs);

            consider(due);
        }
        consider(safeParseDate(task.reviewAt)?.getTime());
    }
    for (const project of input.projects) consider(safeParseDate(project.reviewAt)?.getTime());
    return Number.isFinite(next) && next > nowMs ? next : null;
}

