import { useFocusEffect } from '@react-navigation/native';
import {
  Alert,
  AppState,
  type AlertButton,
  type AppStateStatus,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CALENDAR_DAY_END_HOUR,
  DEFAULT_CALENDAR_DAY_START_HOUR,
  addCalendarMonths as addCalendarSystemMonths,
  buildCalendarEventTaskDraft,
  buildQuickAddParseOptions,
  expandCalendarRecurringTaskSetInRange,
  formatCalendarTimeInputValue,
  getCalendarPlanningCandidates,
  getCalendarMonthIndex,
  getShortWeekdayLabels,
  normalizeDateFormatSetting,
  resolveCalendarSystemSetting,
  resolveDateLocaleTag,
  resolveFeatureFlags,
  findFreeSlotForDay as findCalendarFreeSlotForDay,
  resolveI18nText,
  type I18nTemplateValues,
  getWeekStartsOnIndex,
  isSlotFreeForDay as isCalendarSlotFreeForDay,
  isProjectedRecurringTask,
  isProjectedRecurringTaskId,
  isTaskFinished,
  isTaskInCalendarHistoryProject,
  parseCalendarTimeOnDate,
  safeFormatDate,
  safeParseDate,
  safeParseDueDate,
  shallow,
  startOfCalendarMonth,
  resolveExternalCalendarColor,
  themeExternalCalendarDisplayColor,
  timeEstimateToMinutes as resolveTimeEstimateToMinutes,
  type CalendarSettings,
  type ExternalCalendarEvent,
  type ExternalCalendarSubscription,
  type Task,
  useTaskStore,
} from '@mindwtr/core';
import {
  executeComposerSave,
  openComposerAt,
  openComposerForDate,
  selectComposerTask,
  setComposerDuration,
  setComposerEndTime,
  setComposerMode,
  setComposerQuery,
  setComposerStart,
  setComposerTitle,
  type CalendarComposerDeps,
  type CalendarComposerError,
  type CalendarComposerMode,
  type CalendarComposerState,
} from '@mindwtr/core/calendar-composer';
import {
  buildCalendarDayItems,
  getTaskCompletionInstant,
  isCompletedCalendarTask,
  isSchedulableCalendarTask,
} from '@mindwtr/core/calendar-day-items';

import { useTheme } from '../../../contexts/theme-context';
import { useToast } from '../../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { taskMatchesAreaFilterSelection } from '@mindwtr/core';
import { useLanguage } from '../../../contexts/language-context';
import { canOpenExternalCalendarEvent, fetchExternalCalendarEvents, openExternalCalendarEvent } from '../../../lib/external-calendar';
import { logError } from '../../../lib/app-log';
import {
  coerceCalendarWeekVisibleDays,
  coerceCalendarViewMode,
  getCalendarTimelineAnchorMinutes,
  getCalendarTimelineDefaultScrollKey,
  getCalendarTimelineScrollYForMinutes,
  getCalendarWeekVisibleDaysUpdate,
  getInitialCalendarSelectedDate,
  needsCalendarSelectedDate,
  shiftCalendarVisibleMonth,
  type CalendarViewMode,
} from './calendar-view-mode';
import {
  addCalendarMapItem,
  buildScheduledTasksByDate,
  calendarDateKey,
  compactHourLabel,
  isTimedScheduledTask,
} from './calendar-task-items';
import {
  EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS,
  shouldRefreshExternalCalendarOnAppStateChange,
} from './calendar-external-refresh';

function getFirstDayOfMonth(monthDate: Date, weekStartIndex: number): number {
  const day = monthDate.getDay();
  return (day - weekStartIndex + 7) % 7;
}

