import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  type Task,
  createPomodoroState,
  DEFAULT_POMODORO_DURATIONS,
  formatPomodoroClock,
  getPomodoroPresetOptions,
  type PomodoroAutoStartOptions,
  type PomodoroDurations,
  type PomodoroEvent,
  resetPomodoroState,
  tFallback,
  useTaskStore,
} from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { sendMobileImmediateNotification } from '../lib/notification-service';
import { logWarn } from '../lib/app-log';
import {
  POMODORO_SESSION_STORAGE_KEY,
  pausePomodoroSession,
  resolvePomodoroSession,
  serializePomodoroSession,
  startPomodoroSession,
} from '../lib/pomodoro-session';

export function PomodoroPanel({
  tasks,
  onMarkDone,
}: {
  tasks: Task[];
  onMarkDone: (taskId: string) => void;
}) {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const notificationsEnabled = useTaskStore((state) => state.settings.notificationsEnabled !== false);
  const customDurations = useTaskStore((state) => state.settings.gtd?.pomodoro?.customDurations);
  const linkTaskEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.linkTask === true);
  const autoStartBreaks = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartBreaks === true);
  const autoStartFocus = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartFocus === true);
  const autoStartOptions = useMemo<PomodoroAutoStartOptions>(
    () => ({ autoStartBreaks, autoStartFocus }),
    [autoStartBreaks, autoStartFocus]
  );
  const autoStartOptionsRef = useRef<PomodoroAutoStartOptions>(autoStartOptions);
  const [durations, setDurations] = useState<PomodoroDurations>(DEFAULT_POMODORO_DURATIONS);
  const [timerState, setTimerState] = useState(() => createPomodoroState(DEFAULT_POMODORO_DURATIONS));
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined);
  const [phaseEndsAt, setPhaseEndsAt] = useState<string | undefined>(undefined);
  const [lastEvent, setLastEvent] = useState<PomodoroEvent | null>(null);
  const [isHydratingSession, setIsHydratingSession] = useState(true);
  const [isTaskPickerOpen, setIsTaskPickerOpen] = useState(false);
  const previousEventRef = useRef<PomodoroEvent | null>(null);
  const hasHydratedRef = useRef(false);
  const persistedRemainingSeconds = timerState.isRunning && phaseEndsAt
    ? createPomodoroState(durations, timerState.phase, timerState.completedFocusSessions).remainingSeconds
    : timerState.remainingSeconds;

  const applyResolvedSession = (
    session: ReturnType<typeof resolvePomodoroSession>,
    options?: { emitEvent?: boolean },
  ) => {
    setDurations((prev) => (
      prev.focusMinutes === session.durations.focusMinutes && prev.breakMinutes === session.durations.breakMinutes
        ? prev
        : session.durations
    ));
    setTimerState((prev) => (
      prev.phase === session.timerState.phase
        && prev.remainingSeconds === session.timerState.remainingSeconds
        && prev.isRunning === session.timerState.isRunning
        && prev.completedFocusSessions === session.timerState.completedFocusSessions
        ? prev
        : session.timerState
    ));
    setSelectedTaskId((prev) => (prev === session.selectedTaskId ? prev : session.selectedTaskId));
    setPhaseEndsAt((prev) => (prev === session.phaseEndsAt ? prev : session.phaseEndsAt));
    if (options?.emitEvent !== false) {
      setLastEvent(session.lastEvent);
    }
  };

  useEffect(() => {
    autoStartOptionsRef.current = autoStartOptions;
  }, [autoStartOptions]);

  useEffect(() => {
    if (!linkTaskEnabled) {
      setIsTaskPickerOpen(false);
      return;
    }
    if (!selectedTaskId) return;
    if (tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(undefined);
  }, [linkTaskEnabled, selectedTaskId, tasks]);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        const raw = await AsyncStorage.getItem(POMODORO_SESSION_STORAGE_KEY);
        if (!raw || cancelled) return;
        const parsed = JSON.parse(raw) as ReturnType<typeof serializePomodoroSession>;
        if (cancelled) return;
        applyResolvedSession(resolvePomodoroSession(parsed, Date.now(), autoStartOptionsRef.current), { emitEvent: false });
      } catch (error) {
        void logWarn('Failed to restore pomodoro session', {
          scope: 'pomodoro',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        if (!cancelled) {
          hasHydratedRef.current = true;
          setIsHydratingSession(false);
        }
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedRef.current) return;
    const payload = serializePomodoroSession({
      durations,
      timerState: {
        phase: timerState.phase,
        isRunning: timerState.isRunning,
        completedFocusSessions: timerState.completedFocusSessions,
        remainingSeconds: persistedRemainingSeconds,
      },
      selectedTaskId,
      phaseEndsAt,
      lastEvent: null,
    });
    void AsyncStorage.setItem(POMODORO_SESSION_STORAGE_KEY, JSON.stringify(payload)).catch((error) => {
      void logWarn('Failed to persist pomodoro session', {
        scope: 'pomodoro',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  }, [
    durations,
    phaseEndsAt,
    selectedTaskId,
    timerState.completedFocusSessions,
    timerState.isRunning,
    timerState.phase,
    persistedRemainingSeconds,
  ]);

  useEffect(() => {
    if (!timerState.isRunning || !phaseEndsAt) return;
    const interval = setInterval(() => {
      applyResolvedSession(resolvePomodoroSession({
        durations,
        timerState,
        selectedTaskId,
        phaseEndsAt,
      }, Date.now(), autoStartOptions));
    }, 1000);
    return () => clearInterval(interval);
  }, [autoStartOptions, durations, phaseEndsAt, selectedTaskId, timerState]);

  const selectedTask = useMemo(
    () => (linkTaskEnabled && selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined),
    [linkTaskEnabled, selectedTaskId, tasks]
  );
  const presetOptions = useMemo(() => getPomodoroPresetOptions(customDurations), [customDurations]);

  const cardTitle = tFallback(t, 'pomodoro.title', 'Pomodoro Focus');
  const focusDoneLabel = tFallback(t, 'pomodoro.focusComplete', 'Focus session complete. Take a short break.');
  const breakDoneLabel = tFallback(t, 'pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
  const phaseLabel = timerState.phase === 'focus'
    ? tFallback(t, 'pomodoro.phaseFocus', 'Focus session')
    : tFallback(t, 'pomodoro.phaseBreak', 'Break');
  const noTaskLabel = tFallback(t, 'pomodoro.noTask', 'No available focus task');
  const loadingLabel = tFallback(t, 'common.loading', 'Loading...');
  const sessionsDoneLabel = tFallback(t, 'pomodoro.sessionsDone', 'Focus sessions completed');
  const pauseLabel = tFallback(t, 'common.pause', 'Pause');
  const startLabel = tFallback(t, 'common.start', 'Start');
  const resetLabel = tFallback(t, 'common.reset', 'Reset');
  const switchLabel = tFallback(t, 'pomodoro.switchPhase', 'Switch');
  const markDoneLabel = tFallback(t, 'pomodoro.markTaskDone', 'Mark task done');
  const selectedTaskLabel = tFallback(t, 'pomodoro.selectedTask', 'Timer task');
  const timerOnlyLabel = tFallback(t, 'pomodoro.timerOnly', 'Timer only');
  const changeTaskLabel = selectedTask ? tFallback(t, 'common.change', 'Change') : tFallback(t, 'pomodoro.linkTask', 'Link task');
  const taskDoneShortLabel = tFallback(t, 'pomodoro.taskDoneShort', 'Task done');

  useEffect(() => {
    const previous = previousEventRef.current;
    if (lastEvent && lastEvent !== previous && notificationsEnabled) {
      const message = lastEvent === 'focus-finished' ? focusDoneLabel : breakDoneLabel;
      void sendMobileImmediateNotification(cardTitle, message, {
        phase: lastEvent === 'focus-finished' ? 'focus-complete' : 'break-complete',
      });
    }
    previousEventRef.current = lastEvent;
  }, [breakDoneLabel, cardTitle, focusDoneLabel, lastEvent, notificationsEnabled]);

  const handleApplyPreset = (focusMinutes: number, breakMinutes: number) => {
    const nextDurations = { focusMinutes, breakMinutes };
    const session = resolvePomodoroSession({
      durations,
      timerState,
      selectedTaskId,
      phaseEndsAt,
    }, Date.now(), autoStartOptions);
    applyResolvedSession({
      ...session,
      durations: nextDurations,
      timerState: resetPomodoroState(session.timerState, nextDurations, session.timerState.phase),
      phaseEndsAt: undefined,
      lastEvent: null,
    });
  };

  const handleToggleRun = () => {
    const session = resolvePomodoroSession({
      durations,
      timerState,
      selectedTaskId,
      phaseEndsAt,
    }, Date.now(), autoStartOptions);
    if (session.lastEvent) {
      applyResolvedSession(session);
      return;
    }
    const next = session.timerState.isRunning
      ? pausePomodoroSession(session, Date.now(), autoStartOptions)
      : startPomodoroSession(session, Date.now(), autoStartOptions);
    applyResolvedSession(next);
  };

  const handleReset = () => {
    const session = resolvePomodoroSession({
      durations,
      timerState,
      selectedTaskId,
      phaseEndsAt,
    }, Date.now(), autoStartOptions);
    applyResolvedSession({
      ...session,
      timerState: resetPomodoroState(session.timerState, session.durations, session.timerState.phase),
      phaseEndsAt: undefined,
      lastEvent: null,
    });
  };

  const handleSwitchPhase = () => {
    const session = resolvePomodoroSession({
      durations,
      timerState,
      selectedTaskId,
      phaseEndsAt,
    }, Date.now(), autoStartOptions);
    applyResolvedSession({
      ...session,
      timerState: resetPomodoroState(
        session.timerState,
        session.durations,
        session.timerState.phase === 'focus' ? 'break' : 'focus',
      ),
      phaseEndsAt: undefined,
      lastEvent: null,
    });
  };

  const handleMarkDone = () => {
    if (!selectedTask) return;
    onMarkDone(selectedTask.id);
    setLastEvent(null);
  };

  return (
    <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: tc.text }]}>{cardTitle}</Text>
        </View>
        <View
          style={[
            styles.phaseBadge,
            timerState.phase === 'focus'
              ? { backgroundColor: '#2563EB20', borderColor: '#2563EB', }
              : { backgroundColor: '#05966920', borderColor: '#059669', },
          ]}
        >
          <Text style={[styles.phaseBadgeText, { color: timerState.phase === 'focus' ? '#2563EB' : '#059669' }]}>
            {phaseLabel}
          </Text>
        </View>
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
          {`${sessionsDoneLabel}: ${timerState.completedFocusSessions}`}
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
              backgroundColor: tc.tint,
              borderColor: tc.tint,
            },
          ]}
        >
          <Text style={[styles.actionPrimaryText, { color: tc.onTint }]}>
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
                  setSelectedTaskId(undefined);
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
              <ScrollView style={styles.taskPickerList} contentContainerStyle={styles.taskPickerListContent}>
                {tasks.length === 0 ? (
                  <Text style={[styles.noTaskText, { color: tc.secondaryText }]}>{noTaskLabel}</Text>
                ) : (
                  tasks.map((task) => {
                    const selected = task.id === selectedTaskId;
                    return (
                      <Pressable
                        key={task.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => {
                          setSelectedTaskId(task.id);
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
                  })
                )}
              </ScrollView>
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
  phaseBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  phaseBadgeText: {
    fontSize: 11,
    fontWeight: '700',
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
