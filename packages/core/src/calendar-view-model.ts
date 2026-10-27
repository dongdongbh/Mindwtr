/**
 * The Calendar screen's logic, shared by the React Native screen and the native
 * host contract (native-host-contract-calendar.ts): what each view mode lists and
 * in which order, the period it shows and how navigation moves it, the titles,
 * labels, counts and empty states, the tones each item is drawn in, and the plan
 * behind every action (reschedule, done, remove from calendar, task from event,
 * scheduling a task on a day).
 *
 * The screen keeps React state, gestures, scrolling, layout measurement, theme
 * colors and the platform I/O (reading device calendars and ICS feeds, opening
 * an event in the calendar app). Day cells and the composer reuse
 * calendar-day-items.ts, calendar-scheduling.ts and calendar-composer.ts.
 *
 * Heading dates come from a CalendarDates: the React Native screen keeps its
 * `toLocaleDateString` headings (createCalendarLocaleDates); the contract builds
 * them from date-fns patterns through its DateFormatter
 * (createCalendarPatternDates), because the native host's engine has no Intl.
 * The patterns give the same English text. Clock times format through a
 * DateFormatter (the app's configured `safeFormatDate` on mobile,
 * `createDateFormatter` in the contract).
 */
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

// ---------------------------------------------------------------------------
// View modes and week density.

export type CalendarViewMode = 'month' | 'day' | 'week' | 'schedule';

export const CALENDAR_WEEK_VISIBLE_DAYS_MIN = 2;
export const CALENDAR_WEEK_VISIBLE_DAYS_MAX = 7;
// Five days = a school or work week on one phone screen; a 390px phone gives
// each column ~67px, which the compact column styles are sized for.
export const CALENDAR_WEEK_VISIBLE_DAYS_DEFAULT = 5;

/** The timeline covers the whole day; free-slot search keeps the working day (8–23). */
export const CALENDAR_DAY_START_HOUR = 0;
export const CALENDAR_DAY_END_HOUR = 24;
export const CALENDAR_DAY_MINUTES = (CALENDAR_DAY_END_HOUR - CALENDAR_DAY_START_HOUR) * 60;
export const CALENDAR_SNAP_MINUTES = 5;
/** The schedule view looks this many days ahead and shows at most this many days with items. */
export const CALENDAR_SCHEDULE_DAYS = 45;
export const CALENDAR_SCHEDULE_MAX_SECTIONS = 18;
export const CALENDAR_PLANNING_LIMIT = 6;
export const CALENDAR_SEARCH_LIMIT = 8;
export const CALENDAR_COMPOSER_CANDIDATE_LIMIT = 10;
/** A month cell previews two items, and none once it holds six or more. */
export const CALENDAR_MONTH_PREVIEW_ITEMS = 2;
export const CALENDAR_MONTH_PREVIEW_HIDDEN_AT = 6;
export const CALENDAR_WEEK_ALL_DAY_ITEMS = 3;
/** The day view's pinned all-day card shows this many chips before "+N more", like desktop's all-day row. */
export const CALENDAR_DAY_ALL_DAY_ITEMS = 4;
/** A timeline tap opens the composer with this duration. */
export const CALENDAR_TAP_DURATION_MINUTES = 30;

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

/**
 * Resolves one requested density change while filtering duplicate samples from
 * a continuous slider gesture. The caller stores the returned value before
 * starting persistence so later gesture frames cannot enqueue the same write.
 */
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

/** The week density choices, fewest days first. */
export const CALENDAR_WEEK_DENSITY_VALUES: readonly number[] = Array.from(
    { length: CALENDAR_WEEK_VISIBLE_DAYS_MAX - CALENDAR_WEEK_VISIBLE_DAYS_MIN + 1 },
    (_, index) => CALENDAR_WEEK_VISIBLE_DAYS_MIN + index,
);

// ---------------------------------------------------------------------------
// Days, weeks and months.

/** The key the day maps use (month is 0-based): `${year}-${month}-${day}`. */
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

/** The locale tag calendar headings format with: the user's date format, language, calendar system and device locale. */
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

