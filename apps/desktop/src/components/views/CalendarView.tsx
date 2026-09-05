import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { isSameDay, isToday } from 'date-fns';
import { CalendarClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Minus, Plus, Search } from 'lucide-react';
import {
    formatI18nTemplate,
    getCalendarDayOfMonth,
    getCalendarMonthIndex,
    getShortWeekdayLabels,
    getTaskCalendarOccurrenceDate,
    hasTimeComponent,
    isProjectedRecurringTask,
    orderCalendarDayItemsForLimitedSlots,
    isSameCalendarMonth,
    safeFormatDate,
    tFallback,
    type Task,
} from '@mindwtr/core';

import { ErrorBoundary } from '../ErrorBoundary';
import { cn } from '../../lib/utils';
import { reportError } from '../../lib/report-error';
import { showUndoToast } from '../../lib/undo-registry';
import {
    getCalendarTaskDragItemKind,
    getCalendarTaskDragTaskId,
    hasCalendarTaskDragData,
    setCalendarTaskDragData,
} from '../../lib/calendar-task-drag';
import { useTaskListScope } from './list/task-list-scope';
import { LIST_END_GAP, VIEW_FILTER_INPUT } from './list/list-toolbar';
import { collectCalendarKeyboardTasks } from './calendar/calendar-keyboard-tasks';
import { CalendarOpenTaskModal, CalendarTaskComposerModal } from './calendar/CalendarModals';
import { CalendarPlanningPanel } from './calendar/CalendarPlanningPanel';
import { CalendarSelectedDayPanel } from './calendar/CalendarSelectedDayPanel';
import { TaskQuickActionMenuHost } from '../Task/useTaskQuickActionMenuProps';
import {
    CALENDAR_TIMELINE_DAY_COUNT_MAX,
    CALENDAR_TIMELINE_DAY_COUNT_MIN,
    DESKTOP_DAY_END_HOUR,
    DESKTOP_DAY_START_HOUR,
    DESKTOP_GRID_SNAP_MINUTES,
    DESKTOP_HOUR_HEIGHT,
    dayKey,
    type CalendarCellItem,
    type CalendarViewMode,
} from './calendar/calendar-primitives';
import { useDesktopCalendarController } from './calendar/useDesktopCalendarController';

const PROJECTED_RECURRENCE_LABEL_DATE_FORMAT = 'MMM d';
const CALENDAR_PLANNING_PANEL_COLLAPSED_KEY = 'mindwtr.calendar.planningPanelCollapsed';

const readPlanningPanelCollapsedPreference = (): boolean => {
    if (typeof window === 'undefined') return true;
    try {
        const stored = window.localStorage.getItem(CALENDAR_PLANNING_PANEL_COLLAPSED_KEY);
        return stored === null ? true : stored === 'true';
    } catch {
        return true;
    }
};

function getProjectedRecurrenceDisplayLabel(task: Task, projectedLabel: string): string {
    const occurrenceDateLabel = safeFormatDate(
        getTaskCalendarOccurrenceDate(task),
        PROJECTED_RECURRENCE_LABEL_DATE_FORMAT
    );
    return occurrenceDateLabel ? `${projectedLabel} · ${occurrenceDateLabel}` : projectedLabel;
}

