


import { isDueForReview, safeParseDate, safeParseDueDate } from '../date';
import { createTaskFilterPredicate } from '../saved-filters';
import {
    getFocusSequentialFirstTaskIds,
    getUpcomingDeferredTasks,
    PRIORITY_RANK,
    shouldShowTaskForStart,
    sortTasksByFocusOrder,
    sortTasksBySavedPreference,
    type ProjectDeadlineBoost,
    type UpcomingDeferredTask,
} from '../task-utils';
import type { FilterCriteria, Project, Section, SortField, Task, TaskPriority } from '../types';
import type {
    BuildFocusPoolsInput,
    FocusListContext,
    FocusPools,
    FocusTaskLists,
    FocusTaskSection,
} from '../focus-sections';

type FrozenFocusListContext = FocusListContext & {
    sortBySavedPerspective?: (items: Task[]) => Task[];
};

export const DEFAULT_FOCUS_SORT_BY: SortField = 'default';


const textCollator = new Intl.Collator();


const frozenApplyFilter = <T extends Task>(
    tasks: readonly T[],
    criteria: FilterCriteria | undefined,
    options: Parameters<typeof createTaskFilterPredicate>[1],
): T[] => tasks.filter(createTaskFilterPredicate(criteria, options));

const FOCUS_NEXT_DUE_SOON_WINDOW_DAYS = 30;

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

function getFocusNextActionBucket(dueMs: number, nowMs: number, dueSoonWindowMs: number): number {
    if (!Number.isFinite(dueMs)) return 1;
    if (dueMs <= nowMs + dueSoonWindowMs) return 0;
    return 2;
}

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

function frozenSortByPrecomputedKey<T, K>(
    tasks: readonly T[],
    toKey: (task: T) => K,
    compare: (a: K, b: K) => number,
): T[] {
    const decorated = tasks.map((task) => ({ task, key: toKey(task) }));
    decorated.sort((a, b) => compare(a.key, b.key));
    return decorated.map((entry) => entry.task);
}