/** The month grid: blank cells up to the month's first weekday, then its days. */
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

/**
 * The window the screen shows, and the one to fetch external events for: the
 * week, 45 days from the selected day, or the month (day view included). A
 * "show future recurrence" task paints every occurrence in it.
 */
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

// ---------------------------------------------------------------------------
// Navigation.

/** What the screen is showing: the mode, the selected day (null: none in month view) and a day of the visible month. */
export type CalendarPeriodState = {
    viewMode: CalendarViewMode;
    selectedDate: Date | null;
    visibleMonthDate: Date;
};

export type CalendarPeriodMove = 'previous' | 'next' | 'today';

/**
 * Previous, next and Today: the month view moves its month; the day and week
 * views move the selected day by one day or one week (the month follows it);
 * Today selects today in every view. The schedule view only has Today.
 */
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

/** The selected day moved by `daysDelta`; the visible month follows it. Nothing moves without a selected day. */
export function shiftCalendarSelectedDate(state: CalendarPeriodState, daysDelta: number): CalendarPeriodState {
    if (!state.selectedDate) return state;
    const next = new Date(state.selectedDate);
    next.setDate(next.getDate() + daysDelta);
    return { ...state, selectedDate: next, visibleMonthDate: next };
}

/** Switching mode: the day, week and schedule views select today when nothing is selected. */
export function selectCalendarViewMode(state: CalendarPeriodState, viewMode: CalendarViewMode, now: Date = new Date()): CalendarPeriodState {
    if (!needsCalendarSelectedDate(viewMode) || state.selectedDate) return { ...state, viewMode };
    const next = new Date(now);
    return { viewMode, selectedDate: next, visibleMonthDate: next };
}

// ---------------------------------------------------------------------------
// Labels.

const translateWith = (t: Translate) => (key: string, values?: I18nTemplateValues) => resolveI18nText(t, key, { values });

/**
 * The heading dates of the calendar: the month title, a week's day range, the
 * day title, the details title, a short date, a month cell's spoken date, and
 * the short weekday labels (index 0 is Sunday).
 */
export type CalendarDates = {
    monthYear: (date: Date) => string;
    monthDay: (date: Date) => string;
    dayTitle: (date: Date) => string;
    longDate: (date: Date) => string;
    shortDate: (date: Date) => string;
    cellDate: (date: Date) => string;
    weekdays: readonly string[];
};

/** Headings as the React Native screen draws them: `toLocaleDateString` under the user's locale tag. */
export const createCalendarLocaleDates = (locale: string): CalendarDates => ({
    monthYear: (date) => date.toLocaleDateString(locale, { year: 'numeric', month: 'long' }),
    monthDay: (date) => date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    dayTitle: (date) => date.toLocaleDateString(locale, { weekday: 'short', month: 'long', day: 'numeric' }),
    longDate: (date) => date.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    shortDate: (date) => date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }),
    cellDate: (date) => date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' }),
    weekdays: getShortWeekdayLabels(locale),
});

/**
 * Headings from date-fns patterns through the user's DateFormatter, with no
 * Intl: the native host's engine has none. The patterns follow the locale's
 * day/month order and give the React Native screen's English text (en-US and
 * en-GB); other languages get date-fns's words in the same order. Weekday
 * labels follow getShortWeekdayLabels' rules (no trailing period, three
 * characters, or the narrow form when three would collide).
 */
