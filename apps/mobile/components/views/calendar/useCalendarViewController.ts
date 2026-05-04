import { Alert } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CALENDAR_TIME_ESTIMATE_OPTIONS,
  DEFAULT_CALENDAR_DAY_END_HOUR,
  DEFAULT_CALENDAR_DAY_START_HOUR,
  normalizeDateFormatSetting,
  resolveDateLocaleTag,
  findFreeSlotForDay as findCalendarFreeSlotForDay,
  isSlotFreeForDay as isCalendarSlotFreeForDay,
  minutesToTimeEstimate,
  safeFormatDate,
  safeParseDate,
  safeParseDueDate,
  timeEstimateToMinutes as resolveTimeEstimateToMinutes,
  translateText,
  type ExternalCalendarEvent,
  type ExternalCalendarSubscription,
  type Task,
  useTaskStore,
} from '@mindwtr/core';

import { useTheme } from '../../../contexts/theme-context';
import { useToast } from '../../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { useLanguage } from '../../../contexts/language-context';
import { canOpenExternalCalendarEvent, fetchExternalCalendarEvents, openExternalCalendarEvent } from '../../../lib/external-calendar';
import { logError } from '../../../lib/app-log';
import {
  coerceCalendarWeekVisibleDays,
  coerceCalendarViewMode,
  getInitialCalendarSelectedDate,
  needsCalendarSelectedDate,
  type CalendarViewMode,
} from './calendar-view-mode';

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number, weekStartIndex: number): number {
  const day = new Date(year, month, 1).getDay();
  return (day - weekStartIndex + 7) % 7;
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
const SNAP_MINUTES = 5;
type CalendarTaskComposerMode = 'new' | 'existing';
type CalendarTaskComposerState = {
  date: Date;
  durationMinutes: number;
  endTimeValue: string;
  error: string | null;
  mode: CalendarTaskComposerMode;
  query: string;
  selectedTaskId: string | null;
  startTimeValue: string;
  title: string;
};

const SOURCE_COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#059669', '#0891B2', '#4F46E5', '#65A30D'];
const sourceColorCache = new Map<string, string>();

const sourceColorForId = (sourceId: string): string => {
  const cached = sourceColorCache.get(sourceId);
  if (cached) return cached;
  let hash = 0;
  for (let index = 0; index < sourceId.length; index += 1) {
    hash = ((hash << 5) - hash) + sourceId.charCodeAt(index);
    hash |= 0;
  }
  const color = SOURCE_COLORS[Math.abs(hash) % SOURCE_COLORS.length] ?? SOURCE_COLORS[0];
  sourceColorCache.set(sourceId, color);
  return color;
};

const addMinutesToDate = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60 * 1000);

const formatTimeInputValue = (date: Date): string => (
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
);

const parseTimeOnDate = (date: Date, value: string): Date | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const next = new Date(date);
  next.setHours(hours, minutes, 0, 0);
  return next;
};

const calendarDateKey = (date: Date): string => (
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
);

const addMapItem = <T,>(map: Map<string, T[]>, date: Date, item: T) => {
  const key = calendarDateKey(date);
  const items = map.get(key);
  if (items) {
    items.push(item);
    return;
  }
  map.set(key, [item]);
};

const normalizeDurationMinutes = (minutes: number): number => {
  const estimate = minutesToTimeEstimate(minutes);
  return CALENDAR_TIME_ESTIMATE_OPTIONS.find((option) => option.estimate === estimate)?.minutes
    ?? resolveTimeEstimateToMinutes(estimate);
};

