import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  CALENDAR_WEEK_DENSITY_VALUES,
  CALENDAR_WEEK_VISIBLE_DAYS_MAX,
  CALENDAR_WEEK_VISIBLE_DAYS_MIN,
  calendarDateKey,
  formatCalendarDurationChip,
  formatCalendarScheduleDayTitle,
  getCalendarComposerPlaceholders,
  getCalendarDayAllDayTones,
  getCalendarDetailsTaskLists,
  getCalendarDayBounds,
  getCalendarDayOfMonth,
  getCalendarDayTimeline,
  getCalendarDetailsEventRow,
  getCalendarDetailsTaskRow,
  getCalendarItemTitle,
  getCalendarMonthItemTitle,
  getCalendarTimedDeadlines,
  getCalendarDeadlineMarkerGroups,
  isProjectedRecurringTask,
  type CalendarDeadlineMarker,
  getCalendarModeOptions,
  getCalendarMonthCell,
  getCalendarMonthPreviewTones,
  getCalendarNavigationLabels,
  getCalendarNowMinutes,
  getCalendarMovedStart,
  getCalendarWallMinutes,
  getCalendarProjectedLabel,
  getCalendarScheduleItemText,
  getCalendarScheduleItemTones,
  getCalendarScreenText,
  getCalendarWeekAllDayItems,
  getCalendarWeekAllDayTones,
  getCalendarWeekdayLabel,
  getCalendarWeekTimedEntries,
  isCalendarAllDayItem,
  safeFormatDate,
  snapCalendarTimelineMinutes,
  type CalendarTimedLayout,
  type Task,
} from '@mindwtr/core';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CompactText } from '@/components/compact-text';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { logInfo } from '@/lib/app-log';
import { useAndroidKeyboardInset } from '@/lib/use-android-keyboard-inset';
import { styles } from './calendar/calendar-view.styles';
import { CalendarPeriodNavigation } from './calendar/calendar-period-navigation';
import { CalendarTaskComposerModal } from './calendar/calendar-task-composer-modal';
import {
  CALENDAR_NAVIGATION_CAPTURE_DISTANCE,
  CALENDAR_NAVIGATION_FEEDBACK_DISTANCE,
  CALENDAR_NAVIGATION_SWIPE_VERTICAL_TOLERANCE,
  CALENDAR_NAVIGATION_SWIPE_VERTICAL_RATIO,
  getCalendarNavigationSwipeDirection,
  getCalendarWeekColumnWidth,
  getCalendarWeekContentClampX,
  getCalendarWeekAutoScrollKey,
  getCalendarWeekInitialScrollX,
  getCalendarWeekMaxScrollX,
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

type ScheduledTaskBlockProps = {
  DAY_END_HOUR: number;
  DAY_START_HOUR: number;
  PIXELS_PER_MINUTE: number;
  SNAP_MINUTES: number;
  commitTaskDrag: (taskId: string, dayStartMs: number, startMinutes: number, durationMinutes: number) => void;
  dayStartMs: number;
  durationMinutes: number;
  height: number;
  isDark: boolean;
  layoutStyle: TimedBlockInsetStyle;
  openTaskActions: (taskId: string) => void;
  projected: boolean;
  reducedMotion: boolean;
  setTimelineScrollEnabled: (enabled: boolean) => void;
  task: Task;
  tc: ReturnType<typeof useCalendarViewController>['tc'];
  /** The block's time line, with the projected label for an occurrence. */
  timeLabel: string;
  toRgba: (hex: string, alpha: number) => string;
  top: number;
  triggerDragHaptic: () => void;
};

type PlanningTaskListProps = {
  getScheduleSlotLabel: (date: Date | null, task: Task) => string;
  planningTasks: Task[];
  planningTitle: string;
  scheduleTaskOnSelectedDate: (taskId: string) => void;
  selectedDate: Date | null;
  selectedDatePlanningLabel: string;
  tc: ReturnType<typeof useCalendarViewController>['tc'];
  variant?: 'results' | 'section';
};

function PlanningTaskList({
  getScheduleSlotLabel,
  planningTasks,
  planningTitle,
  scheduleTaskOnSelectedDate,
  selectedDate,
  selectedDatePlanningLabel,
  tc,
  variant = 'results',
}: PlanningTaskListProps) {
  const isSection = variant === 'section';
  const items = planningTasks.map((task) => {
    const taskContent = (
      <>
        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
          {getScheduleSlotLabel(selectedDate, task)}
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
        {planningTitle}
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
  height,
  isDark,
  layoutStyle,
  openTaskActions,
  projected,
  reducedMotion,
  setTimelineScrollEnabled,
  task,
  tc,
  timeLabel,
  toRgba,
  top,
  triggerDragHaptic,
}: ScheduledTaskBlockProps) {
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const zIndex = useSharedValue(1);
  const taskId = task.id;

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

  const compact = height < 48;
  const showTime = height >= 44;

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
          {timeLabel}
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

// Marker labels have a separate rail: they never obscure or reserve task time.
const DEADLINE_ROW_MINUTES = 32;
function DeadlineMarkerRail({ markers, dayStart, pixelsPerMinute, openTaskActions, tc, dueLabel, projectedLabel }: {
  markers: CalendarDeadlineMarker[];
  dayStart: Date;
  pixelsPerMinute: number;
  openTaskActions: (id: string) => void;
  tc: ReturnType<typeof useCalendarViewController>['tc'];
  dueLabel: string;
  projectedLabel: string;
}) {
  const groups = getCalendarDeadlineMarkerGroups(markers, { dayStart, minGapMinutes: DEADLINE_ROW_MINUTES, maxVisibleRows: 3 });
  return <View pointerEvents="box-none" style={styles.deadlineRail}>
    {markers.map((marker) => <Text key={`anchor-${marker.id}`} accessible={false} pointerEvents="none"
      style={[styles.deadlineAnchor, { top: Math.max(0, getCalendarWallMinutes(dayStart, marker.start) * pixelsPerMinute - 6), color: tc.tint }]}>◆</Text>)}
    {groups.map((group) => <ScrollView key={group.markers[0].id} nestedScrollEnabled
      style={[styles.deadlineGroup, { top: group.startMinutes * pixelsPerMinute, height: Math.min(3, group.markers.length) * DEADLINE_ROW_MINUTES * pixelsPerMinute, backgroundColor: tc.cardBg }]}
      contentContainerStyle={{ paddingLeft: 10 }}>
        <View>
          {group.markers.map((marker) => {
            const label = `${safeFormatDate(marker.start, 'p')} · ${dueLabel}`;
            const projected = isProjectedRecurringTask(marker.task);
            const title = getCalendarItemTitle(marker, projectedLabel, safeFormatDate);
            return <Pressable key={marker.id} testID={`calendar-deadline-${marker.task.id}`} accessibilityRole={projected ? undefined : 'button'}
              accessibilityLabel={`${title}, ${label}`} disabled={projected}
              onPress={(event) => { event.stopPropagation(); openTaskActions(marker.task.id); }}
              style={{ height: DEADLINE_ROW_MINUTES * pixelsPerMinute, justifyContent: 'center' }}>
              <Text numberOfLines={1} style={{ color: tc.text, fontSize: 11 }}>{title}</Text>
              <Text numberOfLines={1} style={{ color: tc.tint, fontSize: 11, fontWeight: '600' }}>{label}</Text>
            </Pressable>;
          })}
        </View>
    </ScrollView>)}
  </View>;
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
    calendarDates,
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
    getCalendarItemsForDate,
    getDayLists,
    getScheduleSlotLabel,
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
  const weekHasDeadlines = weekDays.some((day) => getCalendarTimedDeadlines(getDayLists(day).deadlines).length > 0);
  const weekColumnWidth = Math.max(weekHasDeadlines ? 260 : 0, getCalendarWeekColumnWidth(weekAvailableColumnWidth, calendarWeekVisibleDays));
  const compactWeekColumns = weekColumnWidth < 86;
  const ultraCompactWeekColumns = weekColumnWidth < 58;
  const weekDensityProgress = (calendarWeekVisibleDays - CALENDAR_WEEK_VISIBLE_DAYS_MIN)
    / (CALENDAR_WEEK_VISIBLE_DAYS_MAX - CALENDAR_WEEK_VISIBLE_DAYS_MIN);
  const { start: composerStartTimePlaceholder, end: composerEndTimePlaceholder } = getCalendarComposerPlaceholders(safeFormatDate);
  const projectedLabel = getCalendarProjectedLabel(t);
  const selectedDayTimeline = useMemo(() => {
    if (!selectedDayStart || !selectedDayEnd) return { events: [], tasks: [] };
    return getCalendarDayTimeline({
      events: selectedDateTimedEvents,
      tasks: selectedDayScheduledTasks,
      dayStart: selectedDayStart,
      dayEnd: selectedDayEnd,
      timeEstimateToMinutes,
      formatDate: safeFormatDate,
      projectedLabel,
    });
  }, [projectedLabel, selectedDateTimedEvents, selectedDayEnd, selectedDayScheduledTasks, selectedDayStart, timeEstimateToMinutes]);

  const selectedDayDeadlines = useMemo(() => getCalendarTimedDeadlines(selectedDateDeadlines), [selectedDateDeadlines]);
  const markerCount = viewMode === 'day' ? selectedDayDeadlines.length : viewMode === 'week'
    ? weekDays.reduce((count, day) => count + getCalendarTimedDeadlines(getDayLists(day).deadlines).length, 0) : 0;
  const loggedDeadlineModes = useRef(new Set<string>());
  useEffect(() => {
    if (markerCount === 0 || (viewMode !== 'day' && viewMode !== 'week') || loggedDeadlineModes.current.has(viewMode)) return;
    loggedDeadlineModes.current.add(viewMode);
    void logInfo('Calendar timed deadlines rendered', { scope: 'calendar', extra: {
      releaseCheck: 'v1.3.4/calendar-timed-deadlines', outcome: 'rendered', mode: viewMode, count: markerCount,
    } });
  }, [markerCount, viewMode]);

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

    const autoScrollKey = getCalendarWeekAutoScrollKey({
      availableWidth: weekAvailableColumnWidth,
      columnWidth: weekColumnWidth,
      selectedDate,
      visibleDays: calendarWeekVisibleDays,
      weekDays,
    });
    if (lastWeekAutoScrollKeyRef.current === autoScrollKey) return;
    lastWeekAutoScrollKeyRef.current = autoScrollKey;

    const x = Math.min(
      getCalendarWeekInitialScrollX({
        availableWidth: weekAvailableColumnWidth,
        columnWidth: weekColumnWidth,
        // The gutter stays pinned now, so the first day column already starts beside it.
        leadingInset: 0,
        selectedDate,
        visibleDays: calendarWeekVisibleDays,
        weekDays,
      }),
      getCalendarWeekMaxScrollX({
        columnWidth: weekColumnWidth,
        dayCount: weekDays.length,
        gutterWidth: WEEK_TIME_GUTTER_WIDTH,
        viewportWidth: screenWidth,
      }),
    );
    requestAnimationFrame(() => {
      weekHorizontalScrollRef.current?.scrollTo({
        x,
        animated: false,
      });
    });
  }, [calendarWeekVisibleDays, screenWidth, selectedDate, viewMode, weekAvailableColumnWidth, weekColumnWidth, weekDays]);

  // Widening the columns from the density slider shrinks nothing, but narrowing
  // the canvas (more visible days) leaves the old scroll offset beyond the last
  // column and Android keeps it there, showing day headers and then blank space.
  // Re-clamp whenever the canvas actually resizes.
  const handleWeekContentSizeChange = useCallback((contentWidth: number) => {
    const clampedX = getCalendarWeekContentClampX({
      contentWidth,
      currentX: weekScrollX.value,
      viewportWidth: screenWidth,
    });
    if (clampedX === null) return;

    // Store the correction synchronously. Without this, a second content-size
    // callback observes the stale out-of-range value and calls scrollTo again,
    // creating a render/layout feedback loop before onScroll can catch up.
    weekScrollX.value = clampedX;
    weekHorizontalScrollRef.current?.scrollTo({ x: clampedX, animated: false });
  }, [screenWidth, weekScrollX]);

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

  const modeOptions = getCalendarModeOptions(t);
  const formatDurationLabel = formatCalendarDurationChip;
  const navigationLabels = getCalendarNavigationLabels(viewMode, t);
  const text = getCalendarScreenText(t);
  const detailTaskLists = getCalendarDetailsTaskLists({ deadlines: selectedDateDeadlines, scheduled: selectedDateScheduled });

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
      accessibilityLabel={text.showCompletedHint}
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
        {text.showCompleted}
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
      formatDate={safeFormatDate}
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
    />
  );

  if (viewMode === 'day' && selectedDate && selectedDayStart && selectedDayEnd) {
    const allDayItems = getCalendarItemsForDate(selectedDate).filter(isCalendarAllDayItem);
    const handleDayTimelinePress = (event: GestureResponderEvent) => {
      const clampedMinutes = snapCalendarTimelineMinutes(event.nativeEvent.locationY / PIXELS_PER_MINUTE);
      openQuickAddAtDateTime(getCalendarMovedStart(selectedDayStart.getTime(), clampedMinutes));
    };

    return (
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        <View style={[styles.dayModeHeader, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <CalendarPeriodNavigation
            label={selectedDayModeLabel}
            nextLabel={navigationLabels.next}
            onNext={() => shiftSelectedDate(1)}
            onPrevious={() => shiftSelectedDate(-1)}
            onToday={handleToday}
            previousLabel={navigationLabels.previous}
            tc={tc}
            titleVariant="day"
            todayLabel={navigationLabels.today}
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
                <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>{text.allDay}</Text>
                <ScrollView style={styles.allDayList}>
                {allDayItems.map((item) => (
                  <Pressable
                    key={item.id}
                    disabled={getCalendarDayAllDayTones(item).disabled}
                    onPress={() => {
                      if (item.kind === 'event') openExternalEvent(item.event);
                      else openTaskActions(item.task.id);
                    }}
                    style={styles.allDayPressable}
                  >
                    <Text style={[styles.allDayItem, { color: getCalendarDayAllDayTones(item).text === 'tint' ? tc.tint : tc.text }]} numberOfLines={1}>
                      {getCalendarItemTitle(item, projectedLabel, safeFormatDate)}
                    </Text>
                  </Pressable>
                ))}
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

                <View pointerEvents="box-none" style={[styles.timelineItemsLayer, selectedDayDeadlines.length > 0 && { right: '42%' }]}>
                  {selectedDayTimeline.events.map(({ event, start: clampedStart, end: clampedEnd, layout, timeLabel }) => {
                    const startMinutes = getCalendarWallMinutes(selectedDayStart, clampedStart);
                    const endMinutes = getCalendarWallMinutes(selectedDayStart, clampedEnd);
                    const top = Math.max(0, startMinutes) * PIXELS_PER_MINUTE;
                    const height = Math.max(16, (endMinutes - startMinutes) * PIXELS_PER_MINUTE);
                    const eventStyle = [
                      styles.eventBlock,
                      {
                        top,
                        height,
                        backgroundColor: toRgba(tc.secondaryText, isDark ? 0.35 : 0.18),
                        borderColor: sourceColorForId(event.sourceId),
                      },
                      getTimedBlockInsetStyle(layout),
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

                  {selectedDayTimeline.tasks.map(({ task, durationMinutes, displayStart: clampedStart, displayEnd: clampedEnd, layout, projected, timeLabel }) => {
                    const startMinutes = getCalendarWallMinutes(selectedDayStart, clampedStart);
                    const endMinutes = getCalendarWallMinutes(selectedDayStart, clampedEnd);
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
                        isDark={isDark}
                        layoutStyle={getTimedBlockInsetStyle(layout)}
                        openTaskActions={openTaskActions}
                        projected={projected}
                        reducedMotion={reducedMotion}
                        setTimelineScrollEnabled={setTimelineScrollEnabled}
                        tc={tc}
                        timeLabel={timeLabel}
                        toRgba={toRgba}
                        triggerDragHaptic={triggerDragHaptic}
                      />
                    );
                  })}
                </View>
                {selectedDayDeadlines.length > 0 && <View pointerEvents="box-none" style={styles.timelineItemsLayer}>
                  <DeadlineMarkerRail markers={selectedDayDeadlines} dayStart={selectedDayStart} pixelsPerMinute={PIXELS_PER_MINUTE}
                    openTaskActions={openTaskActions} tc={tc} dueLabel={t('calendar.due')} projectedLabel={projectedLabel} />
                </View>}
              </View>
            </View>

            <View style={[styles.dayScheduleCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <View style={styles.addTaskForm}>
                <TextInput
                  style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={scheduleQuery}
                  onChangeText={setScheduleQuery}
                  placeholder={text.schedulePlaceholder}
                  placeholderTextColor={tc.secondaryText}
                />
              </View>

              {searchCandidates.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {text.searchResultsTitle}
                  </Text>
                  {searchCandidates.map((task) => (
                    <Pressable
                      key={task.id}
                      style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                      onPress={() => scheduleTaskOnSelectedDate(task.id)}
                    >
                      <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                        {task.title}
                      </Text>
                      <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                        {getScheduleSlotLabel(selectedDate, task)}
                      </Text>
                    </Pressable>
                  ))}
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
            nextLabel={navigationLabels.next}
            onNext={() => shiftSelectedDate(7)}
            onPrevious={() => shiftSelectedDate(-7)}
            onToday={handleToday}
            previousLabel={navigationLabels.previous}
            tc={tc}
            todayLabel={navigationLabels.today}
          />
          {renderModeToggle()}
          {renderShowCompletedToggle()}
        </View>

        <AnimatedWeekScrollView
          ref={weekHorizontalScrollRef}
          horizontal
          nestedScrollEnabled
          onScroll={weekHorizontalScrollHandler}
          onContentSizeChange={handleWeekContentSizeChange}
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
                    {getCalendarWeekdayLabel(day, calendarDates)}
                  </Text>
                  <Text style={[styles.weekDayNumber, compactWeekColumns && styles.weekDayNumberCompact, { color: isToday(day) ? tc.tint : tc.text }]}>
                    {day.getDate()}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={[styles.weekAllDayRow, { borderBottomColor: tc.border }]}>
              <Animated.View style={[styles.weekTimeGutter, styles.weekTimeGutterPinned, { backgroundColor: tc.bg }, weekGutterPinStyle]}>
                <Text style={[styles.weekAllDayLabel, { color: tc.secondaryText }]}>{text.allDay}</Text>
              </Animated.View>
              {weekDays.map((day) => {
                const allDayItems = getCalendarWeekAllDayItems(getCalendarItemsForDate(day));
                return (
                  <View key={`all-${day.toISOString()}`} style={[styles.weekAllDayCell, compactWeekColumns && styles.weekAllDayCellCompact, { width: weekColumnWidth, borderLeftColor: tc.border }]}>
                    {allDayItems.map((item) => {
                      const tones = getCalendarWeekAllDayTones(item);
                      return (
                        <Pressable
                          key={item.id}
                          disabled={tones.disabled}
                          onPress={(pressEvent) => {
                            pressEvent.stopPropagation();
                            if (item.kind === 'event') openExternalEvent(item.event);
                            else openTaskActions(item.task.id);
                          }}
                          style={[
                            styles.weekAllDayItem,
                            compactWeekColumns && styles.weekAllDayItemCompact,
                            {
                              backgroundColor: tones.fill === 'secondary' ? toRgba(tc.secondaryText, isDark ? 0.28 : 0.14) : tc.inputBg,
                              borderLeftColor: item.kind === 'event'
                                ? sourceColorForId(item.event.sourceId)
                                : tones.accent === 'tint'
                                  ? tc.tint
                                  : tc.danger,
                              borderStyle: tones.dashed ? 'dashed' : 'solid',
                            },
                          ]}
                        >
                          <Text style={[styles.weekAllDayText, compactWeekColumns && styles.weekAllDayTextCompact, { color: tc.text }]} numberOfLines={1}>
                            {getCalendarItemTitle(item, projectedLabel, safeFormatDate)}
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
                  const nowMinutes = getCalendarNowMinutes(new Date());
                  const showNow = isToday(day) && nowMinutes !== null;
                  const { dayStart, dayEnd } = getCalendarDayBounds(day);
                  const deadlineMarkers = getCalendarTimedDeadlines(getDayLists(day).deadlines);
                  const timedEntries = getCalendarWeekTimedEntries({
                    items: getCalendarItemsForDate(day),
                    dayStart,
                    dayEnd,
                    timeEstimateToMinutes,
                    formatDate: safeFormatDate,
                    projectedLabel,
                  });
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
                        <View style={[styles.weekNowLine, { top: (nowMinutes ?? 0) * PIXELS_PER_MINUTE }]}>
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
                          deadlineMarkers.length > 0 && { right: '42%' },
                        ]}
                      >
                        {timedEntries.map((entry) => {
                          if (entry.kind === 'event') {
                            const { item, start: displayStart, end: displayEnd } = entry;
                            const top = getCalendarWallMinutes(dayStart, displayStart) * PIXELS_PER_MINUTE;
                            const height = Math.max(24, (getCalendarWallMinutes(dayStart, displayEnd) - getCalendarWallMinutes(dayStart, displayStart)) * PIXELS_PER_MINUTE);
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
                              getTimedBlockInsetStyle(entry.layout),
                            ];
                            const eventContent = (
                              <>
                                <Text style={[styles.weekBlockTitle, compactWeekColumns && styles.weekBlockTitleCompact, { color: tc.text }]} numberOfLines={compactWeekColumns ? 2 : 1}>{item.title}</Text>
                                {!compactWeekColumns && (
                                  <Text style={[styles.weekBlockTime, { color: tc.secondaryText }]} numberOfLines={1}>
                                    {entry.timeLabel}
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

                          const { item, projected } = entry;
                          const top = getCalendarWallMinutes(dayStart, entry.displayStart) * PIXELS_PER_MINUTE;
                          const height = Math.max(24, (getCalendarWallMinutes(dayStart, entry.displayEnd) - getCalendarWallMinutes(dayStart, entry.displayStart)) * PIXELS_PER_MINUTE);
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
                                getTimedBlockInsetStyle(entry.layout),
                              ]}
                            >
                              <Text style={[styles.weekTaskBlockTitle, compactWeekColumns && styles.weekTaskBlockTitleCompact, projected && { color: tc.tint }]} numberOfLines={compactWeekColumns ? 2 : 1}>{item.title}</Text>
                              {!compactWeekColumns && (
                                <Text style={[styles.weekTaskBlockTime, projected && { color: tc.secondaryText }]} numberOfLines={1}>
                                  {entry.timeLabel}
                                </Text>
                              )}
                            </Pressable>
                          );
                        })}
                      </View>
                      {deadlineMarkers.length > 0 && <DeadlineMarkerRail markers={deadlineMarkers} dayStart={dayStart} pixelsPerMinute={PIXELS_PER_MINUTE}
                        openTaskActions={openTaskActions} tc={tc} dueLabel={t('calendar.due')} projectedLabel={projectedLabel} />}
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
              accessibilityLabel={text.weekDensity}
              accessibilityHint={text.weekDensityHint}
              accessibilityValue={{
                min: CALENDAR_WEEK_VISIBLE_DAYS_MIN,
                max: CALENDAR_WEEK_VISIBLE_DAYS_MAX,
                now: calendarWeekVisibleDays,
                text: text.weekDensityValue(calendarWeekVisibleDays),
              }}
              accessibilityActions={[
                { name: 'increment', label: text.weekDensityMore },
                { name: 'decrement', label: text.weekDensityFewer },
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
            {CALENDAR_WEEK_DENSITY_VALUES.map((value) => {
              const active = value === calendarWeekVisibleDays;
              return (
                <Pressable
                  key={value}
                  onPress={() => setCalendarWeekVisibleDays(value)}
                  accessibilityRole="button"
                  accessibilityLabel={text.weekDensityChoice(value)}
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
              <Text style={[styles.title, { color: tc.text }]}>{text.scheduleTitle}</Text>
              <Pressable
                onPress={handleScheduleToday}
                accessibilityRole="button"
                accessibilityLabel={navigationLabels.today}
                style={[styles.todayButton, { borderColor: tc.border }]}
              >
                <Text style={[styles.todayButtonText, { color: tc.tint }]}>{navigationLabels.today}</Text>
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
          // Scheduled days come first; the planning list sits below them like the
          // desktop planning panel, so due tasks are never pushed off screen (#1240).
          ListFooterComponent={selectedDate && planningTasks.length > 0 ? (
            <PlanningTaskList
              getScheduleSlotLabel={getScheduleSlotLabel}
              planningTasks={planningTasks}
              planningTitle={text.planningTitle}
              scheduleTaskOnSelectedDate={scheduleTaskOnSelectedDate}
              selectedDate={selectedDate}
              selectedDatePlanningLabel={selectedDatePlanningLabel}
              tc={tc}
              variant="section"
            />
          ) : null}
          renderItem={({ item: section }) => (
            <View style={styles.scheduleSection}>
              <Text style={[styles.scheduleDate, { color: tc.secondaryText }]}>
                {formatCalendarScheduleDayTitle(section.date, { dates: calendarDates, t })}
              </Text>
              <View style={styles.scheduleItems}>
                {section.items.map((item) => {
                  const itemText = getCalendarScheduleItemText(item, {
                    t,
                    formatDate: safeFormatDate,
                    projectedLabel,
                    sourceNames: calendarNameById,
                    timeEstimateToMinutes,
                  });
                  if (item.kind === 'event') {
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
                          {itemText.detail}
                        </Text>
                      </View>
                    );
                    return (
                      <Pressable
                        key={item.id}
                        onPress={() => openExternalEvent(item.event)}
                        accessibilityRole="button"
                        accessibilityLabel={itemText.accessibilityLabel}
                        style={eventStyle}
                      >
                        {eventContent}
                      </Pressable>
                    );
                  }

                  const tones = getCalendarScheduleItemTones(item);
                  return (
                    <Pressable
                      key={item.id}
                      disabled={tones.disabled}
                      accessibilityRole={tones.disabled ? undefined : 'button'}
                      accessibilityLabel={itemText.accessibilityLabel}
                      accessibilityState={{ disabled: tones.disabled }}
                      style={[
                        styles.scheduleItem,
                        {
                          backgroundColor: tones.fill === 'tint' ? toRgba(tc.tint, isDark ? 0.2 : 0.12) : tc.inputBg,
                          borderLeftColor: tones.accent === 'secondary' ? tc.secondaryText : tones.accent === 'tint' ? tc.tint : tc.danger,
                          borderStyle: tones.dashed ? 'dashed' : 'solid',
                          opacity: tones.faded ? 0.7 : 1,
                        },
                      ]}
                      onPress={() => {
                        if (!tones.disabled) openTaskActions(item.task.id);
                      }}
                    >
                      <View style={styles.taskItemMain}>
                        <Text
                          style={[
                            styles.taskItemTitle,
                            { color: tones.title === 'secondary' ? tc.secondaryText : tc.text },
                            tones.struck && { textDecorationLine: 'line-through' as const },
                          ]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                          {itemText.detail}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
          ListEmptyComponent={planningTasks.length > 0 ? null : (
            <Text style={[styles.noTasks, { color: tc.secondaryText }]}>{text.noTasks}</Text>
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

  const detailsRowOptions = { t, formatDate: safeFormatDate, projectedLabel, timeEstimateToMinutes };

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <CalendarPeriodNavigation
          label={monthLabel}
          nextLabel={navigationLabels.next}
          onNext={handleNextMonth}
          onPrevious={handlePrevMonth}
          onToday={handleToday}
          previousLabel={navigationLabels.previous}
          tc={tc}
          todayLabel={navigationLabels.today}
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
              const dateKey = calendarDateKey(date);
              const cell = getCalendarMonthCell(date, getDayLists(date), { dates: calendarDates, t });
              const { taskCount, eventCount } = cell;
              const visibleItems = cell.previewItems;
              const isSelected = selectedDate && isSameDay(date, selectedDate);
              const todayCellBg = toRgba(tc.tint, isDark ? 0.12 : 0.08);
              const selectedCellBg = toRgba(tc.tint, isDark ? 0.2 : 0.16);

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
                  accessibilityLabel={cell.accessibilityLabel}
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
                        const tones = getCalendarMonthPreviewTones(item);
                        const toneColor = (tone: string) => (
                          tone === 'tint' ? tc.tint : tone === 'danger' ? tc.danger : tone === 'secondary' ? tc.secondaryText : tc.text
                        );
                        return (
                          <View
                            key={item.id}
                            style={[
                              styles.monthPreviewItem,
                              {
                                backgroundColor: tones.fill === 'tint'
                                  ? toRgba(tc.tint, isDark ? 0.24 : 0.14)
                                  : tones.fill === 'none'
                                    ? 'transparent'
                                    : toRgba(tc.secondaryText, isDark ? 0.28 : 0.16),
                                borderLeftColor: item.kind === 'event'
                                  ? sourceColorForId(item.event.sourceId)
                                  : toneColor(tones.accent),
                                borderStyle: tones.dashed ? 'dashed' : 'solid',
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.monthPreviewText,
                                { color: toneColor(tones.text) },
                                tones.struck && { textDecorationLine: 'line-through' as const },
                              ]}
                              numberOfLines={1}
                            >
                              {getCalendarMonthItemTitle(item, date, { projectedLabel, formatDate: safeFormatDate, t })}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                  {cell.showCounts && (
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
              accessibilityHint={text.detailsHandleHint}
              accessibilityLabel={text.detailsHandle}
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
                accessibilityLabel={text.addTask}
                style={styles.addTaskButton}
              >
                <Text style={[styles.addTaskButtonText, { color: tc.tint }]}>{text.addTask}</Text>
              </Pressable>
            </View>

            <View style={styles.addTaskForm}>
              <TextInput
                style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                value={scheduleQuery}
                onChangeText={setScheduleQuery}
                placeholder={text.schedulePlaceholder}
                placeholderTextColor={tc.secondaryText}
              />
            </View>

            <View style={styles.tasksList}>
              {searchCandidates.length > 0 && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {text.searchResultsTitle}
                  </Text>
                  {searchCandidates.map((task) => (
                    <Pressable
                      key={task.id}
                      style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                      onPress={() => scheduleTaskOnSelectedDate(task.id)}
                    >
                      <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                        {task.title}
                      </Text>
                      <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                        {getScheduleSlotLabel(selectedDate, task)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {(externalCalendars.length > 0 || externalError) && (
                <View style={styles.scheduleResults}>
                  <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>
                    {text.events}
                  </Text>
                  {isExternalLoading && (
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {text.loading}
                    </Text>
                  )}
                  {externalError && (
                    <Text style={[styles.taskItemTime, { color: tc.danger }]} numberOfLines={2}>
                      {externalError}
                    </Text>
                  )}
                  {selectedDateExternalEvents.map((event) => {
                    const eventStyle = [styles.taskItem, styles.eventItem, { backgroundColor: tc.inputBg, borderLeftColor: sourceColorForId(event.sourceId) }];
                    const row = getCalendarDetailsEventRow(event, { t, formatDate: safeFormatDate, sourceNames: calendarNameById });
                    const eventContent = (
                      <>
                        <View style={styles.taskItemMain}>
                          <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                            {row.title}
                          </Text>
                          <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                            {row.detail}
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

              {detailTaskLists.deadlines.map((task) => {
                const row = getCalendarDetailsTaskRow(task, 'deadline', detailsRowOptions);
                const projected = row.projected;
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
                        {row.detail}
                      </Text>
                    </Pressable>
                    {row.showDone && (
                      <Pressable
                        style={[styles.quickDoneButton, { borderColor: toRgba(tc.tint, 0.35), backgroundColor: toRgba(tc.tint, 0.16) }]}
                        onPress={() => markTaskDone(task.id)}
                      >
                        <Text style={[styles.quickDoneButtonText, { color: tc.tint }]}>{text.done}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}

              {detailTaskLists.scheduled.map((task) => {
                const row = getCalendarDetailsTaskRow(task, 'scheduled', detailsRowOptions);
                const projected = row.projected;
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
                        {row.detail}
                      </Text>
                    </View>
                    {row.showDone && (
                      <Pressable
                        style={[styles.quickDoneButton, { borderColor: toRgba(tc.tint, 0.35), backgroundColor: toRgba(tc.tint, 0.16) }]}
                        onPress={(event) => {
                          event.stopPropagation();
                          markTaskDone(task.id);
                        }}
                      >
                        <Text style={[styles.quickDoneButtonText, { color: tc.tint }]}>{text.done}</Text>
                      </Pressable>
                    )}
                  </Pressable>
                );
              })}

              {detailTaskLists.deadlines.length === 0
                && detailTaskLists.scheduled.length === 0
                && selectedDateExternalEvents.length === 0 && (
                <Text style={[styles.noTasks, { color: tc.secondaryText }]}>{text.noTasks}</Text>
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
