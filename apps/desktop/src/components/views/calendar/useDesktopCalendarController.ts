import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    addDays,
    addMonths,
    addWeeks,
    eachDayOfInterval,
    endOfMonth,
    endOfWeek,
    format,
    getYear,
    isSameMonth,
    setMonth,
    setYear,
    startOfMonth,
    startOfWeek,
    subDays,
    subMonths,
    subWeeks,
} from 'date-fns';
import {
    CALENDAR_TIME_ESTIMATE_OPTIONS,
    findFreeSlotForDay as findCalendarFreeSlotForDay,
    isSlotFreeForDay as isCalendarSlotFreeForDay,
    isTaskInActiveProject,
    minutesToTimeEstimate,
    safeParseDate,
    safeParseDueDate,
    shallow,
    timeEstimateToMinutes as resolveTimeEstimateToMinutes,
    translateWithFallback,
    type ExternalCalendarEvent,
    type ExternalCalendarSubscription,
    type Task,
    useTaskStore,
} from '@mindwtr/core';

import { checkBudget } from '../../../config/performanceBudgets';
import { useLanguage } from '../../../contexts/language-context';
import { usePerformanceMonitor } from '../../../hooks/usePerformanceMonitor';
import { logError } from '../../../lib/app-log';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../../lib/area-filter';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../../lib/external-calendar-events';
import { fallbackHashString } from '../../../lib/sync-service-utils';
import { reportError } from '../../../lib/report-error';
import { getCalendarMonthNames, getCalendarWeekdayHeaders, resolveCalendarLocale } from '../calendar-locale';

export const DESKTOP_DAY_START_HOUR = 8;
export const DESKTOP_DAY_END_HOUR = 23;
export const DESKTOP_HOUR_HEIGHT = 56;
export const DESKTOP_GRID_SNAP_MINUTES = 15;

const HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY = 'mindwtr.calendar.hiddenExternalCalendars';

export type CalendarCellItem =
    | { id: string; kind: 'scheduled'; task: Task; start: Date | null; title: string }
    | { id: string; kind: 'deadline'; task: Task; start: Date | null; title: string }
    | { id: string; kind: 'event'; event: ExternalCalendarEvent; start: Date | null; title: string };

export type CalendarViewMode = 'day' | 'week' | 'month' | 'schedule';
export type CalendarTaskComposerMode = 'new' | 'existing';
export type CalendarTaskComposerState = {
    durationMinutes: number;
    endTimeValue: string;
    error: string | null;
    mode: CalendarTaskComposerMode;
    query: string;
    selectedTaskId: string | null;
    startDateValue: string;
    startTimeValue: string;
    title: string;
};

export type CalendarTimedItem =
    | { durationMinutes: number; end: Date; id: string; kind: 'task'; start: Date; task: Task; title: string }
    | { durationMinutes: number; end: Date; event: ExternalCalendarEvent; id: string; kind: 'event'; start: Date; title: string };

export const dayKey = (date: Date) => format(date, 'yyyy-MM-dd');

export const externalCalendarColor = (sourceId: string): string => {
    const hash = Number.parseInt(fallbackHashString(sourceId || 'calendar'), 16);
    const hue = (Number.isFinite(hash) ? hash : 0) % 360;
    return `hsl(${hue} 68% 48%)`;
};

export const formatDateInputValue = (date: Date): string => format(date, 'yyyy-MM-dd');
export const formatTimeInputValue = (date: Date): string => format(date, 'HH:mm');
export const addMinutesToDate = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60_000);

export const combineDateAndTime = (dateValue: string, timeValue: string): Date | null => {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
    if (!dateMatch || !timeMatch) return null;
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    const date = new Date(
        year,
        month - 1,
        day,
        hours,
        minutes,
        0,
        0,
    );
    if (Number.isNaN(date.getTime())) return null;
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return null;
    }
    return date;
};

export const normalizeDurationMinutes = (minutes: number): number => {
    const estimate = minutesToTimeEstimate(minutes);
    return CALENDAR_TIME_ESTIMATE_OPTIONS.find((option) => option.estimate === estimate)?.minutes
        ?? resolveTimeEstimateToMinutes(estimate);
};

export const formatDurationLabel = (minutes: number): string => {
    if (minutes < 60) return `${minutes}m`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
};

const parseCalendarDateParam = (value: string | null): Date | null => {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const next = new Date(year, month - 1, day);
    if (Number.isNaN(next.getTime())) return null;
    if (next.getFullYear() !== year || next.getMonth() !== month - 1 || next.getDate() !== day) {
        return null;
    }
    return next;
};

const parseCalendarViewMode = (value: string | null): CalendarViewMode => (
    value === 'day' || value === 'week' || value === 'schedule' ? value : 'month'
);

