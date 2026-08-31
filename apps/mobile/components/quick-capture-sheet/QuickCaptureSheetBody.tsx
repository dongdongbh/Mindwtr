import React from 'react';
import type { RefObject } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, TextInput, TouchableOpacity, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { AtSign, CalendarDays, ChevronDown, ChevronUp, Clock, FileText, Flag, Folder, Layers, Mic, SlidersHorizontal, Square, X } from 'lucide-react-native';
import { formatQuickAddHelp, tFallback } from '@mindwtr/core';
import { ToastViewport } from '@/contexts/toast-context';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText, CompactTextInput } from '@/components/compact-text';
import { ThemedAlertHost } from '@/components/themed-alert';
import { QuickDateChips } from '../QuickDateChips';
import { FocusStarIcon, FOCUS_STAR_COLOR } from '../FocusStarIcon';
import { styles } from './quick-capture-sheet.styles';

// Quick capture favors speed: show only the most-reached date presets inline.
// Rarer choices (+3 days, next month) and clearing live behind the Custom picker / tapping the active chip.
const QUICK_CAPTURE_DATE_PRESETS = ['today', 'tomorrow', 'next_week'] as const;

// An expanded "More" panel is taller than the space left above the keyboard, so without
// a scroll container it pushes the title input off the top of the screen with no way back
// (#887 on iOS, #1120 on Android). Android dismisses the keyboard before expanding, but it
// comes straight back when the user taps the title to keep typing, and the measured lift
// then leaves the tall sheet no room. Only the More panel scrolls: the title input must
// stay OUTSIDE this container, because UIKit auto-scrolls a focused TextInput inside a
// UIScrollView above the keyboard, which double-counts against KeyboardAvoidingView and
// flings the title off the top on every refocus (the regression the first #887 fix shipped).
function SheetScrollArea({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      style={styles.scrollArea}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
      testID="quick-capture-scroll"
    >
      {children}
    </ScrollView>
  );
}

interface QuickCaptureSheetBodyProps {
  addAnother: boolean;
  areaLabel: string;
  children?: React.ReactNode;
  contextLabel: string;
  dueLabel: string;
  dueDate: Date | null;
  dueTimeLabel: string;
  focusNewTask?: boolean;
  canFocusNewTask?: boolean;
  focusNewTaskDisabledReason?: string;
  contentAccessibilityHidden?: boolean;
  handleClose: () => void;
  handleRequestClose?: () => void;
  handleImportTextFile?: () => void;
  handleSave: () => void;
  handleSaveAndEdit?: () => void;
  insetsBottom: number;
  inputRef: RefObject<TextInput | null>;
  keyboardAvoidingEnabled?: boolean;
  androidKeyboardInset?: number;
  noteValue: string;
  onNoteChange: (value: string) => void;
  onOpenAreaPicker: () => void;
  onOpenContextPicker: () => void;
  onOpenDueDatePicker: () => void;
  onOpenDueTimePicker: () => void;
  onOpenPriorityPicker: () => void;
  onOpenProjectPicker: () => void;
  onQuickDueDateSelect: (date: Date | null) => void;
  onResetArea: () => void;
  onResetContexts: () => void;
  onResetDueDate: () => void;
  onResetDueTime: () => void;
  onResetPriority: () => void;
  onResetProject: () => void;
  onToggleOptions: () => void;
  onToggleAddAnother: (value: boolean) => void;
  onToggleFocusNewTask?: () => void;
  onToggleRecording: () => void;
  onValueChange: (value: string) => void;
  optionsExpanded: boolean;
  /** Passive parse read-out; rendered under the title input, above the chips. */
  preview?: React.ReactNode;
  prioritiesEnabled: boolean;
  priorityLabel: string;
  projectLabel: string;
  projectSelected?: boolean;
  recording: boolean;
  recordingBusy: boolean;
  recordingReady: boolean;
  saving?: boolean;
  saveButtonBackgroundColor?: string;
  saveButtonTextColor?: string;
  sheetMaxHeight: number;
  showDueTime: boolean;
  t: (key: string) => string;
  tc: ThemeColors;
  value: string;
  visible: boolean;
}

