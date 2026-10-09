/**
 * The native host contract for the Calendar screen: the month, week, day and
 * schedule views, their navigation, the task composer, and every action the
 * React Native screen offers on a calendar item. Kept in its own file and spread
 * into createNativeHostContract. Every view is built from core's calendar view
 * model (calendar-view-model.ts), the same functions the React Native screen
 * calls.
 *
 * The host keeps the screen's place as a `state` (mode, selected day, visible
 * month) and sends it back; every navigation control carries the state it leads
 * to. External calendars are platform I/O: the host fetches the view's `range`
 * and sends what it has as `calendar` (loading, ready or error).
 *
 * Reads are windowed by NATIVE_HOST_MAX_WINDOW under one revision. Writes go
 * through runCalendarAction with a request UUID: a request the receipts hold
 * (running, or owing its save) goes to them before any other check, and a retry
 * only saves (native-request-receipts.ts); every write is target-state, so a
 * replay after a restart writes nothing, a write to an existing task
 * compare-and-sets on the revision the view showed (a task changed since is
 * refused: STALE_REVISION), and a task a request made answers its replay only
 * while it is exactly what the request writes. Success means the change is
 * saved. A refusal the screen shows (a time conflict, a composer error) writes
 * nothing and leaves the request ID free. The iOS host exposes only the
 * prepared existing-composer write below; its complete stamped target row is
 * the durable receipt.
 *
 * Headings (month and week titles, day titles, weekday labels) come from
 * date-fns patterns through the user's date formatter: the host's engine has no
 * Intl. Their English text equals the React Native screen's.
 *
 * Only functions read this module's imports from native-host-contract.ts, so
 * the import cycle between the two files is safe.
 */
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import { getDefaultTaskAreaMode } from './area-utils';
import { filterCalendarEventsForAreas } from './external-calendar-ingestion';
import { buildCalendarEventTaskDraft, formatCalendarTimeInputValue, minutesToTimeEstimate } from './calendar-scheduling';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import {
    applyComposerCreatedProject,
    openComposerAt,
    openComposerForDate,
    prepareComposerSave,
    selectComposerTask,
    setComposerDuration,
    setComposerEndTime,
    setComposerMode,
    setComposerQuery,
    setComposerTitle,
    type CalendarComposerDeps,
    type CalendarComposerError,
    type CalendarComposerMode,
    type CalendarComposerSaveContext,
} from './calendar-composer';
import { getCalendarTimedDeadlines, getCalendarDeadlineMarkerGroups, type CalendarDayItem, type CalendarTimedLayout } from './calendar-day-items';
import { CALENDAR_TIME_ESTIMATE_OPTIONS, timeEstimateToMinutes } from './calendar-scheduling';
import {
    CALENDAR_DONE_UPDATES,
    CALENDAR_DAY_MINUTES,
    CALENDAR_UNSCHEDULE_UPDATES,
    CALENDAR_VIEW_MODES,
    CALENDAR_WEEK_DENSITY_VALUES,
    calendarDateKey,
    coerceCalendarViewMode,
    coerceCalendarWeekVisibleDays,
    createCalendarSourceColorResolver,
    findCalendarFreeSlot,
    formatCalendarDurationChip,
    formatCalendarComposerClockValue,
    formatCalendarMonthTitle,
    formatCalendarScheduleDayTitle,
    formatCalendarSelectedDateLabels,
    formatCalendarWeekTitle,
    getCalendarComposerCandidates,
    getCalendarComposerErrorText,
    getCalendarComposerPlaceholders,
    getCalendarComposerText,
    getCalendarDayAllDayTones,
    isCalendarAllDayItem,
    getCalendarDayBounds,
    getCalendarDayItems,
    getCalendarDayLists,
    getCalendarDetailsTaskLists,
    getCalendarDayNames,
    getCalendarDayTimeline,
    getCalendarDetailsEventRow,
    getCalendarDetailsTaskRow,
    getCalendarEventSheet,
    getCalendarHourLabels,
    getCalendarItemTitle,
    getCalendarMonthItemTitle,
    createCalendarPatternDates,
    getCalendarModeOptions,
    getCalendarMonthCell,
    getCalendarMovedStart,
    snapCalendarTimelineMinutes,
    getCalendarWallMinutes,
    getCalendarMonthDates,
    getCalendarMonthGrid,
    getCalendarMonthPreviewTones,
    getCalendarNavigationLabels,
    getCalendarNowMinutes,
    getCalendarPlanningTasks,
    getCalendarProjectedLabel,
    getCalendarRangeTasks,
    getCalendarScheduleActionLabel,
    getCalendarScheduleItemText,
    getCalendarScheduleItemTones,
    getCalendarScheduleSections,
    getCalendarSchedulableTasks,
    getCalendarScreenText,
    getCalendarSearchResults,
    getCalendarSourceNames,
    getCalendarSystem,
    getCalendarTaskSheet,
    getCalendarToasts,
    getCalendarVisibleRange,
    getCalendarWeekAllDayItems,
    getCalendarWeekAllDayTones,
    getCalendarWeekDays,
    getCalendarWeekStart,
    getCalendarWeekTimedEntries,
    getCalendarWeekdayLabel,
    indexCalendarCompletedTasks,
    indexCalendarDeadlineTasks,
    indexCalendarEvents,
    indexCalendarScheduledTasks,
    isCalendarComposerSaveDisabled,
    isCalendarSlotFree,
    isSameCalendarDate,
    moveCalendarPeriod,
    needsCalendarSelectedDate,
    planCalendarEventTask,
    planCalendarTaskMove,
    selectCalendarViewMode,
    setCalendarViewComposerStartTime,
    toCalendarViewComposer,
    type CalendarPeriodState,
    type CalendarSheetButton,
    type CalendarTone,
    type CalendarToast,
    type CalendarViewComposerState,
    type CalendarViewMode,
} from './calendar-view-model';
import { createDateFormatter, getCalendarDayOfMonth, getWeekStartsOnIndex, safeParseDate, startOfCalendarMonth, type DateFormatter, type DateFormattingConfig } from './date';
import type { ExternalCalendarEvent, ExternalCalendarSubscription } from './ics';
import { formatLocalDate } from './import-source-reader';
import { logInfo } from './logger';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { createNativeRequestReceipts, isRevision, refuseStale, requestRowId, runStoreWrite, settleWrite, taskRevisionOf, withRequestProject, type NativeUnsavedWrite } from './native-request-receipts';
import { buildQuickAddParseOptions } from './quick-add';
import { isProjectedRecurringTask, isProjectedRecurringTaskId } from './recurrence';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { useTaskStore } from './store';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import { isTaskDateCoherent } from './task-date-coherence';
import { prepareTaskUpdatesForStore } from './store-tasks';
import { applyTaskUpdates, ensureDeviceId, findTaskProjectReactivationTarget, getNextProjectOrder, nextRevision } from './store-helpers';
import { buildNewTask } from './task-creation';
import { buildNewProject } from './store-projects/project-actions';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { normalizeFocusTaskLimit } from './focus-utils';
import { projectToSqliteRow } from './project-sync-schema';
import { generateUUID } from './uuid';
import { countFocusedTasksBeforeBoundary } from './task-utils';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { themeDescriptor } from './theme-scheme';
import type { Area, Project, Section, Task } from './types';
import type { PreparedCalendarCreate } from './store-types';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];
type Translate = (key: string) => string;

export type CalendarViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => Translate;
    /** The user's date settings; clock times format through createDateFormatter with them. */
    dateFormatting: () => DateFormattingConfig;
    /** Data and settings revision, without the clock: what the period index reads. */
    dataRevision: () => string;
    /** Rows with core meta, as the other contract lists build them. */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

/**
 * The external calendars as the host fetched them for the view's `range`.
 * While a refetch runs for the same range, send the calendars and events already
 * shown with `loading`; after a failure the screen keeps the calendars and shows
 * no events. A ready feed's warning keeps its successfully fetched events.
 * Absent: no calendar fetched.
 */
export type NativeCalendarFeed =
    | { status: 'loading'; calendars?: ExternalCalendarSubscription[]; events?: ExternalCalendarEvent[] }
    | { status: 'error'; message: string; calendars?: ExternalCalendarSubscription[] }
    | { status: 'ready'; calendars: ExternalCalendarSubscription[]; events: ExternalCalendarEvent[]; warning?: string };

/** The screen's place: its mode, the selected day (null: none, month view only) and a day of the visible month. Days are `yyyy-MM-dd`. */
export type NativeCalendarState = { viewMode: CalendarViewMode; selectedDate: string | null; visibleMonth: string };

export type NativeCalendarItem = {
    /** The React Native item id ("scheduled-<task>", "deadline-<task>", "completed-<task>", "event-<event>"), or the task or event id in a list. */
    id: string;
    kind: 'scheduled' | 'deadline' | 'completed' | 'event';
    taskId: string | null;
    eventId: string | null;
    /** The exact displayed occurrence; provider identity remains transient. */
    eventRef: { sourceId: string; id: string; start: string; end: string } | null;
    /** The title as drawn: a projected occurrence adds "· Projected · Oct 31" where the screen does. */
    title: string;
    /** The second line (a time, "All day", "Deadline"), or null where the surface draws none. */
    detail: string | null;
    accessibilityLabel: string | null;
    projected: boolean;
    /** Pressing opens getCalendarItemSheet. False for completed or projected items where the screen disables it. */
    pressable: boolean;
    /** Theme tones: `fill` behind the item, `accent` on its left edge, `text` its title; `source` means `sourceColor`. */
    tones: { fill: CalendarTone | null; accent: CalendarTone | null; text: CalendarTone | null; dashed: boolean; struck: boolean; faded: boolean };
    /** The event's calendar color, as the screen resolves it. */
    sourceColor: string | null;
    /**
     * A timed block: minutes into the day (clamped to it), its column among
     * overlapping blocks, and a task's own duration (what a drag moves).
     */
    timed: { startMinutes: number; endMinutes: number; durationMinutes: number; column: CalendarTimedLayout | null } | null;
    /** Point geometry only; never a duration or a movable scheduled block. */
    deadline?: { startMinutes: number; labelMinutes: number; groupId: string; groupIndex: number; groupSize: number };
    /** The row offers Done (month details). */
    showDone: boolean;
    row: NativeTaskRow | null;
};

export type NativeCalendarEntry =
    /** A month cell with its preview items, a week column header, or a schedule day heading. */
    | {
        type: 'day';
        key: string;
        title: string;
        dayNumber: string;
        weekday: string;
        isToday: boolean;
        selected: boolean;
        accessibilityLabel: string | null;
        /** Month cells that hide items show their task and event counts. */
        counts: { tasks: number; events: number } | null;
        preview: NativeCalendarItem[];
        /** Pressing a week column header opens this day in the day view. */
        opens: NativeCalendarState | null;
    }
    /** An item in a lane of a day: the week's all-day lane or timeline, the day view's, a schedule day, or the month details' lists. */
    | { type: 'item'; dayKey: string; lane: 'allDay' | 'timed' | 'deadlineMarker' | 'list' | 'events' | 'deadlines' | 'scheduled'; item: NativeCalendarItem }
    /** A task to schedule: a search result under the selected day, or a planning suggestion. Press it with openCalendarComposer({ scheduleTaskId }). */
    | { type: 'task'; list: 'search' | 'planning'; taskId: string; title: string; detail: string; row: NativeTaskRow };

type NavigationTarget = { label: string; state: NativeCalendarState };

export type NativeCalendarView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** The state this view shows; keep it and send it back. */
    state: NativeCalendarState;
    /** Fetch external events for this window and send them as `calendar`. */
    range: { start: string; end: string };
    /** All modes expose loading, whole-feed failures and retained ready warnings. */
    feedState: { status: 'ready' | 'loading' | 'error'; message: string | null };
    header: {
        title: string;
        /** The day view uses the day title style. */
        titleVariant: 'day' | 'standard';
        previous: NavigationTarget | null;
        next: NavigationTarget | null;
        today: NavigationTarget;
    };
    /** The mode switch; choosing one also runs setViewMode, which the screen saves. */
    modes: { mode: CalendarViewMode; label: string; selected: boolean; state: NativeCalendarState }[];
    showCompleted: { label: string; hint: string; on: boolean };
    text: Omit<ReturnType<typeof getCalendarScreenText>, 'weekDensityValue' | 'weekDensityChoice'> & { toasts: NativeCalendarToasts };
    content:
        | {
            mode: 'month';
            dayNames: string[];
            /** Blank cells before the month's first day. */
            leadingBlanks: number;
            /** The selected day's details panel; `close` is the state without it. */
            details: {
                title: string;
                close: NativeCalendarState;
                query: string;
                searchTitle: string | null;
                /** Null when no external calendar is configured. */
                events: { title: string; loading: string | null; error: string | null } | null;
                empty: string | null;
            } | null;
        }
        | {
            mode: 'week';
            visibleDays: number;
            density: { value: string; choices: { days: number; label: string; selected: boolean }[] };
            hourLabels: string[];
            /** Minutes into today for the current-time line; the column of today draws it. */
            nowMinutes: number | null;
        }
        | {
            mode: 'day';
            dayKey: string;
            hourLabels: string[];
            nowMinutes: number | null;
            query: string;
            searchTitle: string | null;
        }
        | {
            mode: 'schedule';
            planning: { title: string; subtitle: string } | null;
            empty: string | null;
        };
    total: number;
    items: NativeCalendarEntry[];
};

export type NativeCalendarToasts = Omit<ReturnType<typeof getCalendarToasts>, 'saveFailed'> & { saveFailed: CalendarToast };

/** The composer as the host holds it: send it back with every edit and to save. Instants are ISO. */
export type NativeCalendarComposer = {
    date: string;
    startTimeValue: string;
    startAt: string | null;
    endTimeValue: string;
    durationMinutes: number;
    mode: CalendarComposerMode;
    title: string;
    query: string;
    selectedTaskId: string | null;
    /** The selected task's revision when core selected it: an existing-task Save is compare-and-set on it. */
    taskRevision: string | null;
    error: CalendarComposerError | null;
};

export type NativeCalendarComposerView = {
    composer: NativeCalendarComposer;
    timeLabels: { start: string; end: string };
    text: ReturnType<typeof getCalendarComposerText>;
    dateLabel: string;
    placeholders: { start: string; end: string };
    durations: { minutes: number; label: string; selected: boolean }[];
    /** The existing-task list (existing mode only). */
    candidates: { id: string; title: string; selected: boolean }[] | null;
    selectedTaskTitle: string | null;
    error: string | null;
    saveDisabled: boolean;
};

export type NativeCalendarComposerEdit =
    | { type: 'mode'; mode: CalendarComposerMode }
    | { type: 'title'; title: string }
    | { type: 'query'; query: string }
    | { type: 'selectTask'; taskId: string }
    | { type: 'startTime'; value: string }
    | { type: 'endTime'; value: string }
    | { type: 'duration'; minutes: number };

export type NativeCalendarSheet =
    | { kind: 'projected'; title: string; message: string; buttons: CalendarSheetButton<'ok'>[] }
    /** Remove from calendar, Done and Delete send `taskRevision` back. */
    | { kind: 'task'; taskId: string; taskRevision: string; title: string; buttons: CalendarSheetButton<'edit' | 'unschedule' | 'done' | 'delete' | 'cancel'>[] }
    | { kind: 'event'; title: string; buttons: CalendarSheetButton<'createTask' | 'openInCalendar' | 'cancel'>[];
        creationTemplate?: NativeCalendarEventTaskTemplate };

export type NativeCalendarAction =
    /** The composer's Save. A new task takes the request ID as its id. */
    | { type: 'saveComposer'; composer: NativeCalendarComposer }
    /**
     * A timeline block let go at `startMinutes` into `day`. This and the next three send the
     * task's revision the view showed (an item's `row.taskRevision`, the sheet's `taskRevision`).
     */
    | { type: 'moveTask'; taskId: string; day: string; startMinutes: number; durationMinutes: number; taskRevision: string }
    | { type: 'unscheduleTask'; taskId: string; taskRevision: string }
    | { type: 'completeTask'; taskId: string; taskRevision: string }
    | { type: 'deleteTask'; taskId: string; taskRevision: string }
    /** An event's Create task. The request ID becomes the task id. */
    | { type: 'createTaskFromEvent'; event: ExternalCalendarEvent }
    | { type: 'setViewMode'; viewMode: CalendarViewMode }
    | { type: 'setShowCompleted'; on: boolean }
    | { type: 'setWeekVisibleDays'; days: number };

export type NativeCalendarActionResult = {
    /** False when the action had nothing to write, or was refused (see `toast` and `composer`). */
    changed: boolean;
    toast: CalendarToast | null;
    /** The state to show after it: the day view on a saved composer's start, an event task's day. */
    next: NativeCalendarState | null;
    /** The day view scrolls its timeline to this minute. */
    scrollToMinutes: number | null;
    /** A refused composer save: the composer with its error. */
    composer: NativeCalendarComposerView | null;
    /** The task a composer save or an event wrote. */
    taskId: string | null;
};

/** Canonical stored preferences, independent of the Calendar's transient period. */
export type NativeCalendarPreferences = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    values: { viewMode: CalendarViewMode; showCompleted: boolean; weekVisibleDays: number };
};

export type NativeCalendarPreferenceRequest = {
    [Field in keyof NativeCalendarPreferences['values']]: {
        requestId: string;
        field: Field;
        before: NativeCalendarPreferences['values'][Field];
        value: NativeCalendarPreferences['values'][Field];
    }
}[keyof NativeCalendarPreferences['values']];

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const isPreferenceValue = (field: unknown, value: unknown): boolean => (
    field === 'viewMode' ? CALENDAR_VIEW_MODES.includes(value as CalendarViewMode)
        : field === 'showCompleted' ? typeof value === 'boolean'
            : field === 'weekVisibleDays' && CALENDAR_WEEK_DENSITY_VALUES.includes(value as number)
);
const isPaging = (input: Record<string, unknown>) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
    && (input.revision === undefined || typeof input.revision === 'string')
    && ((input.offset as number) === 0 || typeof input.revision === 'string')
);
/** A short, stable key for a view's own inputs, so a page of one view never continues another. */
const paramsKey = (params: unknown): string => {
    const text = JSON.stringify(params);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
};

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENTERED_LIMIT = 200;
const MAX_EVENTS = 2000;
const MAX_CALENDARS = 200;
const ISO_INSTANT_LIMIT = 64;