const getInitialCalendarState = (fallback: Date): { currentMonth: Date; selectedDate: Date | null; viewMode: CalendarViewMode } => {
    if (typeof window === 'undefined') {
        return { currentMonth: fallback, selectedDate: null, viewMode: 'month' };
    }
    const params = new URLSearchParams(window.location.search);
    const selectedDate = parseCalendarDateParam(params.get('calendarDate'));
    const monthDate = parseCalendarDateParam(`${params.get('calendarMonth') ?? ''}-01`);
    return {
        currentMonth: selectedDate ?? monthDate ?? fallback,
        selectedDate,
        viewMode: parseCalendarViewMode(params.get('calendarView')),
    };
};

const serializeHiddenExternalCalendarIds = (ids: Iterable<string>): string => (
    JSON.stringify([...ids].sort())
);

const readHiddenExternalCalendarIds = (): { serialized: string; value: Set<string> } => {
    if (typeof window === 'undefined') {
        return { serialized: '[]', value: new Set() };
    }

    try {
        const raw = window.localStorage.getItem(HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        const ids = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
        return { serialized: serializeHiddenExternalCalendarIds(ids), value: new Set(ids) };
    } catch {
        return { serialized: '[]', value: new Set() };
    }
};

const eventDayRangeForVisibleRange = (
    event: ExternalCalendarEvent,
    visibleRange: { end: Date; start: Date },
): { end: Date; start: Date } | null => {
    const start = safeParseDate(event.start);
    const end = safeParseDate(event.end);
    if (!start || !end) return null;

    const lastMoment = new Date(Math.max(start.getTime(), end.getTime() - 1));
    const eventStartDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const eventEndDay = new Date(lastMoment.getFullYear(), lastMoment.getMonth(), lastMoment.getDate());
    const visibleStartDay = new Date(visibleRange.start.getFullYear(), visibleRange.start.getMonth(), visibleRange.start.getDate());
    const visibleEndDay = new Date(visibleRange.end.getFullYear(), visibleRange.end.getMonth(), visibleRange.end.getDate());
    const clampedStart = new Date(Math.max(eventStartDay.getTime(), visibleStartDay.getTime()));
    const clampedEnd = new Date(Math.min(eventEndDay.getTime(), visibleEndDay.getTime()));

    if (clampedStart.getTime() > clampedEnd.getTime()) return null;
    return { start: clampedStart, end: clampedEnd };
};

export function useDesktopCalendarController() {
    const perf = usePerformanceMonitor('CalendarView');
    const { tasks, areas, addTask, updateTask, settings, getDerivedState } = useTaskStore(
        (state) => ({
            addTask: state.addTask,
            tasks: state.tasks,
            areas: state.areas,
            updateTask: state.updateTask,
            settings: state.settings,
            getDerivedState: state.getDerivedState,
        }),
        shallow
    );
    const { projectMap } = getDerivedState();
    const { t, language } = useLanguage();
    const resolveText = useCallback(
        (key: string, fallback: string) => {
            return translateWithFallback(t, key, fallback);
        },
        [t]
    );
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const weekStartsOn = settings?.weekStart === 'monday' ? 1 : 0;
    const calendarLocale = useMemo(
        () => resolveCalendarLocale({
            language,
            dateFormat: settings?.dateFormat,
            systemLocale: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : undefined,
        }),
        [language, settings?.dateFormat]
    );
    const [initialCalendarState] = useState(() => getInitialCalendarState(new Date()));
    const [currentMonth, setCurrentMonth] = useState(initialCalendarState.currentMonth);
    const [selectedDate, setSelectedDate] = useState<Date | null>(initialCalendarState.selectedDate);
    const [viewMode, setViewMode] = useState<CalendarViewMode>(initialCalendarState.viewMode);
    const [isMonthPickerOpen, setIsMonthPickerOpen] = useState(false);
    const [viewFilterQuery, setViewFilterQuery] = useState('');
    const [scheduleQuery, setScheduleQuery] = useState('');
    const [scheduleError, setScheduleError] = useState<string | null>(null);
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
    const hiddenExternalCalendarIdsStorageRef = useRef<string | null>(null);
    const [hiddenExternalCalendarIds, setHiddenExternalCalendarIds] = useState<Set<string>>(() => {
        const { serialized, value } = readHiddenExternalCalendarIds();
        hiddenExternalCalendarIdsStorageRef.current = serialized;
        return value;
    });
    const [externalError, setExternalError] = useState<string | null>(null);
    const [isExternalLoading, setIsExternalLoading] = useState(false);
    const [editingTimeTaskId, setEditingTimeTaskId] = useState<string | null>(null);
    const [editingTimeValue, setEditingTimeValue] = useState<string>('');
    const [taskComposer, setTaskComposer] = useState<CalendarTaskComposerState | null>(null);
    const calendarBodyRef = useRef<HTMLDivElement | null>(null);
    const normalizedViewFilterQuery = viewFilterQuery.trim().toLowerCase();

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('CalendarView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        url.searchParams.set('calendarMonth', format(currentMonth, 'yyyy-MM'));
        if (selectedDate) {
            url.searchParams.set('calendarDate', dayKey(selectedDate));
        } else {
            url.searchParams.delete('calendarDate');
        }
        url.searchParams.set('calendarView', viewMode);
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }, [currentMonth, selectedDate, viewMode]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const serialized = serializeHiddenExternalCalendarIds(hiddenExternalCalendarIds);
        if (hiddenExternalCalendarIdsStorageRef.current === serialized) return;
        hiddenExternalCalendarIdsStorageRef.current = serialized;
        window.localStorage.setItem(HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY, serialized);
    }, [hiddenExternalCalendarIds]);

    const calendarStart = startOfWeek(startOfMonth(currentMonth), { weekStartsOn });
    const calendarEnd = endOfWeek(endOfMonth(currentMonth), { weekStartsOn });
    const days = eachDayOfInterval({
        start: calendarStart,
        end: calendarEnd,
    });
    const visibleRange = useMemo(() => {
        if (viewMode === 'day') {
            return { start: currentMonth, end: currentMonth };
        }
        if (viewMode === 'week') {
            const start = startOfWeek(currentMonth, { weekStartsOn });
            return { start, end: addDays(start, 6) };
        }
        if (viewMode === 'schedule') {
            return { start: currentMonth, end: addDays(currentMonth, 60) };
        }
        return { start: startOfMonth(currentMonth), end: endOfMonth(currentMonth) };
    }, [currentMonth, viewMode, weekStartsOn]);
    const timelineDays = useMemo(
        () => viewMode === 'day'
            ? [currentMonth]
            : eachDayOfInterval({
                start: startOfWeek(currentMonth, { weekStartsOn }),
                end: addDays(startOfWeek(currentMonth, { weekStartsOn }), 6),
            }),
        [currentMonth, viewMode, weekStartsOn]
    );
    const scheduleDays = useMemo(
        () => eachDayOfInterval({ start: visibleRange.start, end: visibleRange.end }),
        [visibleRange]
    );

    const isSchedulableTask = useCallback((task: Task) => {
        if (task.deletedAt) return false;
        if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return false;
        if (!isTaskInActiveProject(task, projectMap)) return false;
        if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) return false;
        return true;
    }, [projectMap, resolvedAreaFilter, areaById]);

    const isCalendarTaskVisible = useCallback((task: Task) => {
        if (!isSchedulableTask(task)) return false;
        if (normalizedViewFilterQuery && !task.title.toLowerCase().includes(normalizedViewFilterQuery)) return false;
        return true;
    }, [isSchedulableTask, normalizedViewFilterQuery]);

    const calendarTaskData = useMemo(() => {
        const visibleTasks: Task[] = [];
        const deadlinesByDay = new Map<string, Task[]>();
        const scheduledByDay = new Map<string, Task[]>();
        for (const task of tasks) {
            if (!isCalendarTaskVisible(task)) continue;
            visibleTasks.push(task);
            if (task.dueDate) {
                const dueDate = safeParseDueDate(task.dueDate);
                if (dueDate) {
                    const dueKey = dayKey(dueDate);
                    const existingDue = deadlinesByDay.get(dueKey);
                    if (existingDue) existingDue.push(task);
                    else deadlinesByDay.set(dueKey, [task]);
                }
            }
            if (task.startTime) {
                const startTime = safeParseDate(task.startTime);
                if (startTime) {
                    const startKey = dayKey(startTime);
                    const existingStart = scheduledByDay.get(startKey);
                    if (existingStart) existingStart.push(task);
                    else scheduledByDay.set(startKey, [task]);
                }
            }
        }
        return { visibleTasks, deadlinesByDay, scheduledByDay };
    }, [tasks, isCalendarTaskVisible]);

    const schedulableTasks = useMemo(
        () => tasks
            .filter(isSchedulableTask)
            .sort((a, b) => a.title.localeCompare(b.title)),
        [tasks, isSchedulableTask]
    );

    const getDeadlinesForDay = (date: Date) => calendarTaskData.deadlinesByDay.get(dayKey(date)) ?? [];
    const getScheduledForDay = (date: Date) => calendarTaskData.scheduledByDay.get(dayKey(date)) ?? [];
    const [openTaskId, setOpenTaskId] = useState<string | null>(null);
    const openTask = openTaskId ? tasks.find((task) => task.id === openTaskId) ?? null : null;
    const openProject = openTask?.projectId ? projectMap.get(openTask.projectId) : undefined;
    const openTaskFromCalendar = useCallback((task: Task) => {
        setOpenTaskId(task.id);
    }, []);
    const markTaskDone = useCallback((taskId: string) => {
        updateTask(taskId, { status: 'done', isFocusedToday: false })
            .catch((error) => reportError('Failed to mark task done', error));
    }, [updateTask]);

    const calendarNameById = useMemo(() => new Map(externalCalendars.map((c) => [c.id, c.name])), [externalCalendars]);

    const visibleExternalEvents = useMemo(
        () => externalEvents.filter((event) => {
            if (hiddenExternalCalendarIds.has(event.sourceId)) return false;
            if (!normalizedViewFilterQuery) return true;
            const sourceName = calendarNameById.get(event.sourceId) ?? '';
            return event.title.toLowerCase().includes(normalizedViewFilterQuery)
                || sourceName.toLowerCase().includes(normalizedViewFilterQuery);
        }),
        [calendarNameById, externalEvents, hiddenExternalCalendarIds, normalizedViewFilterQuery]
    );

    const externalEventsByDay = useMemo(() => {
        const nextMap = new Map<string, ExternalCalendarEvent[]>();
        for (const event of visibleExternalEvents) {
            const dayRange = eventDayRangeForVisibleRange(event, visibleRange);
            if (!dayRange) continue;

            const cursor = new Date(dayRange.start);
            while (cursor.getTime() <= dayRange.end.getTime()) {
                const key = dayKey(cursor);
                const existing = nextMap.get(key);
                if (existing) existing.push(event);
                else nextMap.set(key, [event]);
                cursor.setDate(cursor.getDate() + 1);
            }
        }
        return nextMap;
    }, [visibleExternalEvents, visibleRange]);

    const visibleSearchMatchCount = useMemo(() => {
        if (!normalizedViewFilterQuery) return null;
        const rangeStart = new Date(visibleRange.start);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(visibleRange.end);
        rangeEnd.setHours(23, 59, 59, 999);
        const startMs = rangeStart.getTime();
        const endMs = rangeEnd.getTime();

        const taskIds = new Set<string>();
        for (const task of calendarTaskData.visibleTasks) {
            const dueDate = task.dueDate ? safeParseDueDate(task.dueDate) : null;
            const startTime = task.startTime ? safeParseDate(task.startTime) : null;
            if (dueDate && dueDate.getTime() >= startMs && dueDate.getTime() <= endMs) taskIds.add(task.id);
            if (startTime && startTime.getTime() >= startMs && startTime.getTime() <= endMs) taskIds.add(task.id);
        }

        const eventCount = visibleExternalEvents.filter((event) => {
            const start = safeParseDate(event.start);
            const end = safeParseDate(event.end);
            if (!start || !end) return false;
            return start.getTime() <= endMs && end.getTime() >= startMs;
        }).length;

        return taskIds.size + eventCount;
    }, [calendarTaskData.visibleTasks, normalizedViewFilterQuery, visibleExternalEvents, visibleRange]);

    const getExternalEventsForDay = useCallback(
        (date: Date) => externalEventsByDay.get(dayKey(date)) ?? [],
        [externalEventsByDay]
    );

    const timeEstimateToMinutes = (estimate: Task['timeEstimate']): number => (
        resolveTimeEstimateToMinutes(estimate, { enabled: timeEstimatesEnabled })
    );

    const getSchedulingTasks = () => schedulableTasks;

    const findFreeSlotForDay = (day: Date, durationMinutes: number, excludeTaskId?: string): Date | null => (
        findCalendarFreeSlotForDay({
            day,
            durationMinutes,
            events: getExternalEventsForDay(day),
            excludeTaskId,
            tasks: getSchedulingTasks(),
            timeEstimatesEnabled,
        })
    );

    const isSlotFreeForDay = (day: Date, startTime: Date, durationMinutes: number, excludeTaskId?: string): boolean => (
        isCalendarSlotFreeForDay({
            day,
            durationMinutes,
            events: getExternalEventsForDay(day),
            excludeTaskId,
            startTime,
            tasks: getSchedulingTasks(),
            timeEstimatesEnabled,
        })
    );

    useEffect(() => {
        setEditingTimeTaskId(null);
        setEditingTimeValue('');
    }, [selectedDate]);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setIsExternalLoading(true);
            setExternalError(null);
            try {
                const rangeStart = new Date(visibleRange.start);
                rangeStart.setHours(0, 0, 0, 0);
                const rangeEnd = new Date(visibleRange.end);
                rangeEnd.setHours(23, 59, 59, 999);
                const { calendars, events, warnings } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendars(calendars);
                setExternalEvents(events);
                setExternalError(summarizeExternalCalendarWarnings(warnings));
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error && error.message.trim()
                    ? error.message.trim()
                    : 'Failed to load external calendars.';
                void logError(error, { scope: 'calendar', step: 'loadExternalCalendars' });
                setExternalError(message);
                setExternalEvents([]);
            } finally {
                if (!cancelled) {
                    setIsExternalLoading(false);
                }
            }
        };

        load();

        return () => {
            cancelled = true;
        };
    }, [visibleRange]);

    const scheduleCandidates = useMemo(() => {
        if (!selectedDate) return [];
        const query = scheduleQuery.trim().toLowerCase();
        if (!query) return [];

        return schedulableTasks
            .filter((task) => task.title.toLowerCase().includes(query))
            .slice(0, 12);
    }, [schedulableTasks, scheduleQuery, selectedDate]);

    const taskComposerCandidates = useMemo(() => {
        if (!taskComposer || taskComposer.mode !== 'existing') return [];
        const query = taskComposer.query.trim().toLowerCase();
        return schedulableTasks
            .filter((task) => {
                if (!query) return true;
                return task.title.toLowerCase().includes(query);
            })
            .slice(0, 10);
    }, [schedulableTasks, taskComposer]);

    const selectedComposerTask = taskComposer?.selectedTaskId
        ? tasks.find((task) => task.id === taskComposer.selectedTaskId) ?? null
        : null;

    useEffect(() => {
        if (!selectedDate) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (taskComposer) return;
            const target = event.target as Node;
            if (!calendarBodyRef.current || calendarBodyRef.current.contains(target)) return;
            setSelectedDate(null);
            setScheduleQuery('');
            setScheduleError(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [selectedDate, taskComposer]);

    const openTaskComposerAt = (
        start: Date,
        options?: { durationMinutes?: number; mode?: CalendarTaskComposerMode; taskId?: string },
    ) => {
        const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) : null;
        const durationMinutes = normalizeDurationMinutes(
            options?.durationMinutes ?? (selectedTask ? timeEstimateToMinutes(selectedTask.timeEstimate) : 30)
        );
        setTaskComposer({
            durationMinutes,
            endTimeValue: formatTimeInputValue(addMinutesToDate(start, durationMinutes)),
            error: null,
            mode: options?.mode ?? 'new',
            query: selectedTask?.title ?? '',
            selectedTaskId: selectedTask?.id ?? null,
            startDateValue: formatDateInputValue(start),
            startTimeValue: formatTimeInputValue(start),
            title: '',
        });
    };

    const openTaskComposerForDate = (
        date: Date,
        options?: { mode?: CalendarTaskComposerMode; taskId?: string },
    ) => {
        const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) : null;
        const durationMinutes = normalizeDurationMinutes(selectedTask ? timeEstimateToMinutes(selectedTask.timeEstimate) : 30);
        const slot = findFreeSlotForDay(date, durationMinutes, selectedTask?.id);
        const fallback = new Date(date);
        fallback.setHours(DESKTOP_DAY_START_HOUR, 0, 0, 0);
        openTaskComposerAt(slot ?? fallback, {
            durationMinutes,
            mode: options?.mode,
            taskId: selectedTask?.id,
        });
    };

    const updateTaskComposerStart = (updates: Partial<Pick<CalendarTaskComposerState, 'startDateValue' | 'startTimeValue'>>) => {
        setTaskComposer((prev) => {
            if (!prev) return prev;
            const next = { ...prev, ...updates, error: null };
            const start = combineDateAndTime(next.startDateValue, next.startTimeValue);
            if (!start) return next;
            return {
                ...next,
                endTimeValue: formatTimeInputValue(addMinutesToDate(start, next.durationMinutes)),
            };
        });
    };

    const updateTaskComposerDuration = (durationMinutes: number) => {
        setTaskComposer((prev) => {
            if (!prev) return prev;
            const normalized = normalizeDurationMinutes(durationMinutes);
            const start = combineDateAndTime(prev.startDateValue, prev.startTimeValue);
            return {
                ...prev,
                durationMinutes: normalized,
                endTimeValue: start ? formatTimeInputValue(addMinutesToDate(start, normalized)) : prev.endTimeValue,
                error: null,
            };
        });
    };

    const updateTaskComposerEndTime = (endTimeValue: string) => {
        setTaskComposer((prev) => {
            if (!prev) return prev;
            const start = combineDateAndTime(prev.startDateValue, prev.startTimeValue);
            const end = combineDateAndTime(prev.startDateValue, endTimeValue);
            if (!start || !end || end <= start) {
                return { ...prev, endTimeValue, error: null };
            }
            const normalized = normalizeDurationMinutes((end.getTime() - start.getTime()) / 60_000);
            return {
                ...prev,
                durationMinutes: normalized,
                endTimeValue: formatTimeInputValue(addMinutesToDate(start, normalized)),
                error: null,
            };
        });
    };

    const setTaskComposerMode = (mode: CalendarTaskComposerMode) => {
        setTaskComposer((prev) => prev ? { ...prev, mode, error: null } : prev);
    };

    const saveTaskComposer = async () => {
        if (!taskComposer) return;
        const start = combineDateAndTime(taskComposer.startDateValue, taskComposer.startTimeValue);
        const end = combineDateAndTime(taskComposer.startDateValue, taskComposer.endTimeValue);
        if (!start || !end || end <= start) {
            setTaskComposer((prev) => prev ? { ...prev, error: resolveText('calendar.invalidTimeRange', 'Choose a valid start and end time.') } : prev);
            return;
        }

        const durationMinutes = normalizeDurationMinutes(taskComposer.durationMinutes);
        const selectedTaskId = taskComposer.mode === 'existing' ? taskComposer.selectedTaskId : null;
        if (taskComposer.mode === 'new' && !taskComposer.title.trim()) {
            setTaskComposer((prev) => prev ? { ...prev, error: resolveText('calendar.taskTitleRequired', 'Enter a task title.') } : prev);
            return;
        }
        if (taskComposer.mode === 'existing' && !selectedTaskId) {
            setTaskComposer((prev) => prev ? { ...prev, error: resolveText('calendar.taskRequired', 'Choose a task.') } : prev);
            return;
        }
        if (!isSlotFreeForDay(start, start, durationMinutes, selectedTaskId ?? undefined)) {
            setTaskComposer((prev) => prev ? { ...prev, error: t('calendar.overlapWarning') } : prev);
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
                const result = await addTask(taskComposer.title.trim(), { status: 'next', ...updates });
                if (!result.success) {
                    setTaskComposer((prev) => prev ? { ...prev, error: result.error ?? resolveText('calendar.saveFailed', 'Could not save the task.') } : prev);
                    return;
                }
            }
            setTaskComposer(null);
            setScheduleQuery('');
            setScheduleError(null);
            setSelectedDate(start);
            setCurrentMonth(start);
        } catch (error) {
            reportError('Failed to save calendar task', error);
            setTaskComposer((prev) => prev ? { ...prev, error: resolveText('calendar.saveFailed', 'Could not save the task.') } : prev);
        }
    };

    const scheduleTaskOnSelectedDate = (taskId: string) => {
        if (!selectedDate) return;
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return;

        const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
        const slot = findFreeSlotForDay(selectedDate, durationMinutes, taskId);
        if (!slot) {
            setScheduleError(t('calendar.noFreeTime'));
            return;
        }

        openTaskComposerAt(slot, { mode: 'existing', taskId });
        setScheduleError(null);
    };

    const beginEditScheduledTime = (taskId: string) => {
        if (!selectedDate) return;
        const task = tasks.find((t) => t.id === taskId);
        if (!task?.startTime) return;
        const start = safeParseDate(task.startTime);
        if (!start) return;
        setEditingTimeTaskId(taskId);
        setEditingTimeValue(format(start, 'HH:mm'));
    };

    const commitEditScheduledTime = async () => {
        if (!selectedDate) return;
        if (!editingTimeTaskId) return;
        const task = tasks.find((t) => t.id === editingTimeTaskId);
        if (!task) return;

        const [hh, mm] = editingTimeValue.split(':').map((v) => Number(v));
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;

        const nextStart = new Date(selectedDate);
        nextStart.setHours(hh, mm, 0, 0);

        const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
        const ok = isSlotFreeForDay(selectedDate, nextStart, durationMinutes, task.id);
        if (!ok) {
            setScheduleError(t('calendar.overlapWarning'));
            return;
        }

        await updateTask(task.id, { startTime: nextStart.toISOString() });
        setEditingTimeTaskId(null);
        setEditingTimeValue('');
        setScheduleError(null);
    };

    const openQuickAddForDate = (date: Date) => {
        openTaskComposerForDate(date, { mode: 'new' });
    };

    const openQuickAddForStart = (start: Date) => {
        openTaskComposerAt(start, { durationMinutes: 30, mode: 'new' });
    };

    const cancelEditScheduledTime = () => {
        setEditingTimeTaskId(null);
        setEditingTimeValue('');
    };
    const monthNames = useMemo(() => getCalendarMonthNames(calendarLocale), [calendarLocale]);
    const weekdayHeaders = useMemo(
        () => getCalendarWeekdayHeaders(calendarLocale, weekStartsOn as 0 | 1),
        [calendarLocale, weekStartsOn]
    );
    const currentYear = getYear(currentMonth);
    const currentMonthLabel = (() => {
        if (viewMode === 'day') return format(currentMonth, 'EEEE, MMMM d, yyyy');
        if (viewMode === 'week') {
            const start = startOfWeek(currentMonth, { weekStartsOn });
            const end = addDays(start, 6);
            return `${format(start, 'MMM d')} - ${format(end, 'MMM d, yyyy')}`;
        }
        if (viewMode === 'schedule') {
            return `${format(visibleRange.start, 'MMM d')} - ${format(visibleRange.end, 'MMM d, yyyy')}`;
        }
        return format(currentMonth, 'MMMM yyyy');
    })();
    const yearOptions = useMemo(
        () => Array.from({ length: 11 }, (_, index) => currentYear - 5 + index),
        [currentYear]
    );
    const resetSelectedDayState = () => {
        setScheduleQuery('');
        setScheduleError(null);
        setEditingTimeTaskId(null);
        setEditingTimeValue('');
    };
    const selectCalendarDate = (date: Date) => {
        setSelectedDate(date);
        if (!isSameMonth(date, currentMonth)) {
            setCurrentMonth(date);
        }
    };
    const handleMonthChange = (monthIndex: number) => {
        setSelectedDate(null);
        resetSelectedDayState();
        setCurrentMonth((prev) => setMonth(prev, monthIndex));
    };
    const handleYearChange = (yearValue: number) => {
        setSelectedDate(null);
        resetSelectedDayState();
        setCurrentMonth((prev) => setYear(prev, yearValue));
    };
    const handlePrevMonth = () => {
        setSelectedDate(null);
        resetSelectedDayState();
        setIsMonthPickerOpen(false);
        setCurrentMonth((prev) => {
            if (viewMode === 'day') return subDays(prev, 1);
            if (viewMode === 'week') return subWeeks(prev, 1);
            if (viewMode === 'schedule') return subWeeks(prev, 2);
            return subMonths(prev, 1);
        });
    };
    const handleNextMonth = () => {
        setSelectedDate(null);
        resetSelectedDayState();
        setIsMonthPickerOpen(false);
        setCurrentMonth((prev) => {
            if (viewMode === 'day') return addDays(prev, 1);
            if (viewMode === 'week') return addWeeks(prev, 1);
            if (viewMode === 'schedule') return addWeeks(prev, 2);
            return addMonths(prev, 1);
        });
    };
    const handleToday = () => {
        const nextToday = new Date();
        setCurrentMonth(nextToday);
        setSelectedDate(null);
        resetSelectedDayState();
        setIsMonthPickerOpen(false);
    };
    const handleViewModeChange = (nextMode: CalendarViewMode) => {
        setViewMode(nextMode);
        if (nextMode !== 'month' && selectedDate) {
            setCurrentMonth(selectedDate);
        }
        setIsMonthPickerOpen(false);
    };
    const toggleExternalCalendar = (calendarId: string) => {
        setHiddenExternalCalendarIds((prev) => {
            const next = new Set(prev);
            if (next.has(calendarId)) next.delete(calendarId);
            else next.add(calendarId);
            return next;
        });
    };
    const selectedExternalEvents = selectedDate ? getExternalEventsForDay(selectedDate) : [];
    const selectedAllDayEvents = selectedExternalEvents.filter((event) => event.allDay);
    const selectedTimedEvents = selectedExternalEvents.filter((event) => !event.allDay);
    const selectedDeadlines = selectedDate ? getDeadlinesForDay(selectedDate) : [];
    const selectedScheduled = selectedDate ? getScheduledForDay(selectedDate) : [];
    const selectedScheduledIds = new Set(selectedScheduled.map((task) => task.id));
    const selectedTaskRows = [
        ...selectedScheduled.map((task) => ({
            id: `scheduled-${task.id}`,
            kind: 'scheduled' as const,
            task,
            start: task.startTime ? safeParseDate(task.startTime) : null,
        })),
        ...selectedDeadlines
            .filter((task) => !selectedScheduledIds.has(task.id))
            .map((task) => ({
                id: `deadline-${task.id}`,
                kind: 'deadline' as const,
                task,
                start: task.dueDate ? safeParseDueDate(task.dueDate) : null,
            })),
    ].sort((a, b) => {
        const aTime = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return a.task.title.localeCompare(b.task.title);
    });
    const getCalendarItemsForDate = (date: Date): CalendarCellItem[] => {
        const scheduled = getScheduledForDay(date);
        const scheduledIds = new Set(scheduled.map((task) => task.id));
        const deadlineOnly = getDeadlinesForDay(date).filter((task) => !scheduledIds.has(task.id));
        return [
            ...scheduled.map((task) => ({
                id: `scheduled-${task.id}`,
                kind: 'scheduled' as const,
                task,
                start: task.startTime ? safeParseDate(task.startTime) : null,
                title: task.title,
            })),
            ...deadlineOnly.map((task) => ({
                id: `deadline-${task.id}`,
                kind: 'deadline' as const,
                task,
                start: task.dueDate ? safeParseDueDate(task.dueDate) : null,
                title: task.title,
            })),
            ...getExternalEventsForDay(date).map((event) => ({
                id: `event-${event.id}`,
                kind: 'event' as const,
                event,
                start: safeParseDate(event.start),
                title: event.title,
            })),
        ].sort((a, b) => {
            const aTime = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
            const bTime = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
            if (aTime !== bTime) return aTime - bTime;
            return a.title.localeCompare(b.title);
        });
    };
    const getAllDayItemsForDay = (date: Date) => {
        const scheduledIds = new Set(getScheduledForDay(date).map((task) => task.id));
        return [
            ...getDeadlinesForDay(date)
                .filter((task) => !scheduledIds.has(task.id))
                .map((task) => ({ id: `deadline-${task.id}`, kind: 'deadline' as const, task, title: task.title })),
            ...getExternalEventsForDay(date)
                .filter((event) => event.allDay)
                .map((event) => ({ id: `event-${event.id}`, kind: 'event' as const, event, title: event.title })),
        ];
    };
    const getTimedItemsForDay = (date: Date): CalendarTimedItem[] => {
        const dayStart = new Date(date);
        dayStart.setHours(DESKTOP_DAY_START_HOUR, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(DESKTOP_DAY_END_HOUR, 0, 0, 0);
        const items: CalendarTimedItem[] = [];

        for (const task of getScheduledForDay(date)) {
            const start = task.startTime ? safeParseDate(task.startTime) : null;
            if (!start) continue;
            const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
            items.push({
                durationMinutes,
                end: new Date(start.getTime() + durationMinutes * 60_000),
                id: `task-${task.id}`,
                kind: 'task',
                start,
                task,
                title: task.title,
            });
        }

        for (const event of getExternalEventsForDay(date)) {
            if (event.allDay) continue;
            const rawStart = safeParseDate(event.start);
            const rawEnd = safeParseDate(event.end);
            if (!rawStart || !rawEnd) continue;
            const start = new Date(Math.max(rawStart.getTime(), dayStart.getTime()));
            const end = new Date(Math.min(rawEnd.getTime(), dayEnd.getTime()));
            if (end <= start) continue;
            items.push({
                durationMinutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000)),
                end,
                event,
                id: `event-${event.id}`,
                kind: 'event',
                start,
                title: event.title,
            });
        }

        return items.sort((a, b) => {
            const startDelta = a.start.getTime() - b.start.getTime();
            if (startDelta !== 0) return startDelta;
            return b.durationMinutes - a.durationMinutes;
        });
    };
    const layoutTimedItems = (date: Date) => {
        const columnEnds: number[] = [];
        const positioned = getTimedItemsForDay(date).map((item) => {
            const startMs = item.start.getTime();
            const column = columnEnds.findIndex((endMs) => endMs <= startMs);
            const columnIndex = column >= 0 ? column : columnEnds.length;
            columnEnds[columnIndex] = item.end.getTime();
            return { ...item, columnIndex };
        });
        const columnCount = Math.max(1, columnEnds.length);
        return positioned.map((item) => ({
            ...item,
            columnCount,
            height: Math.max(24, item.durationMinutes / 60 * DESKTOP_HOUR_HEIGHT),
            leftPercent: item.columnIndex * (100 / columnCount),
            top: Math.max(0, ((item.start.getHours() - DESKTOP_DAY_START_HOUR) * 60 + item.start.getMinutes()) / 60 * DESKTOP_HOUR_HEIGHT),
            widthPercent: 100 / columnCount,
        }));
    };

    useEffect(() => {
        const handleCalendarShortcut = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            if (target instanceof HTMLElement) {
                const tag = target.tagName.toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return;
            }

            const consume = () => {
                event.preventDefault();
                event.stopPropagation();
            };

            switch (event.key) {
                case 't':
                    consume();
                    handleToday();
                    break;
                case 'd':
                    consume();
                    handleViewModeChange('day');
                    break;
                case 'w':
                    consume();
                    handleViewModeChange('week');
                    break;
                case 'm':
                    consume();
                    handleViewModeChange('month');
                    break;
                case 'a':
                    consume();
                    handleViewModeChange('schedule');
                    break;
                case 'ArrowLeft':
                    consume();
                    handlePrevMonth();
                    break;
                case 'ArrowRight':
                    consume();
                    handleNextMonth();
                    break;
                case 'n':
                    consume();
                    openQuickAddForDate(selectedDate ?? currentMonth);
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleCalendarShortcut, true);
        return () => window.removeEventListener('keydown', handleCalendarShortcut, true);
    }, [currentMonth, selectedDate, viewMode]);

    return {
        addMinutesToDate,
        beginEditScheduledTime,
        calendarBodyRef,
        calendarNameById,
        cancelEditScheduledTime,
        combineDateAndTime,
        commitEditScheduledTime,
        currentMonth,
        currentMonthLabel,
        currentYear,
        days,
        editingTimeTaskId,
        editingTimeValue,
        externalCalendars,
        externalError,
        externalCalendarColor,
        formatDurationLabel,
        formatTimeInputValue,
        getAllDayItemsForDay,
        getCalendarItemsForDate,
        getDeadlinesForDay,
        getExternalEventsForDay,
        getScheduledForDay,
        handleMonthChange,
        handleNextMonth,
        handlePrevMonth,
        handleToday,
        handleViewModeChange,
        handleYearChange,
        hiddenExternalCalendarIds,
        isExternalLoading,
        isMonthPickerOpen,
        layoutTimedItems,
        markTaskDone,
        monthNames,
        normalizeDurationMinutes,
        openProject,
        openQuickAddForDate,
        openQuickAddForStart,
        openTask,
        openTaskFromCalendar,
        resetSelectedDayState,
        resolveText,
        saveTaskComposer,
        scheduleCandidates,
        scheduleDays,
        scheduleError,
        scheduleQuery,
        scheduleTaskOnSelectedDate,
        selectCalendarDate,
        selectedAllDayEvents,
        selectedComposerTask,
        selectedDate,
        selectedExternalEvents,
        selectedTaskRows,
        selectedTimedEvents,
        setCurrentMonth,
        setEditingTimeValue,
        setIsMonthPickerOpen,
        setOpenTaskId,
        setScheduleError,
        setScheduleQuery,
        setSelectedDate,
        setTaskComposer,
        setTaskComposerMode,
        setViewFilterQuery,
        taskComposer,
        taskComposerCandidates,
        timeEstimateToMinutes,
        timelineDays,
        t,
        toggleExternalCalendar,
        updateTask,
        updateTaskComposerDuration,
        updateTaskComposerEndTime,
        updateTaskComposerStart,
        viewFilterQuery,
        viewMode,
        visibleSearchMatchCount,
        weekdayHeaders,
        yearOptions,
    };
}

export type DesktopCalendarController = ReturnType<typeof useDesktopCalendarController>;
