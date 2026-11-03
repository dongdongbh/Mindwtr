import React from 'react';
import type { RefObject } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, TextInput, TouchableOpacity, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { AtSign, CalendarDays, ChevronDown, ChevronUp, Clock, FileText, Flag, Folder, Layers, Mic, SlidersHorizontal, Square, X } from 'lucide-react-native';
import { getQuickCaptureFocusLabel, getQuickCaptureText, tFallback, TASK_PRIORITY_COLORS, type TaskPriority } from '@mindwtr/core';
import { ToastViewport } from '@/contexts/toast-context';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText, CompactTextInput } from '@/components/compact-text';
import { ThemedAlertHost } from '@/components/themed-alert';
import { SandboxWorkspaceCue } from '@/components/sandbox-workspace-cue';
import { AdaptiveModalSurface } from '@/components/adaptive-modal-surface';
import { QuickDateChips } from '../QuickDateChips';
import { FocusStarIcon, FOCUS_STAR_COLOR } from '../FocusStarIcon';
import { styles } from './quick-capture-sheet.styles';


const QUICK_CAPTURE_DATE_PRESETS = ['today', 'tomorrow', 'next_week'] as const;


function QuickCaptureMetadataScrollArea({ children }: { children: React.ReactNode }) {
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
  onModalShow?: () => void;
  onInputFocus?: () => void;
  onInputBlur?: () => void;
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

  preview?: React.ReactNode;
  prioritiesEnabled: boolean;
  timeEstimatesEnabled: boolean;
  priorityLabel: string;
  selectedPriority: TaskPriority | null;
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
  onModalShow,
  onInputFocus,
  onInputBlur,
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
  timeEstimatesEnabled,
  priorityLabel,
  selectedPriority,
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


  const [syntaxHelpVisible, setSyntaxHelpVisible] = React.useState(false);

  const text = getQuickCaptureText(t, { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled });
  const optionsToggleLabel = optionsExpanded ? text.hideOptions : text.more;
  const defaultProjectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');
  const focusLabel = getQuickCaptureFocusLabel(t, {
    on: focusNewTask,
    canFocus: canFocusNewTask,
    disabledReason: focusNewTaskDisabledReason,
  });


  const focusChipLabel = text.focusChip;

  const customDateLabel = text.customDate;


  const keyboardAvoidingBehavior = Platform.OS === 'ios' ? 'padding' : undefined;
  const androidKeyboardLift = Platform.OS === 'android' && keyboardAvoidingEnabled && androidKeyboardInset > 0
    ? { paddingBottom: androidKeyboardInset }
    : null;


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
      onShow={onModalShow}
      transparent

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
          <AdaptiveModalSurface
            variant="sheet"
            testID="quick-capture-adaptive-surface"
            style={[
              styles.sheet,
              {
                backgroundColor: tc.cardBg,
                paddingBottom: optionsExpanded ? Math.max(20, insetsBottom + 12) : Math.max(12, insetsBottom + 6),
                maxHeight: sheetMaxHeight,
              },
            ]}
          >
            <SandboxWorkspaceCue />
            <View style={styles.headerRow}>
              <CompactText
                style={[styles.title, { color: tc.text }]}
                numberOfLines={2}
              >
                {t('nav.addTask')}
              </CompactText>
              <TouchableOpacity
                testID="quick-capture-close"
                onPress={handleClose}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
                accessibilityState={{ busy: saving, disabled: saving }}
                hitSlop={{ top: 4, right: 4, bottom: 4, left: 4 }}
                style={styles.closeButton}
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
                onFocus={onInputFocus}
                onBlur={onInputBlur}
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

            <QuickCaptureMetadataScrollArea>
            <CompactTextInput
              style={[styles.noteInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              placeholder={t('taskEdit.descriptionPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              value={noteValue}
              onChangeText={onNoteChange}
              editable={!saving}
              accessibilityState={{ busy: saving, disabled: saving }}
              accessibilityLabel={t('taskEdit.descriptionLabel')}
              multiline
              submitBehavior="newline"
              textAlignVertical="top"
            />

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
            {recordingBusy ? (
              <View style={styles.recordingRow}>
                <CompactText
                  style={[styles.recordingText, { color: tc.secondaryText }]}
                  numberOfLines={2}
                  accessibilityLiveRegion="polite"
                >
                  {tFallback(t, 'quickAdd.audioProcessing', 'Processing audio capture...')}
                </CompactText>
              </View>
            ) : null}

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

            {optionsExpanded && (
              <>
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
                      <Clock size={16} color={tc.text} aria-hidden accessible={false} pointerEvents="none" />
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
                      <Flag size={16} color={selectedPriority ? TASK_PRIORITY_COLORS[selectedPriority] : tc.text} />
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

                <TouchableOpacity
                  style={styles.syntaxHelpToggle}
                  onPress={() => setSyntaxHelpVisible((visible) => !visible)}
                  accessibilityRole="button"
                  accessibilityLabel={t('quickAdd.syntaxHelp')}
                  accessibilityState={{ expanded: syntaxHelpVisible }}
                  testID="quick-capture-syntax-help-toggle"
                >
                  {syntaxHelpVisible
                    ? <ChevronUp size={14} color={tc.secondaryText} />
                    : <ChevronDown size={14} color={tc.secondaryText} />}
                  <CompactText style={[styles.syntaxHelpToggleText, { color: tc.secondaryText }]}>
                    {t('quickAdd.syntaxHelp')}
                  </CompactText>
                </TouchableOpacity>
                {syntaxHelpVisible && (
                  <CompactText style={[styles.syntaxHint, { color: tc.secondaryText }]}>
                    {text.syntaxHelpText}
                  </CompactText>
                )}

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
            </QuickCaptureMetadataScrollArea>

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
          </AdaptiveModalSurface>
          {


                                                                            }
          <ToastViewport />
        </KeyboardAvoidingView>
        {children}
        {
                                                                   }
        <ThemedAlertHost />
      </View>
    </Modal>
  );
}
