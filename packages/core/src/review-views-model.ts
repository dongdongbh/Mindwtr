/**
 * The Review screens' logic, shared by the React Native screens and the native
 * host contract: the Review overview (areas, projects and tasks), the Weekly
 * Review wizard and the Daily Review. Candidate lists and step flags come from
 * review-utils.ts; this module adds what each screen shows for them (titles,
 * summaries, counts, colors, empty states, previews), the step rail, the saved
 * session (pause and resume) and each action's write.
 *
 * Colors a screen takes from its theme are `null` here: the platform fills in
 * its own tint.
 */
import type { ReviewSnapshotItem, ReviewSuggestion } from './ai/types';
import { filterReviewSuggestionsToKnownIds } from './ai/utils';
import { getProjectAccentColor } from './task-accent-color';
import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { createDateFormatter, hasTimeComponent, isDueForReview, safeParseDate, type DateFormatter } from './date';
import { formatFocusTaskLimitText, normalizeFocusTaskLimit } from './focus-utils';
import { formatI18nTemplate, tFallback } from './i18n';
import { formatListItemCount } from './list-count';
import type { ExternalCalendarEvent } from './ics';
import { buildQuickAddParseOptions, parseProjectNextActionInput } from './quick-add';
import { resolveFeatureFlags } from './resolve-feature-flags';
import {
    getExternalCalendarEventsForDay,
    parseStoredReviewStepSession,
    type CalendarReviewEntry,
    type DailyReviewBuckets,
    type ExternalCalendarDaySummary,
    type ProjectNextActionState,
    type ReviewOverviewAreaGroup,
    type ReviewSchedulePartition,
    type ReviewOverviewScope,
    type ReviewSessionCadence,
    type ReviewStepFlags,
    type StoredReviewStepSession,
    type WeeklyReviewBuckets,
    type WeeklyReviewProjectEntry,
} from './review-utils';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { formatTimeSpentLabel } from './time-spent';
import type { AppSettings, Area, Person, Project, Task, TaskStatus } from './types';

type Translate = (key: string) => string;

// ---------------------------------------------------------------------------
// Review overview (the Review screen).

/** The statuses Review's bulk "Move to" offers, in order. */
export const REVIEW_BULK_STATUSES: readonly TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];

export function getReviewOverviewText(t: Translate) {
    return {
        noArea: t('review.noArea'),
        singleActions: t('review.singleActions'),
        unassigned: tFallback(t, 'review.unassigned', 'Unassigned'),
        countProject: (count: number) => formatListItemCount(count, 'project', t),
        countTask: (count: number) => formatListItemCount(count, 'task', t),
        activeTask: tFallback(t, 'review.activeTask', 'active task'),
        needsActionSummary: tFallback(t, 'review.needsActionSummary', 'needs action'),
        withoutArea: tFallback(t, 'review.withoutArea', 'without an area'),
        activeTasks: tFallback(t, 'review.activeTasks', 'active tasks'),
        startReview: tFallback(t, 'review.startReview', 'Start Review'),
        expandAreas: tFallback(t, 'review.expandAreas', 'Expand areas'),
        expandEverything: tFallback(t, 'review.expandEverything', 'Expand projects'),
        collapseEverything: tFallback(t, 'review.collapseEverything', 'Collapse all'),
        hasNextAction: t('review.hasNextAction'),
        waiting: t('status.waiting'),
        needsAction: t('review.needsAction'),
        empty: t('review.noTasks'),
        dueEmpty: t('review.dueEmpty'),
        overviewEmpty: t('review.overviewEmpty'),
        scopeDue: t('review.scopeDue'),
        scopeAll: t('review.scopeAll'),
        dueHelp: t('review.dueHelp'),
        overviewHelp: t('review.overviewHelp'),
        markReviewed: t('review.markReviewed'),
        dailyReview: t('dailyReview.title'),
        weeklyReview: t('review.openGuide'),
        cancel: t('common.cancel'),
        selected: t('bulk.selected'),
        organize: tFallback(t, 'bulk.organize', 'Organize'),
        moveTo: t('bulk.moveTo'),
        addTag: t('bulk.addTag'),
        removeTag: tFallback(t, 'bulk.removeTag', 'Remove tag'),
        tagPlaceholder: t('bulk.tagPlaceholder'),
        tagsLabel: t('taskEdit.tagsLabel'),
        share: t('common.share'),
        delete: t('common.delete'),
        save: t('common.save'),
        restore: tFallback(t, 'trash.restoreToInbox', 'Restore'),
    };
}
export type ReviewOverviewText = ReturnType<typeof getReviewOverviewText>;

export type ReviewTone = 'success' | 'warning' | 'danger';

export type ReviewProjectSection = {
    /** `project:<id>`, or `single:<area group id>` for the area's tasks without a project. */
    id: string;
    projectId: string | null;
    isSingleActions: boolean;
    title: string;
    nextActionState: ProjectNextActionState;
    tasks: Task[];
    /** "2 active tasks · Has Next Action", or "8 tasks" for single actions. */
    summary: string;
    /** What the header shows: single actions add " · Single actions". */
    summaryText: string;
    accessibilityLabel: string;
    /** The status dot; single actions have none. */
    statusTone: ReviewTone | null;
    /** The summary turns amber for a project with nothing to do next. */
    summaryTone: 'warning' | 'secondary';
};

