import React from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { Area, Project, TaskPriority } from '@mindwtr/core';
import { PriorityFlag } from '@/components/priority-flag';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { styles } from './quick-capture-sheet.styles';

interface QuickCaptureSheetPickersProps {
  filteredAreas: Area[];
  areaQuery?: string;
  contextInputRef: React.RefObject<TextInput | null>;
  contextOptionsLoading: boolean;
  contextQuery: string;
  contextTags: string[];
  filteredContexts: string[];
  filteredProjects: Project[];
  hasAddableContextTokens: boolean;
  hasExactAreaMatch?: boolean;
  hasExactProjectMatch: boolean;
  onAddContextFromQuery: () => void;
  onCloseAreaPicker: () => void;
  onCloseContextPicker: () => void;
  onClosePriorityPicker: () => void;
  onCloseProjectPicker: () => void;
  onClearContexts: () => void;
  onAreaQueryChange?: (value: string) => void;
  onContextQueryChange: (value: string) => void;
  onProjectQueryChange: (value: string) => void;
  onRemoveContext: (token: string) => void;
  onSelectArea: (areaId: string | null) => void;
  onSelectContext: (token: string) => void;
  onSelectPriority: (priority: TaskPriority | null) => void;
  onSelectProject: (projectId: string | null) => void;
  onSubmitAreaQuery?: () => void;
  onSubmitContextQuery: () => void;
  onSubmitProjectQuery: () => void;
  pendingStartDate: Date | null;
  pickerLayer?: 'all' | 'date' | 'overlay';
  overlayKeyboardInset?: number;
  prioritiesEnabled: boolean;
  priorityOptions: TaskPriority[];
  projectQuery: string;
  selectedAreaId: string | null;
  selectedPriority: TaskPriority | null;
  showAreaPicker: boolean;
  showContextPicker: boolean;
  showDatePicker: boolean;
  showDueTimePicker: boolean;
  showPriorityPicker: boolean;
  showProjectPicker: boolean;
  startPickerMode: 'date' | 'time' | null;
  startTime: Date | null;
  dueDate: Date | null;
  onDueDateChange: (event: { type: string }, selectedDate?: Date) => void;
  onDueTimeChange: (event: { type: string }, selectedDate?: Date) => void;
  onStartTimeChange: (event: { type: string }, selectedDate?: Date) => void;
  t: (key: string) => string;
  tc: ThemeColors;
}