export const createCalendarPatternDates = (formatDate: DateFormatter): CalendarDates => {
    const sample = formatDate(new Date(2001, 10, 22), 'P');
    const dayFirst = sample.indexOf('22') !== -1 && sample.indexOf('11') !== -1 && sample.indexOf('22') < sample.indexOf('11');
    const pattern = (monthFirst: string, dayFirstPattern: string) => (date: Date) => formatDate(date, dayFirst ? dayFirstPattern : monthFirst);
    // Index 0 is Sunday (2023-01-01), like getShortWeekdayLabels. Built in the current time
    // zone on each call; a module-load Date shifts every label by a day after a zone change.
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

/** The month grid's weekday header, starting on the week's first day. */
export const getCalendarDayNames = (dates: CalendarDates, weekStartIndex: number): string[] => (
    Array.from({ length: 7 }, (_, index) => dates.weekdays[(index + weekStartIndex) % 7])
);

export const getCalendarWeekdayLabel = (date: Date, dates: CalendarDates): string => dates.weekdays[date.getDay()];

const formatWithToday = (label: string, date: Date, now: Date, today: string): string => (
    `${label}${isSameCalendarDate(date, now) ? ` · ${today}` : ''}`
);

/** The selected day's month-details title, the planning list's subtitle and the day view's title. */
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

/** The schedule view's day heading ("Wed, Oct 28 · Today"). */
export const formatCalendarScheduleDayTitle = (date: Date, options: { dates: CalendarDates; t: Translate; now?: Date }): string => formatWithToday(
    options.dates.shortDate(date),
    date,
    options.now ?? new Date(),
    translateWith(options.t)('filters.datePreset.today'),
);


/**
 * A month cell's spoken label: the date, then its task and event counts.
 * Counts use each locale's singular and plural forms.
 */
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

/** The previous/next labels of a mode's period navigation, and Today. */
export const getCalendarNavigationLabels = (viewMode: CalendarViewMode, t: Translate) => {
    const tr = translateWith(t);
    const unit = viewMode === 'day' ? 'Day' : viewMode === 'week' ? 'Week' : 'Month';
    return {
        previous: tr(`calendar.prev${unit}`),
        next: tr(`calendar.next${unit}`),
        today: tr('filters.datePreset.today'),
    };
};

/** The screen's fixed labels, in the current language. */
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
        /** The density slider's spoken value ("5 days"). */
        weekDensityValue: (dayCount: number) => (dayCount === 1
            ? tr('calendar.mobile.1Day')
            : tr('calendar.mobile.visibleDayCount', { dayCount })),
        /** A density tick's label ("Show 5 visible days"). */
        weekDensityChoice: (dayCount: number) => (dayCount === 1
            ? tr('calendar.mobile.show1VisibleDay')
            : tr('calendar.mobile.showVisibleDayCount', { dayCount })),
    };
};

/** The task composer's fixed labels; the quick-add help drops the priority and estimate tokens while their features are off. */
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

/** A duration chip: "15m", "1h", "1.5h". */
export const formatCalendarDurationChip = (minutes: number): string => {
    if (minutes < 60) return `${minutes}m`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
};

// A localized "10:00 AM" wraps and clips in the 56px timeline gutter, so drop the :00 an hour
// line already implies. 24-hour locales ("13:00") fit as-is and would be left a bare "13".
export const compactHourLabel = (label: string): string => (
    /[^\d\s.:]/.test(label) ? label.replace(/[.:]00/, '') : label
);

export const formatCalendarHourLabel = (hour: number, formatDate: DateFormatter): string => {
    const sample = new Date(2025, 0, 1, hour, 0, 0, 0);
    return compactHourLabel(formatDate(sample, 'p'));
};

/** The timeline's hour labels, midnight to midnight. */
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

/** "Projected · Oct 31": the label a projected occurrence carries after its title or time. */
export const getProjectedRecurrenceDisplayLabel = (task: Task, projectedLabel: string, formatDate: DateFormatter): string => {
    const occurrenceDateLabel = formatDate(getTaskCalendarOccurrenceDate(task), PROJECTED_RECURRENCE_LABEL_DATE_FORMAT);
    return occurrenceDateLabel ? `${projectedLabel} · ${occurrenceDateLabel}` : projectedLabel;
};

export const getCalendarProjectedLabel = (t: Translate): string => translateWith(t)('calendar.projectedRecurrence');

/** "Title · Projected · Oct 31" for a projected occurrence, the title otherwise. */
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

/** One compact month row keeps the due clock, including a same-day scheduled task. */
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
    // Keep the exact clock visible even when a compact row truncates its title.
    return `${options.formatDate(due, 'p')} · ${options.t('calendar.due')} · ${title}`;
}

/** Appends the projected label to a time or kind label. */
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

// ---------------------------------------------------------------------------
// Tasks and events by day.

