/**
 * Which dates the calendar is looking at: the current month, the selected day,
 * the view mode, and everything derived from them (the month grid, the timeline
 * days, the header labels, the month picker).
 *
 * It owns the URL round-trip too — the view mode and dates survive a reload
 * through `?calendarView=`/`?calendarDate=`/`?calendarMonth=`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    addDays,
    addWeeks,
    eachDayOfInterval,
    endOfWeek,
    format,
    startOfDay,
    startOfWeek,
    subDays,
    subWeeks,
} from 'date-fns';
import {
    addCalendarMonths as addCalendarSystemMonths,
    endOfCalendarMonth,
    getCalendarYear,
    isSameCalendarMonth,
    setCalendarMonthIndex,
    setCalendarYear,
    startOfCalendarMonth,
    type CalendarSystemSetting,
    type WeekStartsOnIndex,
} from '@mindwtr/core';

import {
    CALENDAR_DATE_PARAM,
    CALENDAR_MONTH_PARAM,
    CALENDAR_VIEW_PARAM,
} from '../../../lib/calendar-view-params';
import { getCalendarMonthNames, getCalendarWeekdayHeaders } from '../calendar-locale';
import {
    CALENDAR_DAYS_IN_WEEK,
    CALENDAR_TIMELINE_DAY_COUNT_DEFAULT,
    coerceCalendarTimelineDayCount,
    dayKey,
    type CalendarViewMode,
} from './calendar-primitives';
import { getWorkspaceCache } from '../../../lib/workspace-cache';

/**
 * How many days the week timeline shows. A layout choice about this screen, so
 * it lives beside the other device-local calendar preferences instead of in
 * synced settings — a wide desktop and a laptop should not fight over it.
 */
const CALENDAR_TIMELINE_DAY_COUNT_STORAGE_KEY = 'mindwtr.calendar.timelineDayCount';

