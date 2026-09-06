/**
 * The one home for the "Today" list the widget payload builders render:
 * `apps/mobile/lib/widget-data.ts` (Android widget, iOS widget, and the
 * Shortcuts snapshot's "focus" list, #980) and
 * `apps/desktop/src/lib/macos-widget-data.ts` (the macOS WidgetKit widget,
 * #1054). Both used to carry their own copy of this selection, and the copies
 * picked a sequential project's one slot with the order-only
 * `getSequentialFirstTaskIds` while the Focus screens picked it with the
 * schedule-ranked `getFocusSequentialFirstTaskIds` -- so a project whose
 * step 3 was due today showed step 3 in Focus and step 1 on the widget.
 *
 * Focus order is ONE contract across surfaces (#1090): this module applies the
 * Focus screens' rule, and the builders keep only their payload shaping (which
 * needs `react-native-android-widget` / AsyncStorage on mobile and neither on
 * desktop, hence no shared builder).
 *
 * `now` is a parameter, never `Date.now()`, so the selection is deterministic
 * in tests and one payload build sees one instant.
 */
import { safeParseDate, safeParseDueDate } from './date';
import { getFocusSequentialFirstTaskIds, sortTasksBy } from './task-utils';
import type { Project, Task, TaskSortBy } from './types';

export interface TodayFocusSelectionInput {
    /**
     * The caller's already-narrowed pool: undeleted, actionable, in an active
     * project. This is the widget's equivalent of the Focus screens'
     * `baseActiveTasks` -- deliberately NOT start-time filtered, because
     * `getFocusSequentialFirstTaskIds` must see a step that is deferred to a
     * future date to know it still holds its project's slot.
     */
    activeTasks: Task[];
    projects: Project[];
    sortBy: TaskSortBy;
    now: Date;
}

export interface TodayFocusSelection {
    /** Starred tasks, sorted; they lead the widget list. */
    starredTasks: Task[];
    /** Everything else that belongs in today's list, sorted; starred excluded. */
    focusTasks: Task[];
}

/**
 * Starred tasks first, then next actions due or starting today, then the rest
 * of today's actionable next actions -- with a sequential project contributing
 * at most the one step the Focus screen would show for it.
 */
export function computeTodayFocusTasks({
    activeTasks,
    projects,
    sortBy,
    now,
}: TodayFocusSelectionInput): TodayFocusSelection {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const sequentialProjectIds = new Set(
        projects.filter((project) => project.isSequential && !project.deletedAt).map((project) => project.id)
    );
    const sequentialWithinSectionProjectIds = new Set(
        projects
            .filter((project) => project.isSequential && project.sequentialScope === 'section' && !project.deletedAt)
            .map((project) => project.id)
    );

    const isPlannedForFuture = (task: Task) => {
        const start = safeParseDate(task.startTime);
        return Boolean(start && start > endOfToday);
    };
    const isScheduleCandidate = (task: Task) => {
        const due = safeParseDueDate(task.dueDate);
        const start = safeParseDate(task.startTime);
        const startsToday = Boolean(start && start >= startOfToday && start <= endOfToday);
        return Boolean(due && due <= endOfToday) || startsToday;
    };

    // The whole active pool goes in, exactly as the Focus screens hand over
    // `baseActiveTasks`: the helper's own `isFocusSequentialCandidate` decides
    // which tasks hold a slot (starred, next/waiting, or due for review), and
    // its schedule ranking hands the slot to a later step that is due today or
    // due for review.
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(activeTasks, sequentialProjectIds, {
        now,
        sectionScopedProjectIds: sequentialWithinSectionProjectIds,
    });
    const isSequentialBlocked = (task: Task) => {
        if (!task.projectId) return false;
        if (!sequentialProjectIds.has(task.projectId)) return false;
        return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleTasks = activeTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        return isScheduleCandidate(task);
    });
    const scheduleTaskIds = new Set(scheduleTasks.map((task) => task.id));

    const nextTasks = activeTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isPlannedForFuture(task)) return false;
        if (isSequentialBlocked(task)) return false;
        return !scheduleTaskIds.has(task.id);
    });

    // Starred tasks mirror core's focusedTasks (the caller's pool already
    // excludes done/reference/archived/deleted and inactive projects) and lead
    // the list, so "current focused task" surfaces (lock widget, list head)
    // show the task the user actually starred -- including starred
    // waiting/someday tasks, which keep their status by design.
    const starredTasks = activeTasks.filter((task) => (
        task.isFocusedToday === true
        && (!isPlannedForFuture(task) || isScheduleCandidate(task))
    ));
    const starredTaskIds = new Set(starredTasks.map((task) => task.id));

    return {
        starredTasks: sortTasksBy(starredTasks, sortBy),
        focusTasks: sortTasksBy(
            [...scheduleTasks, ...nextTasks].filter((task) => !starredTaskIds.has(task.id)),
            sortBy,
        ),
    };
}