export function QuickCaptureSheetBody({
  addAnother,
  areaLabel,
  children,
  contextLabel,
  dueDate,
  dueLabel,
  dueTimeLabel,
  focusNewTask = false,
  canFocusNewTask = true,
  focusNewTaskDisabledReason,
  contentAccessibilityHidden = false,
  handleClose,
  handleRequestClose,
  handleImportTextFile,
  handleSave,
  handleSaveAndEdit,
  insetsBottom,
  inputRef,
  keyboardAvoidingEnabled = true,
  androidKeyboardInset = 0,
  noteValue,
  onNoteChange,
  onOpenAreaPicker,
  onOpenContextPicker,
  onOpenDueDatePicker,
  onOpenDueTimePicker,
  onOpenPriorityPicker,
  onOpenProjectPicker,
  onQuickDueDateSelect,
  onResetArea,
  onResetContexts,
  onResetDueDate,
  onResetDueTime,
  onResetPriority,
  onResetProject,
  onToggleOptions,
  onToggleAddAnother,
  onToggleFocusNewTask = () => {},
  onToggleRecording,
  onValueChange,
  optionsExpanded,
  preview,
  prioritiesEnabled,
  priorityLabel,
  projectLabel,
  projectSelected = false,
  recording,
  recordingBusy,
  recordingReady,
  saving = false,
  saveButtonBackgroundColor,
  saveButtonTextColor,
  sheetMaxHeight,
  showDueTime,
  t,
  tc,
  value,
  visible,
}: QuickCaptureSheetBodyProps) {
  const optionsToggleLabel = optionsExpanded ? t('taskEdit.hideOptions') : tFallback(t, 'common.more', 'More');
  const defaultProjectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');
  const focusDisabled = !focusNewTask && !canFocusNewTask;
  const addFocusLabel = tFallback(t, 'agenda.addToFocus', "Add to today's focus");
  const removeFocusLabel = tFallback(t, 'agenda.removeFromFocus', 'Remove from focus');
  const focusLabel = focusNewTask
    ? removeFocusLabel
    : (focusDisabled ? (focusNewTaskDisabledReason || addFocusLabel) : addFocusLabel);
  // Short visible label for the property chip; reuses the Focus screen title so it
  // stays translated everywhere without minting a new English-only string.
  const focusChipLabel = tFallback(t, 'agenda.title', 'Focus');
  // Drop the trailing ellipsis here so the Custom chip is narrow enough to sit on the preset row;
  // the shared recurrence.custom string (used elsewhere) keeps its "…".
  const customDateLabel = t('recurrence.custom').replace(/[\s.…]+$/u, '');
  // iOS resizes the modal via padding behavior; Android keeps the keyboard out
  // of the way with a measured bottom inset (see android-keyboard-frame) because
  // the transparent Android modal window does not resize for the keyboard. The
  // lift is gated on keyboardAvoidingEnabled so the tall expanded sheet stays
  // anchored to the bottom (its header cannot be pushed off the top of screen).
  const keyboardAvoidingBehavior = Platform.OS === 'ios' ? 'padding' : undefined;
  const androidKeyboardLift = Platform.OS === 'android' && keyboardAvoidingEnabled && androidKeyboardInset > 0
    ? { paddingBottom: androidKeyboardInset }
    : null;

  // "Add to today's focus" is a task property, not a title-entry control, so it lives
  // with the Contexts/Area/Project chips (here) instead of next to the mic. The mic
  // stays beside the title because it is an input method. On = filled gold star +
  // selected chip, matching how focused tasks render in the list.
  const renderFocusChip = (chipStyle: StyleProp<ViewStyle>) => (
    <TouchableOpacity
      onPress={onToggleFocusNewTask}
      accessibilityRole="button"
      accessibilityLabel={focusLabel}
      accessibilityState={{ selected: focusNewTask }}
      style={[
        chipStyle,
        {
          backgroundColor: focusNewTask ? `${FOCUS_STAR_COLOR}22` : tc.filterBg,
          borderColor: focusNewTask ? FOCUS_STAR_COLOR : tc.border,
        },
      ]}
      activeOpacity={0.85}
    >
      <FocusStarIcon
        focused={focusNewTask}
        inactiveColor={tc.secondaryText}
        size={16}
      />
      <CompactText
        style={[styles.optionText, { color: focusNewTask ? FOCUS_STAR_COLOR : tc.text }]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {focusChipLabel}
      </CompactText>
    </TouchableOpacity>
  );

  return (
    <Modal
      visible={visible}
      transparent
      // Transparent Android modal animations can blend stale frames on some tablet GPUs.
      animationType={Platform.OS === 'android' ? 'none' : 'slide'}
      hardwareAccelerated={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
      statusBarTranslucent={Platform.OS === 'android'}
      accessibilityViewIsModal
      onRequestClose={saving ? () => undefined : (handleRequestClose ?? handleClose)}
    >
      <View style={styles.modalRoot} accessibilityViewIsModal>
        <Pressable
          style={styles.backdrop}
          onPress={saving ? undefined : handleClose}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          accessibilityState={{ busy: saving, disabled: saving }}
          accessibilityElementsHidden={contentAccessibilityHidden}
          importantForAccessibility={contentAccessibilityHidden ? 'no-hide-descendants' : 'auto'}
        />
        <KeyboardAvoidingView
          behavior={keyboardAvoidingBehavior}
          keyboardVerticalOffset={0}
          style={[styles.keyboardAvoiding, androidKeyboardLift]}
          accessibilityElementsHidden={contentAccessibilityHidden}
          importantForAccessibility={contentAccessibilityHidden ? 'no-hide-descendants' : 'auto'}
        >
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: tc.cardBg,
                paddingBottom: optionsExpanded ? Math.max(20, insetsBottom + 12) : Math.max(12, insetsBottom + 6),
                maxHeight: sheetMaxHeight,
              },
            ]}
          >
            <View style={styles.headerRow}>
              <CompactText
                style={[styles.title, { color: tc.text }]}
                numberOfLines={2}
              >
                {t('nav.addTask')}
              </CompactText>
              <TouchableOpacity
                onPress={handleClose}
                disabled={saving}
                accessibilityLabel={t('common.close')}
                accessibilityState={{ busy: saving, disabled: saving }}
              >
                <X size={18} color={tc.secondaryText} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputRow}>
              <CompactTextInput
                ref={inputRef}
                style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                placeholder={t('quickAdd.inputLabel')}
                placeholderTextColor={tc.secondaryText}
                value={value}
                onChangeText={onValueChange}
                editable={!saving}
                accessibilityState={{ busy: saving, disabled: saving }}
                accessibilityLabel={t('quickAdd.inputLabel')}
                accessibilityHint={t('quickAdd.inputHint')}
                onSubmitEditing={() => {
                  if (saving) return;
                  if (!addAnother) {
                    inputRef.current?.blur();
                  }
                  handleSave();
                }}
                returnKeyType="done"
                multiline
                // Return still submits (and keeps focus in add-another mode)
                // instead of inserting a newline; pasted multi-line text keeps
                // its newlines so handleSave's bulk-create path engages.
                submitBehavior={addAnother ? 'submit' : 'blurAndSubmit'}
                textAlignVertical="center"
              />
              <TouchableOpacity
                onPress={onToggleRecording}
                accessibilityRole="button"
                accessibilityLabel={recording ? t('quickAdd.audioStop') : t('quickAdd.audioRecord')}
                style={[
                  styles.recordButton,
                  {
                    backgroundColor: recordingReady ? tc.danger : tc.filterBg,
                    borderColor: tc.border,
                    opacity: recordingBusy ? 0.6 : 1,
                  },
                ]}
                disabled={recordingBusy}
              >
                {recordingReady ? (
                  <Square size={16} color={tc.onTint} />
                ) : (
                  <Mic size={16} color={tc.text} />
                )}
              </TouchableOpacity>
            </View>

            {preview ? <View style={styles.previewRow}>{preview}</View> : null}

            {recordingReady && (
              <View style={styles.recordingRow}>
                <View style={[styles.recordingDot, { backgroundColor: tc.danger }]} />
                <CompactText
                  style={[styles.recordingText, { color: tc.danger }]}
                  numberOfLines={1}
                >
                  {t('quickAdd.audioRecording')}
                </CompactText>
              </View>
            )}

            <View style={styles.optionsHeaderRow}>
              {!optionsExpanded && projectSelected ? (
                <TouchableOpacity
                  style={[styles.collapsedProjectChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                  onPress={onOpenProjectPicker}
                  onLongPress={onResetProject}
                  accessibilityRole="button"
                  accessibilityLabel={`${defaultProjectLabel}: ${projectLabel}`}
                >
                  <Folder size={16} color={tc.text} />
                  <CompactText
                    style={[styles.collapsedProjectText, { color: tc.text }]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {projectLabel}
                  </CompactText>
                </TouchableOpacity>
              ) : null}
              {!optionsExpanded && !projectSelected ? (
                <TouchableOpacity
                  style={[styles.collapsedContextChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                  onPress={onOpenContextPicker}
                  onLongPress={onResetContexts}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('taskEdit.contextsLabel')}: ${contextLabel}`}
                >
                  <AtSign size={16} color={tc.text} />
                  <CompactText
                    style={[styles.collapsedContextText, { color: tc.text }]}
                    numberOfLines={2}
                    ellipsizeMode="tail"
                  >
                    {contextLabel}
                  </CompactText>
                </TouchableOpacity>
              ) : null}
              {!optionsExpanded ? renderFocusChip(styles.focusChip) : null}
              <TouchableOpacity
                style={[styles.optionsToggle, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                onPress={onToggleOptions}
                accessibilityRole="button"
                accessibilityLabel={optionsToggleLabel}
                accessibilityState={{ expanded: optionsExpanded }}
              >
                <SlidersHorizontal size={16} color={tc.text} />
                <CompactText
                  style={[styles.optionsToggleText, { color: tc.text }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                >
                  {optionsToggleLabel}
                </CompactText>
                {optionsExpanded ? (
                  <ChevronUp size={16} color={tc.secondaryText} />
                ) : (
                  <ChevronDown size={16} color={tc.secondaryText} />
                )}
              </TouchableOpacity>
            </View>

            <SheetScrollArea>
            {optionsExpanded && (
              <>
                {/* Longer notes without typing /note: (#1118). First in the panel
                    because it is the most-reached expanded field; the same
                    description the task editor and the full capture screen edit. */}
                <CompactText
                  style={[styles.noteLabel, { color: tc.secondaryText }]}
                  numberOfLines={1}
                >
                  {t('taskEdit.descriptionLabel')}
                </CompactText>
                <CompactTextInput
                  style={[styles.noteInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                  placeholder={t('taskEdit.descriptionPlaceholder')}
                  placeholderTextColor={tc.secondaryText}
                  value={noteValue}
                  onChangeText={onNoteChange}
                  accessibilityLabel={t('taskEdit.descriptionLabel')}
                  multiline
                  textAlignVertical="top"
                />
                <View style={styles.optionsRow}>
                  {renderFocusChip(styles.optionChip)}
                  {showDueTime && (
                    <TouchableOpacity
                      style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                      onPress={onOpenDueTimePicker}
                      onLongPress={onResetDueTime}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('task.aria.dueTime')}: ${dueTimeLabel}`}
                    >
                      <Clock size={16} color={tc.text} />
                      <CompactText
                        style={[styles.optionText, { color: tc.text }]}
                        numberOfLines={2}
                        ellipsizeMode="tail"
                      >
                        {dueTimeLabel}
                      </CompactText>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                    onPress={onOpenContextPicker}
                    onLongPress={onResetContexts}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('taskEdit.contextsLabel')}: ${contextLabel}`}
                  >
                    <AtSign size={16} color={tc.text} />
                    <CompactText
                      style={[styles.optionText, { color: tc.text }]}
                      numberOfLines={2}
                      ellipsizeMode="tail"
                    >
                      {contextLabel}
                    </CompactText>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                    onPress={onOpenAreaPicker}
                    onLongPress={onResetArea}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('taskEdit.areaLabel')}: ${areaLabel}`}
                  >
                    <Layers size={16} color={tc.text} />
                    <CompactText
                      style={[styles.optionText, { color: tc.text }]}
                      numberOfLines={2}
                      ellipsizeMode="tail"
                    >
                      {areaLabel}
                    </CompactText>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                    onPress={onOpenProjectPicker}
                    onLongPress={onResetProject}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('taskEdit.projectLabel')}: ${projectLabel}`}
                  >
                    <Folder size={16} color={tc.text} />
                    <CompactText
                      style={[styles.optionText, { color: tc.text }]}
                      numberOfLines={2}
                      ellipsizeMode="tail"
                    >
                      {projectLabel}
                    </CompactText>
                  </TouchableOpacity>

                  {prioritiesEnabled && (
                    <TouchableOpacity
                      style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                      onPress={onOpenPriorityPicker}
                      onLongPress={onResetPriority}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('taskEdit.priorityLabel')}: ${priorityLabel}`}
                    >
                      <Flag size={16} color={tc.text} />
                      <CompactText
                        style={[styles.optionText, { color: tc.text }]}
                        numberOfLines={2}
                        ellipsizeMode="tail"
                      >
                        {priorityLabel}
                      </CompactText>
                    </TouchableOpacity>
                  )}
                </View>

                <CompactText
                  style={[styles.syntaxHint, { color: tc.secondaryText }]}
                  numberOfLines={4}
                  ellipsizeMode="tail"
                >
                  {formatQuickAddHelp(t('quickAdd.help'), { priorities: prioritiesEnabled })}
                </CompactText>

                {handleImportTextFile ? (
                  <TouchableOpacity
                    style={[styles.importTextButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                    onPress={handleImportTextFile}
                    accessibilityRole="button"
                    accessibilityLabel={tFallback(t, 'quickAdd.bulkImportTextFileLabel', 'Import text file')}
                  >
                    <FileText size={16} color={tc.text} />
                    <CompactText
                      style={[styles.importTextButtonText, { color: tc.text }]}
                      numberOfLines={2}
                    >
                      {tFallback(t, 'quickAdd.bulkImportTextFile', 'Import .txt')}
                    </CompactText>
                  </TouchableOpacity>
                ) : null}

                <QuickDateChips
                  t={t}
                  tc={tc}
                  selectedDate={dueDate}
                  presets={QUICK_CAPTURE_DATE_PRESETS}
                  onSelect={(date) => onQuickDueDateSelect(date)}
                  trailing={
                    <TouchableOpacity
                      style={[styles.customDateButton, { borderColor: tc.border }]}
                      onPress={onOpenDueDatePicker}
                      onLongPress={onResetDueDate}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('taskEdit.dueDateLabel')}: ${dueLabel}`}
                    >
                      <CalendarDays size={14} color={tc.secondaryText} />
                      <CompactText
                        style={[styles.customDateButtonText, { color: tc.secondaryText }]}
                        numberOfLines={2}
                        ellipsizeMode="tail"
                      >
                        {customDateLabel}
                      </CompactText>
                    </TouchableOpacity>
                  }
                />
              </>
            )}
            </SheetScrollArea>

            <View style={[styles.footerRow, !optionsExpanded && styles.footerRowCompact]}>
              <View style={styles.toggleRow}>
                <Switch
                  value={addAnother}
                  onValueChange={onToggleAddAnother}
                  disabled={saving}
                  thumbColor={addAnother ? tc.tint : tc.border}
                  trackColor={{ false: tc.border, true: `${tc.tint}55` }}
                  accessibilityLabel={t('quickAdd.addAnother')}
                />
                <CompactText
                  style={[styles.toggleText, { color: tc.text }]}
                  numberOfLines={2}
                >
                  {t('quickAdd.addAnother')}
                </CompactText>
              </View>
              <View style={styles.saveActions}>
                {handleSaveAndEdit ? (
                  <TouchableOpacity
                    onPress={handleSaveAndEdit}
                    style={[
                      styles.saveButton,
                      styles.saveAndEditButton,
                      { borderColor: tc.border, opacity: value.trim() && !saving ? 1 : 0.5 },
                    ]}
                    disabled={saving || !value.trim()}
                    accessibilityRole="button"
                    accessibilityLabel={t('quickAdd.saveAndEdit')}
                    accessibilityState={{ busy: saving, disabled: saving || !value.trim() }}
                  >
                    <CompactText
                      style={[styles.saveAndEditText, { color: tc.text }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.75}
                    >
                      {t('quickAdd.saveAndEdit')}
                    </CompactText>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  onPress={handleSave}
                  style={[styles.saveButton, { backgroundColor: saveButtonBackgroundColor ?? tc.tint, opacity: value.trim() && !saving ? 1 : 0.5 }]}
                  disabled={saving || !value.trim()}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.save')}
                  accessibilityState={{ busy: saving, disabled: saving || !value.trim() }}
                >
                  <CompactText
                    style={[styles.saveText, saveButtonTextColor ? { color: saveButtonTextColor } : null]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                  >
                    {t('common.save')}
                  </CompactText>
                </TouchableOpacity>
              </View>
            </View>
          </View>
          {/* Toasts fired from inside the sheet (e.g. the speech-not-configured notice)
              render behind the native modal window without a viewport here, so the user
              only saw them after closing the sheet (#886, #834). It sits inside the
              keyboard-avoiding view on purpose: that container's bottom padding is the
              keyboard, so the toast lands above it instead of behind it. */}
          <ToastViewport />
        </KeyboardAvoidingView>
        {children}
        {/* Audio/permission alerts fire while the sheet is up (#940); last child
            so the overlay covers the sheet and its own pickers. */}
        <ThemedAlertHost />
      </View>
    </Modal>
  );
}