export type ReviewAreaSection = {
    /** `area:<id>`, or `area:none`. */
    id: string;
    areaId: string | null;
    isUnassigned: boolean;
    title: string;
    /** The area dot; null means the theme tint. */
    color: string | null;
    taskCount: number;
    projectCount: number;
    needsActionCount: number;
    summary: string;
    accessibilityLabel: string;
    projectGroups: ReviewProjectSection[];
};

/**
 * Review's area groups as the screen shows them, from core's overview groups
 * (visibility, sort and counts: getReviewOverviewGroups).
 */
export function decorateReviewOverviewGroups(
    groups: readonly ReviewOverviewAreaGroup[],
    options: {
        areaById: ReadonlyMap<string, Area>;
        /** settings.appearance.unassignedAreaColor */
        unassignedAreaColor: string | undefined;
        text: ReviewOverviewText;
        scope?: ReviewOverviewScope;
    },
): ReviewAreaSection[] {
    const { areaById, text, scope = 'all' } = options;
    const unassignedAreaColor = options.unassignedAreaColor || DEFAULT_AREA_COLOR;
    return groups.map((group) => {
        const area = group.areaId ? areaById.get(group.areaId) : undefined;
        const representativeProject = group.projectGroups.find(({ project }) => project)?.project;
        const id = group.areaId ? `area:${group.areaId}` : 'area:none';
        const isUnassigned = !group.areaId;
        const title = area?.name || representativeProject?.areaTitle || text.unassigned || text.noArea;
        const taskSummary = isUnassigned
            ? `${text.countTask(group.taskCount)} ${text.withoutArea}`
            : text.countTask(group.taskCount);
        const summary = [
            group.projectCount > 0 ? text.countProject(group.projectCount) : null,
            taskSummary,
            scope === 'all' && group.needsActionCount > 0 ? `${group.needsActionCount} ${text.needsActionSummary}` : null,
        ].filter(Boolean).join(' · ');
        return {
            id,
            areaId: group.areaId ?? null,
            isUnassigned,
            title,
            color: group.areaId ? (area?.color && area.color !== DEFAULT_PROJECT_COLOR ? area.color : null) : unassignedAreaColor,
            taskCount: group.taskCount,
            projectCount: group.projectCount,
            needsActionCount: group.needsActionCount,
            summary,
            accessibilityLabel: `${title}, ${summary}`,
            projectGroups: group.projectGroups.map((projectGroup) => {
                const isSingleActions = !projectGroup.project;
                const groupTitle = projectGroup.project?.title || text.singleActions;
                const state = projectGroup.nextActionState;
                const stateLabel = state === 'next' ? text.hasNextAction : state === 'waiting' ? text.waiting : text.needsAction;
                const projectSummary = scope === 'due'
                    ? text.countTask(projectGroup.tasks.length)
                    : isSingleActions
                    ? text.countTask(projectGroup.tasks.length)
                    : `${projectGroup.tasks.length} ${projectGroup.tasks.length === 1 ? text.activeTask : text.activeTasks} · ${stateLabel}`;
                return {
                    id: projectGroup.project ? `project:${projectGroup.project.id}` : `single:${id}`,
                    projectId: projectGroup.project?.id ?? null,
                    isSingleActions,
                    title: groupTitle,
                    nextActionState: state,
                    tasks: projectGroup.tasks,
                    summary: projectSummary,
                    summaryText: isSingleActions ? `${projectSummary} · ${text.singleActions}` : projectSummary,
                    accessibilityLabel: `${groupTitle}, ${projectSummary}`,
                    // Delegated (waiting) stays amber; truly stuck turns red (#1086).
                    statusTone: scope === 'due' || isSingleActions ? null : state === 'next' ? 'success' : state === 'waiting' ? 'warning' : 'danger',
                    summaryTone: scope === 'all' && !isSingleActions && state === 'none' ? 'warning' : 'secondary',
                };
            }),
        };
    });
}

/** The task sort Review applies. */
export const getReviewOverviewSortBy = (settings: AppSettings | undefined) => resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);

export type ReviewExpansion = { areaIds: string[]; projectIds: string[] };

/**
 * The expand button: it opens every area, then every project, then folds all.
 * `next` is the expansion after pressing it (null: nothing to expand).
 */
