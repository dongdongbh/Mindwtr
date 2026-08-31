import {
  addCalendarMonths,
  startOfCalendarMonth,
  type CalendarSystemSetting,
} from '@mindwtr/core';

export type CalendarViewMode = 'month' | 'day' | 'week' | 'schedule';

export const CALENDAR_WEEK_VISIBLE_DAYS_MIN = 2;
export const CALENDAR_WEEK_VISIBLE_DAYS_MAX = 7;
export const CALENDAR_WEEK_VISIBLE_DAYS_DEFAULT = 2;
export const CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT = 150;
export const CALENDAR_WEEK_COLUMN_WIDTH_MIN = 40;
export const CALENDAR_NAVIGATION_SWIPE_DISTANCE = 28;
export const CALENDAR_NAVIGATION_SWIPE_VELOCITY = 260;
export const CALENDAR_NAVIGATION_SWIPE_VELOCITY_DISTANCE = 12;
export const CALENDAR_NAVIGATION_SWIPE_VERTICAL_TOLERANCE = 56;
export const CALENDAR_NAVIGATION_SWIPE_VERTICAL_RATIO = 1;
export const CALENDAR_NAVIGATION_CAPTURE_DISTANCE = 8;
export const CALENDAR_NAVIGATION_FEEDBACK_DISTANCE = 72;
export const CALENDAR_TIMELINE_SCROLL_ANCHOR_Y = 180;

type CalendarNavigationSwipeInput = {
  translationX: number;
  translationY: number;
  velocityX?: number;
};

export const coerceCalendarViewMode = (value?: string | null): CalendarViewMode => (
  value === 'day' || value === 'week' || value === 'schedule' ? value : 'month'
);

export const needsCalendarSelectedDate = (viewMode: CalendarViewMode): boolean => (
  viewMode === 'day' || viewMode === 'week' || viewMode === 'schedule'
);

export const getInitialCalendarSelectedDate = (
  viewMode: CalendarViewMode,
  today: Date = new Date(),
): Date | null => (
  needsCalendarSelectedDate(viewMode) ? new Date(today) : null
);

export const shiftCalendarVisibleMonth = (
  visibleMonth: Date,
  months: number,
  calendarSystem: CalendarSystemSetting,
): Date => startOfCalendarMonth(
  addCalendarMonths(visibleMonth, months, calendarSystem),
  calendarSystem,
);

export const getCalendarTimelineDefaultScrollKey = ({
  selectedDate,
  viewMode,
  weekStartTime,
}: {
  selectedDate: Date | null;
  viewMode: CalendarViewMode;
  weekStartTime: number;
}): string => {
  if (viewMode === 'day') return selectedDate ? 'day' : '';
  if (viewMode === 'week') return `week:${weekStartTime}`;
  return '';
};

export const getCalendarTimelineScrollYForMinutes = ({
  anchorY = CALENDAR_TIMELINE_SCROLL_ANCHOR_Y,
  contentTop = 0,
  minutes,
  pixelsPerMinute,
}: {
  anchorY?: number;
  contentTop?: number;
  minutes: number;
  pixelsPerMinute: number;
}): number => (
  Math.max(0, contentTop + minutes * pixelsPerMinute - anchorY)
);

export const getCalendarTimelineAnchorMinutes = ({
  anchorY = CALENDAR_TIMELINE_SCROLL_ANCHOR_Y,
  contentTop = 0,
  dayMinutes,
  pixelsPerMinute,
  scrollY,
}: {
  anchorY?: number;
  contentTop?: number;
  dayMinutes: number;
  pixelsPerMinute: number;
  scrollY: number;
}): number => {
  const rawMinutes = (scrollY - contentTop + anchorY) / pixelsPerMinute;
  if (!Number.isFinite(rawMinutes)) return 0;
  return Math.max(0, Math.min(dayMinutes, rawMinutes));
};

const isSameCalendarDay = (date: Date, otherDate: Date): boolean => (
  date.getFullYear() === otherDate.getFullYear() &&
  date.getMonth() === otherDate.getMonth() &&
  date.getDate() === otherDate.getDate()
);

export const getCalendarWeekInitialVisibleDayIndex = (
  weekDays: Date[],
  selectedDate: Date | null,
  today: Date = new Date(),
): number => {
  const targetDate = selectedDate ?? today;
  const targetIndex = weekDays.findIndex((day) => isSameCalendarDay(day, targetDate));
  if (targetIndex >= 0) return targetIndex;

  const todayIndex = weekDays.findIndex((day) => isSameCalendarDay(day, today));
  return Math.max(0, todayIndex);
};