function getCalendarMonthDates(monthDate: Date, calendarSystem: string): Date[] {
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

function getWeekStart(date: Date, weekStartIndex: number): Date {
  const start = new Date(date);
  const diff = (start.getDay() - weekStartIndex + 7) % 7;
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const PIXELS_PER_MINUTE = 1.4;
const DAY_TIMELINE_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const SNAP_MINUTES = 5;
type CalendarTaskComposerMode = CalendarComposerMode;
/** Shared composer state plus the mobile day and free-text time input. */
type CalendarTaskComposerState = CalendarComposerState & {
  date: Date;
  startTimeValue: string;
};

/**
 * User pick > feed-provided color > deterministic palette hash (#974), then a
 * display-only theme remap — the resolved value is canonical, `theme` only
 * decides which hex it is painted as.
 */
const sourceColorForId = (sourceId: string, override?: string, feedColor?: string, theme?: string): string => (
  themeExternalCalendarDisplayColor(resolveExternalCalendarColor(sourceId, override, feedColor), theme)
);

const formatTimeInputValue = formatCalendarTimeInputValue;
const parseTimeOnDate = parseCalendarTimeOnDate;

export function useCalendarViewController() {
  const { tasks, allTasks, projects, areas, addTask, addProject, updateTask, deleteTask, people, updateSettings, settings } = useTaskStore((state) => ({
    tasks: state.tasks,
    people: state.people,
    // Archived tasks are absent from the visible `tasks` projection, so the
    // completed look-back reads the full list like the Archive screen (#955).
    allTasks: state._allTasks,
    projects: state.projects,
    areas: state.areas,
    addProject: state.addProject,
    addTask: state.addTask,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    updateSettings: state.updateSettings,
    settings: state.settings,
  }), shallow);
  const { isDark, themePreset } = useTheme();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const { t, language } = useLanguage();
  const { areaById, projectById, resolvedAreaFilter, visibleTasks: areaVisibleTasks } = useVisibleTaskContext();
  const quickAddParseOptions = useMemo(
    () => buildQuickAddParseOptions(settings, { tasks, people }),
    [people, settings, tasks],
  );

  const toRgba = (hex: string, alpha: number) => {
    const normalized = hex.replace('#', '');
    const full = normalized.length === 3
      ? normalized.split('').map((c) => c + c).join('')
      : normalized.padEnd(6, '0');
    const intVal = Number.parseInt(full, 16);
    const r = (intVal >> 16) & 255;
    const g = (intVal >> 8) & 255;
    const b = intVal & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const tr = (key: string, values?: I18nTemplateValues) => resolveI18nText(t, key, { values });

  const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);
  const calendarSettings: CalendarSettings | undefined = settings?.calendar;
  const today = new Date();
  const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
    ? Intl.DateTimeFormat().resolvedOptions().locale
    : '';
  const calendarSystem = resolveCalendarSystemSetting(settings?.calendarSystem, { language, systemLocale });
  const initialViewMode = coerceCalendarViewMode(calendarSettings?.viewMode);
  const calendarWeekVisibleDays = coerceCalendarWeekVisibleDays(calendarSettings?.weekVisibleDays);
  const calendarSettingsRef = useRef(calendarSettings);
  const requestedCalendarWeekVisibleDaysRef = useRef(calendarWeekVisibleDays);
  const showCompleted = calendarSettings?.showCompleted === true;
  const [visibleMonthDate, setVisibleMonthDate] = useState(today);
  const [selectedDate, setSelectedDate] = useState<Date | null>(() => getInitialCalendarSelectedDate(initialViewMode, today));
  const [viewMode, setViewModeState] = useState<CalendarViewMode>(() => initialViewMode);
  const pendingViewModeSaveRef = useRef<CalendarViewMode | null>(null);
  const selectedDateRef = useRef<Date | null>(selectedDate);
  const viewModeRef = useRef<CalendarViewMode>(viewMode);
  const [scheduleQuery, setScheduleQuery] = useState('');
  const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [isExternalLoading, setIsExternalLoading] = useState(false);
  const [externalRefreshToken, setExternalRefreshToken] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const nowTickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasHandledInitialFocusRef = useRef(false);
  const lastExternalRefreshRequestMsRef = useRef(0);
  const timelineScrollRef = useRef<any>(null);
  const timelineScrollOffsetRef = useRef(0);
  const timelineContentTopRef = useRef(0);
  const timelineAnchorMinutesRef = useRef<number | null>(null);
  const lastDayTimelineRestoreKeyRef = useRef('');
  const [pendingScrollMinutes, setPendingScrollMinutes] = useState<number | null>(null);
  const lastDefaultTimelineScrollKeyRef = useRef('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [calendarComposer, setCalendarComposer] = useState<CalendarTaskComposerState | null>(null);

  const logCalendarError = (error: unknown) => {
    void logError(error, { scope: 'calendar' });
  };
  useEffect(() => {
    calendarSettingsRef.current = calendarSettings;
  }, [calendarSettings]);
  useEffect(() => {
    requestedCalendarWeekVisibleDaysRef.current = calendarWeekVisibleDays;
  }, [calendarWeekVisibleDays]);
  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  const ensureSelectedDateForViewMode = useCallback((nextMode: CalendarViewMode) => {
    if (!needsCalendarSelectedDate(nextMode) || selectedDateRef.current) return;
    const nextDate = new Date();
    selectedDateRef.current = nextDate;
    setSelectedDate(nextDate);
    setVisibleMonthDate(nextDate);
  }, []);
  const setViewMode = (nextMode: CalendarViewMode) => {
    ensureSelectedDateForViewMode(nextMode);
    pendingViewModeSaveRef.current = nextMode;
    setViewModeState(nextMode);
    updateSettings({ calendar: { ...calendarSettings, viewMode: nextMode } })
      .catch(logCalendarError);
  };

  const toggleShowCompleted = () => {
    updateSettings({ calendar: { ...calendarSettings, showCompleted: !showCompleted } })
      .catch(logCalendarError);
  };

  const setCalendarWeekVisibleDays = useCallback((visibleDays: number) => {
    const previousVisibleDays = requestedCalendarWeekVisibleDaysRef.current;
    const nextVisibleDays = getCalendarWeekVisibleDaysUpdate({
      currentVisibleDays: previousVisibleDays,
      requestedVisibleDays: visibleDays,
    });
    if (nextVisibleDays === null) return;

    // A pan gesture emits many frames for each integer tick. Record the
    // requested value before persistence so stale callback closures cannot
    // enqueue the same settings write on every frame.
    requestedCalendarWeekVisibleDaysRef.current = nextVisibleDays;
    updateSettings({
      calendar: {
        ...calendarSettingsRef.current,
        weekVisibleDays: nextVisibleDays,
      },
    }).catch((error) => {
      if (requestedCalendarWeekVisibleDaysRef.current === nextVisibleDays) {
        requestedCalendarWeekVisibleDaysRef.current = previousVisibleDays;
      }
      void logError(error, { scope: 'calendar' });
    });
  }, [updateSettings]);

  useEffect(() => {
    ensureSelectedDateForViewMode(viewMode);
  }, [ensureSelectedDateForViewMode, viewMode]);

  useEffect(() => {
    const storedViewMode = calendarSettings?.viewMode;
    if (!storedViewMode) return;
    const nextMode = coerceCalendarViewMode(storedViewMode);
    if (pendingViewModeSaveRef.current) {
      if (pendingViewModeSaveRef.current === nextMode) {
        pendingViewModeSaveRef.current = null;
      } else {
        return;
      }
    }
    if (viewModeRef.current === nextMode) return;
    setViewModeState(nextMode);
    ensureSelectedDateForViewMode(nextMode);
  }, [calendarSettings?.viewMode, ensureSelectedDateForViewMode]);

  const weekStartIndex = getWeekStartsOnIndex(settings?.weekStart);
  const currentMonthDate = useMemo(
    () => startOfCalendarMonth(visibleMonthDate, calendarSystem),
    [calendarSystem, visibleMonthDate],
  );
  const monthDates = useMemo(
    () => getCalendarMonthDates(currentMonthDate, calendarSystem),
    [calendarSystem, currentMonthDate],
  );
  const firstDay = getFirstDayOfMonth(currentMonthDate, weekStartIndex);
  const locale = resolveDateLocaleTag({
    language,
    dateFormat: normalizeDateFormatSetting(settings?.dateFormat),
    calendarSystem: settings?.calendarSystem,
    systemLocale,
  });
  const monthLabel = currentMonthDate.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
  });
  const shortWeekdayLabels = getShortWeekdayLabels(locale);
  const dayNames = Array.from({ length: 7 }, (_, i) => shortWeekdayLabels[(i + weekStartIndex) % 7]);
  const weekStartDate = useMemo(() => (
    getWeekStart(selectedDate ?? currentMonthDate, weekStartIndex)
  ), [currentMonthDate, selectedDate, weekStartIndex]);
  const weekStartTime = weekStartDate.getTime();
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStartTime);
    date.setDate(date.getDate() + index);
    return date;
  }), [weekStartTime]);
  const weekLabel = useMemo(() => (
    `${weekDays[0].toLocaleDateString(locale, { month: 'short', day: 'numeric' })} - ${weekDays[6].toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`
  ), [locale, weekDays]);
  const defaultTimelineScrollKey = useMemo(() => getCalendarTimelineDefaultScrollKey({
    selectedDate,
    viewMode,
    weekStartTime,
  }), [selectedDate, viewMode, weekStartTime]);

  // The same visible-window bounds used to fetch/clip external calendar events
  // below double as the recurrence range: whatever window the month grid, week
  // strip, or schedule list is currently showing is exactly what a "show future
  // recurrence" task should paint every occurrence into (#calendar-range-projection).
  const externalCalendarRange = useMemo(() => {
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
        ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 45, 23, 59, 59, 999)
        : new Date(addCalendarSystemMonths(currentMonthDate, 1, calendarSystem).getTime() - 1);
    return { rangeStart, rangeEnd };
  }, [calendarSystem, currentMonthDate, selectedDate, viewMode, weekStartTime]);

  // Primitive bounds, not the `externalCalendarRange` object: in month mode the window's actual
  // start/end don't change when the selected day or week-start reference does, but the object's
  // identity does, and re-expanding every recurring task's whole range on every day tap is exactly
  // the "unrelated state change" P19 says must not re-enumerate.
  const externalRangeStartMs = externalCalendarRange.rangeStart.getTime();
  const externalRangeEndMs = externalCalendarRange.rangeEnd.getTime();
  const recurrenceProjectionDayKey = calendarDateKey(new Date(nowTick));
  const recurrenceProjectedAtIso = useMemo(
    () => new Date(nowTick).toISOString(),
    // A calendar projection changes at a local-day boundary, not on every
    // minute tick used by the current-time line and planning suggestions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recurrenceProjectionDayKey],
  );

  const visibleTasks = useMemo(() => {
    const recurrenceRange = {
      startIso: new Date(externalRangeStartMs).toISOString(),
      endIso: new Date(externalRangeEndMs).toISOString(),
    };
    // Done, archived and reference tasks are deliberately excluded here: they
    // belong to the completed look-back below, filed by completion date, not to
    // the scheduled/deadline buckets. Before #955 mobile left them in and showed
    // finished work on its old start/due date while desktop hid it entirely.
    const schedulable = areaVisibleTasks.filter(isSchedulableCalendarTask);
    return expandCalendarRecurringTaskSetInRange(
      schedulable,
      recurrenceRange,
      recurrenceProjectedAtIso,
    );
  }, [areaVisibleTasks, externalRangeStartMs, externalRangeEndMs, recurrenceProjectedAtIso]);

  const completedTasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    if (!showCompleted) return map;
    for (const task of allTasks) {
      if (!isCompletedCalendarTask(task)) continue;
      if (!isTaskInCalendarHistoryProject(task, projectById)) continue;
      if (!taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectById, areaById)) continue;
      const completedAt = getTaskCompletionInstant(task);
      if (completedAt) addCalendarMapItem(map, completedAt, task);
    }
    return map;
  }, [allTasks, showCompleted, projectById, resolvedAreaFilter, areaById]);

  const schedulableTasks = useMemo(() => (
    areaVisibleTasks
      .filter(isSchedulableCalendarTask)
      .sort((a, b) => a.title.localeCompare(b.title))
  ), [areaVisibleTasks]);

  const visibleSchedulableTasks = schedulableTasks;

  const scheduledTasksByDate = useMemo(() => buildScheduledTasksByDate(visibleTasks), [visibleTasks]);

  const deadlineTasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of visibleTasks) {
      if (!task.dueDate) continue;
      const dueDate = safeParseDueDate(task.dueDate);
      if (dueDate) addCalendarMapItem(map, dueDate, task);
    }
    return map;
  }, [visibleTasks]);

  const externalEventsByDate = useMemo(() => {
    const map = new Map<string, ExternalCalendarEvent[]>();
    for (const event of externalEvents) {
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
  }, [externalEvents]);

  const getDeadlinesForDate = useCallback((date: Date): Task[] => (
    deadlineTasksByDate.get(calendarDateKey(date)) ?? []
  ), [deadlineTasksByDate]);

  const getScheduledForDate = useCallback((date: Date): Task[] => (
    scheduledTasksByDate.get(calendarDateKey(date)) ?? []
  ), [scheduledTasksByDate]);

  const getCompletedForDate = useCallback((date: Date): Task[] => (
    completedTasksByDate.get(calendarDateKey(date)) ?? []
  ), [completedTasksByDate]);

  const getTaskCountForDate = useCallback((date: Date) => {
    const ids = new Set<string>();
    for (const task of getDeadlinesForDate(date)) ids.add(task.id);
    for (const task of getScheduledForDate(date)) ids.add(task.id);
    for (const task of getCompletedForDate(date)) ids.add(task.id);
    return ids.size;
  }, [getCompletedForDate, getDeadlinesForDate, getScheduledForDate]);

  const getExternalEventsForDate = useCallback((date: Date) => {
    return externalEventsByDate.get(calendarDateKey(date)) ?? [];
  }, [externalEventsByDate]);

  const getCalendarItemsForDate = useCallback((date: Date) => buildCalendarDayItems({
    completed: getCompletedForDate(date),
    deadlines: getDeadlinesForDate(date),
    events: getExternalEventsForDate(date),
    scheduled: getScheduledForDate(date),
  }), [getCompletedForDate, getDeadlinesForDate, getExternalEventsForDate, getScheduledForDate]);

  const timeEstimateToMinutes = (estimate: Task['timeEstimate']): number => (
    resolveTimeEstimateToMinutes(estimate, { enabled: timeEstimatesEnabled })
  );

  const findFreeSlotForDay = (day: Date, durationMinutes: number, excludeTaskId?: string): Date | null => (
    findCalendarFreeSlotForDay({
      day,
      dayEndHour: DEFAULT_CALENDAR_DAY_END_HOUR,
      dayStartHour: DEFAULT_CALENDAR_DAY_START_HOUR,
      durationMinutes,
      events: getExternalEventsForDate(day),
      excludeTaskId,
      snapMinutes: SNAP_MINUTES,
      tasks: schedulableTasks,
      timeEstimatesEnabled,
    })
  );

  const isSlotFreeForDay = (day: Date, startTime: Date, durationMinutes: number, excludeTaskId?: string): boolean => (
    isCalendarSlotFreeForDay({
      day,
      dayEndHour: DAY_END_HOUR,
      dayStartHour: DAY_START_HOUR,
      durationMinutes,
      events: getExternalEventsForDate(day),
      excludeTaskId,
      snapMinutes: SNAP_MINUTES,
      startTime,
      tasks: schedulableTasks,
      timeEstimatesEnabled,
    })
  );

  const externalCalendarSettings = settings?.externalCalendars;

  const requestExternalCalendarRefresh = useCallback(() => {
    const nowMs = Date.now();
    if (nowMs - lastExternalRefreshRequestMsRef.current < EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS) return;
    lastExternalRefreshRequestMsRef.current = nowMs;
    setExternalRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setIsExternalLoading(true);
    setExternalError(null);
    const rangeStart = new Date(externalRangeStartMs);
    const rangeEnd = new Date(externalRangeEndMs);

    fetchExternalCalendarEvents(rangeStart, rangeEnd, { signal: controller?.signal })
      .then(({ calendars, events }) => {
        if (cancelled) return;
        setExternalCalendars(calendars);
        setExternalEvents(events);
      })
      .catch((error) => {
        if (cancelled) return;
        logCalendarError(error);
        setExternalError(String(error));
        setExternalEvents([]);
      })
      .finally(() => {
        if (cancelled) return;
        setIsExternalLoading(false);
      });

    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [externalCalendarSettings, externalRangeEndMs, externalRangeStartMs, externalRefreshToken]);

  useFocusEffect(
    useCallback(() => {
      if (!hasHandledInitialFocusRef.current) {
        hasHandledInitialFocusRef.current = true;
        return undefined;
      }
      requestExternalCalendarRefresh();
      return undefined;
    }, [requestExternalCalendarRefresh]),
  );

  useEffect(() => {
    // The "now" tick only needs to run while the app is on screen: a
    // backgrounded calendar view has nothing rendering its current-time line
    // or day-keyed planning candidates, so ticking there just wakes the JS
    // thread for no visible effect.
    const startNowTick = () => {
      if (nowTickIntervalRef.current) return;
      setNowTick(Date.now());
      nowTickIntervalRef.current = setInterval(() => setNowTick(Date.now()), 60_000);
    };
    const stopNowTick = () => {
      if (!nowTickIntervalRef.current) return;
      clearInterval(nowTickIntervalRef.current);
      nowTickIntervalRef.current = null;
    };

    // iOS reports 'inactive' (not 'active') during a cold launch's initial
    // AppState read, so only treat 'background' as not-yet-active (correction #6).
    if (appStateRef.current !== 'background') startNowTick();

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (shouldRefreshExternalCalendarOnAppStateChange(appStateRef.current, nextAppState)) {
        requestExternalCalendarRefresh();
      }
      if (nextAppState === 'active') {
        startNowTick();
      } else {
        stopNowTick();
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
      stopNowTick();
    };
  }, [requestExternalCalendarRefresh]);

  const calendarNameById = useMemo(
    () => new Map(externalCalendars.map((calendar) => [calendar.id, calendar.name])),
    [externalCalendars],
  );
  const calendarColorById = useMemo(
    () => new Map(externalCalendars.map((calendar) => [calendar.id, sourceColorForId(calendar.id, calendar.color, calendar.feedColor, themePreset)])),
    [externalCalendars, themePreset],
  );
  const getSourceColorForId = useCallback(
    (sourceId: string) => calendarColorById.get(sourceId) ?? sourceColorForId(sourceId, undefined, undefined, themePreset),
    [calendarColorById, themePreset],
  );

  const planningTasks = useMemo(() => {
    if (!selectedDate) return [];
    return getCalendarPlanningCandidates(areaVisibleTasks, {
      limit: 6,
      now: new Date(nowTick),
      prioritizeByPriority: prioritiesEnabled,
      projects,
    });
    // Planning candidates recompute at most once per local day, not on every
    // minute tick: nowTick only sets the "now" instant used for date/sort
    // comparisons, mirrored from recurrenceProjectedAtIso above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaVisibleTasks, recurrenceProjectionDayKey, prioritiesEnabled, projects, selectedDate]);

  const searchCandidates = useMemo(() => {
    if (!selectedDate) return [];
    const query = scheduleQuery.trim().toLowerCase();
    if (!query) return [];
    return visibleSchedulableTasks
      .filter((task) => task.title.toLowerCase().includes(query))
      .slice(0, 8);
  }, [scheduleQuery, selectedDate, visibleSchedulableTasks]);

  const calendarComposerCandidates = useMemo(() => {
    if (!calendarComposer || calendarComposer.mode !== 'existing') return [];
    const query = calendarComposer.query.trim().toLowerCase();
    return visibleSchedulableTasks
      .filter((task) => !query || task.title.toLowerCase().includes(query))
      .slice(0, 10);
  }, [calendarComposer, visibleSchedulableTasks]);

  const calendarComposerSelectedTask = calendarComposer?.selectedTaskId
    ? tasks.find((task) => task.id === calendarComposer.selectedTaskId) ?? null
    : null;

  const composerDeps: CalendarComposerDeps = {
    findFreeSlot: findFreeSlotForDay,
    timeEstimateToMinutes,
  };

  const openedComposer = (state: CalendarComposerState, date: Date): CalendarTaskComposerState => {
    const start = state.startAt ?? date;
    return { ...state, date: start, startTimeValue: formatTimeInputValue(start) };
  };

  const applyToComposer = (update: (state: CalendarTaskComposerState) => CalendarComposerState) => {
    setCalendarComposer((prev) => prev ? { ...prev, ...update(prev) } : prev);
  };

  const composerErrorText = (error: CalendarComposerError): string => {
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

  const calendarComposerError = calendarComposer?.error ? composerErrorText(calendarComposer.error) : null;

  const failCalendarComposer = (error: CalendarComposerError) => {
    setCalendarComposer((prev) => prev ? { ...prev, error } : prev);
  };

  const openCalendarComposerAt = (start: Date, options?: { durationMinutes?: number; mode?: CalendarTaskComposerMode; taskId?: string }) => {
    const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) ?? null : null;
    setCalendarComposer(openedComposer(openComposerAt(start, {
      durationMinutes: options?.durationMinutes,
      mode: options?.mode,
      task: selectedTask,
    }, composerDeps), start));
  };

  const openCalendarComposerForDate = (date: Date, options?: { mode?: CalendarTaskComposerMode; taskId?: string }) => {
    const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) ?? null : null;
    setCalendarComposer(openedComposer(openComposerForDate(date, {
      mode: options?.mode,
      task: selectedTask,
    }, composerDeps), date));
  };

  const setCalendarComposerMode = (mode: CalendarTaskComposerMode) => {
    applyToComposer((prev) => setComposerMode(prev, mode));
  };

  const setCalendarComposerTitle = (title: string) => {
    applyToComposer((prev) => setComposerTitle(prev, title));
  };

  const setCalendarComposerQuery = (query: string) => {
    applyToComposer((prev) => setComposerQuery(prev, query));
  };

  const selectCalendarComposerTask = (task: Task) => {
    applyToComposer((prev) => selectComposerTask(prev, task, composerDeps));
  };

  const setCalendarComposerStartTime = (value: string) => {
    setCalendarComposer((prev) => prev ? {
      ...prev,
      ...setComposerStart(prev, parseTimeOnDate(prev.date, value)),
      startTimeValue: value,
    } : prev);
  };

  const setCalendarComposerDuration = (durationMinutes: number) => {
    applyToComposer((prev) => setComposerDuration(prev, durationMinutes));
  };

  const setCalendarComposerEndTime = (value: string) => {
    applyToComposer((prev) => setComposerEndTime(prev, value));
  };

  const closeCalendarComposer = () => setCalendarComposer(null);

  const saveCalendarComposer = async () => {
    if (!calendarComposer) return;
    const result = await executeComposerSave(calendarComposer, {
      areas,
      isSlotFree: (start, durationMinutes, excludeTaskId) => (
        isSlotFreeForDay(start, start, durationMinutes, excludeTaskId)
      ),
      parseOptions: quickAddParseOptions,
      projects,
    }, { addProject, addTask, updateTask });
    if (!result.success) {
      if (result.cause !== undefined) logCalendarError(result.cause);
      failCalendarComposer(result.error);
      return;
    }

    setCalendarComposer(null);
    setScheduleQuery('');
    setSelectedDate(result.start);
    setVisibleMonthDate(result.start);
    setPendingScrollMinutes((result.start.getHours() * 60 + result.start.getMinutes()) - DAY_START_HOUR * 60);
    setViewMode('day');
  };

  const scheduleTaskOnSelectedDate = (taskId: string) => {
    if (!selectedDate) return;
    const task = schedulableTasks.find((item) => item.id === taskId);
    if (!task) return;

    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    const slot = findFreeSlotForDay(selectedDate, durationMinutes, taskId);
    if (!slot) {
      showToast({
        title: t('calendar.noFreeTimeTitle'),
        message: t('calendar.noFreeTime'),
        tone: 'info',
        durationMs: 4200,
      });
      return;
    }

    openCalendarComposerAt(slot, { durationMinutes, mode: 'existing', taskId });
  };

  const openQuickAddForDate = (date: Date) => {
    openCalendarComposerForDate(date, { mode: 'new' });
  };

  const openQuickAddAtDateTime = (date: Date) => {
    openCalendarComposerAt(date, { mode: 'new' });
  };

  const selectedDayKey = selectedDate
    ? `${selectedDate.getFullYear()}-${selectedDate.getMonth()}-${selectedDate.getDate()}`
    : '';

  const getTimelineScrollY = useCallback((minutes: number) => getCalendarTimelineScrollYForMinutes({
    contentTop: viewModeRef.current === 'day' ? timelineContentTopRef.current : 0,
    minutes,
    pixelsPerMinute: PIXELS_PER_MINUTE,
  }), []);

  const rememberTimelineScrollY = useCallback((scrollY: number) => {
    timelineScrollOffsetRef.current = Math.max(0, scrollY);
    timelineAnchorMinutesRef.current = getCalendarTimelineAnchorMinutes({
      contentTop: viewModeRef.current === 'day' ? timelineContentTopRef.current : 0,
      dayMinutes: DAY_TIMELINE_MINUTES,
      pixelsPerMinute: PIXELS_PER_MINUTE,
      scrollY: timelineScrollOffsetRef.current,
    });
  }, []);

  const scrollTimelineToMinutes = useCallback((minutes: number, animated: boolean) => {
    const y = getTimelineScrollY(minutes);
    rememberTimelineScrollY(y);
    timelineScrollRef.current?.scrollTo({ y, animated });
  }, [getTimelineScrollY, rememberTimelineScrollY]);

  const handleTimelineScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    rememberTimelineScrollY(event.nativeEvent.contentOffset.y);
  }, [rememberTimelineScrollY]);

  const handleTimelineContentLayout = useCallback((event: LayoutChangeEvent) => {
    timelineContentTopRef.current = event.nativeEvent.layout.y;
  }, []);

  useEffect(() => {
    if (viewMode !== 'day' && viewMode !== 'week') return;
    if (viewMode === 'day' && !selectedDate) return;
    if (pendingScrollMinutes == null) return;

    const frame = requestAnimationFrame(() => {
      scrollTimelineToMinutes(pendingScrollMinutes, true);
      setPendingScrollMinutes(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingScrollMinutes, scrollTimelineToMinutes, selectedDate, viewMode]);

  useEffect(() => {
    // Runs after persisted view-mode/date restore above so day switches keep the user's previous timeline anchor.
    if (viewMode !== 'day' || !selectedDate || pendingScrollMinutes != null) return;
    if (lastDefaultTimelineScrollKeyRef.current !== 'day') return;
    if (lastDayTimelineRestoreKeyRef.current === selectedDayKey) return;

    lastDayTimelineRestoreKeyRef.current = selectedDayKey;
    const minutes = timelineAnchorMinutesRef.current;
    if (minutes == null) return;

    const frame = requestAnimationFrame(() => {
      scrollTimelineToMinutes(minutes, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingScrollMinutes, scrollTimelineToMinutes, selectedDate, selectedDayKey, viewMode]);

  useEffect(() => {
    if (!defaultTimelineScrollKey) {
      lastDefaultTimelineScrollKeyRef.current = '';
      return;
    }
    if (lastDefaultTimelineScrollKeyRef.current === defaultTimelineScrollKey) return;
    lastDefaultTimelineScrollKeyRef.current = defaultTimelineScrollKey;
    if (pendingScrollMinutes != null) return;

    const now = new Date();
    setPendingScrollMinutes((now.getHours() * 60 + now.getMinutes()) - DAY_START_HOUR * 60);
  }, [defaultTimelineScrollKey, pendingScrollMinutes]);

  const shiftSelectedDate = (daysDelta: number) => {
    if (!selectedDate) return;
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + daysDelta);
    setSelectedDate(next);
    setVisibleMonthDate(next);
  };

  const handleToday = () => {
    const next = new Date();
    setSelectedDate(next);
    setVisibleMonthDate(next);
    if (viewMode === 'day' || viewMode === 'week') {
      setPendingScrollMinutes((next.getHours() * 60 + next.getMinutes()) - DAY_START_HOUR * 60);
    }
  };

  const formatHourLabel = (hour: number) => {
    const sample = new Date(2025, 0, 1, hour, 0, 0, 0);
    return compactHourLabel(safeFormatDate(sample, 'p'));
  };

  const formatTimeRange = (start: Date, durationMinutes: number) => {
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const startLabel = safeFormatDate(start, 'p');
    const endLabel = safeFormatDate(end, 'p');
    return `${startLabel}-${endLabel}`;
  };

  const getScheduleSlotLabel = (date: Date | null, task: Task) => {
    if (!date) return null;
    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    const slot = findFreeSlotForDay(date, durationMinutes, task.id);
    return slot ? formatTimeRange(slot, durationMinutes) : null;
  };

  const commitTaskDrag = (taskId: string, dayStartMs: number, startMinutes: number, durationMinutes: number) => {
    if (isProjectedRecurringTaskId(taskId)) return;
    const day = new Date(dayStartMs);
    const nextStart = new Date(dayStartMs + startMinutes * 60 * 1000);
    const ok = isSlotFreeForDay(day, nextStart, durationMinutes, taskId);
    if (!ok) {
      showToast({
        title: t('calendar.timeConflictTitle'),
        message: t('calendar.overlapWarning'),
        tone: 'warning',
        durationMs: 4200,
      });
      return;
    }
    updateTask(taskId, { startTime: nextStart.toISOString() }).catch(logCalendarError);
  };

  const setTimelineScrollEnabled = (enabled: boolean) => {
    const ref = timelineScrollRef.current as any;
    if (!ref?.setNativeProps) return;
    ref.setNativeProps({ scrollEnabled: enabled });
  };

  const markTaskDone = (taskId: string) => {
    updateTask(taskId, { status: 'done', isFocusedToday: false }).catch(logCalendarError);
  };

  const openTaskActions = (taskId: string) => {
    const task = visibleTasks.find((item) => item.id === taskId);
    if (!task) return;
    if (isProjectedRecurringTask(task)) {
      Alert.alert(
        task.title,
        tr('calendar.projectedRecurrenceDescription'),
        [{ text: t('common.ok') }],
        { cancelable: true },
      );
      return;
    }

    const buttons = [
      {
        text: t('common.edit'),
        onPress: () => setEditingTask(task),
      },
    ] as Parameters<typeof Alert.alert>[2];

    if (task.startTime) {
      buttons?.push({
        text: t('calendar.unschedule'),
        onPress: () => updateTask(task.id, { startTime: undefined }).catch(logCalendarError),
      });
    }
    if (!isTaskFinished(task)) {
      buttons?.push({
        text: t('status.done'),
        onPress: () => markTaskDone(task.id),
      });
    }

    buttons?.push(
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => deleteTask(task.id).catch(logCalendarError),
      },
      { text: t('common.cancel'), style: 'cancel' },
    );

    Alert.alert(task.title, undefined, buttons, { cancelable: true });
  };

  const openExternalEventInCalendar = (event: ExternalCalendarEvent) => {
    openExternalCalendarEvent(event)
      .then((opened) => {
        if (opened) return;
        showToast({
          title: t('calendar.cannotOpenEventTitle'),
          message: t('calendar.openUnsupported'),
          tone: 'info',
          durationMs: 3600,
        });
      })
      .catch((error) => {
        logCalendarError(error);
        showToast({
          title: t('calendar.cannotOpenEventTitle'),
          message: t('calendar.openFromCalendarApp'),
          tone: 'warning',
          durationMs: 4200,
        });
      });
  };

  const createTaskFromExternalEvent = async (event: ExternalCalendarEvent) => {
    try {
      const { initialProps, title } = buildCalendarEventTaskDraft(event, {
        calendarName: calendarNameById.get(event.sourceId),
        fallbackTitle: t('calendar.eventFallbackTitle'),
      });
      const result = await addTask(title, initialProps);
      if (!result.success) {
        showToast({
          title: t('calendar.saveTaskFailed'),
          message: result.error ?? t('calendar.saveTaskFailed'),
          tone: 'warning',
          durationMs: 4200,
        });
        return;
      }

      const nextDate = safeParseDate(initialProps.startTime ?? initialProps.dueDate ?? event.start);
      if (nextDate) {
        setSelectedDate(nextDate);
        setVisibleMonthDate(nextDate);
      }
      showToast({
        title: t('calendar.eventTaskCreatedTitle'),
        message: t('calendar.eventTaskCreated'),
        tone: 'success',
        durationMs: 3000,
      });
    } catch (error) {
      logCalendarError(error);
      showToast({
        title: t('calendar.saveTaskFailed'),
        message: t('calendar.saveTaskFailed'),
        tone: 'warning',
        durationMs: 4200,
      });
    }
  };

  const openExternalEvent = (event: ExternalCalendarEvent) => {
    const buttons: AlertButton[] = [
      {
        text: t('calendar.createTaskFromEvent'),
        onPress: () => {
          void createTaskFromExternalEvent(event);
        },
      },
    ];

    if (canOpenExternalCalendarEvent(event)) {
      buttons.push({
        text: t('calendar.openInCalendar'),
        onPress: () => openExternalEventInCalendar(event),
      });
    }

    buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(event.title || t('calendar.eventFallbackTitle'), undefined, buttons, { cancelable: true });
  };

  const handlePrevMonth = () => {
    setVisibleMonthDate(shiftCalendarVisibleMonth(currentMonthDate, -1, calendarSystem));
  };

  const handleNextMonth = () => {
    setVisibleMonthDate(shiftCalendarVisibleMonth(currentMonthDate, 1, calendarSystem));
  };

  const calendarDays: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) calendarDays.push(null);
  calendarDays.push(...monthDates);

  const selectedDateExternalEvents = useMemo(
    () => (selectedDate ? getExternalEventsForDate(selectedDate) : []),
    [getExternalEventsForDate, selectedDate],
  );
  const selectedDateDeadlines = useMemo(
    () => (selectedDate ? getDeadlinesForDate(selectedDate) : []),
    [getDeadlinesForDate, selectedDate],
  );
  const selectedDateScheduled = useMemo(
    () => (selectedDate ? getScheduledForDate(selectedDate) : []),
    [getScheduledForDate, selectedDate],
  );
  const selectedDateTimedEvents = useMemo(
    () => selectedDateExternalEvents.filter((event) => !event.allDay),
    [selectedDateExternalEvents],
  );
  const selectedDayStart = useMemo(() => {
    if (!selectedDate) return null;
    const dayStart = new Date(selectedDate);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
    return dayStart;
  }, [selectedDate]);
  const selectedDayEnd = useMemo(() => {
    if (!selectedDate) return null;
    const dayEnd = new Date(selectedDate);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
    return dayEnd;
  }, [selectedDate]);
  const selectedDayMinutes = DAY_TIMELINE_MINUTES;
  const timelineHeight = selectedDayMinutes * PIXELS_PER_MINUTE;
  const selectedDayScheduledTasks = useMemo(
    () => selectedDateScheduled.filter((task) =>
      isTimedScheduledTask(task)
      && !task.deletedAt
      && task.status !== 'done'
      && task.status !== 'reference'
    ),
    [selectedDateScheduled],
  );
  const selectedDayNowTop = useMemo(() => {
    if (!selectedDate || !isToday(selectedDate)) return null;
    const now = new Date(nowTick);
    const minutes = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
    if (minutes < 0 || minutes > selectedDayMinutes) return null;
    return minutes * PIXELS_PER_MINUTE;
  }, [nowTick, selectedDate, selectedDayMinutes]);
  const selectedDateLongLabel = selectedDate
    ? selectedDate.toLocaleDateString(locale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '';
  const selectedDatePlanningLabel = selectedDate
    ? tr('calendar.planningForDate', {
        date: selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }),
      })
    : '';
  const selectedDayModeLabel = selectedDate
    ? `${selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'long', day: 'numeric' })}${isToday(selectedDate) ? ` · ${t('filters.datePreset.today')}` : ''}`
    : '';
  const scheduleSections = useMemo(() => {
    const start = selectedDate ?? currentMonthDate;
    const sections: { date: Date; id: string; items: ReturnType<typeof getCalendarItemsForDate> }[] = [];
    for (let offset = 0; offset < 45; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset);
      const items = getCalendarItemsForDate(date);
      if (items.length === 0) continue;
      sections.push({ id: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`, date, items });
      if (sections.length >= 18) break;
    }
    return sections;
  }, [currentMonthDate, getCalendarItemsForDate, selectedDate]);

  const closeEditingTask = () => setEditingTask(null);
  const saveEditingTask = (taskId: string, updates: Partial<Task>) => updateTask(taskId, updates);

  return {
    DAY_END_HOUR,
    DAY_START_HOUR,
    PIXELS_PER_MINUTE,
    SNAP_MINUTES,
    calendarDays,
    calendarComposer,
    calendarComposerCandidates,
    calendarComposerError,
    calendarComposerSelectedTask,
    calendarSystem,
    calendarWeekVisibleDays,
    calendarNameById,
    closeCalendarComposer,
    closeEditingTask,
    commitTaskDrag,
    dayNames,
    editingTask,
    externalCalendars,
    externalError,
    formatHourLabel,
    formatTimeRange,
    getCalendarItemsForDate,
    getExternalEventsForDate,
    getScheduleSlotLabel,
    getTaskCountForDate,
    handleNextMonth,
    handlePrevMonth,
    handleTimelineContentLayout,
    handleTimelineScroll,
    handleToday,
    isDark,
    isExternalLoading,
    isExternalEventOpenable: canOpenExternalCalendarEvent,
    isSameDay,
    isToday,
    locale,
    markTaskDone,
    monthLabel,
    planningTasks,
    tr,
    openQuickAddAtDateTime,
    openQuickAddForDate,
    openExternalEvent,
    openTaskActions,
    saveEditingTask,
    scheduleQuery,
    scheduleTaskOnSelectedDate,
    searchCandidates,
    selectedDate,
    selectedDateDeadlines,
    selectedDateExternalEvents,
    selectedDateLongLabel,
    selectedDatePlanningLabel,
    selectedDateScheduled,
    selectedDateTimedEvents,
    selectedDayMinutes,
    selectedDayModeLabel,
    selectedDayNowTop,
    selectedDayScheduledTasks,
    selectedDayStart,
    selectedDayEnd,
    scheduleSections,
    saveCalendarComposer,
    selectCalendarComposerTask,
    setCalendarComposerDuration,
    setCalendarComposerEndTime,
    setCalendarComposerMode,
    setCalendarComposerQuery,
    setCalendarComposerStartTime,
    setCalendarComposerTitle,
    setCalendarWeekVisibleDays,
    showCompleted,
    toggleShowCompleted,
    setEditingTask,
    setScheduleQuery,
    setSelectedDate,
    setTimelineScrollEnabled,
    setViewMode,
    shiftSelectedDate,
    showToast,
    sourceColorForId: getSourceColorForId,
    t,
    tc,
    timeEstimateToMinutes,
    timelineHeight,
    timelineScrollRef,
    toRgba,
    updateTask,
    viewMode,
    weekDays,
    weekLabel,
  };
}
