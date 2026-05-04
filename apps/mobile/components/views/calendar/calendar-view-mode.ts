export type CalendarViewMode = 'month' | 'day' | 'week' | 'schedule';

export const CALENDAR_WEEK_VISIBLE_DAYS_MIN = 2;
export const CALENDAR_WEEK_VISIBLE_DAYS_MAX = 7;
export const CALENDAR_WEEK_VISIBLE_DAYS_DEFAULT = 2;
export const CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT = 150;
export const CALENDAR_WEEK_COLUMN_WIDTH_MIN = 40;
export const CALENDAR_NAVIGATION_SWIPE_DISTANCE = 56;
export const CALENDAR_NAVIGATION_SWIPE_VELOCITY = 500;
export const CALENDAR_NAVIGATION_SWIPE_VERTICAL_TOLERANCE = 32;

type CalendarNavigationSwipeInput = {
  translationX: number;
  translationY: number;
  velocityX?: number;
};

export const coerceCalendarViewMode = (value?: string | null): CalendarViewMode => (
  value === 'day' || value === 'week' || value === 'schedule' ? value : 'month'
);

export const needsCalendarSelectedDate = (viewMode: CalendarViewMode): boolean => (
  viewMode === 'day' || viewMode === 'week'
);

export const getInitialCalendarSelectedDate = (
  viewMode: CalendarViewMode,
  today: Date = new Date(),
): Date | null => (
  needsCalendarSelectedDate(viewMode) ? new Date(today) : null
);

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

export const getCalendarWeekColumnWidth = (
  availableWidth: number,
  visibleDays?: number | null,
): number => {
  const resolvedVisibleDays = coerceCalendarWeekVisibleDays(visibleDays);
  const width = Number.isFinite(availableWidth) && availableWidth > 0
    ? availableWidth / resolvedVisibleDays
    : CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT;
  return Math.max(
    CALENDAR_WEEK_COLUMN_WIDTH_MIN,
    Math.min(CALENDAR_WEEK_COLUMN_WIDTH_DEFAULT, width)
  );
};

export const getCalendarWeekInitialScrollX = ({
  columnWidth,
  selectedDate,
  visibleDays,
  weekDays,
}: {
  columnWidth: number;
  selectedDate: Date | null;
  visibleDays: number;
  weekDays: Date[];
}): number => {
  if (coerceCalendarWeekVisibleDays(visibleDays) >= weekDays.length) return 0;
  const dayIndex = getCalendarWeekInitialVisibleDayIndex(weekDays, selectedDate);
  return Math.max(0, dayIndex * Math.max(0, columnWidth));
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
    || verticalDrift > horizontalDistance * 0.75
  ) {
    return null;
  }

  const hasEnoughDistance = horizontalDistance >= CALENDAR_NAVIGATION_SWIPE_DISTANCE;
  const hasEnoughVelocity = (
    horizontalDistance >= CALENDAR_NAVIGATION_SWIPE_DISTANCE * 0.45
    && Math.abs(velocityX) >= CALENDAR_NAVIGATION_SWIPE_VELOCITY
  );
  if (!hasEnoughDistance && !hasEnoughVelocity) return null;

  return translationX < 0 ? 1 : -1;
};