/**
 * Done, archived and reference tasks are excluded here: they belong to the
 * completed look-back, filed by completion date, not to the scheduled/deadline
 * buckets (#955). Recurring tasks that show their future occurrences paint
 * every occurrence in the visible range.
 */
export const getCalendarRangeTasks = (
    visibleTasks: readonly Task[],
    range: { rangeStartMs: number; rangeEndMs: number },
    projectedAtIso: string,
): Task[] => expandCalendarRecurringTaskSetInRange(
    visibleTasks.filter(isSchedulableCalendarTask),
    { startIso: new Date(range.rangeStartMs).toISOString(), endIso: new Date(range.rangeEndMs).toISOString() },
    projectedAtIso,
);

/** Tasks the planning, search and composer lists offer, by title. */
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

/** Finished work on the day it was completed, when the look-back is on (#955), in the area filter. */
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

/** An event on every local day it touches; one that ends at midnight does not reach the next day. */
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

/** Month details use the same scheduled-over-deadline choice as other views. */
export const getCalendarDetailsTaskLists = (lists: Pick<CalendarDayLists, 'deadlines' | 'scheduled'>) => {
    return { deadlines: getCalendarDistinctDeadlines(lists.deadlines, lists.scheduled), scheduled: lists.scheduled };
};

/** A day's distinct tasks: scheduled, due or completed that day. */
export const countCalendarDayTasks = (lists: CalendarDayLists): number => {
    const ids = new Set<string>();
    for (const task of lists.deadlines) ids.add(task.id);
    for (const task of lists.scheduled) ids.add(task.id);
    for (const task of lists.completed) ids.add(task.id);
    return ids.size;
};

/** The day view's timed tasks: scheduled at a clock time, still open. */
export const getCalendarDayTimedTasks = (scheduled: readonly Task[]): Task[] => scheduled.filter((task) => (
    isTimedScheduledTask(task)
    && !task.deletedAt
    && task.status !== 'done'
    && task.status !== 'reference'
));

/** Items without a clock time: date-only deadlines, completions, starts and all-day events. */
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

/** The schedule view: up to 18 days with items, from `start` over the next 45 days. */
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

// ---------------------------------------------------------------------------
// External calendars.

/**
 * A calendar's color: the user's pick, then the feed's own, then a stable
 * palette color for its id (#974), shown in the theme's variant.
 */
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

/** An event's time: "All day", or its clock range. */
export const formatCalendarEventTime = (event: ExternalCalendarEvent, options: { t: Translate; formatDate: DateFormatter }): string => {
    if (event.allDay) return options.t('calendar.allDay');
    const start = safeParseDate(event.start);
    const end = safeParseDate(event.end);
    return start && end ? formatCalendarClockRange(start, end, options.formatDate) : '';
};

// ---------------------------------------------------------------------------
// Surfaces. Tones name the theme color a part is drawn in; `source` is the
// event's calendar color.

export type CalendarTone = 'tint' | 'danger' | 'secondary' | 'text' | 'input' | 'none' | 'source';