export function getReviewExpansionControl(
    groups: readonly ReviewAreaSection[],
    expanded: { areaIds: ReadonlySet<string>; projectIds: ReadonlySet<string> },
    text: ReviewOverviewText,
) {
    const areaIds = groups.map((group) => group.id);
    const projectIds = groups.flatMap((group) => group.projectGroups.map((projectGroup) => projectGroup.id));
    const allAreasExpanded = areaIds.length > 0 && areaIds.every((id) => expanded.areaIds.has(id));
    const allProjectsExpanded = projectIds.length > 0 && projectIds.every((id) => expanded.projectIds.has(id));
    const next: ReviewExpansion | null = !areaIds.length
        ? null
        : !allAreasExpanded
            ? { areaIds, projectIds: [] }
            : !allProjectsExpanded ? { areaIds, projectIds } : { areaIds: [], projectIds: [] };
    return {
        label: !allAreasExpanded ? text.expandAreas : allProjectsExpanded ? text.collapseEverything : text.expandEverything,
        disabled: areaIds.length === 0,
        /** Everything is open: the button shows "collapse". */
        allExpanded: allAreasExpanded && allProjectsExpanded,
        next,
    };
}

/** One area or project header tapped: open it, or fold it again. */
export function toggleReviewExpandedId(ids: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
}