/** A `yyyy-MM-dd` day as local midnight, or null. */
const parseDayKey = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return formatLocalDate(date) === value ? date : null;
};
const dayKey = (date: Date): string => formatLocalDate(date);
const toState = (period: CalendarPeriodState): NativeCalendarState => ({
    viewMode: period.viewMode,
    selectedDate: period.selectedDate ? dayKey(period.selectedDate) : null,
    visibleMonth: dayKey(period.visibleMonthDate),
});

const isEvent = (value: unknown): value is ExternalCalendarEvent => (
    isObjectRecord(value) && isText(value.id) && isText(value.sourceId) && isText(value.title, 2000)
    && isText(value.start, ISO_INSTANT_LIMIT) && isText(value.end, ISO_INSTANT_LIMIT) && typeof value.allDay === 'boolean'
    && (value.nativeEventId === undefined || isText(value.nativeEventId))
    && (value.description === undefined || isText(value.description, 20_000))
    && (value.location === undefined || isText(value.location, 2000))
);
const isCalendarSource = (value: unknown): value is ExternalCalendarSubscription => (
    isObjectRecord(value) && isText(value.id) && isText(value.name, 2000)
    && (value.color === undefined || isText(value.color, 64)) && (value.feedColor === undefined || isText(value.feedColor, 64))
    && (value.areaIds === undefined || isList(value.areaIds, 200, (id): id is string => isText(id, 200)))
);
const isList = <T,>(value: unknown, limit: number, check: (entry: unknown) => entry is T): value is T[] => (
    Array.isArray(value) && value.length <= limit && value.every(check)
);

type Feed = { status: NativeCalendarFeed['status']; calendars: ExternalCalendarSubscription[]; events: ExternalCalendarEvent[]; loading: boolean; error: string | null };
const readFeed = (value: unknown): Feed | null => {
    if (value === undefined) return { status: 'ready', calendars: [], events: [], loading: false, error: null };
    if (!isObjectRecord(value)) return null;
    const calendars = value.calendars === undefined ? [] : value.calendars;
    if (!isList(calendars, MAX_CALENDARS, isCalendarSource)) return null;
    if (value.status === 'loading') {
        const events = value.events === undefined ? [] : value.events;
        return isList(events, MAX_EVENTS, isEvent) ? { status: 'loading', calendars, events, loading: true, error: null } : null;
    }
    if (value.status === 'error' && isText(value.message, 2000)) return { status: 'error', calendars, events: [], loading: false, error: value.message };
    if (value.status === 'ready' && isList(value.events, MAX_EVENTS, isEvent)
        && (value.warning === undefined || isText(value.warning, 2000))) {
        return { status: 'ready', calendars, events: value.events, loading: false, error: value.warning ?? null };
    }
    return null;
};

/** The composer as the contract holds it: the view model's state and the selected task's revision. */
type ComposerState = CalendarViewComposerState & { taskRevision: string | null };

const toComposer = (state: ComposerState): NativeCalendarComposer => ({
    date: state.date.toISOString(),
    startTimeValue: state.startTimeValue,
    startAt: state.startAt ? state.startAt.toISOString() : null,
    endTimeValue: state.endTimeValue,
    durationMinutes: state.durationMinutes,
    mode: state.mode,
    title: state.title,
    query: state.query,
    selectedTaskId: state.selectedTaskId,
    taskRevision: state.taskRevision,
    error: state.error,
});
const COMPOSER_ERROR_CODES = new Set(['invalid_range', 'title_required', 'task_required', 'overlap', 'invalid_date_command', 'start_after_due', 'save_failed']);
const readComposer = (value: unknown, formatDate: DateFormatter): ComposerState | null => {
    if (!isObjectRecord(value)) return null;
    const date = isText(value.date, ISO_INSTANT_LIMIT) ? safeParseDate(value.date) : null;
    const startAt = value.startAt === null ? null : isText(value.startAt, ISO_INSTANT_LIMIT) ? safeParseDate(value.startAt) : undefined;
    const error = value.error;
    const validError = error === null || (isObjectRecord(error) && COMPOSER_ERROR_CODES.has(error.code as string)
        && (error.detail === undefined || isText(error.detail, 2000)));
    if (!date || startAt === undefined || !validError
        || !isText(value.startTimeValue, 64) || !isText(value.endTimeValue, 64)
        || !Number.isSafeInteger(value.durationMinutes) || (value.durationMinutes as number) < 1 || (value.durationMinutes as number) > 24 * 60
        || (value.mode !== 'new' && value.mode !== 'existing')
        || !isText(value.title, 10_000) || !isText(value.query, 2000)
        || (value.selectedTaskId !== null && !isText(value.selectedTaskId))
        || (value.taskRevision !== null && !isRevision(value.taskRevision))) {
        return null;
    }
    const rawStart = startAt ? formatCalendarTimeInputValue(startAt) : null;
    const end = startAt ? new Date(startAt.getTime() + (value.durationMinutes as number) * 60_000) : null;
    const rawEnd = end ? formatCalendarTimeInputValue(end) : null;
    return {
        date,
        startTimeValue: rawStart && value.startTimeValue === formatDate(startAt, 'p', rawStart) ? rawStart : value.startTimeValue,
        startAt,
        endTimeValue: rawEnd && value.endTimeValue === formatDate(end, 'p', rawEnd) ? rawEnd : value.endTimeValue,
        durationMinutes: value.durationMinutes as number,
        mode: value.mode,
        title: value.title,
        query: value.query,
        selectedTaskId: value.selectedTaskId as string | null,
        taskRevision: value.taskRevision as string | null,
        error: error as CalendarComposerError | null,
    };
};

export type NativeCalendarScheduleRequest = { requestId: string; composer: NativeCalendarComposer };
type ResolverProject = { id: string; status: Project['status']; deletedAt: string | null; purgedAt: string | null };
type ResolverSection = { id: string; projectId: string; deletedAt: string | null };
type ResolverArea = { id: string; deletedAt: string | null };
type CalendarSchedulePolicy = {
    preparedAt: string;
    preparedOffsetMinutes: number;
    preparedLocalDay: string;
    endOfLocalTodayUTC: string;
    endOffsetMinutes: number;
    container: { project: ResolverProject | null; section: ResolverSection | null; area: ResolverArea | null };
    normalizedUpdates: Record<string, unknown>;
};
export type NativePreparedCalendarSchedule = {
    version: 1;
    request: NativeCalendarScheduleRequest;
    kind: 'existing';
    before: Task;
    after: Task;
    requested: { startTime: string; timeEstimate: NonNullable<Task['timeEstimate']> };
    policy: CalendarSchedulePolicy;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    projection: { offsetMinutes: number; localDay: string; localMinute: number };
    result: NativeCalendarActionResult;
};
export type NativeCalendarSchedulePreparation = { kind: 'prepared'; prepared: NativePreparedCalendarSchedule }
    | { kind: 'refused' | 'noop'; result: NativeCalendarActionResult };

export type NativeCalendarUnscheduleRequest = { requestId: string; taskId: string; taskRevision: string };
export type NativePreparedCalendarUnschedule = {
    version: 1;
    kind: 'unschedule';
    request: NativeCalendarUnscheduleRequest;
    before: Task;
    after: Task;
    policy: CalendarSchedulePolicy;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    result: NativeCalendarActionResult;
};
export type NativeCalendarUnschedulePreparation = { kind: 'prepared'; prepared: NativePreparedCalendarUnschedule }
    | { kind: 'noop'; result: NativeCalendarActionResult };

export type NativeCalendarCreateRequest = { requestId: string; composer: NativeCalendarComposer };
type CalendarCreateIntent = {
    sourceTitle: string;
    title: string;
    props: Partial<Task>;
    projectToCreate: { name: string; color: string; areaId: string | null } | null;
};
type CalendarCreationWitness = {
    selectedProject: Project | null;
    areas: Area[];
    projectOrderMax: number | null;
    taskOrderMax: number | null;
    defaultAreaMode: string | null;
    defaultAreaId: string | null;
    defaultProjectFlowMode: string | null;
    focusCount: number;
    focusLimit: number;
    focusRequested: boolean;
    sequentialEmpty: boolean;
    focusEndOfTodayIso: string | null;
    focusEndOffsetMinutes: number | null;
    preparedOffsetMinutes: number;
    preparedLocalDay: string;
};
export type NativePreparedCalendarCreate = {
    version: 1;
    kind: 'new';
    request: NativeCalendarCreateRequest;
    intent: CalendarCreateIntent;
    task: Task;
    project: Project | null;
    generatedLinkIds: string[];
    preparedAt: string;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    creation: CalendarCreationWitness;
    projection: { offsetMinutes: number; localDay: string; localMinute: number };
    result: NativeCalendarActionResult;
};
export type NativeCalendarCreatePreparation = { kind: 'prepared'; prepared: NativePreparedCalendarCreate }
    | { kind: 'refused'; result: NativeCalendarActionResult };

/** Only the fields RN intentionally copies; never a provider id, URL or feed. */
export type NativeCalendarEventTaskTemplate = {
    event: { title: string; start: string; end: string; allDay: boolean; description?: string; location?: string };
    calendarName: string | null;
    fallbackTitle: string;
    state: NativeCalendarState;
};
export type NativeCalendarEventTaskCreateRequest = NativeCalendarEventTaskTemplate & { requestId: string };
export type NativePreparedCalendarEventTaskCreate = Omit<NativePreparedCalendarCreate, 'kind' | 'request' | 'generatedLinkIds'> & {
    kind: 'event';
    request: NativeCalendarEventTaskCreateRequest;
    defaultAreaWitness: NonNullable<PreparedCalendarCreate['defaultAreaWitness']> | null;
};
export type NativeCalendarEventTaskCreatePreparation = { kind: 'prepared'; prepared: NativePreparedCalendarEventTaskCreate };

const CALENDAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const calendarRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const calendarKeys = (value: Record<string, unknown>, expected: readonly string[]) => (
    Object.keys(value).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);
const calendarSame = (left: unknown, right: unknown): boolean => {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : calendarRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
};
const calendarStoredRow = (task: Task): Task => {
    const values = taskToSqliteRow(task);
    return taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]])));
};
const calendarRowEqual = (left: Task, right: Task) => calendarSame(calendarStoredRow(left), calendarStoredRow(right));
const calendarUtf8Within = (text: string, limit: number): boolean => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index++;
        } else bytes += 3;
        if (bytes > limit) return false;
    }
    return true;
};
const localProjection = (instant: string, offsetMinutes: number) => {
    const projected = new Date(Date.parse(instant) + offsetMinutes * 60_000);
    return { day: projected.toISOString().slice(0, 10), minute: projected.getUTCHours() * 60 + projected.getUTCMinutes() };
};
const offsetValid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= -840 && (value as number) <= 840;
const instantValid = (value: unknown): value is string => typeof value === 'string' && CALENDAR_INSTANT.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const storedCalendarDateValid = (value: unknown): value is string => instantValid(value)
    || (typeof value === 'string' && DAY_KEY_PATTERN.test(value)
        && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
        && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
// The composer a prepared journal froze: the view's composer, with the selected task's
// revision (receipts' compare-and-set) or, journaled before that field, without it.
const PREPARED_COMPOSER_KEYS = ['date', 'startTimeValue', 'startAt', 'endTimeValue', 'durationMinutes', 'mode', 'title', 'query', 'selectedTaskId', 'error'] as const;
const preparedComposerKeysValid = (composer: Record<string, unknown>) => calendarKeys(composer, PREPARED_COMPOSER_KEYS)
    || (calendarKeys(composer, [...PREPARED_COMPOSER_KEYS, 'taskRevision']) && (composer.taskRevision === null || isRevision(composer.taskRevision)));
const calendarUpdates = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === undefined ? null : item]));
const projectProjection = (project: Project | undefined): ResolverProject | null => project ? {
    id: project.id, status: project.status, deletedAt: project.deletedAt ?? null, purgedAt: project.purgedAt ?? null,
} : null;
const sectionProjection = (section: Section | undefined): ResolverSection | null => section ? {
    id: section.id, projectId: section.projectId, deletedAt: section.deletedAt ?? null,
} : null;
const areaProjection = (area: Area | undefined): ResolverArea | null => area ? { id: area.id, deletedAt: area.deletedAt ?? null } : null;
const resolverLists = (container: CalendarSchedulePolicy['container']) => ({
    projects: container.project ? [{ ...container.project, deletedAt: container.project.deletedAt ?? undefined,
        purgedAt: container.project.purgedAt ?? undefined }] as Project[] : [],
    sections: container.section ? [{ ...container.section, deletedAt: container.section.deletedAt ?? undefined }] as Section[] : [],
    areas: container.area ? [{ ...container.area, deletedAt: container.area.deletedAt ?? undefined }] as Area[] : [],
});

const CREATE_PROPS = new Set(['status', 'description', 'contexts', 'tags', 'assignedTo', 'priority', 'energyLevel',
    'startTime', 'dueDate', 'reviewAt', 'timeEstimate', 'projectId', 'areaId', 'isFocusedToday', 'attachments']);
const validCreateTokens = (value: unknown) => Array.isArray(value) && value.length <= 100
    && value.every((item) => typeof item === 'string' && item.length <= 500)
    && new Set(value).size === value.length;
const createIntentValid = (intent: CalendarCreateIntent, request: NativeCalendarCreateRequest) => {
    if (!calendarRecord(intent) || !calendarKeys(intent, ['sourceTitle', 'title', 'props', 'projectToCreate'])
        || intent.sourceTitle !== request.composer.title || typeof intent.title !== 'string' || !intent.title.trim()
        || intent.title.length > 10_000 || !calendarRecord(intent.props)
        || Object.keys(intent.props).some((key) => !CREATE_PROPS.has(key))
        || intent.props.startTime !== request.composer.startAt
        || intent.props.timeEstimate !== minutesToTimeEstimate(request.composer.durationMinutes)
        || (intent.props.status !== undefined && !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(intent.props.status))
        || (intent.props.description !== undefined && (typeof intent.props.description !== 'string' || intent.props.description.length > 20_000))
        || (intent.props.contexts !== undefined && !validCreateTokens(intent.props.contexts))
        || (intent.props.tags !== undefined && !validCreateTokens(intent.props.tags))
        || (intent.props.assignedTo !== undefined && (typeof intent.props.assignedTo !== 'string' || intent.props.assignedTo.length > 500))
        || (intent.props.priority !== undefined && !['low', 'medium', 'high', 'urgent'].includes(intent.props.priority))
        || (intent.props.energyLevel !== undefined && !['low', 'medium', 'high'].includes(intent.props.energyLevel))
        || (intent.props.dueDate !== undefined && !storedCalendarDateValid(intent.props.dueDate))
        || (intent.props.reviewAt !== undefined && !storedCalendarDateValid(intent.props.reviewAt))
        || (intent.props.projectId !== undefined && (typeof intent.props.projectId !== 'string' || intent.props.projectId.length > 500))
        || (intent.props.areaId !== undefined && (typeof intent.props.areaId !== 'string' || intent.props.areaId.length > 500))
        || (intent.props.isFocusedToday !== undefined && intent.props.isFocusedToday !== true)
        || (intent.props.attachments !== undefined && (!Array.isArray(intent.props.attachments) || intent.props.attachments.length > 64
            || intent.props.attachments.some((attachment) => !calendarRecord(attachment)
                || !calendarKeys(attachment, ['id', 'kind', 'title', 'uri', 'createdAt', 'updatedAt'])
                || attachment.kind !== 'link' || typeof attachment.title !== 'string' || typeof attachment.uri !== 'string'
                || attachment.title.length > 2_000 || attachment.uri.length > 10_000)))) return false;
    const project = intent.projectToCreate;
    return project === null || (calendarRecord(project) && calendarKeys(project, ['name', 'color', 'areaId'])
        && typeof project.name === 'string' && Boolean(project.name.trim()) && project.name.length <= 10_000
        && project.color === DEFAULT_PROJECT_COLOR
        && (project.areaId === null || typeof project.areaId === 'string'));
};

/** Re-run the existing factories over only the inputs they read; never parse the user's title again. */
const calendarCreatedRows = (prepared: Pick<NativePreparedCalendarCreate, 'creation' | 'intent' | 'project' | 'preparedAt' | 'deviceIdBefore' | 'deviceIdToInitialize'>
    & { request: { requestId: string } }): { task: Task; project: Project | null } | null => {
    const { creation, intent, project, preparedAt } = prepared;
    const settings = { gtd: {
        defaultAreaMode: creation.defaultAreaMode, defaultAreaId: creation.defaultAreaId,
        defaultProjectFlowMode: creation.defaultProjectFlowMode,
    } } as unknown as ReturnType<typeof useTaskStore.getState>['settings'];
    const deviceId = prepared.deviceIdBefore ?? prepared.deviceIdToInitialize;
    if (!deviceId) return null;
    let createdProject: Project | null = null;
    if (project) {
        if (!intent.projectToCreate || creation.selectedProject) return null;
        const orderWitness = creation.projectOrderMax === null ? [] : [{
            id: 'calendar-order-witness', areaId: intent.projectToCreate.areaId ?? undefined,
            order: creation.projectOrderMax,
        } as Project];
        createdProject = buildNewProject({
            title: intent.projectToCreate.name, color: intent.projectToCreate.color,
            initialProps: intent.projectToCreate.areaId === null ? undefined : { areaId: intent.projectToCreate.areaId },
            existingProjects: orderWitness, existingAreas: creation.areas, settings, deviceId,
            now: preparedAt, id: project.id,
        });
    }
    const selectedProject = createdProject ?? creation.selectedProject;
    const draft = intent.projectToCreate && selectedProject
        ? applyComposerCreatedProject({ title: intent.title, props: intent.props }, selectedProject.id)
        : { title: intent.title, props: intent.props };
    const order = creation.taskOrderMax;
    const built = buildNewTask({
        title: draft.title, initialTaskProps: draft.props, id: prepared.request.requestId.toLowerCase(),
        now: preparedAt, deviceId,
        state: { settings, _allProjects: selectedProject ? [selectedProject] : [], _allSections: [], _allAreas: creation.areas },
        tasks: [], focusedCount: creation.focusCount, focusTaskLimit: creation.focusLimit,
        projectOrderReserver: (projectId) => projectId ? (order ?? -1) + 1 : undefined,
        endOfTodayIso: creation.focusEndOfTodayIso ?? undefined,
    });
    return built.ok ? { task: built.task, project: createdProject } : null;
};

