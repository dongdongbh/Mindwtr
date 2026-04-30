import { format, getMonth, isSameDay, isSameMonth, isToday } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { safeFormatDate } from '@mindwtr/core';

import { ErrorBoundary } from '../ErrorBoundary';
import { cn } from '../../lib/utils';
import { CalendarOpenTaskModal, CalendarTaskComposerModal } from './calendar/CalendarModals';
import { CalendarSelectedDayPanel } from './calendar/CalendarSelectedDayPanel';
import {
    DESKTOP_DAY_END_HOUR,
    DESKTOP_DAY_START_HOUR,
    DESKTOP_GRID_SNAP_MINUTES,
    DESKTOP_HOUR_HEIGHT,
    type CalendarViewMode,
    dayKey,
    useDesktopCalendarController,
} from './calendar/useDesktopCalendarController';

export function CalendarView() {
    const controller = useDesktopCalendarController();
    const {
        calendarBodyRef,
        currentMonth,
        currentMonthLabel,
        currentYear,
        days,
        externalCalendars,
        externalError,
        externalCalendarColor,
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
        monthNames,
        openQuickAddForStart,
        openTaskFromCalendar,
        resolveText,
        scheduleDays,
        selectCalendarDate,
        selectedDate,
        setIsMonthPickerOpen,
        setViewFilterQuery,
        timelineDays,
        t,
        toggleExternalCalendar,
        viewFilterQuery,
        viewMode,
        visibleSearchMatchCount,
        weekdayHeaders,
        yearOptions,
    } = controller;

    return (
        <ErrorBoundary>
            <div className="space-y-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                    <h2 className="text-3xl font-bold tracking-tight">{t('nav.calendar')}</h2>
                    <p className="text-sm text-muted-foreground">
                        {resolveText('calendar.tasksAndEvents', 'Tasks and external events by date')}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={handleToday}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
                        {resolveText('calendar.today', 'Today')}
                    </button>
                    <div className="inline-flex rounded-md border border-border bg-card p-1">
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
                    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
                        <button
                            type="button"
                            onClick={handlePrevMonth}
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                            aria-label={resolveText('calendar.prevMonth', 'Previous month')}
                            title={resolveText('calendar.prevMonth', 'Previous month')}
                        >
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setIsMonthPickerOpen((open) => !open)}
                                className="h-8 min-w-[11rem] rounded px-3 text-sm font-semibold hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                                                value={getMonth(currentMonth)}
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
                            aria-label={resolveText('calendar.nextMonth', 'Next month')}
                            title={resolveText('calendar.nextMonth', 'Next month')}
                        >
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            </header>
            <div className="relative mb-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input
                    type="text"
                    data-view-filter-input
                    placeholder={t('common.search')}
                    value={viewFilterQuery}
                    onChange={(event) => setViewFilterQuery(event.target.value)}
                    className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                {visibleSearchMatchCount !== null && (
                    <div className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                        {visibleSearchMatchCount > 0
                            ? resolveText('calendar.searchMatches', `${visibleSearchMatchCount} matches in this view`).replace('{count}', String(visibleSearchMatchCount))
                            : resolveText('calendar.noSearchMatches', 'No matching calendar items in this view')}
                    </div>
                )}
            </div>

            {externalError && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
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
                                    style={{ backgroundColor: hidden ? 'hsl(var(--muted-foreground))' : externalCalendarColor(calendar.id) }}
                                    aria-hidden="true"
                                />
                                {calendar.name}
                            </button>
                        );
                    })}
                </div>
            )}

            <div ref={calendarBodyRef} className="space-y-6">
                {viewMode === 'month' && (
                <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden shadow-sm">
                    {weekdayHeaders.map((day) => (
                        <div key={day} className="bg-card p-2 text-center text-sm font-medium text-muted-foreground">
                            {day}
                        </div>
                    ))}

                    {days.map((day, _dayIdx) => {
                        const cellItems = getCalendarItemsForDate(day);
                        const visibleItems = cellItems.slice(0, 3);
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
                                    "group bg-card min-h-[128px] p-2 transition-colors hover:bg-accent/50 relative",
                                    !isSameMonth(day, currentMonth) && "bg-muted/50 text-muted-foreground",
                                    isSelected && "ring-2 ring-primary"
                                )}
                                onClick={() => selectCalendarDate(day)}
                            >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <div className="flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium" style={todayMarkerStyle}>
                                            <span className="tabular-nums leading-none">
                                                {format(day, 'd')}
                                            </span>
                                        </div>
                                        {isToday(day) && (
                                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-normal text-primary">
                                                {resolveText('calendar.today', 'Today')}
                                            </span>
                                        )}
                                    </div>
                                    {isSelected && <div className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
                                </div>

                                <div className="space-y-1">
                                    {visibleItems.map((item) => {
                                        const timeLabel = item.start && (item.kind === 'scheduled' || (item.kind === 'event' && !item.event.allDay))
                                            ? safeFormatDate(item.start, 'p')
                                            : item.kind === 'event' && item.event.allDay
                                                ? t('calendar.allDay')
                                                : '';
                                        const content = (
                                            <>
                                                {timeLabel && <span className="mr-1 text-[10px] opacity-75">{timeLabel}</span>}
                                                <span>{item.title}</span>
                                            </>
                                        );

                                        if (item.kind === 'event') {
                                            return (
                                                <div
                                                    key={item.id}
                                                    className="truncate rounded border-l-[3px] bg-muted/70 px-1.5 py-1 text-xs text-muted-foreground"
                                                    style={{ borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                    title={item.title}
                                                >
                                                    {content}
                                                </div>
                                            );
                                        }

                                        const task = item.task;
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                data-task-id={task.id}
                                                data-task-edit-trigger
                                                className={cn(
                                                    "block w-full truncate rounded px-1.5 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                    item.kind === 'scheduled'
                                                        ? "bg-primary/10 text-primary"
                                                        : "border-l-[3px] border-destructive/70 bg-background/60 text-foreground"
                                                )}
                                                title={task.title}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    openTaskFromCalendar(task);
                                                }}
                                            >
                                                {content}
                                            </button>
                                        );
                                    })}
                                    {overflowCount > 0 && (
                                        <div className="px-1.5 pt-0.5 text-[11px] font-medium text-muted-foreground">
                                            +{overflowCount} {resolveText('calendar.more', 'more')}
                                        </div>
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
                            style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}
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
                                        isToday(day) && "bg-primary/5"
                                    )}
                                >
                                    <div className="text-xs font-medium text-muted-foreground">{format(day, 'EEE')}</div>
                                    <div className={cn("mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-semibold", isToday(day) && "bg-primary text-primary-foreground")}>
                                        {format(day, 'd')}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <div
                            className="grid border-b border-border"
                            style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}
                        >
                            <div className="border-r border-border p-2 text-xs font-medium text-muted-foreground">
                                {t('calendar.allDay')}
                            </div>
                            {timelineDays.map((day) => {
                                const allDayItems = getAllDayItemsForDay(day).slice(0, 4);
                                return (
                                    <div key={dayKey(day)} className="min-h-12 space-y-1 border-r border-border p-2 last:border-r-0">
                                        {allDayItems.map((item) => {
                                            if (item.kind === 'event') {
                                                return (
                                                    <div
                                                        key={item.id}
                                                        className="truncate rounded border-l-[3px] bg-muted/60 px-2 py-1 text-xs text-muted-foreground"
                                                        style={{ borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                        title={item.title}
                                                    >
                                                        {item.title}
                                                    </div>
                                                );
                                            }
                                            return (
                                                <button
                                                    key={item.id}
                                                    type="button"
                                                    data-task-id={item.task.id}
                                                    data-task-edit-trigger
                                                    onClick={() => openTaskFromCalendar(item.task)}
                                                    className="block w-full truncate rounded border-l-[3px] border-destructive/70 bg-background/70 px-2 py-1 text-left text-xs hover:bg-muted"
                                                    title={item.title}
                                                >
                                                    {item.title}
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>

                        <div className="grid" style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}>
                            <div className="relative border-r border-border bg-muted/20" style={{ height: (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * DESKTOP_HOUR_HEIGHT }}>
                                {Array.from({ length: DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR + 1 }, (_, index) => {
                                    const hour = DESKTOP_DAY_START_HOUR + index;
                                    return (
                                        <div key={hour} className="absolute right-2 -translate-y-2 text-[11px] text-muted-foreground" style={{ top: index * DESKTOP_HOUR_HEIGHT }}>
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
                                        className={cn("relative border-r border-border last:border-r-0", isToday(day) && "bg-primary/5")}
                                        style={{ height: (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * DESKTOP_HOUR_HEIGHT }}
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
                                                <span className="h-2 w-2 -translate-x-1 rounded-full bg-red-500" />
                                                <span className="h-0.5 flex-1 bg-red-500" />
                                            </div>
                                        )}
                                        {layoutTimedItems(day).map((item) => {
                                            const timeLabel = `${safeFormatDate(item.start, 'p')}-${safeFormatDate(item.end, 'p')}`;
                                            const commonStyle = {
                                                height: item.height,
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
                                                        style={{ ...commonStyle, borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                        title={`${item.title} ${timeLabel}`}
                                                        onClick={(event) => event.stopPropagation()}
                                                    >
                                                        <div className="truncate font-medium text-foreground">{item.title}</div>
                                                        <div className="truncate">{timeLabel}</div>
                                                    </div>
                                                );
                                            }
                                            return (
                                                <button
                                                    key={item.id}
                                                    type="button"
                                                    data-calendar-block
                                                    data-task-id={item.task.id}
                                                    data-task-edit-trigger
                                                    className="absolute z-10 overflow-hidden rounded bg-primary px-2 py-1 text-left text-xs text-primary-foreground shadow-sm hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                                    style={commonStyle}
                                                    title={`${item.title} ${timeLabel}`}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        openTaskFromCalendar(item.task);
                                                    }}
                                                >
                                                    <div className="truncate font-semibold">{item.title}</div>
                                                    <div className="truncate opacity-90">{timeLabel}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })}
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
                                    <section key={dayKey(day)} className="grid gap-3 px-4 py-3 md:grid-cols-[9rem_minmax(0,1fr)]">
                                        <div>
                                            <div className={cn("text-sm font-semibold", isToday(day) && "text-primary")}>{format(day, 'EEE, MMM d')}</div>
                                            {isToday(day) && <div className="mt-1 text-xs font-medium text-primary">{resolveText('calendar.today', 'Today')}</div>}
                                        </div>
                                        <div className="space-y-1">
                                            {items.map((item) => {
                                                const timeLabel = item.start && (item.kind === 'scheduled' || (item.kind === 'event' && !item.event.allDay))
                                                    ? safeFormatDate(item.start, 'p')
                                                    : item.kind === 'event' && item.event.allDay
                                                        ? t('calendar.allDay')
                                                        : t('calendar.deadline');
                                                if (item.kind === 'event') {
                                                    return (
                                                        <div
                                                            key={item.id}
                                                            className="flex items-center gap-3 rounded border-l-[3px] bg-muted/50 px-3 py-2 text-sm"
                                                            style={{ borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                        >
                                                            <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                                        </div>
                                                    );
                                                }
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        data-task-id={item.task.id}
                                                        data-task-edit-trigger
                                                        onClick={() => openTaskFromCalendar(item.task)}
                                                        className={cn(
                                                            "flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                            item.kind === 'scheduled' ? "bg-primary/10 text-primary" : "border-l-[3px] border-destructive/70 bg-background"
                                                        )}
                                                    >
                                                        <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                                        <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
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
                <CalendarOpenTaskModal controller={controller} />
                <CalendarTaskComposerModal controller={controller} />
        </div>
        </div>
        </ErrorBoundary>
    );
}
