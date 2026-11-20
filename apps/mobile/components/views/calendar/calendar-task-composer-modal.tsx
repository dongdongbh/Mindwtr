import {
  CALENDAR_TIME_ESTIMATE_OPTIONS,
  createCalendarLocaleDates,
  formatCalendarComposerClockValue,
  getCalendarComposerText,
  isCalendarComposerSaveDisabled,
  resolveFeatureFlags,
  useTaskStore,
  type CalendarViewComposerState,
  type DateFormatter,
  type Task,
} from '@mindwtr/core';
import React from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ScrollView as ResultsScrollView } from 'react-native-gesture-handler';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './calendar-view.styles';

export type MobileCalendarComposerState = CalendarViewComposerState;

type CalendarTaskComposerModalProps = {
  bottomInset: number;
  candidates: Task[];
  closeComposer: () => void;
  composer: MobileCalendarComposerState | null;
  endTimePlaceholder: string;
  error: string | null;
  formatDate: DateFormatter;
  formatDurationLabel: (minutes: number) => string;
  isDark: boolean;
  keyboardInset: number;
  locale: string;
  saveComposer: () => void;
  selectTask: (task: Task) => void;
  selectedTask: Task | null;
  setDuration: (minutes: number) => void;
  setEndTime: (value: string) => void;
  setMode: (mode: 'new' | 'existing') => void;
  setQuery: (value: string) => void;
  setStartTime: (value: string) => void;
  setTitle: (value: string) => void;
  startTimePlaceholder: string;
  t: (key: string) => string;
  tc: ThemeColors;
  toRgba: (hex: string, alpha: number) => string;
};

