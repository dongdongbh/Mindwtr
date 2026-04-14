import { Alert } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeDateFormatSetting,
  resolveDateLocaleTag,
  safeFormatDate,
  safeParseDate,
  safeParseDueDate,
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
import { useQuickCapture } from '../../../contexts/quick-capture-context';

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number, weekStartIndex: number): number {
  const day = new Date(year, month, 1).getDay();
  return (day - weekStartIndex + 7) % 7;
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

export function useCalendarViewController() {
  const { tasks, projects, updateTask, deleteTask, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const { t, language } = useLanguage();
  const { openQuickCapture } = useQuickCapture();
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
  const [viewMode, setViewMode] = useState<'month' | 'day'>('month');
  const [scheduleQuery, setScheduleQuery] = useState('');
  const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [isExternalLoading, setIsExternalLoading] = useState(false);
  const timelineScrollRef = useRef<any>(null);
  const [pendingScrollMinutes, setPendingScrollMinutes] = useState<number | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const logCalendarError = (error: unknown) => {
    void logError(error, { scope: 'calendar' });
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

  const visibleTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById))
  ), [tasks, resolvedAreaFilter, projectById, areaById]);

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

  const timeEstimateToMinutes = (estimate: Task['timeEstimate']): number => {
    if (!timeEstimatesEnabled) return 30;
    switch (estimate) {
      case '5min': return 5;
      case '10min': return 10;
      case '15min': return 15;
      case '30min': return 30;
      case '1hr': return 60;
      case '2hr': return 120;
      case '3hr': return 180;
      case '4hr': return 240;
      case '4hr+': return 240;
      default: return 30;
    }
  };

  const ceilToMinutes = (date: Date, stepMinutes: number) => {
    const stepMs = stepMinutes * 60 * 1000;
    return new Date(Math.ceil(date.getTime() / stepMs) * stepMs);
  };

  const findFreeSlotForDay = (day: Date, durationMinutes: number, excludeTaskId?: string): Date | null => {
    const dayStart = new Date(day);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

    const isTodaySelected = isSameDay(day, new Date());
    const earliest = ceilToMinutes(
      new Date(Math.max(dayStart.getTime(), isTodaySelected ? Date.now() : dayStart.getTime())),
      SNAP_MINUTES,
    );

    type Interval = { end: number; start: number };
    const intervals: Interval[] = [];

    for (const event of getExternalEventsForDate(day)) {
      if (event.allDay) continue;
      const start = safeParseDate(event.start);
      const end = safeParseDate(event.end);
      if (!start || !end) continue;
      const s = Math.max(start.getTime(), dayStart.getTime());
      const e = Math.min(end.getTime(), dayEnd.getTime());
      if (e > s) intervals.push({ start: s, end: e });
    }

    for (const task of visibleTasks) {
      if (task.deletedAt) continue;
      if (task.id === excludeTaskId) continue;
      if (task.status === 'done' || task.status === 'reference') continue;
      const start = task.startTime ? safeParseDate(task.startTime) : null;
      if (!start) continue;
      if (!isSameDay(start, day)) continue;
      const durMs = timeEstimateToMinutes(task.timeEstimate) * 60 * 1000;
      const s = Math.max(start.getTime(), dayStart.getTime());
      const e = Math.min(start.getTime() + durMs, dayEnd.getTime());
      if (e > s) intervals.push({ start: s, end: e });
    }

    intervals.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end) merged.push({ ...interval });
      else last.end = Math.max(last.end, interval.end);
    }

    const durationMs = durationMinutes * 60 * 1000;
    let cursor = Math.max(earliest.getTime(), dayStart.getTime());

    for (const interval of merged) {
      if (cursor + durationMs <= interval.start) return new Date(cursor);
      if (cursor < interval.end) cursor = interval.end;
    }

    if (cursor + durationMs <= dayEnd.getTime()) return new Date(cursor);
    return null;
  };

  const isSlotFreeForDay = (day: Date, startTime: Date, durationMinutes: number, excludeTaskId?: string) => {
    const dayStart = new Date(day);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

    const startMs = startTime.getTime();
    const endMs = startMs + durationMinutes * 60 * 1000;
    if (startMs < dayStart.getTime() || endMs > dayEnd.getTime()) return false;

    const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && aEnd > bStart;

    for (const event of getExternalEventsForDate(day)) {
      if (event.allDay) continue;
      const start = safeParseDate(event.start);
      const end = safeParseDate(event.end);
      if (!start || !end) continue;
      const s = Math.max(start.getTime(), dayStart.getTime());
      const e = Math.min(end.getTime(), dayEnd.getTime());
      if (e > s && overlaps(startMs, endMs, s, e)) return false;
    }

    for (const task of visibleTasks) {
      if (task.deletedAt) continue;
      if (task.id === excludeTaskId) continue;
      if (task.status === 'done' || task.status === 'reference') continue;
      const start = task.startTime ? safeParseDate(task.startTime) : null;
      if (!start) continue;
      if (!isSameDay(start, day)) continue;
      const durMs = timeEstimateToMinutes(task.timeEstimate) * 60 * 1000;
      const s = Math.max(start.getTime(), dayStart.getTime());
      const e = Math.min(start.getTime() + durMs, dayEnd.getTime());
      if (e > s && overlaps(startMs, endMs, s, e)) return false;
    }

    return true;
  };

  useEffect(() => {
    let cancelled = false;
    setIsExternalLoading(true);
    setExternalError(null);

    const rangeStart = new Date(currentYear, currentMonth, 1, 0, 0, 0, 0);
    const rangeEnd = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);

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
  }, [currentYear, currentMonth]);

  const calendarNameById = useMemo(
    () => new Map(externalCalendars.map((calendar) => [calendar.id, calendar.name])),
    [externalCalendars],
  );

  const nextQuickScheduleCandidates = useMemo(() => {
    if (!selectedDate) return [];
    return visibleTasks
      .filter((task) => !task.deletedAt && task.status === 'next')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 6);
  }, [visibleTasks, selectedDate]);

  const searchCandidates = useMemo(() => {
    if (!selectedDate) return [];
    const query = scheduleQuery.trim().toLowerCase();
    if (!query) return [];
    return visibleTasks
      .filter((task) => {
        if (task.deletedAt) return false;
        if (task.status === 'done' || task.status === 'reference') return false;
        if (task.status === 'next') return false;
        return task.title.toLowerCase().includes(query);
      })
      .slice(0, 8);
  }, [visibleTasks, scheduleQuery, selectedDate]);

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

    updateTask(taskId, { startTime: slot.toISOString() }).catch(logCalendarError);
    setScheduleQuery('');
    setPendingScrollMinutes((slot.getHours() * 60 + slot.getMinutes()) - DAY_START_HOUR * 60);
    setViewMode('day');
  };

  const openQuickAddForDate = (date: Date) => {
    const durationMinutes = 30;
    const slot = findFreeSlotForDay(date, durationMinutes);
    const fallback = new Date(date);
    fallback.setHours(DAY_START_HOUR, 0, 0, 0);
    const start = slot ?? fallback;
    openQuickCapture({ initialProps: { startTime: start.toISOString() } });
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
  const selectedDateLongLabel = selectedDate
    ? selectedDate.toLocaleDateString(locale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '';
  const selectedDayModeLabel = selectedDate
    ? selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'long', day: 'numeric' })
    : '';

  const closeEditingTask = () => setEditingTask(null);
  const saveEditingTask = (taskId: string, updates: Partial<Task>) => updateTask(taskId, updates);

  return {
    DAY_END_HOUR,
    DAY_START_HOUR,
    PIXELS_PER_MINUTE,
    SNAP_MINUTES,
    calendarDays,
    calendarNameById,
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
    getExternalEventsForDate,
    getScheduleSlotLabel,
    getTaskCountForDate,
    handleNextMonth,
    handlePrevMonth,
    isDark,
    isExternalLoading,
    isSameDay,
    isToday,
    locale,
    localize,
    markTaskDone,
    monthLabel,
    nextQuickScheduleCandidates,
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
    selectedDayScheduledTasks,
    selectedDayStart,
    selectedDayEnd,
    setCurrentMonth,
    setCurrentYear,
    setEditingTask,
    setScheduleQuery,
    setSelectedDate,
    setTimelineScrollEnabled,
    setViewMode,
    shiftSelectedDate,
    showToast,
    t,
    tc,
    timeEstimateToMinutes,
    timelineHeight,
    timelineScrollRef,
    toRgba,
    updateTask,
    viewMode,
  };
}
