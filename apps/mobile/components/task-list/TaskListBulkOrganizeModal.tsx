import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ChevronRight, ClipboardCheck, X } from 'lucide-react-native';
import {
  applyBulkOrganizeDraftEdit,
  BULK_ORGANIZE_KEEP,
  BULK_ORGANIZE_NONE,
  buildBulkOrganizeDialogModel,
  buildBulkOrganizeInput,
  createBulkOrganizeArea,
  createBulkOrganizeProject,
  EMPTY_BULK_ORGANIZE_DRAFT,
  ensureBulkOrganizeDestinationSaved,
  getBulkOrganizeAreaOptions,
  getBulkOrganizeProjectOptions,
  type Area,
  type BulkOrganizeDateField,
  type BulkOrganizeDraftEdit,
  type BulkOrganizeTaskUpdateInput,
  type Project,
} from '@mindwtr/core';

import { TaskEditAreaPicker } from '../task-edit/TaskEditAreaPicker';
import { TaskEditProjectPicker } from '../task-edit/TaskEditProjectPicker';
import { TaskListBulkDateField } from './TaskListBulkDateField';
import { useAndroidKeyboardInset } from '../../lib/use-android-keyboard-inset';
import { styles } from './task-list.styles';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

type ThemeColors = {
  border: string;
  cardBg: string;
  danger: string;
  filterBg: string;
  inputBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

type TaskListBulkOrganizeModalProps = {
  areas: Area[];
  isApplying: boolean;
  onApply: (input: BulkOrganizeTaskUpdateInput) => void | Promise<void>;
  onClose: () => void;
  projects: Project[];
  selectedCount: number;
  t: (key: string) => string;
  themeColors: ThemeColors;
  visible: boolean;
};

export function TaskListBulkOrganizeModal({
  areas,
  isApplying,
  onApply,
  onClose,
  projects,
  selectedCount,
  t,
  themeColors,
  visible,
}: TaskListBulkOrganizeModalProps) {
  const filledButton = useFilledButtonColors();
  const keyboardInset = useAndroidKeyboardInset(visible);

  const [draft, setDraft] = useState(EMPTY_BULK_ORGANIZE_DRAFT);
  const editDraft = useCallback((edit: BulkOrganizeDraftEdit) => {
    setDraft((current) => applyBulkOrganizeDraftEdit(current, edit));
  }, []);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [areaPickerVisible, setAreaPickerVisible] = useState(false);
  const [datePicker, setDatePicker] = useState<BulkOrganizeDateField | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [isCreatingDestination, setIsCreatingDestination] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const destinationCreateSessionRef = useRef(0);
  const destinationCreatePendingRef = useRef(false);

  useEffect(() => {
    destinationCreateSessionRef.current += 1;
    destinationCreatePendingRef.current = false;
    setIsCreatingDestination(false);
    setDestinationError(null);
    setDatePicker(null);
    if (!visible) {
      setProjectPickerVisible(false);
      setAreaPickerVisible(false);
      return;
    }
    setDraft(EMPTY_BULK_ORGANIZE_DRAFT);
    setProjectPickerVisible(false);
    setAreaPickerVisible(false);
    setShowValidation(false);
    return () => {
      destinationCreateSessionRef.current += 1;
      destinationCreatePendingRef.current = false;
    };
  }, [visible]);

  const runDestinationCreate = useCallback(async <T,>(operation: () => Promise<T | null>): Promise<T | null> => {
    if (isApplying || destinationCreatePendingRef.current) return null;
    const session = ++destinationCreateSessionRef.current;
    destinationCreatePendingRef.current = true;
    setIsCreatingDestination(true);
    setDestinationError(null);
    try {
      const created = await operation();
      return session === destinationCreateSessionRef.current && visible ? created : null;
    } catch (error) {
      if (session === destinationCreateSessionRef.current && visible) throw error;
      return null;
    } finally {
      if (session === destinationCreateSessionRef.current) {
        destinationCreatePendingRef.current = false;
        setIsCreatingDestination(false);
      }
    }
  }, [isApplying, visible]);

  const activeProjects = useMemo(() => getBulkOrganizeProjectOptions(projects), [projects]);
  const activeAreas = useMemo(() => getBulkOrganizeAreaOptions(areas), [areas]);


  const dialog = buildBulkOrganizeDialogModel({ draft, projects: activeProjects, areas: activeAreas, selectedCount, t });
  const selectedProjectId = dialog.project.selectedId;
  const selectedAreaId = dialog.area.selectedId;
  const isBusy = isApplying || isCreatingDestination;

  const selectDestination = async (kind: 'project' | 'area', id?: string) => {
    if (isApplying || destinationCreatePendingRef.current) return;
    try {
      const savedId = id ? await runDestinationCreate(async () => {
        await ensureBulkOrganizeDestinationSaved();
        return id;
      }) : BULK_ORGANIZE_NONE;
      if (!savedId) return;
      setDestinationError(null);

      editDraft({ type: kind === 'project' ? 'setProject' : 'setArea', value: savedId });
    } catch {
      setDestinationError(kind === 'project' ? dialog.createFailed.project : dialog.createFailed.area);
    }
  };

  const closeModal = useCallback(() => {
    if (isApplying || destinationCreatePendingRef.current) return;
    destinationCreateSessionRef.current += 1;
    onClose();
  }, [isApplying, onClose]);

  const renderChip = (label: string, selected: boolean, onPress: () => void, disabled = false) => (
    <TouchableOpacity
      key={label}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: disabled || isBusy }}
      disabled={disabled || isBusy}
      onPress={onPress}
      style={[
        styles.bulkOrganizeChip,
        {
          backgroundColor: selected ? themeColors.tint : themeColors.filterBg,
          borderColor: selected ? themeColors.tint : themeColors.border,
          opacity: disabled || isBusy ? 0.45 : 1,
        },
      ]}
    >
      <Text style={[styles.bulkOrganizeChipText, { color: selected ? themeColors.onTint : themeColors.text }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const renderPickerRow = ({
    disabled = false,
    label,
    onPress,
    testID,
    value,
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    value: string;
  }) => (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={{ disabled: disabled || isBusy }}
      disabled={disabled || isBusy}
      onPress={onPress}
      style={[
        styles.bulkOrganizePickerRow,
        {
          backgroundColor: themeColors.inputBg,
          borderColor: themeColors.border,
          opacity: disabled || isBusy ? 0.5 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.bulkOrganizePickerValue, { color: disabled ? themeColors.secondaryText : themeColors.text }]}
      >
        {value}
      </Text>
      <ChevronRight size={18} color={themeColors.secondaryText} strokeWidth={2.2} />
    </TouchableOpacity>
  );

  const apply = () => {
    if (isApplying || destinationCreatePendingRef.current) return;
    if (!dialog.canApply) {
      setShowValidation(true);
      return;
    }
    void onApply(buildBulkOrganizeInput(draft));
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={closeModal}
    >
      <Pressable
        style={keyboardInset > 0 ? [styles.modalOverlay, { paddingBottom: keyboardInset }] : styles.modalOverlay}
        onPress={closeModal}
      >
        <Pressable
          style={[styles.bulkOrganizeCard, { backgroundColor: themeColors.cardBg, borderColor: themeColors.border }]}
          onPress={(event) => event.stopPropagation()}
        >
          <View style={styles.bulkOrganizeHeader}>
            <View style={styles.bulkOrganizeTitleRow}>
              <ClipboardCheck size={18} color={themeColors.tint} />
              <View style={styles.bulkOrganizeTitleBlock}>
                <Text style={[styles.bulkOrganizeTitle, { color: themeColors.text }]}>
                  {dialog.title}
                </Text>
                <Text style={[styles.bulkOrganizeSubtitle, { color: themeColors.secondaryText }]}>
                  {dialog.subtitle}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={dialog.closeLabel}
              accessibilityState={{ disabled: isBusy }}
              disabled={isBusy}
              hitSlop={8}
              onPress={closeModal}
              style={styles.bulkOrganizeCloseButton}
            >
              <X size={20} color={themeColors.secondaryText} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.bulkOrganizeScroll}
            contentContainerStyle={styles.bulkOrganizeContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {dialog.statusLabel}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkOrganizeChipRow}>
                {dialog.statuses.map((option) => renderChip(
                  option.label,
                  option.selected,
                  () => {
                    editDraft({ type: 'setStatus', value: option.value });
                    setShowValidation(false);
                  },
                ))}
              </ScrollView>
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {dialog.project.label}
              </Text>
              {renderPickerRow({
                label: dialog.project.label,
                onPress: () => setProjectPickerVisible(true),
                testID: 'bulk-organize-project-picker-row',
                value: dialog.project.value,
              })}
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {dialog.area.label}
              </Text>
              {renderPickerRow({
                disabled: dialog.area.disabled,
                label: dialog.area.label,
                onPress: () => setAreaPickerVisible(true),
                testID: 'bulk-organize-area-picker-row',
                value: dialog.area.value,
              })}
            </View>

            {dialog.waitingFor && (
              <View style={styles.bulkOrganizeSection}>
                <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                  {dialog.waitingFor.label}
                </Text>
                <TextInput
                  accessibilityLabel={dialog.waitingFor.label}
                  value={draft.delegateWho}
                  onChangeText={(value) => {
                    editDraft({ type: 'setText', field: 'delegateWho', value });
                    setShowValidation(false);
                  }}
                  placeholder={dialog.waitingFor.placeholder}
                  placeholderTextColor={themeColors.secondaryText}
                  style={[
                    styles.bulkOrganizeInput,
                    { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                  ]}
                />
              </View>
            )}

            <View style={styles.bulkOrganizeDateGrid}>
              {dialog.dates.map(({ field, label }) => (
                <TaskListBulkDateField
                  key={field}
                  label={label}
                  value={draft[field]}
                  onChange={(value) => editDraft({ type: 'setText', field, value })}
                  pickerVisible={visible && datePicker === field}
                  onOpenPicker={() => setDatePicker(field)}
                  onClosePicker={() => setDatePicker(null)}
                  disabled={isBusy}
                  t={t}
                  tc={themeColors}
                />
              ))}
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {dialog.contexts.label}
              </Text>
              <TextInput
                accessibilityLabel={dialog.contexts.label}
                value={draft.contexts}
                onChangeText={(value) => editDraft({ type: 'setText', field: 'contexts', value })}
                placeholder={dialog.contexts.placeholder}
                placeholderTextColor={themeColors.secondaryText}
                style={[
                  styles.bulkOrganizeInput,
                  { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                ]}
              />
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {dialog.tags.label}
              </Text>
              <TextInput
                accessibilityLabel={dialog.tags.label}
                value={draft.tags}
                onChangeText={(value) => editDraft({ type: 'setText', field: 'tags', value })}
                placeholder={dialog.tags.placeholder}
                placeholderTextColor={themeColors.secondaryText}
                style={[
                  styles.bulkOrganizeInput,
                  { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                ]}
              />
            </View>

            {destinationError && (
              <Text accessibilityRole="alert" style={[styles.bulkOrganizeValidation, { color: themeColors.danger }]}>
                {destinationError}
              </Text>
            )}
            {showValidation && (
              <Text style={[styles.bulkOrganizeValidation, { color: themeColors.danger }]}>
                {dialog.validationMessage}
              </Text>
            )}
          </ScrollView>

          <View style={[styles.bulkOrganizeFooter, { borderTopColor: themeColors.border }]}>
            <TouchableOpacity
              onPress={closeModal}
              disabled={isBusy}
              style={styles.bulkOrganizeFooterButton}
              accessibilityRole="button"
              accessibilityState={{ disabled: isBusy }}
            >
              <Text style={[styles.bulkOrganizeFooterText, { color: themeColors.secondaryText }]}>
                {dialog.cancelLabel}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={apply}
              disabled={isBusy || selectedCount === 0}
              style={[
                styles.bulkOrganizeApplyButton,
                { backgroundColor: filledButton.backgroundColor, opacity: isBusy || selectedCount === 0 ? 0.6 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled: isBusy || selectedCount === 0, busy: isApplying }}
            >
              {isApplying ? (
                <ActivityIndicator size="small" color={filledButton.textColor ?? themeColors.onTint} />
              ) : null}
              <Text style={[styles.bulkOrganizeApplyText, { color: filledButton.textColor ?? themeColors.onTint }]}>
                {dialog.applyLabel}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>

      <TaskEditProjectPicker
        visible={visible && projectPickerVisible}
        projects={activeProjects}
        allProjects={projects}
        tc={themeColors}
        t={t}
        allowCreate={!isApplying}
        leadingOptions={[{
          key: 'keep-project',
          label: dialog.project.keepLabel,
          selected: draft.projectChoice === BULK_ORGANIZE_KEEP,
          onPress: () => editDraft({ type: 'setProject', value: BULK_ORGANIZE_KEEP }),
        }]}
        selectedProjectId={draft.projectChoice === BULK_ORGANIZE_NONE ? null : selectedProjectId}
        onClose={() => setProjectPickerVisible(false)}
        onSelectProject={(projectId?: string) => { void selectDestination('project', projectId); }}
        onCreateProject={(title) => runDestinationCreate(
          () => createBulkOrganizeProject(title, selectedAreaId),
        )}
      />

      <TaskEditAreaPicker
        visible={visible && areaPickerVisible}
        areas={activeAreas}
        tc={themeColors}
        t={t}
        allowCreate={!isApplying}
        leadingOptions={[{
          key: 'keep-area',
          label: dialog.area.keepLabel,
          selected: draft.areaChoice === BULK_ORGANIZE_KEEP,
          onPress: () => editDraft({ type: 'setArea', value: BULK_ORGANIZE_KEEP }),
        }]}
        selectedAreaId={draft.areaChoice === BULK_ORGANIZE_NONE ? null : selectedAreaId}
        onClose={() => setAreaPickerVisible(false)}
        onSelectArea={(areaId?: string) => { void selectDestination('area', areaId); }}
        onCreateArea={(name) => runDestinationCreate(() => createBulkOrganizeArea(name))}
      />
    </Modal>
  );
}