export type CalendarMonthNavigationOptions = {
    calendarLocale: string;
    calendarSystem: CalendarSystemSetting;
    /**
     * Runs on every explicit navigation (and when the selected day is closed),
     * so the selected-day panel can drop its transient search/edit state.
     */
    onNavigate: () => void;
    weekStartsOn: WeekStartsOnIndex;
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

const needsCalendarSelectedDate = (viewMode: CalendarViewMode): boolean => (
    viewMode === 'day' || viewMode === 'week' || viewMode === 'schedule'
);

const readStoredTimelineDayCount = (): number => {
    if (typeof window === 'undefined') return CALENDAR_TIMELINE_DAY_COUNT_DEFAULT;
    try {
        const stored = getWorkspaceCache()?.getItem(CALENDAR_TIMELINE_DAY_COUNT_STORAGE_KEY);
        if (stored == null) return CALENDAR_TIMELINE_DAY_COUNT_DEFAULT;
        // Anything unparseable — a hand-edited value, an older format — coerces
        // back to a whole week rather than leaving the timeline with no columns.
        return coerceCalendarTimelineDayCount(Number.parseInt(stored, 10));
    } catch {
        return CALENDAR_TIMELINE_DAY_COUNT_DEFAULT;
    }
};

const getInitialCalendarState = (fallback: Date): { currentMonth: Date; selectedDate: Date | null; viewMode: CalendarViewMode } => {
    if (typeof window === 'undefined') {
        return { currentMonth: fallback, selectedDate: null, viewMode: 'month' };
    }
    const params = new URLSearchParams(window.location.search);
    const viewMode = parseCalendarViewMode(params.get(CALENDAR_VIEW_PARAM));
    const selectedDate = parseCalendarDateParam(params.get(CALENDAR_DATE_PARAM))
        ?? (needsCalendarSelectedDate(viewMode) ? new Date(fallback) : null);
    const monthDate = parseCalendarDateParam(`${params.get(CALENDAR_MONTH_PARAM) ?? ''}-01`);
    return {
        currentMonth: selectedDate ?? monthDate ?? fallback,
        selectedDate,
        viewMode,
    };
};

export function useCalendarMonthNavigation({
    calendarLocale,
    calendarSystem,
    onNavigate,
    weekStartsOn,
}: CalendarMonthNavigationOptions) {
    const [initialCalendarState] = useState(() => getInitialCalendarState(new Date()));
    const [currentMonth, setCurrentMonth] = useState(initialCalendarState.currentMonth);
    const [selectedDate, setSelectedDate] = useState<Date | null>(initialCalendarState.selectedDate);
    const [viewMode, setViewMode] = useState<CalendarViewMode>(initialCalendarState.viewMode);
    const [isMonthPickerOpen, setIsMonthPickerOpen] = useState(false);
    const [timelineDayCount, setTimelineDayCountState] = useState(readStoredTimelineDayCount);

    const setTimelineDayCount = useCallback((value: number) => {
        const next = coerceCalendarTimelineDayCount(value);
        setTimelineDayCountState(next);
        if (typeof window === 'undefined') return;
        try {
            getWorkspaceCache()?.setItem(CALENDAR_TIMELINE_DAY_COUNT_STORAGE_KEY, String(next));
        } catch {
            // A blocked or full store only costs the preference on next launch.
        }
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        url.searchParams.set(CALENDAR_MONTH_PARAM, format(currentMonth, 'yyyy-MM'));
        if (selectedDate) {
            url.searchParams.set(CALENDAR_DATE_PARAM, dayKey(selectedDate));
        } else {
            url.searchParams.delete(CALENDAR_DATE_PARAM);
        }
        url.searchParams.set(CALENDAR_VIEW_PARAM, viewMode);
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }, [currentMonth, selectedDate, viewMode]);

    const currentCalendarMonth = useMemo(
        () => startOfCalendarMonth(currentMonth, calendarSystem),
        [calendarSystem, currentMonth]
    );
    const calendarStart = startOfWeek(currentCalendarMonth, { weekStartsOn });
    const calendarEnd = endOfWeek(endOfCalendarMonth(currentCalendarMonth, calendarSystem), { weekStartsOn });
    const days = eachDayOfInterval({
        start: calendarStart,
        end: calendarEnd,
    });
    // A full week keeps the configured week boundary. Shorter timelines are
    // contiguous rolling windows, so paging by their size never hides a day.
    const timelineStart = useMemo(
        () => timelineDayCount === CALENDAR_DAYS_IN_WEEK
            ? startOfWeek(currentMonth, { weekStartsOn })
            : startOfDay(currentMonth),
        [currentMonth, timelineDayCount, weekStartsOn]
    );
    const visibleRange = useMemo(() => {
        if (viewMode === 'day') {
            return { start: currentMonth, end: currentMonth };
        }
        if (viewMode === 'week') {
            return { start: timelineStart, end: addDays(timelineStart, timelineDayCount - 1) };
        }
        if (viewMode === 'schedule') {
            return { start: currentMonth, end: addDays(currentMonth, 60) };
        }
        return {
            start: currentCalendarMonth,
            end: endOfCalendarMonth(currentCalendarMonth, calendarSystem),
        };
    }, [calendarSystem, currentCalendarMonth, currentMonth, timelineDayCount, timelineStart, viewMode]);
    const timelineDays = useMemo(
        () => viewMode === 'day'
            ? [currentMonth]
            : Array.from({ length: timelineDayCount }, (_, index) => addDays(timelineStart, index)),
        [currentMonth, timelineDayCount, timelineStart, viewMode]
    );
    const scheduleDays = useMemo(
        () => eachDayOfInterval({ start: visibleRange.start, end: visibleRange.end }),
        [visibleRange]
    );

    const monthNames = useMemo(() => getCalendarMonthNames(calendarLocale), [calendarLocale]);
    const weekdayHeaders = useMemo(
        () => getCalendarWeekdayHeaders(calendarLocale, weekStartsOn),
        [calendarLocale, weekStartsOn]
    );
    const currentYear = getCalendarYear(currentMonth, calendarSystem);
    const currentMonthLabel = (() => {
        if (viewMode === 'day') return currentMonth.toLocaleDateString(calendarLocale, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
        if (viewMode === 'week') {
            const end = addDays(timelineStart, timelineDayCount - 1);
            return `${timelineStart.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        if (viewMode === 'schedule') {
            return `${visibleRange.start.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric' })} - ${visibleRange.end.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        return currentCalendarMonth.toLocaleDateString(calendarLocale, { month: 'long', year: 'numeric' });
    })();
    const yearOptions = useMemo(
        () => Array.from({ length: 11 }, (_, index) => currentYear - 5 + index),
        [currentYear]
    );

    const selectCalendarDate = (date: Date) => {
        setSelectedDate(date);
        if (viewMode !== 'week' && !isSameCalendarMonth(date, currentMonth, calendarSystem)) {
            setCurrentMonth(date);
        }
    };
    /** Brings a date the user just acted on into view, and selects it. */
    const revealDate = useCallback((date: Date) => {
        setSelectedDate(date);
        setCurrentMonth(date);
    }, []);
    const closeSelectedDay = () => {
        setSelectedDate(null);
        onNavigate();
    };
    const openDayViewForDate = (date: Date) => {
        setSelectedDate(date);
        setCurrentMonth(date);
        setViewMode('day');
        onNavigate();
        setIsMonthPickerOpen(false);
    };
    const handleMonthChange = (monthIndex: number) => {
        setSelectedDate(null);
        onNavigate();
        setCurrentMonth((prev) => setCalendarMonthIndex(prev, monthIndex, calendarSystem));
    };
    const handleYearChange = (yearValue: number) => {
        setSelectedDate(null);
        onNavigate();
        setCurrentMonth((prev) => setCalendarYear(prev, yearValue, calendarSystem));
    };
    const handlePrevMonth = () => {
        onNavigate();
        setIsMonthPickerOpen(false);
        const next = viewMode === 'day'
            ? subDays(currentMonth, 1)
            : viewMode === 'week'
            ? subDays(currentMonth, timelineDayCount)
            : viewMode === 'schedule'
            ? subWeeks(currentMonth, 2)
            : addCalendarSystemMonths(currentMonth, -1, calendarSystem);
        setCurrentMonth(next);
        setSelectedDate(needsCalendarSelectedDate(viewMode) ? next : null);
    };
    const handleNextMonth = () => {
        onNavigate();
        setIsMonthPickerOpen(false);
        const next = viewMode === 'day'
            ? addDays(currentMonth, 1)
            : viewMode === 'week'
            ? addDays(currentMonth, timelineDayCount)
            : viewMode === 'schedule'
            ? addWeeks(currentMonth, 2)
            : addCalendarSystemMonths(currentMonth, 1, calendarSystem);
        setCurrentMonth(next);
        setSelectedDate(needsCalendarSelectedDate(viewMode) ? next : null);
    };
    const handleToday = () => {
        const nextToday = new Date();
        setCurrentMonth(nextToday);
        setSelectedDate(needsCalendarSelectedDate(viewMode) ? nextToday : null);
        onNavigate();
        setIsMonthPickerOpen(false);
    };
    const handleViewModeChange = (nextMode: CalendarViewMode) => {
        setViewMode(nextMode);
        if (needsCalendarSelectedDate(nextMode)) {
            const nextDate = selectedDate ?? new Date();
            setSelectedDate(nextDate);
            setCurrentMonth(nextDate);
        }
        setIsMonthPickerOpen(false);
    };
    const toggleMonthPicker = () => setIsMonthPickerOpen((open) => !open);

    return {
        closeSelectedDay,
        currentMonth,
        currentMonthLabel,
        currentYear,
        days,
        handleMonthChange,
        handleNextMonth,
        handlePrevMonth,
        handleToday,
        handleViewModeChange,
        handleYearChange,
        isMonthPickerOpen,
        monthNames,
        openDayViewForDate,
        revealDate,
        scheduleDays,
        selectCalendarDate,
        selectedDate,
        setTimelineDayCount,
        timelineDayCount,
        timelineDays,
        toggleMonthPicker,
        viewMode,
        visibleRange,
        weekdayHeaders,
        yearOptions,
    };
}

export type CalendarMonthNavigation = ReturnType<typeof useCalendarMonthNavigation>;