export function CalendarView() {
    const timelineScrollRef = useRef<HTMLDivElement | null>(null);
    const [timelineScrollbarWidth, setTimelineScrollbarWidth] = useState(0);
    const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
    const [isPlanningPanelCollapsed, setIsPlanningPanelCollapsed] = useState(readPlanningPanelCollapsedPreference);
    const controller = useDesktopCalendarController();
    const {
        calendarBodyRef,
        calendarSystem,
        createTaskFromExternalEvent,
        currentMonth,
        currentMonthLabel,
        currentYear,
        days,
        externalCalendars,
        externalError,
        getExternalCalendarColor,
        getTaskAccentColor,
        getAllDayItemsForDay,
        getCalendarItemsForDate,
        handleMonthChange,
        handleNextMonth,
        handlePrevMonth,
        handleToday,
        handleViewModeChange,
        handleYearChange,
        hiddenExternalCalendarIds,
        isMonthPickerOpen,
        layoutTimedItems,
        locale,
        monthNames,
        openDayViewForDate,
        openQuickAddForStart,
        openTaskFromCalendar,
        resolveText,
        scheduleDays,
        selectCalendarDate,
        selectedDate,
        setTimelineDayCount,
        timelineDayCount,
        timelineDays,
        t,
        showCompleted,
        toggleShowCompleted,
        showScheduled,
        toggleShowScheduled,
        toggleExternalCalendar,
        toggleMonthPicker,
        updateViewFilterQuery,
        updateTask,
        updateTaskDateFromDrop,
        updateTaskStartTimeFromDrop,
        viewFilterQuery,
        viewMode,
        visibleSearchMatchCount,
        weekdayHeaders,
        yearOptions,
    } = controller;
    // One registration covers the whole view: the grid, the planning panel and
    // the selected-day panel all render inside it, so document order already
    // flattens them in the order the user sees.
    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        getTasks: collectCalendarKeyboardTasks,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
    });
    const handleCalendarTaskDragStart = useCallback((event: DragEvent<HTMLElement>, task: Task, itemKind: CalendarCellItem['kind']) => {
        if (itemKind === 'event') return;
        // A completed task is a record of what happened, not a plan that can be
        // moved to another day (#955).
        if (itemKind === 'completed') return;
        if (isProjectedRecurringTask(task)) return;
        event.stopPropagation();
        setCalendarTaskDragData(event.dataTransfer, task.id, {
            itemKind,
            variant: 'calendar-block',
        });
    }, []);
    const handleCalendarTaskDragOver = useCallback((event: DragEvent<HTMLElement>) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);
    const handleDropOnDueDate = useCallback((event: DragEvent<HTMLElement>, date: Date) => {
        const taskId = getCalendarTaskDragTaskId(event.dataTransfer);
        if (!taskId) return;
        const itemKind = getCalendarTaskDragItemKind(event.dataTransfer);
        event.preventDefault();
        event.stopPropagation();
        void updateTaskDateFromDrop(taskId, date, itemKind);
    }, [updateTaskDateFromDrop]);
    const handleOpenDayKeyDown = useCallback((event: KeyboardEvent<HTMLElement>, date: Date) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openDayViewForDate(date);
    }, [openDayViewForDate]);
    const handleDropOnTimelineSlot = useCallback((event: DragEvent<HTMLElement>, date: Date) => {
        const taskId = getCalendarTaskDragTaskId(event.dataTransfer);
        if (!taskId) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const rawMinutes = ((event.clientY - rect.top) / DESKTOP_HOUR_HEIGHT) * 60;
        const snapped = Math.round(rawMinutes / DESKTOP_GRID_SNAP_MINUTES) * DESKTOP_GRID_SNAP_MINUTES;
        const maxMinutes = (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60 - DESKTOP_GRID_SNAP_MINUTES;
        const clamped = Math.max(0, Math.min(maxMinutes, snapped));
        const start = new Date(date);
        start.setHours(DESKTOP_DAY_START_HOUR, clamped, 0, 0);

        event.preventDefault();
        event.stopPropagation();
        void updateTaskStartTimeFromDrop(taskId, start);
    }, [updateTaskStartTimeFromDrop]);
    // Right-clicking a scheduled block or a due-date chip opens the same
    // TaskQuickActionMenu the row list uses (via the shared hook), plus a
    // calendar-only "Remove from calendar" entry. Native HTML5 drag only ever
    // engages the primary mouse button, so a right-click context menu and an
    // in-progress drag cannot occur on the same gesture.
    const [taskQuickActionMenu, setTaskQuickActionMenu] = useState<{
        task: Task;
        x: number;
        y: number;
        kind: 'scheduled' | 'deadline';
    } | null>(null);
    const handleCalendarTaskContextMenu = useCallback((
        event: ReactMouseEvent<HTMLElement>,
        task: Task,
        kind: 'scheduled' | 'deadline',
    ) => {
        if (isProjectedRecurringTask(task)) return;
        event.preventDefault();
        event.stopPropagation();
        setTaskQuickActionMenu({ task, x: event.clientX, y: event.clientY, kind });
    }, []);
    const closeTaskQuickActionMenu = useCallback(() => setTaskQuickActionMenu(null), []);
    // The context menu names no task, so the chip it acts on keeps a ring while
    // the menu is open (#999). Foreground-based so it reads on solid-primary blocks.
    const taskMenuRingClass = (taskId: string) => (
        taskQuickActionMenu?.task.id === taskId ? 'ring-2 ring-inset ring-foreground/60' : undefined
    );
    const handleRemoveTaskFromCalendar = useCallback((task: Task, kind: 'scheduled' | 'deadline') => {
        // Clearing startTime alone does nothing visible: applyTaskUpdates
        // recomputes it from dueDate whenever relativeStartOffset is set, so
        // both fields are cleared (and both restored on undo).
        const previousValues = kind === 'scheduled'
            ? { startTime: task.startTime, relativeStartOffset: task.relativeStartOffset }
            : { dueDate: task.dueDate, relativeStartOffset: task.relativeStartOffset };
        const clearedUpdates = kind === 'scheduled'
            ? { startTime: undefined, relativeStartOffset: undefined }
            : { dueDate: undefined };
        void updateTask(task.id, clearedUpdates)
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to remove task from calendar');
                }
                // Reuses the existing "Remove from calendar" string for the toast
                // too — the locale-parity gate (zh/zh-Hant full parity, pt floor)
                // does not allow adding an English-only key here.
                showUndoToast(tFallback(t, 'calendar.unschedule', 'Remove from calendar'), () => {
                    void updateTask(task.id, previousValues)
                        .catch((error) => reportError('Failed to undo remove from calendar', error));
                }, t);
            })
            .catch((error) => reportError('Failed to remove task from calendar', error));
    }, [t, updateTask]);
    const timelineScrollKey = viewMode === 'day' || viewMode === 'week'
        ? `${viewMode}:${timelineDays.map(dayKey).join('|')}`
        : '';
    const handlePlanningPanelCollapsedChange = useCallback((collapsed: boolean) => {
        setIsPlanningPanelCollapsed(collapsed);
        try {
            window.localStorage.setItem(CALENDAR_PLANNING_PANEL_COLLAPSED_KEY, collapsed ? 'true' : 'false');
        } catch {
            // Ignore storage failures; the in-memory state still updates.
        }
    }, []);
    const periodNavigationLabels = viewMode === 'day'
        ? {
            previous: resolveText('calendar.prevDay', 'Previous day'),
            next: resolveText('calendar.nextDay', 'Next day'),
        }
        : viewMode === 'week'
            ? {
                previous: resolveText('calendar.prevWeek', 'Previous week'),
                next: resolveText('calendar.nextWeek', 'Next week'),
            }
            : {
                previous: resolveText('calendar.prevMonth', 'Previous month'),
                next: resolveText('calendar.nextMonth', 'Next month'),
            };

    useLayoutEffect(() => {
        const scroller = timelineScrollRef.current;
        if (!timelineScrollKey || !scroller) return;
        // WebKit does not reliably mirror scrollbar-gutter on non-scrolling rows.
        setTimelineScrollbarWidth(Math.max(0, scroller.offsetWidth - scroller.clientWidth));
    }, [timelineScrollKey]);

    useLayoutEffect(() => {
        const scroller = timelineScrollRef.current;
        const main = scroller?.closest('main');
        if (!timelineScrollKey || !scroller || !main) return;
        // Size the hour grid to the space the window actually leaves it instead
        // of guessing the surrounding chrome with a constant: every chrome
        // change (the #955 search row, the #977 end gap) silently broke the
        // `100vh - 20rem` budget and put a second scrollbar on the view.
        const measure = () => {
            const top = scroller.getBoundingClientRect().top
                - main.getBoundingClientRect().top
                + main.scrollTop;
            // 26rem floor keeps ~6.5 hours visible in short windows while still
            // fitting 768px-tall laptops. No ceiling: a tall monitor shows more
            // hours of a class timetable instead of stopping at 48rem with the
            // rest of the window empty. Reserve LIST_END_GAP (1rem) plus the
            // card's bottom border and sub-pixel rounding below the scroller.
            setTimelineHeight(Math.max(416, Math.floor(main.clientHeight - top - 18)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(main);
        // The card around the scroller re-measures when the all-day row grows.
        if (scroller.parentElement) observer.observe(scroller.parentElement);
        return () => observer.disconnect();
    }, [timelineScrollKey, externalError, externalCalendars.length, visibleSearchMatchCount]);

    useEffect(() => {
        if (!timelineScrollKey) return;
        const now = new Date();
        const minutes = (now.getHours() - DESKTOP_DAY_START_HOUR) * 60 + now.getMinutes();
        const clampedMinutes = Math.max(0, Math.min((DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60, minutes));
        const scrollTop = Math.max(0, (clampedMinutes / 60) * DESKTOP_HOUR_HEIGHT - 220);
        const frame = window.requestAnimationFrame(() => {
            timelineScrollRef.current?.scrollTo({ top: scrollTop });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [timelineScrollKey]);

    return (
        <ErrorBoundary>
            <div className={cn("space-y-6", LIST_END_GAP)} data-list-end>
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                    <h2 className="text-3xl font-bold tracking-tight">{t('nav.calendar')}</h2>
                    <p className="text-sm text-muted-foreground">
                        {resolveText('calendar.tasksAndEvents', 'Tasks and external events by date')}
                    </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <button
                        type="button"
                        onClick={handleToday}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
                        {resolveText('calendar.today', 'Today')}
                    </button>
                    <div className="grid w-full grid-cols-2 rounded-md border border-border bg-card p-1 sm:inline-flex sm:w-auto">
                        {([
                            ['day', resolveText('calendar.day', 'Day')],
                            ['week', resolveText('calendar.week', 'Week')],
                            ['month', resolveText('calendar.month', 'Month')],
                            ['schedule', resolveText('calendar.schedule', 'Schedule')],
                        ] as Array<[CalendarViewMode, string]>).map(([mode, label]) => (
                            <button
                                key={mode}
                                type="button"
                                onClick={() => handleViewModeChange(mode)}
                                className={cn(
                                    "h-7 rounded px-2.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                                    viewMode === mode
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {/* Only the week timeline splits its width across days, so the
                        count is meaningless in Day (always one), Month and Schedule. */}
                    {viewMode === 'week' && (
                        <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
                            <button
                                type="button"
                                onClick={() => setTimelineDayCount(timelineDayCount - 1)}
                                disabled={timelineDayCount <= CALENDAR_TIMELINE_DAY_COUNT_MIN}
                                className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:pointer-events-none disabled:opacity-40"
                                aria-label={resolveText('calendar.mobile.showFewerDays', 'Show fewer days')}
                                title={resolveText('calendar.mobile.showFewerDays', 'Show fewer days')}
                            >
                                <Minus className="h-4 w-4" aria-hidden="true" />
                            </button>
                            <span className="min-w-[4.5rem] text-center text-sm font-medium tabular-nums" aria-live="polite">
                                {formatI18nTemplate(
                                    // Same string mobile shows for the same setting — one
                                    // translation, one meaning, on both platforms (#951).
                                    resolveText('calendar.mobile.visibleDayCount', '{{dayCount}} days'),
                                    { dayCount: timelineDayCount }
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => setTimelineDayCount(timelineDayCount + 1)}
                                disabled={timelineDayCount >= CALENDAR_TIMELINE_DAY_COUNT_MAX}
                                className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:pointer-events-none disabled:opacity-40"
                                aria-label={resolveText('calendar.mobile.showMoreDays', 'Show more days')}
                                title={resolveText('calendar.mobile.showMoreDays', 'Show more days')}
                            >
                                <Plus className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                    )}
                    <div className="flex w-full items-center gap-1 rounded-md border border-border bg-card p-1 sm:w-auto">
                        <button
                            type="button"
                            onClick={handlePrevMonth}
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                            aria-label={periodNavigationLabels.previous}
                            title={periodNavigationLabels.previous}
                        >
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <div className="relative min-w-0 flex-1 sm:flex-none">
                            <button
                                type="button"
                                onClick={toggleMonthPicker}
                                className="h-8 w-full min-w-0 rounded px-3 text-sm font-semibold hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40 sm:min-w-[11rem]"
                                aria-haspopup="dialog"
                                aria-expanded={isMonthPickerOpen}
                            >
                                {currentMonthLabel}
                            </button>
                            {isMonthPickerOpen && (
                                <div className="absolute right-0 top-10 z-20 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg">
                                    <div className="grid grid-cols-2 gap-2">
                                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                                            {resolveText('calendar.month', 'Month')}
                                            <select
                                                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                                                value={getCalendarMonthIndex(currentMonth, calendarSystem)}
                                                onChange={(event) => handleMonthChange(Number(event.target.value))}
                                                aria-label={resolveText('calendar.month', 'Month')}
                                            >
                                                {monthNames.map((label, index) => (
                                                    <option key={label} value={index}>{label}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                                            {resolveText('calendar.year', 'Year')}
                                            <select
                                                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                                                value={currentYear}
                                                onChange={(event) => handleYearChange(Number(event.target.value))}
                                                aria-label={resolveText('calendar.year', 'Year')}
                                            >
                                                {yearOptions.map((year) => (
                                                    <option key={year} value={year}>{year}</option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={handleNextMonth}
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                            aria-label={periodNavigationLabels.next}
                            title={periodNavigationLabels.next}
                        >
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            </header>
            <div className="mb-4 space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                        <input
                            type="text"
                            data-view-filter-input
                            placeholder={t('common.search')}
                            aria-label={t('common.search')}
                            value={viewFilterQuery}
                            onChange={(event) => updateViewFilterQuery(event.target.value)}
                            className={cn(VIEW_FILTER_INPUT, 'pl-9')}
                        />
                    </div>
                    <button
                        type="button"
                        onClick={toggleShowScheduled}
                        aria-pressed={showScheduled}
                        className={cn(
                            'inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                            showScheduled
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                        title={resolveText('calendar.showScheduledHint', 'Show tasks on their start date; turn off to read only deadlines')}
                    >
                        <CalendarClock className="h-4 w-4" aria-hidden="true" />
                        {resolveText('calendar.showScheduled', 'Starts')}
                    </button>
                    <button
                        type="button"
                        onClick={toggleShowCompleted}
                        aria-pressed={showCompleted}
                        className={cn(
                            'inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                            showCompleted
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                        title={resolveText('calendar.showCompletedHint', 'Show done and archived tasks on the day they were completed')}
                    >
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        {resolveText('calendar.showCompleted', 'Completed')}
                    </button>
                </div>
                {visibleSearchMatchCount !== null && (
                    <div className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                        {visibleSearchMatchCount > 0
                            ? resolveText('calendar.searchMatches', `${visibleSearchMatchCount} matches in this view`).replace('{count}', String(visibleSearchMatchCount))
                            : resolveText('calendar.noSearchMatches', 'No matching calendar items in this view')}
                    </div>
                )}
            </div>

            {externalError && (
                <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground">
                    {externalError}
                </div>
            )}

            {externalCalendars.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/70 px-3 py-2">
                    <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                        {resolveText('calendar.visibleCalendars', 'Calendars')}
                    </span>
                    {externalCalendars.map((calendar) => {
                        const hidden = hiddenExternalCalendarIds.has(calendar.id);
                        return (
                            <button
                                key={calendar.id}
                                type="button"
                                onClick={() => toggleExternalCalendar(calendar.id)}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                                    hidden
                                        ? "border-border bg-muted/40 text-muted-foreground"
                                        : "border-border bg-background text-foreground"
                                )}
                            >
                                <span
                                    className="h-2.5 w-2.5 rounded-full"
                                    style={{ backgroundColor: hidden ? 'hsl(var(--muted-foreground))' : getExternalCalendarColor(calendar.id) }}
                                    aria-hidden="true"
                                />
                                {calendar.name}
                            </button>
                        );
                    })}
                </div>
            )}

            <div
                ref={calendarBodyRef}
                className={cn(
                    "grid gap-6",
                    isPlanningPanelCollapsed
                        ? "xl:grid-cols-[minmax(0,1fr)_3.5rem]"
                        : "xl:grid-cols-[minmax(0,1fr)_20rem]"
                )}
            >
                <div className="min-w-0 space-y-6">
                {viewMode === 'month' && (
                <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden shadow-sm">
                    {weekdayHeaders.map((day) => (
                        <div key={day} className="bg-card p-1 text-center text-xs font-medium text-muted-foreground sm:p-2 sm:text-sm">
                            {day}
                        </div>
                    ))}

                    {days.map((day, _dayIdx) => {
                        const cellItems = getCalendarItemsForDate(day);
                        // One-off items claim the cell's three visible rows
                        // before projected recurring occurrences, which repeat
                        // on every matching day.
                        const visibleItems = orderCalendarDayItemsForLimitedSlots(cellItems).slice(0, 3);
                        const overflowCount = Math.max(0, cellItems.length - visibleItems.length);
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
                                    "group relative min-h-24 cursor-pointer bg-card p-1 transition-colors hover:bg-accent/50 sm:min-h-[128px] sm:p-2",
                                    !isSameCalendarMonth(day, currentMonth, calendarSystem) && "bg-muted/50 text-muted-foreground",
                                    isSelected && "ring-2 ring-primary"
                                )}
                                data-calendar-drop-date={dayKey(day)}
                                role="button"
                                tabIndex={0}
                                aria-label={`${day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}, ${resolveText('calendar.openDayView', 'Open day view')}`}
                                onClick={() => openDayViewForDate(day)}
                                onKeyDown={(event) => handleOpenDayKeyDown(event, day)}
                                onDragOver={handleCalendarTaskDragOver}
                                onDrop={(event) => handleDropOnDueDate(event, day)}
                                title={resolveText('calendar.openDayView', 'Open day view')}
                            >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <div className="flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium sm:h-6 sm:w-6 sm:text-sm" style={todayMarkerStyle}>
                                            <span className="tabular-nums leading-none">
                                                {getCalendarDayOfMonth(day, calendarSystem)}
                                            </span>
                                        </div>
                                        {isToday(day) && (
                                            <span className="hidden rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-bold uppercase tracking-normal text-primary sm:inline">
                                                {resolveText('calendar.today', 'Today')}
                                            </span>
                                        )}
                                    </div>
                                    {isSelected && <div className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
                                </div>

                                <div className="space-y-1">
                                    {visibleItems.map((item) => {
                                        const isAllDayScheduled = item.kind === 'scheduled' && !hasTimeComponent(item.task.startTime);
                                        const timeLabel = isAllDayScheduled
                                            ? t('calendar.allDay')
                                            : item.start && (item.kind === 'scheduled' || item.kind === 'completed' || (item.kind === 'event' && !item.event.allDay))
                                            ? safeFormatDate(item.start, 'p')
                                            : item.kind === 'event' && item.event.allDay
                                                ? t('calendar.allDay')
                                                : '';

                                        if (item.kind === 'event') {
                                            const content = (
                                                <>
                                                    {timeLabel && <span className="mr-1 text-[10px] opacity-75">{timeLabel}</span>}
                                                    <span>{item.title}</span>
                                                </>
                                            );
                                            return (
                                                <div
                                                    key={item.id}
                                                    className="truncate rounded border-l-[3px] bg-muted/70 px-1.5 py-1 text-xs text-muted-foreground"
                                                    style={{ borderLeftColor: getExternalCalendarColor(item.event.sourceId) }}
                                                    title={item.title}
                                                >
                                                    {content}
                                                </div>
                                            );
                                        }

                                        const task = item.task;
                                        const completed = item.kind === 'completed';
                                        const projected = isProjectedRecurringTask(task);
                                        const projectedLabel = projected
                                            ? getProjectedRecurrenceDisplayLabel(task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                            : '';
                                        const content = (
                                            <>
                                                {timeLabel && <span className="mr-1 text-[10px] opacity-75">{timeLabel}</span>}
                                                <span className={cn(completed && 'line-through')}>{item.title}</span>
                                                {projected && <span className="ml-1 text-[10px] opacity-75">{projectedLabel}</span>}
                                            </>
                                        );
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                data-task-id={task.id}
                                                {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                draggable={!projected && !completed}
                                                disabled={projected}
                                                className={cn(
                                                    "block w-full truncate rounded px-1.5 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                    projected
                                                        ? "border border-dashed border-primary/50 bg-primary/5 text-primary/80"
                                                        : completed
                                                        ? "bg-muted/60 text-muted-foreground"
                                                        : item.kind === 'scheduled'
                                                        ? "bg-primary/10 text-primary"
                                                        : "border-l-[3px] border-muted-foreground/60 bg-background/60 text-foreground",
                                                    taskMenuRingClass(task.id)
                                                )}
                                                style={!projected && !completed && item.kind !== 'scheduled'
                                                    ? { borderLeftColor: getTaskAccentColor(task) }
                                                    : undefined}
                                                title={projected ? `${task.title} (${projectedLabel})` : task.title}
                                                onDragStart={(event) => handleCalendarTaskDragStart(event, task, item.kind)}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (projected) return;
                                                    openTaskFromCalendar(task);
                                                }}
                                                onContextMenu={(event) => {
                                                    if (projected || completed) return;
                                                    handleCalendarTaskContextMenu(event, task, item.kind);
                                                }}
                                            >
                                                {content}
                                            </button>
                                        );
                                    })}
                                    {overflowCount > 0 && (
                                        <button
                                            type="button"
                                            className="w-full rounded px-1.5 pt-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                openDayViewForDate(day);
                                            }}
                                            aria-label={`${resolveText('calendar.openDayView', 'Open day view')}: ${day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`}
                                        >
                                            +{overflowCount} {resolveText('calendar.more', 'more')}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                )}

                {(viewMode === 'day' || viewMode === 'week') && (
                    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                        <div
                            className="grid border-b border-border bg-muted/40"
                            style={{
                                gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))`,
                                paddingRight: timelineScrollbarWidth,
                            }}
                        >
                            <div className="border-r border-border p-2 text-xs font-medium text-muted-foreground">
                                {resolveText('calendar.time', 'Time')}
                            </div>
                            {timelineDays.map((day) => (
                                <button
                                    key={dayKey(day)}
                                    type="button"
                                    onClick={() => selectCalendarDate(day)}
                                    className={cn(
                                        "border-r border-border p-2 text-left last:border-r-0 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40",
                                        // With one visible day the tint marks nothing and just
                                        // makes the lone column look off; the date bubble
                                        // already says "today".
                                        timelineDays.length > 1 && isToday(day) && "bg-primary/5"
                                    )}
                                >
                                    <div className="text-xs font-medium text-muted-foreground">
                                        {getShortWeekdayLabels(locale)[day.getDay()]}
                                    </div>
                                    <div className={cn("mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-semibold", isToday(day) && "bg-primary text-primary-foreground")}>
                                        {getCalendarDayOfMonth(day, calendarSystem)}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <div
                            className="grid border-b border-border"
                            style={{
                                gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))`,
                                paddingRight: timelineScrollbarWidth,
                            }}
                        >
                            <div className="border-r border-border p-2 text-xs font-medium text-muted-foreground">
                                {t('calendar.allDay')}
                            </div>
                            {timelineDays.map((day) => {
                                const allDayItems = orderCalendarDayItemsForLimitedSlots(getAllDayItemsForDay(day)).slice(0, 4);
                                return (
                                    <div
                                        key={dayKey(day)}
                                        data-calendar-all-day-drop-date={dayKey(day)}
                                        className="min-h-12 space-y-1 border-r border-border p-2 last:border-r-0"
                                        onDragOver={handleCalendarTaskDragOver}
                                        onDrop={(event) => handleDropOnDueDate(event, day)}
                                    >
                                        {allDayItems.map((item) => {
                                            if (item.kind === 'event') {
                                                return (
                                                    <div
                                                        key={item.id}
                                                        className="truncate rounded border-l-[3px] bg-muted/60 px-2 py-1 text-xs text-muted-foreground"
                                                        style={{ borderLeftColor: getExternalCalendarColor(item.event.sourceId) }}
                                                        title={item.title}
                                                    >
                                                        {item.title}
                                                    </div>
                                                );
                                            }
                                            const completed = item.kind === 'completed';
                                            const projected = isProjectedRecurringTask(item.task);
                                            const projectedLabel = projected
                                                ? getProjectedRecurrenceDisplayLabel(item.task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                                : '';
                                            return (
                                                <button
                                                    key={item.id}
                                                    type="button"
                                                    data-task-id={item.task.id}
                                                    {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                    draggable={!projected && !completed}
                                                    disabled={projected}
                                                    onDragStart={(event) => handleCalendarTaskDragStart(event, item.task, item.kind)}
                                                    onClick={() => {
                                                        if (!projected) openTaskFromCalendar(item.task);
                                                    }}
                                                    onContextMenu={(event) => {
                                                        if (projected || completed) return;
                                                        handleCalendarTaskContextMenu(event, item.task, item.kind);
                                                    }}
                                                    className={cn(
                                                        "block w-full truncate rounded border-l-[3px] px-2 py-1 text-left text-xs hover:bg-muted",
                                                        projected
                                                            ? "border-primary/50 border-dashed bg-primary/5 text-primary/80"
                                                            : completed
                                                            ? "border-transparent bg-muted/60 text-muted-foreground line-through"
                                                            : item.kind === 'scheduled'
                                                            ? "border-primary/70 bg-primary/5"
                                                            : "border-muted-foreground/60 bg-background/70",
                                                        taskMenuRingClass(item.task.id)
                                                    )}
                                                    style={!projected && !completed && item.kind !== 'scheduled'
                                                        ? { borderLeftColor: getTaskAccentColor(item.task) }
                                                        : undefined}
                                                    title={projected ? `${item.title} (${projectedLabel})` : item.title}
                                                >
                                                    {projected ? `${item.title} · ${projectedLabel}` : item.title}
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>

                        <div
                            ref={timelineScrollRef}
                            className="overflow-y-auto"
                            style={{ height: timelineHeight ?? 'max(28rem, calc(100vh - 20rem))' }}
                        >
                            <div className="grid" style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}>
                                <div className="relative border-r border-border bg-muted/20" style={{ height: (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * DESKTOP_HOUR_HEIGHT }}>
                                    {Array.from({ length: DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR + 1 }, (_, index) => {
                                        const hour = DESKTOP_DAY_START_HOUR + index;
                                        return (
                                            <div key={hour} className="absolute right-2 -translate-y-2 text-[11px] text-muted-foreground first:translate-y-0" style={{ top: index * DESKTOP_HOUR_HEIGHT }}>
                                                {safeFormatDate(new Date(0, 0, 1, hour), 'p')}
                                            </div>
                                        );
                                    })}
                                </div>
                                {timelineDays.map((day) => {
                                    const now = new Date();
                                    const nowMinutes = (now.getHours() - DESKTOP_DAY_START_HOUR) * 60 + now.getMinutes();
                                    const nowTop = nowMinutes / 60 * DESKTOP_HOUR_HEIGHT;
                                    const showNow = isToday(day) && nowMinutes >= 0 && nowMinutes <= (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60;
                                    return (
                                        <div
                                            key={dayKey(day)}
                                            data-calendar-timed-drop-date={dayKey(day)}
                                            className={cn("relative border-r border-border last:border-r-0", timelineDays.length > 1 && isToday(day) && "bg-primary/5")}
                                            style={{ height: (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * DESKTOP_HOUR_HEIGHT }}
                                            onDragOver={handleCalendarTaskDragOver}
                                            onDrop={(event) => handleDropOnTimelineSlot(event, day)}
                                            onClick={(event) => {
                                                const rect = event.currentTarget.getBoundingClientRect();
                                                const rawMinutes = ((event.clientY - rect.top) / DESKTOP_HOUR_HEIGHT) * 60;
                                                const snapped = Math.round(rawMinutes / DESKTOP_GRID_SNAP_MINUTES) * DESKTOP_GRID_SNAP_MINUTES;
                                                const maxMinutes = (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60 - 30;
                                                const clamped = Math.max(0, Math.min(maxMinutes, snapped));
                                                const start = new Date(day);
                                                start.setHours(DESKTOP_DAY_START_HOUR, clamped, 0, 0);
                                                openQuickAddForStart(start);
                                            }}
                                        >
                                            {Array.from({ length: DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR + 1 }, (_, index) => (
                                                <div
                                                    key={index}
                                                    className="absolute left-0 right-0 border-t border-border/70"
                                                    style={{ top: index * DESKTOP_HOUR_HEIGHT }}
                                                />
                                            ))}
                                            {showNow && (
                                                <div className="absolute left-0 right-0 z-20 flex items-center" style={{ top: nowTop }}>
                                                    <span className="h-2 w-2 -translate-x-1 rounded-full bg-destructive" />
                                                    <span className="h-0.5 flex-1 bg-destructive" />
                                                </div>
                                            )}
                                            {layoutTimedItems(day).map((item) => {
                                                const timeLabel = `${safeFormatDate(item.start, 'p')}-${safeFormatDate(item.end, 'p')}`;
                                                const commonStyle = {
                                                    // 2px seam so back-to-back blocks read as separate
                                                    // items instead of one slab (layout floors at 24px).
                                                    height: item.height - 2,
                                                    left: `calc(${item.leftPercent}% + 3px)`,
                                                    top: item.top,
                                                    width: `calc(${item.widthPercent}% - 6px)`,
                                                };
                                                if (item.kind === 'event') {
                                                    return (
                                                        <div
                                                            key={item.id}
                                                            data-calendar-block
                                                            className="absolute z-10 overflow-hidden rounded border-l-[4px] bg-muted/80 px-2 py-1 text-xs text-muted-foreground shadow-sm"
                                                            style={{ ...commonStyle, borderLeftColor: getExternalCalendarColor(item.event.sourceId) }}
                                                            title={`${item.title} ${timeLabel}`}
                                                            onClick={(event) => event.stopPropagation()}
                                                        >
                                                            <div className="truncate font-medium text-foreground">{item.title}</div>
                                                            <div className="truncate">{timeLabel}</div>
                                                        </div>
                                                    );
                                                }
                                                const projected = isProjectedRecurringTask(item.task);
                                                const projectedLabel = projected
                                                    ? getProjectedRecurrenceDisplayLabel(item.task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                                    : '';
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        data-calendar-block
                                                        data-task-id={item.task.id}
                                                        {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                        draggable={!projected}
                                                        disabled={projected}
                                                        className={cn(
                                                            "absolute z-10 overflow-hidden rounded px-2 py-1 text-left text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                            projected
                                                                ? "border border-dashed border-primary/50 bg-primary/10 text-primary"
                                                                : "bg-primary text-primary-foreground hover:bg-primary/90",
                                                            taskMenuRingClass(item.task.id)
                                                        )}
                                                        style={commonStyle}
                                                        title={projected ? `${item.title} ${timeLabel} (${projectedLabel})` : `${item.title} ${timeLabel}`}
                                                        onDragStart={(event) => handleCalendarTaskDragStart(event, item.task, 'scheduled')}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            if (projected) return;
                                                            openTaskFromCalendar(item.task);
                                                        }}
                                                        onContextMenu={(event) => {
                                                            if (projected) return;
                                                            handleCalendarTaskContextMenu(event, item.task, 'scheduled');
                                                        }}
                                                    >
                                                        <div className="truncate font-semibold">{item.title}</div>
                                                        <div className="truncate opacity-90">
                                                            {projected ? `${timeLabel} · ${projectedLabel}` : timeLabel}
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                {viewMode === 'schedule' && (
                    <div className="rounded-lg border border-border bg-card">
                        <div className="border-b border-border px-4 py-3">
                            <div className="text-sm font-semibold">{resolveText('calendar.schedule', 'Schedule')}</div>
                            <div className="text-xs text-muted-foreground">{currentMonthLabel}</div>
                        </div>
                        <div className="divide-y divide-border">
                            {scheduleDays.map((day) => {
                                const items = getCalendarItemsForDate(day);
                                if (items.length === 0) return null;
                                return (
                                    <section
                                        key={dayKey(day)}
                                        data-calendar-schedule-drop-date={dayKey(day)}
                                        className="grid gap-3 px-4 py-3 md:grid-cols-[9rem_minmax(0,1fr)]"
                                        onDragOver={handleCalendarTaskDragOver}
                                        onDrop={(event) => handleDropOnDueDate(event, day)}
                                    >
                                        <div>
                                            <div className={cn("text-sm font-semibold", isToday(day) && "text-primary")}>
                                                {day.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                                            </div>
                                            {isToday(day) && <div className="mt-1 text-xs font-medium text-primary">{resolveText('calendar.today', 'Today')}</div>}
                                        </div>
                                        <div className="space-y-1">
                                            {items.map((item) => {
                                                const isAllDayScheduled = item.kind === 'scheduled' && !hasTimeComponent(item.task.startTime);
                                                const timeLabel = isAllDayScheduled
                                                    ? t('calendar.allDay')
                                                    : item.start && (item.kind === 'scheduled' || item.kind === 'completed' || (item.kind === 'event' && !item.event.allDay))
                                                    ? safeFormatDate(item.start, 'p')
                                                    : item.kind === 'event' && item.event.allDay
                                                        ? t('calendar.allDay')
                                                        : t('calendar.deadline');
                                                if (item.kind === 'event') {
                                                    return (
                                                        <div
                                                            key={item.id}
                                                            className="flex items-center gap-3 rounded border-l-[3px] bg-muted/50 px-3 py-2 text-sm"
                                                            style={{ borderLeftColor: getExternalCalendarColor(item.event.sourceId) }}
                                                        >
                                                            <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                                            <button
                                                                type="button"
                                                                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/15 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                                                onClick={() => void createTaskFromExternalEvent(item.event)}
                                                                aria-label={`${resolveText('calendar.createTaskFromEvent', 'Create task')}: ${item.title}`}
                                                                title={resolveText('calendar.createTaskFromEvent', 'Create task')}
                                                            >
                                                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                                                {resolveText('calendar.createTaskFromEvent', 'Create task')}
                                                            </button>
                                                        </div>
                                                    );
                                                }
                                                const completed = item.kind === 'completed';
                                                const projected = isProjectedRecurringTask(item.task);
                                                const projectedLabel = projected
                                                    ? getProjectedRecurrenceDisplayLabel(item.task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                                    : '';
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        data-task-id={item.task.id}
                                                        {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                        draggable={!projected && !completed}
                                                        disabled={projected}
                                                        onDragStart={(event) => handleCalendarTaskDragStart(event, item.task, item.kind)}
                                                        onClick={() => {
                                                            if (!projected) openTaskFromCalendar(item.task);
                                                        }}
                                                        onContextMenu={(event) => {
                                                            if (projected || completed) return;
                                                            handleCalendarTaskContextMenu(event, item.task, item.kind);
                                                        }}
                                                        className={cn(
                                                            "flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                            projected
                                                                ? "border border-dashed border-primary/50 bg-primary/5 text-primary"
                                                                : completed
                                                                ? "bg-muted/50 text-muted-foreground"
                                                                : item.kind === 'scheduled' ? "bg-primary/10 text-primary" : "border-l-[3px] border-muted-foreground/60 bg-background",
                                                            taskMenuRingClass(item.task.id)
                                                        )}
                                                        style={!projected && !completed && item.kind !== 'scheduled'
                                                            ? { borderLeftColor: getTaskAccentColor(item.task) }
                                                            : undefined}
                                                    >
                                                        <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                                        <span className={cn('min-w-0 flex-1 truncate text-foreground', completed && 'text-muted-foreground line-through')}>{item.title}</span>
                                                        {projected && (
                                                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                                                {projectedLabel}
                                                            </span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </section>
                                );
                            })}
                        </div>
                    </div>
                )}

                <CalendarSelectedDayPanel controller={controller} />
                </div>
                <CalendarPlanningPanel
                    controller={controller}
                    isCollapsed={isPlanningPanelCollapsed}
                    onCollapsedChange={handlePlanningPanelCollapsedChange}
                />
        </div>
            <CalendarOpenTaskModal controller={controller} />
            <CalendarTaskComposerModal controller={controller} />
            {taskQuickActionMenu && (
                <TaskQuickActionMenuHost
                    task={taskQuickActionMenu.task}
                    x={taskQuickActionMenu.x}
                    y={taskQuickActionMenu.y}
                    onClose={closeTaskQuickActionMenu}
                    overrides={{
                        extraActions: [{
                            id: 'remove-from-calendar',
                            label: tFallback(t, 'calendar.unschedule', 'Remove from calendar'),
                            onSelect: () => handleRemoveTaskFromCalendar(taskQuickActionMenu.task, taskQuickActionMenu.kind),
                        }],
                    }}
                />
            )}
        </div>
        </ErrorBoundary>
    );
}