/** What Review's Share sends for the selected tasks: titles and checklists. */
export function buildReviewShareText(tasks: readonly Task[]): string {
    const lines: string[] = [];
    tasks.forEach((task) => {
        lines.push(`- ${task.title}`);
        task.checklist?.forEach((item) => {
            if (!item.title) return;
            lines.push(`  - ${item.isCompleted ? '[x]' : '[ ]'} ${item.title}`);
        });
    });
    return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Pause and resume, shared by both review wizards.

export type WeeklyReviewStepId = 'inbox' | 'stale' | 'calendar' | 'waiting' | 'contexts' | 'projects' | 'someday' | 'completed';
export type DailyReviewStepId = 'today' | 'focus' | 'inbox' | 'waiting' | 'completed';

const WEEKLY_REVIEW_STEP_IDS: ReadonlySet<WeeklyReviewStepId> = new Set<WeeklyReviewStepId>([
    'inbox', 'stale', 'calendar', 'waiting', 'contexts', 'projects', 'someday', 'completed',
]);
const DAILY_REVIEW_STEP_IDS: ReadonlySet<DailyReviewStepId> = new Set<DailyReviewStepId>(['today', 'focus', 'inbox', 'waiting', 'completed']);

/** Device-local storage keys: where a paused review and the last finished Weekly Review are kept. */
export const WEEKLY_REVIEW_SESSION_STORAGE_KEY = 'mindwtr:weeklyReview:currentStep';
export const DAILY_REVIEW_SESSION_STORAGE_KEY = 'mindwtr:dailyReview:currentStep';
export const LAST_WEEKLY_REVIEW_STORAGE_KEY = 'lastWeeklyReview';

/**
 * The review a wizard opens with: the stored one when it is from this week (weekly)
 * or today (daily), else a new one on the first step.
 */
export function restoreReviewSession<Step extends WeeklyReviewStepId | DailyReviewStepId>(
    cadence: ReviewSessionCadence,
    stored: string | null | undefined,
    options: { now: Date; weekStart?: string | null },
): { session: StoredReviewStepSession<Step>; resumed: boolean } {
    const restored = cadence === 'weekly'
        ? parseStoredReviewStepSession(stored, WEEKLY_REVIEW_STEP_IDS as ReadonlySet<Step>, { cadence, now: options.now, weekStart: options.weekStart })
        : parseStoredReviewStepSession(stored, DAILY_REVIEW_STEP_IDS as ReadonlySet<Step>, { cadence, now: options.now });
    if (restored) return { session: restored, resumed: true };
    return { session: { step: (cadence === 'weekly' ? 'inbox' : 'today') as Step, startedAt: options.now.toISOString() }, resumed: false };
}

/** What a wizard stores after every step change. */
export const serializeReviewSession = (session: StoredReviewStepSession<WeeklyReviewStepId | DailyReviewStepId>): string => (
    JSON.stringify({ step: session.step, startedAt: session.startedAt })
);

export type ReviewStepRailItem = { id: string; title: string; number: number; state: 'current' | 'complete' | 'pending' };

/** The Weekly Review's step rail: steps without work count as done. */
export function getReviewStepRail(
    steps: readonly (ReviewStepFlags & { title: string })[],
    displayedStep: string,
    currentStepIndex: number,
): ReviewStepRailItem[] {
    return steps.map((step, index) => {
        const skipped = !step.hasWork && step.id !== 'completed';
        return {
            id: step.id,
            title: step.title,
            number: index + 1,
            state: step.id === displayedStep ? 'current' : skipped || index < currentStepIndex ? 'complete' : 'pending',
        };
    });
}

/** The calendar window a review fetches: `days` days from the start of `day`. */
export function getReviewCalendarRange(day: Date, days: number): { start: Date; end: Date } {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    end.setMilliseconds(-1);
    return { start, end };
}

/** "+3 More" under a folded list. */
const formatReviewMoreLabel = (hidden: number, more: string) => `+${hidden} ${more}`;

// ---------------------------------------------------------------------------
// Weekly Review.

const defaultWeeklyReviewLabels = {
    weeklyReview: 'Weekly Review',
    inbox: 'Inbox',
    ai: 'AI Insight',
    stale: 'Stale items',
    staleDesc: 'No recent activity. Update each one, complete it, or let it go.',
    staleDaysInactive: '{{days}} days inactive',
    calendar: 'Calendar',
    waiting: 'Waiting For',
    contexts: 'Contexts',
    projects: 'Projects',
    someday: 'Someday/Maybe',
    done: 'Done!',
    timeFor: 'Time for Weekly Review!',
    timeForDesc: 'Take a few minutes to get your system clean and clear.',
    startReview: 'Start Review',
    inboxDesc: 'Clear Your Inbox',
    inboxGuide: 'Process each item: delete it, delegate it, set a next action, or move to Someday. Goal: inbox zero!',
    itemsInInbox: 'items in inbox',
    inboxEmpty: 'Great job! Inbox is empty!',
    aiDesc: 'AI highlights stale tasks and cleanup suggestions.',
    aiRun: 'Run analysis',
    aiRunning: 'Analyzing...',
    aiEmpty: 'No stale items found.',
    aiApply: 'Apply selected',
    aiActionSomeday: 'Move to Someday',
    aiActionArchive: 'Archive',
    aiActionBreakdown: 'Needs breakdown',
    aiActionKeep: 'Keep',
    loading: 'Loading…',
    calendarDesc: 'Review your hard landscape first: a compact summary of the next 7 days.',
    calendarEmpty: 'No calendar events in this range.',
    calendarUpcoming: 'Next 7 days',
    calendarTasks: 'Mindwtr tasks (next 7 days)',
    calendarTasksEmpty: 'No scheduled/due tasks in this range.',
    dueLabel: 'Due',
    startLabel: 'Start',
    allDay: 'All day',
    more: 'more',
    less: 'less',
    addTask: 'Add task',
    addTaskPlaceholder: 'Enter task title',
    saveAndEdit: 'Save & edit',
    cancel: 'Cancel',
    add: 'Add',
    waitingDesc: 'Follow Up on Waiting Items',
    waitingGuide: 'Check each item: need to follow up? Mark done if resolved. Add notes for context.',
    contextsDesc: 'Review your contexts and make sure each one has clear next actions.',
    contextsEmpty: 'No contexts with active tasks.',
    nothingWaiting: 'Nothing waiting - all clear!',
    notDueYet: 'Not due yet',
    projectsDesc: 'Review Your Projects',
    projectsGuide: 'Each active project needs a clear next action. Projects without next actions get stuck!',
    noActiveProjects: 'No active projects',
    somedayDesc: 'Revisit Someday/Maybe',
    somedayGuide: 'Anything you want to start now? Anything no longer interesting? Activate it or delete it.',
    listEmpty: 'List is empty',
    reviewComplete: 'Review Complete!',
    completeDesc: 'Your system is clean and you\'re ready for the week ahead!',
    summaryInboxEmpty: 'Inbox is empty',
    summaryInboxCount: '{{count}} item(s) still in Inbox',
    summaryProjectsOk: 'Every active project has a next action',
    summaryProjectsMissing: '{{count}} project(s) have no next action',
    summaryWaitingStale: '{{count}} waiting item(s) untouched for more than two weeks',
    weekHeading: 'This week',
    weekCompletedCount: '{{count}} action(s) completed this week',
    weekProjectsMovedCount: '{{count}} project(s) moved forward',
    weekEstimatedTasksCount: '{{count}} completed task(s) had an estimate',
    weekEstimatedTotal: 'Estimated: {{duration}}',
    weekTrackedTotal: 'Tracked on those tasks: {{duration}}',
    finish: 'Finish',
    next: 'Next',
    back: 'Back',
    hasNext: '✓ Has Next',
    waitingStatus: 'Waiting',
    needsAction: '! Needs Action',
    activeTask: 'active task',
    activeTasks: 'active tasks',
    moreItems: 'more items',
};

export type WeeklyReviewLabels = Record<keyof typeof defaultWeeklyReviewLabels, string>;

const weeklyReviewLabelKeys: WeeklyReviewLabels = {
    weeklyReview: 'settings.weeklyReview',
    inbox: 'nav.inbox',
    ai: 'review.aiStep',
    stale: 'review.staleStep',
    staleDesc: 'review.staleStepDesc',
    staleDaysInactive: 'review.staleDaysInactive',
    calendar: 'nav.calendar',
    waiting: 'review.waitingStep',
    contexts: 'review.contexts',
    projects: 'nav.projects',
    someday: 'review.somedayStep',
    done: 'review.allDone',
    timeFor: 'review.timeFor',
    timeForDesc: 'review.timeForDesc',
    startReview: 'review.startReview',
    inboxDesc: 'review.inboxStep',
    inboxGuide: 'review.inboxGuide',
    itemsInInbox: 'review.inboxZeroDesc',
    inboxEmpty: 'review.inboxEmpty',
    aiDesc: 'review.aiStepDesc',
    aiRun: 'review.aiRun',
    aiRunning: 'review.aiRunning',
    aiEmpty: 'review.aiEmpty',
    aiApply: 'review.aiApply',
    aiActionSomeday: 'review.aiAction.someday',
    aiActionArchive: 'review.aiAction.archive',
    aiActionBreakdown: 'review.aiAction.breakdown',
    aiActionKeep: 'review.aiAction.keep',
    loading: 'common.loading',
    calendarDesc: 'review.calendarStepDesc',
    calendarEmpty: 'review.calendarEmpty',
    calendarUpcoming: 'review.upcoming14',
    calendarTasks: 'review.calendarTasks',
    calendarTasksEmpty: 'review.calendarTasksEmpty',
    dueLabel: 'taskEdit.dueDateLabel',
    startLabel: 'taskEdit.startDateLabel',
    allDay: 'calendar.allDay',
    more: 'common.more',
    less: 'common.less',
    addTask: 'nav.addTask',
    addTaskPlaceholder: 'review.addTaskPlaceholder',
    saveAndEdit: 'quickAdd.saveAndEdit',
    cancel: 'common.cancel',
    add: 'common.add',
    waitingDesc: 'review.waitingStepDesc',
    waitingGuide: 'review.waitingHint',
    contextsDesc: 'review.contextsStepDesc',
    contextsEmpty: 'review.contextsEmpty',
    nothingWaiting: 'review.waitingEmpty',
    notDueYet: 'review.notDueYet',
    projectsDesc: 'review.projectsStep',
    projectsGuide: 'review.projectsHint',
    noActiveProjects: 'review.noActiveTasks',
    somedayDesc: 'review.somedayStepDesc',
    somedayGuide: 'review.somedayHint',
    listEmpty: 'review.listEmpty',
    reviewComplete: 'review.complete',
    completeDesc: 'review.completeDesc',
    summaryInboxEmpty: 'review.summaryInboxEmpty',
    summaryInboxCount: 'review.summaryInboxCount',
    summaryProjectsOk: 'review.summaryProjectsOk',
    summaryProjectsMissing: 'review.summaryProjectsMissing',
    summaryWaitingStale: 'review.summaryWaitingStale',
    weekHeading: 'review.weekHeading',
    weekCompletedCount: 'review.weekCompletedCount',
    weekProjectsMovedCount: 'review.weekProjectsMovedCount',
    weekEstimatedTasksCount: 'review.weekEstimatedTasksCount',
    weekEstimatedTotal: 'review.weekEstimatedTotal',
    weekTrackedTotal: 'review.weekTrackedTotal',
    finish: 'review.finish',
    next: 'review.next',
    back: 'review.back',
    hasNext: 'review.hasNextAction',
    waitingStatus: 'status.waiting',
    needsAction: 'review.needsAction',
    activeTask: 'review.activeTask',
    activeTasks: 'review.activeTasks',
    moreItems: 'review.moreItems',
};

/** Every Weekly Review label in the current language, with English where a key is missing. */
export function getWeeklyReviewLabels(t?: Translate): WeeklyReviewLabels {
    return Object.fromEntries(
        (Object.keys(defaultWeeklyReviewLabels) as (keyof WeeklyReviewLabels)[]).map((key) => [
            key,
            t ? tFallback(t, weeklyReviewLabelKeys[key], defaultWeeklyReviewLabels[key]) : defaultWeeklyReviewLabels[key],
        ]),
    ) as WeeklyReviewLabels;
}

/** The settings the Weekly Review reads. */
export function getWeeklyReviewSettings(settings: AppSettings | undefined) {
    return {
        aiEnabled: settings?.ai?.enabled === true,
        includeContextStep: settings?.gtd?.weeklyReview?.includeContextStep !== false,
        weekStart: settings?.weekStart,
    };
}

export type WeeklyReviewStep = ReviewStepFlags & { id: WeeklyReviewStepId; title: string };

/** The steps in order with their titles; which have work comes from buildReviewSteps. */
export function titleWeeklyReviewSteps(flags: readonly ReviewStepFlags[], labels: WeeklyReviewLabels): WeeklyReviewStep[] {
    const titles: Record<WeeklyReviewStepId, string> = {
        inbox: labels.inbox,
        stale: labels.stale,
        calendar: labels.calendar,
        waiting: labels.waiting,
        contexts: labels.contexts,
        projects: labels.projects,
        someday: labels.someday,
        completed: labels.done,
    };
    return flags.map((flag) => ({ ...flag, id: flag.id as WeeklyReviewStepId, title: titles[flag.id as WeeklyReviewStepId] }));
}

/** The stale step: tasks (in the order found, among the tasks on screen) and projects. */
export function getWeeklyReviewStale(staleItems: readonly ReviewSnapshotItem[], tasks: readonly Task[], labels: WeeklyReviewLabels) {
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return {
        tasks: staleItems.flatMap((item) => {
            if (item.id.startsWith('project:')) return [];
            const task = taskById.get(item.id);
            return task ? [task] : [];
        }),
        projects: staleItems.filter((item) => item.id.startsWith('project:')).map((item) => ({
            id: item.id,
            title: item.title,
            daysLabel: formatI18nTemplate(labels.staleDaysInactive, { days: item.daysStale }),
        })),
    };
}

/** How many of a folded list the Weekly Review shows. */
export const WEEKLY_REVIEW_PREVIEW = { contextTasks: 4, dayEvents: 2, calendarTasks: 12 } as const;

export type WeeklyReviewCalendarDay = {
    key: string;
    dayStart: Date;
    title: string;
    totalCount: number;
    events: { key: string; title: string; timeLabel: string }[];
    /** "+1 More" while folded; null when every event already shows. */
    moreLabel: string | null;
};

/** The calendar step's external days (non-empty, 7 days) and its first 12 task dates. */
export function getWeeklyReviewCalendar(
    days: readonly ExternalCalendarDaySummary[],
    items: readonly CalendarReviewEntry[],
    labels: WeeklyReviewLabels,
    formatDate: DateFormatter,
) {
    return {
        days: days.map((day): WeeklyReviewCalendarDay => ({
            key: day.dayStart.toISOString(),
            dayStart: day.dayStart,
            title: `${formatDate(day.dayStart, 'EEEE, PP')} · ${day.totalCount}`,
            totalCount: day.totalCount,
            events: day.events.map((event) => {
                const start = safeParseDate(event.start);
                return {
                    key: `${event.sourceId}-${event.id}-${event.start}`,
                    title: event.title,
                    timeLabel: event.allDay || !start ? labels.allDay : formatDate(start, 'p'),
                };
            }),
            moreLabel: day.totalCount > WEEKLY_REVIEW_PREVIEW.dayEvents
                ? formatReviewMoreLabel(day.totalCount - WEEKLY_REVIEW_PREVIEW.dayEvents, labels.more)
                : null,
        })),
        tasks: items.slice(0, WEEKLY_REVIEW_PREVIEW.calendarTasks).map((entry) => ({
            key: `${entry.kind}-${entry.task.id}-${entry.date.toISOString()}`,
            task: entry.task,
            title: entry.task.title,
            meta: `${entry.kind === 'due' ? labels.dueLabel : labels.startLabel} · ${formatDate(entry.date, hasTimeComponent(entry.kind === 'due' ? entry.task.dueDate : entry.task.startTime) ? 'Pp' : 'P')}`,
        })),
    };
}

/** What the upcoming column shows instead of days: loading, the fetch error, or its empty text. */
export function getWeeklyReviewCalendarNotice(
    state: { loading: boolean; error: string | null; dayCount: number },
    labels: WeeklyReviewLabels,
): string | null {
    if (state.loading) return labels.loading;
    if (state.error) return state.error;
    return state.dayCount === 0 ? labels.calendarEmpty : null;
}

/** Waiting or Someday: due and unscheduled show; "Not due yet" folds the rest. */
export function getWeeklyReviewScheduledList(groups: ReviewSchedulePartition<Task>, labels: WeeklyReviewLabels) {
    return {
        visible: [...groups.due, ...groups.unscheduled],
        scheduled: groups.scheduled,
        total: groups.due.length + groups.scheduled.length + groups.unscheduled.length,
        scheduledLabel: `${labels.notDueYet} (${groups.scheduled.length})`,
    };
}

/** A context's card: its first four tasks until unfolded. */
export function getWeeklyReviewContextMoreLabel(taskCount: number, labels: WeeklyReviewLabels): string | null {
    return taskCount > WEEKLY_REVIEW_PREVIEW.contextTasks
        ? formatReviewMoreLabel(taskCount - WEEKLY_REVIEW_PREVIEW.contextTasks, labels.more)
        : null;
}

const PROJECT_BADGES: Record<ProjectNextActionState, { label: keyof WeeklyReviewLabels; color: string; background: string }> = {
    next: { label: 'hasNext', color: '#10B981', background: '#10B98120' },
    // Delegated (waiting) is amber, not the red alarm (#1086).
    waiting: { label: 'waitingStatus', color: '#F59E0B', background: '#F59E0B20' },
    none: { label: 'needsAction', color: '#EF4444', background: '#EF444420' },
};

export type WeeklyReviewProject = WeeklyReviewProjectEntry & {
    /** Project identity color; the historical field name is retained for native compatibility. */
    areaColor: string | null;
    badge: { label: string; color: string; background: string };
    countLabel: string;
};

export function getWeeklyReviewProjects(
    entries: readonly WeeklyReviewProjectEntry[],
    areaById: ReadonlyMap<string, Area>,
    labels: WeeklyReviewLabels,
): WeeklyReviewProject[] {
    return entries.map((entry) => {
        const badge = PROJECT_BADGES[entry.nextActionState];
        return {
            ...entry,
            areaColor: getProjectAccentColor(entry.project, areaById) || null,
            badge: { label: labels[badge.label], color: badge.color, background: badge.background },
            countLabel: `${entry.tasks.length} ${entry.tasks.length === 1 ? labels.activeTask : labels.activeTasks}`,
        };
    });
}

/** The last step: this week's look-back (when anything was completed) and the system check. */
export function getWeeklyReviewCompletion(
    buckets: Pick<WeeklyReviewBuckets, 'lookBack' | 'summary'>,
    settings: AppSettings | undefined,
    labels: WeeklyReviewLabels,
) {
    const { lookBack, summary } = buckets;
    const estimated = formatTimeSpentLabel(lookBack.estimatedMinutes);
    const tracked = formatTimeSpentLabel(lookBack.trackedMinutes);
    // Time estimates default ON; both flags go through resolveFeatureFlags.
    const features = resolveFeatureFlags(settings);
    const showEstimates = lookBack.estimatedTaskCount > 0 && features.timeEstimates;
    const showTracked = showEstimates && tracked !== null && features.pomodoro && settings?.gtd?.pomodoro?.linkTask === true;
    const week = lookBack.completedCount > 0 ? {
        heading: labels.weekHeading,
        rows: [
            formatI18nTemplate(labels.weekCompletedCount, { count: lookBack.completedCount }),
            ...(lookBack.projectsMovedCount > 0 ? [formatI18nTemplate(labels.weekProjectsMovedCount, { count: lookBack.projectsMovedCount })] : []),
            ...(showEstimates ? [
                formatI18nTemplate(labels.weekEstimatedTasksCount, { count: lookBack.estimatedTaskCount }),
                ...(estimated ? [formatI18nTemplate(labels.weekEstimatedTotal, { duration: estimated })] : []),
                ...(showTracked ? [formatI18nTemplate(labels.weekTrackedTotal, { duration: tracked })] : []),
            ] : []),
        ],
    } : null;
    const checks: { good: boolean; text: string }[] = [{
        good: summary.inboxCount === 0,
        text: summary.inboxCount === 0 ? labels.summaryInboxEmpty : formatI18nTemplate(labels.summaryInboxCount, { count: summary.inboxCount }),
    }];
    if (summary.activeProjectCount > 0) {
        checks.push({
            good: summary.projectsWithoutNextAction === 0,
            text: summary.projectsWithoutNextAction === 0
                ? labels.summaryProjectsOk
                : formatI18nTemplate(labels.summaryProjectsMissing, { count: summary.projectsWithoutNextAction }),
        });
    }
    if (summary.staleWaitingCount > 0) {
        checks.push({ good: false, text: formatI18nTemplate(labels.summaryWaitingStale, { count: summary.staleWaitingCount }) });
    }
    return { week, checks };
}

/** AI suggestions the review can apply: someday or archive, for tasks only. */
export const isActionableReviewSuggestion = (suggestion: Pick<ReviewSuggestion, 'id' | 'action'>) => (
    !suggestion.id.startsWith('project:') && (suggestion.action === 'someday' || suggestion.action === 'archive')
);

export function getReviewSuggestionActionLabel(action: ReviewSuggestion['action'], labels: WeeklyReviewLabels): string {
    if (action === 'someday') return labels.aiActionSomeday;
    if (action === 'archive') return labels.aiActionArchive;
    if (action === 'breakdown') return labels.aiActionBreakdown;
    return labels.aiActionKeep;
}

/** Suggestions for items the review offered, as shown (and so as applied). */
export type TitledReviewSuggestion = ReviewSuggestion & { title: string };
export const filterReviewSuggestions = (suggestions: readonly ReviewSuggestion[], staleItems: readonly ReviewSnapshotItem[]): TitledReviewSuggestion[] => {
    const titleById = new Map(staleItems.map((item) => [item.id, item.title]));
    return filterReviewSuggestionsToKnownIds([...suggestions], staleItems.map((item) => item.id))
        .map((suggestion) => ({ ...suggestion, title: titleById.get(suggestion.id) ?? suggestion.id }));
};

/** Apply selected: someday, or archived and completed now. */
export function buildReviewSuggestionUpdates(
    suggestions: readonly ReviewSuggestion[],
    selectedIds: ReadonlySet<string>,
    now: Date,
): { id: string; updates: Partial<Task> }[] {
    return suggestions
        .filter((suggestion) => selectedIds.has(suggestion.id))
        .filter(isActionableReviewSuggestion)
        .map((suggestion) => (suggestion.action === 'someday'
            ? { id: suggestion.id, updates: { status: 'someday' as TaskStatus } }
            : { id: suggestion.id, updates: { status: 'archived' as TaskStatus, completedAt: now.toISOString() } }));
}

/**
 * The project step's Add task: the quick-add grammar, as in the project next-action
 * prompt (#859). Null for a blank title.
 */
export function planReviewProjectTask(input: {
    title: string;
    projectId: string;
    projects: Project[];
    areas: Area[];
    settings: AppSettings | undefined;
    tasks: Task[];
    people: readonly Person[];
    now?: Date;
}): { title: string; props: Partial<Task> } | null {
    const raw = input.title.trim();
    if (!raw) return null;
    const { title, props } = parseProjectNextActionInput(raw, {
        projectId: input.projectId,
        projects: input.projects,
        areas: input.areas,
        now: input.now,
        parseOptions: buildQuickAddParseOptions(input.settings, { tasks: input.tasks, people: input.people }),
    });
    return { title, props };
}

// ---------------------------------------------------------------------------
// Daily Review.

/** The settings the Daily Review reads. */
export function getDailyReviewSettings(settings: AppSettings | undefined) {
    return {
        sortBy: resolveNonDoneTaskSortBy(settings?.taskSortBy, settings),
        includeFocusStep: settings?.gtd?.dailyReview?.includeFocusStep !== false,
        focusTaskLimit: normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit),
    };
}

