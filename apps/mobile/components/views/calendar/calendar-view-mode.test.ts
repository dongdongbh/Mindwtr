import { describe, expect, it } from 'vitest';

import {
  coerceCalendarWeekVisibleDays,
  coerceCalendarViewMode,
  getCalendarTimelineAnchorMinutes,
  getCalendarNavigationSwipeDirection,
  getCalendarTimelineDefaultScrollKey,
  getCalendarTimelineScrollYForMinutes,
  getCalendarWeekColumnWidth,
  getCalendarWeekContentClampX,
  getCalendarWeekMaxScrollX,
  getCalendarWeekInitialScrollX,
  getCalendarWeekInitialVisibleDayIndex,
  getCalendarWeekVisibleDaysUpdate,
  getInitialCalendarSelectedDate,
  shiftCalendarVisibleMonth,
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
    expect(needsCalendarSelectedDate('schedule')).toBe(true);
    expect(needsCalendarSelectedDate('month')).toBe(false);
  });

  it('starts persisted date-specific views on today', () => {
    const today = new Date('2026-05-01T12:00:00.000Z');

    expect(getInitialCalendarSelectedDate('day', today)?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(getInitialCalendarSelectedDate('week', today)?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(getInitialCalendarSelectedDate('schedule', today)?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
    expect(getInitialCalendarSelectedDate('month', today)).toBeNull();
  });

  it('moves between Jalali months without rebuilding them as Gregorian months', () => {
    const next = shiftCalendarVisibleMonth(new Date(2026, 6, 23, 12), 1, 'jalali');

    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 7, 23]);
  });

  it('does not reset the day timeline default scroll when the selected date changes', () => {
    expect(getCalendarTimelineDefaultScrollKey({
      selectedDate: new Date(2026, 4, 1, 12),
      viewMode: 'day',
      weekStartTime: 0,
    })).toBe('day');
    expect(getCalendarTimelineDefaultScrollKey({
      selectedDate: new Date(2026, 4, 2, 12),
      viewMode: 'day',
      weekStartTime: 0,
    })).toBe('day');
    expect(getCalendarTimelineDefaultScrollKey({
      selectedDate: null,
      viewMode: 'day',
      weekStartTime: 0,
    })).toBe('');
  });

  it('keeps week timeline default scroll keyed by the visible week', () => {
    expect(getCalendarTimelineDefaultScrollKey({
      selectedDate: new Date(2026, 4, 1, 12),
      viewMode: 'week',
      weekStartTime: 123,
    })).toBe('week:123');
    expect(getCalendarTimelineDefaultScrollKey({
      selectedDate: null,
      viewMode: 'month',
      weekStartTime: 123,
    })).toBe('');
  });

  it('computes day timeline scroll positions relative to timeline content', () => {
    expect(getCalendarTimelineScrollYForMinutes({
      contentTop: 64,
      minutes: 360,
      pixelsPerMinute: 2,
    })).toBe(604);
    expect(getCalendarTimelineAnchorMinutes({
      contentTop: 64,
      dayMinutes: 900,
      pixelsPerMinute: 2,
      scrollY: 604,
    })).toBe(360);
  });

  it('clamps timeline anchor minutes inside the visible day', () => {
    expect(getCalendarTimelineAnchorMinutes({
      dayMinutes: 900,
      pixelsPerMinute: 2,
      scrollY: -500,
    })).toBe(0);
    expect(getCalendarTimelineAnchorMinutes({
      dayMinutes: 900,
      pixelsPerMinute: 2,
      scrollY: 10_000,
    })).toBe(900);
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
    expect(getCalendarWeekColumnWidth(304, 2)).toBe(152);
    expect(getCalendarWeekColumnWidth(480, 2)).toBe(240);
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

  it('accounts for the week gutter when aligning visible day columns', () => {
    const weekDays = Array.from({ length: 7 }, (_, index) => new Date(2026, 4, 3 + index));

    expect(getCalendarWeekInitialScrollX({
      columnWidth: 100,
      leadingInset: 56,
      selectedDate: new Date(2026, 4, 5, 12),
      visibleDays: 2,
      weekDays,
    })).toBe(256);
    expect(getCalendarWeekInitialScrollX({
      columnWidth: 80,
      leadingInset: 56,
      selectedDate: new Date(2026, 4, 8, 12),
      visibleDays: 5,
      weekDays,
    })).toBe(216);
    expect(getCalendarWeekInitialScrollX({
      columnWidth: 56,
      leadingInset: 56,
      selectedDate: new Date(2026, 4, 5, 12),
      visibleDays: 7,
      weekDays,
    })).toBe(56);
  });

  it('recognizes deliberate horizontal calendar navigation swipes', () => {
    expect(getCalendarNavigationSwipeDirection({ translationX: -30, translationY: 8 })).toBe(1);
    expect(getCalendarNavigationSwipeDirection({ translationX: 30, translationY: 8 })).toBe(-1);
    expect(getCalendarNavigationSwipeDirection({ translationX: -72, translationY: 8 })).toBe(1);
    expect(getCalendarNavigationSwipeDirection({ translationX: 72, translationY: 8 })).toBe(-1);
    expect(getCalendarNavigationSwipeDirection({ translationX: -14, translationY: 4, velocityX: -320 })).toBe(1);
    expect(getCalendarNavigationSwipeDirection({ translationX: -32, translationY: 28 })).toBe(1);
  });

  it('ignores taps and mostly vertical drags as calendar navigation', () => {
    expect(getCalendarNavigationSwipeDirection({ translationX: -18, translationY: 2 })).toBeNull();
    expect(getCalendarNavigationSwipeDirection({ translationX: -72, translationY: 76 })).toBeNull();
    expect(getCalendarNavigationSwipeDirection({ translationX: -30, translationY: 34, velocityX: -900 })).toBeNull();
  });
});

describe('getCalendarWeekMaxScrollX', () => {
  it('is the canvas overflow past the viewport', () => {
    expect(getCalendarWeekMaxScrollX({ columnWidth: 210, dayCount: 7, gutterWidth: 56, viewportWidth: 897 }))
      .toBe(56 + 210 * 7 - 897);
  });

  it('never goes negative when the canvas fits', () => {
    expect(getCalendarWeekMaxScrollX({ columnWidth: 50, dayCount: 7, gutterWidth: 56, viewportWidth: 897 }))
      .toBe(0);
  });
});

describe('getCalendarWeekContentClampX', () => {
  it('returns one correction and becomes a no-op after the caller stores it', () => {
    const correction = getCalendarWeekContentClampX({
      currentX: 1_050,
      contentWidth: 1_080,
      viewportWidth: 1_080,
    });

    expect(correction).toBe(0);
    expect(getCalendarWeekContentClampX({
      currentX: correction ?? 1_050,
      contentWidth: 1_080,
      viewportWidth: 1_080,
    })).toBeNull();
  });

  it('does not disturb an offset that already fits the resized canvas', () => {
    expect(getCalendarWeekContentClampX({
      currentX: 180,
      contentWidth: 1_500,
      viewportWidth: 1_080,
    })).toBeNull();
  });
});

describe('getCalendarWeekVisibleDaysUpdate', () => {
  it('accepts a new density once and rejects repeated gesture samples', () => {
    let requestedVisibleDays = 2;
    const firstUpdate = getCalendarWeekVisibleDaysUpdate({
      currentVisibleDays: requestedVisibleDays,
      requestedVisibleDays: 5,
    });

    expect(firstUpdate).toBe(5);
    requestedVisibleDays = firstUpdate ?? requestedVisibleDays;
    expect(getCalendarWeekVisibleDaysUpdate({
      currentVisibleDays: requestedVisibleDays,
      requestedVisibleDays: 5,
    })).toBeNull();
  });

  it('coerces the requested density before comparing it', () => {
    expect(getCalendarWeekVisibleDaysUpdate({
      currentVisibleDays: 7,
      requestedVisibleDays: 20,
    })).toBeNull();
  });
});