export function QuickCaptureSheetPickers({
  areaQuery = '',
  filteredAreas,
  contextInputRef,
  contextOptionsLoading,
  contextQuery,
  contextTags,
  dueDate,
  filteredContexts,
  filteredProjects,
  hasAddableContextTokens,
  hasExactAreaMatch = false,
  hasExactProjectMatch,
  onAddContextFromQuery,
  onCloseAreaPicker,
  onCloseContextPicker,
  onClosePriorityPicker,
  onCloseProjectPicker,
  onClearContexts,
  onAreaQueryChange = () => {},
  onContextQueryChange,
  onDueDateChange,
  onDueTimeChange,
  onProjectQueryChange,
  onRemoveContext,
  onSelectArea,
  onSelectContext,
  onSelectPriority,
  onSelectProject,
  onStartTimeChange,
  onSubmitAreaQuery = () => {},
  onSubmitContextQuery,
  onSubmitProjectQuery,
  pendingStartDate,
  pickerLayer = 'all',
  overlayKeyboardInset = 0,
  prioritiesEnabled,
  priorityOptions,
  projectQuery,
  selectedAreaId,
  selectedPriority,
  showAreaPicker,
  showContextPicker,
  showDatePicker,
  showDueTimePicker,
  showPriorityPicker,
  showProjectPicker,
  startPickerMode,
  startTime,
  t,
  tc,
}: QuickCaptureSheetPickersProps) {
  const showDateLayer = pickerLayer !== 'overlay';
  const showOverlayLayer = pickerLayer !== 'date';
  // Center the picker card in the space above the keyboard so its input/list are
  // not hidden behind the keyboard inside the non-resizing Android modal.
  const overlayStyle = overlayKeyboardInset > 0
    ? [styles.overlay, { paddingBottom: overlayKeyboardInset }]
    : styles.overlay;
  const trimmedAreaQuery = areaQuery.trim();

  return (
    <>
      {showDateLayer && showDatePicker && (
        <DateTimePicker
          value={dueDate ?? new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={onDueDateChange}
        />
      )}

      {showDateLayer && showDueTimePicker && (
        <DateTimePicker
          value={dueDate ?? new Date()}
          mode="time"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={onDueTimeChange}
        />
      )}

      {showDateLayer && startPickerMode && (
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

      {showOverlayLayer && showContextPicker && (
        <View style={overlayStyle} accessibilityViewIsModal>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onCloseContextPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]} accessibilityRole="header">{t('taskEdit.contextsLabel')}</Text>
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
              accessibilityRole="list"
              accessibilityLabel={t('taskEdit.contextsLabel')}
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
              ListEmptyComponent={contextOptionsLoading ? (
                <View style={styles.pickerRow}>
                  <ActivityIndicator color={tc.tint} />
                </View>
              ) : null}
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
                  accessibilityState={{ selected: contextTags.some((item) => item.toLowerCase() === token.toLowerCase()) }}
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
              removeClippedSubviews={false}
            />
          </View>
        </View>
      )}

      {showOverlayLayer && showAreaPicker && (
        <View style={overlayStyle} accessibilityViewIsModal>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onCloseAreaPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]} accessibilityRole="header">{t('taskEdit.areaLabel')}</Text>
            <TextInput
              value={areaQuery}
              onChangeText={onAreaQueryChange}
              placeholder={t('common.search')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.pickerInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={onSubmitAreaQuery}
              returnKeyType="done"
              blurOnSubmit
              accessibilityLabel={t('taskEdit.areaLabel')}
            />
            {!hasExactAreaMatch && trimmedAreaQuery && (
              <Pressable
                onPress={onSubmitAreaQuery}
                style={styles.pickerRow}
                accessibilityRole="button"
                accessibilityLabel={`${t('areas.create')}: ${trimmedAreaQuery}`}
              >
                <Text style={[styles.pickerRowText, { color: tc.tint }]}>+ {t('areas.create')} &quot;{trimmedAreaQuery}&quot;</Text>
              </Pressable>
            )}
            <FlatList
              style={[styles.pickerList, { borderColor: tc.border }]}
              accessibilityRole="list"
              accessibilityLabel={t('taskEdit.areaLabel')}
              contentContainerStyle={styles.pickerListContent}
              data={filteredAreas}
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
                  accessibilityState={{ selected: selectedAreaId === area.id }}
                  accessibilityLabel={area.name}
                >
                  <Text style={[styles.pickerRowText, { color: tc.text }]}>
                    {selectedAreaId === area.id ? `✓ ${area.name}` : area.name}
                  </Text>
                </Pressable>
              )}
              removeClippedSubviews={false}
            />
          </View>
        </View>
      )}

      {showOverlayLayer && showProjectPicker && (
        <View style={overlayStyle} accessibilityViewIsModal>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onCloseProjectPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]} accessibilityRole="header">{t('taskEdit.projectLabel')}</Text>
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
              accessibilityRole="list"
              accessibilityLabel={t('taskEdit.projectLabel')}
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
              removeClippedSubviews={false}
            />
          </View>
        </View>
      )}

      {showOverlayLayer && prioritiesEnabled && showPriorityPicker && (
        <View style={overlayStyle} accessibilityViewIsModal>
          <Pressable
            style={styles.overlayBackdrop}
            onPress={onClosePriorityPicker}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]} accessibilityRole="header">{t('taskEdit.priorityLabel')}</Text>
            <Pressable
              onPress={() => onSelectPriority(null)}
              style={[styles.pickerRow, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}
              accessibilityRole="button"
              accessibilityLabel={t('common.none')}
            >
              <PriorityFlag priority={null} color={tc.text} />
              <Text style={[styles.pickerRowText, { color: tc.text }]}>{t('common.none')}</Text>
            </Pressable>
            {priorityOptions.map((option) => (
              <Pressable
                key={option}
                onPress={() => onSelectPriority(option)}
                style={[
                  styles.pickerRow,
                  { flexDirection: 'row', alignItems: 'center', gap: 8 },
                  selectedPriority === option ? { backgroundColor: tc.filterBg, borderRadius: 8 } : null,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: selectedPriority === option }}
                accessibilityLabel={t(`priority.${option}`)}
              >
                <PriorityFlag priority={option} />
                <Text style={[styles.pickerRowText, { color: tc.text }]}>
                  {selectedPriority === option ? `✓ ${t(`priority.${option}`)}` : t(`priority.${option}`)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </>
  );
}
