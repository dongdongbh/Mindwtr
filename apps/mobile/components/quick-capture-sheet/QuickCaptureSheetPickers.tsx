import React from 'react';
import { FlatList, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { Area, Project, TaskPriority } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { styles } from './quick-capture-sheet.styles';

interface QuickCaptureSheetPickersProps {
  areas: Area[];
  contextInputRef: React.RefObject<TextInput | null>;
  contextQuery: string;
  contextTags: string[];
  filteredContexts: string[];
  filteredProjects: Project[];
  hasAddableContextTokens: boolean;
  hasExactProjectMatch: boolean;
  onAddContextFromQuery: () => void;
  onCloseAreaPicker: () => void;
  onCloseContextPicker: () => void;
  onClosePriorityPicker: () => void;
  onCloseProjectPicker: () => void;
  onClearContexts: () => void;
  onContextQueryChange: (value: string) => void;
  onProjectQueryChange: (value: string) => void;
  onRemoveContext: (token: string) => void;
  onSelectArea: (areaId: string | null) => void;
  onSelectContext: (token: string) => void;
  onSelectPriority: (priority: TaskPriority | null) => void;
  onSelectProject: (projectId: string | null) => void;
  onSubmitContextQuery: () => void;
  onSubmitProjectQuery: () => void;
  pendingStartDate: Date | null;
  prioritiesEnabled: boolean;
  priorityOptions: TaskPriority[];
  projectQuery: string;
  selectedAreaId: string | null;
  selectedPriority: TaskPriority | null;
  showAreaPicker: boolean;
  showContextPicker: boolean;
  showDatePicker: boolean;
  showPriorityPicker: boolean;
  showProjectPicker: boolean;
  startPickerMode: 'date' | 'time' | null;
  startTime: Date | null;
  dueDate: Date | null;
  onDueDateChange: (event: { type: string }, selectedDate?: Date) => void;
  onStartTimeChange: (event: { type: string }, selectedDate?: Date) => void;
  t: (key: string) => string;
  tc: ThemeColors;
}

export function QuickCaptureSheetPickers({
  areas,
  contextInputRef,
  contextQuery,
  contextTags,
  dueDate,
  filteredContexts,
  filteredProjects,
  hasAddableContextTokens,
  hasExactProjectMatch,
  onAddContextFromQuery,
  onCloseAreaPicker,
  onCloseContextPicker,
  onClosePriorityPicker,
  onCloseProjectPicker,
  onClearContexts,
  onContextQueryChange,
  onDueDateChange,
  onProjectQueryChange,
  onRemoveContext,
  onSelectArea,
  onSelectContext,
  onSelectPriority,
  onSelectProject,
  onStartTimeChange,
  onSubmitContextQuery,
  onSubmitProjectQuery,
  pendingStartDate,
  prioritiesEnabled,
  priorityOptions,
  projectQuery,
  selectedAreaId,
  selectedPriority,
  showAreaPicker,
  showContextPicker,
  showDatePicker,
  showPriorityPicker,
  showProjectPicker,
  startPickerMode,
  startTime,
  t,
  tc,
}: QuickCaptureSheetPickersProps) {
  return (
    <>
      {showDatePicker && (
        <DateTimePicker
          value={dueDate ?? new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={onDueDateChange}
        />
      )}

      {startPickerMode && (
        <DateTimePicker
          value={(() => {
            if (Platform.OS === 'ios') return startTime ?? new Date();
            if (startPickerMode === 'time') return pendingStartDate ?? startTime ?? new Date();
            return startTime ?? new Date();
          })()}
          mode={Platform.OS === 'ios' ? 'datetime' : startPickerMode}
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={onStartTimeChange}
        />
      )}

      <Modal
        visible={showContextPicker}
        transparent
        animationType="fade"
        onRequestClose={onCloseContextPicker}
      >
        <View style={styles.overlay}>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onCloseContextPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.contextsLabel')}</Text>
            <TextInput
              ref={contextInputRef}
              value={contextQuery}
              onChangeText={onContextQueryChange}
              placeholder={t('taskEdit.contextsPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.pickerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={onSubmitContextQuery}
              returnKeyType="done"
              blurOnSubmit={false}
              submitBehavior="submit"
            />
            {hasAddableContextTokens && contextQuery.trim() && (
              <Pressable
                onPress={onAddContextFromQuery}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={`${t('common.add')}: ${contextQuery.trim()}`}
              >
                <Text style={[styles.pickerRowText, { color: tc.tint }]}>
                  + {contextQuery.trim()}
                </Text>
              </Pressable>
            )}
            {contextTags.length > 0 && (
              <View style={styles.selectedContextWrap}>
                {contextTags.map((token) => (
                  <Pressable
                    key={token}
                    onPress={() => onRemoveContext(token)}
                    style={[styles.selectedContextChip, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('common.delete')}: ${token}`}
                  >
                    <Text style={[styles.selectedContextChipText, { color: tc.text }]}>{token}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              contentContainerStyle={styles.pickerListContent}
              data={filteredContexts}
              keyExtractor={(token) => token}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={(
                <Pressable
                  onPress={() => {
                    onClearContexts();
                    onCloseContextPicker();
                  }}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.clear')}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('common.clear')}</Text>
                </Pressable>
              )}
              renderItem={({ item: token }) => (
                <Pressable
                  onPress={() => onSelectContext(token)}
                  style={[
                    styles.pickerRow,
                    contextTags.some((item) => item.toLowerCase() === token.toLowerCase())
                      ? { backgroundColor: tc.filterBg, borderRadius: 8 }
                      : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    contextTags.some((item) => item.toLowerCase() === token.toLowerCase())
                      ? `${t('common.delete')}: ${token}`
                      : `${t('common.add')}: ${token}`
                  }
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>
                    {contextTags.some((item) => item.toLowerCase() === token.toLowerCase()) ? `✓ ${token}` : token}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={showAreaPicker}
        transparent
        animationType="fade"
        onRequestClose={onCloseAreaPicker}
      >
        <View style={styles.overlay}>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onCloseAreaPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.areaLabel')}</Text>
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              contentContainerStyle={styles.pickerListContent}
              data={areas.filter((area) => !area.deletedAt)}
              keyExtractor={(area) => area.id}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={(
                <Pressable
                  onPress={() => onSelectArea(null)}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t('taskEdit.noAreaOption')}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('taskEdit.noAreaOption')}</Text>
                </Pressable>
              )}
              renderItem={({ item: area }) => (
                <Pressable
                  onPress={() => onSelectArea(area.id)}
                  style={[
                    styles.pickerRow,
                    selectedAreaId === area.id ? { backgroundColor: tc.filterBg, borderRadius: 8 } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={area.name}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>
                    {selectedAreaId === area.id ? `✓ ${area.name}` : area.name}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={showProjectPicker}
        transparent
        animationType="fade"
        onRequestClose={onCloseProjectPicker}
      >
        <View style={styles.overlay}>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onCloseProjectPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.projectLabel')}</Text>
            <TextInput
              value={projectQuery}
              onChangeText={onProjectQueryChange}
              placeholder={t('projects.addPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.pickerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={onSubmitProjectQuery}
              returnKeyType="done"
              blurOnSubmit
            />
            {!hasExactProjectMatch && projectQuery.trim() && (
              <Pressable
                onPress={onSubmitProjectQuery}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={`${t('projects.create')}: ${projectQuery.trim()}`}
              >
                <Text style={[styles.pickerRowText, { color: tc.tint }]}>+ {t('projects.create')} &quot;{projectQuery.trim()}&quot;</Text>
              </Pressable>
            )}
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              contentContainerStyle={styles.pickerListContent}
              data={filteredProjects}
              keyExtractor={(project) => project.id}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={(
                <Pressable
                  onPress={() => onSelectProject(null)}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={t('taskEdit.noProjectOption')}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('taskEdit.noProjectOption')}</Text>
                </Pressable>
              )}
              renderItem={({ item: project }) => (
                <Pressable
                  onPress={() => onSelectProject(project.id)}
                  style={styles.pickerRow}
                  accessibilityRole="button"
                  accessibilityLabel={project.title}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>{project.title}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      {prioritiesEnabled && (
        <Modal
          visible={showPriorityPicker}
          transparent
          animationType="fade"
          onRequestClose={onClosePriorityPicker}
        >
          <View style={styles.overlay}>
            <Pressable
              style={styles.overlayBackdrop}
              onPress={onClosePriorityPicker}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
            />
            <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('taskEdit.priorityLabel')}</Text>
              <Pressable
                onPress={() => onSelectPriority(null)}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={t('common.clear')}
              >
                <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('common.clear')}</Text>
              </Pressable>
              {priorityOptions.map((option) => (
                <Pressable
                  key={option}
                  onPress={() => onSelectPriority(option)}
                  style={[
                    styles.pickerRow,
                    selectedPriority === option ? { backgroundColor: tc.filterBg, borderRadius: 8 } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t(`priority.${option}`)}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>
                    {selectedPriority === option ? `✓ ${t(`priority.${option}`)}` : t(`priority.${option}`)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}