export type DailyReviewStep = ReviewStepFlags & { id: DailyReviewStepId; title: string; description: string };

/** The steps in order with titles and descriptions; which have work comes from buildReviewSteps. */
export function titleDailyReviewSteps(flags: readonly ReviewStepFlags[], t: Translate): DailyReviewStep[] {
    const text: Record<DailyReviewStepId, [string, string]> = {
        today: ['dailyReview.todayStep', 'dailyReview.todayDesc'],
        inbox: ['dailyReview.inboxStep', 'dailyReview.inboxDesc'],
        waiting: ['dailyReview.waitingStep', 'dailyReview.waitingDesc'],
        focus: ['dailyReview.focusStep', 'dailyReview.focusDesc'],
        completed: ['dailyReview.completeTitle', 'dailyReview.completeDesc'],
    };
    return flags.map((flag) => {
        const [title, description] = text[flag.id as DailyReviewStepId];
        return { ...flag, id: flag.id as DailyReviewStepId, title: t(title), description: t(description) };
    });
}

export function getDailyReviewText(t: Translate, focusTaskLimit: number) {
    return {
        title: t('dailyReview.title'),
        completeTitle: t('dailyReview.completeTitle'),
        tasks: t('common.tasks'),
        focusSelected: t('dailyReview.focusSelected'),
        events: t('calendar.events'),
        loading: t('common.loading'),
        noEvents: t('calendar.noTasks'),
        allDay: t('calendar.allDay'),
        todayEmpty: t('agenda.noTasks'),
        focusEmpty: formatFocusTaskLimitText(t('agenda.focusHint'), focusTaskLimit),
        inboxEmpty: t('review.inboxEmpty'),
        waitingEmpty: t('review.waitingEmpty'),
        processInbox: t('inbox.processButton'),
        followUpToday: tFallback(t, 'dailyReview.followUpToday', 'Follow up today'),
        reviewDue: tFallback(t, 'agenda.reviewDue', 'Review Due'),
        back: t('review.back'),
        next: t('review.nextStepBtn'),
        finish: t('review.finish'),
        close: t('common.close'),
    };
}
export type DailyReviewText = ReturnType<typeof getDailyReviewText>;

