import React from 'react';
import type { RefObject } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { AtSign, CalendarDays, Flag, Folder, Mic, Square, X } from 'lucide-react-native';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { styles } from './quick-capture-sheet.styles';

interface QuickCaptureSheetBodyProps {
  addAnother: boolean;
  areaLabel: string;
  contextLabel: string;
  dueLabel: string;
  handleClose: () => void;
  handleSave: () => void;
  insetsBottom: number;
  inputRef: RefObject<TextInput | null>;
  onOpenAreaPicker: () => void;
  onOpenContextPicker: () => void;
  onOpenDueDatePicker: () => void;
  onOpenPriorityPicker: () => void;
  onOpenProjectPicker: () => void;
  onResetArea: () => void;
  onResetContexts: () => void;
  onResetDueDate: () => void;
  onResetPriority: () => void;
  onResetProject: () => void;
  onToggleAddAnother: (value: boolean) => void;
  onToggleRecording: () => void;
  onValueChange: (value: string) => void;
  prioritiesEnabled: boolean;
  priorityLabel: string;
  projectLabel: string;
  recording: boolean;
  recordingBusy: boolean;
  recordingReady: boolean;
  sheetMaxHeight: number;
  t: (key: string) => string;
  tc: ThemeColors;
  value: string;
  visible: boolean;
}

export function QuickCaptureSheetBody({
  addAnother,
  areaLabel,
  contextLabel,
  dueLabel,
  handleClose,
  handleSave,
  insetsBottom,
  inputRef,
  onOpenAreaPicker,
  onOpenContextPicker,
  onOpenDueDatePicker,
  onOpenPriorityPicker,
  onOpenProjectPicker,
  onResetArea,
  onResetContexts,
  onResetDueDate,
  onResetPriority,
  onResetProject,
  onToggleAddAnother,
  onToggleRecording,
  onValueChange,
  prioritiesEnabled,
  priorityLabel,
  projectLabel,
  recording,
  recordingBusy,
  recordingReady,
  sheetMaxHeight,
  t,
  tc,
  value,
  visible,
}: QuickCaptureSheetBodyProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable
        style={styles.backdrop}
        onPress={handleClose}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
        style={styles.keyboardAvoiding}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: tc.cardBg,
              paddingBottom: Math.max(20, insetsBottom + 12),
              maxHeight: sheetMaxHeight,
            },
          ]}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: tc.text }]}>{t('nav.addTask')}</Text>
            <TouchableOpacity onPress={handleClose} accessibilityLabel={t('common.close')}>
              <X size={18} color={tc.secondaryText} />
            </TouchableOpacity>
          </View>

          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              placeholder={t('quickAdd.placeholder')}
              placeholderTextColor={tc.secondaryText}
              value={value}
              onChangeText={onValueChange}
              onSubmitEditing={() => {
                if (Platform.OS === 'ios') {
                  inputRef.current?.blur();
                  return;
                }
                handleSave();
              }}
              returnKeyType="done"
              blurOnSubmit
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

          {recordingReady && (
            <View style={styles.recordingRow}>
              <View style={[styles.recordingDot, { backgroundColor: tc.danger }]} />
              <Text style={[styles.recordingText, { color: tc.danger }]}>{t('quickAdd.audioRecording')}</Text>
            </View>
          )}

          <View style={styles.optionsRow}>
            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={onOpenDueDatePicker}
              onLongPress={onResetDueDate}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.dueDate')}: ${dueLabel}`}
            >
              <CalendarDays size={16} color={tc.text} />
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{dueLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={onOpenContextPicker}
              onLongPress={onResetContexts}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.contextsLabel')}: ${contextLabel}`}
            >
              <AtSign size={16} color={tc.text} />
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{contextLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={onOpenAreaPicker}
              onLongPress={onResetArea}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.areaLabel')}: ${areaLabel}`}
            >
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{areaLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={onOpenProjectPicker}
              onLongPress={onResetProject}
              accessibilityRole="button"
              accessibilityLabel={`${t('taskEdit.project')}: ${projectLabel}`}
            >
              <Folder size={16} color={tc.text} />
              <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{projectLabel}</Text>
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
                <Text style={[styles.optionText, { color: tc.text }]} numberOfLines={1}>{priorityLabel}</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.footerRow}>
            <View style={styles.toggleRow}>
              <Switch
                value={addAnother}
                onValueChange={onToggleAddAnother}
                thumbColor={addAnother ? tc.tint : tc.border}
                trackColor={{ false: tc.border, true: `${tc.tint}55` }}
                accessibilityLabel={t('quickAdd.addAnother')}
              />
              <Text style={[styles.toggleText, { color: tc.text }]}>{t('quickAdd.addAnother')}</Text>
            </View>
            <TouchableOpacity
              onPress={handleSave}
              style={[styles.saveButton, { backgroundColor: tc.tint, opacity: value.trim() ? 1 : 0.5 }]}
              disabled={!value.trim()}
              accessibilityRole="button"
              accessibilityLabel={t('common.save')}
            >
              <Text style={styles.saveText}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
