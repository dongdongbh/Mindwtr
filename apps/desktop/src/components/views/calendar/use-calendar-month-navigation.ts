


import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    addDays,
    addWeeks,
    eachDayOfInterval,
    endOfWeek,
    format,
    startOfDay,
    startOfWeek,
} from 'date-fns';
import {
    addCalendarMonths as addCalendarSystemMonths,
    endOfCalendarMonth,
    getCalendarMonthIndex,
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
    coerceDesktopCalendarViewMode,
    dayKey,
    getCalendarOverviewMonthCount,
    getCalendarPeriodMonthDelta,
    getCalendarTimelineDayCount,
    isCalendarOverviewViewMode,
    needsDesktopCalendarSelectedDate,
    type CalendarViewMode,
} from './calendar-primitives';
import { getWorkspaceCache } from '../../../lib/workspace-cache';


const CALENDAR_TIMELINE_DAY_COUNT_STORAGE_KEY = 'mindwtr.calendar.timelineDayCount';

export type CalendarMonthNavigationOptions = {
    calendarLocale: string;
    calendarSystem: CalendarSystemSetting;


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

const readStoredTimelineDayCount = (): number => {
    if (typeof window === 'undefined') return CALENDAR_TIMELINE_DAY_COUNT_DEFAULT;
    try {
        const stored = getWorkspaceCache()?.getItem(CALENDAR_TIMELINE_DAY_COUNT_STORAGE_KEY);
        if (stored == null) return CALENDAR_TIMELINE_DAY_COUNT_DEFAULT;


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
    const viewMode = coerceDesktopCalendarViewMode(params.get(CALENDAR_VIEW_PARAM));
    const selectedDate = parseCalendarDateParam(params.get(CALENDAR_DATE_PARAM))
        ?? (needsDesktopCalendarSelectedDate(viewMode) ? new Date(fallback) : null);
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


    const overviewMonths = useMemo(() => {
        if (!isCalendarOverviewViewMode(viewMode)) return [];
        const count = getCalendarOverviewMonthCount(viewMode);
        const firstMonth = viewMode === 'year'
            ? addCalendarSystemMonths(currentCalendarMonth, -getCalendarMonthIndex(currentCalendarMonth, calendarSystem), calendarSystem)
            : currentCalendarMonth;
        return Array.from({ length: count }, (_, index) => addCalendarSystemMonths(firstMonth, index, calendarSystem));
    }, [calendarSystem, currentCalendarMonth, viewMode]);
    const overviewMonthGrids = useMemo(() => overviewMonths.map((month) => {
        const monthStart = startOfCalendarMonth(month, calendarSystem);
        const monthEnd = endOfCalendarMonth(monthStart, calendarSystem);
        return {
            month: monthStart,
            days: eachDayOfInterval({
                start: startOfWeek(monthStart, { weekStartsOn }),
                end: endOfWeek(monthEnd, { weekStartsOn }),
            }),
        };
    }), [calendarSystem, overviewMonths, weekStartsOn]);

    const effectiveTimelineDayCount = getCalendarTimelineDayCount(viewMode, timelineDayCount);
    const timelineStart = useMemo(
        () => viewMode === 'week' && effectiveTimelineDayCount === CALENDAR_DAYS_IN_WEEK
            ? startOfWeek(currentMonth, { weekStartsOn })
            : startOfDay(currentMonth),
        [currentMonth, effectiveTimelineDayCount, viewMode, weekStartsOn]
    );
    const visibleRange = useMemo(() => {
        if (viewMode === 'day') {
            return { start: currentMonth, end: currentMonth };
        }
        if (viewMode === 'threeDay' || viewMode === 'week') {
            return { start: timelineStart, end: addDays(timelineStart, effectiveTimelineDayCount - 1) };
        }
        if (viewMode === 'schedule') {
            return { start: currentMonth, end: addDays(currentMonth, 60) };
        }
        if (overviewMonths.length > 0) {
            return {
                start: startOfCalendarMonth(overviewMonths[0]!, calendarSystem),
                end: endOfCalendarMonth(overviewMonths[overviewMonths.length - 1]!, calendarSystem),
            };
        }
        return {
            start: currentCalendarMonth,
            end: endOfCalendarMonth(currentCalendarMonth, calendarSystem),
        };
    }, [calendarSystem, currentCalendarMonth, currentMonth, effectiveTimelineDayCount, overviewMonths, timelineStart, viewMode]);
    const timelineDays = useMemo(
        () => viewMode === 'day'
            ? [currentMonth]
            : Array.from({ length: effectiveTimelineDayCount }, (_, index) => addDays(timelineStart, index)),
        [currentMonth, effectiveTimelineDayCount, timelineStart, viewMode]
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
        if (viewMode === 'threeDay' || viewMode === 'week') {
            const end = addDays(timelineStart, effectiveTimelineDayCount - 1);
            return `${timelineStart.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        if (viewMode === 'schedule') {
            return `${visibleRange.start.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric' })} - ${visibleRange.end.toLocaleDateString(calendarLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        if (viewMode === 'quarter' && overviewMonths.length > 0) {
            const end = overviewMonths[overviewMonths.length - 1]!;
            return `${currentCalendarMonth.toLocaleDateString(calendarLocale, { month: 'short' })} - ${end.toLocaleDateString(calendarLocale, { month: 'short', year: 'numeric' })}`;
        }
        if (viewMode === 'year') return String(currentYear);
        return currentCalendarMonth.toLocaleDateString(calendarLocale, { month: 'long', year: 'numeric' });
    })();
    const yearOptions = useMemo(
        () => Array.from({ length: 11 }, (_, index) => currentYear - 5 + index),
        [currentYear]
    );

    const selectCalendarDate = (date: Date) => {
        setSelectedDate(date);
        if (viewMode !== 'week' && viewMode !== 'threeDay' && !isSameCalendarMonth(date, currentMonth, calendarSystem)) {
            setCurrentMonth(date);
        }
    };

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
    const stepCalendarPeriod = (direction: -1 | 1) => {
        onNavigate();
        setIsMonthPickerOpen(false);
        const monthDelta = getCalendarPeriodMonthDelta(viewMode);
        const next = monthDelta !== 0
            ? addCalendarSystemMonths(currentMonth, direction * monthDelta, calendarSystem)
            : viewMode === 'schedule'
                ? addWeeks(currentMonth, direction * 2)
                : addDays(currentMonth, direction * effectiveTimelineDayCount);
        setCurrentMonth(next);
        setSelectedDate(needsDesktopCalendarSelectedDate(viewMode) ? next : null);
    };
    const handlePrevMonth = () => stepCalendarPeriod(-1);
    const handleNextMonth = () => stepCalendarPeriod(1);

    /** The second navigation pair always nudges the anchor by exactly one day. */
    const stepCalendarDay = (direction: -1 | 1) => {
        onNavigate();
        setIsMonthPickerOpen(false);
        const next = addDays(currentMonth, direction);
        setCurrentMonth(next);
        setSelectedDate(needsDesktopCalendarSelectedDate(viewMode) ? next : null);
    };
    const handlePrevDay = () => stepCalendarDay(-1);
    const handleNextDay = () => stepCalendarDay(1);

    const handleToday = () => {
        const nextToday = new Date();
        setCurrentMonth(nextToday);
        setSelectedDate(needsDesktopCalendarSelectedDate(viewMode) ? nextToday : null);
        onNavigate();
        setIsMonthPickerOpen(false);
    };
    const handleViewModeChange = (nextMode: CalendarViewMode) => {
        setViewMode(nextMode);
        if (needsDesktopCalendarSelectedDate(nextMode)) {
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
        handleNextDay,
        handleNextMonth,
        handlePrevDay,
        handlePrevMonth,
        handleToday,
        handleViewModeChange,
        handleYearChange,
        isMonthPickerOpen,
        monthNames,
        openDayViewForDate,
        overviewMonthGrids,
        overviewMonths,
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
