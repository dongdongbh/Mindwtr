import {
    getFocusSequentialFirstTaskIds,
    getProjectDeadlineBoosts,
    isDueForReview,
    safeParseDate,
    safeParseDueDate,
    sortFocusNextActions,
    sortTasksByFocusOrder,
    type Project,
    type ProjectDeadlineBoost,
    type SortField,
    type Task,
} from '@mindwtr/core';

import { splitFocusedTasks } from './focus-screen-utils';

// The ONE derivation of which task lands in which Focus section, shared by
// the Focus screen (app/(drawer)/(tabs)/focus.tsx) and the widget payload
// (lib/widget-data.ts, #1173) so the two can never disagree. Callers hand
// over their already-filtered pools; this module only sorts and buckets.

export const DEFAULT_FOCUS_SORT_BY: SortField = 'default';

export type FocusTaskSectionKey = 'focus' | 'schedule' | 'reviewDue' | 'next' | 'upcoming';

export interface FocusTaskLists {
    focusedTasks: Task[];
    schedule: Task[];
    reviewDue: Task[];
    nextActions: Task[];
    upcoming: Task[];
    projectDeadlineBoosts: Map<string, ProjectDeadlineBoost>;
}

export interface FocusTaskSection {
    key: FocusTaskSectionKey;
    title: string;
    items: Task[];
}

export interface DeriveFocusTaskListsInput {
    now: Date;
    /** Starred, actionable tasks after the user's criteria (never area- or start-hidden). */
    focusedPool: Task[];
    /** The time-granularity pool after the user's criteria. */
    filteredActiveTasks: Task[];
    /** The day-granularity pool after the user's criteria (Today membership). */
    scheduleCandidates: Task[];
    /** `getUpcomingDeferredTasks` output, tasks only, reveal-date order. */
    upcomingCandidates: Task[];
    /** The unfiltered actionable pool a sequential project's slot is decided on. */
    baseActiveTasks: Task[];
    projects: Project[];
    sequentialProjectIds: Set<string>;
    sequentialWithinSectionProjectIds: Set<string>;
    sortBy: SortField;
    prioritiesEnabled: boolean;
    /** Applies the caller's non-default sort; only called when `sortBy` is not the default. */
    sortBySavedPerspective: (items: Task[]) => Task[];
}