/** "Step 2 of 5". */
export const formatDailyReviewStepLabel = (t: Translate, index: number, count: number) => (
    `${t('review.step')} ${index + 1} ${t('review.of')} ${count}`
);

/** The Daily Review shows five events a day. */
const DAILY_REVIEW_EVENT_PREVIEW = 5;

/** One day's calendar card, with a five-event preview by default. */
export function getDailyReviewCalendarDay(
    events: readonly ExternalCalendarEvent[],
    day: Date,
    text: DailyReviewText,
    formatDate: DateFormatter,
    eventLimit = DAILY_REVIEW_EVENT_PREVIEW,
) {
    const dayEvents = getExternalCalendarEventsForDay(events, day);
    return {
        title: `${formatDate(day, 'P')} · ${text.events}`,
        count: dayEvents.length,
        events: dayEvents.slice(0, eventLimit).map((event) => {
            const start = safeParseDate(event.start);
            const end = safeParseDate(event.end);
            return {
                key: `${event.sourceId}-${event.id}-${event.start}`,
                title: event.title,
                timeLabel: event.allDay || !start || !end ? text.allDay : `${formatDate(start, 'p')} - ${formatDate(end, 'p')}`,
            };
        }),
    };
}

/** The Today step's list: overdue first, then due today. */
export const getDailyReviewTodayTasks = (buckets: Pick<DailyReviewBuckets, 'overdue' | 'dueToday'>) => [...buckets.overdue, ...buckets.dueToday];

/** The day a review stands on: local midnight. */
export const getReviewDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

/** A waiting row's "Follow up today": off once the item is due for review. */
export function getDailyReviewFollowUp(task: Task, today: Date, text: Pick<DailyReviewText, 'followUpToday' | 'reviewDue'>) {
    const due = isDueForReview(task.reviewAt, today);
    return {
        due,
        label: due ? text.reviewDue : text.followUpToday,
        accessibilityLabel: `${text.followUpToday}: ${task.title}`,
    };
}

/** Follow up today sets the review date to the start of today; nothing once it is due. */
export function planDailyReviewFollowUp(task: Task, today: Date): { reviewAt: string } | null {
    if (isDueForReview(task.reviewAt, today)) return null;
    return { reviewAt: createDateFormatter({ calendarSystem: 'gregorian' })(getReviewDay(today), 'yyyy-MM-dd') };
}