export function useCalendarViewController() {
  const { tasks, projects, addTask, updateTask, deleteTask, updateSettings, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const { t, language } = useLanguage();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();

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

  const localize = (enText: string, zhText?: string) =>
    (language === 'zh' || language === 'zh-Hant') && zhText ? zhText : translateText(enText, language);

  const timeEstimatesEnabled = useTaskStore((state) => state.settings?.features?.timeEstimates !== false);
  const today = new Date();
  const initialViewMode = coerceCalendarViewMode(settings?.calendar?.viewMode);
  const calendarWeekVisibleDays = coerceCalendarWeekVisibleDays(settings?.calendar?.weekVisibleDays);
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
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
  const [nowTick, setNowTick] = useState(() => Date.now());
  const timelineScrollRef = useRef<any>(null);
  const [pendingScrollMinutes, setPendingScrollMinutes] = useState<number | null>(null);
  const lastDefaultTimelineScrollKeyRef = useRef('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [calendarComposer, setCalendarComposer] = useState<CalendarTaskComposerState | null>(null);

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const logCalendarError = (error: unknown) => {
    void logError(error, { scope: 'calendar' });
  };
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
    setCurrentMonth(nextDate.getMonth());
    setCurrentYear(nextDate.getFullYear());
  }, []);
  const setViewMode = (nextMode: CalendarViewMode) => {
    ensureSelectedDateForViewMode(nextMode);
    pendingViewModeSaveRef.current = nextMode;
    setViewModeState(nextMode);
    updateSettings({ calendar: { ...settings?.calendar, viewMode: nextMode } })
      .catch(logCalendarError);
  };

  const setCalendarWeekVisibleDays = (visibleDays: number) => {
    const nextVisibleDays = coerceCalendarWeekVisibleDays(visibleDays);
    if (nextVisibleDays === calendarWeekVisibleDays) return;
    updateSettings({ calendar: { ...settings?.calendar, weekVisibleDays: nextVisibleDays } })
      .catch(logCalendarError);
  };

  useEffect(() => {
    ensureSelectedDateForViewMode(viewMode);
  }, [ensureSelectedDateForViewMode, viewMode]);

  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const storedViewMode = settings?.calendar?.viewMode;
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
  }, [ensureSelectedDateForViewMode, settings?.calendar?.viewMode]);

  const weekStartIndex = settings?.weekStart === 'monday' ? 1 : 0;
  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth, weekStartIndex);
  const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
    ? Intl.DateTimeFormat().resolvedOptions().locale
    : '';
  const locale = resolveDateLocaleTag({
    language,
    dateFormat: normalizeDateFormatSetting(settings?.dateFormat),
    systemLocale,
  });
  const monthLabel = new Date(currentYear, currentMonth, 1).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
  });
  const dayNames = Array.from({ length: 7 }, (_, i) => {
    const base = new Date(2021, 7, 1 + ((i + weekStartIndex) % 7));
    return base.toLocaleDateString(locale, { weekday: 'short' });
  });
  const weekStartDate = useMemo(() => (
    getWeekStart(selectedDate ?? new Date(currentYear, currentMonth, 1), weekStartIndex)
  ), [currentMonth, currentYear, selectedDate, weekStartIndex]);
  const weekStartTime = weekStartDate.getTime();
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStartTime);
    date.setDate(date.getDate() + index);
    return date;
  }), [weekStartTime]);
  const weekLabel = useMemo(() => (
    `${weekDays[0].toLocaleDateString(locale, { month: 'short', day: 'numeric' })} - ${weekDays[6].toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`
  ), [locale, weekDays]);
  const defaultTimelineScrollKey = useMemo(() => {
    if (viewMode === 'day' && selectedDate) return `day:${calendarDateKey(selectedDate)}`;
    if (viewMode === 'week') return `week:${weekStartTime}`;
    return '';
  }, [selectedDate, viewMode, weekStartTime]);

  const areaVisibleTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById))
  ), [tasks, resolvedAreaFilter, projectById, areaById]);

  const visibleTasks = areaVisibleTasks;

  const schedulableTasks = useMemo(() => (
    areaVisibleTasks
      .filter((task) => !task.deletedAt && task.status !== 'done' && task.status !== 'archived' && task.status !== 'reference')
      .sort((a, b) => a.title.localeCompare(b.title))
  ), [areaVisibleTasks]);

  const visibleSchedulableTasks = schedulableTasks;

  const scheduledTasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of visibleTasks) {
      if (!task.startTime) continue;
      const startTime = safeParseDate(task.startTime);
      if (startTime) addMapItem(map, startTime, task);
    }
    return map;
  }, [visibleTasks]);

  const deadlineTasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of visibleTasks) {
      if (!task.dueDate) continue;
      const dueDate = safeParseDueDate(task.dueDate);
      if (dueDate) addMapItem(map, dueDate, task);
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
        addMapItem(map, day, event);
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

  const getTaskCountForDate = useCallback((date: Date) => {
    const ids = new Set<string>();
    for (const task of getDeadlinesForDate(date)) ids.add(task.id);
    for (const task of getScheduledForDate(date)) ids.add(task.id);
    return ids.size;
  }, [getDeadlinesForDate, getScheduledForDate]);

  const getExternalEventsForDate = useCallback((date: Date) => {
    return externalEventsByDate.get(calendarDateKey(date)) ?? [];
  }, [externalEventsByDate]);

  const getCalendarItemsForDate = useCallback((date: Date) => {
    const scheduled = getScheduledForDate(date);
    const scheduledIds = new Set(scheduled.map((task) => task.id));
    const deadlines = getDeadlinesForDate(date).filter((task) => !scheduledIds.has(task.id));
    return [
      ...scheduled.map((task) => ({
        id: `scheduled-${task.id}`,
        kind: 'scheduled' as const,
        title: task.title,
        task,
        start: task.startTime ? safeParseDate(task.startTime) : null,
      })),
      ...deadlines.map((task) => ({
        id: `deadline-${task.id}`,
        kind: 'deadline' as const,
        title: task.title,
        task,
        start: task.dueDate ? safeParseDueDate(task.dueDate) : null,
      })),
      ...getExternalEventsForDate(date).map((event) => ({
        id: `event-${event.id}`,
        kind: 'event' as const,
        title: event.title,
        event,
        start: safeParseDate(event.start),
      })),
    ].sort((a, b) => {
      const aTime = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return a.title.localeCompare(b.title);
    });
  }, [getDeadlinesForDate, getExternalEventsForDate, getScheduledForDate]);

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

  const externalCalendarRange = useMemo(() => {
    const weekStart = new Date(weekStartTime);
    const rangeStart = viewMode === 'week'
      ? weekStart
      : viewMode === 'schedule'
        ? new Date(selectedDate ?? new Date(currentYear, currentMonth, 1))
        : new Date(currentYear, currentMonth, 1, 0, 0, 0, 0);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = viewMode === 'week'
      ? new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6, 23, 59, 59, 999)
      : viewMode === 'schedule'
        ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 45, 23, 59, 59, 999)
        : new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);
    return { rangeStart, rangeEnd };
  }, [currentMonth, currentYear, selectedDate, viewMode, weekStartTime]);

  const externalRangeStartMs = externalCalendarRange.rangeStart.getTime();
  const externalRangeEndMs = externalCalendarRange.rangeEnd.getTime();

  useEffect(() => {
    let cancelled = false;
    setIsExternalLoading(true);
    setExternalError(null);
    const rangeStart = new Date(externalRangeStartMs);
    const rangeEnd = new Date(externalRangeEndMs);

    fetchExternalCalendarEvents(rangeStart, rangeEnd)
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
    };
  }, [externalRangeEndMs, externalRangeStartMs]);

  const calendarNameById = useMemo(
    () => new Map(externalCalendars.map((calendar) => [calendar.id, calendar.name])),
    [externalCalendars],
  );

  const nextQuickScheduleCandidates = useMemo(() => {
    if (!selectedDate) return [];
    return visibleSchedulableTasks
      .filter((task) => task.status === 'next')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 6);
  }, [selectedDate, visibleSchedulableTasks]);

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

  const openCalendarComposerAt = (start: Date, options?: { durationMinutes?: number; mode?: CalendarTaskComposerMode; taskId?: string }) => {
    const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) : null;
    const durationMinutes = normalizeDurationMinutes(
      options?.durationMinutes ?? (selectedTask ? timeEstimateToMinutes(selectedTask.timeEstimate) : 30)
    );
    setCalendarComposer({
      date: start,
      durationMinutes,
      endTimeValue: formatTimeInputValue(addMinutesToDate(start, durationMinutes)),
      error: null,
      mode: options?.mode ?? 'new',
      query: selectedTask?.title ?? '',
      selectedTaskId: selectedTask?.id ?? null,
      startTimeValue: formatTimeInputValue(start),
      title: '',
    });
  };

  const openCalendarComposerForDate = (date: Date, options?: { mode?: CalendarTaskComposerMode; taskId?: string }) => {
    const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) : null;
    const durationMinutes = normalizeDurationMinutes(selectedTask ? timeEstimateToMinutes(selectedTask.timeEstimate) : 30);
    const slot = findFreeSlotForDay(date, durationMinutes, selectedTask?.id);
    const fallback = new Date(date);
    fallback.setHours(DEFAULT_CALENDAR_DAY_START_HOUR, 0, 0, 0);
    openCalendarComposerAt(slot ?? fallback, { durationMinutes, mode: options?.mode, taskId: selectedTask?.id });
  };

  const setCalendarComposerMode = (mode: CalendarTaskComposerMode) => {
    setCalendarComposer((prev) => prev ? { ...prev, mode, error: null } : prev);
  };

  const setCalendarComposerTitle = (title: string) => {
    setCalendarComposer((prev) => prev ? { ...prev, title, error: null } : prev);
  };

  const setCalendarComposerQuery = (query: string) => {
    setCalendarComposer((prev) => prev ? { ...prev, query, selectedTaskId: null, error: null } : prev);
  };

  const selectCalendarComposerTask = (task: Task) => {
    const durationMinutes = normalizeDurationMinutes(timeEstimateToMinutes(task.timeEstimate));
    setCalendarComposer((prev) => {
      if (!prev) return prev;
      const start = parseTimeOnDate(prev.date, prev.startTimeValue) ?? prev.date;
      return {
        ...prev,
        durationMinutes,
        endTimeValue: formatTimeInputValue(addMinutesToDate(start, durationMinutes)),
        error: null,
        query: task.title,
        selectedTaskId: task.id,
      };
    });
  };

  const setCalendarComposerStartTime = (value: string) => {
    setCalendarComposer((prev) => {
      if (!prev) return prev;
      const start = parseTimeOnDate(prev.date, value);
      return {
        ...prev,
        endTimeValue: start ? formatTimeInputValue(addMinutesToDate(start, prev.durationMinutes)) : prev.endTimeValue,
        error: null,
        startTimeValue: value,
      };
    });
  };

  const setCalendarComposerDuration = (durationMinutes: number) => {
    setCalendarComposer((prev) => {
      if (!prev) return prev;
      const normalized = normalizeDurationMinutes(durationMinutes);
      const start = parseTimeOnDate(prev.date, prev.startTimeValue) ?? prev.date;
      return {
        ...prev,
        durationMinutes: normalized,
        endTimeValue: formatTimeInputValue(addMinutesToDate(start, normalized)),
        error: null,
      };
    });
  };

  const setCalendarComposerEndTime = (value: string) => {
    setCalendarComposer((prev) => {
      if (!prev) return prev;
      const start = parseTimeOnDate(prev.date, prev.startTimeValue);
      const end = parseTimeOnDate(prev.date, value);
      if (!start || !end || end <= start) return { ...prev, endTimeValue: value, error: null };
      const normalized = normalizeDurationMinutes((end.getTime() - start.getTime()) / 60_000);
      return {
        ...prev,
        durationMinutes: normalized,
        endTimeValue: formatTimeInputValue(addMinutesToDate(start, normalized)),
        error: null,
      };
    });
  };

  const closeCalendarComposer = () => setCalendarComposer(null);

  const saveCalendarComposer = async () => {
    if (!calendarComposer) return;
    const start = parseTimeOnDate(calendarComposer.date, calendarComposer.startTimeValue);
    const end = parseTimeOnDate(calendarComposer.date, calendarComposer.endTimeValue);
    if (!start || !end || end <= start) {
      setCalendarComposer((prev) => prev ? { ...prev, error: localize('Choose a valid start and end time.', '请选择有效的开始和结束时间。') } : prev);
      return;
    }

    const durationMinutes = normalizeDurationMinutes(calendarComposer.durationMinutes);
    const selectedTaskId = calendarComposer.mode === 'existing' ? calendarComposer.selectedTaskId : null;
    if (calendarComposer.mode === 'new' && !calendarComposer.title.trim()) {
      setCalendarComposer((prev) => prev ? { ...prev, error: localize('Enter a task title.', '请输入任务标题。') } : prev);
      return;
    }
    if (calendarComposer.mode === 'existing' && !selectedTaskId) {
      setCalendarComposer((prev) => prev ? { ...prev, error: localize('Choose a task.', '请选择一个任务。') } : prev);
      return;
    }
    if (!isSlotFreeForDay(start, start, durationMinutes, selectedTaskId ?? undefined)) {
      setCalendarComposer((prev) => prev ? { ...prev, error: t('calendar.overlapWarning') } : prev);
      return;
    }

    const updates = {
      startTime: start.toISOString(),
      timeEstimate: minutesToTimeEstimate(durationMinutes),
    };
    try {
      if (selectedTaskId) {
        await updateTask(selectedTaskId, updates);
      } else {
        const result = await addTask(calendarComposer.title.trim(), { status: 'next', ...updates });
        if (!result.success) {
          setCalendarComposer((prev) => prev ? { ...prev, error: result.error ?? localize('Could not save the task.', '无法保存任务。') } : prev);
          return;
        }
      }
      setCalendarComposer(null);
      setScheduleQuery('');
      setSelectedDate(start);
      setCurrentMonth(start.getMonth());
      setCurrentYear(start.getFullYear());
      setPendingScrollMinutes((start.getHours() * 60 + start.getMinutes()) - DAY_START_HOUR * 60);
      setViewMode('day');
    } catch (error) {
      logCalendarError(error);
      setCalendarComposer((prev) => prev ? { ...prev, error: localize('Could not save the task.', '无法保存任务。') } : prev);
    }
  };

  const scheduleTaskOnSelectedDate = (taskId: string) => {
    if (!selectedDate) return;
    const task = schedulableTasks.find((item) => item.id === taskId);
    if (!task) return;

    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    const slot = findFreeSlotForDay(selectedDate, durationMinutes, taskId);
    if (!slot) {
      showToast({
        title: localize('No free time', '没有空闲时间'),
        message: localize('There is not enough free time on this day to schedule the task.', '这一天没有足够的空闲时间来安排该任务。'),
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

  useEffect(() => {
    if (viewMode !== 'day' && viewMode !== 'week') return;
    if (viewMode === 'day' && !selectedDate) return;
    if (pendingScrollMinutes == null) return;

    const y = Math.max(0, pendingScrollMinutes * PIXELS_PER_MINUTE - 180);
    const frame = requestAnimationFrame(() => {
      timelineScrollRef.current?.scrollTo({ y, animated: true });
      setPendingScrollMinutes(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [viewMode, selectedDate, pendingScrollMinutes]);

  useEffect(() => {
    if (!defaultTimelineScrollKey) return;
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
    setCurrentMonth(next.getMonth());
    setCurrentYear(next.getFullYear());
  };

  const handleToday = () => {
    const next = new Date();
    setSelectedDate(next);
    setCurrentMonth(next.getMonth());
    setCurrentYear(next.getFullYear());
    if (viewMode === 'day' || viewMode === 'week') {
      setPendingScrollMinutes((next.getHours() * 60 + next.getMinutes()) - DAY_START_HOUR * 60);
    }
  };

  const formatHourLabel = (hour: number) => {
    const sample = new Date(2025, 0, 1, hour, 0, 0, 0);
    return safeFormatDate(sample, 'p');
  };

  const formatTimeRange = (start: Date, durationMinutes: number) => {
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const startLabel = safeFormatDate(start, 'p');
    const endLabel = safeFormatDate(end, 'p');
    return `${startLabel}-${endLabel}`;
  };

  const getScheduleSlotLabel = (date: Date, task: Task) => {
    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    const slot = findFreeSlotForDay(date, durationMinutes, task.id);
    return slot ? formatTimeRange(slot, durationMinutes) : null;
  };

  const commitTaskDrag = (taskId: string, dayStartMs: number, startMinutes: number, durationMinutes: number) => {
    const day = new Date(dayStartMs);
    const nextStart = new Date(dayStartMs + startMinutes * 60 * 1000);
    const ok = isSlotFreeForDay(day, nextStart, durationMinutes, taskId);
    if (!ok) {
      showToast({
        title: localize('Time conflict', '时间冲突'),
        message: localize('That time overlaps with an event. Please choose a free slot.', '该时间段与日程冲突，请选择空闲时间。'),
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
    if (task.status !== 'done' && task.status !== 'archived') {
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

  const openExternalEvent = (event: ExternalCalendarEvent) => {
    if (!canOpenExternalCalendarEvent(event)) {
      showToast({
        title: localize('Cannot open event', '无法打开日程'),
        message: localize('Only device calendar events can be opened in the calendar app.', '只有设备日历事件可以在日历应用中打开。'),
        tone: 'info',
        durationMs: 3600,
      });
      return;
    }

    openExternalCalendarEvent(event)
      .then((opened) => {
        if (opened) return;
        showToast({
          title: localize('Cannot open event', '无法打开日程'),
          message: localize('This calendar app does not support opening the event.', '该日历应用不支持打开此日程。'),
          tone: 'info',
          durationMs: 3600,
        });
      })
      .catch((error) => {
        logCalendarError(error);
        showToast({
          title: localize('Cannot open event', '无法打开日程'),
          message: localize('Open the event from your calendar app instead.', '请改从你的日历应用打开该日程。'),
          tone: 'warning',
          durationMs: 4200,
        });
      });
  };

  const handlePrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) calendarDays.push(null);
  for (let day = 1; day <= daysInMonth; day++) calendarDays.push(day);

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
  const selectedDateAllDayEvents = useMemo(
    () => selectedDateExternalEvents.filter((event) => event.allDay),
    [selectedDateExternalEvents],
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
  const selectedDayMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const timelineHeight = selectedDayMinutes * PIXELS_PER_MINUTE;
  const selectedDayScheduledTasks = useMemo(
    () => selectedDateScheduled.filter((task) => !task.deletedAt && task.status !== 'done' && task.status !== 'reference'),
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
  const selectedDayModeLabel = selectedDate
    ? `${selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'long', day: 'numeric' })}${isToday(selectedDate) ? ` · ${localize('Today', '今天')}` : ''}`
    : '';
  const scheduleSections = useMemo(() => {
    const start = selectedDate ?? new Date(currentYear, currentMonth, 1);
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
  }, [currentMonth, currentYear, getCalendarItemsForDate, selectedDate]);

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
    calendarComposerSelectedTask,
    calendarWeekVisibleDays,
    calendarNameById,
    closeCalendarComposer,
    closeEditingTask,
    commitTaskDrag,
    currentMonth,
    currentYear,
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
    handleToday,
    isDark,
    isExternalLoading,
    isExternalEventOpenable: canOpenExternalCalendarEvent,
    isSameDay,
    isToday,
    locale,
    localize,
    markTaskDone,
    monthLabel,
    nextQuickScheduleCandidates,
    openQuickAddAtDateTime,
    openQuickAddForDate,
    openExternalEvent,
    openTaskActions,
    saveEditingTask,
    scheduleQuery,
    scheduleTaskOnSelectedDate,
    searchCandidates,
    selectedDate,
    selectedDateAllDayEvents,
    selectedDateDeadlines,
    selectedDateExternalEvents,
    selectedDateLongLabel,
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
    setCurrentMonth,
    setCurrentYear,
    setEditingTask,
    setScheduleQuery,
    setSelectedDate,
    setTimelineScrollEnabled,
    setViewMode,
    shiftSelectedDate,
    showToast,
    sourceColorForId,
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
