import { describe, expect, it } from 'vitest';

import {
  CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT,
  coerceCalendarWeekVisibleDays,
  coerceCalendarViewMode,
  getCalendarNavigationSwipeDirection,
  getCalendarWeekColumnWidth,
  getCalendarWeekInitialScrollX,
  getCalendarWeekInitialVisibleDayIndex,
  getInitialCalendarSelectedDate,
  needsCalendarSelectedDate,
} from './calendar-view-mode';

describe('calendar view mode helpers', () => {
  it('coerces unsupported stored values to month', () => {
    expect(coerceCalendarViewMode('day')).toBe('day');
    expect(coerceCalendarViewMode('week')).toBe('week');
    expect(coerceCalendarViewMode('schedule')).toBe('schedule');
    expect(coerceCalendarViewMode('agenda')).toBe('month');
    expect(coerceCalendarViewMode(undefined)).toBe('month');
  });

  it('requires a selected date for date-specific views', () => {
    expect(needsCalendarSelectedDate('day')).toBe(true);
    expect(needsCalendarSelectedDate('week')).toBe(true);
    expect(needsCalendarSelectedDate('month')).toBe(false);
    expect(needsCalendarSelectedDate('schedule')).toBe(false);
  });

  it('starts persisted day and week views on today', () => {
    const today = new Date('2026-05-01T12:00:00.000Z');

    expect(getInitialCalendarSelectedDate('day', today)?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(getInitialCalendarSelectedDate('week', today)?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(getInitialCalendarSelectedDate('month', today)).toBeNull();
  });

  it('chooses the selected day as the initial visible week column', () => {
    const weekDays = Array.from({ length: 7 }, (_, index) => new Date(2026, 3, 27 + index));

    expect(getCalendarWeekInitialVisibleDayIndex(weekDays, new Date(2026, 4, 1, 12))).toBe(4);
  });

  it('falls back to today for the initial visible week column', () => {
    const weekDays = Array.from({ length: 7 }, (_, index) => new Date(2026, 3, 27 + index));

    expect(getCalendarWeekInitialVisibleDayIndex(weekDays, null, new Date(2026, 4, 2, 12))).toBe(5);
    expect(getCalendarWeekInitialVisibleDayIndex(weekDays, null, new Date(2026, 4, 10, 12))).toBe(0);
  });

  it('coerces visible week day counts into the supported density range', () => {
    expect(coerceCalendarWeekVisibleDays(undefined)).toBe(2);
    expect(coerceCalendarWeekVisibleDays(1)).toBe(2);
    expect(coerceCalendarWeekVisibleDays(4.4)).toBe(4);
    expect(coerceCalendarWeekVisibleDays(8)).toBe(7);
  });

  it('sizes week columns from the requested visible day density', () => {
    expect(getCalendarWeekColumnWidth(304, 2)).toBe(CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT);
    expect(getCalendarWeekColumnWidth(304, 4)).toBe(76);
    expect(getCalendarWeekColumnWidth(280, 7)).toBe(40);
  });

  it('keeps full-week density anchored at the start of the week', () => {
    const weekDays = Array.from({ length: 7 }, (_, index) => new Date(2026, 3, 27 + index));

    expect(getCalendarWeekInitialScrollX({
      columnWidth: 100,
      selectedDate: new Date(2026, 4, 1, 12),
      visibleDays: 3,
      weekDays,
    })).toBe(400);
    expect(getCalendarWeekInitialScrollX({
      columnWidth: 43,
      selectedDate: new Date(2026, 4, 1, 12),
      visibleDays: 7,
      weekDays,
    })).toBe(0);
  });

  it('recognizes deliberate horizontal calendar navigation swipes', () => {
    expect(getCalendarNavigationSwipeDirection({ translationX: -72, translationY: 8 })).toBe(1);
    expect(getCalendarNavigationSwipeDirection({ translationX: 72, translationY: 8 })).toBe(-1);
    expect(getCalendarNavigationSwipeDirection({ translationX: -28, translationY: 4, velocityX: -640 })).toBe(1);
  });

  it('ignores taps and mostly vertical drags as calendar navigation', () => {
    expect(getCalendarNavigationSwipeDirection({ translationX: -18, translationY: 2 })).toBeNull();
    expect(getCalendarNavigationSwipeDirection({ translationX: -72, translationY: 48 })).toBeNull();
    expect(getCalendarNavigationSwipeDirection({ translationX: -44, translationY: 40, velocityX: -900 })).toBeNull();
  });
});