export function frozenGetProjectDeadlineBoosts(
    tasks: readonly Task[],
    projects: readonly Project[],
    options: { now?: Date } = {},
): Map<string, ProjectDeadlineBoost> {
    const now = options.now ?? new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const projectInfoById = new Map<string, ProjectDeadlineBoost>();

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

type FrozenSortFocusNextActionsOptions = {
    now?: Date;
    dueSoonWindowDays?: number;
    prioritizeByPriority?: boolean;
    projectDeadlineBoosts?: ReadonlyMap<string, ProjectDeadlineBoost>;
    projects?: readonly Project[];
};

export function frozenSortFocusNextActions(
    tasks: Task[],
    options: FrozenSortFocusNextActionsOptions = {},
): Task[] {
    const nowMs = (options.now ?? new Date()).getTime();
    const dueSoonWindowDays = Number.isFinite(options.dueSoonWindowDays)
        ? Math.max(0, Math.floor(options.dueSoonWindowDays as number))
        : FOCUS_NEXT_DUE_SOON_WINDOW_DAYS;
    const dueSoonWindowMs = dueSoonWindowDays * 24 * 60 * 60 * 1000;
    const prioritizeByPriority = options.prioritizeByPriority === true;
    const projectDeadlineBoosts = options.projectDeadlineBoosts
        ?? (options.projects ? frozenGetProjectDeadlineBoosts(tasks, options.projects, { now: options.now }) : new Map());

    return frozenSortByPrecomputedKey(tasks, (task) => {
        const due = safeDueTime(task.dueDate, Number.POSITIVE_INFINITY);
        return {
            task,
            due,
            bucket: getFocusNextActionBucket(due, nowMs, dueSoonWindowMs),
            start: safeTime(task.startTime, Number.POSITIVE_INFINITY),
            created: safeTime(task.createdAt, 0),
        };
    }, (keyA, keyB) => {
        const { task: a, bucket: bucketA } = keyA;
        const { task: b, bucket: bucketB } = keyB;
        if (bucketA !== bucketB) return bucketA - bucketB;

        if (bucketA !== 1) {
            if (keyA.due !== keyB.due) return keyA.due - keyB.due;
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
            const priorityDiff = (PRIORITY_RANK[b.priority as TaskPriority] || 0)
                - (PRIORITY_RANK[a.priority as TaskPriority] || 0);
            if (priorityDiff !== 0) return priorityDiff;
        }

        if (keyA.start !== keyB.start) return keyA.start - keyB.start;

        const createdDiff = keyA.created - keyB.created;
        if (createdDiff !== 0) return createdDiff;

        const titleDiff = textCollator.compare(a.title, b.title);
        if (titleDiff !== 0) return titleDiff;

        return textCollator.compare(a.id, b.id);
    });
}


export function frozenGetTodayBounds(now: Date): { startOfToday: Date; endOfToday: Date } {
    return {
        startOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
        endOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
    };
}

export function frozenIsTodayScheduleCandidate(task: Task, now: Date): boolean {
    const { startOfToday, endOfToday } = frozenGetTodayBounds(now);
    const due = safeParseDueDate(task.dueDate);
    const start = safeParseDate(task.startTime);
    const startsToday = Boolean(start && start >= startOfToday && start <= endOfToday);
    return Boolean(due && due <= endOfToday) || startsToday;
}

export function frozenBuildFocusPools({
    tasks,
    visibleTasks,
    projects,
    criteria,
    now,
    keep,
}: BuildFocusPoolsInput): FocusPools {
    const narrow = (pool: Task[]) => frozenApplyFilter(
        keep ? pool.filter(keep) : pool,
        criteria as FilterCriteria | undefined,
        { projects, now, tokenMatchMode: 'all' },
    );
    return {
        focused: narrow(tasks.filter((task) => task.isFocusedToday === true)),
        active: narrow(visibleTasks.filter((task) => shouldShowTaskForStart(task, { now, granularity: 'time' }))),
        schedule: narrow(visibleTasks.filter((task) => shouldShowTaskForStart(task, { now }))),
        upcoming: getUpcomingDeferredTasks(narrow(visibleTasks.filter((task) => !task.isFocusedToday)), { now }) as UpcomingDeferredTask[],
        base: visibleTasks,
    };
}

export function frozenDeriveFocusTaskLists(pools: FocusPools, ctx: FrozenFocusListContext): FocusTaskLists {
    const { now, projects, sections, sortBy, prioritiesEnabled } = ctx;
    const isDefaultSort = sortBy === DEFAULT_FOCUS_SORT_BY;
    const sortBySavedPerspective = ctx.sortBySavedPerspective
        ?? ((items: Task[]) => (isDefaultSort ? items : sortTasksBySavedPreference(items, sortBy, {
            projects,
            prioritizeByPriority: prioritiesEnabled,
            sortOrder: ctx.sortOrder,
        })));

    const sortWith = (items: Task[], getTime: (task: Task) => number) => [...items].sort((a, b) => {
        const timeDiff = getTime(a) - getTime(b);
        if (timeDiff !== 0) return timeDiff;
        if (prioritiesEnabled) {
            const priorityDiff = (PRIORITY_RANK[b.priority as TaskPriority] || 0) - (PRIORITY_RANK[a.priority as TaskPriority] || 0);
            if (priorityDiff !== 0) return priorityDiff;
        }
        const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
        const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
        return aCreated - bCreated;
    });

    const sequentialProjectIds = new Set<string>();
    const sequentialWithinSectionProjectIds = new Set<string>();
    for (const project of projects) {
        if (project.deletedAt || !project.isSequential) continue;
        sequentialProjectIds.add(project.id);
        if (project.sequentialScope === 'section') sequentialWithinSectionProjectIds.add(project.id);
    }
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(pools.base, sequentialProjectIds, {
        now,
        sectionScopedProjectIds: sequentialWithinSectionProjectIds,
        sections: sections as Section[],
    });
    const isSequentialBlocked = (task: Task) => {
        if (!task.projectId) return false;
        if (!sequentialProjectIds.has(task.projectId)) return false;
        return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleItems = pools.schedule.filter((task) => {
        if (task.isFocusedToday) return false;
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        return frozenIsTodayScheduleCandidate(task, now);
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
        ? frozenGetProjectDeadlineBoosts(nextItems, projects, { now })
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
            ? frozenSortFocusNextActions(nextItems, { now, prioritizeByPriority: prioritiesEnabled, projectDeadlineBoosts })
            : sortBySavedPerspective(nextItems),
        upcoming: pools.upcoming.map((entry) => entry.task).filter((task) => !isSequentialBlocked(task)),
        projectDeadlineBoosts,
        sequentialBlockedIds: new Set(
            pools.base.filter(isSequentialBlocked).map((task) => task.id),
        ),
    };
}


export function frozenBuildFocusTaskSections(
    lists: Pick<FocusTaskLists, 'focusedTasks' | 'schedule' | 'reviewDue' | 'nextActions' | 'upcoming'>,
    translate: (key: string) => string | undefined,
): FocusTaskSection[] {
    const sections: FocusTaskSection[] = [];
    if (lists.focusedTasks.length > 0) {
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