/** A month cell: which items it previews, whether it shows the counts, and its spoken label. */
export function getCalendarMonthCell(
    date: Date,
    lists: CalendarDayLists,
    options: { dates: CalendarDates; t: Translate },
) {
    const items = getCalendarDayItems(lists);
    const taskCount = countCalendarDayTasks(lists);
    const eventCount = lists.events.length;
    // One-off items claim the cell's few visible rows before projected
    // recurring occurrences, which repeat every day.
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

/** How a month cell draws one preview item. */
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

/**
 * An all-day lane capped at `limit` chips, as desktop draws it: one-off items
 * take the slots before projected recurring ones, and `hiddenCount` is what a
 * "+N more" chip counts. `expanded` shows every item; `hiddenCount` stays the
 * collapsed count so the screen can keep offering the toggle.
 */
export function getCalendarAllDayLane(items: readonly CalendarDayItem[], limit: number, expanded = false) {
    const all = orderCalendarDayItemsForLimitedSlots(items.filter(isCalendarAllDayItem));
    return {
        items: expanded ? all : all.slice(0, limit),
        hiddenCount: Math.max(0, all.length - limit),
    };
}

/** The overflow chip's label: "+2 more", as desktop writes it. */
export const formatCalendarAllDayMore = (hiddenCount: number, t: Translate): string => `+${hiddenCount} ${t('calendar.more')}`;

/** The week view's all-day lane: its first three items; a projected one cannot be pressed. */
export const getCalendarWeekAllDayItems = (items: readonly CalendarDayItem[]): CalendarDayItem[] => (
    getCalendarAllDayLane(items, CALENDAR_WEEK_ALL_DAY_ITEMS).items
);

/**
 * An all-day chip, in the week lane and the day card alike, as desktop draws
 * it: a fill with a colored left edge (the event's calendar, the tint for a
 * scheduled or projected task, danger for a deadline), and a completed item
 * crossed out and muted.
 */
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

/** The day view's pinned all-day card: the week lane's chips, but a projected item still opens; completed items have no action. */
export const getCalendarDayAllDayTones = (item: CalendarDayItem) => ({
    ...getCalendarWeekAllDayTones(item),
    disabled: item.kind === 'completed',
});

/** A schedule view row's time line and spoken label. */
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

/** A month-details row of a deadline or scheduled task: its time line, and whether it offers Done. */
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

/** A month-details event row: the title with its calendar's name, and its time. */
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
/** Timeline coordinates are local clock minutes, including across a DST change. */
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
    /** Clamped to the day. */
    start: Date;
    end: Date;
    /** The clamped part's clock range. */
    timeLabel: string;
    layout: CalendarTimedLayout | undefined;
};

export type CalendarTimelineTask = {
    task: Task;
    /** The task's own start (not clamped). */
    start: Date;
    durationMinutes: number;
    /** Clamped to the day. */
    displayStart: Date;
    displayEnd: Date;
    layout: CalendarTimedLayout | undefined;
    projected: boolean;
    /** "9:00 AM-9:30 AM", with the projected label after it for an occurrence. */
    timeLabel: string;
};

/**
 * The day view's timeline: its timed events (in feed order), then its timed
 * tasks, each clamped to the day, side by side where they overlap.
 */
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

/** A week column's timed items in time order, clamped to the day, side by side where they overlap. */
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