export function CalendarTaskComposerModal({
  bottomInset,
  candidates,
  closeComposer,
  composer,
  endTimePlaceholder,
  error,
  formatDate,
  formatDurationLabel,
  isDark,
  keyboardInset,
  locale,
  saveComposer,
  selectTask,
  selectedTask,
  setDuration,
  setEndTime,
  setMode,
  setQuery,
  setStartTime,
  setTitle,
  startTimePlaceholder,
  t,
  tc,
  toRgba,
}: CalendarTaskComposerModalProps) {
  const prioritiesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
  const timeEstimatesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).timeEstimates);
  const [focusedTime, setFocusedTime] = React.useState<'start' | 'end' | null>(null);
  React.useEffect(() => {
    if (!composer) setFocusedTime(null);
  }, [composer]);
  const saveDisabled = isCalendarComposerSaveDisabled(composer);
  const text = getCalendarComposerText(t, { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled });
  const end = composer?.startAt ? new Date(composer.startAt.getTime() + composer.durationMinutes * 60_000) : null;

  return (
    <Modal
      accessibilityViewIsModal
      animationType="fade"
      onRequestClose={closeComposer}
      transparent
      visible={Boolean(composer)}
    >
      <View
        style={keyboardInset > 0
          ? [styles.composerBackdrop, { paddingBottom: keyboardInset }]
          : styles.composerBackdrop}
      >
        {composer && (
          <ScrollView
            accessibilityViewIsModal
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.composerContent, { paddingBottom: Math.max(18, bottomInset + 14) }]}
            style={[
              styles.calendarComposer,
              {
                backgroundColor: tc.cardBg,
                borderColor: tc.border,
              },
            ]}
          >
            <View style={styles.composerHeader}>
              <View style={styles.taskItemMain}>
                <Text accessibilityRole="header" style={[styles.composerTitle, { color: tc.text }]}>
                  {text.title}
                </Text>
                <Text style={[styles.composerDate, { color: tc.secondaryText }]}>
                  {createCalendarLocaleDates(locale).shortDate(composer.date)}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={text.close}
                accessibilityRole="button"
                hitSlop={6}
                onPress={closeComposer}
                style={styles.composerCloseButton}
              >
                <Text style={[styles.composerCloseText, { color: tc.secondaryText }]}>×</Text>
              </Pressable>
            </View>

            <View style={[styles.composerModeToggle, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
              {[
                { value: 'new' as const, label: text.newTask },
                { value: 'existing' as const, label: text.existingTask },
              ].map((option) => {
                const active = composer.mode === option.value;
                return (
                  <Pressable
                    accessibilityLabel={option.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    key={option.value}
                    onPress={() => setMode(option.value)}
                    style={[styles.composerModeButton, active && { backgroundColor: tc.tint }]}
                  >
                    <Text style={[styles.composerModeText, { color: active ? tc.onTint : tc.secondaryText }]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {composer.mode === 'new' ? (
              <View style={styles.composerSection}>
                <TextInput
                  accessibilityLabel={text.titlePlaceholder}
                  onChangeText={setTitle}
                  placeholder={text.titlePlaceholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={composer.title}
                />
                <Text style={[styles.composerHelp, { color: tc.secondaryText }]}>
                  {text.help}
                </Text>
              </View>
            ) : (
              <View style={styles.composerSection}>
                <TextInput
                  accessibilityLabel={text.queryPlaceholder}
                  onChangeText={setQuery}
                  placeholder={text.queryPlaceholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={composer.query}
                />
                <ResultsScrollView nestedScrollEnabled style={styles.composerResults} keyboardShouldPersistTaps="handled">
                  {candidates.map((task) => {
                    const selected = task.id === composer.selectedTaskId;
                    return (
                      <Pressable
                        accessibilityLabel={task.title}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        key={task.id}
                        onPress={() => selectTask(task)}
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
                  {candidates.length === 0 && (
                    <Text style={[styles.noTasks, { color: tc.secondaryText }]}>
                      {text.noMatchingTasks}
                    </Text>
                  )}
                </ResultsScrollView>
                {selectedTask && (
                  <Text
                    accessibilityLiveRegion="polite"
                    numberOfLines={1}
                    style={[styles.composerSelectedTask, { color: tc.tint, backgroundColor: toRgba(tc.tint, isDark ? 0.22 : 0.12) }]}
                  >
                    {selectedTask.title}
                  </Text>
                )}
              </View>
            )}

            <View style={styles.composerTimeRow}>
              <View style={styles.composerTimeField}>
                <Text style={[styles.composerLabel, { color: tc.secondaryText }]}>{text.start}</Text>
                <TextInput
                  accessibilityLabel={text.start}
                  keyboardType="numbers-and-punctuation"
                  onChangeText={setStartTime}
                  onFocus={() => setFocusedTime('start')}
                  onBlur={() => setFocusedTime(null)}
                  placeholder={startTimePlaceholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerTimeInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={focusedTime === 'start' ? composer.startTimeValue : formatCalendarComposerClockValue(composer.startTimeValue, composer.startAt, formatDate)}
                />
              </View>
              <View style={styles.composerTimeField}>
                <Text style={[styles.composerLabel, { color: tc.secondaryText }]}>{text.end}</Text>
                <TextInput
                  accessibilityLabel={text.end}
                  keyboardType="numbers-and-punctuation"
                  onChangeText={setEndTime}
                  onFocus={() => setFocusedTime('end')}
                  onBlur={() => setFocusedTime(null)}
                  placeholder={endTimePlaceholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerTimeInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={focusedTime === 'end' ? composer.endTimeValue : formatCalendarComposerClockValue(composer.endTimeValue, end, formatDate)}
                />
              </View>
            </View>

            <View style={styles.durationChips}>
              {CALENDAR_TIME_ESTIMATE_OPTIONS.map((option) => {
                const active = composer.durationMinutes === option.minutes;
                const durationLabel = formatDurationLabel(option.minutes);
                return (
                  <Pressable
                    accessibilityLabel={durationLabel}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    hitSlop={6}
                    key={option.estimate}
                    onPress={() => setDuration(option.minutes)}
                    style={[
                      styles.durationChip,
                      {
                        backgroundColor: active ? tc.tint : tc.inputBg,
                        borderColor: active ? tc.tint : tc.border,
                      },
                    ]}
                  >
                    <Text style={[styles.durationChipText, { color: active ? tc.onTint : tc.secondaryText }]}>
                      {durationLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {error && (
              <Text
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                style={[styles.composerError, { color: tc.danger }]}
              >
                {error}
              </Text>
            )}

            <View style={styles.composerActions}>
              <Pressable
                accessibilityLabel={text.cancel}
                accessibilityRole="button"
                onPress={closeComposer}
                style={[styles.composerCancelButton, { backgroundColor: tc.inputBg }]}
              >
                <Text style={[styles.composerActionText, { color: tc.text }]}>{text.cancel}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={text.save}
                accessibilityRole="button"
                accessibilityState={{ disabled: saveDisabled }}
                disabled={saveDisabled}
                onPress={saveComposer}
                style={[
                  styles.composerSaveButton,
                  {
                    backgroundColor: tc.tint,
                    opacity: saveDisabled ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.composerActionText, { color: tc.onTint }]}>{text.save}</Text>
              </Pressable>
            </View>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