export const coerceCalendarWeekVisibleDays = (value?: number | null): number => {
  if (!Number.isFinite(value)) return CALENDAR_WEEK_VISIBLE_DAYS_DEFAULT;
  return Math.max(
    CALENDAR_WEEK_VISIBLE_DAYS_MIN,
    Math.min(CALENDAR_WEEK_VISIBLE_DAYS_MAX, Math.round(value as number))
  );
};

/**
 * Resolves one requested density change while filtering duplicate samples from
 * a continuous slider gesture. The caller stores the returned value before
 * starting persistence so later gesture frames cannot enqueue the same write.
 */
export const getCalendarWeekVisibleDaysUpdate = ({
  currentVisibleDays,
  requestedVisibleDays,
}: {
  currentVisibleDays: number;
  requestedVisibleDays: number;
}): number | null => {
  const current = coerceCalendarWeekVisibleDays(currentVisibleDays);
  const requested = coerceCalendarWeekVisibleDays(requestedVisibleDays);
  return current === requested ? null : requested;
};

export const getCalendarWeekColumnWidth = (
  availableWidth: number,
  visibleDays?: number | null,
): number => {
  const resolvedVisibleDays = coerceCalendarWeekVisibleDays(visibleDays);
  const width = Number.isFinite(availableWidth) && availableWidth > 0
    ? availableWidth / resolvedVisibleDays
    : CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT;
  return Math.max(CALENDAR_WEEK_COLUMN_WIDTH_MIN, width);
};

export const getCalendarWeekInitialScrollX = ({
  columnWidth,
  leadingInset = 0,
  selectedDate,
  visibleDays,
  weekDays,
}: {
  columnWidth: number;
  leadingInset?: number;
  selectedDate: Date | null;
  visibleDays: number;
  weekDays: Date[];
}): number => {
  const resolvedVisibleDays = coerceCalendarWeekVisibleDays(visibleDays);
  const dayIndex = getCalendarWeekInitialVisibleDayIndex(weekDays, selectedDate);
  const maxStartIndex = Math.max(0, weekDays.length - resolvedVisibleDays);
  const startIndex = Math.min(dayIndex, maxStartIndex);
  return Math.max(0, leadingInset) + startIndex * Math.max(0, columnWidth);
};

/**
 * The furthest x the week canvas can scroll to: canvas width (pinned gutter +
 * one column per day) minus the viewport. Density changes resize the columns,
 * and a scroll offset taken under a wider canvas strands the view past the
 * last day unless it is re-clamped against this.
 */
export const getCalendarWeekMaxScrollX = ({
  columnWidth,
  dayCount,
  gutterWidth,
  viewportWidth,
}: {
  columnWidth: number;
  dayCount: number;
  gutterWidth: number;
  viewportWidth: number;
}): number => Math.max(0, gutterWidth + columnWidth * dayCount - viewportWidth);

/**
 * Returns the corrected horizontal offset after a week canvas resize, or null
 * when the current offset already fits. Callers must store the correction
 * before asking the scroll view to move so repeated content-size callbacks are
 * idempotent while the native scroll event catches up.
 */
export const getCalendarWeekContentClampX = ({
  contentWidth,
  currentX,
  viewportWidth,
}: {
  contentWidth: number;
  currentX: number;
  viewportWidth: number;
}): number | null => {
  const maxX = Math.max(0, contentWidth - viewportWidth);
  return currentX > maxX ? maxX : null;
};

export const getCalendarNavigationSwipeDirection = ({
  translationX,
  translationY,
  velocityX = 0,
}: CalendarNavigationSwipeInput): -1 | 1 | null => {
  const horizontalDistance = Math.abs(translationX);
  const verticalDrift = Math.abs(translationY);
  if (
    verticalDrift > CALENDAR_NAVIGATION_SWIPE_VERTICAL_TOLERANCE
    || verticalDrift > horizontalDistance * CALENDAR_NAVIGATION_SWIPE_VERTICAL_RATIO
  ) {
    return null;
  }

  const hasEnoughDistance = horizontalDistance >= CALENDAR_NAVIGATION_SWIPE_DISTANCE;
  const hasEnoughVelocity = (
    horizontalDistance >= CALENDAR_NAVIGATION_SWIPE_VELOCITY_DISTANCE
    && Math.abs(velocityX) >= CALENDAR_NAVIGATION_SWIPE_VELOCITY
  );
  if (!hasEnoughDistance && !hasEnoughVelocity) return null;

  return translationX < 0 ? 1 : -1;
};
