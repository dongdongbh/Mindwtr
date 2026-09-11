import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import {
  type Task,
  formatPomodoroClock,
  getPomodoroFocusSessionsCompletedToday,
  getPomodoroPresetOptions,
  type PomodoroAutoStartOptions,
  tFallback,
  useTaskStore,
} from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { logWarn } from '../lib/app-log';
import { POMODORO_COLLAPSED_STORAGE_KEY } from '../lib/pomodoro-session';
import { mobilePomodoroController, useMobilePomodoroControllerState } from '../lib/pomodoro-controller';

export function PomodoroPanel({
  tasks,
  onMarkDone,
}: {
  tasks: Task[];
  onMarkDone: (taskId: string) => void;
}) {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const customDurations = useTaskStore((state) => state.settings.gtd?.pomodoro?.customDurations);
  const linkTaskEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.linkTask === true);
  const liveTasks = useTaskStore((state) => state.tasks);
  const autoStartBreaks = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartBreaks === true);
  const autoStartFocus = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartFocus === true);
  const autoStartOptions = useMemo<PomodoroAutoStartOptions>(
    () => ({ autoStartBreaks, autoStartFocus }),
    [autoStartBreaks, autoStartFocus]
  );
  const pomodoro = useMobilePomodoroControllerState();
  const { durations, timerState, selectedTaskId, lastEvent, sessionHistory } = pomodoro;
  // Presentation only, and deliberately device-local: a phone folding the card
  // away should not fold it away on the desktop too, so this lives in
  // AsyncStorage rather than synced settings (#946, matching desktop's #875).
  // Starts expanded so an update never hides a timer someone was already using.
  const [collapsed, setCollapsed] = useState(false);
  const isHydratingSession = pomodoro.isHydrating;
  const [isTaskPickerOpen, setIsTaskPickerOpen] = useState(false);

  useEffect(() => {
    void mobilePomodoroController.ensureHydrated(autoStartOptions);
  }, [autoStartOptions]);

  useEffect(() => {
    if (!linkTaskEnabled) {
      setIsTaskPickerOpen(false);
      return;
    }
    if (!selectedTaskId) return;
    if (liveTasks.some((task) => task.id === selectedTaskId)) return;
    mobilePomodoroController.setSelectedTaskId(undefined);
  }, [linkTaskEnabled, liveTasks, selectedTaskId]);

  const selectedTask = useMemo(
    () => (linkTaskEnabled && selectedTaskId ? liveTasks.find((task) => task.id === selectedTaskId) : undefined),
    [linkTaskEnabled, liveTasks, selectedTaskId]
  );
  const presetOptions = useMemo(() => getPomodoroPresetOptions(customDurations), [customDurations]);

  const cardTitle = tFallback(t, 'pomodoro.mobileTitle', 'Pomodoro Timer');
  const focusDoneLabel = tFallback(t, 'pomodoro.focusComplete', 'Focus session complete. Take a short break.');
  const breakDoneLabel = tFallback(t, 'pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
  const phaseLabel = timerState.phase === 'focus'
    ? tFallback(t, 'pomodoro.phaseFocusShort', 'Focus')
    : tFallback(t, 'pomodoro.phaseBreakShort', 'Break');
  const noTaskLabel = tFallback(t, 'pomodoro.noTask', 'No available focus task');
  const loadingLabel = tFallback(t, 'common.loading', 'Loading...');
  const sessionsDoneLabel = tFallback(t, 'pomodoro.sessionsDone', 'Focus sessions completed');
  const pauseLabel = tFallback(t, 'common.pause', 'Pause');
  const startLabel = tFallback(t, 'common.start', 'Start');
  const resetLabel = tFallback(t, 'common.reset', 'Reset');
  const switchLabel = timerState.phase === 'focus'
    ? tFallback(t, 'pomodoro.switchToBreak', 'Switch to Break')
    : tFallback(t, 'pomodoro.switchToFocus', 'Switch to Focus');
  const markDoneLabel = tFallback(t, 'pomodoro.markTaskDone', 'Mark task done');
  const selectedTaskLabel = tFallback(t, 'pomodoro.selectedTask', 'Timer task');
  const timerOnlyLabel = tFallback(t, 'pomodoro.timerOnly', 'Timer only');
  const changeTaskLabel = selectedTask ? tFallback(t, 'common.change', 'Change') : tFallback(t, 'pomodoro.linkTask', 'Link task');
  const taskDoneShortLabel = tFallback(t, 'pomodoro.taskDoneShort', 'Task done');
  const runningLabel = tFallback(t, 'pomodoro.running', 'Running');
  const pausedLabel = tFallback(t, 'pomodoro.paused', 'Paused');
  const handleApplyPreset = (focusMinutes: number, breakMinutes: number) => {
    mobilePomodoroController.setDurations({ focusMinutes, breakMinutes }, autoStartOptions);
  };

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(POMODORO_COLLAPSED_STORAGE_KEY)
      .then((raw) => {
        if (!active || raw === null) return;
        setCollapsed(raw === 'true');
      })
      .catch((error) => {
        logWarn('Failed to read pomodoro collapse preference', { scope: 'pomodoro', extra: { error: String(error) } });
      });
    return () => {
      active = false;
    };
  }, []);

  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next);
    void AsyncStorage.setItem(POMODORO_COLLAPSED_STORAGE_KEY, String(next)).catch((error) => {
      logWarn('Failed to save pomodoro collapse preference', { scope: 'pomodoro', extra: { error: String(error) } });
    });
  };

  const handleToggleRun = () => {
    mobilePomodoroController.toggle(autoStartOptions);
  };

  const handleReset = () => {
    mobilePomodoroController.reset(autoStartOptions);
  };

  const handleSwitchPhase = () => {
    mobilePomodoroController.switchPhase(autoStartOptions);
  };

  const handleMarkDone = () => {
    if (!selectedTask) return;
    onMarkDone(selectedTask.id);
    mobilePomodoroController.clearLastEvent();
  };

  const collapseLabel = tFallback(t, 'pomodoro.collapse', 'Collapse timer');
  const expandLabel = tFallback(t, 'pomodoro.expand', 'Expand timer');
  const phaseColor = timerState.phase === 'focus' ? tc.tint : tc.success;

  const collapseToggle = (
    <Pressable
      accessibilityLabel={collapsed ? expandLabel : collapseLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => toggleCollapsed(!collapsed)}
      style={styles.collapseToggle}
    >
      {collapsed
        ? <ChevronDown size={18} color={tc.secondaryText} />
        : <ChevronUp size={18} color={tc.secondaryText} />}
    </Pressable>
  );

  if (collapsed) {
    // The session state and its timers live above this branch, so folding the
    // card away never stops the run — the clock here is the same one.
    return (
      <View style={[styles.card, styles.collapsedCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
        <View style={styles.collapsedRow}>
          <Text style={[styles.collapsedClock, { color: tc.text }]}>
            {formatPomodoroClock(timerState.remainingSeconds)}
          </Text>
          <Text style={[styles.phaseStatusText, { color: phaseColor }]} numberOfLines={1}>
            {`${phaseLabel} · ${timerState.isRunning ? runningLabel : pausedLabel}`}
          </Text>
          {timerState.isRunning && (
            <View
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.collapsedRunningDot, { backgroundColor: phaseColor }]}
            />
          )}
          <View style={styles.collapsedSpacer} />
          {collapseToggle}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: tc.text }]}>{cardTitle}</Text>
        </View>
        <View style={styles.phaseStatus}>
          <Text style={[styles.phaseStatusText, { color: phaseColor }]}>
            {phaseLabel}
          </Text>
        </View>
        {collapseToggle}
      </View>

      {isHydratingSession && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={tc.tint} />
          <Text style={[styles.loadingText, { color: tc.secondaryText }]}>{loadingLabel}</Text>
        </View>
      )}

      <View style={styles.presetRow}>
        {presetOptions.map((preset) => {
          const active = durations.focusMinutes === preset.focusMinutes && durations.breakMinutes === preset.breakMinutes;
          return (
            <Pressable
              key={preset.id}
              onPress={() => handleApplyPreset(preset.focusMinutes, preset.breakMinutes)}
              disabled={isHydratingSession}
              style={[
                styles.presetChip,
                {
                  opacity: isHydratingSession ? 0.6 : 1,
                  borderColor: active ? tc.tint : tc.border,
                  backgroundColor: active ? tc.tint : tc.filterBg,
                },
              ]}
            >
              <Text style={[styles.presetText, { color: active ? tc.onTint : tc.secondaryText }]}>{preset.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.timerBox}>
        <Text style={[styles.timerText, { color: tc.text }]}>{formatPomodoroClock(timerState.remainingSeconds)}</Text>
        <Text style={[styles.sessionText, { color: tc.secondaryText }]}>
          {`${sessionsDoneLabel}: ${getPomodoroFocusSessionsCompletedToday(sessionHistory)}`}
        </Text>
      </View>

      {linkTaskEnabled && (
        <View style={styles.taskLinkRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={selectedTaskLabel}
            onPress={() => setIsTaskPickerOpen(true)}
            style={[styles.taskPickerButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
          >
            <View style={styles.taskPickerTextBlock}>
              <Text style={[styles.taskPickerLabel, { color: tc.secondaryText }]}>{selectedTaskLabel}</Text>
              <Text style={[styles.taskPickerValue, { color: tc.text }]} numberOfLines={1}>
                {selectedTask?.title ?? timerOnlyLabel}
              </Text>
            </View>
            <Text style={[styles.taskPickerAction, { color: tc.tint }]}>{changeTaskLabel}</Text>
          </Pressable>
          {selectedTask && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={markDoneLabel}
              onPress={handleMarkDone}
              disabled={!selectedTask || isHydratingSession}
              style={[
                styles.actionDone,
                {
                  opacity: selectedTask && !isHydratingSession ? 1 : 0.5,
                  borderColor: tc.success,
                  backgroundColor: `${tc.success}18`,
                },
              ]}
            >
              <Text style={[styles.actionDoneText, { color: tc.success }]}>
                {taskDoneShortLabel}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.timerActionRow}>
        <Pressable
          onPress={handleToggleRun}
          disabled={isHydratingSession}
          style={[
            styles.actionPrimary,
            {
              opacity: isHydratingSession ? 0.5 : 1,
              backgroundColor: filledButton.backgroundColor,
              borderColor: filledButton.backgroundColor,
            },
          ]}
        >
          <Text style={[styles.actionPrimaryText, { color: filledButton.textColor ?? tc.onTint }]}>
            {timerState.isRunning ? pauseLabel : startLabel}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleReset}
          disabled={isHydratingSession}
          style={[styles.actionSecondary, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
        >
          <Text style={[styles.actionSecondaryText, { color: tc.secondaryText }]}>
            {resetLabel}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={switchLabel}
          onPress={handleSwitchPhase}
          disabled={isHydratingSession}
          style={[styles.actionSecondary, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
        >
          <Text style={[styles.actionSecondaryText, { color: tc.secondaryText }]}>
            {switchLabel}
          </Text>
        </Pressable>
      </View>

      {lastEvent && (
        <Text style={[styles.eventText, { color: tc.secondaryText }]}>
          {lastEvent === 'focus-finished' ? focusDoneLabel : breakDoneLabel}
        </Text>
      )}

      {linkTaskEnabled && (
        <Modal
          visible={isTaskPickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setIsTaskPickerOpen(false)}
        >
          <View style={styles.modalRoot}>
            <Pressable style={styles.modalScrim} onPress={() => setIsTaskPickerOpen(false)} />
            <View style={[styles.taskPickerSheet, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <Text style={[styles.taskPickerSheetTitle, { color: tc.text }]}>{selectedTaskLabel}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: !selectedTaskId }}
                onPress={() => {
                  mobilePomodoroController.setSelectedTaskId(undefined);
                  setIsTaskPickerOpen(false);
                }}
                style={[
                  styles.taskPickerOption,
                  {
                    borderColor: !selectedTaskId ? tc.tint : tc.border,
                    backgroundColor: !selectedTaskId ? `${tc.tint}18` : tc.filterBg,
                  },
                ]}
              >
                <Text style={[styles.taskPickerOptionText, { color: !selectedTaskId ? tc.tint : tc.text }]}>
                  {timerOnlyLabel}
                </Text>
              </Pressable>
              <FlatList
                data={tasks}
                renderItem={({ item: task }) => {
                  const selected = task.id === selectedTaskId;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => {
                        mobilePomodoroController.setSelectedTaskId(task.id);
                        setIsTaskPickerOpen(false);
                      }}
                      style={[
                        styles.taskPickerOption,
                        {
                          borderColor: selected ? tc.tint : tc.border,
                          backgroundColor: selected ? `${tc.tint}18` : tc.filterBg,
                        },
                      ]}
                    >
                      <Text
                        style={[styles.taskPickerOptionText, { color: selected ? tc.tint : tc.text }]}
                        numberOfLines={2}
                      >
                        {task.title}
                      </Text>
                    </Pressable>
                  );
                }}
                keyExtractor={(task) => task.id}
                style={styles.taskPickerList}
                contentContainerStyle={styles.taskPickerListContent}
                initialNumToRender={12}
                maxToRenderPerBatch={12}
                windowSize={5}
                updateCellsBatchingPeriod={50}
                removeClippedSubviews={false}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <Text style={[styles.noTaskText, { color: tc.secondaryText }]}>{noTaskLabel}</Text>
                }
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
    gap: 8,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  collapsedCard: {
    paddingVertical: 10,
  },
  collapsedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  collapsedClock: {
    fontSize: 20,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  collapsedRunningDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  collapsedSpacer: {
    flex: 1,
  },
  collapseToggle: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },

  headerText: {
    flex: 1,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 12,
    fontWeight: '500',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  phaseStatus: {
    paddingTop: 2,
  },
  phaseStatusText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  presetText: {
    fontSize: 11,
    fontWeight: '700',
  },
  timerBox: {
    alignItems: 'center',
    gap: 2,
  },
  timerText: {
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  sessionText: {
    fontSize: 11,
    fontWeight: '600',
  },
  taskLinkRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
  },
  taskPickerButton: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  taskPickerTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  taskPickerLabel: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  taskPickerValue: {
    fontSize: 13,
    fontWeight: '700',
  },
  taskPickerAction: {
    fontSize: 12,
    fontWeight: '700',
  },
  timerActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionPrimary: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  actionPrimaryText: {
    fontSize: 12,
    fontWeight: '700',
  },
  actionSecondary: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  actionSecondaryText: {
    fontSize: 12,
    fontWeight: '700',
  },
  actionDone: {
    borderWidth: 1,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  actionDoneText: {
    fontSize: 12,
    fontWeight: '700',
  },
  eventText: {
    fontSize: 12,
    fontWeight: '500',
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#00000099',
  },
  taskPickerSheet: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 10,
    maxHeight: '72%',
  },
  taskPickerSheetTitle: {
    fontSize: 16,
    fontWeight: '800',
  },
  taskPickerList: {
    maxHeight: 320,
  },
  taskPickerListContent: {
    gap: 8,
  },
  taskPickerOption: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  taskPickerOptionText: {
    fontSize: 14,
    fontWeight: '700',
  },
  noTaskText: {
    fontSize: 13,
    fontWeight: '600',
    paddingVertical: 8,
  },
});