/** No store, parser, current clock, or timezone access: also runs before terminal journal cleanup. */
export const validatePreparedCalendarCreate = (input: unknown): NativeHostResult<NativeCalendarActionResult> => {
    try {
        if (!calendarRecord(input) || !calendarKeys(input, ['request', 'prepared'])
            || !calendarRecord(input.request) || !calendarRecord(input.prepared)) return fail('INVALID_INPUT', 'Malformed prepared Calendar creation');
        const request = input.request as NativeCalendarCreateRequest;
        const prepared = input.prepared as NativePreparedCalendarCreate;
        const composer = request.composer;
        const creation = prepared.creation;
        const projection = prepared.projection;
        if (!calendarKeys(input.request, ['requestId', 'composer']) || !CALENDAR_UUID.test(request.requestId)
            || request.requestId !== request.requestId.toLowerCase()
            || !calendarRecord(composer)
            || !preparedComposerKeysValid(composer)
            || composer.mode !== 'new' || !instantValid(composer.date) || !instantValid(composer.startAt)
            || typeof composer.startTimeValue !== 'string' || composer.startTimeValue.length > 64
            || typeof composer.endTimeValue !== 'string' || composer.endTimeValue.length > 64
            || !Number.isSafeInteger(composer.durationMinutes) || composer.durationMinutes < 1 || composer.durationMinutes > 1440
            || typeof composer.title !== 'string' || composer.title.length > 10_000
            || typeof composer.query !== 'string' || composer.query.length > 2000
            || (composer.selectedTaskId !== null && (typeof composer.selectedTaskId !== 'string' || composer.selectedTaskId.length > 500))
            || composer.error !== null
            || !calendarKeys(input.prepared, ['version', 'kind', 'request', 'intent', 'task', 'project', 'generatedLinkIds', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'creation', 'projection', 'result'])
            || prepared.version !== 1 || prepared.kind !== 'new' || !calendarSame(request, prepared.request)
            || !createIntentValid(prepared.intent, request) || !instantValid(prepared.preparedAt)
            || !calendarRecord(prepared.task) || prepared.task.id !== request.requestId
            || (prepared.project !== null && (!calendarRecord(prepared.project) || !CALENDAR_UUID.test(prepared.project.id) || prepared.project.id === request.requestId))
            || !Array.isArray(prepared.generatedLinkIds) || prepared.generatedLinkIds.length > 64
            || !prepared.generatedLinkIds.every((id) => typeof id === 'string' && CALENDAR_UUID.test(id))
            || new Set(prepared.generatedLinkIds).size !== prepared.generatedLinkIds.length
            || !calendarRecord(creation)
            || !calendarKeys(creation, ['selectedProject', 'areas', 'projectOrderMax', 'taskOrderMax', 'defaultAreaMode', 'defaultAreaId', 'defaultProjectFlowMode', 'focusCount', 'focusLimit', 'focusRequested', 'sequentialEmpty', 'focusEndOfTodayIso', 'focusEndOffsetMinutes', 'preparedOffsetMinutes', 'preparedLocalDay'])
            || (creation.selectedProject !== null && !calendarRecord(creation.selectedProject))
            || !Array.isArray(creation.areas) || creation.areas.length > 2 || !creation.areas.every(calendarRecord)
            || !Number.isSafeInteger(creation.focusCount) || creation.focusCount < 0
            || !Number.isSafeInteger(creation.focusLimit) || creation.focusLimit < 1
            || creation.focusRequested !== (prepared.intent.props.isFocusedToday === true)
            || typeof creation.sequentialEmpty !== 'boolean'
            || !offsetValid(creation.preparedOffsetMinutes)
            || localProjection(prepared.preparedAt, creation.preparedOffsetMinutes).day !== creation.preparedLocalDay
            || (creation.focusRequested ? (!instantValid(creation.focusEndOfTodayIso)
                || !offsetValid(creation.focusEndOffsetMinutes)
                || localProjection(creation.focusEndOfTodayIso, creation.focusEndOffsetMinutes).day !== creation.preparedLocalDay
                || new Date(Date.parse(creation.focusEndOfTodayIso) + creation.focusEndOffsetMinutes * 60_000).toISOString().slice(11) !== '23:59:59.999Z'
                || Date.parse(creation.focusEndOfTodayIso) < Date.parse(prepared.preparedAt)
                || Date.parse(creation.focusEndOfTodayIso) - Date.parse(prepared.preparedAt) > 27 * 60 * 60_000)
                : creation.focusEndOfTodayIso !== null || creation.focusEndOffsetMinutes !== null)
            || (creation.projectOrderMax !== null && !Number.isSafeInteger(creation.projectOrderMax))
            || (creation.taskOrderMax !== null && !Number.isSafeInteger(creation.taskOrderMax))
            || (prepared.project === null ? creation.projectOrderMax !== null : creation.projectOrderMax === null)
            || (prepared.task.projectId ? creation.taskOrderMax === null : creation.taskOrderMax !== null)
            || !(creation.defaultAreaMode === null || ['none', 'fixed', 'active'].includes(creation.defaultAreaMode))
            || !(creation.defaultAreaId === null || typeof creation.defaultAreaId === 'string')
            || !(creation.defaultProjectFlowMode === null || ['parallel', 'sequential'].includes(creation.defaultProjectFlowMode))
            || !(prepared.deviceIdBefore === null || typeof prepared.deviceIdBefore === 'string')
            || !(prepared.deviceIdToInitialize === null || typeof prepared.deviceIdToInitialize === 'string')
            || (prepared.deviceIdBefore === null ? !prepared.deviceIdToInitialize : prepared.deviceIdToInitialize !== null)
            || !calendarRecord(projection) || !calendarKeys(projection, ['offsetMinutes', 'localDay', 'localMinute'])
            || !offsetValid(projection.offsetMinutes)
            || localProjection(composer.startAt, projection.offsetMinutes).day !== projection.localDay
            || localProjection(composer.startAt, projection.offsetMinutes).minute !== projection.localMinute
            || JSON.stringify(input).length > 2_000_000) return fail('INVALID_INPUT', 'Malformed prepared Calendar creation');
        if (!isTaskDateCoherent({ startTime: composer.startAt, dueDate: prepared.intent.props.dueDate },
            { startLocalDay: projection.localDay })) return fail('INVALID_INPUT', 'Prepared Calendar creation has incoherent dates');
        const linkIds = (prepared.intent.props.attachments ?? []).map((attachment) => attachment.id);
        if (!calendarSame(linkIds, prepared.generatedLinkIds)
            || (prepared.intent.props.attachments ?? []).some((attachment) => attachment.kind !== 'link')
            || (prepared.intent.props.attachments ?? []).some((attachment) => attachment.createdAt !== prepared.preparedAt
                || attachment.updatedAt !== prepared.preparedAt)
            || (prepared.intent.projectToCreate && !prepared.project && !creation.selectedProject)
            || (!prepared.intent.projectToCreate && prepared.project)
            || (prepared.intent.projectToCreate && prepared.intent.props.projectId)
            || (creation.selectedProject && prepared.intent.projectToCreate
                && findSelectableProjectByTitleAndArea([creation.selectedProject], prepared.intent.projectToCreate.name,
                    prepared.intent.projectToCreate.areaId ?? undefined)?.id !== creation.selectedProject.id)
            || (creation.selectedProject && (!prepared.intent.projectToCreate && creation.selectedProject.id !== prepared.intent.props.projectId))
            || (prepared.project && prepared.intent.projectToCreate?.areaId !== (prepared.project.areaId ?? null))) {
            return fail('INVALID_INPUT', 'Prepared Calendar creation intent does not match');
        }
        const derived = calendarCreatedRows(prepared);
        if (!derived || !calendarSame(derived.task, prepared.task) || !calendarRowEqual(derived.task, prepared.task)
            || (creation.focusRequested && (derived.project ?? creation.selectedProject)?.isSequential === true && !creation.sequentialEmpty)
            || (creation.sequentialEmpty && !(creation.focusRequested && (derived.project ?? creation.selectedProject)?.isSequential === true))
            || !calendarSame(derived.project, prepared.project)
            || (derived.project && !calendarSame(projectToSqliteRow(derived.project), projectToSqliteRow(prepared.project!)))) {
            return fail('INVALID_INPUT', 'Prepared Calendar creation row does not match');
        }
        const expected: NativeCalendarActionResult = { changed: true, toast: null, composer: null,
            next: { viewMode: 'day', selectedDate: projection.localDay, visibleMonth: projection.localDay },
            scrollToMinutes: projection.localMinute, taskId: request.requestId };
        if (!calendarSame(prepared.result, expected)) return fail('INVALID_INPUT', 'Prepared Calendar creation result does not match');
        return { ok: true, value: prepared.result };
    } catch {
        return fail('INVALID_INPUT', 'Malformed prepared Calendar creation');
    }
};

const eventCopyDateValid = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > ISO_INSTANT_LIMIT) return false;
    if (storedCalendarDateValid(value)) return true;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    return Boolean(match && storedCalendarDateValid(match[1]) && Number(match[2]) < 24
        && Number(match[3]) < 60 && Number(match[4]) < 60 && !Number.isNaN(Date.parse(value)));
};
const eventCopyStateValid = (state: unknown): state is NativeCalendarState => calendarRecord(state)
    && calendarKeys(state, ['viewMode', 'selectedDate', 'visibleMonth'])
    && CALENDAR_VIEW_MODES.includes(state.viewMode as CalendarViewMode)
    && typeof state.visibleMonth === 'string' && DAY_KEY_PATTERN.test(state.visibleMonth) && storedCalendarDateValid(state.visibleMonth)
    && (state.selectedDate === null ? state.viewMode === 'month'
        : typeof state.selectedDate === 'string' && DAY_KEY_PATTERN.test(state.selectedDate) && storedCalendarDateValid(state.selectedDate));
