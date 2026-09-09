import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ChevronRight, ClipboardCheck, X } from 'lucide-react-native';
import {
  createBulkOrganizeArea,
  createBulkOrganizeProject,
  ensureBulkOrganizeDestinationSaved,
  isSelectableProjectForTaskAssignment,
  parseBulkOrganizeTokenInput,
  tFallback,
  type Area,
  type BulkOrganizeStatus,
  type BulkOrganizeTaskUpdateInput,
  type Project,
} from '@mindwtr/core';

import { TaskEditAreaPicker } from '../task-edit/TaskEditAreaPicker';
import { TaskEditProjectPicker } from '../task-edit/TaskEditProjectPicker';
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

const STATUS_OPTIONS: BulkOrganizeStatus[] = ['next', 'waiting', 'someday', 'done', 'reference'];
const KEEP_VALUE = '__KEEP__';
const NONE_VALUE = '__NONE__';

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
  const [status, setStatus] = useState<BulkOrganizeStatus | typeof KEEP_VALUE>(KEEP_VALUE);
  const [projectChoice, setProjectChoice] = useState(KEEP_VALUE);
  const [areaChoice, setAreaChoice] = useState(KEEP_VALUE);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [areaPickerVisible, setAreaPickerVisible] = useState(false);
  const [contextsInput, setContextsInput] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [delegateWho, setDelegateWho] = useState('');
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
    if (!visible) {
      setProjectPickerVisible(false);
      setAreaPickerVisible(false);
      return;
    }
    setStatus(KEEP_VALUE);
    setProjectChoice(KEEP_VALUE);
    setAreaChoice(KEEP_VALUE);
    setProjectPickerVisible(false);
    setAreaPickerVisible(false);
    setContextsInput('');
    setTagsInput('');
    setStartDate('');
    setDueDate('');
    setReviewDate('');
    setDelegateWho('');
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

  const selectDestination = async (kind: 'project' | 'area', id?: string) => {
    if (isApplying || destinationCreatePendingRef.current) return;
    try {
      const savedId = id ? await runDestinationCreate(async () => {
        await ensureBulkOrganizeDestinationSaved();
        return id;
      }) : NONE_VALUE;
      if (!savedId) return;
      setDestinationError(null);
      if (kind === 'project') {
        setProjectChoice(savedId);
        setAreaChoice(KEEP_VALUE);
      } else {
        setAreaChoice(savedId);
      }
    } catch {
      setDestinationError(kind === 'project'
        ? tFallback(t, 'projects.createFailed', 'Failed to create project.')
        : tFallback(t, 'projects.createAreaFailed', 'Failed to create area.'));
    }
  };

  const closeModal = useCallback(() => {
    if (isApplying || destinationCreatePendingRef.current) return;
    destinationCreateSessionRef.current += 1;
    onClose();
  }, [isApplying, onClose]);

  const activeProjects = useMemo(
    () => projects
      .filter(isSelectableProjectForTaskAssignment)
      .sort((a, b) => a.title.localeCompare(b.title)),
    [projects],
  );
  const activeAreas = useMemo(
    () => areas
      .filter((area) => !area.deletedAt)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [areas],
  );

  const selectedProjectId = projectChoice !== KEEP_VALUE && projectChoice !== NONE_VALUE ? projectChoice : undefined;
  const selectedAreaId = areaChoice !== KEEP_VALUE && areaChoice !== NONE_VALUE ? areaChoice : undefined;
  const selectedProject = selectedProjectId ? activeProjects.find((project) => project.id === selectedProjectId) : undefined;
  const selectedArea = selectedAreaId ? activeAreas.find((area) => area.id === selectedAreaId) : undefined;
  const projectChoiceLabel = projectChoice === KEEP_VALUE
    ? tFallback(t, 'bulk.keepProject', 'Keep project')
    : projectChoice === NONE_VALUE
      ? tFallback(t, 'taskEdit.noProjectOption', 'No project')
      : selectedProject?.title ?? tFallback(t, 'taskEdit.projectLabel', 'Project');
  const areaChoiceLabel = areaChoice === KEEP_VALUE
    ? tFallback(t, 'bulk.keepArea', 'Keep area')
    : areaChoice === NONE_VALUE
      ? tFallback(t, 'taskEdit.noAreaOption', 'No area')
      : selectedArea?.name ?? tFallback(t, 'projects.areaLabel', 'Area');
  const isWaiting = status === 'waiting';
  const canApply = selectedCount > 0 && (!isWaiting || delegateWho.trim().length > 0);
  const isBusy = isApplying || isCreatingDestination;

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
    if (!canApply) {
      setShowValidation(true);
      return;
    }
    const input: BulkOrganizeTaskUpdateInput = {
      contexts: parseBulkOrganizeTokenInput(contextsInput, '@'),
      tags: parseBulkOrganizeTokenInput(tagsInput, '#'),
    };

    if (status !== KEEP_VALUE) input.status = status;

    if (projectChoice !== KEEP_VALUE) {
      input.projectId = projectChoice === NONE_VALUE ? null : projectChoice;
    }
    if (!selectedProjectId && areaChoice !== KEEP_VALUE) {
      input.areaId = areaChoice === NONE_VALUE ? null : areaChoice;
    }
    if (startDate.trim()) input.startTime = startDate.trim();
    if (dueDate.trim()) input.dueDate = dueDate.trim();
    if (reviewDate.trim()) input.reviewAt = reviewDate.trim();
    if (isWaiting) input.assignedTo = delegateWho.trim();

    void onApply(input);
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
                  {tFallback(t, 'bulk.organize', 'Bulk organize')}
                </Text>
                <Text style={[styles.bulkOrganizeSubtitle, { color: themeColors.secondaryText }]}>
                  {selectedCount} {tFallback(t, 'bulk.selected', 'selected')} - {tFallback(t, 'bulk.organizeHintShort', 'Titles and descriptions stay unchanged.')}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={tFallback(t, 'common.close', 'Close')}
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
                {tFallback(t, 'bulk.organizeStatus', 'Status')}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkOrganizeChipRow}>
                {renderChip(
                  tFallback(t, 'bulk.keepStatus', 'Keep status'),
                  status === KEEP_VALUE,
                  () => {
                    setStatus(KEEP_VALUE);
                    setShowValidation(false);
                  },
                )}
                {STATUS_OPTIONS.map((option) => renderChip(
                  tFallback(t, `status.${option}`, option),
                  status === option,
                  () => {
                    setStatus(option);
                    setShowValidation(false);
                  },
                ))}
              </ScrollView>
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {tFallback(t, 'taskEdit.projectLabel', 'Project')}
              </Text>
              {renderPickerRow({
                label: tFallback(t, 'taskEdit.projectLabel', 'Project'),
                onPress: () => setProjectPickerVisible(true),
                testID: 'bulk-organize-project-picker-row',
                value: projectChoiceLabel,
              })}
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {tFallback(t, 'projects.areaLabel', 'Area')}
              </Text>
              {renderPickerRow({
                disabled: Boolean(selectedProjectId),
                label: tFallback(t, 'projects.areaLabel', 'Area'),
                onPress: () => setAreaPickerVisible(true),
                testID: 'bulk-organize-area-picker-row',
                value: areaChoiceLabel,
              })}
            </View>

            {isWaiting && (
              <View style={styles.bulkOrganizeSection}>
                <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                  {tFallback(t, 'process.delegateWhoLabel', 'Waiting for')}
                </Text>
                <TextInput
                  value={delegateWho}
                  onChangeText={(value) => {
                    setDelegateWho(value);
                    setShowValidation(false);
                  }}
                  placeholder={tFallback(t, 'process.delegateWhoPlaceholder', 'Person or team')}
                  placeholderTextColor={themeColors.secondaryText}
                  style={[
                    styles.bulkOrganizeInput,
                    { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                  ]}
                />
              </View>
            )}

            <View style={styles.bulkOrganizeDateGrid}>
              <View style={styles.bulkOrganizeDateField}>
                <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                  {tFallback(t, 'taskEdit.startDateLabel', 'Start')}
                </Text>
                <TextInput
                  value={startDate}
                  onChangeText={setStartDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={themeColors.secondaryText}
                  style={[
                    styles.bulkOrganizeInput,
                    { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                  ]}
                />
              </View>
              <View style={styles.bulkOrganizeDateField}>
                <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                  {tFallback(t, 'taskEdit.dueDateLabel', 'Due')}
                </Text>
                <TextInput
                  value={dueDate}
                  onChangeText={setDueDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={themeColors.secondaryText}
                  style={[
                    styles.bulkOrganizeInput,
                    { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                  ]}
                />
              </View>
              <View style={styles.bulkOrganizeDateField}>
                <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                  {isWaiting ? tFallback(t, 'process.followUpLabel', 'Follow-up') : tFallback(t, 'taskEdit.reviewDateLabel', 'Review')}
                </Text>
                <TextInput
                  value={reviewDate}
                  onChangeText={setReviewDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={themeColors.secondaryText}
                  style={[
                    styles.bulkOrganizeInput,
                    { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                  ]}
                />
              </View>
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {tFallback(t, 'taskEdit.contextsLabel', 'Contexts')}
              </Text>
              <TextInput
                value={contextsInput}
                onChangeText={setContextsInput}
                placeholder="@computer, @office"
                placeholderTextColor={themeColors.secondaryText}
                style={[
                  styles.bulkOrganizeInput,
                  { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text },
                ]}
              />
            </View>

            <View style={styles.bulkOrganizeSection}>
              <Text style={[styles.bulkOrganizeLabel, { color: themeColors.secondaryText }]}>
                {tFallback(t, 'taskEdit.tagsLabel', 'Tags')}
              </Text>
              <TextInput
                value={tagsInput}
                onChangeText={setTagsInput}
                placeholder="#project, #admin"
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
                {tFallback(t, 'bulk.waitingPersonRequired', 'Choose who these items are waiting for.')}
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
                {tFallback(t, 'common.cancel', 'Cancel')}
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
                {tFallback(t, 'bulk.applyToSelected', 'Apply to selected')}
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
          label: tFallback(t, 'bulk.keepProject', 'Keep project'),
          selected: projectChoice === KEEP_VALUE,
          onPress: () => {
            setProjectChoice(KEEP_VALUE);
            setAreaChoice(KEEP_VALUE);
          },
        }]}
        selectedProjectId={projectChoice === NONE_VALUE ? null : selectedProjectId}
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
          label: tFallback(t, 'bulk.keepArea', 'Keep area'),
          selected: areaChoice === KEEP_VALUE,
          onPress: () => setAreaChoice(KEEP_VALUE),
        }]}
        selectedAreaId={areaChoice === NONE_VALUE ? null : selectedAreaId}
        onClose={() => setAreaPickerVisible(false)}
        onSelectArea={(areaId?: string) => { void selectDestination('area', areaId); }}
        onCreateArea={(name) => runDestinationCreate(() => createBulkOrganizeArea(name))}
      />
    </Modal>
  );
}
