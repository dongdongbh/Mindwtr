


import { format } from 'date-fns';
import type { ExternalCalendarEvent, Task } from '@mindwtr/core';
import type { CalendarDayItem } from '@mindwtr/core/calendar-day-items';

export const DESKTOP_DAY_START_HOUR = 0;
export const DESKTOP_DAY_END_HOUR = 24;
export const DESKTOP_HOUR_HEIGHT = 56;
export const DESKTOP_GRID_SNAP_MINUTES = 15;

export const CALENDAR_DAYS_IN_WEEK = 7;
export const CALENDAR_THREE_DAY_COUNT = 3;
export const CALENDAR_QUARTER_MONTH_COUNT = 3;
export const CALENDAR_YEAR_MONTH_COUNT = 12;


export const CALENDAR_TIMELINE_DAY_COUNT_MIN = 2;
export const CALENDAR_TIMELINE_DAY_COUNT_MAX = CALENDAR_DAYS_IN_WEEK;
export const CALENDAR_TIMELINE_DAY_COUNT_DEFAULT = CALENDAR_DAYS_IN_WEEK;

export const coerceCalendarTimelineDayCount = (value?: number | null): number => {
    if (!Number.isFinite(value)) return CALENDAR_TIMELINE_DAY_COUNT_DEFAULT;
    return Math.max(
        CALENDAR_TIMELINE_DAY_COUNT_MIN,
        Math.min(CALENDAR_TIMELINE_DAY_COUNT_MAX, Math.round(value as number))
    );
};

export type CalendarCellItem = CalendarDayItem;

export type CalendarViewMode = 'day' | 'threeDay' | 'week' | 'month' | 'quarter' | 'year' | 'schedule';

/**
 * The desktop calendar's mode order. The shared core still exposes only the four
 * modes the mobile screen and the native host contract can render; desktop keeps
 * its own list so a synced/unknown value cannot leak into those screens.
 */
export const CALENDAR_VIEW_MODE_ORDER: readonly CalendarViewMode[] = [
    'day', 'threeDay', 'week', 'month', 'quarter', 'year', 'schedule',
];

export const coerceDesktopCalendarViewMode = (value?: string | null): CalendarViewMode => (
    CALENDAR_VIEW_MODE_ORDER.find((mode) => mode === value) ?? 'month'
);

export const needsDesktopCalendarSelectedDate = (viewMode: CalendarViewMode): boolean => (
    viewMode === 'day' || viewMode === 'threeDay' || viewMode === 'week' || viewMode === 'schedule'
);

export const isCalendarTimelineViewMode = (viewMode: CalendarViewMode): boolean => (
    viewMode === 'day' || viewMode === 'threeDay' || viewMode === 'week'
);

export const isCalendarOverviewViewMode = (viewMode: CalendarViewMode): boolean => (
    viewMode === 'quarter' || viewMode === 'year'
);

export const getCalendarOverviewMonthCount = (viewMode: CalendarViewMode): number => (
    viewMode === 'year' ? CALENDAR_YEAR_MONTH_COUNT
        : viewMode === 'quarter' ? CALENDAR_QUARTER_MONTH_COUNT
            : 0
);

export const getCalendarTimelineDayCount = (viewMode: CalendarViewMode, timelineDayCount: number): number => (
    viewMode === 'day' ? 1
        : viewMode === 'threeDay' ? CALENDAR_THREE_DAY_COUNT
            : timelineDayCount
);

export const getCalendarPeriodMonthDelta = (viewMode: CalendarViewMode): number => (
    viewMode === 'month' ? 1
        : viewMode === 'quarter' ? CALENDAR_QUARTER_MONTH_COUNT
            : viewMode === 'year' ? CALENDAR_YEAR_MONTH_COUNT
                : 0
);

export type CalendarTimedItem =
    | { durationMinutes: number; end: Date; id: string; kind: 'task'; start: Date; task: Task; title: string }
    | { durationMinutes: number; end: Date; event: ExternalCalendarEvent; id: string; kind: 'event'; start: Date; title: string };

export const dayKey = (date: Date) => format(date, 'yyyy-MM-dd');

export const formatDateInputValue = (date: Date): string => format(date, 'yyyy-MM-dd');

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