const eventCopyTemplateValid = (value: unknown, withRequestId: boolean): value is NativeCalendarEventTaskCreateRequest => {
    if (!calendarRecord(value) || !calendarKeys(value, withRequestId
        ? ['requestId', 'event', 'calendarName', 'fallbackTitle', 'state'] : ['event', 'calendarName', 'fallbackTitle', 'state'])
        || (withRequestId && (typeof value.requestId !== 'string' || !CALENDAR_UUID.test(value.requestId)
            || value.requestId !== value.requestId.toLowerCase()))
        || !(value.calendarName === null || typeof value.calendarName === 'string' && value.calendarName.length <= 2000)
        || typeof value.fallbackTitle !== 'string' || value.fallbackTitle.length > 2000
        || !eventCopyStateValid(value.state) || !calendarRecord(value.event)) return false;
    const event = value.event;
    return ['title', 'start', 'end', 'allDay'].every((key) => Object.prototype.hasOwnProperty.call(event, key))
        && Object.keys(event).every((key) => ['title', 'start', 'end', 'allDay', 'description', 'location'].includes(key))
        && typeof event.title === 'string' && event.title.length <= 2000 && typeof event.allDay === 'boolean'
        && eventCopyDateValid(event.start) && eventCopyDateValid(event.end)
        && (event.allDay || !DAY_KEY_PATTERN.test(event.start) && !DAY_KEY_PATTERN.test(event.end))
        && (event.description === undefined || typeof event.description === 'string' && event.description.length <= 20_000)
        && (event.location === undefined || typeof event.location === 'string' && event.location.length <= 2000);
};
const eventCopyPlan = (request: NativeCalendarEventTaskTemplate) => planCalendarEventTask({
    ...request.event, id: 'calendar-copy', sourceId: 'calendar-copy',
}, { calendarName: request.calendarName ?? undefined, t: () => request.fallbackTitle });
const eventDefaultAreaId = (creation: CalendarCreationWitness): string | null => {
    const settings = { gtd: { defaultAreaMode: creation.defaultAreaMode, defaultAreaId: creation.defaultAreaId } } as unknown as ReturnType<typeof useTaskStore.getState>['settings'];
    return getDefaultTaskAreaMode(settings) === 'fixed' ? creation.defaultAreaId?.trim() || null : null;
};
const eventAreaValid = (area: unknown): area is Area => calendarRecord(area)
    && ['id', 'name', 'order', 'createdAt', 'updatedAt'].every((key) => Object.prototype.hasOwnProperty.call(area, key))
    && Object.keys(area).every((key) => ['id', 'name', 'color', 'icon', 'order', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt'].includes(key))
    && typeof area.id === 'string' && area.id.length <= 500 && typeof area.name === 'string' && area.name.length <= 10_000
    && Number.isFinite(area.order) && instantValid(area.createdAt) && instantValid(area.updatedAt)
    && (area.deletedAt === undefined || instantValid(area.deletedAt))
    && (area.rev === undefined || Number.isSafeInteger(area.rev) && (area.rev as number) >= 0)
    && ['color', 'icon', 'revBy'].every((key) => area[key] === undefined || typeof area[key] === 'string' && (area[key] as string).length <= 500);
const eventCopyResult = (request: NativeCalendarEventTaskCreateRequest, localDay: string): NativeCalendarActionResult => ({
    changed: true, toast: null, composer: null, next: { viewMode: request.state.viewMode, selectedDate: localDay, visibleMonth: localDay },
    scrollToMinutes: null, taskId: request.requestId,
});

/** Closed event-copy journal authority; no provider, store, clock, locale or timezone access. */
export const validatePreparedCalendarEventTaskCreate = (input: unknown): NativeHostResult<NativeCalendarActionResult> => {
    try {
        if (!calendarRecord(input) || !calendarKeys(input, ['request', 'prepared'])
            || !eventCopyTemplateValid(input.request, true) || !calendarRecord(input.prepared)
            || !calendarUtf8Within(JSON.stringify(input), 2_000_000)) return fail('INVALID_INPUT', 'Malformed prepared Calendar event task');
        const request = input.request;
        const prepared = input.prepared as NativePreparedCalendarEventTaskCreate;
        const { creation, projection, intent, defaultAreaWitness } = prepared;
        // The planner's draft is shared with RN. Date-only parsing is anchored
        // explicitly here; the planner's live showDate is not journal authority.
        const plan = buildCalendarEventTaskDraft({ ...request.event, id: 'calendar-copy', sourceId: 'calendar-copy',
            start: request.event.allDay ? `${request.event.start.slice(0, 10)}T00:00:00.000Z` : request.event.start },
        { calendarName: request.calendarName ?? undefined, fallbackTitle: request.fallbackTitle });
        if (!calendarKeys(input.prepared, ['version', 'kind', 'request', 'intent', 'task', 'project', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'creation', 'projection', 'result', 'defaultAreaWitness'])
            || prepared.version !== 1 || prepared.kind !== 'event' || !eventCopyTemplateValid(prepared.request, true) || !calendarSame(request, prepared.request)
            || !instantValid(prepared.preparedAt) || prepared.project !== null || !calendarRecord(prepared.task)
            || !calendarRecord(intent) || !calendarKeys(intent, ['sourceTitle', 'title', 'props', 'projectToCreate'])
            || intent.sourceTitle !== request.event.title || intent.title !== plan.title || intent.projectToCreate !== null
            || !calendarRecord(intent.props) || Object.keys(intent.props).some((key) => !['status', 'startTime', 'timeEstimate', 'dueDate', 'description', 'location'].includes(key))
            || !calendarSame(intent.props, plan.initialProps)
            || (plan.initialProps.description?.length ?? 0) > 22_012
            || !calendarRecord(creation) || !calendarKeys(creation, ['selectedProject', 'areas', 'projectOrderMax', 'taskOrderMax', 'defaultAreaMode', 'defaultAreaId', 'defaultProjectFlowMode', 'focusCount', 'focusLimit', 'focusRequested', 'sequentialEmpty', 'focusEndOfTodayIso', 'focusEndOffsetMinutes', 'preparedOffsetMinutes', 'preparedLocalDay'])
            || creation.selectedProject !== null || creation.projectOrderMax !== null || creation.taskOrderMax !== null
            || creation.focusCount !== 0 || creation.focusLimit !== 1 || creation.focusRequested !== false || creation.sequentialEmpty !== false
            || creation.focusEndOfTodayIso !== null || creation.focusEndOffsetMinutes !== null
            || !(creation.defaultAreaMode === null || ['none', 'fixed', 'active'].includes(creation.defaultAreaMode))
            || !(creation.defaultAreaId === null || typeof creation.defaultAreaId === 'string' && creation.defaultAreaId.length <= 500)
            || creation.defaultProjectFlowMode !== null || !offsetValid(creation.preparedOffsetMinutes)
            || localProjection(prepared.preparedAt, creation.preparedOffsetMinutes).day !== creation.preparedLocalDay
            || !Array.isArray(creation.areas) || creation.areas.length > 1 || !creation.areas.every(eventAreaValid)
            || !(prepared.deviceIdBefore === null || typeof prepared.deviceIdBefore === 'string' && Boolean(prepared.deviceIdBefore) && prepared.deviceIdBefore.length <= 500)
            || !(prepared.deviceIdToInitialize === null || typeof prepared.deviceIdToInitialize === 'string' && CALENDAR_UUID.test(prepared.deviceIdToInitialize))
            || (prepared.deviceIdBefore === null ? !prepared.deviceIdToInitialize : prepared.deviceIdToInitialize !== null)
            || !calendarRecord(projection) || !calendarKeys(projection, ['offsetMinutes', 'localDay', 'localMinute'])
            || !offsetValid(projection.offsetMinutes)) return fail('INVALID_INPUT', 'Malformed prepared Calendar event task');
        const defaultId = eventDefaultAreaId(creation);
        if (defaultId === null ? defaultAreaWitness !== null || creation.areas.length !== 0
            : !calendarRecord(defaultAreaWitness) || !calendarKeys(defaultAreaWitness, ['id', 'before'])
                || defaultAreaWitness.id !== defaultId
                || (defaultAreaWitness.before === null ? creation.areas.length !== 0
                    : !calendarRecord(defaultAreaWitness.before) || !calendarKeys(defaultAreaWitness.before, ['deletedAt'])
                        || creation.areas.length !== 1 || creation.areas[0].id !== defaultId
                        || (creation.areas[0].deletedAt ?? null) !== defaultAreaWitness.before.deletedAt)) {
            return fail('INVALID_INPUT', 'Prepared Calendar event Area witness does not match');
        }
        const expectedProjection = request.event.allDay
            ? { day: plan.initialProps.dueDate, minute: 0 }
            : localProjection(plan.initialProps.startTime!, projection.offsetMinutes);
        if (projection.localDay !== expectedProjection.day || projection.localMinute !== expectedProjection.minute) {
            return fail('INVALID_INPUT', 'Prepared Calendar event navigation does not match');
        }
        const rows = calendarCreatedRows(prepared);
        if (!rows || Object.keys(prepared.task).some((key) => !Object.prototype.hasOwnProperty.call(rows.task, key))
            || !calendarSame(rows.task, prepared.task) || !calendarRowEqual(rows.task, prepared.task)) {
            return fail('INVALID_INPUT', 'Prepared Calendar event task row does not match');
        }
        const expected = eventCopyResult(request, projection.localDay);
        if (!calendarRecord(prepared.result) || !calendarKeys(prepared.result, Object.keys(expected))
            || !eventCopyStateValid(prepared.result.next)
            || !calendarSame(prepared.result, expected)) return fail('INVALID_INPUT', 'Prepared Calendar event result does not match');
        return { ok: true, value: expected };
    } catch { return fail('INVALID_INPUT', 'Malformed prepared Calendar event task'); }
};

/** Pure journal authority: no store, clock, locale, or ambient timezone reads. */
export const validatePreparedCalendarSchedule = (input: unknown): NativeHostResult<NativeCalendarActionResult> => {
    try {
        if (!calendarRecord(input) || !calendarKeys(input, ['request', 'prepared']) || !calendarRecord(input.request)
            || !calendarRecord(input.prepared)) return fail('INVALID_INPUT', 'Malformed prepared Calendar schedule');
        const prepared = input.prepared as NativePreparedCalendarSchedule;
        const request = input.request as NativeCalendarScheduleRequest;
        const composer = request.composer;
        const before = prepared.before;
        const after = prepared.after;
        const policy = prepared.policy;
        const projection = prepared.projection;
        if (!calendarKeys(input.request, ['requestId', 'composer']) || typeof request.requestId !== 'string'
            || !CALENDAR_UUID.test(request.requestId) || !calendarRecord(composer)
            || !preparedComposerKeysValid(composer)
            || composer.mode !== 'existing' || typeof composer.selectedTaskId !== 'string' || !composer.selectedTaskId
            || !instantValid(composer.startAt) || !instantValid(composer.date)
            || typeof composer.startTimeValue !== 'string' || composer.startTimeValue.length > 64
            || typeof composer.endTimeValue !== 'string' || composer.endTimeValue.length > 64
            || !Number.isSafeInteger(composer.durationMinutes) || composer.durationMinutes < 1 || composer.durationMinutes > 1440
            || typeof composer.title !== 'string' || composer.title.length > 10_000
            || typeof composer.query !== 'string' || composer.query.length > 2000 || composer.error !== null
            || !calendarKeys(input.prepared, ['version', 'request', 'kind', 'before', 'after', 'requested', 'policy', 'deviceIdBefore', 'deviceIdToInitialize', 'projection', 'result'])
            || prepared.version !== 1 || prepared.kind !== 'existing' || !calendarSame(request, prepared.request)
            || !calendarRecord(before) || !calendarRecord(after) || before.id !== composer.selectedTaskId || after.id !== before.id
            || before.deletedAt || before.purgedAt || before.status === 'reference'
            || !calendarRecord(prepared.requested) || !calendarKeys(prepared.requested, ['startTime', 'timeEstimate'])
            || prepared.requested.startTime !== composer.startAt
            || prepared.requested.timeEstimate !== minutesToTimeEstimate(composer.durationMinutes)
            || !calendarRecord(policy) || !calendarKeys(policy, ['preparedAt', 'preparedOffsetMinutes', 'preparedLocalDay', 'endOfLocalTodayUTC', 'endOffsetMinutes', 'container', 'normalizedUpdates'])
            || !instantValid(policy.preparedAt) || !instantValid(policy.endOfLocalTodayUTC)
            || !offsetValid(policy.preparedOffsetMinutes) || !offsetValid(policy.endOffsetMinutes)
            || localProjection(policy.preparedAt, policy.preparedOffsetMinutes).day !== policy.preparedLocalDay
            || localProjection(policy.endOfLocalTodayUTC, policy.endOffsetMinutes).day !== policy.preparedLocalDay
            || localProjection(policy.endOfLocalTodayUTC, policy.endOffsetMinutes).minute !== 1439
            || new Date(Date.parse(policy.endOfLocalTodayUTC) + policy.endOffsetMinutes * 60_000).toISOString().slice(11) !== '23:59:59.999Z'
            || Date.parse(policy.endOfLocalTodayUTC) < Date.parse(policy.preparedAt)
            || Date.parse(policy.endOfLocalTodayUTC) - Date.parse(policy.preparedAt) > 27 * 60 * 60_000
            || !calendarRecord(policy.container) || !calendarKeys(policy.container, ['project', 'section', 'area'])
            || !calendarRecord(policy.normalizedUpdates)
            || !calendarRecord(projection) || !calendarKeys(projection, ['offsetMinutes', 'localDay', 'localMinute'])
            || !offsetValid(projection.offsetMinutes)
            || localProjection(composer.startAt, projection.offsetMinutes).day !== projection.localDay
            || localProjection(composer.startAt, projection.offsetMinutes).minute !== projection.localMinute
            || !(prepared.deviceIdBefore === null || typeof prepared.deviceIdBefore === 'string')
            || !(prepared.deviceIdToInitialize === null || typeof prepared.deviceIdToInitialize === 'string')
            || (prepared.deviceIdBefore === null ? prepared.deviceIdToInitialize !== after.revBy
                : prepared.deviceIdBefore !== after.revBy || prepared.deviceIdToInitialize !== null)
            || after.rev !== nextRevision(before.rev) || after.updatedAt !== policy.preparedAt) {
            return fail('INVALID_INPUT', 'Malformed prepared Calendar schedule');
        }
        const container = policy.container;
        if ((container.project !== null && (!calendarRecord(container.project) || !calendarKeys(container.project, ['id', 'status', 'deletedAt', 'purgedAt']) || container.project.id !== before.projectId))
            || (container.section !== null && (!calendarRecord(container.section) || !calendarKeys(container.section, ['id', 'projectId', 'deletedAt']) || container.section.id !== before.sectionId))
            || (container.area !== null && (!calendarRecord(container.area) || !calendarKeys(container.area, ['id', 'deletedAt']) || container.area.id !== before.areaId))
            || (before.projectId && !container.project) || (before.sectionId && !container.section) || (before.areaId && !container.area)) {
            return fail('INVALID_INPUT', 'Malformed Calendar container witness');
        }
        const lists = resolverLists(container);
        const updates = prepareTaskUpdatesForStore({ task: before, updates: prepared.requested,
            allProjects: lists.projects, allSections: lists.sections, allAreas: lists.areas,
            futureBoundary: policy.endOfLocalTodayUTC });
        if (!updates.ok || findTaskProjectReactivationTarget(before, updates.updates, lists.projects)
            || !calendarSame(calendarUpdates(updates.updates), policy.normalizedUpdates)) {
            return fail('INVALID_INPUT', 'Prepared Calendar update policy does not match');
        }
        const applied = applyTaskUpdates(before, { ...updates.updates, rev: after.rev, revBy: after.revBy }, policy.preparedAt);
        if (applied.nextRecurringTask || !calendarSame(applied.updatedTask, after) || !calendarRowEqual(applied.updatedTask, after)) {
            return fail('INVALID_INPUT', 'Prepared Calendar target does not match');
        }
        const result = prepared.result;
        if (!calendarRecord(result) || !calendarKeys(result, ['changed', 'toast', 'next', 'scrollToMinutes', 'composer', 'taskId'])
            || result.changed !== true || result.toast !== null || result.composer !== null || result.taskId !== before.id
            || !calendarRecord(result.next) || !calendarKeys(result.next, ['viewMode', 'selectedDate', 'visibleMonth'])
            || result.next.viewMode !== 'day' || result.next.selectedDate !== projection.localDay
            || result.next.visibleMonth !== projection.localDay || result.scrollToMinutes !== projection.localMinute) {
            return fail('INVALID_INPUT', 'Prepared Calendar result does not match');
        }
        return { ok: true, value: result };
    } catch {
        return fail('INVALID_INPUT', 'Malformed prepared Calendar schedule');
    }
};

const unscheduleResult = (taskId: string, changed: boolean): NativeCalendarActionResult => ({
    taskId, changed, toast: null, next: null, scrollToMinutes: null, composer: null,
});

/** Pure journal authority, including the exact shared task-update policy and stored row. */
export const validatePreparedCalendarUnschedule = (input: unknown): NativeHostResult<NativeCalendarActionResult> => {
    const malformed = () => fail('INVALID_INPUT', 'Malformed prepared Calendar unschedule');
    try {
        const serialized = JSON.stringify(input);
        if (typeof serialized !== 'string' || !calendarUtf8Within(serialized, 2_000_000)
            || !calendarRecord(input) || !calendarKeys(input, ['request', 'prepared'])
            || !calendarRecord(input.request) || !calendarRecord(input.prepared)) return malformed();
        const request = input.request as NativeCalendarUnscheduleRequest;
        const prepared = input.prepared as NativePreparedCalendarUnschedule;
        const { before, after, policy } = prepared;
        if (!calendarKeys(input.request, ['requestId', 'taskId', 'taskRevision'])
            || typeof request.requestId !== 'string' || !CALENDAR_UUID.test(request.requestId)
            || typeof request.taskId !== 'string' || !request.taskId || request.taskId.length > 200
            || typeof request.taskRevision !== 'string' || !request.taskRevision || request.taskRevision.length > 200
            || !calendarKeys(input.prepared, ['version', 'kind', 'request', 'before', 'after', 'policy', 'deviceIdBefore', 'deviceIdToInitialize', 'result'])
            || prepared.version !== 1 || prepared.kind !== 'unschedule' || !calendarSame(request, prepared.request)
            || !calendarRecord(before) || !calendarRecord(after)
            || before.id !== request.taskId || after.id !== request.taskId
            || taskRevisionOf(before) !== request.taskRevision
            || typeof before.startTime !== 'string' || !before.startTime
            || before.deletedAt || before.purgedAt || before.status === 'reference'
            || isProjectedRecurringTaskId(request.taskId)
            || !calendarRecord(policy) || !calendarKeys(policy, ['preparedAt', 'preparedOffsetMinutes', 'preparedLocalDay', 'endOfLocalTodayUTC', 'endOffsetMinutes', 'container', 'normalizedUpdates'])
            || !instantValid(policy.preparedAt) || !instantValid(policy.endOfLocalTodayUTC)
            || !offsetValid(policy.preparedOffsetMinutes) || !offsetValid(policy.endOffsetMinutes)
            || localProjection(policy.preparedAt, policy.preparedOffsetMinutes).day !== policy.preparedLocalDay
            || localProjection(policy.endOfLocalTodayUTC, policy.endOffsetMinutes).day !== policy.preparedLocalDay
            || localProjection(policy.endOfLocalTodayUTC, policy.endOffsetMinutes).minute !== 1439
            || new Date(Date.parse(policy.endOfLocalTodayUTC) + policy.endOffsetMinutes * 60_000).toISOString().slice(11) !== '23:59:59.999Z'
            || Date.parse(policy.endOfLocalTodayUTC) < Date.parse(policy.preparedAt)
            || Date.parse(policy.endOfLocalTodayUTC) - Date.parse(policy.preparedAt) > 27 * 60 * 60_000
            || !calendarRecord(policy.container) || !calendarKeys(policy.container, ['project', 'section', 'area'])
            || !calendarRecord(policy.normalizedUpdates)
            || !(prepared.deviceIdBefore === null || typeof prepared.deviceIdBefore === 'string')
            || !(prepared.deviceIdToInitialize === null || typeof prepared.deviceIdToInitialize === 'string')
            || (prepared.deviceIdBefore === null ? prepared.deviceIdToInitialize !== after.revBy
                : prepared.deviceIdBefore !== after.revBy || prepared.deviceIdToInitialize !== null)
            || after.rev !== nextRevision(before.rev) || after.updatedAt !== policy.preparedAt) return malformed();
        const container = policy.container;
        if ((container.project !== null && (!calendarRecord(container.project) || !calendarKeys(container.project, ['id', 'status', 'deletedAt', 'purgedAt']) || container.project.id !== before.projectId))
            || (container.section !== null && (!calendarRecord(container.section) || !calendarKeys(container.section, ['id', 'projectId', 'deletedAt']) || container.section.id !== before.sectionId))
            || (container.area !== null && (!calendarRecord(container.area) || !calendarKeys(container.area, ['id', 'deletedAt']) || container.area.id !== before.areaId))
            || (before.projectId && !container.project) || (before.sectionId && !container.section) || (before.areaId && !container.area)) return malformed();
        const lists = resolverLists(container);
        if (isStatusListTaskReadOnly(before, lists.projects)) return malformed();
        const updates = prepareTaskUpdatesForStore({ task: before, updates: { ...CALENDAR_UNSCHEDULE_UPDATES },
            allProjects: lists.projects, allSections: lists.sections, allAreas: lists.areas,
            futureBoundary: policy.endOfLocalTodayUTC });
        if (!updates.ok || findTaskProjectReactivationTarget(before, updates.updates, lists.projects)
            || !calendarSame(calendarUpdates(updates.updates), policy.normalizedUpdates)) return malformed();
        const applied = applyTaskUpdates(before, { ...updates.updates, rev: after.rev, revBy: after.revBy }, policy.preparedAt);
        if (applied.nextRecurringTask || !calendarSame(applied.updatedTask, after) || !calendarRowEqual(applied.updatedTask, after)) return malformed();
        const result = prepared.result;
        if (!calendarRecord(result) || !calendarKeys(result, ['taskId', 'changed', 'toast', 'next', 'scrollToMinutes', 'composer'])
            || !calendarSame(result, unscheduleResult(request.taskId, true))) return malformed();
        return { ok: true, value: result };
    } catch {
        return malformed();
    }
};

export function createCalendarViewMethods(deps: CalendarViewDeps) {
    // Exact retries through the shared helper: a retry finishes a failed save and never writes twice.
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    // Recurring projections are anchored once per local day, as on mobile, so a
    // fluid series does not move with every minute of the revision.
    let projectedAt = { day: '', iso: '' };
    // ponytail: one cached view per revision and inputs; paging rebuilds nothing.
    let cachedView: { key: string; value: BuiltView } | null = null;
    // Request IDs that entered the receipts, and their payloads, so a retry reaches its
    // receipt before any check. ponytail: the last 200; the receipts keep 50 anyway.
    const entered = new Map<string, string>();

    const preferences = (): NativeCalendarPreferences['values'] => {
        const calendar = useTaskStore.getState().settings.calendar;
        return {
            viewMode: coerceCalendarViewMode(calendar?.viewMode),
            showCompleted: calendar?.showCompleted === true,
            weekVisibleDays: coerceCalendarWeekVisibleDays(calendar?.weekVisibleDays),
        };
    };

    /** The tasks the screen may show (mobile's visible-task projection), per data and settings revision. */
    let visible: { key: string; value: ReturnType<typeof buildVisible> } | null = null;
    const buildVisible = () => {
        const store = useTaskStore.getState();
        const areas = sortAreasForDisplay(store.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const projectById = new Map(store.projects.map((project) => [project.id, project]));
        const resolvedAreaFilter = resolveAreaFilterSelection(store.settings.filters, areas);
        const visibleTasks = store.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter }));
        return { areaById, projectById, resolvedAreaFilter, visibleTasks, schedulableTasks: getCalendarSchedulableTasks(visibleTasks) };
    };
    const visibleFor = (dataRevision: string) => {
        if (visible?.key !== dataRevision) visible = { key: dataRevision, value: buildVisible() };
        return visible.value;
    };

    /** Everything a view, the composer and the actions read, as mobile's screen reads it. */
    const context = (now: Date) => {
        const store = useTaskStore.getState();
        const settings = store.settings;
        const config = deps.dateFormatting();
        const language = config.language ?? 'en';
        const systemLocale = config.systemLocale ?? '';
        const dataRevision = deps.dataRevision();
        const flags = resolveFeatureFlags(settings);
        const t = deps.t();
        const formatDate = createDateFormatter(config) as DateFormatter;
        anchorProjections(now);
        return {
            store,
            settings,
            t,
            now,
            dataRevision,
            // No Intl on the native host: headings come from date-fns patterns.
            dates: createCalendarPatternDates(createDateFormatter(config, { jalaliMonthNames: true })),
            calendarSystem: getCalendarSystem({ language, settings, systemLocale }),
            formatDate,
            weekStartIndex: getWeekStartsOnIndex(settings.weekStart),
            flags,
            ...visibleFor(dataRevision),
            estimateMinutes: (estimate: Task['timeEstimate']) => timeEstimateToMinutes(estimate, { enabled: flags.timeEstimates }),
            projectedLabel: getCalendarProjectedLabel(t),
            showCompleted: settings.calendar?.showCompleted === true,
        };
    };
    type Context = ReturnType<typeof context>;
    const anchorProjections = (now: Date) => {
        const today = dayKey(now);
        if (projectedAt.day !== today) projectedAt = { day: today, iso: now.toISOString() };
    };

    /** The state the host sent, or the screen's opening state; a mode that needs a day gets today. */
    const readState = (value: unknown, ctx: Pick<Context, 'settings' | 'now'>): CalendarPeriodState | null => {
        const today = parseDayKey(dayKey(ctx.now))!;
        if (value === undefined) {
            const viewMode = coerceCalendarViewMode(ctx.settings.calendar?.viewMode);
            return { viewMode, selectedDate: needsCalendarSelectedDate(viewMode) ? today : null, visibleMonthDate: today };
        }
        if (!isObjectRecord(value) || !CALENDAR_VIEW_MODES.includes(value.viewMode as CalendarViewMode)) return null;
        const selectedDate = value.selectedDate === null ? null : parseDayKey(value.selectedDate);
        const visibleMonthDate = parseDayKey(value.visibleMonth);
        if (!visibleMonthDate || (value.selectedDate !== null && !selectedDate)) return null;
        return selectCalendarViewMode({ viewMode: 'month', selectedDate, visibleMonthDate }, value.viewMode as CalendarViewMode, today);
    };

    /**
     * The period's tasks and events by day. Cached by what it reads (the data and
     * settings revision, the range, the events and the projection day), so a new
     * selected day, search text or item sheet in the same range expands nothing.
     */
    // ponytail: the last two ranges; a host that flips between more ranges rebuilds.
    const indexCache: { key: string; value: ReturnType<typeof buildIndex> }[] = [];
    const buildIndex = (ctx: Context, range: { rangeStart: Date; rangeEnd: Date }, feed: Feed) => {
        const rangeTasks = getCalendarRangeTasks(
            ctx.visibleTasks,
            { rangeStartMs: range.rangeStart.getTime(), rangeEndMs: range.rangeEnd.getTime() },
            projectedAt.iso,
        );
        const index = {
            scheduled: indexCalendarScheduledTasks(rangeTasks),
            deadlines: indexCalendarDeadlineTasks(rangeTasks),
            completed: indexCalendarCompletedTasks(ctx.store._allTasks, {
                showCompleted: ctx.showCompleted, projectById: ctx.projectById, areaById: ctx.areaById, resolvedAreaFilter: ctx.resolvedAreaFilter,
            }),
            events: indexCalendarEvents(filterCalendarEventsForAreas(feed.events, feed.calendars, ctx.resolvedAreaFilter, ctx.store.areas)),
        };
        const availabilityEvents = indexCalendarEvents(filterCalendarEventsForAreas(feed.events, feed.calendars, { included: [], excluded: [] }, ctx.store.areas));
        return { rangeTasks, index, lists: (date: Date) => getCalendarDayLists(index, date), availabilityEvents: (date: Date) => availabilityEvents.get(calendarDateKey(date)) ?? [] };
    };
    const periodIndex = (ctx: Context, period: CalendarPeriodState, feed: Feed) => {
        const currentMonthDate = startOfCalendarMonth(period.visibleMonthDate, ctx.calendarSystem);
        const weekStartTime = getCalendarWeekStart(period.selectedDate ?? currentMonthDate, ctx.weekStartIndex).getTime();
        const range = getCalendarVisibleRange({
            calendarSystem: ctx.calendarSystem, currentMonthDate, selectedDate: period.selectedDate, viewMode: period.viewMode, weekStartTime,
        });
        const key = [ctx.dataRevision, range.rangeStart.getTime(), range.rangeEnd.getTime(), paramsKey(feed.events), paramsKey(feed.calendars), projectedAt.iso].join('|');
        let hit = indexCache.find((entry) => entry.key === key);
        if (!hit) {
            hit = { key, value: buildIndex(ctx, range, feed) };
            indexCache.unshift(hit);
            indexCache.length = Math.min(indexCache.length, 2);
        }
        return { currentMonthDate, weekStartTime, range, ...hit.value };
    };

    const slotOptions = (ctx: Context, events: readonly ExternalCalendarEvent[], excludeTaskId?: string) => ({
        events, excludeTaskId, tasks: ctx.schedulableTasks, timeEstimatesEnabled: ctx.flags.timeEstimates, now: ctx.now,
    });

    type BuiltView = Omit<NativeCalendarView, 'version' | 'revision' | 'total' | 'items'> & { entries: PendingEntry[] };
    type PendingItem = Omit<NativeCalendarItem, 'row'> & { task: Task | null };
    type PendingEntry =
        | (Omit<Extract<NativeCalendarEntry, { type: 'day' }>, 'preview'> & { preview: PendingItem[] })
        | { type: 'item'; dayKey: string; lane: Extract<NativeCalendarEntry, { type: 'item' }>['lane']; item: PendingItem }
        | { type: 'task'; list: 'search' | 'planning'; taskId: string; title: string; detail: string; task: Task };

    const item = (source: CalendarDayItem | null, fields: Partial<PendingItem> & Pick<PendingItem, 'title'>, task: Task | null, event: ExternalCalendarEvent | null): PendingItem => ({
        id: source?.id ?? task?.id ?? event?.id ?? '',
        kind: source?.kind ?? (event ? 'event' : 'scheduled'),
        taskId: task?.id ?? null,
        eventId: event?.id ?? null,
        eventRef: event ? { sourceId: event.sourceId, id: event.id, start: event.start, end: event.end } : null,
        detail: null,
        accessibilityLabel: null,
        projected: false,
        pressable: true,
        tones: { fill: null, accent: null, text: null, dashed: false, struck: false, faded: false },
        sourceColor: null,
        timed: null,
        showDone: false,
        ...fields,
        task,
    });
    const sourceTask = (entry: CalendarDayItem): Task | null => (entry.kind === 'event' ? null : entry.task);
    const sourceEvent = (entry: CalendarDayItem): ExternalCalendarEvent | null => (entry.kind === 'event' ? entry.event : null);
    const minutesIn = (dayStart: Date, from: Date, to: Date, layout: CalendarTimedLayout | undefined, durationMinutes?: number) => {
        const startMinutes = getCalendarWallMinutes(dayStart, from);
        const endMinutes = getCalendarWallMinutes(dayStart, to);
        return { startMinutes, endMinutes, durationMinutes: durationMinutes ?? endMinutes - startMinutes, column: layout ?? null };
    };

    const build = (ctx: Context, period: CalendarPeriodState, feed: Feed, query: string): BuiltView => {
        const { t, formatDate, dates, now, projectedLabel } = ctx;
        const periodData = periodIndex(ctx, period, feed);
        const { lists, availabilityEvents, currentMonthDate, weekStartTime } = periodData;
        // Calendar colors in the theme's variant, as mobile paints them (its theme preset).
        const sourceColor = createCalendarSourceColorResolver(feed.calendars, themeDescriptor(ctx.settings.theme)?.statusPreset ?? 'default');
        const sourceNames = getCalendarSourceNames(feed.calendars);
        const screen = getCalendarScreenText(t);
        const toasts = getCalendarToasts(t);
        const nav = getCalendarNavigationLabels(period.viewMode, t);
        const move = (direction: 'previous' | 'next' | 'today'): NativeCalendarState => (
            toState(moveCalendarPeriod(period, direction, { calendarSystem: ctx.calendarSystem, now: parseDayKey(dayKey(now))! }))
        );
        const selected = period.selectedDate;
        const dateLabels = formatCalendarSelectedDateLabels(selected, { dates, t, now });
        const entries: PendingEntry[] = [];
        const eventsFor = availabilityEvents;

        const scheduleRow = (task: Task, list: 'search' | 'planning'): PendingEntry => {
            const durationMinutes = ctx.estimateMinutes(task.timeEstimate);
            const slot = selected ? findCalendarFreeSlot(selected, durationMinutes, slotOptions(ctx, eventsFor(selected), task.id)) : null;
            return { type: 'task', list, taskId: task.id, title: task.title, detail: getCalendarScheduleActionLabel(slot, durationMinutes, { t, formatDate }), task };
        };
        const searchResults = selected ? getCalendarSearchResults(ctx.schedulableTasks, query) : [];

        const addDeadlineMarkers = (date: Date) => {
            const { dayStart } = getCalendarDayBounds(date);
            const groups = getCalendarDeadlineMarkerGroups(getCalendarTimedDeadlines(lists(date).deadlines), { dayStart, minGapMinutes: 32, maxVisibleRows: 3 });
            for (const group of groups) {
                for (const [index, marker] of group.markers.entries()) {
                    const projected = isProjectedRecurringTask(marker.task);
                    const detail = `${formatDate(marker.start, 'p')} · ${t('calendar.due')}`;
                    const title = getCalendarItemTitle(marker, projectedLabel, formatDate);
                    entries.push({ type: 'item', dayKey: dayKey(date), lane: 'deadlineMarker', item: item(null, {
                        id: marker.id, kind: 'deadline', title, detail, projected, pressable: !projected,
                        accessibilityLabel: `${title}, ${detail}`,
                        tones: { fill: null, accent: 'tint', text: 'text', dashed: projected, struck: false, faded: false },
                        deadline: { startMinutes: getCalendarWallMinutes(dayStart, marker.start), labelMinutes: group.startMinutes,
                            groupId: group.markers[0].id, groupIndex: index, groupSize: group.markers.length },
                    }, marker.task, null) });
                }
            }
        };

        let content: NativeCalendarView['content'];
        let title: string;
        if (period.viewMode === 'month') {
            title = formatCalendarMonthTitle(currentMonthDate, dates);
            const grid = getCalendarMonthGrid(currentMonthDate, getCalendarMonthDates(currentMonthDate, ctx.calendarSystem), ctx.weekStartIndex);
            for (const date of grid) {
                if (!date) continue;
                const cell = getCalendarMonthCell(date, lists(date), { dates, t });
                entries.push({
                    type: 'day',
                    key: dayKey(date),
                    title: String(getCalendarDayOfMonth(date, ctx.calendarSystem)),
                    dayNumber: String(getCalendarDayOfMonth(date, ctx.calendarSystem)),
                    weekday: getCalendarWeekdayLabel(date, dates),
                    isToday: isSameCalendarDate(date, now),
                    selected: Boolean(selected && isSameCalendarDate(date, selected)),
                    accessibilityLabel: cell.accessibilityLabel,
                    counts: cell.showCounts ? { tasks: cell.taskCount, events: cell.eventCount } : null,
                    preview: cell.previewItems.map((entry) => {
                        const tones = getCalendarMonthPreviewTones(entry);
                        const event = sourceEvent(entry);
                        return item(entry, {
                            title: getCalendarMonthItemTitle(entry, date, { projectedLabel, formatDate, t }),
                            projected: tones.dashed,
                            pressable: false,
                            tones: { fill: tones.fill, accent: tones.accent, text: tones.text, dashed: tones.dashed, struck: tones.struck, faded: false },
                            sourceColor: event ? sourceColor(event.sourceId) : null,
                        }, sourceTask(entry), event);
                    }),
                    opens: null,
                });
            }
            let details: Extract<NativeCalendarView['content'], { mode: 'month' }>['details'] = null;
            if (selected) {
                const day = dayKey(selected);
                const dayLists = lists(selected);
                for (const task of searchResults) entries.push(scheduleRow(task, 'search'));
                const showEvents = feed.calendars.length > 0 || feed.error !== null;
                if (showEvents) {
                    for (const event of dayLists.events) {
                        const row = getCalendarDetailsEventRow(event, { t, formatDate, sourceNames });
                        entries.push({ type: 'item', dayKey: day, lane: 'events', item: item(null, {
                            id: event.id, kind: 'event', title: row.title, detail: row.detail,
                            tones: { fill: 'input', accent: 'source', text: 'text', dashed: false, struck: false, faded: false },
                            sourceColor: sourceColor(event.sourceId),
                        }, null, event) });
                    }
                }
                const detailTasks = getCalendarDetailsTaskLists(dayLists);
                for (const kind of ['deadline', 'scheduled'] as const) {
                    for (const task of detailTasks[kind === 'deadline' ? 'deadlines' : 'scheduled']) {
                        const row = getCalendarDetailsTaskRow(task, kind, { t, formatDate, projectedLabel, timeEstimateToMinutes: ctx.estimateMinutes });
                        entries.push({ type: 'item', dayKey: day, lane: kind === 'deadline' ? 'deadlines' : 'scheduled', item: item(null, {
                            id: task.id, kind, title: task.title, detail: row.detail, projected: row.projected, pressable: !row.projected,
                            tones: { fill: row.tones.fill, accent: 'tint', text: row.tones.title, dashed: row.tones.dashed, struck: false, faded: false },
                            showDone: row.showDone,
                        }, task, null) });
                    }
                }
                const empty = detailTasks.deadlines.length === 0 && detailTasks.scheduled.length === 0 && dayLists.events.length === 0;
                details = {
                    title: dateLabels.long,
                    close: toState({ ...period, selectedDate: null }),
                    query,
                    searchTitle: searchResults.length > 0 ? screen.searchResultsTitle : null,
                    events: showEvents ? { title: screen.events, loading: feed.loading ? screen.loading : null, error: feed.error } : null,
                    empty: empty ? screen.noTasks : null,
                };
            }
            content = {
                mode: 'month',
                dayNames: getCalendarDayNames(dates, ctx.weekStartIndex),
                leadingBlanks: grid.findIndex((date) => date !== null),
                details,
            };
        } else if (period.viewMode === 'week') {
            const weekDays = getCalendarWeekDays(weekStartTime);
            title = formatCalendarWeekTitle(weekDays, dates);
            for (const date of weekDays) {
                entries.push({
                    type: 'day', key: dayKey(date), title: `${getCalendarWeekdayLabel(date, dates)} ${date.getDate()}`,
                    dayNumber: String(date.getDate()), weekday: getCalendarWeekdayLabel(date, dates),
                    isToday: isSameCalendarDate(date, now), selected: Boolean(selected && isSameCalendarDate(date, selected)),
                    accessibilityLabel: null, counts: null, preview: [],
                    opens: toState(selectCalendarViewMode({ ...period, selectedDate: date }, 'day', now)),
                });
            }
            for (const date of weekDays) {
                for (const entry of getCalendarWeekAllDayItems(getCalendarDayItems(lists(date)))) {
                    const tones = getCalendarWeekAllDayTones(entry);
                    const event = sourceEvent(entry);
                    entries.push({ type: 'item', dayKey: dayKey(date), lane: 'allDay', item: item(entry, {
                        title: getCalendarItemTitle(entry, projectedLabel, formatDate), projected: tones.dashed, pressable: !tones.disabled,
                        tones: { fill: tones.fill, accent: tones.accent, text: 'text', dashed: tones.dashed, struck: false, faded: false },
                        sourceColor: event ? sourceColor(event.sourceId) : null,
                    }, sourceTask(entry), event) });
                }
            }
            for (const date of weekDays) {
                const { dayStart, dayEnd } = getCalendarDayBounds(date);
                addDeadlineMarkers(date);
                for (const entry of getCalendarWeekTimedEntries({
                    items: getCalendarDayItems(lists(date)), dayStart, dayEnd, timeEstimateToMinutes: ctx.estimateMinutes, formatDate, projectedLabel,
                })) {
                    if (entry.kind === 'event') {
                        entries.push({ type: 'item', dayKey: dayKey(date), lane: 'timed', item: item(entry.item, {
                            title: entry.item.title, detail: entry.timeLabel,
                            tones: { fill: 'secondary', accent: 'source', text: 'text', dashed: false, struck: false, faded: false },
                            sourceColor: sourceColor(entry.item.event.sourceId),
                            timed: minutesIn(dayStart, entry.start, entry.end, entry.layout),
                        }, null, entry.item.event) });
                    } else {
                        entries.push({ type: 'item', dayKey: dayKey(date), lane: 'timed', item: item(entry.item, {
                            title: entry.item.title, detail: entry.timeLabel, projected: entry.projected, pressable: !entry.projected,
                            tones: { fill: 'tint', accent: 'tint', text: entry.projected ? 'tint' : null, dashed: entry.projected, struck: false, faded: false },
                            timed: minutesIn(dayStart, entry.displayStart, entry.displayEnd, entry.layout, entry.durationMinutes),
                        }, entry.item.task, null) });
                    }
                }
            }
            const visibleDays = coerceCalendarWeekVisibleDays(ctx.settings.calendar?.weekVisibleDays);
            content = {
                mode: 'week',
                visibleDays,
                density: {
                    value: screen.weekDensityValue(visibleDays),
                    choices: CALENDAR_WEEK_DENSITY_VALUES.map((days) => ({ days, label: screen.weekDensityChoice(days), selected: days === visibleDays })),
                },
                hourLabels: getCalendarHourLabels(formatDate),
                nowMinutes: getCalendarNowMinutes(now),
            };
        } else if (period.viewMode === 'day') {
            const day = selected!;
            title = dateLabels.dayTitle;
            const dayLists = lists(day);
            for (const entry of getCalendarDayItems(dayLists).filter(isCalendarAllDayItem)) {
                const event = sourceEvent(entry);
                entries.push({ type: 'item', dayKey: dayKey(day), lane: 'allDay', item: item(entry, {
                    title: getCalendarItemTitle(entry, projectedLabel, formatDate),
                    projected: getCalendarDayAllDayTones(entry).text === 'tint', pressable: !getCalendarDayAllDayTones(entry).disabled,
                    tones: { fill: null, accent: null, text: getCalendarDayAllDayTones(entry).text, dashed: false, struck: false, faded: false },
                }, sourceTask(entry), event) });
            }
            const { dayStart, dayEnd } = getCalendarDayBounds(day);
            addDeadlineMarkers(day);
            const timeline = getCalendarDayTimeline({
                events: dayLists.events, tasks: dayLists.scheduled, dayStart, dayEnd, timeEstimateToMinutes: ctx.estimateMinutes, formatDate, projectedLabel,
            });
            for (const entry of timeline.events) {
                entries.push({ type: 'item', dayKey: dayKey(day), lane: 'timed', item: item(null, {
                    id: entry.event.id, kind: 'event', title: entry.event.title, detail: entry.timeLabel,
                    tones: { fill: 'secondary', accent: 'source', text: 'text', dashed: false, struck: false, faded: false },
                    sourceColor: sourceColor(entry.event.sourceId),
                    timed: minutesIn(dayStart, entry.start, entry.end, entry.layout),
                }, null, entry.event) });
            }
            for (const entry of timeline.tasks) {
                entries.push({ type: 'item', dayKey: dayKey(day), lane: 'timed', item: item(null, {
                    id: entry.task.id, kind: 'scheduled', title: entry.task.title, detail: entry.timeLabel, projected: entry.projected,
                    tones: { fill: 'tint', accent: 'tint', text: entry.projected ? 'tint' : null, dashed: entry.projected, struck: false, faded: false },
                    timed: minutesIn(dayStart, entry.displayStart, entry.displayEnd, entry.layout, entry.durationMinutes),
                }, entry.task, null) });
            }
            for (const task of searchResults) entries.push(scheduleRow(task, 'search'));
            content = {
                mode: 'day',
                dayKey: dayKey(day),
                hourLabels: getCalendarHourLabels(formatDate),
                nowMinutes: isSameCalendarDate(day, now) ? getCalendarNowMinutes(now) : null,
                query,
                searchTitle: searchResults.length > 0 ? screen.searchResultsTitle : null,
            };
        } else {
            title = screen.scheduleTitle;
            const sections = getCalendarScheduleSections(selected ?? currentMonthDate, (date) => getCalendarDayItems(lists(date)));
            for (const section of sections) {
                const key = dayKey(section.date);
                entries.push({
                    type: 'day', key, title: formatCalendarScheduleDayTitle(section.date, { dates, t, now }),
                    dayNumber: String(section.date.getDate()), weekday: getCalendarWeekdayLabel(section.date, dates),
                    isToday: isSameCalendarDate(section.date, now), selected: false, accessibilityLabel: null, counts: null, preview: [], opens: null,
                });
                for (const entry of section.items) {
                    const text = getCalendarScheduleItemText(entry, { t, formatDate, projectedLabel, sourceNames, timeEstimateToMinutes: ctx.estimateMinutes });
                    const tones = getCalendarScheduleItemTones(entry);
                    const event = sourceEvent(entry);
                    entries.push({ type: 'item', dayKey: key, lane: 'list', item: item(entry, {
                        title: entry.title, detail: text.detail, accessibilityLabel: text.accessibilityLabel, projected: tones.dashed,
                        pressable: !tones.disabled,
                        tones: { fill: tones.fill, accent: tones.accent, text: tones.title, dashed: tones.dashed, struck: tones.struck, faded: tones.faded },
                        sourceColor: event ? sourceColor(event.sourceId) : null,
                    }, sourceTask(entry), event) });
                }
            }
            const planning = selected ? getCalendarPlanningTasks(ctx.visibleTasks, {
                now, prioritiesEnabled: ctx.flags.priorities, projects: ctx.store.projects, sections: ctx.store.sections,
            }) : [];
            for (const task of planning) entries.push(scheduleRow(task, 'planning'));
            content = {
                mode: 'schedule',
                planning: planning.length > 0 ? { title: screen.planningTitle, subtitle: dateLabels.planning } : null,
                empty: sections.length === 0 && planning.length === 0 ? screen.noTasks : null,
            };
        }

        const periodNav = period.viewMode === 'schedule' ? null : period.viewMode;
        const { weekDensityValue: _value, weekDensityChoice: _choice, ...fixedText } = screen;
        return {
            state: toState(period),
            range: { start: periodData.range.rangeStart.toISOString(), end: periodData.range.rangeEnd.toISOString() },
            feedState: { status: feed.status, message: feed.loading ? screen.loading : feed.error },
            header: {
                title,
                titleVariant: period.viewMode === 'day' ? 'day' : 'standard',
                previous: periodNav ? { label: nav.previous, state: move('previous') } : null,
                next: periodNav ? { label: nav.next, state: move('next') } : null,
                today: { label: nav.today, state: move('today') },
            },
            modes: getCalendarModeOptions(t).map((option) => ({
                mode: option.value,
                label: option.label,
                selected: option.value === period.viewMode,
                state: toState(selectCalendarViewMode(period, option.value, parseDayKey(dayKey(now))!)),
            })),
            showCompleted: { label: screen.showCompleted, hint: screen.showCompletedHint, on: ctx.showCompleted },
            text: { ...fixedText, toasts: { ...toasts, saveFailed: toasts.saveFailed() } },
            content,
            entries,
        };
    };

    const finish = (built: BuiltView, revision: string, window: { offset: number; limit: number }, now: Date): NativeCalendarView => {
        const pageEntries = built.entries.slice(window.offset, window.offset + window.limit);
        // Rows carry core meta; one row build per page, in entry order.
        const tasks: Task[] = [];
        for (const entry of pageEntries) {
            if (entry.type === 'task') tasks.push(entry.task);
            else if (entry.type === 'item' && entry.item.task) tasks.push(entry.item.task);
            else if (entry.type === 'day') for (const preview of entry.preview) if (preview.task) tasks.push(preview.task);
        }
        const rows = deps.rows(tasks, now);
        let rowIndex = 0;
        const done = ({ task, ...rest }: PendingItem): NativeCalendarItem => ({ ...rest, row: task ? rows[rowIndex++] ?? null : null });
        const items = pageEntries.map((entry): NativeCalendarEntry => {
            if (entry.type === 'day') return { ...entry, preview: entry.preview.map(done) };
            if (entry.type === 'item') return { ...entry, item: done(entry.item) };
            const { task: _task, ...rest } = entry;
            return { ...rest, row: rows[rowIndex++] };
        });
        const { entries, ...view } = built;
        return { version: NATIVE_HOST_CONTRACT_VERSION, revision, ...view, total: entries.length, items };
    };

    // ---- The composer ------------------------------------------------------------

    const composerDeps = (ctx: Context, events: (date: Date) => readonly ExternalCalendarEvent[]): CalendarComposerDeps => ({
        findFreeSlot: (day, durationMinutes, excludeTaskId) => findCalendarFreeSlot(day, durationMinutes, slotOptions(ctx, events(day), excludeTaskId)),
        timeEstimateToMinutes: ctx.estimateMinutes,
    });
    const composerView = (ctx: Context, state: ComposerState): NativeCalendarComposerView => {
        const selectedTask = state.selectedTaskId ? ctx.store.tasks.find((task) => task.id === state.selectedTaskId) ?? null : null;
        return {
            composer: toComposer(state),
            timeLabels: {
                start: formatCalendarComposerClockValue(state.startTimeValue, state.startAt, ctx.formatDate),
                end: formatCalendarComposerClockValue(state.endTimeValue, state.startAt ? new Date(state.startAt.getTime() + state.durationMinutes * 60_000) : null, ctx.formatDate),
            },
            text: getCalendarComposerText(ctx.t, { priorities: ctx.flags.priorities }),
            dateLabel: ctx.dates.shortDate(state.date),
            placeholders: getCalendarComposerPlaceholders(ctx.formatDate),
            durations: CALENDAR_TIME_ESTIMATE_OPTIONS.map((option) => ({
                minutes: option.minutes, label: formatCalendarDurationChip(option.minutes), selected: state.durationMinutes === option.minutes,
            })),
            candidates: state.mode === 'existing'
                ? getCalendarComposerCandidates(ctx.schedulableTasks, state.query).map((task) => ({ id: task.id, title: task.title, selected: task.id === state.selectedTaskId }))
                : null,
            selectedTaskTitle: selectedTask?.title ?? null,
            error: state.error ? getCalendarComposerErrorText(state.error, ctx.t) : null,
            saveDisabled: isCalendarComposerSaveDisabled(state),
        };
    };
    const saveContext = (ctx: Context, events: (date: Date) => readonly ExternalCalendarEvent[], excludeCreatedId?: string): CalendarComposerSaveContext => ({
        areas: ctx.store.areas,
        projects: ctx.store.projects,
        now: ctx.now,
        parseOptions: buildQuickAddParseOptions(ctx.settings, { tasks: ctx.store.tasks, people: ctx.store.people }),
        // A retry of a create finds the task it made in the slot; that task is not in the way.
        isSlotFree: (start, durationMinutes, excludeTaskId) => isCalendarSlotFree(start, start, durationMinutes, slotOptions(ctx, events(start), excludeTaskId ?? excludeCreatedId)),
    });

    // ---- Actions -----------------------------------------------------------------

    type Outcome = NativeHostResult<NativeCalendarActionResult> | NativeUnsavedWrite<NativeCalendarActionResult>;
    const result = (fields: Partial<NativeCalendarActionResult> = {}): NativeCalendarActionResult => ({
        changed: false, toast: null, next: null, scrollToMinutes: null, composer: null, taskId: null, ...fields,
    });
    const unchanged = (fields: Partial<NativeCalendarActionResult> = {}): Outcome => ({ ok: true, value: result(fields) });
    const written = async (call: Parameters<typeof runStoreWrite>[0], fields: Partial<NativeCalendarActionResult> = {}): Promise<Outcome> => (
        settleWrite(await runStoreWrite(call), result({ ...fields, changed: true }))
    );
    const liveTask = (id: unknown): Task | undefined => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return task && !task.deletedAt && !task.purgedAt ? task : undefined;
    };
    /** After a composer save the screen shows the day view on the new start, scrolled to it. */
    const dayView = (start: Date): Pick<NativeCalendarActionResult, 'next' | 'scrollToMinutes'> => ({
        next: { viewMode: 'day', selectedDate: dayKey(start), visibleMonth: dayKey(start) },
        scrollToMinutes: start.getHours() * 60 + start.getMinutes(),
    });
    const eventsByDay = (feed: Feed) => {
        const byDay = indexCalendarEvents(filterCalendarEventsForAreas(feed.events, feed.calendars, { included: [], excluded: [] }, []));
        return (date: Date): readonly ExternalCalendarEvent[] => byDay.get(calendarDateKey(date)) ?? [];
    };

    /**
     * A task this request made (the request ID is its id) answers a replay only
     * when it is still exactly what the request writes: its title and every field
     * the request sets. Anything else under that ID is refused.
     */
    const matchesPlan = (task: Task, title: string, props: Partial<Task>): boolean => (
        !task.deletedAt && !task.purgedAt && task.title === title
        && Object.entries(props).every(([field, planned]) => (
            JSON.stringify(task[field as keyof Task] ?? null) === JSON.stringify(planned ?? null)
        ))
    );
    const taskById = (id: string) => useTaskStore.getState()._allTasks.find((task) => task.id === id);
    const moveTarget = (action: Extract<NativeCalendarAction, { type: 'moveTask' }>) => (
        getCalendarMovedStart(parseDayKey(action.day)!.getTime(), action.startMinutes, safeParseDate(taskById(action.taskId)?.startTime)).toISOString()
    );
    const isMoveFree = (ctx: Context, feed: Feed, action: Extract<NativeCalendarAction, { type: 'moveTask' }>, taskId: string) => planCalendarTaskMove({
        taskId, dayStartMs: parseDayKey(action.day)!.getTime(), startMinutes: action.startMinutes, durationMinutes: action.durationMinutes,
        currentStart: safeParseDate(taskById(taskId)?.startTime),
        isSlotFree: (day, start, durationMinutes, excludeTaskId) => isCalendarSlotFree(day, start, durationMinutes, slotOptions(ctx, eventsByDay(feed)(day), excludeTaskId)),
    });

    /** Compare-and-set, right before a write to an existing task: one changed since the view showed it is not written. */
    const stale = (task: Task, taskRevision: string | null): Outcome | null => refuseStale([task], [taskRevision ?? undefined]);

    /**
     * The write. It runs inside the receipts, so it checks everything again: a
     * write that does not apply returns ACTION_FAILED and leaves no receipt, a
     * target that already holds writes nothing, and a task that changed since the
     * view is refused (STALE_REVISION).
     */
    const perform = async (requestId: string, action: NativeCalendarAction, ctx: Context, feed: Feed, state: CalendarPeriodState): Promise<Outcome> => {
        const store = useTaskStore.getState();
        const events = eventsByDay(feed);
        switch (action.type) {
            case 'saveComposer': {
                const composer = readComposer(action.composer, ctx.formatDate)!;
                const createdId = requestId.toLowerCase();
                const base = saveContext(ctx, events, createdId);
                // A `+Project` this request creates takes an id from the request and its name (as a
                // quick capture's does), and that project is matched first under that name: a replay
                // files the task there, renamed since or not, never in a project given that name since.
                const ownId = (name: string) => requestRowId(requestId, `project:${name.trim().toLowerCase()}`);
                const bare = prepareComposerSave(composer, { ...base, projects: [] });
                const ownName = bare.kind === 'create' ? bare.projectToCreate?.name : undefined;
                const projects = ownName ? withRequestProject(base.projects ?? [], ownId(ownName), ownName) : base.projects;
                // Deleted or archived since: never made again, and the task is not written.
                if (!projects) return fail('STALE_REVISION', 'The project this request created is gone');
                // The whole save is validated here, before any write: the task plan, its
                // dates and the slot. No refusal can follow a project write.
                const intent = prepareComposerSave(composer, { ...base, projects });
                if (intent.kind === 'error') return fail('ACTION_FAILED', getCalendarComposerErrorText(intent.error, ctx.t));
                const answer = { ...dayView(composer.startAt!), taskId: intent.kind === 'update' ? intent.taskId : createdId };
                if (intent.kind === 'update') {
                    const task = liveTask(intent.taskId);
                    if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                    if (task.startTime === intent.updates.startTime && task.timeEstimate === intent.updates.timeEstimate) return unchanged(answer);
                    return stale(task, composer.taskRevision) ?? written(() => store.updateTask(task.id, intent.updates), answer);
                }
                const projectId = intent.projectToCreate ? ownId(intent.projectToCreate.name) : null;
                const planned = projectId ? applyComposerCreatedProject(intent.draft, projectId) : intent.draft;
                const existing = taskById(createdId);
                if (existing) {
                    // A replay after a restart: the task is found by the request ID.
                    return matchesPlan(existing, planned.title, planned.props)
                        ? unchanged(answer)
                        : fail('INVALID_INPUT', 'Request ID already belongs to another task');
                }
                const landed = await runStoreWrite(async () => {
                    let draft = planned;
                    if (intent.projectToCreate) {
                        const { name, color, initialProps } = intent.projectToCreate;
                        const project = await useTaskStore.getState().addProject(name, color, { ...initialProps, id: projectId! });
                        if (!project) return { success: false, error: 'Project creation failed' };
                        draft = applyComposerCreatedProject(intent.draft, project.id);
                    }
                    return useTaskStore.getState().addTask(draft.title, draft.props, { captureId: requestId });
                });
                // Acknowledged only once the task exists. A project without its task did not
                // land the request: no receipt, and a retry finds the project by its id and adds
                // the task.
                if (!taskById(createdId)) return fail('ACTION_FAILED', landed.ok ? 'Task creation failed' : landed.error.message);
                return settleWrite(landed, result({ ...answer, changed: true }));
            }
            case 'moveTask': {
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot move');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                const target = moveTarget(action);
                if (task.startTime === target) return unchanged();
                if (isMoveFree(ctx, feed, action, task.id).kind !== 'move') return fail('ACTION_FAILED', getCalendarToasts(ctx.t).timeConflict.message);
                return stale(task, action.taskRevision) ?? written(() => store.updateTask(task.id, { startTime: target }));
            }
            case 'unscheduleTask':
            case 'completeTask': {
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot change');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (action.type === 'unscheduleTask') {
                    if (!task.startTime) return unchanged();
                    return stale(task, action.taskRevision) ?? written(() => store.updateTask(task.id, { ...CALENDAR_UNSCHEDULE_UPDATES }));
                }
                if (task.status === 'done') return unchanged();
                return stale(task, action.taskRevision) ?? written(() => store.updateTask(task.id, { ...CALENDAR_DONE_UPDATES }));
            }
            case 'deleteTask': {
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot change');
                const task = typeof action.taskId === 'string' ? store._tasksById.get(action.taskId) : undefined;
                if (!task || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
                if (task.deletedAt) return unchanged();
                return stale(task, action.taskRevision) ?? written(() => store.deleteTask(task.id));
            }
            case 'createTaskFromEvent': {
                const plan = planCalendarEventTask(action.event, { calendarName: getCalendarSourceNames(feed.calendars).get(action.event.sourceId), t: ctx.t });
                const createdId = requestId.toLowerCase();
                // The screen stays in its mode and moves to the event's day.
                const next = plan.showDate ? toState({ ...state, selectedDate: plan.showDate, visibleMonthDate: plan.showDate }) : null;
                const answer = { toast: getCalendarToasts(ctx.t).eventTaskCreated, next, taskId: createdId };
                const existing = taskById(createdId);
                if (existing) {
                    // The event's start or date, duration, place and notes: the whole task the event makes.
                    return matchesPlan(existing, plan.title, plan.initialProps)
                        ? unchanged(answer)
                        : fail('INVALID_INPUT', 'Request ID already belongs to another task');
                }
                return written(async () => {
                    const added = await store.addTask(plan.title, plan.initialProps, { captureId: requestId });
                    return added.success && added.id !== createdId ? { success: false, error: 'Task creation failed' } : added;
                }, answer);
            }
            case 'setViewMode':
            case 'setShowCompleted':
            case 'setWeekVisibleDays': {
                const calendar = ctx.settings.calendar;
                const patch = action.type === 'setViewMode'
                    ? { viewMode: action.viewMode }
                    : action.type === 'setShowCompleted'
                        ? { showCompleted: action.on }
                        : { weekVisibleDays: coerceCalendarWeekVisibleDays(action.days) };
                const current = action.type === 'setViewMode'
                    ? calendar?.viewMode
                    : action.type === 'setShowCompleted'
                        ? calendar?.showCompleted === true
                        : coerceCalendarWeekVisibleDays(calendar?.weekVisibleDays);
                if (Object.values(patch)[0] === current) return unchanged();
                return written(() => store.updateSettings({ calendar: { ...calendar, ...patch } }));
            }
            default:
                return fail('INVALID_INPUT', 'The calendar does not offer that action');
        }
    };

    /**
     * A new request's input checks and the refusals the screen shows (a time
     * conflict, a composer error). A refusal writes nothing and stays out of the
     * receipts, so its request ID stays free. A request the receipts already hold
     * skips these checks (runCalendarAction).
     */
    const check = (requestId: string, action: NativeCalendarAction, ctx: Context, feed: Feed): Outcome | null => {
        switch (action.type) {
            case 'saveComposer': {
                const composer = readComposer(action.composer, ctx.formatDate);
                if (!composer) return fail('INVALID_INPUT', 'A composer from openCalendarComposer is required');
                // A task under this ID is a replay: the write checks it is this request's.
                if (taskById(requestId.toLowerCase())) return null;
                if (isCalendarComposerSaveDisabled(composer)) return fail('INVALID_INPUT', 'Save is not available yet');
                const intent = prepareComposerSave(composer, saveContext(ctx, eventsByDay(feed)));
                if (intent.kind !== 'error') return null;
                return unchanged({ composer: composerView(ctx, { ...composer, error: intent.error }) });
            }
            case 'moveTask': {
                if (!parseDayKey(action.day) || !Number.isSafeInteger(action.startMinutes) || action.startMinutes < 0
                    || !Number.isSafeInteger(action.durationMinutes) || action.durationMinutes < 1
                    || action.startMinutes + action.durationMinutes > 24 * 60 || !isRevision(action.taskRevision)) {
                    return fail('INVALID_INPUT', 'A day, a start minute and a duration inside the day, and the revision the view showed, are required');
                }
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot move');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (task.startTime === moveTarget(action)) return null;
                return isMoveFree(ctx, feed, action, task.id).kind === 'move' ? null : unchanged({ toast: getCalendarToasts(ctx.t).timeConflict });
            }
            case 'unscheduleTask':
            case 'completeTask':
            case 'deleteTask':
                return isText(action.taskId) && isRevision(action.taskRevision) ? null : fail('INVALID_INPUT', 'A task id and the revision the view showed are required');
            case 'createTaskFromEvent':
                return isEvent(action.event) ? null : fail('INVALID_INPUT', 'An event from the calendar feed is required');
            case 'setViewMode':
                return CALENDAR_VIEW_MODES.includes(action.viewMode) ? null : fail('INVALID_INPUT', 'A calendar view mode is required');
            case 'setShowCompleted':
                return typeof action.on === 'boolean' ? null : fail('INVALID_INPUT', 'on must be a boolean');
            case 'setWeekVisibleDays':
                return CALENDAR_WEEK_DENSITY_VALUES.includes(action.days) ? null : fail('INVALID_INPUT', 'A week density from the view is required');
            default:
                return fail('INVALID_INPUT', 'The calendar does not offer that action');
        }
    };

    return {
        getCalendarPreferences(): NativeHostResult<NativeCalendarPreferences> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return { ok: true, value: { version: NATIVE_HOST_CONTRACT_VERSION, values: preferences() } };
        },

        /** A stored preference edit, safe to replay after receipt loss or restart. */
        async setCalendarPreference(input: NativeCalendarPreferenceRequest): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || Object.keys(input).length !== 4
                || !Object.keys(input).every((key) => ['requestId', 'field', 'before', 'value'].includes(key))
                || !isPreferenceValue(input.field, input.before) || !isPreferenceValue(input.field, input.value)) {
                return fail('INVALID_INPUT', 'A request UUID, preference field, and canonical before/value are required');
            }
            const { requestId, field, before, value } = input;
            const outcome = await receipts.run(requestId, JSON.stringify(['calendarPreference', field, before, value]), async () => {
                // Receipts precede mutable checks: an owed save must never reapply
                // the edit over a newer value. A receipt-free replay checks only this field.
                const current = preferences()[field];
                if (current === value) return unchanged();
                if (current !== before) return fail('STALE_REVISION', 'Calendar preference changed while editing');
                const store = useTaskStore.getState();
                return written(() => store.updateSettings({ calendar: { ...store.settings.calendar, [field]: value } }));
            });
            if (outcome.ok) {
                try {
                    logInfo('Native Calendar preference result', {
                        scope: 'native-host', category: 'storage', context: {
                            releaseCheck: 'v1.3.3/native-calendar-preference', outcome: outcome.value.changed ? 'applied' : 'replayed',
                        },
                    });
                } catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return outcome;
        },

        /**
         * The Calendar in `state` (absent: the screen as it opens, in the saved
         * view mode on today), windowed. Fetch external events for `range` and send
         * them as `calendar`; `scheduleQuery` is the search under the selected day.
         */
        getCalendarView(input: {
            state?: NativeCalendarState;
            scheduleQuery?: string;
            calendar?: NativeCalendarFeed;
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeCalendarView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            anchorProjections(now);
            const settings = useTaskStore.getState().settings;
            const feed = isObjectRecord(input) ? readFeed(input.calendar) : null;
            const period = isObjectRecord(input) ? readState(input.state, { settings, now }) : null;
            const query = isObjectRecord(input) ? input.scheduleQuery ?? '' : null;
            if (!isObjectRecord(input) || !isPaging(input) || !feed || !period || !isText(query, 2000)) {
                return fail('INVALID_INPUT', 'A valid state, calendar, schedule query, offset, bounded limit and revision for later pages are required');
            }
            const revision = `${deps.revision(now)}:${paramsKey([toState(period), query, feed, projectedAt.iso])}`;
            if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'The calendar changed; restart paging from offset zero');
            // The store, settings and language are in the revision; a later page reuses the build.
            if (cachedView?.key !== revision) cachedView = { key: revision, value: build(context(now), period, feed, query) };
            return { ok: true, value: finish(cachedView.value, revision, input as { offset: number; limit: number }, now) };
        },

        /**
         * What pressing an item offers: a task's sheet (Edit, Remove from calendar,
         * Done, Delete, Cancel; a projected occurrence only explains itself) or an
         * event's (Create task, Open in calendar when the host can open it, Cancel).
         * Edit opens the task editor; the rest are runCalendarAction. Send the view's
         * state and calendar: as on mobile, only the view's open tasks and projected
         * occurrences offer a sheet, and a completed item answers TASK_NOT_FOUND.
         */
        getCalendarItemSheet(input:
            | { taskId: string; state?: NativeCalendarState; calendar?: NativeCalendarFeed }
            | { event: ExternalCalendarEvent; canOpen: boolean; state?: NativeCalendarState; calendarName?: string | null }): NativeHostResult<NativeCalendarSheet> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            const ctx = context(now);
            if (isObjectRecord(input) && 'event' in input) {
                if (!isEvent(input.event) || typeof input.canOpen !== 'boolean') return fail('INVALID_INPUT', 'An event and whether the host can open it are required');
                if (input.state !== undefined) {
                    if (!calendarKeys(input, ['event', 'canOpen', 'state', 'calendarName']) || input.canOpen !== false
                        || !eventCopyStateValid(input.state)
                        || Object.keys(input.event).some((key) => !['id', 'sourceId', 'title', 'start', 'end', 'allDay', 'nativeEventId', 'description', 'location'].includes(key))) {
                        return fail('INVALID_INPUT', 'An owned event state and calendar name are required');
                    }
                    const { title, start, end, allDay, description, location } = input.event;
                    const creationTemplate: NativeCalendarEventTaskTemplate = {
                        event: { title, start, end, allDay, ...(description === undefined ? {} : { description }), ...(location === undefined ? {} : { location }) },
                        calendarName: input.calendarName as string | null, fallbackTitle: ctx.t('calendar.eventFallbackTitle'), state: input.state,
                    };
                    if (!eventCopyTemplateValid(creationTemplate, false) || !calendarUtf8Within(JSON.stringify(creationTemplate), 2_000_000)) {
                        return fail('INVALID_INPUT', 'Calendar event cannot be copied');
                    }
                    return { ok: true, value: { kind: 'event', ...getCalendarEventSheet(input.event, { canOpen: false, t: ctx.t }),
                        creationTemplate: JSON.parse(JSON.stringify(creationTemplate)) as NativeCalendarEventTaskTemplate } };
                }
                return { ok: true, value: { kind: 'event', ...getCalendarEventSheet(input.event, { canOpen: input.canOpen, t: ctx.t }) } };
            }
            if (!isObjectRecord(input) || !isText(input.taskId)) return fail('INVALID_INPUT', 'A task id or an event is required');
            const period = readState(input.state, ctx);
            const feed = readFeed(input.calendar);
            if (!period || !feed) return fail('INVALID_INPUT', 'The view\'s state and calendar are required');
            const task = periodIndex(ctx, period, feed).rangeTasks.find((candidate) => candidate.id === input.taskId);
            if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
            const sheet = getCalendarTaskSheet(task, ctx.t);
            if (sheet.kind === 'projected') return { ok: true, value: sheet };
            const stored = ctx.store._tasksById.get(task.id) ?? task;
            return { ok: true, value: { ...sheet, kind: 'task', taskId: task.id, taskRevision: taskRevisionOf(stored) } };
        },

        /**
         * Open the composer: at an instant (a timeline tap), on a day at its first
         * free slot (Add task, a week column), or for a task to schedule on the
         * selected day (a planning or search row), which refuses with the no-free-time
         * toast when the day is full.
         */
        openCalendarComposer(input: {
            at?: string;
            day?: string;
            rawMinutes?: number;
            scheduleTaskId?: string;
            mode?: CalendarComposerMode;
            calendar?: NativeCalendarFeed;
        }): NativeHostResult<{ composer: NativeCalendarComposerView | null; toast: CalendarToast | null }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            const ctx = context(now);
            const feed = isObjectRecord(input) ? readFeed(input.calendar) : null;
            if (!isObjectRecord(input) || !feed || (input.mode !== undefined && input.mode !== 'new' && input.mode !== 'existing')) {
                return fail('INVALID_INPUT', 'An instant, a day or a task to schedule, and the calendar, are required');
            }
            if (feed.status !== 'ready') return fail('ACTION_FAILED', ctx.t('settings.calendarMobile.failedToLoadEvents'));
            const events = eventsByDay(feed);
            const openDeps = composerDeps(ctx, events);
            const at = isText(input.at, ISO_INSTANT_LIMIT) ? safeParseDate(input.at) : null;
            const day = parseDayKey(input.day);
            if (input.rawMinutes !== undefined) {
                if (input.mode !== 'new' || !day || input.at !== undefined || input.scheduleTaskId !== undefined
                    || !Number.isFinite(input.rawMinutes) || input.rawMinutes < 0 || input.rawMinutes > CALENDAR_DAY_MINUTES
                    || Object.keys(input).some((key) => !['day', 'rawMinutes', 'mode', 'calendar'].includes(key))) {
                    return fail('INVALID_INPUT', 'A New composer day and bounded timeline minute are required');
                }
                const start = getCalendarMovedStart(day.getTime(), snapCalendarTimelineMinutes(input.rawMinutes));
                return { ok: true, value: { composer: composerView(ctx, { ...toCalendarViewComposer(openComposerAt(start, { mode: 'new' }, openDeps), start), taskRevision: null }), toast: null } };
            }
            if (input.scheduleTaskId !== undefined) {
                const task = ctx.schedulableTasks.find((candidate) => candidate.id === input.scheduleTaskId);
                if (!task || !day) return fail('INVALID_INPUT', 'A task the planning list offers and the selected day are required');
                const durationMinutes = ctx.estimateMinutes(task.timeEstimate);
                const slot = openDeps.findFreeSlot(day, durationMinutes, task.id);
                if (!slot) return { ok: true, value: { composer: null, toast: getCalendarToasts(ctx.t).noFreeTime } };
                const opened = toCalendarViewComposer(openComposerAt(slot, { durationMinutes, mode: 'existing', task }, openDeps), slot);
                return { ok: true, value: { composer: composerView(ctx, { ...opened, taskRevision: taskRevisionOf(task) }), toast: null } };
            }
            if (at) return { ok: true, value: { composer: composerView(ctx, { ...toCalendarViewComposer(openComposerAt(at, { mode: input.mode ?? 'new' }, openDeps), at), taskRevision: null }), toast: null } };
            if (day) return { ok: true, value: { composer: composerView(ctx, { ...toCalendarViewComposer(openComposerForDate(day, { mode: input.mode ?? 'new' }, openDeps), day), taskRevision: null }), toast: null } };
            return fail('INVALID_INPUT', 'An instant, a day or a task to schedule is required');
        },

        /** Apply one composer edit and return the composer after it. Nothing is written. */
        editCalendarComposer(input: { composer: NativeCalendarComposer; edit: NativeCalendarComposerEdit; calendar?: NativeCalendarFeed }): NativeHostResult<NativeCalendarComposerView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            const ctx = context(now);
            const state = isObjectRecord(input) ? readComposer(input.composer, ctx.formatDate) : null;
            const feed = isObjectRecord(input) ? readFeed(input.calendar) : null;
            const edit = isObjectRecord(input) && isObjectRecord(input.edit) ? input.edit as NativeCalendarComposerEdit : null;
            if (!state || !feed || !edit) return fail('INVALID_INPUT', 'A composer, an edit and the calendar are required');
            if (feed.status !== 'ready') return fail('ACTION_FAILED', ctx.t('settings.calendarMobile.failedToLoadEvents'));
            const events = eventsByDay(feed);
            let next: ComposerState | null = null;
            switch (edit.type) {
                case 'mode':
                    if (edit.mode === 'new' || edit.mode === 'existing') next = { ...state, ...setComposerMode(state, edit.mode) };
                    break;
                case 'title':
                    if (isText(edit.title, 10_000)) next = { ...state, ...setComposerTitle(state, edit.title) };
                    break;
                case 'query':
                    // A new search drops the chosen task, and its revision with it.
                    if (isText(edit.query, 2000)) next = { ...state, ...setComposerQuery(state, edit.query), taskRevision: null };
                    break;
                case 'selectTask': {
                    const task = ctx.schedulableTasks.find((candidate) => candidate.id === edit.taskId);
                    if (task) next = { ...state, ...selectComposerTask(state, task, composerDeps(ctx, events)), taskRevision: taskRevisionOf(task) };
                    break;
                }
                case 'startTime':
                    if (isText(edit.value, 64)) next = { ...setCalendarViewComposerStartTime(state, edit.value), taskRevision: state.taskRevision };
                    break;
                case 'endTime':
                    if (isText(edit.value, 64)) next = { ...state, ...setComposerEndTime(state, edit.value) };
                    break;
                case 'duration':
                    if (Number.isSafeInteger(edit.minutes) && edit.minutes >= 1 && edit.minutes <= 24 * 60) next = { ...state, ...setComposerDuration(state, edit.minutes) };
                    break;
                default:
                    break;
            }
            if (!next) return fail('INVALID_INPUT', 'That composer edit is not valid');
            return { ok: true, value: composerView(ctx, next) };
        },

        /** Pure Calendar choice and RN task-update plan; the host journals its frozen row before commit. */
        async prepareCalendarComposerSave(input: { requestId: string; composer: NativeCalendarComposer; calendar?: NativeCalendarFeed }): Promise<NativeHostResult<NativeCalendarSchedulePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!calendarRecord(input) || !Object.keys(input).every((key) => ['requestId', 'composer', 'calendar'].includes(key))
                || !Object.prototype.hasOwnProperty.call(input, 'composer') || !Object.prototype.hasOwnProperty.call(input, 'requestId')
                || typeof input.requestId !== 'string' || !CALENDAR_UUID.test(input.requestId)) {
                return fail('INVALID_INPUT', 'An existing composer and request UUID are required');
            }
            const now = new Date();
            const ctx = context(now);
            const composer = readComposer(input.composer, ctx.formatDate);
            const feed = readFeed(input.calendar);
            if (!composer || !feed || composer.mode !== 'existing' || !composer.selectedTaskId
                || !ctx.schedulableTasks.some((task) => task.id === composer.selectedTaskId)) {
                return fail('INVALID_INPUT', 'An offered existing task and composer are required');
            }
            if (feed.status !== 'ready') return fail('ACTION_FAILED', ctx.t('settings.calendarMobile.failedToLoadEvents'));
            const request: NativeCalendarScheduleRequest = { requestId: input.requestId, composer: input.composer };
            const intent = prepareComposerSave(composer, saveContext(ctx, eventsByDay(feed)));
            if (intent.kind === 'error') return { ok: true, value: { kind: 'refused', result: result({ composer: composerView(ctx, { ...composer, error: intent.error }) }) } };
            if (intent.kind !== 'update' || intent.taskId !== composer.selectedTaskId
                || typeof intent.updates.startTime !== 'string' || typeof intent.updates.timeEstimate !== 'string') {
                return fail('INVALID_INPUT', 'Calendar composer did not produce an existing task schedule');
            }
            const store = useTaskStore.getState();
            const task = store._tasksById.get(intent.taskId);
            if (!task || task.deletedAt || task.purgedAt || task.status === 'reference'
                || isStatusListTaskReadOnly(task, store._allProjects)) return fail('TASK_NOT_FOUND', 'Task is not schedulable');
            const navigation = { ...dayView(composer.startAt!), taskId: task.id };
            if (task.startTime === intent.updates.startTime && task.timeEstimate === intent.updates.timeEstimate) {
                if (store.persistenceFailure) {
                    try { await store.retryPersistence(); }
                    catch { return fail('SAVE_FAILED', 'Pending Calendar changes are not saved'); }
                }
                const saved = await deps.save();
                if (!saved.ok) return saved;
                return { ok: true, value: { kind: 'noop', result: result(navigation) } };
            }
            const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            const start = composer.startAt!;
            const policy: CalendarSchedulePolicy = {
                preparedAt: now.toISOString(), preparedOffsetMinutes: -now.getTimezoneOffset(),
                preparedLocalDay: dayKey(now), endOfLocalTodayUTC: end.toISOString(), endOffsetMinutes: -end.getTimezoneOffset(),
                container: {
                    project: projectProjection(store._allProjects.find((item) => item.id === task.projectId)),
                    section: sectionProjection(store._allSections.find((item) => item.id === task.sectionId)),
                    area: areaProjection(store._allAreas.find((item) => item.id === task.areaId)),
                }, normalizedUpdates: {},
            };
            const lists = resolverLists(policy.container);
            const planned = prepareTaskUpdatesForStore({ task, updates: intent.updates,
                allProjects: lists.projects, allSections: lists.sections, allAreas: lists.areas,
                futureBoundary: policy.endOfLocalTodayUTC });
            if (!planned.ok || findTaskProjectReactivationTarget(task, planned.updates, store._allProjects)) {
                return fail('INVALID_INPUT', 'This task needs a wider Calendar update');
            }
            policy.normalizedUpdates = calendarUpdates(planned.updates);
            const device = ensureDeviceId(store.settings);
            const applied = applyTaskUpdates(task, { ...planned.updates, rev: nextRevision(task.rev), revBy: device.deviceId }, policy.preparedAt);
            if (applied.nextRecurringTask) return fail('INVALID_INPUT', 'Recurring follow-up is outside this Calendar save');
            const prepared: NativePreparedCalendarSchedule = {
                version: 1, request, kind: 'existing', before: JSON.parse(JSON.stringify(task)) as Task,
                after: JSON.parse(JSON.stringify(applied.updatedTask)) as Task,
                requested: { startTime: intent.updates.startTime, timeEstimate: intent.updates.timeEstimate as NonNullable<Task['timeEstimate']> }, policy,
                deviceIdBefore: store.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                projection: { offsetMinutes: -start.getTimezoneOffset(), localDay: dayKey(start), localMinute: start.getHours() * 60 + start.getMinutes() },
                result: result({ ...navigation, changed: true }),
            };
            const decoded = validatePreparedCalendarSchedule({ request, prepared });
            return decoded.ok ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Calendar schedule could not produce a valid prepared journal');
        },

        /** The host calls this before SQLite open and terminal cleanup as well as before commit. */
        validatePreparedCalendarComposerSave: validatePreparedCalendarSchedule,

        async commitPreparedCalendarComposerSave(input: { request: NativeCalendarScheduleRequest; prepared: NativePreparedCalendarSchedule }): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const authority = validatePreparedCalendarSchedule(input);
            if (!authority.ok) return authority;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = input.prepared;
            const applied = await useTaskStore.getState().commitPreparedCalendarTask(prepared);
            if (!applied.success) return fail(applied.reason === 'missing' ? 'TASK_NOT_FOUND' : 'STALE_REVISION', applied.error ?? 'Prepared Calendar schedule conflicts with current data');
            if (useTaskStore.getState().persistenceFailure) {
                try { await useTaskStore.getState().retryPersistence(); }
                catch { return fail('SAVE_FAILED', 'Pending Calendar schedule is not saved'); }
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            try { logInfo('Native iOS Calendar schedule saved', { scope: 'native-host', category: 'storage',
                context: { releaseCheck: 'v1.3.3/native-ios-calendar-schedule', outcome: applied.outcome } }); }
            catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            return authority;
        },

        /** Freeze RN's Unschedule update policy before the native host writes its journal. */
        async prepareCalendarUnschedule(input: NativeCalendarUnscheduleRequest): Promise<NativeHostResult<NativeCalendarUnschedulePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!calendarRecord(input) || !calendarKeys(input, ['requestId', 'taskId', 'taskRevision'])
                || typeof input.requestId !== 'string' || !CALENDAR_UUID.test(input.requestId)
                || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 200
                || typeof input.taskRevision !== 'string' || !input.taskRevision || input.taskRevision.length > 200) {
                return fail('INVALID_INPUT', 'An Unschedule task and view revision are required');
            }
            const store = useTaskStore.getState();
            const task = store._tasksById.get(input.taskId);
            if (!task || task.deletedAt || task.purgedAt || task.status === 'reference'
                || isProjectedRecurringTaskId(input.taskId) || isStatusListTaskReadOnly(task, store._allProjects)) {
                return fail('TASK_NOT_FOUND', 'Task is not schedulable');
            }
            if (taskRevisionOf(task) !== input.taskRevision) return fail('STALE_REVISION', 'Task changed since the Calendar view');
            if (!task.startTime) return { ok: true, value: { kind: 'noop', result: unscheduleResult(task.id, false) } };
            const now = new Date();
            const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            const policy: CalendarSchedulePolicy = {
                preparedAt: now.toISOString(), preparedOffsetMinutes: -now.getTimezoneOffset(),
                preparedLocalDay: dayKey(now), endOfLocalTodayUTC: end.toISOString(), endOffsetMinutes: -end.getTimezoneOffset(),
                container: {
                    project: projectProjection(store._allProjects.find((item) => item.id === task.projectId)),
                    section: sectionProjection(store._allSections.find((item) => item.id === task.sectionId)),
                    area: areaProjection(store._allAreas.find((item) => item.id === task.areaId)),
                }, normalizedUpdates: {},
            };
            const lists = resolverLists(policy.container);
            const planned = prepareTaskUpdatesForStore({ task, updates: { ...CALENDAR_UNSCHEDULE_UPDATES },
                allProjects: lists.projects, allSections: lists.sections, allAreas: lists.areas,
                futureBoundary: policy.endOfLocalTodayUTC });
            if (!planned.ok || findTaskProjectReactivationTarget(task, planned.updates, store._allProjects)) {
                return fail('INVALID_INPUT', 'This task needs a wider Calendar update');
            }
            policy.normalizedUpdates = calendarUpdates(planned.updates);
            const device = ensureDeviceId(store.settings);
            const applied = applyTaskUpdates(task, { ...planned.updates, rev: nextRevision(task.rev), revBy: device.deviceId }, policy.preparedAt);
            if (applied.nextRecurringTask) return fail('INVALID_INPUT', 'Recurring follow-up is outside this Calendar save');
            const prepared: NativePreparedCalendarUnschedule = {
                version: 1, kind: 'unschedule', request: input,
                before: JSON.parse(JSON.stringify(task)) as Task,
                after: JSON.parse(JSON.stringify(applied.updatedTask)) as Task,
                policy, deviceIdBefore: store.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                result: unscheduleResult(task.id, true),
            };
            const decoded = validatePreparedCalendarUnschedule({ request: input, prepared });
            return decoded.ok ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Calendar Unschedule could not produce a valid prepared journal');
        },

        validatePreparedCalendarUnschedule,

        async commitPreparedCalendarUnschedule(input: { request: NativeCalendarUnscheduleRequest; prepared: NativePreparedCalendarUnschedule }): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const authority = validatePreparedCalendarUnschedule(input);
            if (!authority.ok) return authority;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const applied = await useTaskStore.getState().commitPreparedCalendarTask(input.prepared);
            if (!applied.success) return fail(applied.reason === 'missing' ? 'TASK_NOT_FOUND' : 'STALE_REVISION', applied.error ?? 'Prepared Calendar Unschedule conflicts with current data');
            if (useTaskStore.getState().persistenceFailure) {
                try { await useTaskStore.getState().retryPersistence(); }
                catch { return fail('SAVE_FAILED', 'Pending Calendar Unschedule is not saved'); }
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            try { logInfo('Native iOS Calendar unschedule saved', { scope: 'native-host', category: 'storage',
                context: { releaseCheck: 'v1.3.4/ios-calendar-unschedule', outcome: applied.outcome } }); }
            catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            return authority;
        },

        /** Resolve RN New composer policy once, then freeze its complete atomic task/project publication. */
        async prepareCalendarEventTaskCreate(input: NativeCalendarEventTaskCreateRequest): Promise<NativeHostResult<NativeCalendarEventTaskCreatePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            try {
                if (!eventCopyTemplateValid(input, true) || !calendarUtf8Within(JSON.stringify(input), 2_000_000)) {
                    return fail('INVALID_INPUT', 'A bounded Calendar event copy and request UUID are required');
                }
                const request = JSON.parse(JSON.stringify(input)) as NativeCalendarEventTaskCreateRequest;
                const store = useTaskStore.getState();
                // A fresh hot submission is not a prepared journal replay.
                if (store._tasksById.has(request.requestId)) return fail('INVALID_INPUT', 'Request ID already belongs to a task');
                const now = new Date();
                const plan = eventCopyPlan(request);
                if (!plan.showDate || (plan.initialProps.description?.length ?? 0) > 22_012) return fail('INVALID_INPUT', 'Calendar event cannot be copied');
                const device = ensureDeviceId(store.settings);
                const creation: CalendarCreationWitness = {
                    selectedProject: null, areas: [], projectOrderMax: null, taskOrderMax: null,
                    defaultAreaMode: store.settings.gtd?.defaultAreaMode ?? null, defaultAreaId: store.settings.gtd?.defaultAreaId ?? null,
                    defaultProjectFlowMode: null, focusCount: 0, focusLimit: 1, focusRequested: false, sequentialEmpty: false,
                    focusEndOfTodayIso: null, focusEndOffsetMinutes: null, preparedOffsetMinutes: -now.getTimezoneOffset(), preparedLocalDay: dayKey(now),
                };
                const defaultId = eventDefaultAreaId(creation);
                const area = defaultId === null ? undefined : store._allAreas.find((item) => item.id === defaultId);
                creation.areas = area ? JSON.parse(JSON.stringify([area])) as Area[] : [];
                const localDay = request.event.allDay ? plan.initialProps.dueDate! : dayKey(plan.showDate);
                const prepared: NativePreparedCalendarEventTaskCreate = {
                    version: 1, kind: 'event', request, intent: { sourceTitle: request.event.title, title: plan.title,
                        props: JSON.parse(JSON.stringify(plan.initialProps)) as Partial<Task>, projectToCreate: null },
                    task: {} as Task, project: null, preparedAt: now.toISOString(), deviceIdBefore: store.settings.deviceId ?? null,
                    deviceIdToInitialize: device.updated ? device.deviceId : null, creation,
                    defaultAreaWitness: defaultId === null ? null : { id: defaultId, before: area ? { deletedAt: area.deletedAt ?? null } : null },
                    projection: { offsetMinutes: -plan.showDate.getTimezoneOffset(), localDay,
                        localMinute: request.event.allDay ? 0 : plan.showDate.getHours() * 60 + plan.showDate.getMinutes() },
                    result: eventCopyResult(request, localDay),
                };
                const rows = calendarCreatedRows(prepared);
                if (!rows) return fail('INVALID_INPUT', 'Calendar event cannot resolve its task container');
                prepared.task = rows.task;
                const authority = validatePreparedCalendarEventTaskCreate({ request, prepared });
                if (!authority.ok) return authority;
                return { ok: true, value: { kind: 'prepared', prepared } };
            } catch { return fail('INVALID_INPUT', 'A bounded Calendar event copy and request UUID are required'); }
        },

        validatePreparedCalendarEventTaskCreate,

        async commitCalendarEventTaskCreate(input: { request: NativeCalendarEventTaskCreateRequest; prepared: NativePreparedCalendarEventTaskCreate }): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const authority = validatePreparedCalendarEventTaskCreate(input);
            if (!authority.ok) return authority;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const applied = await useTaskStore.getState().commitPreparedCalendarCreate(input.prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Calendar event task conflicts with current data');
            if (useTaskStore.getState().persistenceFailure) {
                try { await useTaskStore.getState().retryPersistence(); }
                catch { return fail('SAVE_FAILED', 'Pending Calendar event task is not saved'); }
            }
            const saved = await deps.save();
            return saved.ok ? authority : saved;
        },

        async prepareCalendarComposerCreate(input: { requestId: string; composer: NativeCalendarComposer; calendar?: NativeCalendarFeed }): Promise<NativeHostResult<NativeCalendarCreatePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!calendarRecord(input) || !Object.keys(input).every((key) => ['requestId', 'composer', 'calendar'].includes(key))
                || !Object.prototype.hasOwnProperty.call(input, 'requestId') || !Object.prototype.hasOwnProperty.call(input, 'composer')
                || typeof input.requestId !== 'string' || !CALENDAR_UUID.test(input.requestId)
                || input.requestId !== input.requestId.toLowerCase()) return fail('INVALID_INPUT', 'A New composer and request UUID are required');
            const now = new Date();
            const ctx = context(now);
            const composer = readComposer(input.composer, ctx.formatDate);
            const feed = readFeed(input.calendar);
            if (!composer || composer.mode !== 'new' || !feed) return fail('INVALID_INPUT', 'A valid New composer and calendar are required');
            if (feed.status !== 'ready') return fail('ACTION_FAILED', ctx.t('settings.calendarMobile.failedToLoadEvents'));
            const resolved = prepareComposerSave(composer, saveContext(ctx, eventsByDay(feed)));
            if (resolved.kind === 'error') return { ok: true, value: { kind: 'refused', result: result({ composer: composerView(ctx, { ...composer, error: resolved.error }) }) } };
            if (resolved.kind !== 'create' || !composer.startAt) return fail('INVALID_INPUT', 'Calendar composer did not produce a new task');
            const store = useTaskStore.getState();
            const projectChoice = resolved.projectToCreate;
            const areaId = projectChoice?.initialProps?.areaId;
            const selectedProject = projectChoice
                ? findSelectableProjectByTitleAndArea(store._allProjects, projectChoice.name, areaId)
                : resolved.draft.props.projectId
                    ? store._allProjects.find((item) => item.id === resolved.draft.props.projectId)
                    : undefined;
            const projectId = selectedProject?.id ?? (projectChoice ? generateUUID() : resolved.draft.props.projectId);
            const usesDefaultArea = !projectChoice && !resolved.draft.props.projectId
                && !Object.prototype.hasOwnProperty.call(resolved.draft.props, 'areaId');
            const areaIds = new Set([areaId, resolved.draft.props.areaId, selectedProject?.areaId,
                usesDefaultArea ? store.settings.gtd?.defaultAreaId : undefined]
                .filter((id): id is string => typeof id === 'string' && Boolean(id)));
            const areas = store._allAreas.filter((area) => areaIds.has(area.id));
            if (areas.length > 2) return fail('INVALID_INPUT', 'Calendar creation needs too many area inputs');
            const sequentialEmpty = resolved.draft.props.isFocusedToday === true && selectedProject?.isSequential === true
                && !store._allTasks.some((task) => task.projectId === selectedProject.id);
            if (resolved.draft.props.isFocusedToday === true && selectedProject?.isSequential && !sequentialEmpty) {
                return fail('INVALID_INPUT', 'Cannot add this task to Today’s Focus in a sequential project');
            }
            const focusEnd = resolved.draft.props.isFocusedToday === true
                ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999) : null;
            const focusedCount = focusEnd ? countFocusedTasksBeforeBoundary(store.tasks, focusEnd.toISOString()) : 0;
            if (focusEnd && focusedCount !== store.getFocusedCount()) {
                return fail('INVALID_INPUT', 'Calendar Focus count changed; reopen the composer');
            }
            const projectOrderMax = projectChoice && !selectedProject
                ? store._allProjects.filter((item) => (item.areaId ?? null) === (areaId ?? null))
                    .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1)
                : null;
            const taskOrderMax = projectId ? (getNextProjectOrder(projectId, store._allTasks) ?? 0) - 1 : null;
            const device = ensureDeviceId(store.settings);
            const request: NativeCalendarCreateRequest = { requestId: input.requestId, composer: input.composer };
            const start = composer.startAt;
            const prepared: NativePreparedCalendarCreate = {
                version: 1, kind: 'new', request,
                intent: {
                    sourceTitle: input.composer.title, title: resolved.draft.title,
                    props: JSON.parse(JSON.stringify(resolved.draft.props)) as Partial<Task>,
                    projectToCreate: projectChoice ? { name: projectChoice.name, color: projectChoice.color, areaId: areaId ?? null } : null,
                }, task: {} as Task, project: projectChoice && !selectedProject ? { id: projectId } as Project : null,
                generatedLinkIds: (resolved.draft.props.attachments ?? []).map((attachment) => attachment.id),
                preparedAt: now.toISOString(), deviceIdBefore: store.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                creation: {
                    selectedProject: selectedProject ?? null, areas, projectOrderMax, taskOrderMax,
                    defaultAreaMode: store.settings.gtd?.defaultAreaMode ?? null,
                    defaultAreaId: store.settings.gtd?.defaultAreaId ?? null,
                    defaultProjectFlowMode: store.settings.gtd?.defaultProjectFlowMode ?? null,
                    focusCount: focusedCount, focusLimit: normalizeFocusTaskLimit(store.settings.gtd?.focusTaskLimit),
                    focusRequested: resolved.draft.props.isFocusedToday === true,
                    sequentialEmpty: Boolean(sequentialEmpty),
                    focusEndOfTodayIso: focusEnd?.toISOString() ?? null,
                    focusEndOffsetMinutes: focusEnd ? -focusEnd.getTimezoneOffset() : null,
                    preparedOffsetMinutes: -now.getTimezoneOffset(), preparedLocalDay: dayKey(now),
                },
                projection: { offsetMinutes: -start.getTimezoneOffset(), localDay: dayKey(start), localMinute: start.getHours() * 60 + start.getMinutes() },
                result: result({ ...dayView(start), changed: true, taskId: input.requestId }),
            };
            const rows = calendarCreatedRows(prepared);
            if (!rows) return fail('INVALID_INPUT', 'Calendar creation cannot resolve its container');
            if (prepared.creation.focusRequested && rows.project?.isSequential === true) prepared.creation.sequentialEmpty = true;
            if (prepared.creation.focusRequested && (rows.project ?? prepared.creation.selectedProject)?.isSequential === true
                && !prepared.creation.sequentialEmpty) {
                return fail('INVALID_INPUT', 'Cannot add this task to Today’s Focus in a sequential project');
            }
            prepared.task = rows.task;
            prepared.project = rows.project;
            if (!validatePreparedCalendarCreate({ request, prepared }).ok) return fail('INVALID_INPUT', 'Calendar creation could not produce a valid prepared journal');
            return { ok: true, value: { kind: 'prepared', prepared } };
        },

        validatePreparedCalendarComposerCreate: validatePreparedCalendarCreate,

        async commitPreparedCalendarComposerCreate(input: { request: NativeCalendarCreateRequest; prepared: NativePreparedCalendarCreate }): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const authority = validatePreparedCalendarCreate(input);
            if (!authority.ok) return authority;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const applied = await useTaskStore.getState().commitPreparedCalendarCreate(input.prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Calendar creation conflicts with current data');
            if (useTaskStore.getState().persistenceFailure) {
                try { await useTaskStore.getState().retryPersistence(); }
                catch { return fail('SAVE_FAILED', 'Pending Calendar creation is not saved'); }
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            try { logInfo('Native iOS Calendar task created', { scope: 'native-host', category: 'storage',
                context: { releaseCheck: 'v1.3.3/native-ios-calendar-create', outcome: applied.outcome } }); }
            catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            return authority;
        },

        /**
         * One calendar action, as the screen writes it. Reuse `requestId` to retry:
         * a completed request writes nothing again. Send the `calendar` the view
         * shows: a move and a composer save check the day's events for overlaps, and
         * an event task names its calendar. A write to an existing task sends the
         * revision the view showed (the composer carries its own) and is refused
         * (STALE_REVISION) when the task changed since.
         */
        async runCalendarAction(input: {
            requestId: string;
            action: NativeCalendarAction;
            state?: NativeCalendarState;
            calendar?: NativeCalendarFeed;
        }): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action) || typeof input.requestId !== 'string') {
                return fail('INVALID_INPUT', 'A request UUID and an action are required');
            }
            const ctx = context(new Date());
            const feed = readFeed(input.calendar);
            const state = readState(input.state, ctx);
            if (!feed || !state) return fail('INVALID_INPUT', 'The view\'s state and a calendar that is loading, ready or an error are required');
            const action = input.action as NativeCalendarAction;
            const requestId = input.requestId;
            const payload = JSON.stringify(['calendar', action]);
            // The receipts come first: a request that is running or owes its save skips the
            // checks of a new request (the slot may be taken since), and only saves.
            const known = entered.get(requestId);
            if (known === undefined) {
                const refused = check(requestId, action, ctx, feed);
                if (refused) return refused as NativeHostResult<NativeCalendarActionResult>;
                entered.set(requestId, payload);
                if (entered.size > ENTERED_LIMIT) entered.delete(entered.keys().next().value!);
            }
            const outcome = await receipts.run(requestId, payload, () => perform(requestId, action, context(new Date()), feed, state));
            // A write that did not land leaves no receipt; another payload under a known ID was refused and changes nothing.
            if (!outcome.ok && outcome.error.code !== 'SAVE_FAILED' && (known === undefined || known === payload)) entered.delete(requestId);
            return outcome;
        },
    };
}
