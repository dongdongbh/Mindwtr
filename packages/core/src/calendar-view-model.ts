


import { taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import {
    buildCalendarDayItems,
    getCalendarDistinctDeadlines,
    buildTimedCalendarLayouts,
    getTaskCompletionInstant,
    isCompletedCalendarTask,
    isSchedulableCalendarTask,
    orderCalendarDayItemsForLimitedSlots,
    type CalendarDayItem,
    type CalendarTimedLayout,
    type CalendarTimedLayoutInput,
} from './calendar-day-items';
import { setComposerStart, type CalendarComposerError, type CalendarComposerState } from './calendar-composer';
import { formatListItemCount } from './list-count';
import {
    DEFAULT_CALENDAR_DAY_END_HOUR,
    DEFAULT_CALENDAR_DAY_START_HOUR,
    buildCalendarEventTaskDraft,
    findFreeSlotForDay,
    formatCalendarTimeInputValue,
    isSlotFreeForDay,
    minutesToTimeEstimate,
    parseCalendarTimeOnDate,
} from './calendar-scheduling';
import {
    addCalendarMonths,
    getCalendarMonthIndex,
    getShortWeekdayLabels,
    hasTimeComponent,
    normalizeDateFormatSetting,
    resolveCalendarSystemSetting,
    resolveDateLocaleTag,
    safeParseDate,
    safeParseDueDate,
    startOfCalendarMonth,
    type CalendarSystemSetting,
    type DateFormatter,
} from './date';
import { resolveExternalCalendarColor, themeExternalCalendarDisplayColor } from './external-calendar-colors';
import { resolveI18nText, type I18nTemplateValues } from './i18n';
import type { ExternalCalendarEvent, ExternalCalendarSubscription } from './ics';
import { isTaskInCalendarHistoryProject } from './project-utils';
import { formatQuickAddHelp } from './quick-add';
import { expandCalendarRecurringTaskSetInRange, getTaskCalendarOccurrenceDate, isProjectedRecurringTask, isProjectedRecurringTaskId } from './recurrence';
import { isTaskFinished } from './task-status';
import { getCalendarPlanningCandidates } from './task-utils';
import type { AppSettings, Area, Project, Section, Task } from './types';

type Translate = (key: string) => string;


export type CalendarViewMode = 'month' | 'day' | 'week' | 'schedule';

export const CALENDAR_WEEK_VISIBLE_DAYS_MIN = 2;
export const CALENDAR_WEEK_VISIBLE_DAYS_MAX = 7;


export const CALENDAR_WEEK_VISIBLE_DAYS_DEFAULT = 5;


export const CALENDAR_DAY_START_HOUR = 0;
export const CALENDAR_DAY_END_HOUR = 24;
export const CALENDAR_DAY_MINUTES = (CALENDAR_DAY_END_HOUR - CALENDAR_DAY_START_HOUR) * 60;
export const CALENDAR_SNAP_MINUTES = 5;

export const CALENDAR_SCHEDULE_DAYS = 45;
export const CALENDAR_SCHEDULE_MAX_SECTIONS = 18;
export const CALENDAR_PLANNING_LIMIT = 6;
export const CALENDAR_SEARCH_LIMIT = 8;
export const CALENDAR_COMPOSER_CANDIDATE_LIMIT = 10;

export const CALENDAR_MONTH_PREVIEW_ITEMS = 2;
export const CALENDAR_MONTH_PREVIEW_HIDDEN_AT = 6;
export const CALENDAR_WEEK_ALL_DAY_ITEMS = 3;

export const CALENDAR_DAY_ALL_DAY_ITEMS = 4;

export const CALENDAR_TAP_DURATION_MINUTES = 30;

/** The grid steps a day timeline may snap to, shortest first. */
export const CALENDAR_GRID_STEP_OPTIONS: readonly number[] = [5, 10, 15, 30, 60];
/** The default keeps the drag and tap snap the screen has always had. */
export const CALENDAR_GRID_STEP_DEFAULT = CALENDAR_SNAP_MINUTES;
/** The day timeline's zoom multiplies the screen's base pixels per minute; the week stays fixed. */
export const CALENDAR_TIMELINE_ZOOM_OPTIONS: readonly number[] = [0.75, 1, 1.5, 2];
export const CALENDAR_TIMELINE_ZOOM_DEFAULT = 1;
export const CALENDAR_TIMELINE_ZOOM_MIN = CALENDAR_TIMELINE_ZOOM_OPTIONS[0];
export const CALENDAR_TIMELINE_ZOOM_MAX = CALENDAR_TIMELINE_ZOOM_OPTIONS[CALENDAR_TIMELINE_ZOOM_OPTIONS.length - 1];

/** The stored grid step, or the default when it is not one a timeline offers. */
export const coerceCalendarGridStep = (value?: number | null): number => {
    const step = Number(value);
    return CALENDAR_GRID_STEP_OPTIONS.includes(step) ? step : CALENDAR_GRID_STEP_DEFAULT;
};

/** The stored zoom, clamped to the range the timeline offers. */
export const coerceCalendarTimelineZoom = (value?: number | null): number => {
    const zoom = Number(value);
    if (!Number.isFinite(zoom)) return CALENDAR_TIMELINE_ZOOM_DEFAULT;
    return Math.max(CALENDAR_TIMELINE_ZOOM_MIN, Math.min(CALENDAR_TIMELINE_ZOOM_MAX, zoom));
};

/** The zoom choices' labels: "75%", "100%", "150%", "200%". */
export const formatCalendarTimelineZoomLabel = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/** The sub-hour minutes the timeline draws grid lines at for `gridStep`; 60 leaves the hour lines alone. */
export const getCalendarGridLineMinutes = (gridStep: number): number[] => {
    const step = Number(gridStep);
    if (!Number.isFinite(step) || step <= 0 || step >= CALENDAR_DAY_MINUTES) return [];
    const minutes: number[] = [];
    for (let minute = step; minute < CALENDAR_DAY_MINUTES; minute += step) {
        if (minute % 60 !== 0) minutes.push(minute);
    }
    return minutes;
};

export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = ['month', 'day', 'week', 'schedule'];

export const coerceCalendarViewMode = (value?: string | null): CalendarViewMode => (
    value === 'day' || value === 'week' || value === 'schedule' ? value : 'month'
);

export const needsCalendarSelectedDate = (viewMode: CalendarViewMode): boolean => (
    viewMode === 'day' || viewMode === 'week' || viewMode === 'schedule'
);

export const getInitialCalendarSelectedDate = (
    viewMode: CalendarViewMode,
    today: Date = new Date(),
): Date | null => (
    needsCalendarSelectedDate(viewMode) ? new Date(today) : null
);

export const shiftCalendarVisibleMonth = (
    visibleMonth: Date,
    months: number,
    calendarSystem: CalendarSystemSetting,
): Date => startOfCalendarMonth(
    addCalendarMonths(visibleMonth, months, calendarSystem),
    calendarSystem,
);

export const coerceCalendarWeekVisibleDays = (value?: number | null): number => {
    if (!Number.isFinite(value)) return CALENDAR_WEEK_VISIBLE_DAYS_DEFAULT;
    return Math.max(
        CALENDAR_WEEK_VISIBLE_DAYS_MIN,
        Math.min(CALENDAR_WEEK_VISIBLE_DAYS_MAX, Math.round(value as number)),
    );
};


export const getCalendarWeekVisibleDaysUpdate = ({
    currentVisibleDays,
    requestedVisibleDays,
}: {
    currentVisibleDays: number;
    requestedVisibleDays: number;
}): number | null => {
    const current = coerceCalendarWeekVisibleDays(currentVisibleDays);
    const requested = coerceCalendarWeekVisibleDays(requestedVisibleDays);
    return current === requested ? null : requested;
};


export const CALENDAR_WEEK_DENSITY_VALUES: readonly number[] = Array.from(
    { length: CALENDAR_WEEK_VISIBLE_DAYS_MAX - CALENDAR_WEEK_VISIBLE_DAYS_MIN + 1 },
    (_, index) => CALENDAR_WEEK_VISIBLE_DAYS_MIN + index,
);


export const calendarDateKey = (date: Date): string => (
    `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
);

export const isSameCalendarDate = (date: Date, otherDate: Date): boolean => (
    date.getFullYear() === otherDate.getFullYear()
    && date.getMonth() === otherDate.getMonth()
    && date.getDate() === otherDate.getDate()
);

export const addCalendarMapItem = <T,>(map: Map<string, T[]>, date: Date, item: T) => {
    const key = calendarDateKey(date);
    const items = map.get(key);
    if (items) {
        items.push(item);
        return;
    }
    map.set(key, [item]);
};

export const isTimedScheduledTask = (task: Pick<Task, 'startTime'>): boolean => (
    hasTimeComponent(task.startTime)
);

export const isAllDayScheduledTask = (task: Pick<Task, 'startTime'>): boolean => (
    Boolean(task.startTime) && !hasTimeComponent(task.startTime)
);


export const getCalendarLocale = (params: {
    language: string;
    settings: Pick<AppSettings, 'dateFormat' | 'calendarSystem'> | undefined;
    systemLocale: string;
}): string => resolveDateLocaleTag({
    language: params.language,
    dateFormat: normalizeDateFormatSetting(params.settings?.dateFormat),
    calendarSystem: params.settings?.calendarSystem,
    systemLocale: params.systemLocale,
});

export const getCalendarSystem = (params: {
    language: string;
    settings: Pick<AppSettings, 'calendarSystem'> | undefined;
    systemLocale: string;
}): CalendarSystemSetting => resolveCalendarSystemSetting(params.settings?.calendarSystem, {
    language: params.language,
    systemLocale: params.systemLocale,
});

export function getCalendarMonthDates(monthDate: Date, calendarSystem: string): Date[] {
    const firstOfMonth = startOfCalendarMonth(monthDate, calendarSystem);
    const monthIndex = getCalendarMonthIndex(firstOfMonth, calendarSystem);
    const dates: Date[] = [];
    const cursor = new Date(firstOfMonth);
    while (dates.length < 32 && getCalendarMonthIndex(cursor, calendarSystem) === monthIndex) {
        dates.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
}


export function getCalendarMonthGrid(currentMonthDate: Date, monthDates: readonly Date[], weekStartIndex: number): (Date | null)[] {
    const firstDay = (currentMonthDate.getDay() - weekStartIndex + 7) % 7;
    const cells: (Date | null)[] = [];
    for (let index = 0; index < firstDay; index += 1) cells.push(null);
    cells.push(...monthDates);
    return cells;
}

export function getCalendarWeekStart(date: Date, weekStartIndex: number): Date {
    const start = new Date(date);
    const diff = (start.getDay() - weekStartIndex + 7) % 7;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return start;
}

export const getCalendarWeekDays = (weekStartTime: number): Date[] => Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStartTime);
    date.setDate(date.getDate() + index);
    return date;
});


export function getCalendarVisibleRange({
    calendarSystem,
    currentMonthDate,
    selectedDate,
    viewMode,
    weekStartTime,
}: {
    calendarSystem: string;
    currentMonthDate: Date;
    selectedDate: Date | null;
    viewMode: CalendarViewMode;
    weekStartTime: number;
}): { rangeStart: Date; rangeEnd: Date } {
    const weekStart = new Date(weekStartTime);
    const rangeStart = viewMode === 'week'
        ? weekStart
        : viewMode === 'schedule'
            ? new Date(selectedDate ?? currentMonthDate)
            : new Date(currentMonthDate);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = viewMode === 'week'
        ? new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6, 23, 59, 59, 999)
        : viewMode === 'schedule'
            ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + CALENDAR_SCHEDULE_DAYS, 23, 59, 59, 999)
            : new Date(addCalendarMonths(currentMonthDate, 1, calendarSystem).getTime() - 1);
    return { rangeStart, rangeEnd };
}


export type CalendarPeriodState = {
    viewMode: CalendarViewMode;
    selectedDate: Date | null;
    visibleMonthDate: Date;
};

export type CalendarPeriodMove = 'previous' | 'next' | 'today';


export function moveCalendarPeriod(
    state: CalendarPeriodState,
    move: CalendarPeriodMove,
    options: { calendarSystem: CalendarSystemSetting; now?: Date },
): CalendarPeriodState {
    if (move === 'today') {
        const next = options.now ? new Date(options.now) : new Date();
        return { ...state, selectedDate: next, visibleMonthDate: next };
    }
    const direction = move === 'next' ? 1 : -1;
    if (state.viewMode === 'month') {
        const currentMonthDate = startOfCalendarMonth(state.visibleMonthDate, options.calendarSystem);
        return { ...state, visibleMonthDate: shiftCalendarVisibleMonth(currentMonthDate, direction, options.calendarSystem) };
    }
    if (state.viewMode === 'schedule') return state;
    return shiftCalendarSelectedDate(state, state.viewMode === 'week' ? direction * 7 : direction);
}


export function shiftCalendarSelectedDate(state: CalendarPeriodState, daysDelta: number): CalendarPeriodState {
    if (!state.selectedDate) return state;
    const next = new Date(state.selectedDate);
    next.setDate(next.getDate() + daysDelta);
    return { ...state, selectedDate: next, visibleMonthDate: next };
}


export function selectCalendarViewMode(state: CalendarPeriodState, viewMode: CalendarViewMode, now: Date = new Date()): CalendarPeriodState {
    if (!needsCalendarSelectedDate(viewMode) || state.selectedDate) return { ...state, viewMode };
    const next = new Date(now);
    return { viewMode, selectedDate: next, visibleMonthDate: next };
}


const translateWith = (t: Translate) => (key: string, values?: I18nTemplateValues) => resolveI18nText(t, key, { values });


export type CalendarDates = {
    monthYear: (date: Date) => string;
    monthDay: (date: Date) => string;
    dayTitle: (date: Date) => string;
    longDate: (date: Date) => string;
    shortDate: (date: Date) => string;
    cellDate: (date: Date) => string;
    weekdays: readonly string[];
};


export const createCalendarLocaleDates = (locale: string): CalendarDates => ({
    monthYear: (date) => date.toLocaleDateString(locale, { year: 'numeric', month: 'long' }),
    monthDay: (date) => date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    dayTitle: (date) => date.toLocaleDateString(locale, { weekday: 'short', month: 'long', day: 'numeric' }),
    longDate: (date) => date.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    shortDate: (date) => date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }),
    cellDate: (date) => date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' }),
    weekdays: getShortWeekdayLabels(locale),
});


export const createCalendarPatternDates = (formatDate: DateFormatter): CalendarDates => {
    const sample = formatDate(new Date(2001, 10, 22), 'P');
    const dayFirst = sample.indexOf('22') !== -1 && sample.indexOf('11') !== -1 && sample.indexOf('22') < sample.indexOf('11');
    const pattern = (monthFirst: string, dayFirstPattern: string) => (date: Date) => formatDate(date, dayFirst ? dayFirstPattern : monthFirst);


    const weekdayLabels = (token: string) => Array.from({ length: 7 }, (_, day) => formatDate(new Date(2023, 0, 1 + day), token));
    const short = weekdayLabels('EEE').map((label) => label.replace(/\.+$/, ''));
    let weekdays = short;
    if (short.some((label) => [...label].length > 3)) {
        const truncated = short.map((label) => [...label].slice(0, 3).join(''));
        weekdays = new Set(truncated).size === truncated.length ? truncated : weekdayLabels('EEEEE');
    }
    return {
        monthYear: (date) => formatDate(date, 'LLLL yyyy'),
        monthDay: pattern('MMM d', 'd MMM'),
        dayTitle: pattern('EEE, MMMM d', 'EEE d MMMM'),
        longDate: pattern('EEEE, MMMM d, yyyy', 'EEEE, d MMMM yyyy'),
        shortDate: pattern('EEE, MMM d', 'EEE d MMM'),
        cellDate: pattern('EEEE, MMMM d', 'EEEE d MMMM'),
        weekdays,
    };
};

export const formatCalendarMonthTitle = (currentMonthDate: Date, dates: CalendarDates): string => dates.monthYear(currentMonthDate);

export const formatCalendarWeekTitle = (weekDays: readonly Date[], dates: CalendarDates): string => (
    `${dates.monthDay(weekDays[0])} - ${dates.monthDay(weekDays[6])}`
);


export const getCalendarDayNames = (dates: CalendarDates, weekStartIndex: number): string[] => (
    Array.from({ length: 7 }, (_, index) => dates.weekdays[(index + weekStartIndex) % 7])
);

export const getCalendarWeekdayLabel = (date: Date, dates: CalendarDates): string => dates.weekdays[date.getDay()];

const formatWithToday = (label: string, date: Date, now: Date, today: string): string => (
    `${label}${isSameCalendarDate(date, now) ? ` · ${today}` : ''}`
);


export function formatCalendarSelectedDateLabels(selectedDate: Date | null, options: { dates: CalendarDates; t: Translate; now?: Date }) {
    if (!selectedDate) return { long: '', planning: '', dayTitle: '' };
    const { dates, t } = options;
    const now = options.now ?? new Date();
    return {
        long: dates.longDate(selectedDate),
        planning: translateWith(t)('calendar.planningForDate', { date: dates.shortDate(selectedDate) }),
        dayTitle: formatWithToday(dates.dayTitle(selectedDate), selectedDate, now, t('filters.datePreset.today')),
    };
}


export const formatCalendarScheduleDayTitle = (date: Date, options: { dates: CalendarDates; t: Translate; now?: Date }): string => formatWithToday(
    options.dates.shortDate(date),
    date,
    options.now ?? new Date(),
    translateWith(options.t)('filters.datePreset.today'),
);


export const getCalendarMonthCellAccessibilityLabel = (
    date: Date,
    counts: { taskCount: number; eventCount: number },
    options: { dates: CalendarDates; t: Translate },
): string => [
    options.dates.cellDate(date),
    counts.taskCount > 0 ? formatListItemCount(counts.taskCount, 'task', options.t) : '',
    counts.eventCount > 0 ? formatListItemCount(counts.eventCount, 'event', options.t) : '',
].filter(Boolean).join('. ');

export const getCalendarModeOptions = (t: Translate): { value: CalendarViewMode; label: string }[] => {
    const tr = translateWith(t);
    return [
        { value: 'month', label: tr('calendar.mobile.month') },
        { value: 'day', label: tr('calendar.mobile.day') },
        { value: 'week', label: tr('calendar.mobile.week') },
        { value: 'schedule', label: tr('calendar.scheduleResults') },
    ];
};


export const getCalendarNavigationLabels = (viewMode: CalendarViewMode, t: Translate) => {
    const tr = translateWith(t);
    const unit = viewMode === 'day' ? 'Day' : viewMode === 'week' ? 'Week' : 'Month';
    return {
        previous: tr(`calendar.prev${unit}`),
        next: tr(`calendar.next${unit}`),
        today: tr('filters.datePreset.today'),
    };
};


export const getCalendarScreenText = (t: Translate) => {
    const tr = translateWith(t);
    return {
        showCompleted: tr('calendar.showCompleted'),
        showCompletedHint: tr('calendar.showCompletedHint'),
        allDay: t('calendar.allDay'),
        allDayLess: t('common.less'),
        addTask: t('calendar.addTask'),
        schedulePlaceholder: t('calendar.schedulePlaceholder'),
        searchResultsTitle: t('calendar.scheduleResults'),
        scheduleTitle: tr('calendar.scheduleResults'),
        planningTitle: tr('calendar.planningTitle'),
        events: t('calendar.events'),
        loading: tr('calendar.mobile.loading'),
        noTasks: t('calendar.noTasks'),
        done: t('status.done'),
        detailsHandle: tr('calendar.mobile.dayDetailsPanelHandle'),
        detailsHandleHint: tr('calendar.mobile.swipeUpOrDownToResizeTheDayDetailsPanel'),
        weekDensity: tr('calendar.mobile.visibleWeekDays'),
        weekDensityHint: tr('calendar.mobile.swipeUpOrDownToShowMoreOrFewerDays'),
        weekDensityMore: tr('calendar.mobile.showMoreDays'),
        weekDensityFewer: tr('calendar.mobile.showFewerDays'),

        weekDensityValue: (dayCount: number) => (dayCount === 1
            ? tr('calendar.mobile.1Day')
            : tr('calendar.mobile.visibleDayCount', { dayCount })),

        weekDensityChoice: (dayCount: number) => (dayCount === 1
            ? tr('calendar.mobile.show1VisibleDay')
            : tr('calendar.mobile.showVisibleDayCount', { dayCount })),
    };
};


export const getCalendarComposerText = (t: Translate, options: { priorities: boolean; timeEstimates: boolean }) => {
    const tr = translateWith(t);
    return {
        title: tr('calendar.mobile.scheduleTask'),
        close: t('common.close'),
        newTask: tr('calendar.mobile.newTask'),
        existingTask: tr('calendar.mobile.existingTask'),
        titlePlaceholder: t('calendar.addTask'),
        help: formatQuickAddHelp(t('quickAdd.help'), options),
        queryPlaceholder: t('calendar.schedulePlaceholder'),
        noMatchingTasks: tr('calendar.mobile.noMatchingTasks'),
        start: tr('taskEdit.start'),
        end: tr('calendar.mobile.end'),
        cancel: t('common.cancel'),
        save: t('common.save'),
    };
};


export const formatCalendarDurationChip = (minutes: number): string => {
    if (minutes < 60) return `${minutes}m`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
};


export const compactHourLabel = (label: string): string => (
    /[^\d\s.:]/.test(label) ? label.replace(/[.:]00/, '') : label
);

export const formatCalendarHourLabel = (hour: number, formatDate: DateFormatter): string => {
    const sample = new Date(2025, 0, 1, hour, 0, 0, 0);
    return compactHourLabel(formatDate(sample, 'p'));
};


export const getCalendarHourLabels = (formatDate: DateFormatter): string[] => Array.from(
    { length: CALENDAR_DAY_END_HOUR - CALENDAR_DAY_START_HOUR + 1 },
    (_, index) => formatCalendarHourLabel(CALENDAR_DAY_START_HOUR + index, formatDate),
);

export const formatCalendarTimeRange = (start: Date, durationMinutes: number, formatDate: DateFormatter): string => {
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    return `${formatDate(start, 'p')}-${formatDate(end, 'p')}`;
};

export const formatCalendarClockRange = (start: Date, end: Date, formatDate: DateFormatter): string => (
    `${formatDate(start, 'p')}-${formatDate(end, 'p')}`
);

const PROJECTED_RECURRENCE_LABEL_DATE_FORMAT = 'MMM d';


export const getProjectedRecurrenceDisplayLabel = (task: Task, projectedLabel: string, formatDate: DateFormatter): string => {
    const occurrenceDateLabel = formatDate(getTaskCalendarOccurrenceDate(task), PROJECTED_RECURRENCE_LABEL_DATE_FORMAT);
    return occurrenceDateLabel ? `${projectedLabel} · ${occurrenceDateLabel}` : projectedLabel;
};

export const getCalendarProjectedLabel = (t: Translate): string => translateWith(t)('calendar.projectedRecurrence');


export const getCalendarItemTitle = (item: CalendarDayItem, projectedLabel: string, formatDate: DateFormatter): string => (
    item.kind !== 'event' && isProjectedRecurringTask(item.task)
        ? `${item.title} · ${getProjectedRecurrenceDisplayLabel(item.task, projectedLabel, formatDate)}`
        : item.title
);

const getCalendarTimedDueLabel = (task: Task, options: { t: Translate; formatDate: DateFormatter }): string => {
    if (!hasTimeComponent(task.dueDate)) return '';
    const due = safeParseDueDate(task.dueDate);
    return due ? `${options.t('calendar.due')} ${options.formatDate(due, 'p')}` : '';
};


export function getCalendarMonthItemTitle(
    item: CalendarDayItem,
    date: Date,
    options: { t: Translate; formatDate: DateFormatter; projectedLabel?: string },
): string {
    const title = options.projectedLabel
        ? getCalendarItemTitle(item, options.projectedLabel, options.formatDate) : item.title;
    if (item.kind !== 'deadline' && item.kind !== 'scheduled') return title;
    const due = safeParseDueDate(item.task.dueDate);
    if (!due || !isSameCalendarDate(due, date)) return title;
    if (!hasTimeComponent(item.task.dueDate)) return title;

    return `${options.formatDate(due, 'p')} · ${options.t('calendar.due')} · ${title}`;
}


export const withCalendarProjectedLabel = (label: string, task: Task, projectedLabel: string, formatDate: DateFormatter): string => (
    isProjectedRecurringTask(task) ? `${label} · ${getProjectedRecurrenceDisplayLabel(task, projectedLabel, formatDate)}` : label
);

export const getCalendarComposerErrorText = (error: CalendarComposerError, t: Translate): string => {
    switch (error.code) {
        case 'invalid_range':
            return t('calendar.invalidTimeRange');
        case 'title_required':
            return t('calendar.enterTaskTitle');
        case 'task_required':
            return t('calendar.chooseTask');
        case 'overlap':
            return t('calendar.overlapWarning');
        case 'invalid_date_command':
            return `${t('quickAdd.invalidDateCommand')}: ${error.detail ?? ''}`;
        case 'start_after_due':
            return t('task.dateIssue.startAfterDue');
        default:
            return error.detail ?? t('calendar.saveTaskFailed');
    }
};


export const getCalendarRangeTasks = (
    visibleTasks: readonly Task[],
    range: { rangeStartMs: number; rangeEndMs: number },
    projectedAtIso: string,
): Task[] => expandCalendarRecurringTaskSetInRange(
    visibleTasks.filter(isSchedulableCalendarTask),
    { startIso: new Date(range.rangeStartMs).toISOString(), endIso: new Date(range.rangeEndMs).toISOString() },
    projectedAtIso,
);


export const getCalendarSchedulableTasks = (visibleTasks: readonly Task[]): Task[] => (
    visibleTasks.filter(isSchedulableCalendarTask).sort((a, b) => a.title.localeCompare(b.title))
);

export const indexCalendarScheduledTasks = (tasks: readonly Task[]): Map<string, Task[]> => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
        if (!task.startTime) continue;
        const startTime = safeParseDate(task.startTime);
        if (startTime) addCalendarMapItem(map, startTime, task);
    }
    return map;
};

export const indexCalendarDeadlineTasks = (tasks: readonly Task[]): Map<string, Task[]> => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
        if (!task.dueDate) continue;
        const dueDate = safeParseDueDate(task.dueDate);
        if (dueDate) addCalendarMapItem(map, dueDate, task);
    }
    return map;
};


export const indexCalendarCompletedTasks = (
    allTasks: readonly Task[],
    options: {
        showCompleted: boolean;
        projectById: Map<string, Project>;
        areaById: Map<string, Area>;
        resolvedAreaFilter: AreaFilterSelection;
    },
): Map<string, Task[]> => {
    const map = new Map<string, Task[]>();
    if (!options.showCompleted) return map;
    for (const task of allTasks) {
        if (!isCompletedCalendarTask(task)) continue;
        if (!isTaskInCalendarHistoryProject(task, options.projectById)) continue;
        if (!taskMatchesAreaFilterSelection(task, options.resolvedAreaFilter, options.projectById, options.areaById)) continue;
        const completedAt = getTaskCompletionInstant(task);
        if (completedAt) addCalendarMapItem(map, completedAt, task);
    }
    return map;
};


export const indexCalendarEvents = (events: readonly ExternalCalendarEvent[]): Map<string, ExternalCalendarEvent[]> => {
    const map = new Map<string, ExternalCalendarEvent[]>();
    for (const event of events) {
        const start = safeParseDate(event.start);
        const end = safeParseDate(event.end);
        if (!start || !end) continue;
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);
        if (end.getTime() === endDay.getTime()) {
            endDay.setDate(endDay.getDate() - 1);
        }
        for (let guard = 0; day.getTime() <= endDay.getTime() && guard < 370; guard += 1) {
            addCalendarMapItem(map, day, event);
            day.setDate(day.getDate() + 1);
        }
    }
    return map;
};

export type CalendarDayIndex = {
    scheduled: Map<string, Task[]>;
    deadlines: Map<string, Task[]>;
    completed: Map<string, Task[]>;
    events: Map<string, ExternalCalendarEvent[]>;
};

export type CalendarDayLists = {
    scheduled: Task[];
    deadlines: Task[];
    completed: Task[];
    events: ExternalCalendarEvent[];
};

export const getCalendarDayLists = (index: CalendarDayIndex, date: Date): CalendarDayLists => {
    const key = calendarDateKey(date);
    return {
        scheduled: index.scheduled.get(key) ?? [],
        deadlines: index.deadlines.get(key) ?? [],
        completed: index.completed.get(key) ?? [],
        events: index.events.get(key) ?? [],
    };
};

export const getCalendarDayItems = (
    lists: CalendarDayLists,
    options: { preserveTimedDeadlines?: boolean } = {},
): CalendarDayItem[] => buildCalendarDayItems({ ...lists, ...options });


export const getCalendarDetailsTaskLists = (lists: Pick<CalendarDayLists, 'deadlines' | 'scheduled'>) => {
    return { deadlines: getCalendarDistinctDeadlines(lists.deadlines, lists.scheduled), scheduled: lists.scheduled };
};


export const countCalendarDayTasks = (lists: CalendarDayLists): number => {
    const ids = new Set<string>();
    for (const task of lists.deadlines) ids.add(task.id);
    for (const task of lists.scheduled) ids.add(task.id);
    for (const task of lists.completed) ids.add(task.id);
    return ids.size;
};


export const getCalendarDayTimedTasks = (scheduled: readonly Task[]): Task[] => scheduled.filter((task) => (
    isTimedScheduledTask(task)
    && !task.deletedAt
    && task.status !== 'done'
    && task.status !== 'reference'
));


export const isCalendarAllDayItem = (item: CalendarDayItem): boolean => (
    (item.kind === 'deadline' && !hasTimeComponent(item.task.dueDate))
    || item.kind === 'completed'
    || (item.kind === 'scheduled' && isAllDayScheduledTask(item.task))
    || (item.kind === 'event' && item.event.allDay)
);

export const isCalendarTimedItem = (item: CalendarDayItem): boolean => (
    (item.kind === 'scheduled' && isTimedScheduledTask(item.task))
    || (item.kind === 'event' && !item.event.allDay)
);


export function getCalendarScheduleSections(
    start: Date,
    itemsForDate: (date: Date) => CalendarDayItem[],
): { date: Date; id: string; items: CalendarDayItem[] }[] {
    const sections: { date: Date; id: string; items: CalendarDayItem[] }[] = [];
    for (let offset = 0; offset < CALENDAR_SCHEDULE_DAYS; offset += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + offset);
        const items = itemsForDate(date);
        if (items.length === 0) continue;
        sections.push({ id: calendarDateKey(date), date, items });
        if (sections.length >= CALENDAR_SCHEDULE_MAX_SECTIONS) break;
    }
    return sections;
}


export const getCalendarSourceColor = (sourceId: string, options: { override?: string; feedColor?: string; theme?: string } = {}): string => (
    themeExternalCalendarDisplayColor(resolveExternalCalendarColor(sourceId, options.override, options.feedColor), options.theme)
);

export function createCalendarSourceColorResolver(calendars: readonly ExternalCalendarSubscription[], theme?: string): (sourceId: string) => string {
    const colors = new Map(calendars.map((calendar) => [
        calendar.id,
        getCalendarSourceColor(calendar.id, { override: calendar.color, feedColor: calendar.feedColor, theme }),
    ]));
    return (sourceId) => colors.get(sourceId) ?? getCalendarSourceColor(sourceId, { theme });
}

export const getCalendarSourceNames = (calendars: readonly ExternalCalendarSubscription[]): Map<string, string> => (
    new Map(calendars.map((calendar) => [calendar.id, calendar.name]))
);


export const formatCalendarEventTime = (event: ExternalCalendarEvent, options: { t: Translate; formatDate: DateFormatter }): string => {
    if (event.allDay) return options.t('calendar.allDay');
    const start = safeParseDate(event.start);
    const end = safeParseDate(event.end);
    return start && end ? formatCalendarClockRange(start, end, options.formatDate) : '';
};


export type CalendarTone = 'tint' | 'danger' | 'secondary' | 'text' | 'input' | 'none' | 'source';


export function getCalendarMonthCell(
    date: Date,
    lists: CalendarDayLists,
    options: { dates: CalendarDates; t: Translate },
) {
    const items = getCalendarDayItems(lists);
    const taskCount = countCalendarDayTasks(lists);
    const eventCount = lists.events.length;


    const previewItems = orderCalendarDayItemsForLimitedSlots(items)
        .slice(0, items.length >= CALENDAR_MONTH_PREVIEW_HIDDEN_AT ? 0 : CALENDAR_MONTH_PREVIEW_ITEMS);
    return {
        items,
        previewItems,
        taskCount,
        eventCount,
        showCounts: items.length > previewItems.length && (taskCount > 0 || eventCount > 0),
        accessibilityLabel: getCalendarMonthCellAccessibilityLabel(date, { taskCount, eventCount }, options),
    };
}


export const getCalendarMonthPreviewTones = (item: CalendarDayItem) => {
    const projected = item.kind !== 'event' && isProjectedRecurringTask(item.task);
    return {
        fill: (item.kind === 'scheduled' ? 'tint' : item.kind === 'deadline' ? 'none' : 'secondary') as CalendarTone,
        accent: (item.kind === 'event'
            ? 'source'
            : projected
                ? 'tint'
                : item.kind === 'deadline'
                    ? 'danger'
                    : item.kind === 'completed'
                        ? 'secondary'
                        : 'tint') as CalendarTone,
        text: (item.kind === 'scheduled' || projected ? 'tint' : item.kind === 'completed' ? 'secondary' : 'text') as CalendarTone,
        dashed: projected,
        struck: item.kind === 'completed',
    };
};


export function getCalendarAllDayLane(items: readonly CalendarDayItem[], limit: number, expanded = false) {
    const all = orderCalendarDayItemsForLimitedSlots(items.filter(isCalendarAllDayItem));
    return {
        items: expanded ? all : all.slice(0, limit),
        hiddenCount: Math.max(0, all.length - limit),
    };
}


export const formatCalendarAllDayMore = (hiddenCount: number, t: Translate): string => `+${hiddenCount} ${t('calendar.more')}`;


export const getCalendarWeekAllDayItems = (items: readonly CalendarDayItem[]): CalendarDayItem[] => (
    getCalendarAllDayLane(items, CALENDAR_WEEK_ALL_DAY_ITEMS).items
);


export const getCalendarWeekAllDayTones = (item: CalendarDayItem) => {
    const projected = item.kind !== 'event' && isProjectedRecurringTask(item.task);
    const completed = item.kind === 'completed';
    return {
        fill: (item.kind === 'event' || completed ? 'secondary' : 'input') as CalendarTone,
        accent: (item.kind === 'event'
            ? 'source'
            : projected || item.kind === 'scheduled'
                ? 'tint'
                : completed
                    ? 'secondary'
                    : 'danger') as CalendarTone,
        text: (completed ? 'secondary' : projected ? 'tint' : 'text') as CalendarTone,
        dashed: projected,
        struck: completed,
        disabled: projected || completed,
    };
};


export const getCalendarDayAllDayTones = (item: CalendarDayItem) => ({
    ...getCalendarWeekAllDayTones(item),
    disabled: item.kind === 'completed',
});


export function getCalendarScheduleItemText(
    item: CalendarDayItem,
    options: {
        t: Translate;
        formatDate: DateFormatter;
        projectedLabel: string;
        sourceNames: Map<string, string>;
        timeEstimateToMinutes: (estimate: Task['timeEstimate']) => number;
    },
): { detail: string; accessibilityLabel: string } {
    const { t, formatDate } = options;
    if (item.kind === 'event') {
        const timeLabel = formatCalendarEventTime(item.event, options);
        const sourceName = options.sourceNames.get(item.event.sourceId);
        return {
            detail: sourceName ? `${timeLabel} · ${sourceName}` : timeLabel,
            accessibilityLabel: sourceName ? `${item.title}. ${timeLabel}. ${sourceName}` : `${item.title}. ${timeLabel}`,
        };
    }
    const projected = isProjectedRecurringTask(item.task);
    const start = item.task.startTime ? safeParseDate(item.task.startTime) : null;
    const timeLabel = item.kind === 'completed'
        ? (item.start ? formatDate(item.start, 'p') : t('status.done'))
        : start && isAllDayScheduledTask(item.task)
            ? t('calendar.allDay')
            : start
                ? formatCalendarTimeRange(start, options.timeEstimateToMinutes(item.task.timeEstimate), formatDate)
                : t('calendar.deadline');
    const projectedDisplayLabel = projected ? getProjectedRecurrenceDisplayLabel(item.task, options.projectedLabel, formatDate) : '';
    return {
        detail: projected ? `${timeLabel} · ${projectedDisplayLabel}` : timeLabel,
        accessibilityLabel: projected ? `${item.title}. ${timeLabel}. ${projectedDisplayLabel}` : `${item.title}. ${timeLabel}`,
    };
}

export const getCalendarScheduleItemTones = (item: CalendarDayItem) => {
    const projected = item.kind !== 'event' && isProjectedRecurringTask(item.task);
    const completed = item.kind === 'completed';
    return {
        fill: (item.kind === 'event' ? 'input' : item.kind === 'scheduled' || projected ? 'tint' : 'input') as CalendarTone,
        accent: (item.kind === 'event' ? 'source' : completed ? 'secondary' : item.kind === 'scheduled' ? 'tint' : 'danger') as CalendarTone,
        title: (completed ? 'secondary' : 'text') as CalendarTone,
        dashed: projected,
        struck: completed,
        faded: completed,
        disabled: projected || completed,
    };
};


export function getCalendarDetailsTaskRow(
    task: Task,
    kind: 'deadline' | 'scheduled',
    options: { t: Translate; formatDate: DateFormatter; projectedLabel: string; timeEstimateToMinutes: (estimate: Task['timeEstimate']) => number },
) {
    const projected = isProjectedRecurringTask(task);
    const dueLabel = getCalendarTimedDueLabel(task, options);
    const scheduledLabel = (): string => {
        const start = safeParseDate(task.startTime);
        if (!start) return '';
        const end = new Date(start.getTime() + options.timeEstimateToMinutes(task.timeEstimate) * 60 * 1000);
        const label = !isTimedScheduledTask(task) ? options.t('calendar.allDay') : formatCalendarClockRange(start, end, options.formatDate);
        const due = safeParseDueDate(task.dueDate);
        const combined = dueLabel && due && isSameCalendarDate(start, due) ? `${label} · ${dueLabel}` : label;
        return withCalendarProjectedLabel(combined, task, options.projectedLabel, options.formatDate);
    };
    const detail = kind === 'deadline'
        ? withCalendarProjectedLabel(dueLabel || options.t('calendar.deadline'), task, options.projectedLabel, options.formatDate)
        : scheduledLabel();
    return {
        detail,
        projected,
        showDone: !projected && !isTaskFinished(task),
        tones: { fill: (projected ? 'tint' : 'input') as CalendarTone, title: (projected ? 'tint' : 'text') as CalendarTone, dashed: projected },
    };
}


export const getCalendarDetailsEventRow = (
    event: ExternalCalendarEvent,
    options: { t: Translate; formatDate: DateFormatter; sourceNames: Map<string, string> },
) => {
    const sourceName = options.sourceNames.get(event.sourceId);
    return {
        title: `${event.title}${sourceName ? ` (${sourceName})` : ''}`,
        detail: formatCalendarEventTime(event, options),
    };
};

const clampToDay = (startMs: number, endMs: number, dayStartMs: number, dayEndMs: number) => ({
    start: Math.max(startMs, dayStartMs),
    end: Math.min(endMs, dayEndMs),
});

export const getCalendarWallMinutes = (dayStart: Date, instant: Date): number => (
    instant.getFullYear() !== dayStart.getFullYear() || instant.getMonth() !== dayStart.getMonth() || instant.getDate() !== dayStart.getDate()
        ? 24 * 60
        : instant.getHours() * 60 + instant.getMinutes() + instant.getSeconds() / 60 + instant.getMilliseconds() / 60_000
);
const layoutInput = (id: string, startMs: number, endMs: number, dayStartMs: number, dayEndMs: number): CalendarTimedLayoutInput | null => {
    const clamped = clampToDay(startMs, endMs, dayStartMs, dayEndMs);
    if (clamped.end <= clamped.start) return null;
    const dayStart = new Date(dayStartMs);
    return { id, startMinutes: getCalendarWallMinutes(dayStart, new Date(clamped.start)), endMinutes: getCalendarWallMinutes(dayStart, new Date(clamped.end)) };
};

export type CalendarTimelineEvent = {
    event: ExternalCalendarEvent;

    start: Date;
    end: Date;

    timeLabel: string;
    layout: CalendarTimedLayout | undefined;
};

export type CalendarTimelineTask = {
    task: Task;

    start: Date;
    durationMinutes: number;

    displayStart: Date;
    displayEnd: Date;
    layout: CalendarTimedLayout | undefined;
    projected: boolean;

    timeLabel: string;
};


export function getCalendarDayTimeline(options: {
    events: readonly ExternalCalendarEvent[];
    tasks: readonly Task[];
    dayStart: Date;
    dayEnd: Date;
    timeEstimateToMinutes: (estimate: Task['timeEstimate']) => number;
    formatDate: DateFormatter;
    projectedLabel: string;
}): { events: CalendarTimelineEvent[]; tasks: CalendarTimelineTask[] } {
    const dayStartMs = options.dayStart.getTime();
    const dayEndMs = options.dayEnd.getTime();
    const inputs: CalendarTimedLayoutInput[] = [];
    const events: Omit<CalendarTimelineEvent, 'layout'>[] = [];
    for (const event of options.events) {
        if (event.allDay) continue;
        const start = safeParseDate(event.start);
        const end = safeParseDate(event.end);
        if (!start || !end) continue;
        const clamped = clampToDay(start.getTime(), end.getTime(), dayStartMs, dayEndMs);
        events.push({
            event,
            start: new Date(clamped.start),
            end: new Date(clamped.end),
            timeLabel: formatCalendarClockRange(new Date(clamped.start), new Date(clamped.end), options.formatDate),
        });
        const input = layoutInput(`event:${event.id}`, start.getTime(), end.getTime(), dayStartMs, dayEndMs);
        if (input) inputs.push(input);
    }
    const tasks: Omit<CalendarTimelineTask, 'layout'>[] = [];
    for (const task of getCalendarDayTimedTasks(options.tasks)) {
        const start = task.startTime ? safeParseDate(task.startTime) : null;
        if (!start) continue;
        const durationMinutes = options.timeEstimateToMinutes(task.timeEstimate);
        const endMs = start.getTime() + durationMinutes * 60_000;
        const clamped = clampToDay(start.getTime(), endMs, dayStartMs, dayEndMs);
        tasks.push({
            task,
            start,
            durationMinutes,
            displayStart: new Date(clamped.start),
            displayEnd: new Date(clamped.end),
            projected: isProjectedRecurringTask(task),
            timeLabel: withCalendarProjectedLabel(formatCalendarTimeRange(start, durationMinutes, options.formatDate), task, options.projectedLabel, options.formatDate),
        });
        const input = layoutInput(`task:${task.id}`, start.getTime(), endMs, dayStartMs, dayEndMs);
        if (input) inputs.push(input);
    }
    const layouts = buildTimedCalendarLayouts(inputs);
    return {
        events: events.map((entry) => ({ ...entry, layout: layouts.get(`event:${entry.event.id}`) })),
        tasks: tasks.map((entry) => ({ ...entry, layout: layouts.get(`task:${entry.task.id}`) })),
    };
}

type CalendarEventItem = Extract<CalendarDayItem, { kind: 'event' }>;
type CalendarTaskItem = Exclude<CalendarDayItem, { kind: 'event' }>;

export type CalendarWeekTimedEntry =
    | { kind: 'event'; item: CalendarEventItem; start: Date; end: Date; timeLabel: string; layout: CalendarTimedLayout | undefined }
    | {
        kind: 'task';
        item: CalendarTaskItem;
        start: Date;
        durationMinutes: number;
        displayStart: Date;
        displayEnd: Date;
        projected: boolean;
        timeLabel: string;
        layout: CalendarTimedLayout | undefined;
    };
type WithoutLayout<T> = T extends unknown ? Omit<T, 'layout'> : never;


export function getCalendarWeekTimedEntries(options: {
    items: readonly CalendarDayItem[];
    dayStart: Date;
    dayEnd: Date;
    timeEstimateToMinutes: (estimate: Task['timeEstimate']) => number;
    formatDate: DateFormatter;
    projectedLabel: string;
}): CalendarWeekTimedEntry[] {
    const dayStartMs = options.dayStart.getTime();
    const dayEndMs = options.dayEnd.getTime();
    const inputs: CalendarTimedLayoutInput[] = [];
    const entries: WithoutLayout<CalendarWeekTimedEntry>[] = [];
    for (const item of options.items.filter(isCalendarTimedItem)) {
        if (item.kind === 'event') {
            const start = safeParseDate(item.event.start);
            const end = safeParseDate(item.event.end);
            if (!start || !end) continue;
            const clamped = clampToDay(start.getTime(), end.getTime(), dayStartMs, dayEndMs);
            const displayStart = new Date(clamped.start);
            const displayEnd = new Date(clamped.end);
            entries.push({ kind: 'event', item, start: displayStart, end: displayEnd, timeLabel: formatCalendarClockRange(displayStart, displayEnd, options.formatDate) });
            const input = layoutInput(`event:${item.event.id}`, start.getTime(), end.getTime(), dayStartMs, dayEndMs);
            if (input) inputs.push(input);
            continue;
        }
        const task = item.task;
        const start = task.startTime ? safeParseDate(task.startTime) : null;
        if (!start) continue;
        const durationMinutes = options.timeEstimateToMinutes(task.timeEstimate);
        const endMs = start.getTime() + durationMinutes * 60_000;
        const clamped = clampToDay(start.getTime(), endMs, dayStartMs, dayEndMs);
        entries.push({
            kind: 'task',
            item,
            start,
            durationMinutes,
            displayStart: new Date(clamped.start),
            displayEnd: new Date(clamped.end),
            projected: isProjectedRecurringTask(task),
            timeLabel: withCalendarProjectedLabel(formatCalendarTimeRange(start, durationMinutes, options.formatDate), task, options.projectedLabel, options.formatDate),
        });
        const input = layoutInput(`task:${task.id}`, start.getTime(), endMs, dayStartMs, dayEndMs);
        if (input) inputs.push(input);
    }
    const layouts = buildTimedCalendarLayouts(inputs);
    return entries.map((entry): CalendarWeekTimedEntry => (entry.kind === 'event'
        ? { ...entry, layout: layouts.get(`event:${entry.item.event.id}`) }
        : { ...entry, layout: layouts.get(`task:${entry.item.task.id}`) }));
}


export const getCalendarDayBounds = (date: Date): { dayStart: Date; dayEnd: Date } => {
    const dayStart = new Date(date);
    dayStart.setHours(CALENDAR_DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(CALENDAR_DAY_END_HOUR, 0, 0, 0);
    return { dayStart, dayEnd };
};


export const getCalendarNowMinutes = (now: Date): number | null => {
    const minutes = (now.getHours() - CALENDAR_DAY_START_HOUR) * 60 + now.getMinutes();
    if (minutes < 0 || minutes > CALENDAR_DAY_MINUTES) return null;
    return minutes;
};

/** A timeline tap at `rawMinutes` into the day: snapped to `snapMinutes`, and early enough for a 30-minute task. */
export const snapCalendarTimelineMinutes = (rawMinutes: number, snapMinutes: number = CALENDAR_SNAP_MINUTES): number => {
    const snappedMinutes = Math.round(rawMinutes / snapMinutes) * snapMinutes;
    return Math.max(0, Math.min(CALENDAR_DAY_MINUTES - CALENDAR_TAP_DURATION_MINUTES, snappedMinutes));
};


export const getCalendarPlanningTasks = (
    visibleTasks: readonly Task[],
    options: { now: Date; prioritiesEnabled: boolean; projects: readonly Project[]; sections: readonly Section[] },
): Task[] => getCalendarPlanningCandidates(visibleTasks, {
    limit: CALENDAR_PLANNING_LIMIT,
    now: options.now,
    prioritizeByPriority: options.prioritiesEnabled,
    projects: options.projects,
    sections: options.sections,
});

const matchingTitles = (tasks: readonly Task[], query: string, limit: number): Task[] => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((task) => !needle || task.title.toLowerCase().includes(needle)).slice(0, limit);
};


export const getCalendarSearchResults = (schedulableTasks: readonly Task[], query: string): Task[] => (
    query.trim() ? matchingTitles(schedulableTasks, query, CALENDAR_SEARCH_LIMIT) : []
);


export const getCalendarComposerCandidates = (schedulableTasks: readonly Task[], query: string): Task[] => (
    matchingTitles(schedulableTasks, query, CALENDAR_COMPOSER_CANDIDATE_LIMIT)
);

type SlotOptions = {
    events: readonly ExternalCalendarEvent[];
    tasks: readonly Task[];
    timeEstimatesEnabled: boolean;
    excludeTaskId?: string;
    now?: Date;
};


export const findCalendarFreeSlot = (day: Date, durationMinutes: number, options: SlotOptions): Date | null => findFreeSlotForDay({
    day,
    dayEndHour: DEFAULT_CALENDAR_DAY_END_HOUR,
    dayStartHour: DEFAULT_CALENDAR_DAY_START_HOUR,
    durationMinutes,
    events: options.events,
    excludeTaskId: options.excludeTaskId,
    now: options.now,
    snapMinutes: CALENDAR_SNAP_MINUTES,
    tasks: options.tasks,
    timeEstimatesEnabled: options.timeEstimatesEnabled,
});


export const isCalendarSlotFree = (day: Date, startTime: Date, durationMinutes: number, options: SlotOptions): boolean => isSlotFreeForDay({
    day,
    dayEndHour: CALENDAR_DAY_END_HOUR,
    dayStartHour: CALENDAR_DAY_START_HOUR,
    durationMinutes,
    events: options.events,
    excludeTaskId: options.excludeTaskId,
    snapMinutes: CALENDAR_SNAP_MINUTES,
    startTime,
    tasks: options.tasks,
    timeEstimatesEnabled: options.timeEstimatesEnabled,
});


export const getCalendarScheduleActionLabel = (slot: Date | null, durationMinutes: number, options: { t: Translate; formatDate: DateFormatter }): string => {
    const slotLabel = slot ? formatCalendarTimeRange(slot, durationMinutes, options.formatDate) : null;
    return slotLabel ? `${options.t('calendar.scheduleAction')} · ${slotLabel}` : options.t('calendar.scheduleAction');
};


export type CalendarViewComposerState = CalendarComposerState & {
    date: Date;
    startTimeValue: string;
};

export const toCalendarViewComposer = (state: CalendarComposerState, date: Date): CalendarViewComposerState => {
    const start = state.startAt ?? date;
    return { ...state, date: start, startTimeValue: formatCalendarTimeInputValue(start) };
};

export const setCalendarViewComposerStartTime = (state: CalendarViewComposerState, value: string): CalendarViewComposerState => ({
    ...state,
    ...setComposerStart(state, parseCalendarTimeOnDate(state.date, value)),
    startTimeValue: value,
});

export const isCalendarComposerSaveDisabled = (composer: CalendarComposerState | null): boolean => (
    composer ? (composer.mode === 'new' ? !composer.title.trim() : !composer.selectedTaskId) : true
);


export const getCalendarComposerPlaceholders = (formatDate: DateFormatter) => ({
    start: formatDate(new Date(2000, 0, 1, 9, 0), 'p', '09:00'),
    end: formatDate(new Date(2000, 0, 1, 9, 30), 'p', '09:30'),
});


export const formatCalendarComposerClockValue = (value: string, date: Date | null, formatDate: DateFormatter): string => (
    date && value === formatCalendarTimeInputValue(date) ? formatDate(date, 'p', value) : value
);


export type CalendarSheetButton<Id extends string> = { id: Id; label: string; style: 'default' | 'destructive' | 'cancel' };

export type CalendarTaskSheet =
    | { kind: 'projected'; title: string; message: string; buttons: CalendarSheetButton<'ok'>[] }
    | { kind: 'actions'; title: string; buttons: CalendarSheetButton<'edit' | 'unschedule' | 'done' | 'delete' | 'cancel'>[] };


export function getCalendarTaskSheet(task: Task, t: Translate): CalendarTaskSheet {
    if (isProjectedRecurringTask(task)) {
        return {
            kind: 'projected',
            title: task.title,
            message: translateWith(t)('calendar.projectedRecurrenceDescription'),
            buttons: [{ id: 'ok', label: t('common.ok'), style: 'default' }],
        };
    }
    const buttons: CalendarSheetButton<'edit' | 'unschedule' | 'done' | 'delete' | 'cancel'>[] = [
        { id: 'edit', label: t('common.edit'), style: 'default' },
    ];
    if (task.startTime) buttons.push({ id: 'unschedule', label: t('calendar.unschedule'), style: 'default' });
    if (!isTaskFinished(task)) buttons.push({ id: 'done', label: t('status.done'), style: 'default' });
    buttons.push(
        { id: 'delete', label: t('common.delete'), style: 'destructive' },
        { id: 'cancel', label: t('common.cancel'), style: 'cancel' },
    );
    return { kind: 'actions', title: task.title, buttons };
}


export function getCalendarEventSheet(event: ExternalCalendarEvent, options: { canOpen: boolean; t: Translate }) {
    const { t } = options;
    const buttons: CalendarSheetButton<'createTask' | 'openInCalendar' | 'cancel'>[] = [
        { id: 'createTask', label: t('calendar.createTaskFromEvent'), style: 'default' },
    ];
    if (options.canOpen) buttons.push({ id: 'openInCalendar', label: t('calendar.openInCalendar'), style: 'default' });
    buttons.push({ id: 'cancel', label: t('common.cancel'), style: 'cancel' });
    return { title: event.title || t('calendar.eventFallbackTitle'), buttons };
}


export const CALENDAR_DONE_UPDATES: Readonly<Partial<Task>> = { status: 'done', isFocusedToday: false };

export const CALENDAR_UNSCHEDULE_UPDATES: Readonly<Partial<Task>> = { startTime: undefined };

export type CalendarToast = { tone: 'info' | 'warning' | 'success'; title: string; message: string; durationMs: number };

export const getCalendarToasts = (t: Translate) => ({
    noFreeTime: { tone: 'info', title: t('calendar.noFreeTimeTitle'), message: t('calendar.noFreeTime'), durationMs: 4200 } as CalendarToast,
    timeConflict: { tone: 'warning', title: t('calendar.timeConflictTitle'), message: t('calendar.overlapWarning'), durationMs: 4200 } as CalendarToast,
    eventTaskCreated: { tone: 'success', title: t('calendar.eventTaskCreatedTitle'), message: t('calendar.eventTaskCreated'), durationMs: 3000 } as CalendarToast,
    saveFailed: (message?: string): CalendarToast => ({ tone: 'warning', title: t('calendar.saveTaskFailed'), message: message ?? t('calendar.saveTaskFailed'), durationMs: 4200 }),
    cannotOpenEvent: { tone: 'info', title: t('calendar.cannotOpenEventTitle'), message: t('calendar.openUnsupported'), durationMs: 3600 } as CalendarToast,
    openEventFailed: { tone: 'warning', title: t('calendar.cannotOpenEventTitle'), message: t('calendar.openFromCalendarApp'), durationMs: 4200 } as CalendarToast,
});


export function planCalendarTaskMove(options: {
    taskId: string;
    dayStartMs: number;
    startMinutes: number;
    durationMinutes: number;
    currentStart?: Date | null;
    isSlotFree: (day: Date, start: Date, durationMinutes: number, excludeTaskId: string) => boolean;
}): { kind: 'projected' } | { kind: 'conflict' } | { kind: 'move'; updates: Partial<Task> } {
    if (isProjectedRecurringTaskId(options.taskId)) return { kind: 'projected' };
    const day = new Date(options.dayStartMs);
    const nextStart = getCalendarMovedStart(options.dayStartMs, options.startMinutes, options.currentStart);
    if (options.currentStart?.getTime() === nextStart.getTime()) return { kind: 'move', updates: { startTime: nextStart.toISOString() } };
    if (!options.isSlotFree(day, nextStart, options.durationMinutes, options.taskId)) return { kind: 'conflict' };
    return { kind: 'move', updates: { startTime: nextStart.toISOString() } };
}


export const getCalendarMovedStart = (dayStartMs: number, startMinutes: number, currentStart?: Date | null): Date => {
    const start = new Date(dayStartMs);
    if (currentStart && calendarDateKey(currentStart) === calendarDateKey(start)
        && getCalendarWallMinutes(start, currentStart) === startMinutes) return currentStart;

    start.setHours(0, startMinutes, 0, 0);
    return start;
};

/**
 * A block's bottom edge dragged to `durationMinutes`, its start staying at
 * `startMinutes` into the day. A projected occurrence never resizes; a
 * duration that would overlap something else is refused with the
 * time-conflict toast; otherwise the task's estimate becomes the duration.
 */
export function planCalendarTaskResize(options: {
    taskId: string;
    dayStartMs: number;
    startMinutes: number;
    durationMinutes: number;
    currentStart?: Date | null;
    isSlotFree: (day: Date, start: Date, durationMinutes: number, excludeTaskId: string) => boolean;
}): { kind: 'projected' } | { kind: 'conflict' } | { kind: 'resize'; updates: Partial<Task> } {
    if (isProjectedRecurringTaskId(options.taskId)) return { kind: 'projected' };
    const day = new Date(options.dayStartMs);
    const start = getCalendarMovedStart(options.dayStartMs, options.startMinutes, options.currentStart);
    if (!options.isSlotFree(day, start, options.durationMinutes, options.taskId)) return { kind: 'conflict' };
    return { kind: 'resize', updates: { timeEstimate: minutesToTimeEstimate(options.durationMinutes) } };
}

/** A task made from an event (an all-day event gives a date-only due date), and the day to show after. */
export function planCalendarEventTask(event: ExternalCalendarEvent, options: { calendarName?: string; t: Translate }) {
    const { initialProps, title } = buildCalendarEventTaskDraft(event, {
        calendarName: options.calendarName,
        fallbackTitle: options.t('calendar.eventFallbackTitle'),
    });
    return { title, initialProps, showDate: safeParseDate(initialProps.startTime ?? initialProps.dueDate ?? event.start) };
}