export function deriveFocusTaskLists({
    now,
    focusedPool,
    filteredActiveTasks,
    scheduleCandidates,
    upcomingCandidates,
    baseActiveTasks,
    projects,
    sequentialProjectIds,
    sequentialWithinSectionProjectIds,
    sortBy,
    prioritiesEnabled,
    sortBySavedPerspective,
}: DeriveFocusTaskListsInput): FocusTaskLists {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const { otherTasks: nonFocusedTasks } = splitFocusedTasks(filteredActiveTasks);
    const { otherTasks: nonFocusedScheduleTasks } = splitFocusedTasks(scheduleCandidates);
    const allFocusedTasks = focusedPool;
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, {
        now,
        sectionScopedProjectIds: sequentialWithinSectionProjectIds,
    });

    const isSequentialBlocked = (task: Task) => {
        if (!task.projectId) return false;
        if (!sequentialProjectIds.has(task.projectId)) return false;
        return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleItems = nonFocusedScheduleTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        const due = safeParseDueDate(task.dueDate);
        const start = safeParseDate(task.startTime);
        const startsToday = Boolean(
            start
            && start >= startOfToday
            && start <= endOfToday
        );
        return Boolean(due && due <= endOfToday) || startsToday;
    });

    const scheduleIds = new Set(scheduleItems.map((task) => task.id));
    const reviewDueItems = nonFocusedTasks
        .filter((task) => !scheduleIds.has(task.id) && isDueForReview(task.reviewAt, now))
        .sort((a, b) => {
            const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
            const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
            if (aReview !== bReview) return aReview - bReview;
            return a.title.localeCompare(b.title);
        });
    const reviewDueIds = new Set(reviewDueItems.map((task) => task.id));

    const nextItems = nonFocusedTasks.filter((task) => {
        if (reviewDueIds.has(task.id)) return false;
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        return !scheduleIds.has(task.id);
    });
    const nextProjectDeadlineBoosts = sortBy === DEFAULT_FOCUS_SORT_BY
        ? getProjectDeadlineBoosts(nextItems, projects, { now })
        : new Map<string, ProjectDeadlineBoost>();

    // Mirrors desktop's scheduleSortTime (AgendaView.tsx): the earlier of due
    // and start, so a 09:00 start sorts ahead of a 17:00 due date.
    const scheduleSortTime = (task: Task) => {
        const due = safeParseDueDate(task.dueDate)?.getTime();
        const start = safeParseDate(task.startTime)?.getTime();
        if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
        if (typeof due === 'number') return due;
        if (typeof start === 'number') return start;
        return Number.POSITIVE_INFINITY;
    };
    const sortedScheduleItems = [...scheduleItems].sort((a, b) => {
        const timeDiff = scheduleSortTime(a) - scheduleSortTime(b);
        if (timeDiff !== 0) return timeDiff;
        return a.title.localeCompare(b.title);
    });

    return {
        // Default sort honours the manual Today's Focus order (focusOrder); an
        // explicit non-default sort wins and hides the reorder affordance.
        focusedTasks: sortBy === DEFAULT_FOCUS_SORT_BY
            ? sortTasksByFocusOrder(allFocusedTasks)
            : sortBySavedPerspective(allFocusedTasks),
        schedule: sortBy === DEFAULT_FOCUS_SORT_BY ? sortedScheduleItems : sortBySavedPerspective(scheduleItems),
        nextActions: sortBy === DEFAULT_FOCUS_SORT_BY
            ? sortFocusNextActions(nextItems, {
                now,
                prioritizeByPriority: prioritiesEnabled,
                projectDeadlineBoosts: nextProjectDeadlineBoosts,
            })
            : sortBySavedPerspective(nextItems),
        reviewDue: sortBy === DEFAULT_FOCUS_SORT_BY ? reviewDueItems : sortBySavedPerspective(reviewDueItems),
        // The forecast keeps reveal-date order even under a custom sort — the
        // date a task appears is the only ordering that means anything here.
        upcoming: upcomingCandidates.filter((task) => !isSequentialBlocked(task)),
        projectDeadlineBoosts: nextProjectDeadlineBoosts,
    };
}

/**
 * The Focus screen's task sections in screen order with the screen's titles:
 * Today's Focus (only when starred tasks exist), Today, Review Due, Next
 * actions, Upcoming (only when non-empty). `translate` returns undefined for a
 * missing key so both `t()` and a raw dictionary lookup fit.
 */
export function buildFocusTaskSections(
    lists: Pick<FocusTaskLists, 'focusedTasks' | 'schedule' | 'reviewDue' | 'nextActions' | 'upcoming'>,
    translate: (key: string) => string | undefined,
): FocusTaskSection[] {
    const sections: FocusTaskSection[] = [];
    if (lists.focusedTasks.length > 0) {
        sections.push({ key: 'focus', title: translate('agenda.todaysFocus') ?? "Today's Focus", items: lists.focusedTasks });
    }
    sections.push(
        { key: 'schedule', title: translate('focus.schedule') ?? 'Today', items: lists.schedule },
        { key: 'reviewDue', title: translate('agenda.reviewDue') ?? 'Review Due', items: lists.reviewDue },
        { key: 'next', title: translate('focus.nextActions') ?? translate('list.next') ?? 'Next actions', items: lists.nextActions },
    );
    if (lists.upcoming.length > 0) {
        sections.push({ key: 'upcoming', title: translate('agenda.upcoming') ?? 'Upcoming', items: lists.upcoming });
    }
    return sections;
}
