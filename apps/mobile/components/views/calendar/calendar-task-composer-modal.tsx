import {
  CALENDAR_TIME_ESTIMATE_OPTIONS,
  formatQuickAddHelp,
  resolveFeatureFlags,
  useTaskStore,
  type CalendarComposerState,
  type Task,
} from '@mindwtr/core';
import React from 'react';
import {
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './calendar-view.styles';

export type MobileCalendarComposerState = CalendarComposerState & {
  date: Date;
  startTimeValue: string;
};

type CalendarTaskComposerModalProps = {
  bottomInset: number;
  candidates: Task[];
  closeComposer: () => void;
  composer: MobileCalendarComposerState | null;
  endTimePlaceholder: string;
  error: string | null;
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
  tr: (key: string) => string;
};

export function CalendarTaskComposerModal({
  bottomInset,
  candidates,
  closeComposer,
  composer,
  endTimePlaceholder,
  error,
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
  tr,
}: CalendarTaskComposerModalProps) {
  const prioritiesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
  const saveDisabled = composer
    ? composer.mode === 'new'
      ? !composer.title.trim()
      : !composer.selectedTaskId
    : true;

  return (
    <Modal
      accessibilityViewIsModal
      animationType="fade"
      onRequestClose={closeComposer}
      transparent
      visible={Boolean(composer)}
    >
      <Pressable
        accessible={false}
        onPress={closeComposer}
        style={keyboardInset > 0
          ? [styles.composerBackdrop, { paddingBottom: keyboardInset }]
          : styles.composerBackdrop}
      >
        {composer && (
          <View
            accessibilityViewIsModal
            onTouchEnd={(event) => event.stopPropagation()}
            style={[
              styles.calendarComposer,
              {
                backgroundColor: tc.cardBg,
                borderColor: tc.border,
                paddingBottom: Math.max(18, bottomInset + 14),
              },
            ]}
          >
            <View style={styles.composerHeader}>
              <View style={styles.taskItemMain}>
                <Text accessibilityRole="header" style={[styles.composerTitle, { color: tc.text }]}>
                  {tr('calendar.mobile.scheduleTask')}
                </Text>
                <Text style={[styles.composerDate, { color: tc.secondaryText }]}>
                  {composer.date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={t('common.close')}
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
                { value: 'new' as const, label: tr('calendar.mobile.newTask') },
                { value: 'existing' as const, label: tr('calendar.mobile.existingTask') },
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
                  accessibilityLabel={t('calendar.addTask')}
                  onChangeText={setTitle}
                  placeholder={t('calendar.addTask')}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={composer.title}
                />
                <Text style={[styles.composerHelp, { color: tc.secondaryText }]}>
                  {formatQuickAddHelp(t('quickAdd.help'), { priorities: prioritiesEnabled })}
                </Text>
              </View>
            ) : (
              <View style={styles.composerSection}>
                <TextInput
                  accessibilityLabel={t('calendar.schedulePlaceholder')}
                  onChangeText={setQuery}
                  placeholder={t('calendar.schedulePlaceholder')}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={composer.query}
                />
                <ScrollView style={styles.composerResults} keyboardShouldPersistTaps="handled">
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
                      {tr('calendar.mobile.noMatchingTasks')}
                    </Text>
                  )}
                </ScrollView>
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
                <Text style={[styles.composerLabel, { color: tc.secondaryText }]}>{tr('taskEdit.start')}</Text>
                <TextInput
                  accessibilityLabel={tr('taskEdit.start')}
                  keyboardType="numbers-and-punctuation"
                  onChangeText={setStartTime}
                  placeholder={startTimePlaceholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerTimeInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={composer.startTimeValue}
                />
              </View>
              <View style={styles.composerTimeField}>
                <Text style={[styles.composerLabel, { color: tc.secondaryText }]}>{tr('calendar.mobile.end')}</Text>
                <TextInput
                  accessibilityLabel={tr('calendar.mobile.end')}
                  keyboardType="numbers-and-punctuation"
                  onChangeText={setEndTime}
                  placeholder={endTimePlaceholder}
                  placeholderTextColor={tc.secondaryText}
                  style={[styles.input, styles.composerTimeInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  value={composer.endTimeValue}
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
                accessibilityLabel={t('common.cancel')}
                accessibilityRole="button"
                onPress={closeComposer}
                style={[styles.composerCancelButton, { backgroundColor: tc.inputBg }]}
              >
                <Text style={[styles.composerActionText, { color: tc.text }]}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('common.save')}
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
                <Text style={[styles.composerActionText, { color: tc.onTint }]}>{t('common.save')}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </Pressable>
    </Modal>
  );
}