/** The day and week start of the timeline for `date`. */
export const getCalendarDayBounds = (date: Date): { dayStart: Date; dayEnd: Date } => {
    const dayStart = new Date(date);
    dayStart.setHours(CALENDAR_DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(CALENDAR_DAY_END_HOUR, 0, 0, 0);
    return { dayStart, dayEnd };
};

/** Minutes into the timeline for the current-time line (drawn on today only), null outside it. */
export const getCalendarNowMinutes = (now: Date): number | null => {
    const minutes = (now.getHours() - CALENDAR_DAY_START_HOUR) * 60 + now.getMinutes();
    if (minutes < 0 || minutes > CALENDAR_DAY_MINUTES) return null;
    return minutes;
};

/** A timeline tap at `rawMinutes` into the day: snapped, and early enough for a 30-minute task. */
export const snapCalendarTimelineMinutes = (rawMinutes: number): number => {
    const snappedMinutes = Math.round(rawMinutes / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES;
    return Math.max(0, Math.min(CALENDAR_DAY_MINUTES - CALENDAR_TAP_DURATION_MINUTES, snappedMinutes));
};

// ---------------------------------------------------------------------------
// Planning, search and free slots.

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

/** The schedule search under a selected day: nothing until something is typed. */
export const getCalendarSearchResults = (schedulableTasks: readonly Task[], query: string): Task[] => (
    query.trim() ? matchingTitles(schedulableTasks, query, CALENDAR_SEARCH_LIMIT) : []
);

/** The composer's existing-task list: every schedulable task until something is typed. */
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

/** The first free slot of the working day (8–23, from now on today), snapped to five minutes. */
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

/** Whether `startTime` for `durationMinutes` overlaps nothing on its day. */
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

/** A planning or search row's second line: "Schedule · 10:00 AM-10:30 AM", or "Schedule" when the day is full. */
export const getCalendarScheduleActionLabel = (slot: Date | null, durationMinutes: number, options: { t: Translate; formatDate: DateFormatter }): string => {
    const slotLabel = slot ? formatCalendarTimeRange(slot, durationMinutes, options.formatDate) : null;
    return slotLabel ? `${options.t('calendar.scheduleAction')} · ${slotLabel}` : options.t('calendar.scheduleAction');
};

// ---------------------------------------------------------------------------
// The composer as the screen holds it: the shared state plus the picked day
// and the free-text start time.

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

/** The time fields' placeholders: 9:00 and 9:30 in the user's clock. */
export const getCalendarComposerPlaceholders = (formatDate: DateFormatter) => ({
    start: formatDate(new Date(2000, 0, 1, 9, 0), 'p', '09:00'),
    end: formatDate(new Date(2000, 0, 1, 9, 30), 'p', '09:30'),
});

/** Show a derived time in the user's clock while preserving raw edits. */
export const formatCalendarComposerClockValue = (value: string, date: Date | null, formatDate: DateFormatter): string => (
    date && value === formatCalendarTimeInputValue(date) ? formatDate(date, 'p', value) : value
);

// ---------------------------------------------------------------------------
// Actions.

export type CalendarSheetButton<Id extends string> = { id: Id; label: string; style: 'default' | 'destructive' | 'cancel' };

export type CalendarTaskSheet =
    | { kind: 'projected'; title: string; message: string; buttons: CalendarSheetButton<'ok'>[] }
    | { kind: 'actions'; title: string; buttons: CalendarSheetButton<'edit' | 'unschedule' | 'done' | 'delete' | 'cancel'>[] };

/**
 * What pressing a task offers: Edit, Remove from calendar (when it has a
 * start), Done (while open), Delete and Cancel. A projected occurrence only
 * explains itself.
 */
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

/** What pressing an event offers: Create task, Open in calendar (when the host can open it) and Cancel. */
export function getCalendarEventSheet(event: ExternalCalendarEvent, options: { canOpen: boolean; t: Translate }) {
    const { t } = options;
    const buttons: CalendarSheetButton<'createTask' | 'openInCalendar' | 'cancel'>[] = [
        { id: 'createTask', label: t('calendar.createTaskFromEvent'), style: 'default' },
    ];
    if (options.canOpen) buttons.push({ id: 'openInCalendar', label: t('calendar.openInCalendar'), style: 'default' });
    buttons.push({ id: 'cancel', label: t('common.cancel'), style: 'cancel' });
    return { title: event.title || t('calendar.eventFallbackTitle'), buttons };
}

/** Done from the calendar also takes the task off today's focus. */
export const CALENDAR_DONE_UPDATES: Readonly<Partial<Task>> = { status: 'done', isFocusedToday: false };
/** Remove from calendar: the start goes; the due date stays. */
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

/**
 * A dragged block let go at `startMinutes` into its day. A projected
 * occurrence never moves; a slot that overlaps something is refused with the
 * time-conflict toast; otherwise the task starts there.
 */
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

/** Convert minutes on a local calendar day to wall-clock time across DST. */
export const getCalendarMovedStart = (dayStartMs: number, startMinutes: number, currentStart?: Date | null): Date => {
    const start = new Date(dayStartMs);
    if (currentStart && calendarDateKey(currentStart) === calendarDateKey(start)
        && getCalendarWallMinutes(start, currentStart) === startMinutes) return currentStart;
    // ponytail: a new drop onto a repeated clock minute picks its first occurrence; choosing the second needs a fold-aware gesture coordinate.
    start.setHours(0, startMinutes, 0, 0);
    return start;
};

/** A task made from an event (an all-day event gives a date-only due date), and the day to show after. */
export function planCalendarEventTask(event: ExternalCalendarEvent, options: { calendarName?: string; t: Translate }) {
    const { initialProps, title } = buildCalendarEventTaskDraft(event, {
        calendarName: options.calendarName,
        fallbackTitle: options.t('calendar.eventFallbackTitle'),
    });
    return { title, initialProps, showDate: safeParseDate(initialProps.startTime ?? initialProps.dueDate ?? event.start) };
}
