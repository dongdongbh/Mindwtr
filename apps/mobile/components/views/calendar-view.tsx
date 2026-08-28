import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AccessibilityActionEvent,
  FlatList,
  type LayoutChangeEvent,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { getCalendarDayOfMonth, getShortWeekdayLabels, getTaskCalendarOccurrenceDate, isProjectedRecurringTask, isTaskFinished, safeFormatDate, safeParseDate, type Task } from '@mindwtr/core';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CompactText } from '@/components/compact-text';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { useAndroidKeyboardInset } from '@/lib/use-android-keyboard-inset';
import {
  buildTimedCalendarLayouts,
  orderCalendarDayItemsForLimitedSlots,
  type CalendarTimedLayout,
  type CalendarTimedLayoutInput,
} from '@mindwtr/core/calendar-day-items';
import { styles } from './calendar/calendar-view.styles';
import { CalendarPeriodNavigation } from './calendar/calendar-period-navigation';
import { CalendarTaskComposerModal } from './calendar/calendar-task-composer-modal';
import {
  isAllDayScheduledTask,
  isTimedScheduledTask,
} from './calendar/calendar-task-items';
import {
  CALENDAR_WEEK_VISIBLE_DAYS_MAX,
  CALENDAR_WEEK_VISIBLE_DAYS_MIN,
  CALENDAR_NAVIGATION_CAPTURE_DISTANCE,
  CALENDAR_NAVIGATION_FEEDBACK_DISTANCE,
  CALENDAR_NAVIGATION_SWIPE_VERTICAL_TOLERANCE,
  CALENDAR_NAVIGATION_SWIPE_VERTICAL_RATIO,
  getCalendarNavigationSwipeDirection,
  getCalendarWeekColumnWidth,
  getCalendarWeekInitialScrollX,
} from './calendar/calendar-view-mode';
import { useCalendarViewController } from './calendar/useCalendarViewController';

const MONTH_DETAILS_COLLAPSED_SNAP = 0.26;
const MONTH_DETAILS_MID_SNAP = 0.58;
const MONTH_DETAILS_EXPANDED_SNAP = 0.9;
const MONTH_DETAILS_HIDE_THRESHOLD = 0.2;
const MONTH_DETAILS_MIN_HEIGHT = 176;
const TIMED_BLOCK_COLUMN_GAP = 2;
const WEEK_TIME_GUTTER_WIDTH = 56;
// The gutter is pinned by counter-translating it against this scroller's offset, so it needs to
// be animatable. Wrapping the gesture-handler ScrollView keeps the existing scroll behaviour.
const AnimatedWeekScrollView = Animated.createAnimatedComponent(ScrollView);
const WEEK_DENSITY_VALUES = Array.from(
  { length: CALENDAR_WEEK_VISIBLE_DAYS_MAX - CALENDAR_WEEK_VISIBLE_DAYS_MIN + 1 },
  (_, index) => CALENDAR_WEEK_VISIBLE_DAYS_MIN + index
);

type CalendarNavigationMode = 'month' | 'day';

type TimedBlockInsetStyle = Pick<ViewStyle, 'left' | 'right' | 'marginLeft' | 'marginRight'>;

const percentDimension = (value: number): `${number}%` => {
  const clamped = Math.max(0, Math.min(100, value));
  return `${Number(clamped.toFixed(4))}%` as `${number}%`;
};

const getTimedBlockInsetStyle = (layout?: CalendarTimedLayout): TimedBlockInsetStyle => {
  const leftPercent = layout?.leftPercent ?? 0;
  const widthPercent = layout?.widthPercent ?? 100;
  const rightPercent = 100 - leftPercent - widthPercent;
  return {
    left: percentDimension(leftPercent),
    right: percentDimension(rightPercent),
    marginLeft: layout && layout.columnIndex > 0 ? TIMED_BLOCK_COLUMN_GAP : 0,
    marginRight: layout && layout.columnIndex < layout.columnCount - 1 ? TIMED_BLOCK_COLUMN_GAP : 0,
  };
};

const PROJECTED_RECURRENCE_LABEL_DATE_FORMAT = 'MMM d';

const getProjectedRecurrenceDisplayLabel = (task: Task, projectedLabel: string): string => {
  const occurrenceDateLabel = safeFormatDate(
    getTaskCalendarOccurrenceDate(task),
    PROJECTED_RECURRENCE_LABEL_DATE_FORMAT
  );
  return occurrenceDateLabel ? `${projectedLabel} · ${occurrenceDateLabel}` : projectedLabel;
};

type ScheduledTaskBlockProps = {
  DAY_END_HOUR: number;
  DAY_START_HOUR: number;
  PIXELS_PER_MINUTE: number;
  SNAP_MINUTES: number;
  commitTaskDrag: (taskId: string, dayStartMs: number, startMinutes: number, durationMinutes: number) => void;
  dayStartMs: number;
  durationMinutes: number;
  formatTimeRange: (start: Date, durationMinutes: number) => string;
  height: number;
  isDark: boolean;
  layoutStyle: TimedBlockInsetStyle;
  openTaskActions: (taskId: string) => void;
  projectedLabel: string;
  reducedMotion: boolean;
  setTimelineScrollEnabled: (enabled: boolean) => void;
  task: Task;
  tc: ReturnType<typeof useCalendarViewController>['tc'];
  toRgba: (hex: string, alpha: number) => string;
  top: number;
  triggerDragHaptic: () => void;
};

type PlanningTaskListProps = {
  getScheduleSlotLabel: (date: Date | null, task: Task) => string | null;
  planningTasks: Task[];
  scheduleTaskOnSelectedDate: (taskId: string) => void;
  selectedDate: Date | null;
  selectedDatePlanningLabel: string;
  t: ReturnType<typeof useCalendarViewController>['t'];
  tc: ReturnType<typeof useCalendarViewController>['tc'];
  tr: ReturnType<typeof useCalendarViewController>['tr'];
  variant?: 'results' | 'section';
};

function PlanningTaskList({
  getScheduleSlotLabel,
  planningTasks,
  scheduleTaskOnSelectedDate,
  selectedDate,
  selectedDatePlanningLabel,
  t,
  tc,
  tr,
  variant = 'results',
}: PlanningTaskListProps) {
  const isSection = variant === 'section';
  const items = planningTasks.map((task) => {
    const slotLabel = getScheduleSlotLabel(selectedDate, task);
    const taskContent = (
      <>
        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
          {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
        </Text>
      </>
    );
    return (
      <Pressable
        key={task.id}
        style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
        onPress={() => scheduleTaskOnSelectedDate(task.id)}
      >
        {isSection ? <View style={styles.taskItemMain}>{taskContent}</View> : taskContent}
      </Pressable>
    );
  });

  return (
    <View style={isSection ? styles.scheduleSection : styles.scheduleResults}>
      <Text style={[isSection ? styles.scheduleDate : styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
        {tr('calendar.planningTitle')}
      </Text>
      <Text style={[styles.scheduleResultsSubtitle, { color: tc.secondaryText }]}>
        {selectedDatePlanningLabel}
      </Text>
      {isSection ? <View style={styles.scheduleItems}>{items}</View> : items}
    </View>
  );
}

function ScheduledTaskBlock({
  DAY_END_HOUR,
  DAY_START_HOUR,
  PIXELS_PER_MINUTE,
  SNAP_MINUTES,
  commitTaskDrag,
  dayStartMs,
  durationMinutes,
  formatTimeRange,
  height,
  isDark,
  layoutStyle,
  openTaskActions,
  projectedLabel,
  reducedMotion,
  setTimelineScrollEnabled,
  task,
  tc,
  toRgba,
  top,
  triggerDragHaptic,
}: ScheduledTaskBlockProps) {
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const zIndex = useSharedValue(1);
  const taskId = task.id;
  const projected = isProjectedRecurringTask(task);

  const panGesture = Gesture.Pan()
    .activateAfterLongPress(140)
    .onStart(() => {
      scale.value = reducedMotion ? 1 : withSpring(1.02);
      zIndex.value = 50;
      runOnJS(triggerDragHaptic)();
      runOnJS(setTimelineScrollEnabled)(false);
    })
    .onUpdate((event) => {
      translateY.value = event.translationY;
    })
    .onEnd((event) => {
      const dayMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
      const startMinutes = Math.round((top + event.translationY) / PIXELS_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES;
      const clampedMinutes = Math.max(0, Math.min(dayMinutes - durationMinutes, startMinutes));
      runOnJS(commitTaskDrag)(taskId, dayStartMs, clampedMinutes, durationMinutes);
      translateY.value = reducedMotion ? 0 : withSpring(0);
      scale.value = reducedMotion ? 1 : withSpring(1);
      zIndex.value = 1;
    })
    .onFinalize(() => {
      runOnJS(setTimelineScrollEnabled)(true);
    });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(openTaskActions)(taskId);
  });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
    zIndex: zIndex.value,
  }));

  const start = task.startTime ? safeParseDate(task.startTime) : null;
  const label = start ? formatTimeRange(start, durationMinutes) : '';
  const compact = height < 48;
  const showTime = height >= 44;
  const projectedDisplayLabel = projected ? getProjectedRecurrenceDisplayLabel(task, projectedLabel) : projectedLabel;

  const blockContent = (
    <>
      <Text
        style={[styles.taskBlockTitle, compact && styles.taskBlockTitleCompact, projected && { color: tc.tint }]}
        numberOfLines={compact ? 1 : 2}
      >
        {task.title}
      </Text>
      {showTime && (
        <Text style={[styles.taskBlockTime, projected && { color: tc.secondaryText }]} numberOfLines={1}>
          {projected ? `${label} · ${projectedDisplayLabel}` : label}
        </Text>
      )}
    </>
  );

  if (projected) {
    return (
      <Animated.View
        style={[
          styles.taskBlock,
          {
            top,
            height,
            paddingVertical: compact ? 2 : 8,
            justifyContent: compact ? 'center' : undefined,
            backgroundColor: toRgba(tc.tint, isDark ? 0.18 : 0.1),
            borderColor: toRgba(tc.tint, isDark ? 0.7 : 0.45),
            borderStyle: 'dashed',
          },
          layoutStyle,
          animatedStyle,
        ]}
      >
        {blockContent}
      </Animated.View>
    );
  }

  return (
    <GestureDetector gesture={Gesture.Race(panGesture, tapGesture)}>
      <Animated.View
        style={[
          styles.taskBlock,
          {
            top,
            height,
            paddingVertical: compact ? 2 : 8,
            justifyContent: compact ? 'center' : undefined,
            backgroundColor: isDark ? toRgba(tc.tint, 0.85) : tc.tint,
            borderColor: toRgba(tc.tint, isDark ? 0.6 : 0.3),
          },
          layoutStyle,
          animatedStyle,
        ]}
      >
        {blockContent}
      </Animated.View>
    </GestureDetector>
  );
}

