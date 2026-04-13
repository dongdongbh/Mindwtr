import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { addMonths, endOfMonth, endOfWeek, format, getMonth, getYear, isSameDay, isSameMonth, isToday, setMonth, setYear, startOfMonth, startOfWeek, subMonths, eachDayOfInterval } from 'date-fns';
import { shallow, safeFormatDate, safeParseDate, safeParseDueDate, type ExternalCalendarEvent, type ExternalCalendarSubscription, useTaskStore, type Task, isTaskInActiveProject } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { reportError } from '../../lib/report-error';
import { logError } from '../../lib/app-log';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { TaskItem } from '../TaskItem';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../lib/external-calendar-events';
import { getCalendarMonthNames, getCalendarWeekdayHeaders, resolveCalendarLocale } from './calendar-locale';

const dayKey = (date: Date) => format(date, 'yyyy-MM-dd');

export function CalendarView() {
    const perf = usePerformanceMonitor('CalendarView');
    const { tasks, areas, updateTask, deleteTask, settings, getDerivedState } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            areas: state.areas,
            updateTask: state.updateTask,
            deleteTask: state.deleteTask,
            settings: state.settings,
            getDerivedState: state.getDerivedState,
        }),
        shallow
    );
    const { projectMap } = getDerivedState();
    const { t, language } = useLanguage();
    const resolveText = useCallback(
        (key: string, fallback: string) => {
            const value = t(key);
            return value === key ? fallback : value;
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
    const today = new Date();
    const [currentMonth, setCurrentMonth] = useState(today);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [viewFilterQuery, setViewFilterQuery] = useState('');
    const [scheduleQuery, setScheduleQuery] = useState('');
    const [scheduleError, setScheduleError] = useState<string | null>(null);
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalError, setExternalError] = useState<string | null>(null);
    const [isExternalLoading, setIsExternalLoading] = useState(false);
    const [editingTimeTaskId, setEditingTimeTaskId] = useState<string | null>(null);
    const [editingTimeValue, setEditingTimeValue] = useState<string>('');
    const calendarBodyRef = useRef<HTMLDivElement | null>(null);
    const normalizedViewFilterQuery = viewFilterQuery.trim().toLowerCase();

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('CalendarView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const calendarStart = startOfWeek(startOfMonth(currentMonth), { weekStartsOn });
    const calendarEnd = endOfWeek(endOfMonth(currentMonth), { weekStartsOn });
    const days = eachDayOfInterval({
        start: calendarStart,
        end: calendarEnd,
    });

    const isCalendarTaskVisible = (task: Task) => {
        if (task.deletedAt) return false;
        if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return false;
        if (!isTaskInActiveProject(task, projectMap)) return false;
        if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) return false;
        if (normalizedViewFilterQuery && !task.title.toLowerCase().includes(normalizedViewFilterQuery)) return false;
        return true;
    };

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
    }, [tasks, projectMap, resolvedAreaFilter, areaById, normalizedViewFilterQuery]);

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

    const externalEventsByDay = useMemo(() => {
        const nextMap = new Map<string, ExternalCalendarEvent[]>();
        for (const event of externalEvents) {
            const start = safeParseDate(event.start);
            const end = safeParseDate(event.end);
            if (!start || !end) continue;

            const lastMoment = new Date(Math.max(start.getTime(), end.getTime() - 1));
            const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
            const lastDay = new Date(lastMoment.getFullYear(), lastMoment.getMonth(), lastMoment.getDate());

            while (cursor.getTime() <= lastDay.getTime()) {
                const key = dayKey(cursor);
                const existing = nextMap.get(key);
                if (existing) existing.push(event);
                else nextMap.set(key, [event]);
                cursor.setDate(cursor.getDate() + 1);
            }
        }
        return nextMap;
    }, [externalEvents]);

    const getExternalEventsForDay = useCallback(
        (date: Date) => externalEventsByDay.get(dayKey(date)) ?? [],
        [externalEventsByDay]
    );

    const timeEstimateToMinutes = (estimate: any): number => {
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
        dayStart.setHours(8, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 0, 0, 0);

        const isTodaySelected = isSameDay(day, new Date());
        const earliest = ceilToMinutes(new Date(Math.max(dayStart.getTime(), isTodaySelected ? Date.now() : dayStart.getTime())), 5);

        type Interval = { start: number; end: number };
        const intervals: Interval[] = [];

        for (const event of getExternalEventsForDay(day)) {
            if (event.allDay) continue;
            const start = safeParseDate(event.start);
            const end = safeParseDate(event.end);
            if (!start || !end) continue;
            const s = Math.max(start.getTime(), dayStart.getTime());
            const e = Math.min(end.getTime(), dayEnd.getTime());
            if (e > s) intervals.push({ start: s, end: e });
        }

        for (const task of tasks) {
            if (!isCalendarTaskVisible(task)) continue;
            if (task.id === excludeTaskId) continue;
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
        dayStart.setHours(8, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 0, 0, 0);

        const startMs = startTime.getTime();
        const endMs = startMs + durationMinutes * 60 * 1000;
        if (startMs < dayStart.getTime() || endMs > dayEnd.getTime()) return false;

        const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && aEnd > bStart;

        for (const event of getExternalEventsForDay(day)) {
            if (event.allDay) continue;
            const start = safeParseDate(event.start);
            const end = safeParseDate(event.end);
            if (!start || !end) continue;
            const s = Math.max(start.getTime(), dayStart.getTime());
            const e = Math.min(end.getTime(), dayEnd.getTime());
            if (e > s && overlaps(startMs, endMs, s, e)) return false;
        }

        for (const task of tasks) {
            if (!isCalendarTaskVisible(task)) continue;
            if (task.id === excludeTaskId) continue;
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

    const calendarNameById = useMemo(() => new Map(externalCalendars.map((c) => [c.id, c.name])), [externalCalendars]);

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
                const rangeStart = startOfMonth(currentMonth);
                const rangeEnd = endOfMonth(currentMonth);
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
    }, [currentMonth]);

    const scheduleCandidates = useMemo(() => {
        if (!selectedDate) return [];
        const query = scheduleQuery.trim().toLowerCase();
        if (!query) return [];

        return calendarTaskData.visibleTasks
            .filter((task) => {
                if (task.status !== 'next') return false;
                return task.title.toLowerCase().includes(query);
            })
            .slice(0, 12);
    }, [calendarTaskData.visibleTasks, scheduleQuery, selectedDate]);

    useEffect(() => {
        if (!selectedDate) return;
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!calendarBodyRef.current || calendarBodyRef.current.contains(target)) return;
            setSelectedDate(null);
            setScheduleQuery('');
            setScheduleError(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [selectedDate]);

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

        updateTask(taskId, { startTime: slot.toISOString() })
            .catch((error) => reportError('Failed to update scheduled time', error));
        setScheduleQuery('');
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
        const durationMinutes = 30;
        const slot = findFreeSlotForDay(date, durationMinutes);
        const fallback = new Date(date);
        fallback.setHours(9, 0, 0, 0);
        const start = slot ?? fallback;
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: {
                initialProps: { startTime: start.toISOString() },
            },
        }));
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
    const yearOptions = useMemo(
        () => Array.from({ length: 11 }, (_, index) => currentYear - 5 + index),
        [currentYear]
    );
    const handleMonthChange = (monthIndex: number) => {
        setSelectedDate(null);
        setScheduleQuery('');
        setScheduleError(null);
        setCurrentMonth((prev) => setMonth(prev, monthIndex));
    };
    const handleYearChange = (yearValue: number) => {
        setSelectedDate(null);
        setScheduleQuery('');
        setScheduleError(null);
        setCurrentMonth((prev) => setYear(prev, yearValue));
    };
    const handlePrevMonth = () => {
        setSelectedDate(null);
        setScheduleQuery('');
        setScheduleError(null);
        setCurrentMonth((prev) => subMonths(prev, 1));
    };
    const handleNextMonth = () => {
        setSelectedDate(null);
        setScheduleQuery('');
        setScheduleError(null);
        setCurrentMonth((prev) => addMonths(prev, 1));
    };
    const selectedExternalEvents = selectedDate ? getExternalEventsForDay(selectedDate) : [];

    return (
        <ErrorBoundary>
            <div className="space-y-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <h2 className="text-3xl font-bold tracking-tight">{t('nav.calendar')}</h2>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handlePrevMonth}
                        className="rounded border border-border bg-muted/50 p-2 text-muted-foreground hover:text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-label={resolveText('calendar.prevMonth', 'Previous month')}
                    >
                        ‹
                    </button>
                    <div className="flex items-center gap-2 rounded border border-border bg-card px-3 py-1">
                        <select
                            className="bg-transparent text-sm focus:outline-none"
                            value={getMonth(currentMonth)}
                            onChange={(event) => handleMonthChange(Number(event.target.value))}
                            aria-label={resolveText('calendar.month', 'Month')}
                        >
                            {monthNames.map((label, index) => (
                                <option key={label} value={index}>{label}</option>
                            ))}
                        </select>
                        <select
                            className="bg-transparent text-sm focus:outline-none"
                            value={currentYear}
                            onChange={(event) => handleYearChange(Number(event.target.value))}
                            aria-label={resolveText('calendar.year', 'Year')}
                        >
                            {yearOptions.map((year) => (
                                <option key={year} value={year}>{year}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        type="button"
                        onClick={handleNextMonth}
                        className="rounded border border-border bg-muted/50 p-2 text-muted-foreground hover:text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-label={resolveText('calendar.nextMonth', 'Next month')}
                    >
                        ›
                    </button>
                </div>
            </header>
            <div className="mb-4">
                <input
                    type="text"
                    data-view-filter-input
                    placeholder={t('common.search')}
                    value={viewFilterQuery}
                    onChange={(event) => setViewFilterQuery(event.target.value)}
                    className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
            </div>

            {externalError && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                    {externalError}
                </div>
            )}

            <div ref={calendarBodyRef} className="space-y-6">
                <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden shadow-sm">
                    {weekdayHeaders.map((day) => (
                        <div key={day} className="bg-card p-2 text-center text-sm font-medium text-muted-foreground">
                            {day}
                        </div>
                    ))}

                    {days.map((day, _dayIdx) => {
                        const deadlines = getDeadlinesForDay(day);
                        const scheduled = getScheduledForDay(day);
                        const taskCount = new Set([...deadlines, ...scheduled].map((t) => t.id)).size;
                        const eventCount = getExternalEventsForDay(day).length;
                        const isSelected = selectedDate && isSameDay(day, selectedDate);
                        const todayMarkerStyle = isToday(day)
                            ? {
                                backgroundColor: 'hsl(var(--primary))',
                                color: 'hsl(var(--primary-foreground))',
                            }
                            : undefined;

                        return (
                            <div
                                key={day.toString()}
                                className={cn(
                                    "group bg-card min-h-[120px] p-2 transition-colors hover:bg-accent/50 relative",
                                    !isSameMonth(day, currentMonth) && "bg-muted/50 text-muted-foreground",
                                    isToday(day) && "bg-accent/20",
                                    isSelected && "ring-2 ring-primary"
                                )}
                                onClick={() => setSelectedDate(day)}
                            >
                                <div className="flex justify-between items-start">
                                    <div className={cn(
                                        "text-sm font-medium w-6 h-6 flex items-center justify-center rounded-full mb-1",
                                    )} style={todayMarkerStyle}>
                                        <span className="tabular-nums leading-none">
                                            {format(day, 'd')}
                                        </span>
                                    </div>
                                    {(taskCount > 0 || eventCount > 0) && (
                                        <div className="flex items-center gap-1">
                                            {taskCount > 0 && (
                                                <div className="text-[10px] px-1.5 rounded bg-primary/10 text-primary border border-primary/20">
                                                    {taskCount}
                                                </div>
                                            )}
                                            {eventCount > 0 && (
                                                <div className="text-[10px] px-1.5 rounded bg-muted/60 text-muted-foreground border border-border">
                                                    {eventCount}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-1">
                                    {deadlines.map(task => (
                                        <div
                                            key={task.id}
                                            data-task-id={task.id}
                                            data-task-edit-trigger
                                            className="text-xs truncate px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                                            title={task.title}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openTaskFromCalendar(task);
                                            }}
                                        >
                                            {task.title}
                                        </div>
                                    ))}
                                    {scheduled.slice(0, 2).map(task => (
                                        <div
                                            key={task.id}
                                            data-task-id={task.id}
                                            data-task-edit-trigger
                                            className="text-xs truncate px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                            title={task.title}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openTaskFromCalendar(task);
                                            }}
                                        >
                                            {task.title}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {selectedDate && (
                    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                        <div className="flex items-baseline justify-between gap-4">
                            <div className="text-sm font-semibold">{format(selectedDate, 'PPPP')}</div>
                            <div className="flex items-center gap-3">
                                <button
                                    className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80"
                                    onClick={() => openQuickAddForDate(selectedDate)}
                                >
                                    {t('calendar.addTask')}
                                </button>
                                <button
                                    className="text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => {
                                        setSelectedDate(null);
                                        setScheduleQuery('');
                                        setScheduleError(null);
                                    }}
                                >
                                    {t('common.close')}
                                </button>
                            </div>
                        </div>

                    <div className="space-y-2">
                        <input
                            type="text"
                            value={scheduleQuery}
                            onChange={(e) => {
                                setScheduleQuery(e.target.value);
                                if (scheduleError) setScheduleError(null);
                            }}
                            placeholder={t('calendar.schedulePlaceholder')}
                            className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        {scheduleError && (
                            <div className="text-xs text-red-400">{scheduleError}</div>
                        )}

                        {scheduleCandidates.length > 0 && (
                            <div className="space-y-1">
                                <div className="text-xs text-muted-foreground">{t('calendar.scheduleResults')}</div>
                                <div className="flex flex-wrap gap-2">
                                    {scheduleCandidates.map((task) => (
                                        <button
                                            key={task.id}
                                            className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80"
                                            onClick={() => scheduleTaskOnSelectedDate(task.id)}
                                            title={task.title}
                                        >
                                            {task.title}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">{t('calendar.events')}</div>
                            <div className="space-y-1">
                                {isExternalLoading && (
                                    <div className="text-sm text-muted-foreground">Loading…</div>
                                )}
                                {selectedExternalEvents.map((event) => {
                                    const start = safeParseDate(event.start);
                                    const end = safeParseDate(event.end);
                                    const timeLabel = event.allDay
                                        ? t('calendar.allDay')
                                        : start && end
                                            ? `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`
                                            : '';
                                    const sourceLabel = calendarNameById.get(event.sourceId);
                                    return (
                                        <div key={event.id} className="text-sm truncate">
                                            <span className="text-muted-foreground mr-2">{timeLabel}</span>
                                            {event.title}
                                            {sourceLabel ? ` (${sourceLabel})` : ''}
                                        </div>
                                    );
                                })}
                                {!isExternalLoading && !externalError && selectedExternalEvents.length === 0 && (
                                    <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>
                                )}
                            </div>
                        </div>
                        <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">{t('calendar.deadline')}</div>
                            <div className="space-y-1">
                                {getDeadlinesForDay(selectedDate).map((task) => (
                                    <div key={task.id} className="flex items-center justify-between gap-2">
                                        <button
                                            type="button"
                                            data-task-id={task.id}
                                            data-task-edit-trigger
                                            onClick={() => openTaskFromCalendar(task)}
                                            className="min-w-0 flex-1 text-sm truncate text-left text-foreground hover:underline"
                                        >
                                            {task.title}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => markTaskDone(task.id)}
                                            className="text-xs px-2 py-1 rounded bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                                        >
                                            {t('status.done')}
                                        </button>
                                    </div>
                                ))}
                                {getDeadlinesForDay(selectedDate).length === 0 && (
                                    <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>
                                )}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">{t('review.startTime')}</div>
                            <div className="space-y-1">
                                {getScheduledForDay(selectedDate).map((task) => {
                                    const start = safeParseDate(task.startTime);
                                    if (!start) return null;
                                    const durMs = timeEstimateToMinutes(task.timeEstimate) * 60 * 1000;
                                    const end = new Date(start.getTime() + durMs);
                                    const label = `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`;
                                    return (
                                        <div key={task.id} className="flex items-center justify-between gap-3">
                                            <button
                                                type="button"
                                                data-task-id={task.id}
                                                data-task-edit-trigger
                                                onClick={() => openTaskFromCalendar(task)}
                                                className="min-w-0 text-sm truncate text-left text-foreground hover:underline"
                                            >
                                                <span className="text-muted-foreground mr-2">{label}</span>
                                                {task.title}
                                            </button>
                                            <div className="flex items-center gap-2">
                                                {editingTimeTaskId === task.id ? (
                                                    <>
                                                        <input
                                                            type="time"
                                                            value={editingTimeValue}
                                                            onChange={(e) => setEditingTimeValue(e.target.value)}
                                                            className="text-xs px-2 py-1 rounded border border-border bg-background"
                                                        />
                                                        <button
                                                            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground"
                                                            onClick={commitEditScheduledTime}
                                                        >
                                                            {t('common.save')}
                                                        </button>
                                                        <button
                                                            className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80"
                                                            onClick={cancelEditScheduledTime}
                                                        >
                                                            {t('common.cancel')}
                                                        </button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button
                                                            className="text-xs px-2 py-1 rounded bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                                                            onClick={() => markTaskDone(task.id)}
                                                        >
                                                            {t('status.done')}
                                                        </button>
                                                        <button
                                                            className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80"
                                                            onClick={() => beginEditScheduledTime(task.id)}
                                                        >
                                                            {t('common.edit')}
                                                        </button>
                                                        <button
                                                            className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80"
                                                            onClick={() => updateTask(task.id, { startTime: undefined })
                                                                .catch((error) => reportError('Failed to clear scheduled time', error))}
                                                            title={t('calendar.unschedule')}
                                                        >
                                                            {t('calendar.unschedule')}
                                                        </button>
                                                        <button
                                                            className="text-xs px-2 py-1 rounded bg-destructive text-destructive-foreground"
                                                            onClick={() => deleteTask(task.id)
                                                                .catch((error) => reportError('Failed to delete task', error))}
                                                        >
                                                            {t('common.delete')}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                                {getScheduledForDay(selectedDate).length === 0 && (
                                    <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {openTask && (
                <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
                    <div
                        className="absolute inset-0"
                        onClick={() => setOpenTaskId(null)}
                    />
                    <div className="relative w-full max-w-3xl bg-background border border-border rounded-xl shadow-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-semibold">{t('taskEdit.editTask') || 'Task'}</h3>
                            <button
                                type="button"
                                onClick={() => setOpenTaskId(null)}
                                className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
                            >
                                {t('common.close')}
                            </button>
                        </div>
                        <TaskItem
                            task={openTask}
                            project={openProject}
                            showQuickDone={false}
                            readOnly={false}
                            compactMetaEnabled={true}
                        />
                    </div>
                </div>
            )}
        </div>
        </div>
        </ErrorBoundary>
    );
}
