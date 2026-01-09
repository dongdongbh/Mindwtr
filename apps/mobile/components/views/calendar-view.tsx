import { Alert, View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  safeParseDate,
  translateText,
  type ExternalCalendarEvent,
  type ExternalCalendarSubscription,
  type Task,
  useTaskStore,
} from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar';
import { GestureDetector, Gesture, ScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { TaskEditModal } from '@/components/task-edit-modal';

// Simple date utilities (avoiding date-fns dependency)
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
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

export function CalendarView() {
  const { tasks, updateTask, deleteTask } = useTaskStore();
  const { isDark } = useTheme();
  const tc = useThemeColors();
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
  const { t, language } = useLanguage();
  const localize = (enText: string, zhText?: string) =>
    language === 'zh' && zhText ? zhText : translateText(enText, language);
  const timeEstimatesEnabled = useTaskStore((state) => state.settings?.features?.timeEstimates === true);
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
  const timelineScrollRef = useRef<ScrollView | null>(null);
  const [pendingScrollMinutes, setPendingScrollMinutes] = useState<number | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // Theme colors
  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const localeMap: Record<typeof language, string> = {
    en: 'en-US',
    zh: 'zh-CN',
    es: 'es-ES',
    hi: 'hi-IN',
    ar: 'ar',
    de: 'de-DE',
    ru: 'ru-RU',
    ja: 'ja-JP',
    fr: 'fr-FR',
    pt: 'pt-PT',
    ko: 'ko-KR',
    it: 'it-IT',
    tr: 'tr-TR',
  };
  const locale = localeMap[language] ?? 'en-US';
  const monthLabel = new Date(currentYear, currentMonth, 1).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
  });
  const dayNames = Array.from({ length: 7 }, (_, i) => {
    const base = new Date(2021, 7, 1 + i); // Aug 1, 2021 is a Sunday
    return base.toLocaleDateString(locale, { weekday: 'short' });
  });

  const getDeadlinesForDate = (date: Date): Task[] => {
    return tasks.filter((task) => {
      if (!task.dueDate) return false;
      const dueDate = safeParseDate(task.dueDate);
      return dueDate && isSameDay(dueDate, date);
    });
  };

  const getScheduledForDate = (date: Date): Task[] => {
    return tasks.filter((task) => {
      if (!task.startTime) return false;
      const startTime = safeParseDate(task.startTime);
      return startTime && isSameDay(startTime, date);
    });
  };

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
      SNAP_MINUTES
    );

    type Interval = { start: number; end: number };
    const intervals: Interval[] = [];

    // External timed events.
    for (const event of getExternalEventsForDate(day)) {
      if (event.allDay) continue;
      const start = safeParseDate(event.start);
      const end = safeParseDate(event.end);
      if (!start || !end) continue;
      const s = Math.max(start.getTime(), dayStart.getTime());
      const e = Math.min(end.getTime(), dayEnd.getTime());
      if (e > s) intervals.push({ start: s, end: e });
    }

	    // Scheduled tasks (startTime + estimate).
	    for (const task of tasks) {
	      if (task.deletedAt) continue;
	      if (task.id === excludeTaskId) continue;
	      if (task.status === 'done') continue;
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

	    for (const task of tasks) {
	      if (task.deletedAt) continue;
	      if (task.id === excludeTaskId) continue;
	      if (task.status === 'done') continue;
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
        console.error(error);
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

  const calendarNameById = useMemo(() => {
    return new Map(externalCalendars.map((c) => [c.id, c.name]));
  }, [externalCalendars]);

  const nextQuickScheduleCandidates = useMemo(() => {
    if (!selectedDate) return [];
    return tasks
      .filter((task) => {
        if (task.deletedAt) return false;
        if (task.status !== 'next') return false;
        return true;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 6);
  }, [tasks, selectedDate]);

	  const searchCandidates = useMemo(() => {
	    if (!selectedDate) return [];
	    const query = scheduleQuery.trim().toLowerCase();
	    if (!query) return [];
	    return tasks
	      .filter((task) => {
	        if (task.deletedAt) return false;
	        if (task.status === 'done') return false;
	        if (task.status === 'next') return false;
	        return task.title.toLowerCase().includes(query);
	      })
	      .slice(0, 8);
	  }, [tasks, scheduleQuery, selectedDate]);

  const scheduleTaskOnSelectedDate = (taskId: string) => {
    if (!selectedDate) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    const slot = findFreeSlotForDay(selectedDate, durationMinutes, taskId);
    if (!slot) {
      Alert.alert(
        localize('No free time', '没有空闲时间'),
        localize('There is not enough free time on this day to schedule the task.', '这一天没有足够的空闲时间来安排该任务。')
      );
      return;
    }

    updateTask(taskId, { startTime: slot.toISOString() }).catch(console.error);
    setScheduleQuery('');
    setPendingScrollMinutes((slot.getHours() * 60 + slot.getMinutes()) - DAY_START_HOUR * 60);
    setViewMode('day');
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

  const formatHourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

  const formatTimeRange = (start: Date, durationMinutes: number) => {
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const startLabel = start.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const endLabel = end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return `${startLabel}-${endLabel}`;
  };

  const commitTaskDrag = (taskId: string, dayStartMs: number, startMinutes: number, durationMinutes: number) => {
    const day = new Date(dayStartMs);
    const nextStart = new Date(dayStartMs + startMinutes * 60 * 1000);
    const ok = isSlotFreeForDay(day, nextStart, durationMinutes, taskId);
    if (!ok) {
      Alert.alert(
        localize('Time conflict', '时间冲突'),
        localize('That time overlaps with an event. Please choose a free slot.', '该时间段与日程冲突，请选择空闲时间。')
      );
      return;
    }
    updateTask(taskId, { startTime: nextStart.toISOString() }).catch(console.error);
  };

  const setTimelineScrollEnabled = (enabled: boolean) => {
    const ref = timelineScrollRef.current as any;
    if (!ref?.setNativeProps) return;
    ref.setNativeProps({ scrollEnabled: enabled });
  };

  const openTaskActions = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
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
        onPress: () => updateTask(task.id, { startTime: undefined }).catch(console.error),
      });
    }

    buttons?.push(
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => deleteTask(task.id).catch(console.error),
      },
      { text: t('common.cancel'), style: 'cancel' },
    );

    Alert.alert(task.title, undefined, buttons, { cancelable: true });
  };

  function ScheduledTaskBlock({
    task,
    dayStartMs,
    top,
    height,
    durationMinutes,
  }: {
    task: Task;
    dayStartMs: number;
    top: number;
    height: number;
    durationMinutes: number;
  }) {
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const zIndex = useSharedValue(1);
    const taskId = task.id;

    const panGesture = Gesture.Pan()
      .activateAfterLongPress(140)
      .onStart(() => {
        scale.value = withSpring(1.02);
        zIndex.value = 50;
        runOnJS(setTimelineScrollEnabled)(false);
      })
      .onUpdate((event) => {
        translateY.value = event.translationY;
      })
      .onEnd((event) => {
        const dayMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
        const startMinutes = Math.round((top + event.translationY) / PIXELS_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES;
        const clampedMinutes = Math.max(0, Math.min(dayMinutes - durationMinutes, startMinutes));
        runOnJS(commitTaskDrag)(taskId, dayStartMs, clampedMinutes, durationMinutes);
        translateY.value = withSpring(0);
        scale.value = withSpring(1);
        zIndex.value = 1;
      })
      .onFinalize(() => {
        runOnJS(setTimelineScrollEnabled)(true);
      });

    const tapGesture = Gesture.Tap().onEnd(() => {
      runOnJS(openTaskActions)(taskId);
    });

    const composedGesture = Gesture.Race(panGesture, tapGesture);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ translateY: translateY.value }, { scale: scale.value }],
      zIndex: zIndex.value,
    }));

    const start = task.startTime ? safeParseDate(task.startTime) : null;
    const label = start ? formatTimeRange(start, durationMinutes) : '';

    const compact = height < 48;
    const showTime = height >= 44;

    return (
      <GestureDetector gesture={composedGesture}>
        <Animated.View
          style={[
            styles.taskBlock,
            {
              top,
              height,
              paddingVertical: compact ? 2 : 8,
              justifyContent: compact ? 'center' : undefined,
              backgroundColor: isDark ? toRgba(tc.tint, 0.85) : tc.tint,
              borderColor: toRgba(tc.tint, isDark ? 0.6 : 0.3),
            },
            animatedStyle,
          ]}
        >
          <Text style={[styles.taskBlockTitle, compact && styles.taskBlockTitleCompact]} numberOfLines={compact ? 1 : 2}>
            {task.title}
          </Text>
          {showTime && (
            <Text style={styles.taskBlockTime} numberOfLines={1}>
              {label}
            </Text>
          )}
        </Animated.View>
      </GestureDetector>
    );
  }

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

  // Build calendar grid
  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(day);
  }

  if (viewMode === 'day' && selectedDate) {
    const dayStart = new Date(selectedDate);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(selectedDate);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
    const dayMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
    const timelineHeight = dayMinutes * PIXELS_PER_MINUTE;

    const dayEvents = getExternalEventsForDate(selectedDate);
    const allDayEvents = dayEvents.filter((e) => e.allDay);
    const timedEvents = dayEvents.filter((e) => !e.allDay);
	    const scheduledTasks = getScheduledForDate(selectedDate).filter((task) => !task.deletedAt && task.status !== 'done');

    return (
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        <View style={[styles.dayModeHeader, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <Pressable onPress={() => setViewMode('month')} style={styles.dayModeBack}>
            <Text style={[styles.dayModeBackText, { color: tc.text }]}>
              ‹ {localize('Month', '月')}
            </Text>
          </Pressable>
          <Text style={[styles.dayModeTitle, { color: tc.text }]} numberOfLines={1}>
            {selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'long', day: 'numeric' })}
          </Text>
          <View style={styles.dayModeNav}>
            <Pressable onPress={() => shiftSelectedDate(-1)} style={styles.dayNavButton}>
              <Text style={[styles.dayNavText, { color: tc.text }]}>‹</Text>
            </Pressable>
            <Pressable onPress={() => shiftSelectedDate(1)} style={styles.dayNavButton}>
              <Text style={[styles.dayNavText, { color: tc.text }]}>›</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView
          ref={timelineScrollRef}
          style={styles.dayScroll}
          contentContainerStyle={styles.dayScrollContent}
        >
          {allDayEvents.length > 0 && (
            <View style={[styles.allDayCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>{t('calendar.allDay')}</Text>
              {allDayEvents.slice(0, 6).map((event) => (
                <Text key={event.id} style={[styles.allDayItem, { color: tc.text }]} numberOfLines={1}>
                  {event.title}
                </Text>
              ))}
            </View>
          )}

          <View style={[styles.timelineCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <View style={[styles.timelineArea, { height: timelineHeight }]}>
              {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, idx) => {
                const hour = DAY_START_HOUR + idx;
                const top = idx * 60 * PIXELS_PER_MINUTE;
                return (
                  <View key={hour} style={[styles.hourLine, { top }]}>
                    <Text style={[styles.hourLabel, { color: tc.secondaryText }]}>{formatHourLabel(hour)}</Text>
                    <View style={[styles.hourDivider, { backgroundColor: tc.border }]} />
                  </View>
                );
              })}

              {timedEvents.map((event) => {
                const start = safeParseDate(event.start);
                const end = safeParseDate(event.end);
                if (!start || !end) return null;
                const clampedStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
                const clampedEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
                const startMinutes = (clampedStart.getTime() - dayStart.getTime()) / 60_000;
                const endMinutes = (clampedEnd.getTime() - dayStart.getTime()) / 60_000;
                const top = Math.max(0, startMinutes) * PIXELS_PER_MINUTE;
                const height = Math.max(16, (endMinutes - startMinutes) * PIXELS_PER_MINUTE);
                const timeLabel = formatTimeRange(clampedStart, Math.max(1, Math.round(endMinutes - startMinutes)));
                return (
                  <View
                    key={event.id}
                    style={[
                      styles.eventBlock,
                      {
                        top,
                        height,
                        backgroundColor: toRgba(tc.secondaryText, isDark ? 0.35 : 0.18),
                        borderColor: toRgba(tc.border, isDark ? 0.35 : 0.28),
                      },
                    ]}
                  >
                    <Text style={[styles.eventBlockTitle, { color: tc.text }]} numberOfLines={1}>
                      {event.title}
                    </Text>
                    <Text style={[styles.eventBlockTime, { color: tc.secondaryText }]} numberOfLines={1}>
                      {timeLabel}
                    </Text>
                  </View>
                );
              })}

              {scheduledTasks.map((task) => {
                const start = task.startTime ? safeParseDate(task.startTime) : null;
                if (!start) return null;
                const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
                const clampedStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
                const clampedEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
                const startMinutes = (clampedStart.getTime() - dayStart.getTime()) / 60_000;
                const endMinutes = (clampedEnd.getTime() - dayStart.getTime()) / 60_000;
                const top = Math.max(0, startMinutes) * PIXELS_PER_MINUTE;
                const height = Math.max(24, (endMinutes - startMinutes) * PIXELS_PER_MINUTE);
                return (
                  <ScheduledTaskBlock
                    key={task.id}
                    task={task}
                    dayStartMs={dayStart.getTime()}
                    top={top}
                    height={height}
                    durationMinutes={durationMinutes}
                  />
                );
              })}
            </View>
          </View>

          <View style={[styles.dayScheduleCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            {nextQuickScheduleCandidates.length > 0 && (
              <View style={styles.scheduleResults}>
                <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>{t('nav.next')}</Text>
                {nextQuickScheduleCandidates.map((task) => (
                  (() => {
                    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                    const slot = findFreeSlotForDay(selectedDate, durationMinutes, task.id);
                    const slotLabel = slot ? formatTimeRange(slot, durationMinutes) : null;
                    return (
                  <Pressable
                    key={task.id}
                    style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                    onPress={() => scheduleTaskOnSelectedDate(task.id)}
                  >
                    <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                      {task.title}
                    </Text>
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
                    </Text>
                  </Pressable>
                    );
                  })()
                ))}
              </View>
            )}

            <View style={styles.addTaskForm}>
              <TextInput
                style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                value={scheduleQuery}
                onChangeText={setScheduleQuery}
                placeholder={t('calendar.schedulePlaceholder')}
                placeholderTextColor={tc.secondaryText}
              />
            </View>

	            {searchCandidates.length > 0 && (
	              <View style={styles.scheduleResults}>
                <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                  {t('calendar.scheduleResults')}
                </Text>
	                {searchCandidates.map((task) => (
                  (() => {
                    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                    const slot = findFreeSlotForDay(selectedDate, durationMinutes, task.id);
                    const slotLabel = slot ? formatTimeRange(slot, durationMinutes) : null;
                    return (
                  <Pressable
                    key={task.id}
                    style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                    onPress={() => scheduleTaskOnSelectedDate(task.id)}
                  >
                    <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                      {task.title}
                    </Text>
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
                    </Text>
                  </Pressable>
                    );
                  })()
                ))}
              </View>
            )}
          </View>
        </ScrollView>

        <TaskEditModal
          visible={Boolean(editingTask)}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={(taskId, updates) => updateTask(taskId, updates)}
          defaultTab="view"
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <Pressable onPress={handlePrevMonth} style={styles.navButton}>
          <Text style={[styles.navButtonText, { color: tc.text }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: tc.text }]}>
          {monthLabel}
        </Text>
        <Pressable onPress={handleNextMonth} style={styles.navButton}>
          <Text style={[styles.navButtonText, { color: tc.text }]}>›</Text>
        </Pressable>
      </View>

      <View style={styles.monthCalendar}>
        <View style={[styles.dayHeaders, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          {dayNames.map((day) => (
            <View key={day} style={styles.dayHeader}>
              <Text style={[styles.dayHeaderText, { color: tc.secondaryText }]}>{day}</Text>
            </View>
          ))}
        </View>

        <View style={[styles.calendarGrid, selectedDate && styles.calendarGridCompact]}>
          {calendarDays.map((day, index) => {
            if (day === null) {
              return <View key={`empty-${index}`} style={[styles.dayCell, selectedDate && styles.dayCellCompact]} />;
            }

            const date = new Date(currentYear, currentMonth, day);
            const taskCount = getTaskCountForDate(date);
            const eventCount = getExternalEventsForDate(date).length;
            const isSelected = selectedDate && isSameDay(date, selectedDate);
            const todayCellBg = toRgba(tc.tint, isDark ? 0.12 : 0.08);
            const selectedCellBg = toRgba(tc.tint, isDark ? 0.2 : 0.16);

            return (
              <Pressable
                key={day}
                style={[
                  styles.dayCell,
                  selectedDate && styles.dayCellCompact,
                  isToday(date) && { backgroundColor: todayCellBg },
                  isSelected && { backgroundColor: selectedCellBg },
                ]}
                onPress={() => setSelectedDate(date)}
              >
                <View
                  style={[
                    styles.dayNumber,
                    selectedDate && styles.dayNumberCompact,
                    isToday(date) && styles.todayNumber,
                    isToday(date) && { backgroundColor: tc.tint },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      selectedDate && styles.dayTextCompact,
                      { color: tc.text },
                      isToday(date) && styles.todayText,
                      isToday(date) && { color: tc.onTint },
                    ]}
                  >
                    {day}
                  </Text>
                </View>
                {(taskCount > 0 || eventCount > 0) && (
                  <View style={styles.indicatorRow}>
                    {taskCount > 0 && (
                      <View style={[styles.taskDot, { backgroundColor: tc.tint }]}>
                        <Text style={[styles.taskDotText, { color: tc.onTint }]}>{taskCount}</Text>
                      </View>
                    )}
                    {eventCount > 0 && (
                      <View style={[styles.eventDot, { backgroundColor: tc.secondaryText }]}>
                        <Text style={[styles.eventDotText, { color: tc.bg }]}>{eventCount}</Text>
                      </View>
                    )}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      {selectedDate && (
        <View style={[styles.monthDetailsPane, { backgroundColor: tc.cardBg, borderTopColor: tc.border }]}>
          <ScrollView contentContainerStyle={styles.monthDetailsContent} keyboardShouldPersistTaps="handled">
            <Text style={[styles.selectedDateTitle, { color: tc.text }]}>
              {selectedDate.toLocaleDateString(locale, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </Text>

            {nextQuickScheduleCandidates.length > 0 && (
              <View style={styles.scheduleResults}>
                <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>{t('nav.next')}</Text>
                {nextQuickScheduleCandidates.map((task) => (
                  (() => {
                    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                    const slot = findFreeSlotForDay(selectedDate, durationMinutes, task.id);
                    const slotLabel = slot ? formatTimeRange(slot, durationMinutes) : null;
                    return (
                      <Pressable
                        key={task.id}
                        style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                        onPress={() => scheduleTaskOnSelectedDate(task.id)}
                      >
                        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                          {task.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                          {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
                        </Text>
                      </Pressable>
                    );
                  })()
                ))}
              </View>
            )}

            <View style={styles.addTaskForm}>
              <TextInput
                style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                value={scheduleQuery}
                onChangeText={setScheduleQuery}
                placeholder={t('calendar.schedulePlaceholder')}
                placeholderTextColor={tc.secondaryText}
              />
            </View>

            <View style={styles.tasksList}>
              {searchCandidates.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {t('calendar.scheduleResults')}
                  </Text>
                  {searchCandidates.map((task) => (
                    (() => {
                      const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                      const slot = findFreeSlotForDay(selectedDate, durationMinutes, task.id);
                      const slotLabel = slot ? formatTimeRange(slot, durationMinutes) : null;
                      return (
                        <Pressable
                          key={task.id}
                          style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                          onPress={() => scheduleTaskOnSelectedDate(task.id)}
                        >
                          <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                            {task.title}
                          </Text>
                          <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                            {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
                          </Text>
                        </Pressable>
                      );
                    })()
                  ))}
                </View>
              )}

              {externalCalendars.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {t('calendar.events')}
                  </Text>
                  {isExternalLoading && (
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {localize('Loading…', '加载中…')}
                    </Text>
                  )}
                  {externalError && (
                    <Text style={[styles.taskItemTime, { color: tc.danger }]} numberOfLines={2}>
                      {externalError}
                    </Text>
                  )}
                  {getExternalEventsForDate(selectedDate).map((event) => (
                    <View key={event.id} style={[styles.taskItem, styles.eventItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.secondaryText }]}>
                      <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                        {event.title}
                        {calendarNameById.get(event.sourceId) ? ` (${calendarNameById.get(event.sourceId)})` : ''}
                      </Text>
                      <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                        {event.allDay ? t('calendar.allDay') : (() => {
                          const start = safeParseDate(event.start);
                          const end = safeParseDate(event.end);
                          if (!start || !end) return '';
                          return `${start.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}-${end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
                        })()}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {getDeadlinesForDate(selectedDate).map((task) => (
                <View key={task.id} style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}>
                  <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                  <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                    {t('calendar.deadline')}
                  </Text>
                </View>
              ))}

              {getScheduledForDate(selectedDate).map((task) => (
                <Pressable
                  key={task.id}
                  style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                  onPress={() => openTaskActions(task.id)}
                >
                  <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                  <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                    {(() => {
                      const start = safeParseDate(task.startTime);
                      if (!start) return '';
                      const durMs = timeEstimateToMinutes(task.timeEstimate) * 60 * 1000;
                      const end = new Date(start.getTime() + durMs);
                      const startLabel = start.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                      const endLabel = end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                      return `${startLabel}-${endLabel}`;
                    })()}
                  </Text>
                </Pressable>
              ))}

              {getDeadlinesForDate(selectedDate).length === 0
                && getScheduledForDate(selectedDate).length === 0
                && getExternalEventsForDate(selectedDate).length === 0 && (
                <Text style={[styles.noTasks, { color: tc.secondaryText }]}>{t('calendar.noTasks')}</Text>
              )}
            </View>
          </ScrollView>
        </View>
      )}

      <TaskEditModal
        visible={Boolean(editingTask)}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={(taskId, updates) => updateTask(taskId, updates)}
        defaultTab="view"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 2,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#111827',
  },
  navButton: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  navButtonText: {
    fontSize: 26,
    color: '#3B82F6',
    fontWeight: 'bold',
  },
  monthCalendar: {
    flexShrink: 0,
  },
  monthDetailsPane: {
    flexShrink: 0,
    maxHeight: 300,
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  monthDetailsContent: {
    padding: 16,
    paddingBottom: 24,
  },
  calendarScroll: {
    flex: 1,
  },
  dayHeaders: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  dayHeader: {
    flex: 1,
    alignItems: 'center',
  },
  dayHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 4,
    paddingTop: 0,
  },
  calendarGridCompact: {
    paddingHorizontal: 12,
  },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  dayCellCompact: {
    aspectRatio: 0.88,
    padding: 3,
  },
  todayCell: {
    backgroundColor: '#EFF6FF',
  },
  selectedCell: {
    backgroundColor: '#DBEAFE',
  },
  dayNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumberCompact: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  todayNumber: {
    backgroundColor: '#3B82F6',
  },
  dayText: {
    fontSize: 14,
    color: '#111827',
  },
  dayTextCompact: {
    fontSize: 13,
  },
  todayText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  taskDot: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 16,
    alignItems: 'center',
  },
  taskDotText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  indicatorRow: {
    marginTop: 2,
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventDot: {
    backgroundColor: '#6B7280',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 16,
    alignItems: 'center',
  },
  eventDotText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  selectedDateSection: {
    backgroundColor: '#FFFFFF',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  selectedDateTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  addTaskForm: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    backgroundColor: '#F9FAFB',
    color: '#111827',
  },
  tasksList: {
    gap: 8,
  },
  scheduleResults: {
    gap: 8,
    marginBottom: 12,
  },
  scheduleResultsTitle: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 2,
  },
  taskItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
  },
  eventItem: {
    borderLeftColor: '#6B7280',
  },
  taskItemTitle: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
  },
  taskItemTime: {
    fontSize: 12,
    color: '#6B7280',
    marginLeft: 8,
  },
  noTasks: {
    textAlign: 'center',
    color: '#9CA3AF',
    fontSize: 14,
    paddingVertical: 16,
  },
  dayModeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 10,
  },
  dayModeBack: {
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  dayModeBackText: {
    fontSize: 14,
    fontWeight: '700',
  },
  dayModeTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '800',
  },
  dayModeNav: {
    flexDirection: 'row',
    gap: 8,
  },
  dayNavButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dayNavText: {
    fontSize: 22,
    fontWeight: '800',
  },
  dayScroll: {
    flex: 1,
  },
  dayScrollContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 24,
  },
  allDayCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  allDayItem: {
    fontSize: 13,
    paddingVertical: 2,
  },
  timelineCard: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  timelineArea: {
    position: 'relative',
  },
  hourLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: 18,
    paddingRight: 12,
  },
  hourLabel: {
    width: 56,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
    paddingRight: 8,
  },
  hourDivider: {
    flex: 1,
    height: 1,
  },
  eventBlock: {
    position: 'absolute',
    left: 56,
    right: 12,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
  },
  eventBlockTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  eventBlockTime: {
    fontSize: 11,
    marginTop: 2,
  },
  taskBlock: {
    position: 'absolute',
    left: 56,
    right: 12,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
  },
  taskBlockTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  taskBlockTitleCompact: {
    fontSize: 12,
    lineHeight: 14,
  },
  taskBlockTime: {
    fontSize: 11,
    marginTop: 2,
    color: 'rgba(255,255,255,0.9)',
  },
  dayScheduleCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
});