export function CalendarView() {
  const {
    DAY_END_HOUR,
    DAY_START_HOUR,
    PIXELS_PER_MINUTE,
    SNAP_MINUTES,
    calendarDays,
    calendarComposer,
    calendarComposerCandidates,
    calendarComposerError,
    calendarComposerSelectedTask,
    calendarSystem,
    calendarWeekVisibleDays,
    calendarNameById,
    closeCalendarComposer,
    closeEditingTask,
    commitTaskDrag,
    dayNames,
    editingTask,
    externalCalendars,
    externalError,
    formatHourLabel,
    formatTimeRange,
    getCalendarItemsForDate,
    getExternalEventsForDate,
    getScheduleSlotLabel,
    getTaskCountForDate,
    handleNextMonth,
    handlePrevMonth,
    handleTimelineContentLayout,
    handleTimelineScroll,
    handleToday,
    isDark,
    isExternalLoading,
    isSameDay,
    isToday,
    locale,
    tr,
    markTaskDone,
    monthLabel,
    planningTasks,
    openQuickAddForDate,
    openQuickAddAtDateTime,
    openExternalEvent,
    openTaskActions,
    saveEditingTask,
    saveCalendarComposer,
    scheduleQuery,
    scheduleTaskOnSelectedDate,
    searchCandidates,
    selectCalendarComposerTask,
    selectedDate,
    selectedDateDeadlines,
    selectedDateExternalEvents,
    selectedDateLongLabel,
    selectedDatePlanningLabel,
    selectedDateScheduled,
    selectedDateTimedEvents,
    selectedDayModeLabel,
    selectedDayNowTop,
    selectedDayScheduledTasks,
    selectedDayStart,
    selectedDayEnd,
    scheduleSections,
    setCalendarComposerDuration,
    setCalendarComposerEndTime,
    setCalendarComposerMode,
    setCalendarComposerQuery,
    setCalendarComposerStartTime,
    setCalendarComposerTitle,
    setCalendarWeekVisibleDays,
    setScheduleQuery,
    setSelectedDate,
    setTimelineScrollEnabled,
    setViewMode,
    shiftSelectedDate,
    showCompleted,
    toggleShowCompleted,
    sourceColorForId,
    t,
    tc,
    timeEstimateToMinutes,
    timelineHeight,
    timelineScrollRef,
    toRgba,
    viewMode,
    weekDays,
    weekLabel,
  } = useCalendarViewController();
  const reducedMotion = useReducedMotion();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const composerKeyboardInset = useAndroidKeyboardInset(Boolean(calendarComposer));
  const collapsedSheetSnap = Math.max(
    MONTH_DETAILS_COLLAPSED_SNAP,
    Math.min(MONTH_DETAILS_MID_SNAP, MONTH_DETAILS_MIN_HEIGHT / Math.max(screenHeight, 1))
  );
  const bottomSheetSnap = useSharedValue(collapsedSheetSnap);
  const bottomSheetStart = useSharedValue(collapsedSheetSnap);
  const navigationSwipeOffsetX = useSharedValue(0);
  const suppressMonthDayPressUntilRef = useRef(0);
  const weekHorizontalScrollRef = useRef<any>(null);
  const scheduleScrollRef = useRef<any>(null);
  const lastWeekAutoScrollKeyRef = useRef<string | null>(null);
  const [weekDensityTrackWidth, setWeekDensityTrackWidth] = useState(0);
  const weekScrollX = useSharedValue(0);
  const weekHorizontalScrollHandler = useAnimatedScrollHandler((event) => {
    weekScrollX.value = event.contentOffset.x;
  });
  // Zoomed-in weeks are wider than the screen, so without this the hour labels scroll away and
  // the grid loses its only time reference. Day columns pass underneath instead.
  const weekGutterPinStyle = useAnimatedStyle(() => ({ transform: [{ translateX: weekScrollX.value }] }));
  // The gutter is a column too: sizing days against the full screen width made the canvas
  // overflow by exactly the gutter, so the last day was clipped and the hour labels could be
  // scrolled off the left edge even at full-week zoom.
  const weekAvailableColumnWidth = Math.max(1, screenWidth - WEEK_TIME_GUTTER_WIDTH);
  const weekColumnWidth = getCalendarWeekColumnWidth(weekAvailableColumnWidth, calendarWeekVisibleDays);
  const compactWeekColumns = weekColumnWidth < 86;
  const ultraCompactWeekColumns = weekColumnWidth < 58;
  const weekDensityProgress = (calendarWeekVisibleDays - CALENDAR_WEEK_VISIBLE_DAYS_MIN)
    / (CALENDAR_WEEK_VISIBLE_DAYS_MAX - CALENDAR_WEEK_VISIBLE_DAYS_MIN);
  const composerStartTimePlaceholder = safeFormatDate(new Date(2000, 0, 1, 9, 0), 'p', '09:00');
  const composerEndTimePlaceholder = safeFormatDate(new Date(2000, 0, 1, 9, 30), 'p', '09:30');
  const selectedDayTimedLayouts = useMemo(() => {
    if (!selectedDayStart || !selectedDayEnd) return new Map<string, CalendarTimedLayout>();

    const dayStartMs = selectedDayStart.getTime();
    const dayEndMs = selectedDayEnd.getTime();
    const layoutItems: CalendarTimedLayoutInput[] = [];

    for (const event of selectedDateTimedEvents) {
      const start = safeParseDate(event.start);
      const end = safeParseDate(event.end);
      if (!start || !end) continue;
      const clampedStartMs = Math.max(start.getTime(), dayStartMs);
      const clampedEndMs = Math.min(end.getTime(), dayEndMs);
      if (clampedEndMs <= clampedStartMs) continue;
      layoutItems.push({
        id: `event:${event.id}`,
        startMinutes: (clampedStartMs - dayStartMs) / 60_000,
        endMinutes: (clampedEndMs - dayStartMs) / 60_000,
      });
    }

    for (const task of selectedDayScheduledTasks) {
      const start = task.startTime ? safeParseDate(task.startTime) : null;
      if (!start) continue;
      const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
      const endMs = start.getTime() + durationMinutes * 60_000;
      const clampedStartMs = Math.max(start.getTime(), dayStartMs);
      const clampedEndMs = Math.min(endMs, dayEndMs);
      if (clampedEndMs <= clampedStartMs) continue;
      layoutItems.push({
        id: `task:${task.id}`,
        startMinutes: (clampedStartMs - dayStartMs) / 60_000,
        endMinutes: (clampedEndMs - dayStartMs) / 60_000,
      });
    }

    return buildTimedCalendarLayouts(layoutItems);
  }, [selectedDateTimedEvents, selectedDayEnd, selectedDayScheduledTasks, selectedDayStart, timeEstimateToMinutes]);

  const closeMonthDetailsPane = () => {
    setSelectedDate(null);
  };

  const handleScheduleToday = useCallback(() => {
    handleToday();
    requestAnimationFrame(() => {
      const scheduleList = scheduleScrollRef.current;
      if (typeof scheduleList?.scrollToOffset === 'function') {
        scheduleList.scrollToOffset({ offset: 0, animated: !reducedMotion });
        return;
      }
      scheduleList?.scrollTo?.({ y: 0, animated: !reducedMotion });
    });
  }, [handleToday, reducedMotion]);

  useEffect(() => {
    if (selectedDate) {
      bottomSheetSnap.value = reducedMotion ? collapsedSheetSnap : withSpring(collapsedSheetSnap);
    }
  }, [bottomSheetSnap, collapsedSheetSnap, reducedMotion, selectedDate]);

  useEffect(() => {
    if (viewMode !== 'week') {
      lastWeekAutoScrollKeyRef.current = null;
      return;
    }

    const weekStartTime = weekDays[0]?.getTime() ?? 0;
    const selectedTime = selectedDate?.getTime() ?? 0;
    const autoScrollKey = `${weekStartTime}:${selectedTime}:${calendarWeekVisibleDays}:${weekColumnWidth}`;
    if (lastWeekAutoScrollKeyRef.current === autoScrollKey) return;
    lastWeekAutoScrollKeyRef.current = autoScrollKey;

    const x = getCalendarWeekInitialScrollX({
      columnWidth: weekColumnWidth,
      // The gutter stays pinned now, so the first day column already starts beside it.
      leadingInset: 0,
      selectedDate,
      visibleDays: calendarWeekVisibleDays,
      weekDays,
    });
    requestAnimationFrame(() => {
      weekHorizontalScrollRef.current?.scrollTo({
        x,
        animated: false,
      });
    });
  }, [calendarWeekVisibleDays, selectedDate, viewMode, weekColumnWidth, weekDays]);

  const updateWeekDensityFromTrack = useCallback((x: number) => {
    if (weekDensityTrackWidth <= 0) return;
    const ratio = Math.max(0, Math.min(1, x / weekDensityTrackWidth));
    const nextVisibleDays = Math.round(
      CALENDAR_WEEK_VISIBLE_DAYS_MIN
      + ratio * (CALENDAR_WEEK_VISIBLE_DAYS_MAX - CALENDAR_WEEK_VISIBLE_DAYS_MIN)
    );
    setCalendarWeekVisibleDays(nextVisibleDays);
  }, [setCalendarWeekVisibleDays, weekDensityTrackWidth]);

  const handleWeekDensityTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setWeekDensityTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const weekDensityGesture = useMemo(() => (
    Gesture.Pan()
      .minDistance(0)
      .onStart((event) => {
        runOnJS(updateWeekDensityFromTrack)(event.x);
      })
      .onUpdate((event) => {
        runOnJS(updateWeekDensityFromTrack)(event.x);
      })
  ), [updateWeekDensityFromTrack]);

  const handleWeekDensityAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'increment') {
      setCalendarWeekVisibleDays(Math.min(CALENDAR_WEEK_VISIBLE_DAYS_MAX, calendarWeekVisibleDays + 1));
      return;
    }
    if (event.nativeEvent.actionName === 'decrement') {
      setCalendarWeekVisibleDays(Math.max(CALENDAR_WEEK_VISIBLE_DAYS_MIN, calendarWeekVisibleDays - 1));
    }
  }, [calendarWeekVisibleDays, setCalendarWeekVisibleDays]);

  const bottomSheetGesture = Gesture.Pan()
    .hitSlop({ bottom: 16, top: 12 })
    .onStart(() => {
      bottomSheetStart.value = bottomSheetSnap.value;
    })
    .onUpdate((event) => {
      const next = bottomSheetStart.value - (event.translationY / Math.max(screenHeight, 1));
      bottomSheetSnap.value = Math.max(0, Math.min(MONTH_DETAILS_EXPANDED_SNAP, next));
    })
    .onEnd((event) => {
      const shouldHide = bottomSheetSnap.value <= MONTH_DETAILS_HIDE_THRESHOLD || event.velocityY > 900;
      if (shouldHide) {
        if (reducedMotion) {
          bottomSheetSnap.value = 0;
          runOnJS(closeMonthDetailsPane)();
        } else {
          bottomSheetSnap.value = withSpring(0, undefined, (finished) => {
            if (finished) {
              runOnJS(closeMonthDetailsPane)();
            }
          });
        }
        return;
      }

      const snapPoints = [collapsedSheetSnap, MONTH_DETAILS_MID_SNAP, MONTH_DETAILS_EXPANDED_SNAP];
      let nearest = snapPoints[0];
      let nearestDistance = Math.abs(bottomSheetSnap.value - nearest);
      for (const snap of snapPoints) {
        const distance = Math.abs(bottomSheetSnap.value - snap);
        if (distance < nearestDistance) {
          nearest = snap;
          nearestDistance = distance;
        }
      }
      bottomSheetSnap.value = reducedMotion ? nearest : withSpring(nearest);
    });
  const bottomSheetStyle = useAnimatedStyle(() => ({
    height: screenHeight * bottomSheetSnap.value,
  }));
  const calendarNavigationSwipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: navigationSwipeOffsetX.value }],
  }));

  const triggerDragHaptic = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const shouldCaptureCalendarNavigationSwipe = useCallback((_event: GestureResponderEvent, gestureState: PanResponderGestureState) => {
    const translationX = gestureState.dx;
    const translationY = gestureState.dy;
    const horizontalDistance = Math.abs(translationX);
    const verticalDrift = Math.abs(translationY);
    return (
      horizontalDistance >= CALENDAR_NAVIGATION_CAPTURE_DISTANCE
      && verticalDrift <= CALENDAR_NAVIGATION_SWIPE_VERTICAL_TOLERANCE
      && verticalDrift <= horizontalDistance * CALENDAR_NAVIGATION_SWIPE_VERTICAL_RATIO
    );
  }, []);

  const updateCalendarNavigationSwipeFeedback = useCallback((gestureState: PanResponderGestureState) => {
    const clamped = Math.max(
      -CALENDAR_NAVIGATION_FEEDBACK_DISTANCE,
      Math.min(CALENDAR_NAVIGATION_FEEDBACK_DISTANCE, gestureState.dx * 0.7)
    );
    navigationSwipeOffsetX.value = clamped;
  }, [navigationSwipeOffsetX]);

  const finishCalendarNavigationSwipe = useCallback((mode: CalendarNavigationMode, gestureState: PanResponderGestureState) => {
    const velocityX = Math.abs(gestureState.vx) < 20 ? gestureState.vx * 1000 : gestureState.vx;
    const direction = getCalendarNavigationSwipeDirection({
      translationX: gestureState.dx,
      translationY: gestureState.dy,
      velocityX,
    });
    if (!direction) {
      navigationSwipeOffsetX.value = reducedMotion ? 0 : withSpring(0);
      return;
    }

    triggerDragHaptic();
    const snapOffset = direction === 1
      ? Math.min(screenWidth * 0.18, CALENDAR_NAVIGATION_FEEDBACK_DISTANCE)
      : -Math.min(screenWidth * 0.18, CALENDAR_NAVIGATION_FEEDBACK_DISTANCE);
    navigationSwipeOffsetX.value = reducedMotion
      ? 0
      : withSequence(
        withTiming(snapOffset, { duration: 70 }),
        withSpring(0)
      );

    if (mode === 'month') {
      suppressMonthDayPressUntilRef.current = Date.now() + 350;
      if (direction === -1) handlePrevMonth();
      else handleNextMonth();
      return;
    }

    shiftSelectedDate(direction);
  }, [handleNextMonth, handlePrevMonth, navigationSwipeOffsetX, reducedMotion, screenWidth, shiftSelectedDate, triggerDragHaptic]);

  const cancelCalendarNavigationSwipe = useCallback(() => {
    navigationSwipeOffsetX.value = reducedMotion ? 0 : withSpring(0);
  }, [navigationSwipeOffsetX, reducedMotion]);

  const createCalendarNavigationResponder = useCallback((mode: CalendarNavigationMode) => (
    PanResponder.create({
      onMoveShouldSetPanResponder: shouldCaptureCalendarNavigationSwipe,
      onMoveShouldSetPanResponderCapture: shouldCaptureCalendarNavigationSwipe,
      onPanResponderMove: (_event, gestureState) => updateCalendarNavigationSwipeFeedback(gestureState),
      onPanResponderRelease: (_event, gestureState) => finishCalendarNavigationSwipe(mode, gestureState),
      onPanResponderTerminate: cancelCalendarNavigationSwipe,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onStartShouldSetPanResponder: () => false,
    })
  ), [
    cancelCalendarNavigationSwipe,
    finishCalendarNavigationSwipe,
    shouldCaptureCalendarNavigationSwipe,
    updateCalendarNavigationSwipeFeedback,
  ]);
  const monthNavigationResponder = useMemo(
    () => createCalendarNavigationResponder('month'),
    [createCalendarNavigationResponder]
  );
  const dayNavigationResponder = useMemo(
    () => createCalendarNavigationResponder('day'),
    [createCalendarNavigationResponder]
  );

  const handleMonthDayPress = (date: Date) => {
    if (Date.now() < suppressMonthDayPressUntilRef.current) return;
    setSelectedDate(date);
  };

  const modeOptions = [
    { value: 'month' as const, label: tr('calendar.mobile.month') },
    { value: 'day' as const, label: tr('calendar.mobile.day') },
    { value: 'week' as const, label: tr('calendar.mobile.week') },
    { value: 'schedule' as const, label: tr('calendar.scheduleResults') },
  ];
  const formatDurationLabel = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  };

  const renderModeToggle = () => (
    <View style={[styles.modeToggle, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
      {modeOptions.map((option) => {
        const active = viewMode === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => setViewMode(option.value)}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            style={[styles.modeToggleButton, active && { backgroundColor: tc.tint }]}
          >
            <Text style={[styles.modeToggleText, { color: active ? tc.onTint : tc.secondaryText }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  // Sits under the view-mode switcher in every calendar mode so the look-back
  // can be turned on from wherever you are (#955).
  const renderShowCompletedToggle = () => (
    <Pressable
      onPress={toggleShowCompleted}
      accessibilityRole="button"
      accessibilityLabel={tr('calendar.showCompletedHint')}
      accessibilityState={{ selected: showCompleted }}
      style={[
        styles.showCompletedToggle,
        {
          backgroundColor: showCompleted ? toRgba(tc.tint, isDark ? 0.24 : 0.14) : tc.inputBg,
          borderColor: showCompleted ? tc.tint : tc.border,
        },
      ]}
    >
      <Text style={[styles.showCompletedToggleText, { color: showCompleted ? tc.tint : tc.secondaryText }]}>
        {tr('calendar.showCompleted')}
      </Text>
    </Pressable>
  );

  const renderCalendarComposer = () => (
    <CalendarTaskComposerModal
      bottomInset={insets.bottom}
      candidates={calendarComposerCandidates}
      closeComposer={closeCalendarComposer}
      composer={calendarComposer}
      endTimePlaceholder={composerEndTimePlaceholder}
      error={calendarComposerError}
      formatDurationLabel={formatDurationLabel}
      isDark={isDark}
      keyboardInset={composerKeyboardInset}
      locale={locale}
      saveComposer={saveCalendarComposer}
      selectTask={selectCalendarComposerTask}
      selectedTask={calendarComposerSelectedTask}
      setDuration={setCalendarComposerDuration}
      setEndTime={setCalendarComposerEndTime}
      setMode={setCalendarComposerMode}
      setQuery={setCalendarComposerQuery}
      setStartTime={setCalendarComposerStartTime}
      setTitle={setCalendarComposerTitle}
      startTimePlaceholder={composerStartTimePlaceholder}
      t={t}
      tc={tc}
      toRgba={toRgba}
      tr={tr}
    />
  );

  if (viewMode === 'day' && selectedDate && selectedDayStart && selectedDayEnd) {
    const allDayItems = getCalendarItemsForDate(selectedDate)
      .filter((item) => (
        item.kind === 'deadline'
        || item.kind === 'completed'
        || (item.kind === 'scheduled' && isAllDayScheduledTask(item.task))
        || (item.kind === 'event' && item.event.allDay)
      ));
    const handleDayTimelinePress = (event: GestureResponderEvent) => {
      const dayMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
      const defaultDurationMinutes = 30;
      const rawMinutes = event.nativeEvent.locationY / PIXELS_PER_MINUTE;
      const snappedMinutes = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
      const clampedMinutes = Math.max(0, Math.min(dayMinutes - defaultDurationMinutes, snappedMinutes));
      openQuickAddAtDateTime(new Date(selectedDayStart.getTime() + clampedMinutes * 60_000));
    };

    return (
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        <View style={[styles.dayModeHeader, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <CalendarPeriodNavigation
            label={selectedDayModeLabel}
            nextLabel={tr('calendar.nextDay')}
            onNext={() => shiftSelectedDate(1)}
            onPrevious={() => shiftSelectedDate(-1)}
            onToday={handleToday}
            previousLabel={tr('calendar.prevDay')}
            tc={tc}
            titleVariant="day"
            todayLabel={tr('filters.datePreset.today')}
          />
          {renderModeToggle()}
          {renderShowCompletedToggle()}
        </View>

        <View style={styles.daySwipeArea} {...dayNavigationResponder.panHandlers}>
          <Animated.View style={[styles.calendarNavigationContent, calendarNavigationSwipeStyle]}>
            {/* Pinned above the timeline, like the week view's all-day row. Inside
                the timeline ScrollView it scrolled out of sight the moment the
                view auto-scrolled to the current time, so all-day items looked
                missing on today. */}
            {allDayItems.length > 0 && (
              <View style={[styles.allDayCard, styles.allDayPinned, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>{t('calendar.allDay')}</Text>
                <ScrollView style={styles.allDayList}>
                {allDayItems.map((item) => {
                  const task = item.kind === 'event' ? null : item.task;
                  const projected = task ? isProjectedRecurringTask(task) : false;
                  const projectedDisplayLabel = projected && task
                    ? getProjectedRecurrenceDisplayLabel(task, tr('calendar.projectedRecurrence'))
                    : '';
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => {
                        if (item.kind === 'event') openExternalEvent(item.event);
                        else openTaskActions(item.task.id);
                      }}
                      style={styles.allDayPressable}
                    >
                      <Text style={[styles.allDayItem, { color: projected ? tc.tint : tc.text }]} numberOfLines={1}>
                        {projected ? `${item.title} · ${projectedDisplayLabel}` : item.title}
                      </Text>
                    </Pressable>
                  );
                })}
                </ScrollView>
              </View>
            )}

            <ScrollView
              ref={timelineScrollRef}
              style={styles.dayScroll}
              contentContainerStyle={styles.dayScrollContent}
              onScroll={handleTimelineScroll}
              scrollEventThrottle={16}
            >
            <View
              onLayout={handleTimelineContentLayout}
              style={[styles.timelineCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
            >
              <View style={[styles.timelineArea, { height: timelineHeight }]}>
                <Pressable onPress={handleDayTimelinePress} style={styles.timelineTapTarget} />
                {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, idx) => {
                  const hour = DAY_START_HOUR + idx;
                  const top = idx * 60 * PIXELS_PER_MINUTE;
                  return (
                    <View key={hour} pointerEvents="none" style={[styles.hourLine, { top }]}>
                      <CompactText style={[styles.hourLabel, { color: tc.secondaryText }]} numberOfLines={1}>
                        {formatHourLabel(hour)}
                      </CompactText>
                      <View style={[styles.hourDivider, { backgroundColor: tc.border }]} />
                    </View>
                  );
                })}

                {selectedDayNowTop != null && (
                  <View pointerEvents="none" style={[styles.nowLine, { top: selectedDayNowTop }]}>
                    <View style={styles.nowDot} />
                    <View style={styles.nowRule} />
                  </View>
                )}

                <View pointerEvents="box-none" style={styles.timelineItemsLayer}>
                  {selectedDateTimedEvents.map((event) => {
                    const start = safeParseDate(event.start);
                    const end = safeParseDate(event.end);
                    if (!start || !end) return null;
                    const clampedStart = new Date(Math.max(start.getTime(), selectedDayStart.getTime()));
                    const clampedEnd = new Date(Math.min(end.getTime(), selectedDayEnd.getTime()));
                    const startMinutes = (clampedStart.getTime() - selectedDayStart.getTime()) / 60_000;
                    const endMinutes = (clampedEnd.getTime() - selectedDayStart.getTime()) / 60_000;
                    const top = Math.max(0, startMinutes) * PIXELS_PER_MINUTE;
                    const height = Math.max(16, (endMinutes - startMinutes) * PIXELS_PER_MINUTE);
                    const timeLabel = formatTimeRange(clampedStart, Math.max(1, Math.round(endMinutes - startMinutes)));
                    const eventStyle = [
                      styles.eventBlock,
                      {
                        top,
                        height,
                        backgroundColor: toRgba(tc.secondaryText, isDark ? 0.35 : 0.18),
                        borderColor: sourceColorForId(event.sourceId),
                      },
                      getTimedBlockInsetStyle(selectedDayTimedLayouts.get(`event:${event.id}`)),
                    ];
                    const eventContent = (
                      <>
                        <Text style={[styles.eventBlockTitle, { color: tc.text }]} numberOfLines={1}>
                          {event.title}
                        </Text>
                        <Text style={[styles.eventBlockTime, { color: tc.secondaryText }]} numberOfLines={1}>
                          {timeLabel}
                        </Text>
                      </>
                    );
                    return (
                      <Pressable
                        key={event.id}
                        onPress={(pressEvent) => {
                          pressEvent.stopPropagation();
                          openExternalEvent(event);
                        }}
                        style={eventStyle}
                      >
                        {eventContent}
                      </Pressable>
                    );
                  })}

                  {selectedDayScheduledTasks.map((task) => {
                    const start = task.startTime ? safeParseDate(task.startTime) : null;
                    if (!start) return null;
                    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
                    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
                    const clampedStart = new Date(Math.max(start.getTime(), selectedDayStart.getTime()));
                    const clampedEnd = new Date(Math.min(end.getTime(), selectedDayEnd.getTime()));
                    const startMinutes = (clampedStart.getTime() - selectedDayStart.getTime()) / 60_000;
                    const endMinutes = (clampedEnd.getTime() - selectedDayStart.getTime()) / 60_000;
                    const top = Math.max(0, startMinutes) * PIXELS_PER_MINUTE;
                    const height = Math.max(24, (endMinutes - startMinutes) * PIXELS_PER_MINUTE);
                    return (
                      <ScheduledTaskBlock
                        key={task.id}
                        DAY_END_HOUR={DAY_END_HOUR}
                        DAY_START_HOUR={DAY_START_HOUR}
                        PIXELS_PER_MINUTE={PIXELS_PER_MINUTE}
                        SNAP_MINUTES={SNAP_MINUTES}
                        commitTaskDrag={commitTaskDrag}
                        task={task}
                        dayStartMs={selectedDayStart.getTime()}
                        top={top}
                        height={height}
                        durationMinutes={durationMinutes}
                        formatTimeRange={formatTimeRange}
                        isDark={isDark}
                        layoutStyle={getTimedBlockInsetStyle(selectedDayTimedLayouts.get(`task:${task.id}`))}
                        openTaskActions={openTaskActions}
                        projectedLabel={tr('calendar.projectedRecurrence')}
                        reducedMotion={reducedMotion}
                        setTimelineScrollEnabled={setTimelineScrollEnabled}
                        tc={tc}
                        toRgba={toRgba}
                        triggerDragHaptic={triggerDragHaptic}
                      />
                    );
                  })}
                </View>
              </View>
            </View>

            <View style={[styles.dayScheduleCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <View style={styles.addTaskForm}>
                <TextInput
                  style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={scheduleQuery}
                  onChangeText={setScheduleQuery}
                  placeholder={t('calendar.schedulePlaceholder')}
                  placeholderTextColor={tc.secondaryText}
                />
              </View>

              {searchCandidates.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {t('calendar.scheduleResults')}
                  </Text>
                  {searchCandidates.map((task) => {
                    const slotLabel = getScheduleSlotLabel(selectedDate, task);
                    return (
                      <Pressable
                        key={task.id}
                        style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                        onPress={() => scheduleTaskOnSelectedDate(task.id)}
                      >
                        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                          {task.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                          {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
            </ScrollView>
          </Animated.View>
        </View>

        {renderCalendarComposer()}

        <TaskEditModal
          visible={Boolean(editingTask)}
          task={editingTask}
          onClose={closeEditingTask}
          onSave={saveEditingTask}
          defaultTab="view"
          onProjectNavigate={openProjectScreen}
          onContextNavigate={openContextsScreen}
          onTagNavigate={openContextsScreen}
        />
      </View>
    );
  }

  if (viewMode === 'week') {
    return (
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <CalendarPeriodNavigation
            label={weekLabel}
            nextLabel={tr('calendar.nextWeek')}
            onNext={() => shiftSelectedDate(7)}
            onPrevious={() => shiftSelectedDate(-7)}
            onToday={handleToday}
            previousLabel={tr('calendar.prevWeek')}
            tc={tc}
            todayLabel={tr('filters.datePreset.today')}
          />
          {renderModeToggle()}
          {renderShowCompletedToggle()}
        </View>

        <AnimatedWeekScrollView
          ref={weekHorizontalScrollRef}
          horizontal
          nestedScrollEnabled
          onScroll={weekHorizontalScrollHandler}
          scrollEventThrottle={16}
          // Land on whole days: a half-scrolled column hides its own header under the pinned gutter.
          snapToInterval={weekColumnWidth}
          snapToAlignment="start"
          decelerationRate="fast"
          style={styles.weekHorizontal}
          contentContainerStyle={styles.weekHorizontalContent}
        >
          <View style={[styles.weekCanvas, { width: WEEK_TIME_GUTTER_WIDTH + weekColumnWidth * weekDays.length }]}>
            <View style={[styles.weekHeaderRow, { borderBottomColor: tc.border }]}>
              <Animated.View style={[styles.weekTimeGutter, styles.weekTimeGutterPinned, { backgroundColor: tc.bg }, weekGutterPinStyle]} />
              {weekDays.map((day) => (
                <Pressable
                  key={`header-${day.toISOString()}`}
                  onPress={() => {
                    setSelectedDate(day);
                    setViewMode('day');
                  }}
                  style={[styles.weekDayHeader, { width: weekColumnWidth, borderLeftColor: tc.border }, isToday(day) && { backgroundColor: toRgba(tc.tint, isDark ? 0.2 : 0.1) }]}
                >
                  <Text style={[styles.weekDayName, compactWeekColumns && styles.weekDayNameCompact, { color: tc.secondaryText }]}>
                    {getShortWeekdayLabels(locale)[day.getDay()]}
                  </Text>
                  <Text style={[styles.weekDayNumber, compactWeekColumns && styles.weekDayNumberCompact, { color: isToday(day) ? tc.tint : tc.text }]}>
                    {day.getDate()}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={[styles.weekAllDayRow, { borderBottomColor: tc.border }]}>
              <Animated.View style={[styles.weekTimeGutter, styles.weekTimeGutterPinned, { backgroundColor: tc.bg }, weekGutterPinStyle]}>
                <Text style={[styles.weekAllDayLabel, { color: tc.secondaryText }]}>{t('calendar.allDay')}</Text>
              </Animated.View>
              {weekDays.map((day) => {
                const allDayItems = getCalendarItemsForDate(day)
                  .filter((item) =>
                    item.kind === 'deadline'
                    || item.kind === 'completed'
                    || (item.kind === 'scheduled' && isAllDayScheduledTask(item.task))
                    || (item.kind === 'event' && item.event.allDay)
                  )
                  .slice(0, 3);
                return (
                  <View key={`all-${day.toISOString()}`} style={[styles.weekAllDayCell, compactWeekColumns && styles.weekAllDayCellCompact, { width: weekColumnWidth, borderLeftColor: tc.border }]}>
                    {allDayItems.map((item) => {
                      const isEvent = item.kind === 'event';
                      const projected = item.kind !== 'event' && isProjectedRecurringTask(item.task);
                      const projectedDisplayLabel = projected
                        ? getProjectedRecurrenceDisplayLabel(item.task, tr('calendar.projectedRecurrence'))
                        : '';
                      return (
                        <Pressable
                          key={item.id}
                          disabled={projected}
                          onPress={(pressEvent) => {
                            pressEvent.stopPropagation();
                            if (item.kind === 'event') openExternalEvent(item.event);
                            else openTaskActions(item.task.id);
                          }}
                          style={[
                            styles.weekAllDayItem,
                            compactWeekColumns && styles.weekAllDayItemCompact,
                            {
                              backgroundColor: isEvent ? toRgba(tc.secondaryText, isDark ? 0.28 : 0.14) : tc.inputBg,
                              borderLeftColor: isEvent
                                ? sourceColorForId(item.event.sourceId)
                                : projected
                                  ? tc.tint
                                  : tc.danger,
                              borderStyle: projected ? 'dashed' : 'solid',
                            },
                          ]}
                        >
                          <Text style={[styles.weekAllDayText, compactWeekColumns && styles.weekAllDayTextCompact, { color: tc.text }]} numberOfLines={1}>
                            {projected ? `${item.title} · ${projectedDisplayLabel}` : item.title}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
            </View>

            <ScrollView
              ref={timelineScrollRef}
              nestedScrollEnabled
              style={styles.weekVertical}
              contentContainerStyle={styles.weekVerticalContent}
            >
              <View style={styles.weekGridRow}>
                <Animated.View style={[styles.weekTimeGutter, styles.weekTimeGutterPinned, { backgroundColor: tc.bg, height: timelineHeight }, weekGutterPinStyle]}>
                  {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, idx) => {
                    const hour = DAY_START_HOUR + idx;
                    return (
                      <CompactText
                        key={hour}
                        style={[styles.weekHourLabel, { top: idx * 60 * PIXELS_PER_MINUTE, color: tc.secondaryText }]}
                        numberOfLines={1}
                      >
                        {formatHourLabel(hour)}
                      </CompactText>
                    );
                  })}
                </Animated.View>
                {weekDays.map((day) => {
                  const now = new Date();
                  const nowMinutes = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
                  const showNow = isToday(day) && nowMinutes >= 0 && nowMinutes <= (DAY_END_HOUR - DAY_START_HOUR) * 60;
                  const dayStart = new Date(day);
                  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
                  const dayEnd = new Date(day);
                  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
                  const dayStartMs = dayStart.getTime();
                  const dayEndMs = dayEnd.getTime();
                  const timedItems = getCalendarItemsForDate(day)
                    .filter((item) =>
                      (item.kind === 'scheduled' && isTimedScheduledTask(item.task))
                      || (item.kind === 'event' && !item.event.allDay)
                    );
                  const timedLayoutInputs: CalendarTimedLayoutInput[] = [];
                  for (const item of timedItems) {
                    if (item.kind === 'event') {
                      const start = safeParseDate(item.event.start);
                      const end = safeParseDate(item.event.end);
                      if (!start || !end) continue;
                      const clampedStartMs = Math.max(start.getTime(), dayStartMs);
                      const clampedEndMs = Math.min(end.getTime(), dayEndMs);
                      if (clampedEndMs <= clampedStartMs) continue;
                      timedLayoutInputs.push({
                        id: `event:${item.event.id}`,
                        startMinutes: (clampedStartMs - dayStartMs) / 60_000,
                        endMinutes: (clampedEndMs - dayStartMs) / 60_000,
                      });
                      continue;
                    }

                    const start = item.task.startTime ? safeParseDate(item.task.startTime) : null;
                    if (!start) continue;
                    const durationMinutes = timeEstimateToMinutes(item.task.timeEstimate);
                    const endMs = start.getTime() + durationMinutes * 60_000;
                    const clampedStartMs = Math.max(start.getTime(), dayStartMs);
                    const clampedEndMs = Math.min(endMs, dayEndMs);
                    if (clampedEndMs <= clampedStartMs) continue;
                    timedLayoutInputs.push({
                      id: `task:${item.task.id}`,
                      startMinutes: (clampedStartMs - dayStartMs) / 60_000,
                      endMinutes: (clampedEndMs - dayStartMs) / 60_000,
                    });
                  }
                  const timedLayouts = buildTimedCalendarLayouts(timedLayoutInputs);
                  return (
                    <Pressable
                      key={`grid-${day.toISOString()}`}
                      onPress={() => openQuickAddForDate(day)}
                      style={[styles.weekDayColumn, { width: weekColumnWidth, height: timelineHeight, borderLeftColor: tc.border }, isToday(day) && { backgroundColor: toRgba(tc.tint, isDark ? 0.1 : 0.05) }]}
                    >
                      {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, idx) => (
                        <View key={idx} style={[styles.weekHourRule, { top: idx * 60 * PIXELS_PER_MINUTE, backgroundColor: tc.border }]} />
                      ))}
                      {showNow && (
                        <View style={[styles.weekNowLine, { top: nowMinutes * PIXELS_PER_MINUTE }]}>
                          <View style={styles.nowDot} />
                          <View style={styles.nowRule} />
                        </View>
                      )}
                      <View
                        pointerEvents="box-none"
                        style={[
                          styles.weekTimedItemsLayer,
                          compactWeekColumns && styles.weekTimedItemsLayerCompact,
                          ultraCompactWeekColumns && styles.weekTimedItemsLayerUltraCompact,
                        ]}
                      >
                        {timedItems.map((item) => {
                          if (item.kind === 'event') {
                            const start = safeParseDate(item.event.start);
                            const end = safeParseDate(item.event.end);
                            if (!start || !end) return null;
                            const displayStart = new Date(Math.max(start.getTime(), dayStartMs));
                            const displayEnd = new Date(Math.min(end.getTime(), dayEndMs));
                            const top = ((displayStart.getTime() - dayStartMs) / 60_000) * PIXELS_PER_MINUTE;
                            const height = Math.max(24, ((displayEnd.getTime() - displayStart.getTime()) / 60_000) * PIXELS_PER_MINUTE);
                            const eventStyle = [
                              styles.weekBlock,
                              compactWeekColumns && styles.weekBlockCompact,
                              ultraCompactWeekColumns && styles.weekBlockUltraCompact,
                              {
                                top,
                                height,
                                backgroundColor: toRgba(tc.secondaryText, isDark ? 0.32 : 0.16),
                                borderLeftColor: sourceColorForId(item.event.sourceId),
                              },
                              getTimedBlockInsetStyle(timedLayouts.get(`event:${item.event.id}`)),
                            ];
                            const eventContent = (
                              <>
                                <Text style={[styles.weekBlockTitle, compactWeekColumns && styles.weekBlockTitleCompact, { color: tc.text }]} numberOfLines={compactWeekColumns ? 2 : 1}>{item.title}</Text>
                                {!compactWeekColumns && (
                                  <Text style={[styles.weekBlockTime, { color: tc.secondaryText }]} numberOfLines={1}>
                                    {`${safeFormatDate(displayStart, 'p')}-${safeFormatDate(displayEnd, 'p')}`}
                                  </Text>
                                )}
                              </>
                            );
                            return (
                              <Pressable
                                key={item.id}
                                onPress={(pressEvent) => {
                                  pressEvent.stopPropagation();
                                  openExternalEvent(item.event);
                                }}
                                style={eventStyle}
                              >
                                {eventContent}
                              </Pressable>
                            );
                          }

                          const projected = isProjectedRecurringTask(item.task);
                          const start = item.task.startTime ? safeParseDate(item.task.startTime) : null;
                          if (!start) return null;
                          const projectedDisplayLabel = projected
                            ? getProjectedRecurrenceDisplayLabel(item.task, tr('calendar.projectedRecurrence'))
                            : '';
                          const durationMinutes = timeEstimateToMinutes(item.task.timeEstimate);
                          const displayStartMs = Math.max(start.getTime(), dayStartMs);
                          const displayEndMs = Math.min(start.getTime() + durationMinutes * 60_000, dayEndMs);
                          const top = ((displayStartMs - dayStartMs) / 60_000) * PIXELS_PER_MINUTE;
                          const height = Math.max(24, ((displayEndMs - displayStartMs) / 60_000) * PIXELS_PER_MINUTE);
                          return (
                            <Pressable
                              key={item.id}
                              disabled={projected}
                              onPress={(event) => {
                                event.stopPropagation();
                                if (projected) return;
                                openTaskActions(item.task.id);
                              }}
                              style={[
                                styles.weekBlock,
                                compactWeekColumns && styles.weekBlockCompact,
                                ultraCompactWeekColumns && styles.weekBlockUltraCompact,
                                {
                                  top,
                                  height,
                                  backgroundColor: projected
                                    ? toRgba(tc.tint, isDark ? 0.18 : 0.1)
                                    : isDark ? toRgba(tc.tint, 0.85) : tc.tint,
                                  borderLeftColor: tc.tint,
                                  borderStyle: projected ? 'dashed' : 'solid',
                                },
                                getTimedBlockInsetStyle(timedLayouts.get(`task:${item.task.id}`)),
                              ]}
                            >
                              <Text style={[styles.weekTaskBlockTitle, compactWeekColumns && styles.weekTaskBlockTitleCompact, projected && { color: tc.tint }]} numberOfLines={compactWeekColumns ? 2 : 1}>{item.title}</Text>
                              {!compactWeekColumns && (
                                <Text style={[styles.weekTaskBlockTime, projected && { color: tc.secondaryText }]} numberOfLines={1}>
                                  {projected ? `${formatTimeRange(start, durationMinutes)} · ${projectedDisplayLabel}` : formatTimeRange(start, durationMinutes)}
                                </Text>
                              )}
                            </Pressable>
                          );
                        })}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        </AnimatedWeekScrollView>

        <View style={[styles.weekDensityBar, { backgroundColor: tc.cardBg, borderTopColor: tc.border, paddingBottom: Math.max(12, insets.bottom + 8) }]}>
          <GestureDetector gesture={weekDensityGesture}>
            <View
              onLayout={handleWeekDensityTrackLayout}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={tr('calendar.mobile.visibleWeekDays')}
              accessibilityHint={tr('calendar.mobile.swipeUpOrDownToShowMoreOrFewerDays')}
              accessibilityValue={{
                min: CALENDAR_WEEK_VISIBLE_DAYS_MIN,
                max: CALENDAR_WEEK_VISIBLE_DAYS_MAX,
                now: calendarWeekVisibleDays,
                text: calendarWeekVisibleDays === 1
                  ? tr('calendar.mobile.1Day')
                  : tr('calendar.mobile.visibleDayCount', { dayCount: calendarWeekVisibleDays }),
              }}
              accessibilityActions={[
                { name: 'increment', label: tr('calendar.mobile.showMoreDays') },
                { name: 'decrement', label: tr('calendar.mobile.showFewerDays') },
              ]}
              onAccessibilityAction={handleWeekDensityAccessibilityAction}
              style={[styles.weekDensityTrack, { backgroundColor: tc.border }]}
            >
              <View style={[styles.weekDensityTrackFill, { width: `${weekDensityProgress * 100}%`, backgroundColor: tc.tint }]} />
              <View
                style={[
                  styles.weekDensityThumb,
                  {
                    backgroundColor: tc.tint,
                    borderColor: tc.cardBg,
                    left: `${weekDensityProgress * 100}%`,
                  },
                ]}
              />
            </View>
          </GestureDetector>
          <View style={styles.weekDensityTicks}>
            {WEEK_DENSITY_VALUES.map((value) => {
              const active = value === calendarWeekVisibleDays;
              return (
                <Pressable
                  key={value}
                  onPress={() => setCalendarWeekVisibleDays(value)}
                  accessibilityRole="button"
                  accessibilityLabel={value === 1
                    ? tr('calendar.mobile.show1VisibleDay')
                    : tr('calendar.mobile.showVisibleDayCount', { dayCount: value })}
                  accessibilityState={{ selected: active }}
                  hitSlop={8}
                  style={styles.weekDensityTick}
                >
                  <Text style={[styles.weekDensityTickText, { color: active ? tc.tint : tc.secondaryText }]}>
                    {value}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {renderCalendarComposer()}

        <TaskEditModal
          visible={Boolean(editingTask)}
          task={editingTask}
          onClose={closeEditingTask}
          onSave={saveEditingTask}
          defaultTab="view"
          onProjectNavigate={openProjectScreen}
          onContextNavigate={openContextsScreen}
          onTagNavigate={openContextsScreen}
        />
      </View>
    );
  }

  if (viewMode === 'schedule') {
    return (
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <View style={styles.headerTopRow}>
            <View style={styles.monthTitleWrap}>
              <Text style={[styles.title, { color: tc.text }]}>{tr('calendar.scheduleResults')}</Text>
              <Pressable
                onPress={handleScheduleToday}
                accessibilityRole="button"
                accessibilityLabel={tr('filters.datePreset.today')}
                style={[styles.todayButton, { borderColor: tc.border }]}
              >
                <Text style={[styles.todayButtonText, { color: tc.tint }]}>{tr('filters.datePreset.today')}</Text>
              </Pressable>
            </View>
          </View>
          {renderModeToggle()}
          {renderShowCompletedToggle()}
        </View>

        <FlatList
          ref={scheduleScrollRef}
          data={scheduleSections}
          style={styles.scheduleScroll}
          contentContainerStyle={styles.scheduleContent}
          keyExtractor={(section) => section.id}
          ListHeaderComponent={selectedDate && planningTasks.length > 0 ? (
            <PlanningTaskList
              getScheduleSlotLabel={getScheduleSlotLabel}
              planningTasks={planningTasks}
              scheduleTaskOnSelectedDate={scheduleTaskOnSelectedDate}
              selectedDate={selectedDate}
              selectedDatePlanningLabel={selectedDatePlanningLabel}
              t={t}
              tc={tc}
              tr={tr}
              variant="section"
            />
          ) : null}
          renderItem={({ item: section }) => (
            <View style={styles.scheduleSection}>
              <Text style={[styles.scheduleDate, { color: tc.secondaryText }]}>
                {section.date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                {isToday(section.date) ? ` · ${tr('filters.datePreset.today')}` : ''}
              </Text>
              <View style={styles.scheduleItems}>
                {section.items.map((item) => {
                  if (item.kind === 'event') {
                    const start = safeParseDate(item.event.start);
                    const end = safeParseDate(item.event.end);
                    const timeLabel = item.event.allDay
                      ? t('calendar.allDay')
                        : start && end
                          ? `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`
                          : '';
                    const sourceName = calendarNameById.get(item.event.sourceId);
                    const eventStyle = [
                      styles.scheduleItem,
                      styles.eventItem,
                      {
                        backgroundColor: tc.inputBg,
                        borderLeftColor: sourceColorForId(item.event.sourceId),
                      },
                    ];
                    const eventContent = (
                      <View style={styles.taskItemMain}>
                        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]} numberOfLines={1}>
                          {sourceName ? `${timeLabel} · ${sourceName}` : timeLabel}
                        </Text>
                      </View>
                    );
                    return (
                      <Pressable
                        key={item.id}
                        onPress={() => openExternalEvent(item.event)}
                        accessibilityRole="button"
                        accessibilityLabel={sourceName ? `${item.title}. ${timeLabel}. ${sourceName}` : `${item.title}. ${timeLabel}`}
                        style={eventStyle}
                      >
                        {eventContent}
                      </Pressable>
                    );
                  }

                  const projected = isProjectedRecurringTask(item.task);
                  const completed = item.kind === 'completed';
                  const start = item.task.startTime ? safeParseDate(item.task.startTime) : null;
                  const timeLabel = completed
                    ? (item.start ? safeFormatDate(item.start, 'p') : t('status.done'))
                    : start && isAllDayScheduledTask(item.task)
                    ? t('calendar.allDay')
                    : start
                    ? formatTimeRange(start, timeEstimateToMinutes(item.task.timeEstimate))
                    : t('calendar.deadline');
                  const projectedDisplayLabel = projected
                    ? getProjectedRecurrenceDisplayLabel(item.task, tr('calendar.projectedRecurrence'))
                    : '';
                  return (
                    <Pressable
                      key={item.id}
                      disabled={projected}
                      accessibilityRole="button"
                      accessibilityLabel={projected ? `${item.title}. ${timeLabel}. ${projectedDisplayLabel}` : `${item.title}. ${timeLabel}`}
                      accessibilityState={{ disabled: projected }}
                      style={[
                        styles.scheduleItem,
                        {
                          backgroundColor: item.kind === 'scheduled' || projected ? toRgba(tc.tint, isDark ? 0.2 : 0.12) : tc.inputBg,
                          borderLeftColor: completed ? tc.secondaryText : item.kind === 'scheduled' ? tc.tint : tc.danger,
                          borderStyle: projected ? 'dashed' : 'solid',
                          opacity: completed ? 0.7 : 1,
                        },
                      ]}
                      onPress={() => {
                        if (!projected) openTaskActions(item.task.id);
                      }}
                    >
                      <View style={styles.taskItemMain}>
                        <Text
                          style={[
                            styles.taskItemTitle,
                            { color: completed ? tc.secondaryText : tc.text },
                            completed && { textDecorationLine: 'line-through' as const },
                          ]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                          {projected ? `${timeLabel} · ${projectedDisplayLabel}` : timeLabel}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
          ListEmptyComponent={planningTasks.length > 0 ? null : (
            <Text style={[styles.noTasks, { color: tc.secondaryText }]}>{t('calendar.noTasks')}</Text>
          )}
          removeClippedSubviews={false}
        />

        {renderCalendarComposer()}

        <TaskEditModal
          visible={Boolean(editingTask)}
          task={editingTask}
          onClose={closeEditingTask}
          onSave={saveEditingTask}
          defaultTab="view"
          onProjectNavigate={openProjectScreen}
          onContextNavigate={openContextsScreen}
          onTagNavigate={openContextsScreen}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <CalendarPeriodNavigation
          label={monthLabel}
          nextLabel={tr('calendar.nextMonth')}
          onNext={handleNextMonth}
          onPrevious={handlePrevMonth}
          onToday={handleToday}
          previousLabel={tr('calendar.prevMonth')}
          tc={tc}
          todayLabel={tr('filters.datePreset.today')}
        />
        {renderModeToggle()}
        {renderShowCompletedToggle()}
      </View>

      <View style={styles.monthCalendar} {...monthNavigationResponder.panHandlers}>
        <Animated.View style={calendarNavigationSwipeStyle}>
          <View style={[styles.dayHeaders, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
            {dayNames.map((day) => (
              <View key={day} style={styles.dayHeader}>
                <Text style={[styles.dayHeaderText, { color: tc.secondaryText }]}>{day}</Text>
              </View>
            ))}
          </View>

          <View style={[styles.calendarGrid, selectedDate && styles.calendarGridCompact]}>
            {calendarDays.map((day, index) => {
              if (day === null) {
                return <View key={`empty-${index}`} style={[styles.dayCell, selectedDate && styles.dayCellCompact]} />;
              }

              const date = day;
              const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
              const taskCount = getTaskCountForDate(date);
              const eventCount = getExternalEventsForDate(date).length;
              const calendarItems = getCalendarItemsForDate(date);
              // One-off items claim the cell's few visible rows before
              // projected recurring occurrences, which repeat every day.
              const visibleItems = orderCalendarDayItemsForLimitedSlots(calendarItems)
                .slice(0, calendarItems.length >= 6 ? 0 : 2);
              const showOverflowIndicator = calendarItems.length > visibleItems.length;
              const isSelected = selectedDate && isSameDay(date, selectedDate);
              const todayCellBg = toRgba(tc.tint, isDark ? 0.12 : 0.08);
              const selectedCellBg = toRgba(tc.tint, isDark ? 0.2 : 0.16);
              const dayAccessibilityParts = [
                date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' }),
                taskCount > 0 ? `${taskCount} ${t('common.tasks')}` : '',
                eventCount > 0 ? `${eventCount} ${tr('calendar.events')}` : '',
              ].filter(Boolean);

              return (
                <Pressable
                  key={dateKey}
                  style={[
                    styles.dayCell,
                    selectedDate && styles.dayCellCompact,
                    isToday(date) && { backgroundColor: todayCellBg },
                    isSelected && { backgroundColor: selectedCellBg },
                  ]}
                  onPress={() => handleMonthDayPress(date)}
                  accessibilityRole="button"
                  accessibilityLabel={dayAccessibilityParts.join('. ')}
                  accessibilityState={{ selected: Boolean(isSelected) }}
                >
                  <View
                    style={[
                      styles.dayNumber,
                      selectedDate && styles.dayNumberCompact,
                      isToday(date) && styles.todayNumber,
                      isToday(date) && { backgroundColor: tc.tint },
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayText,
                        selectedDate && styles.dayTextCompact,
                        { color: tc.text },
                        isToday(date) && styles.todayText,
                        isToday(date) && { color: tc.onTint },
                      ]}
                    >
                      {getCalendarDayOfMonth(date, calendarSystem)}
                    </Text>
                  </View>
                  {visibleItems.length > 0 && (
                    <View style={styles.monthPreviewList}>
                      {visibleItems.map((item) => {
                        const isEvent = item.kind === 'event';
                        const projected = item.kind !== 'event' && isProjectedRecurringTask(item.task);
                        const projectedDisplayLabel = projected
                          ? getProjectedRecurrenceDisplayLabel(item.task, tr('calendar.projectedRecurrence'))
                          : '';
                        return (
                          <View
                            key={item.id}
                            style={[
                              styles.monthPreviewItem,
                              {
                                backgroundColor: item.kind === 'scheduled'
                                  ? toRgba(tc.tint, isDark ? 0.24 : 0.14)
                                  : item.kind === 'deadline'
                                    ? 'transparent'
                                    : toRgba(tc.secondaryText, isDark ? 0.28 : 0.16),
                                borderLeftColor: isEvent
                                  ? sourceColorForId(item.event.sourceId)
                                  : projected
                                    ? tc.tint
                                    : item.kind === 'deadline'
                                    ? tc.danger
                                    : item.kind === 'completed'
                                    ? tc.secondaryText
                                    : tc.tint,
                                borderStyle: projected ? 'dashed' : 'solid',
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.monthPreviewText,
                                { color: item.kind === 'scheduled' || projected ? tc.tint : item.kind === 'completed' ? tc.secondaryText : tc.text },
                                item.kind === 'completed' && { textDecorationLine: 'line-through' as const },
                              ]}
                              numberOfLines={1}
                            >
                              {projected ? `${item.title} · ${projectedDisplayLabel}` : item.title}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                  {showOverflowIndicator && (taskCount > 0 || eventCount > 0) && (
                    <View style={styles.indicatorRow}>
                      {taskCount > 0 && (
                        <View style={[styles.taskDot, { backgroundColor: tc.tint }]}>
                          <Text style={[styles.taskDotText, { color: tc.onTint }]}>{taskCount}</Text>
                        </View>
                      )}
                      {eventCount > 0 && (
                        <View style={[styles.eventDot, { backgroundColor: tc.secondaryText }]}>
                          <Text style={[styles.eventDotText, { color: tc.bg }]}>{eventCount}</Text>
                        </View>
                      )}
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        </Animated.View>
      </View>

      {selectedDate && (
        <Animated.View style={[styles.monthDetailsPane, bottomSheetStyle, { backgroundColor: tc.cardBg, borderTopColor: tc.border }]}>
          <GestureDetector gesture={bottomSheetGesture}>
            <View
              accessibilityHint={tr('calendar.mobile.swipeUpOrDownToResizeTheDayDetailsPanel')}
              accessibilityLabel={tr('calendar.mobile.dayDetailsPanelHandle')}
              accessibilityRole="adjustable"
              style={styles.sheetHandleWrap}
            >
              <View style={[styles.sheetHandle, { backgroundColor: tc.border }]} />
            </View>
          </GestureDetector>
          <ScrollView contentContainerStyle={styles.monthDetailsContent} keyboardShouldPersistTaps="handled">
            <View style={styles.monthDetailsHeader}>
              <Text style={[styles.selectedDateTitle, { color: tc.text }]}>
                {selectedDateLongLabel}
              </Text>
              <Pressable
                onPress={() => openQuickAddForDate(selectedDate)}
                accessibilityRole="button"
                accessibilityLabel={t('calendar.addTask')}
                style={styles.addTaskButton}
              >
                <Text style={[styles.addTaskButtonText, { color: tc.tint }]}>{t('calendar.addTask')}</Text>
              </Pressable>
            </View>

            <View style={styles.addTaskForm}>
              <TextInput
                style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                value={scheduleQuery}
                onChangeText={setScheduleQuery}
                placeholder={t('calendar.schedulePlaceholder')}
                placeholderTextColor={tc.secondaryText}
              />
            </View>

            <View style={styles.tasksList}>
              {searchCandidates.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {t('calendar.scheduleResults')}
                  </Text>
                  {searchCandidates.map((task) => {
                    const slotLabel = getScheduleSlotLabel(selectedDate, task);
                    return (
                      <Pressable
                        key={task.id}
                        style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                        onPress={() => scheduleTaskOnSelectedDate(task.id)}
                      >
                        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                          {task.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                          {slotLabel ? `${t('calendar.scheduleAction')} · ${slotLabel}` : t('calendar.scheduleAction')}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {externalCalendars.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {t('calendar.events')}
                  </Text>
                  {isExternalLoading && (
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {tr('calendar.mobile.loading')}
                    </Text>
                  )}
                  {externalError && (
                    <Text style={[styles.taskItemTime, { color: tc.danger }]} numberOfLines={2}>
                      {externalError}
                    </Text>
                  )}
                  {selectedDateExternalEvents.map((event) => {
                    const eventStyle = [styles.taskItem, styles.eventItem, { backgroundColor: tc.inputBg, borderLeftColor: sourceColorForId(event.sourceId) }];
                    const eventContent = (
                      <>
                        <View style={styles.taskItemMain}>
                          <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                            {event.title}
                            {calendarNameById.get(event.sourceId) ? ` (${calendarNameById.get(event.sourceId)})` : ''}
                          </Text>
                          <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                            {event.allDay ? t('calendar.allDay') : (() => {
                              const start = safeParseDate(event.start);
                              const end = safeParseDate(event.end);
                              if (!start || !end) return '';
                              return `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`;
                            })()}
                          </Text>
                        </View>
                      </>
                    );
                    return (
                      <Pressable
                        key={event.id}
                        onPress={() => openExternalEvent(event)}
                        style={eventStyle}
                      >
                        {eventContent}
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {selectedDateDeadlines.map((task) => {
                const projected = isProjectedRecurringTask(task);
                const projectedDisplayLabel = projected
                  ? getProjectedRecurrenceDisplayLabel(task, tr('calendar.projectedRecurrence'))
                  : '';
                return (
                  <View
                    key={task.id}
                    style={[
                      styles.taskItem,
                      {
                        backgroundColor: projected ? toRgba(tc.tint, isDark ? 0.18 : 0.1) : tc.inputBg,
                        borderLeftColor: tc.tint,
                        borderStyle: projected ? 'dashed' : 'solid',
                      },
                    ]}
                  >
                    <Pressable
                      disabled={projected}
                      style={styles.taskItemMain}
                      onPress={() => {
                        if (!projected) openTaskActions(task.id);
                      }}
                    >
                      <Text style={[styles.taskItemTitle, { color: projected ? tc.tint : tc.text }]} numberOfLines={1}>
                        {task.title}
                      </Text>
                      <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                        {projected ? `${t('calendar.deadline')} · ${projectedDisplayLabel}` : t('calendar.deadline')}
                      </Text>
                    </Pressable>
                    {!projected && !isTaskFinished(task) && (
                      <Pressable
                        style={[styles.quickDoneButton, { borderColor: toRgba(tc.tint, 0.35), backgroundColor: toRgba(tc.tint, 0.16) }]}
                        onPress={() => markTaskDone(task.id)}
                      >
                        <Text style={[styles.quickDoneButtonText, { color: tc.tint }]}>{t('status.done')}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}

              {selectedDateScheduled.map((task) => {
                const projected = isProjectedRecurringTask(task);
                const projectedDisplayLabel = projected
                  ? getProjectedRecurrenceDisplayLabel(task, tr('calendar.projectedRecurrence'))
                  : '';
                return (
                  <Pressable
                    key={task.id}
                    disabled={projected}
                    style={[
                      styles.taskItem,
                      {
                        backgroundColor: projected ? toRgba(tc.tint, isDark ? 0.18 : 0.1) : tc.inputBg,
                        borderLeftColor: tc.tint,
                        borderStyle: projected ? 'dashed' : 'solid',
                      },
                    ]}
                    onPress={() => {
                      if (!projected) openTaskActions(task.id);
                    }}
                  >
                    <View style={styles.taskItemMain}>
                      <Text style={[styles.taskItemTitle, { color: projected ? tc.tint : tc.text }]} numberOfLines={1}>
                        {task.title}
                      </Text>
                      <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                        {(() => {
                          const start = safeParseDate(task.startTime);
                          if (!start) return '';
                          const durMs = timeEstimateToMinutes(task.timeEstimate) * 60 * 1000;
                          const end = new Date(start.getTime() + durMs);
                          const label = !isTimedScheduledTask(task)
                            ? t('calendar.allDay')
                            : `${safeFormatDate(start, 'p')}-${safeFormatDate(end, 'p')}`;
                          return projected ? `${label} · ${projectedDisplayLabel}` : label;
                        })()}
                      </Text>
                    </View>
                    {!projected && !isTaskFinished(task) && (
                      <Pressable
                        style={[styles.quickDoneButton, { borderColor: toRgba(tc.tint, 0.35), backgroundColor: toRgba(tc.tint, 0.16) }]}
                        onPress={(event) => {
                          event.stopPropagation();
                          markTaskDone(task.id);
                        }}
                      >
                        <Text style={[styles.quickDoneButtonText, { color: tc.tint }]}>{t('status.done')}</Text>
                      </Pressable>
                    )}
                  </Pressable>
                );
              })}

              {selectedDateDeadlines.length === 0
                && selectedDateScheduled.length === 0
                && selectedDateExternalEvents.length === 0 && (
                <Text style={[styles.noTasks, { color: tc.secondaryText }]}>{t('calendar.noTasks')}</Text>
              )}
            </View>
          </ScrollView>
        </Animated.View>
      )}

      {renderCalendarComposer()}

      <TaskEditModal
        visible={Boolean(editingTask)}
        task={editingTask}
        onClose={closeEditingTask}
        onSave={saveEditingTask}
        defaultTab="view"
        onProjectNavigate={openProjectScreen}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />
    </View>
  );
}
