import { Alert } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CALENDAR_TIME_ESTIMATE_OPTIONS,
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
import { fetchExternalCalendarEvents } from '../../../lib/external-calendar';
import { logError } from '../../../lib/app-log';

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

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 23;
const PIXELS_PER_MINUTE = 1.4;
const SNAP_MINUTES = 5;
type CalendarViewMode = 'month' | 'day' | 'week' | 'schedule';
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

const sourceColorForId = (sourceId: string): string => {
  let hash = 0;
  for (let index = 0; index < sourceId.length; index += 1) {
    hash = ((hash << 5) - hash) + sourceId.charCodeAt(index);
    hash |= 0;
  }
  return SOURCE_COLORS[Math.abs(hash) % SOURCE_COLORS.length] ?? SOURCE_COLORS[0];
};

const coerceCalendarViewMode = (value?: string | null): CalendarViewMode => (
  value === 'day' || value === 'week' || value === 'schedule' ? value : 'month'
);

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
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [viewMode, setViewModeState] = useState<CalendarViewMode>(() => coerceCalendarViewMode(settings?.calendar?.viewMode));
  const [scheduleQuery, setScheduleQuery] = useState('');
  const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [isExternalLoading, setIsExternalLoading] = useState(false);
  const timelineScrollRef = useRef<any>(null);
  const [pendingScrollMinutes, setPendingScrollMinutes] = useState<number | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [calendarComposer, setCalendarComposer] = useState<CalendarTaskComposerState | null>(null);

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const logCalendarError = (error: unknown) => {
    void logError(error, { scope: 'calendar' });
  };
  const setViewMode = (nextMode: CalendarViewMode) => {
    if ((nextMode === 'day' || nextMode === 'week') && !selectedDate) {
      const nextDate = new Date();
      setSelectedDate(nextDate);
      setCurrentMonth(nextDate.getMonth());
      setCurrentYear(nextDate.getFullYear());
    }
    setViewModeState(nextMode);
    updateSettings({ calendar: { viewMode: nextMode } }).catch(logCalendarError);
  };

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
  const weekAnchor = selectedDate ?? new Date(currentYear, currentMonth, 1);
  const weekStartDate = getWeekStart(weekAnchor, weekStartIndex);
  const weekStartTime = weekStartDate.getTime();
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStartDate);
    date.setDate(weekStartDate.getDate() + index);
    return date;
  });
  const weekLabel = `${weekDays[0].toLocaleDateString(locale, { month: 'short', day: 'numeric' })} - ${weekDays[6].toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`;

  const visibleTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById))
  ), [tasks, resolvedAreaFilter, projectById, areaById]);

  const schedulableTasks = useMemo(() => (
    visibleTasks
      .filter((task) => !task.deletedAt && task.status !== 'done' && task.status !== 'archived' && task.status !== 'reference')
      .sort((a, b) => a.title.localeCompare(b.title))
  ), [visibleTasks]);

  const getDeadlinesForDate = (date: Date): Task[] => (
    visibleTasks.filter((task) => {
      if (!task.dueDate) return false;
      const dueDate = safeParseDueDate(task.dueDate);
      return Boolean(dueDate && isSameDay(dueDate, date));
    })
  );

  const getScheduledForDate = (date: Date): Task[] => (
    visibleTasks.filter((task) => {
      if (!task.startTime) return false;
      const startTime = safeParseDate(task.startTime);
      return Boolean(startTime && isSameDay(startTime, date));
    })
  );

  const getTaskCountForDate = (date: Date) => {
    const ids = new Set<string>();
    for (const task of getDeadlinesForDate(date)) ids.add(task.id);
    for (const task of getScheduledForDate(date)) ids.add(task.id);
    return ids.size;
  };

  const getExternalEventsForDate = (date: Date) => {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
    return externalEvents.filter((event) => {
      const start = safeParseDate(event.start);
      const end = safeParseDate(event.end);
      if (!start || !end) return false;
      return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
    });
  };

  const getCalendarItemsForDate = (date: Date) => {
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
  };

  const timeEstimateToMinutes = (estimate: Task['timeEstimate']): number => (
    resolveTimeEstimateToMinutes(estimate, { enabled: timeEstimatesEnabled })
  );

  const findFreeSlotForDay = (day: Date, durationMinutes: number, excludeTaskId?: string): Date | null => (
    findCalendarFreeSlotForDay({
      day,
      dayEndHour: DAY_END_HOUR,
      dayStartHour: DAY_START_HOUR,
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

  useEffect(() => {
    let cancelled = false;
    setIsExternalLoading(true);
    setExternalError(null);

    const rangeStart = viewMode === 'week'
      ? new Date(weekStartDate)
      : viewMode === 'schedule'
        ? new Date(selectedDate ?? new Date(currentYear, currentMonth, 1))
        : new Date(currentYear, currentMonth, 1, 0, 0, 0, 0);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = viewMode === 'week'
      ? new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() + 6, 23, 59, 59, 999)
      : viewMode === 'schedule'
        ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 45, 23, 59, 59, 999)
        : new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);

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
  }, [currentYear, currentMonth, selectedDate, viewMode, weekStartTime]);

  const calendarNameById = useMemo(
    () => new Map(externalCalendars.map((calendar) => [calendar.id, calendar.name])),
    [externalCalendars],
  );

  const nextQuickScheduleCandidates = useMemo(() => {
    if (!selectedDate) return [];
    return schedulableTasks
      .filter((task) => task.status === 'next')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 6);
  }, [schedulableTasks, selectedDate]);

  const searchCandidates = useMemo(() => {
    if (!selectedDate) return [];
    const query = scheduleQuery.trim().toLowerCase();
    if (!query) return [];
    return schedulableTasks
      .filter((task) => task.title.toLowerCase().includes(query))
      .slice(0, 8);
  }, [schedulableTasks, scheduleQuery, selectedDate]);

  const calendarComposerCandidates = useMemo(() => {
    if (!calendarComposer || calendarComposer.mode !== 'existing') return [];
    const query = calendarComposer.query.trim().toLowerCase();
    return schedulableTasks
      .filter((task) => !query || task.title.toLowerCase().includes(query))
      .slice(0, 10);
  }, [calendarComposer, schedulableTasks]);

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
    fallback.setHours(DAY_START_HOUR, 0, 0, 0);
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
    const task = visibleTasks.find((item) => item.id === taskId);
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
    if (viewMode !== 'day') return;
    if (!selectedDate) return;
    if (pendingScrollMinutes == null) return;

    const y = Math.max(0, pendingScrollMinutes * PIXELS_PER_MINUTE - 120);
    requestAnimationFrame(() => {
      timelineScrollRef.current?.scrollTo({ y, animated: true });
      setPendingScrollMinutes(null);
    });
  }, [viewMode, selectedDate, pendingScrollMinutes]);

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
    if (viewMode === 'day') {
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
    [selectedDate, externalEvents],
  );
  const selectedDateDeadlines = useMemo(
    () => (selectedDate ? getDeadlinesForDate(selectedDate) : []),
    [selectedDate, visibleTasks],
  );
  const selectedDateScheduled = useMemo(
    () => (selectedDate ? getScheduledForDate(selectedDate) : []),
    [selectedDate, visibleTasks],
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
    const now = new Date();
    const minutes = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
    if (minutes < 0 || minutes > selectedDayMinutes) return null;
    return minutes * PIXELS_PER_MINUTE;
  }, [selectedDate, selectedDayMinutes]);
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
    const sections: Array<{ date: Date; id: string; items: ReturnType<typeof getCalendarItemsForDate> }> = [];
    for (let offset = 0; offset < 45; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset);
      const items = getCalendarItemsForDate(date);
      if (items.length === 0) continue;
      sections.push({ id: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`, date, items });
      if (sections.length >= 18) break;
    }
    return sections;
  }, [selectedDate, currentMonth, currentYear, visibleTasks, externalEvents]);

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
    isSameDay,
    isToday,
    locale,
    localize,
    markTaskDone,
    monthLabel,
    nextQuickScheduleCandidates,
    openQuickAddAtDateTime,
    openQuickAddForDate,
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
