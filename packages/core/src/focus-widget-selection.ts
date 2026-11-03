


import { deriveFocusTaskLists, type FocusPools } from './focus-sections';
import { TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { isTaskFocusedNow, shouldShowTaskForStart, sortTasksBy } from './task-utils';
import type { Project, Section, Task, TaskSortBy } from './types';


export interface TodayFocusSelectionInput {


    activeTasks: Task[];
    projects: Project[];
    sections: Section[];
    sortBy: TaskSortBy;
    now: Date;
    focusIncludeStartDates?: boolean;
}

export interface TodayFocusSelection {

    starredTasks: Task[];

    focusTasks: Task[];
}


export function computeTodayFocusTasks({
    activeTasks,
    projects,
    sections,
    sortBy,
    now,
    focusIncludeStartDates,
}: TodayFocusSelectionInput): TodayFocusSelection {
    const pools: FocusPools = {
        focused: activeTasks.filter((task) => isTaskFocusedNow(task, now)),
        active: activeTasks.filter((task) => shouldShowTaskForStart(task, { now, granularity: 'time' })),
        schedule: activeTasks,
        upcoming: [],
        base: activeTasks,
    };
    const lists = deriveFocusTaskLists(pools, {
        now,
        projects,
        sections,


        sortBy: 'default',
        prioritiesEnabled: false,
        focusIncludeStartDates,
    });


    const scheduled = new Set(lists.schedule.map((task) => task.id));
    const listed = new Set(
        [...lists.reviewDue, ...lists.nextActions]


            .filter((task) => task.status === 'next' && !lists.sequentialBlockedIds.has(task.id))
            .map((task) => task.id),
    );
    return {
        starredTasks: sortTasksBy(pools.focused, sortBy),
        focusTasks: sortTasksBy([
            ...activeTasks.filter((task) => scheduled.has(task.id)),
            ...activeTasks.filter((task) => listed.has(task.id) && !scheduled.has(task.id)),
        ], sortBy),
    };
}


export function resolveWidgetTaskSort(stored: unknown): TaskSortBy {
    return TASK_LIST_SORT_OPTIONS.includes(stored as TaskSortBy) ? stored as TaskSortBy : 'default';
}
