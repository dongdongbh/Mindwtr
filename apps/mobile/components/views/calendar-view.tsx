import { useEffect } from 'react';
import { Modal, Pressable, Text, TextInput, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import { CALENDAR_TIME_ESTIMATE_OPTIONS, safeFormatDate, safeParseDate, type Task } from '@mindwtr/core';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TaskEditModal } from '@/components/task-edit-modal';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { styles } from './calendar/calendar-view.styles';
import { useCalendarViewController } from './calendar/useCalendarViewController';

const MONTH_DETAILS_COLLAPSED_SNAP = 0.26;
const MONTH_DETAILS_MID_SNAP = 0.58;
const MONTH_DETAILS_EXPANDED_SNAP = 0.9;
const MONTH_DETAILS_HIDE_THRESHOLD = 0.2;
const MONTH_DETAILS_MIN_HEIGHT = 176;

export function CalendarView() {
  const {
    DAY_END_HOUR,
    DAY_START_HOUR,
    PIXELS_PER_MINUTE,
    SNAP_MINUTES,
    calendarDays,
    calendarComposer,
    calendarComposerCandidates,
    calendarComposerSelectedTask,
    calendarNameById,
    closeCalendarComposer,
    closeEditingTask,
    commitTaskDrag,
    currentMonth,
    currentYear,
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
    handleToday,
    isDark,
    isExternalLoading,
    isSameDay,
    isToday,
    locale,
    localize,
    markTaskDone,
    monthLabel,
    nextQuickScheduleCandidates,
    openQuickAddForDate,
    openQuickAddAtDateTime,
    openTaskActions,
    saveEditingTask,
    saveCalendarComposer,
    scheduleQuery,
    scheduleTaskOnSelectedDate,
    searchCandidates,
    selectCalendarComposerTask,
    selectedDate,
    selectedDateAllDayEvents,
    selectedDateDeadlines,
    selectedDateExternalEvents,
    selectedDateLongLabel,
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
    setScheduleQuery,
    setSelectedDate,
    setTimelineScrollEnabled,
    setViewMode,
    shiftSelectedDate,
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
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const collapsedSheetSnap = Math.max(
    MONTH_DETAILS_COLLAPSED_SNAP,
    Math.min(MONTH_DETAILS_MID_SNAP, MONTH_DETAILS_MIN_HEIGHT / Math.max(screenHeight, 1))
  );
  const bottomSheetSnap = useSharedValue(collapsedSheetSnap);
  const bottomSheetStart = useSharedValue(collapsedSheetSnap);

  const closeMonthDetailsPane = () => {
    setSelectedDate(null);
  };

  useEffect(() => {
    if (selectedDate) {
      bottomSheetSnap.value = withSpring(collapsedSheetSnap);
    }
  }, [bottomSheetSnap, collapsedSheetSnap, selectedDate]);

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
        bottomSheetSnap.value = withSpring(0, undefined, (finished) => {
          if (finished) {
            runOnJS(closeMonthDetailsPane)();
          }
        });
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
      bottomSheetSnap.value = withSpring(nearest);
    });
  const bottomSheetStyle = useAnimatedStyle(() => ({
    height: screenHeight * bottomSheetSnap.value,
  }));

  const triggerDragHaptic = () => {
    Haptics.selectionAsync().catch(() => {});
  };

  const modeOptions = [
    { value: 'month' as const, label: localize('Month', '月') },
    { value: 'day' as const, label: localize('Day', '日') },
    { value: 'week' as const, label: localize('Week', '周') },
    { value: 'schedule' as const, label: localize('Schedule', '日程') },
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

  const renderCalendarComposer = () => (
    <Modal
      visible={Boolean(calendarComposer)}
      transparent
      animationType="fade"
      onRequestClose={closeCalendarComposer}
    >
      <Pressable style={styles.composerBackdrop} onPress={closeCalendarComposer}>
        {calendarComposer && (
          <View
            style={[
              styles.calendarComposer,
              {
                backgroundColor: tc.cardBg,
                borderColor: tc.border,
                paddingBottom: Math.max(18, insets.bottom + 14),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.composerHeader}>
              <View style={styles.taskItemMain}>
                <Text style={[styles.composerTitle, { color: tc.text }]}>
                  {localize('Add to calendar', '添加到日历')}
                </Text>
                <Text style={[styles.composerDate, { color: tc.secondaryText }]}>
                  {calendarComposer.date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <Pressable onPress={closeCalendarComposer} style={styles.composerCloseButton}>
                <Text style={[styles.composerCloseText, { color: tc.secondaryText }]}>×</Text>
              </Pressable>
            </View>

            <View style={[styles.composerModeToggle, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
              {[
                { value: 'new' as const, label: localize('New task', '新任务') },
                { value: 'existing' as const, label: localize('Existing task', '现有任务') },
              ].map((option) => {
                const active = calendarComposer.mode === option.value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setCalendarComposerMode(option.value)}
                    style={[styles.composerModeButton, active && { backgroundColor: tc.tint }]}
                  >
                    <Text style={[styles.composerModeText, { color: active ? tc.onTint : tc.secondaryText }]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {calendarComposer.mode === 'new' ? (
              <TextInput
                style={[styles.input, styles.composerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                value={calendarComposer.title}
                onChangeText={setCalendarComposerTitle}
                placeholder={t('calendar.addTask')}
                placeholderTextColor={tc.secondaryText}
              />
            ) : (
              <View style={styles.composerSection}>
                <TextInput
                  style={[styles.input, styles.composerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={calendarComposer.query}
                  onChangeText={setCalendarComposerQuery}
                  placeholder={t('calendar.schedulePlaceholder')}
                  placeholderTextColor={tc.secondaryText}
                />
                <ScrollView style={styles.composerResults} keyboardShouldPersistTaps="handled">
                  {calendarComposerCandidates.map((task) => {
                    const selected = task.id === calendarComposer.selectedTaskId;
                    return (
                      <Pressable
                        key={task.id}
                        onPress={() => selectCalendarComposerTask(task)}
                        style={[
                          styles.composerResultItem,
                          {
                            backgroundColor: selected ? toRgba(tc.tint, isDark ? 0.28 : 0.14) : tc.inputBg,
                            borderLeftColor: selected ? tc.tint : tc.border,
                          },
                        ]}
                      >
                        <Text style={[styles.taskItemTitle, { color: selected ? tc.tint : tc.text }]} numberOfLines={1}>
                          {task.title}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {calendarComposerCandidates.length === 0 && (
                    <Text style={[styles.noTasks, { color: tc.secondaryText }]}>
                      {localize('No matching tasks', '没有匹配的任务')}
                    </Text>
                  )}
                </ScrollView>
                {calendarComposerSelectedTask && (
                  <Text style={[styles.composerSelectedTask, { color: tc.tint, backgroundColor: toRgba(tc.tint, isDark ? 0.22 : 0.12) }]} numberOfLines={1}>
                    {calendarComposerSelectedTask.title}
                  </Text>
                )}
              </View>
            )}

            <View style={styles.composerTimeRow}>
              <View style={styles.composerTimeField}>
                <Text style={[styles.composerLabel, { color: tc.secondaryText }]}>{localize('Start', '开始')}</Text>
                <TextInput
                  style={[styles.input, styles.composerTimeInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={calendarComposer.startTimeValue}
                  onChangeText={setCalendarComposerStartTime}
                  placeholder="09:00"
                  placeholderTextColor={tc.secondaryText}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.composerTimeField}>
                <Text style={[styles.composerLabel, { color: tc.secondaryText }]}>{localize('End', '结束')}</Text>
                <TextInput
                  style={[styles.input, styles.composerTimeInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={calendarComposer.endTimeValue}
                  onChangeText={setCalendarComposerEndTime}
                  placeholder="09:30"
                  placeholderTextColor={tc.secondaryText}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>

            <View style={styles.durationChips}>
              {CALENDAR_TIME_ESTIMATE_OPTIONS.map((option) => {
                const active = calendarComposer.durationMinutes === option.minutes;
                return (
                  <Pressable
                    key={option.estimate}
                    onPress={() => setCalendarComposerDuration(option.minutes)}
                    style={[
                      styles.durationChip,
                      {
                        backgroundColor: active ? tc.tint : tc.inputBg,
                        borderColor: active ? tc.tint : tc.border,
                      },
                    ]}
                  >
                    <Text style={[styles.durationChipText, { color: active ? tc.onTint : tc.secondaryText }]}>
                      {formatDurationLabel(option.minutes)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {calendarComposer.error && (
              <Text style={[styles.composerError, { color: tc.danger }]}>
                {calendarComposer.error}
              </Text>
            )}

            <View style={styles.composerActions}>
              <Pressable
                onPress={closeCalendarComposer}
                style={[styles.composerCancelButton, { backgroundColor: tc.inputBg }]}
              >
                <Text style={[styles.composerActionText, { color: tc.text }]}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={saveCalendarComposer}
                disabled={calendarComposer.mode === 'new' ? !calendarComposer.title.trim() : !calendarComposer.selectedTaskId}
                style={[
                  styles.composerSaveButton,
                  {
                    backgroundColor: tc.tint,
                    opacity: calendarComposer.mode === 'new' ? (calendarComposer.title.trim() ? 1 : 0.5) : (calendarComposer.selectedTaskId ? 1 : 0.5),
                  },
                ]}
              >
                <Text style={[styles.composerActionText, { color: tc.onTint }]}>{t('common.save')}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </Pressable>
    </Modal>
  );

  function ScheduledTaskBlock({
    task,
    dayStartMs,
    durationMinutes,
    height,
    top,
  }: {
    task: Task;
    dayStartMs: number;
    durationMinutes: number;
    height: number;
    top: number;
  }) {
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const zIndex = useSharedValue(1);
    const taskId = task.id;

    const panGesture = Gesture.Pan()
      .activateAfterLongPress(140)
      .onStart(() => {
        scale.value = withSpring(1.02);
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
        translateY.value = withSpring(0);
        scale.value = withSpring(1);
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
            animatedStyle,
          ]}
        >
          <Text style={[styles.taskBlockTitle, compact && styles.taskBlockTitleCompact]} numberOfLines={compact ? 1 : 2}>
            {task.title}
          </Text>
          {showTime && (
            <Text style={styles.taskBlockTime} numberOfLines={1}>
              {label}
            </Text>
          )}
        </Animated.View>
      </GestureDetector>
    );
  }

  if (viewMode === 'day' && selectedDate && selectedDayStart && selectedDayEnd) {
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
          <View style={styles.headerTopRow}>
            <Pressable onPress={() => shiftSelectedDate(-1)} style={styles.navButton}>
              <Text style={[styles.navButtonText, { color: tc.text }]}>‹</Text>
            </Pressable>
            <View style={styles.dayModeTitleWrap}>
              <Text style={[styles.dayModeTitle, { color: tc.text }]} numberOfLines={1}>
                {selectedDayModeLabel}
              </Text>
              <Pressable onPress={handleToday} style={[styles.todayButton, { borderColor: tc.border }]}>
                <Text style={[styles.todayButtonText, { color: tc.tint }]}>{localize('Today', '今天')}</Text>
              </Pressable>
            </View>
            <View style={styles.dayModeNav}>
              <Pressable onPress={() => openQuickAddForDate(selectedDate)} style={styles.dayNavButton}>
                <Text style={[styles.dayNavText, { color: tc.text }]}>＋</Text>
              </Pressable>
              <Pressable onPress={() => shiftSelectedDate(1)} style={styles.navButton}>
                <Text style={[styles.navButtonText, { color: tc.text }]}>›</Text>
              </Pressable>
            </View>
          </View>
          {renderModeToggle()}
        </View>

        <ScrollView
          ref={timelineScrollRef}
          style={styles.dayScroll}
          contentContainerStyle={styles.dayScrollContent}
        >
          {selectedDateAllDayEvents.length > 0 && (
            <View style={[styles.allDayCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>{t('calendar.allDay')}</Text>
              {selectedDateAllDayEvents.slice(0, 6).map((event) => (
                <Text key={event.id} style={[styles.allDayItem, { color: tc.text }]} numberOfLines={1}>
                  {event.title}
                </Text>
              ))}
            </View>
          )}

          <View style={[styles.timelineCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <View style={[styles.timelineArea, { height: timelineHeight }]}>
              <Pressable onPress={handleDayTimelinePress} style={styles.timelineTapTarget} />
              {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, idx) => {
                const hour = DAY_START_HOUR + idx;
                const top = idx * 60 * PIXELS_PER_MINUTE;
                return (
                  <View key={hour} pointerEvents="none" style={[styles.hourLine, { top }]}>
                    <Text style={[styles.hourLabel, { color: tc.secondaryText }]}>{formatHourLabel(hour)}</Text>
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
                return (
                  <View
                    key={event.id}
                    pointerEvents="none"
                    style={[
                      styles.eventBlock,
                      {
                        top,
                        height,
                        backgroundColor: toRgba(tc.secondaryText, isDark ? 0.35 : 0.18),
                        borderColor: sourceColorForId(event.sourceId),
                      },
                    ]}
                  >
                    <Text style={[styles.eventBlockTitle, { color: tc.text }]} numberOfLines={1}>
                      {event.title}
                    </Text>
                    <Text style={[styles.eventBlockTime, { color: tc.secondaryText }]} numberOfLines={1}>
                      {timeLabel}
                    </Text>
                  </View>
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
                    task={task}
                    dayStartMs={selectedDayStart.getTime()}
                    top={top}
                    height={height}
                    durationMinutes={durationMinutes}
                  />
                );
              })}
            </View>
          </View>

          <View style={[styles.dayScheduleCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            {nextQuickScheduleCandidates.length > 0 && (
              <View style={styles.scheduleResults}>
                <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>{t('nav.next')}</Text>
                {nextQuickScheduleCandidates.map((task) => {
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
    const weekColumnWidth = 150;
    return (
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <View style={styles.headerTopRow}>
            <Pressable onPress={() => shiftSelectedDate(-7)} style={styles.navButton}>
              <Text style={[styles.navButtonText, { color: tc.text }]}>‹</Text>
            </Pressable>
            <View style={styles.monthTitleWrap}>
              <Text style={[styles.title, { color: tc.text }]} numberOfLines={1}>
                {weekLabel}
              </Text>
              <Pressable onPress={handleToday} style={[styles.todayButton, { borderColor: tc.border }]}>
                <Text style={[styles.todayButtonText, { color: tc.tint }]}>{localize('Today', '今天')}</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => shiftSelectedDate(7)} style={styles.navButton}>
              <Text style={[styles.navButtonText, { color: tc.text }]}>›</Text>
            </Pressable>
          </View>
          {renderModeToggle()}
        </View>

        <ScrollView horizontal style={styles.weekHorizontal} contentContainerStyle={styles.weekHorizontalContent}>
          <View style={[styles.weekCanvas, { width: 56 + weekColumnWidth * weekDays.length }]}>
            <View style={[styles.weekHeaderRow, { borderBottomColor: tc.border }]}>
              <View style={styles.weekTimeGutter} />
              {weekDays.map((day) => (
                <Pressable
                  key={`header-${day.toISOString()}`}
                  onPress={() => {
                    setSelectedDate(day);
                    setViewMode('day');
                  }}
                  style={[styles.weekDayHeader, { width: weekColumnWidth, borderLeftColor: tc.border }, isToday(day) && { backgroundColor: toRgba(tc.tint, isDark ? 0.2 : 0.1) }]}
                >
                  <Text style={[styles.weekDayName, { color: tc.secondaryText }]}>
                    {day.toLocaleDateString(locale, { weekday: 'short' })}
                  </Text>
                  <Text style={[styles.weekDayNumber, { color: isToday(day) ? tc.tint : tc.text }]}>
                    {day.getDate()}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={[styles.weekAllDayRow, { borderBottomColor: tc.border }]}>
              <View style={styles.weekTimeGutter}>
                <Text style={[styles.weekAllDayLabel, { color: tc.secondaryText }]}>{t('calendar.allDay')}</Text>
              </View>
              {weekDays.map((day) => {
                const allDayItems = getCalendarItemsForDate(day)
                  .filter((item) => item.kind === 'deadline' || (item.kind === 'event' && item.event.allDay))
                  .slice(0, 3);
                return (
                  <View key={`all-${day.toISOString()}`} style={[styles.weekAllDayCell, { width: weekColumnWidth, borderLeftColor: tc.border }]}>
                    {allDayItems.map((item) => {
                      const isEvent = item.kind === 'event';
                      return (
                        <Pressable
                          key={item.id}
                          disabled={isEvent}
                          onPress={() => item.kind !== 'event' && openTaskActions(item.task.id)}
                          style={[
                            styles.weekAllDayItem,
                            {
                              backgroundColor: isEvent ? toRgba(tc.secondaryText, isDark ? 0.28 : 0.14) : tc.inputBg,
                              borderLeftColor: isEvent ? sourceColorForId(item.event.sourceId) : tc.danger,
                            },
                          ]}
                        >
                          <Text style={[styles.weekAllDayText, { color: tc.text }]} numberOfLines={1}>
                            {item.title}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
            </View>

            <ScrollView style={styles.weekVertical} contentContainerStyle={styles.weekVerticalContent}>
              <View style={styles.weekGridRow}>
                <View style={[styles.weekTimeGutter, { height: timelineHeight }]}>
                  {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, idx) => {
                    const hour = DAY_START_HOUR + idx;
                    return (
                      <Text key={hour} style={[styles.weekHourLabel, { top: idx * 60 * PIXELS_PER_MINUTE, color: tc.secondaryText }]}>
                        {formatHourLabel(hour)}
                      </Text>
                    );
                  })}
                </View>
                {weekDays.map((day) => {
                  const now = new Date();
                  const nowMinutes = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
                  const showNow = isToday(day) && nowMinutes >= 0 && nowMinutes <= (DAY_END_HOUR - DAY_START_HOUR) * 60;
                  const timedItems = getCalendarItemsForDate(day)
                    .filter((item) => item.kind === 'scheduled' || (item.kind === 'event' && !item.event.allDay));
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
                      {timedItems.map((item) => {
                        if (item.kind === 'event') {
                          const start = safeParseDate(item.event.start);
                          const end = safeParseDate(item.event.end);
                          if (!start || !end) return null;
                          const clampedStart = new Date(day);
                          clampedStart.setHours(DAY_START_HOUR, 0, 0, 0);
                          const clampedEnd = new Date(day);
                          clampedEnd.setHours(DAY_END_HOUR, 0, 0, 0);
                          const displayStart = new Date(Math.max(start.getTime(), clampedStart.getTime()));
                          const displayEnd = new Date(Math.min(end.getTime(), clampedEnd.getTime()));
                          const top = ((displayStart.getHours() - DAY_START_HOUR) * 60 + displayStart.getMinutes()) * PIXELS_PER_MINUTE;
                          const height = Math.max(24, ((displayEnd.getTime() - displayStart.getTime()) / 60_000) * PIXELS_PER_MINUTE);
                          return (
                            <View
                              key={item.id}
                              style={[
                                styles.weekBlock,
                                {
                                  top,
                                  height,
                                  backgroundColor: toRgba(tc.secondaryText, isDark ? 0.32 : 0.16),
                                  borderLeftColor: sourceColorForId(item.event.sourceId),
                                },
                              ]}
                            >
                              <Text style={[styles.weekBlockTitle, { color: tc.text }]} numberOfLines={1}>{item.title}</Text>
                              <Text style={[styles.weekBlockTime, { color: tc.secondaryText }]} numberOfLines={1}>
                                {`${safeFormatDate(displayStart, 'p')}-${safeFormatDate(displayEnd, 'p')}`}
                              </Text>
                            </View>
                          );
                        }

                        const start = item.task.startTime ? safeParseDate(item.task.startTime) : null;
                        if (!start) return null;
                        const durationMinutes = timeEstimateToMinutes(item.task.timeEstimate);
                        const top = ((start.getHours() - DAY_START_HOUR) * 60 + start.getMinutes()) * PIXELS_PER_MINUTE;
                        const height = Math.max(24, durationMinutes * PIXELS_PER_MINUTE);
                        return (
                          <Pressable
                            key={item.id}
                            onPress={(event) => {
                              event.stopPropagation();
                              openTaskActions(item.task.id);
                            }}
                            style={[
                              styles.weekBlock,
                              {
                                top,
                                height,
                                backgroundColor: isDark ? toRgba(tc.tint, 0.85) : tc.tint,
                                borderLeftColor: tc.tint,
                              },
                            ]}
                          >
                            <Text style={styles.weekTaskBlockTitle} numberOfLines={1}>{item.title}</Text>
                            <Text style={styles.weekTaskBlockTime} numberOfLines={1}>
                              {formatTimeRange(start, durationMinutes)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        </ScrollView>

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
            <Pressable onPress={handlePrevMonth} style={styles.navButton}>
              <Text style={[styles.navButtonText, { color: tc.text }]}>‹</Text>
            </Pressable>
            <View style={styles.monthTitleWrap}>
              <Text style={[styles.title, { color: tc.text }]}>{localize('Schedule', '日程')}</Text>
              <Pressable onPress={handleToday} style={[styles.todayButton, { borderColor: tc.border }]}>
                <Text style={[styles.todayButtonText, { color: tc.tint }]}>{localize('Today', '今天')}</Text>
              </Pressable>
            </View>
            <Pressable onPress={handleNextMonth} style={styles.navButton}>
              <Text style={[styles.navButtonText, { color: tc.text }]}>›</Text>
            </Pressable>
          </View>
          {renderModeToggle()}
        </View>

        <ScrollView style={styles.scheduleScroll} contentContainerStyle={styles.scheduleContent}>
          {scheduleSections.map((section) => (
            <View key={section.id} style={styles.scheduleSection}>
              <Text style={[styles.scheduleDate, { color: tc.secondaryText }]}>
                {section.date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                {isToday(section.date) ? ` · ${localize('Today', '今天')}` : ''}
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
                    return (
                      <View
                        key={item.id}
                        style={[
                          styles.scheduleItem,
                          styles.eventItem,
                          {
                            backgroundColor: tc.inputBg,
                            borderLeftColor: sourceColorForId(item.event.sourceId),
                          },
                        ]}
                      >
                        <View style={styles.taskItemMain}>
                          <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                            {item.title}
                          </Text>
                          <Text style={[styles.taskItemTime, { color: tc.secondaryText }]} numberOfLines={1}>
                            {sourceName ? `${timeLabel} · ${sourceName}` : timeLabel}
                          </Text>
                        </View>
                      </View>
                    );
                  }

                  const start = item.task.startTime ? safeParseDate(item.task.startTime) : null;
                  const timeLabel = start
                    ? formatTimeRange(start, timeEstimateToMinutes(item.task.timeEstimate))
                    : t('calendar.deadline');
                  return (
                    <Pressable
                      key={item.id}
                      style={[
                        styles.scheduleItem,
                        {
                          backgroundColor: item.kind === 'scheduled' ? toRgba(tc.tint, isDark ? 0.2 : 0.12) : tc.inputBg,
                          borderLeftColor: item.kind === 'scheduled' ? tc.tint : tc.danger,
                        },
                      ]}
                      onPress={() => openTaskActions(item.task.id)}
                    >
                      <View style={styles.taskItemMain}>
                        <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                          {timeLabel}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
          {scheduleSections.length === 0 && (
            <Text style={[styles.noTasks, { color: tc.secondaryText }]}>{t('calendar.noTasks')}</Text>
          )}
        </ScrollView>

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
        <View style={styles.headerTopRow}>
          <Pressable onPress={handlePrevMonth} style={styles.navButton}>
            <Text style={[styles.navButtonText, { color: tc.text }]}>‹</Text>
          </Pressable>
          <View style={styles.monthTitleWrap}>
            <Text style={[styles.title, { color: tc.text }]} numberOfLines={1}>
              {monthLabel}
            </Text>
            <Pressable onPress={handleToday} style={[styles.todayButton, { borderColor: tc.border }]}>
              <Text style={[styles.todayButtonText, { color: tc.tint }]}>{localize('Today', '今天')}</Text>
            </Pressable>
          </View>
          <Pressable onPress={handleNextMonth} style={styles.navButton}>
            <Text style={[styles.navButtonText, { color: tc.text }]}>›</Text>
          </Pressable>
        </View>
        {renderModeToggle()}
      </View>

      <View style={styles.monthCalendar}>
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

            const date = new Date(currentYear, currentMonth, day);
            const taskCount = getTaskCountForDate(date);
            const eventCount = getExternalEventsForDate(date).length;
            const calendarItems = getCalendarItemsForDate(date);
            const visibleItems = calendarItems.slice(0, calendarItems.length >= 6 ? 0 : 2);
            const isSelected = selectedDate && isSameDay(date, selectedDate);
            const todayCellBg = toRgba(tc.tint, isDark ? 0.12 : 0.08);
            const selectedCellBg = toRgba(tc.tint, isDark ? 0.2 : 0.16);

            return (
              <Pressable
                key={day}
                style={[
                  styles.dayCell,
                  selectedDate && styles.dayCellCompact,
                  isToday(date) && { backgroundColor: todayCellBg },
                  isSelected && { backgroundColor: selectedCellBg },
                ]}
                onPress={() => setSelectedDate(date)}
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
                    {day}
                  </Text>
                </View>
                {visibleItems.length > 0 && (
                  <View style={styles.monthPreviewList}>
                    {visibleItems.map((item) => {
                      const isEvent = item.kind === 'event';
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
                                : item.kind === 'deadline'
                                  ? tc.danger
                                  : tc.tint,
                            },
                          ]}
                        >
                          <Text
                            style={[styles.monthPreviewText, { color: item.kind === 'scheduled' ? tc.tint : tc.text }]}
                            numberOfLines={1}
                          >
                            {item.title}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}
                {calendarItems.length >= 6 && (taskCount > 0 || eventCount > 0) && (
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
      </View>

      {selectedDate && (
        <Animated.View style={[styles.monthDetailsPane, bottomSheetStyle, { backgroundColor: tc.cardBg, borderTopColor: tc.border }]}>
          <GestureDetector gesture={bottomSheetGesture}>
            <View style={styles.sheetHandleWrap}>
              <View style={[styles.sheetHandle, { backgroundColor: tc.border }]} />
            </View>
          </GestureDetector>
          <ScrollView contentContainerStyle={styles.monthDetailsContent} keyboardShouldPersistTaps="handled">
            <View style={styles.monthDetailsHeader}>
              <Text style={[styles.selectedDateTitle, { color: tc.text }]}>
                {selectedDateLongLabel}
              </Text>
              <Pressable onPress={() => openQuickAddForDate(selectedDate)} style={styles.addTaskButton}>
                <Text style={[styles.addTaskButtonText, { color: tc.tint }]}>{t('calendar.addTask')}</Text>
              </Pressable>
            </View>

            {nextQuickScheduleCandidates.length > 0 && (
              <View style={styles.scheduleResults}>
                <Text style={[styles.scheduleResultsTitle, { color: tc.secondaryText }]}>{t('nav.next')}</Text>
                {nextQuickScheduleCandidates.map((task) => {
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
                      {localize('Loading…', '加载中…')}
                    </Text>
                  )}
                  {externalError && (
                    <Text style={[styles.taskItemTime, { color: tc.danger }]} numberOfLines={2}>
                      {externalError}
                    </Text>
                  )}
                  {selectedDateExternalEvents.map((event) => (
                    <View
                      key={event.id}
                      style={[styles.taskItem, styles.eventItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.secondaryText }]}
                    >
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
                  ))}
                </View>
              )}

              {selectedDateDeadlines.map((task) => (
                <View key={task.id} style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}>
                  <Pressable style={styles.taskItemMain} onPress={() => openTaskActions(task.id)}>
                    <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                      {task.title}
                    </Text>
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {t('calendar.deadline')}
                    </Text>
                  </Pressable>
                  {task.status !== 'done' && task.status !== 'archived' && (
                    <Pressable
                      style={[styles.quickDoneButton, { borderColor: toRgba(tc.tint, 0.35), backgroundColor: toRgba(tc.tint, 0.16) }]}
                      onPress={() => markTaskDone(task.id)}
                    >
                      <Text style={[styles.quickDoneButtonText, { color: tc.tint }]}>{t('status.done')}</Text>
                    </Pressable>
                  )}
                </View>
              ))}

              {selectedDateScheduled.map((task) => (
                <Pressable
                  key={task.id}
                  style={[styles.taskItem, { backgroundColor: tc.inputBg, borderLeftColor: tc.tint }]}
                  onPress={() => openTaskActions(task.id)}
                >
                  <View style={styles.taskItemMain}>
                    <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                      {task.title}
                    </Text>
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {(() => {
                        const start = safeParseDate(task.startTime);
                        if (!start) return '';
                        const durMs = timeEstimateToMinutes(task.timeEstimate) * 60 * 1000;
                        const end = new Date(start.getTime() + durMs);
                        const startLabel = safeFormatDate(start, 'p');
                        const endLabel = safeFormatDate(end, 'p');
                        return `${startLabel}-${endLabel}`;
                      })()}
                    </Text>
                  </View>
                  {task.status !== 'done' && task.status !== 'archived' && (
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
              ))}

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
