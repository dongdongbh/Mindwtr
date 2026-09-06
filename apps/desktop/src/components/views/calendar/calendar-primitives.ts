/**
 * The hook-free part of the desktop calendar: grid geometry, the date shapes the
 * inputs speak in, and the item types every panel renders.
 *
 * It is deliberately a leaf — the calendar sub-hooks and their panels all import
 * from here, so none of them has to import (and cycle back through) the
 * controller that composes them.
 */
import { format } from 'date-fns';
import type { ExternalCalendarEvent, Task } from '@mindwtr/core';
import type { CalendarDayItem } from '@mindwtr/core/calendar-day-items';

export const DESKTOP_DAY_START_HOUR = 0;
export const DESKTOP_DAY_END_HOUR = 24;
export const DESKTOP_HOUR_HEIGHT = 56;
export const DESKTOP_GRID_SNAP_MINUTES = 15;

export const CALENDAR_DAYS_IN_WEEK = 7;

/**
 * How many days the week timeline shows at once (#951).
 *
 * The range and the clamp mirror mobile's `coerceCalendarWeekVisibleDays`
 * (`apps/mobile/components/views/calendar/calendar-view-mode.ts`) on purpose, so
 * the two platforms agree on what a day count means. Only the default differs:
 * mobile opens on 5 (a school or work week in compact columns), a desktop
 * window is wide enough to start on the whole week.
 */
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

export type CalendarViewMode = 'day' | 'week' | 'month' | 'schedule';

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
