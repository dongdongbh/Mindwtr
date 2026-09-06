import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, View, Text, FlatList, Pressable, StyleSheet, TouchableOpacity, Modal, TextInput, Share } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import {
  DEFAULT_AREA_COLOR,
  getReviewOverviewGroups,
  useTaskStore,
  shallow,
  tFallback,
  type Task,
  type TaskStatus,
} from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { ReviewModal } from '../../components/review-modal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp } from 'lucide-react-native';
import { logError } from '../../lib/app-log';

import { TaskEditModal } from '@/components/task-edit-modal';
import { SwipeableTaskItem, type TaskRowActions } from '@/components/swipeable-task-item';
import { TaskListBulkOrganizeModal } from '@/components/task-list/TaskListBulkOrganizeModal';
import { TokenPickerModal } from '@/components/token-picker-modal';
import { useTaskListSelection } from '@/components/use-task-list-selection';
import { resolveNonDoneTaskSortBy } from '@mindwtr/core';

export default function ReviewScreen() {
  const router = useRouter();
  const { tasks, projects, updateTask, deleteTask, restoreTask, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, settings } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    settings: state.settings,
  }), shallow);
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewPickerVisible, setReviewPickerVisible] = useState(false);
  const [moveModalVisible, setMoveModalVisible] = useState(false);
  const [bulkOrganizeVisible, setBulkOrganizeVisible] = useState(false);
  const [expandedAreaIds, setExpandedAreaIds] = useState<Set<string>>(new Set());
  const [expandedReviewProjectIds, setExpandedReviewProjectIds] = useState<Set<string>>(new Set());

  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const insets = useSafeAreaInsets();
  const { areaById, resolvedAreaFilter, sortedAreas } = useMobileAreaFilter();

  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);

  const restoreActionLabel = tFallback(t, 'trash.restoreToInbox', 'Restore');
  const {
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchMove,
    handleBatchOrganize,
    handleBatchRemoveTags,
    hasSelection,
    multiSelectedIds,
    removableTagOptions,
    removeTagPickerVisible,
    selectedIdsArray,
    selectionMode,
    setRemoveTagPickerVisible,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleMultiSelect,
  } = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreActionLabel,
    restoreTask,
    t,
    tasksById,
  });

  useEffect(() => {
    if (selectionMode && multiSelectedIds.size === 0) {
      exitSelectionMode();
    }
  }, [exitSelectionMode, multiSelectedIds, selectionMode]);

  useFocusEffect(
    useCallback(() => {
      setExpandedAreaIds(new Set());
      setExpandedReviewProjectIds(new Set());
      return undefined;
    }, []),
  );

  useEffect(() => {
    const handleBackPress = () => {
      if (
        isModalVisible
        || tagModalVisible
        || removeTagPickerVisible
        || moveModalVisible
        || bulkOrganizeVisible
        || showReviewModal
        || reviewPickerVisible
      ) {
        return false;
      }
      if (!selectionMode) return false;
      exitSelectionMode();
      return true;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [
    selectionMode,
    exitSelectionMode,
    isModalVisible,
    tagModalVisible,
    removeTagPickerVisible,
    moveModalVisible,
    bulkOrganizeVisible,
    showReviewModal,
    reviewPickerVisible,
  ]);

  const handleBatchShare = useCallback(async () => {
    if (!hasSelection) return;
    const selectedTasks = selectedIdsArray.map((id) => tasksById[id]).filter(Boolean);
    const lines: string[] = [];

    selectedTasks.forEach((task) => {
      lines.push(`- ${task.title}`);
      if (task.checklist?.length) {
        task.checklist.forEach((item) => {
          if (!item.title) return;
          lines.push(`  - ${item.isCompleted ? '[x]' : '[ ]'} ${item.title}`);
        });
      }
    });

    const message = lines.join('\n').trim();
    if (!message) return;

    try {
      await Share.share({ message });
      exitSelectionMode();
    } catch (error) {
      void logError(error, { scope: 'review', extra: { message: 'Share failed' } });
    }
  }, [hasSelection, selectedIdsArray, tasksById, exitSelectionMode]);

  const bulkStatuses: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];

  const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
  const reviewOverviewGroups = useMemo(() => getReviewOverviewGroups({
    tasks,
    projects,
    orderedAreas: sortedAreas,
    areaFilter: resolvedAreaFilter,
    sortBy,
  }), [projects, resolvedAreaFilter, sortBy, sortedAreas, tasks]);
  const noAreaLabel = t('review.noArea');
  const singleActionsLabel = t('review.singleActions');
  const translateOr = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  }, [t]);
  const unassignedLabel = translateOr('review.unassigned', 'Unassigned');
  const projectsLabel = translateOr('review.projectsLabel', 'projects');
  const needsActionLabel = translateOr('review.needsActionSummary', 'needs action');
  const withoutAreaLabel = translateOr('review.withoutArea', 'without an area');
  const activeTasksLabel = translateOr('review.activeTasks', 'active tasks');
  const startReviewLabel = translateOr('review.startReview', 'Start Review');
  const expandAreasLabel = translateOr('review.expandAreas', 'Expand areas');
  const expandEverythingLabel = translateOr('review.expandEverything', 'Expand projects');
  const collapseEverythingLabel = translateOr('review.collapseEverything', 'Collapse all');
  const unassignedAreaColor = settings?.appearance?.unassignedAreaColor || DEFAULT_AREA_COLOR;
  const reviewTaskGroups = useMemo(() => {
    return reviewOverviewGroups.map((group) => {
      const area = group.areaId ? areaById.get(group.areaId) : undefined;
      const representativeProject = group.projectGroups.find(({ project }) => project)?.project;
      const areaKey = group.areaId ? `area:${group.areaId}` : 'area:none';

      return {
        ...group,
        color: group.areaId
          ? (area?.color || representativeProject?.color || tc.tint)
          : unassignedAreaColor,
        id: areaKey,
        isUnassigned: !group.areaId,
        projectGroups: group.projectGroups.map((projectGroup) => ({
          ...projectGroup,
          id: projectGroup.project ? `project:${projectGroup.project.id}` : `single:${areaKey}`,
          isSingleActions: !projectGroup.project,
          projectId: projectGroup.project?.id,
          title: projectGroup.project?.title || singleActionsLabel,
        })),
        title: area?.name || representativeProject?.areaTitle || unassignedLabel || noAreaLabel,
      };
    });
  }, [areaById, noAreaLabel, reviewOverviewGroups, singleActionsLabel, tc.tint, unassignedAreaColor, unassignedLabel]);

  const areaGroupIds = useMemo(() => reviewTaskGroups.map((group) => group.id), [reviewTaskGroups]);
  const projectGroupIds = useMemo(
    () => reviewTaskGroups.flatMap((group) => group.projectGroups.map((projectGroup) => projectGroup.id)),
    [reviewTaskGroups],
  );
  const allAreasExpanded = areaGroupIds.length > 0 && areaGroupIds.every((areaId) => expandedAreaIds.has(areaId));
  const allProjectsExpanded = projectGroupIds.length > 0 && projectGroupIds.every((projectId) => expandedReviewProjectIds.has(projectId));
  const expansionControlLabel = !allAreasExpanded
    ? expandAreasLabel
    : allProjectsExpanded
      ? collapseEverythingLabel
      : expandEverythingLabel;

  const toggleAreaExpanded = useCallback((areaId: string) => {
    setExpandedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
  }, []);

  const cycleReviewExpansion = useCallback(() => {
    if (!areaGroupIds.length) return;
    if (!allAreasExpanded) {
      setExpandedAreaIds(new Set(areaGroupIds));
      setExpandedReviewProjectIds(new Set());
      return;
    }
    if (!allProjectsExpanded) {
      setExpandedAreaIds(new Set(areaGroupIds));
      setExpandedReviewProjectIds(new Set(projectGroupIds));
      return;
    }
    setExpandedAreaIds(new Set());
    setExpandedReviewProjectIds(new Set());
  }, [allAreasExpanded, allProjectsExpanded, areaGroupIds, projectGroupIds]);

  const toggleReviewProjectExpanded = useCallback((projectGroupId: string) => {
    setExpandedReviewProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectGroupId)) next.delete(projectGroupId);
      else next.add(projectGroupId);
      return next;
    });
  }, []);

  // One actions object for every row on the screen, reading the current store
  // handlers from a ref, so re-rendering the review list does not hand each row
  // a fresh set of arrows (#766).
  const rowSourcesRef = useRef({ updateTask, deleteTask, toggleMultiSelect });
  rowSourcesRef.current = { updateTask, deleteTask, toggleMultiSelect };
  const openTaskEditor = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: openTaskEditor,
    changeStatus: (task, status) => rowSourcesRef.current.updateTask(task.id, { status: status as TaskStatus }),
    remove: (task) => rowSourcesRef.current.deleteTask(task.id),
    toggleSelect: (task) => rowSourcesRef.current.toggleMultiSelect(task.id),
  }), [openTaskEditor]);
  const handleRowLongPress = useCallback((task: Task) => {
    rowSourcesRef.current.toggleMultiSelect(task.id);
  }, []);

  const renderReviewTaskItem = (task: Task) => (
    <SwipeableTaskItem
      key={task.id}
      task={task}
      isDark={isDark}
      tc={tc}
      actions={rowActions}
      selectionMode={selectionMode}
      isMultiSelected={multiSelectedIds.has(task.id)}
      onLongPressAction={handleRowLongPress}
      onProjectPress={openProjectScreen}
      onContextPress={openContextsScreen}
      onTagPress={openContextsScreen}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      {!selectionMode && (
        <View style={[styles.reviewActionBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={expansionControlLabel}
            accessibilityState={{ disabled: areaGroupIds.length === 0 }}
            style={[
              styles.reviewExpansionButton,
              {
                backgroundColor: tc.filterBg,
                borderColor: tc.border,
                opacity: areaGroupIds.length > 0 ? 1 : 0.45,
              },
            ]}
            onPress={cycleReviewExpansion}
            disabled={areaGroupIds.length === 0}
            activeOpacity={0.75}
          >
            {allAreasExpanded && allProjectsExpanded
              ? <ChevronsUp size={20} color={tc.secondaryText} strokeWidth={2.4} />
              : <ChevronsDown size={20} color={tc.secondaryText} strokeWidth={2.4} />}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.startReviewButton, { backgroundColor: filledButton.backgroundColor }]}
            onPress={() => setReviewPickerVisible(true)}
            activeOpacity={0.85}
          >
            <Text style={[styles.startReviewButtonText, { color: filledButton.textColor ?? tc.onTint }]} numberOfLines={2} ellipsizeMode="tail">
              {startReviewLabel}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {selectionMode && (
        <View style={[styles.bulkBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <View style={styles.bulkHeaderRow}>
            <Text style={[styles.bulkCount, { color: tc.secondaryText }]}>
              {selectedIdsArray.length} {t('bulk.selected')}
            </Text>
            <TouchableOpacity onPress={exitSelectionMode} style={styles.bulkCancelButton}>
              <Text style={[styles.bulkCancelText, { color: tc.tint }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.bulkActions}>
            <TouchableOpacity
              onPress={() => setBulkOrganizeVisible(true)}
              disabled={!hasSelection || bulkActionLoading}
              style={[
                styles.bulkActionButton,
                {
                  backgroundColor: tc.tint,
                  opacity: hasSelection && !bulkActionLoading ? 1 : 0.5,
                },
              ]}
            >
              <Text style={[styles.bulkActionText, { color: tc.onTint }]}>
                {translateOr('bulk.organize', 'Organize')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setMoveModalVisible(true)}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('bulk.moveTo')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setTagModalVisible(true)}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('bulk.addTag')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setRemoveTagPickerVisible(true)}
              disabled={!hasSelection || removableTagOptions.length === 0}
              style={[
                styles.bulkActionButton,
                {
                  backgroundColor: tc.filterBg,
                  opacity: hasSelection && removableTagOptions.length > 0 ? 1 : 0.5,
                },
              ]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>
                {tFallback(t, 'bulk.removeTag', 'Remove tag')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleBatchShare}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('common.share')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleBatchDelete}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('common.delete')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={reviewTaskGroups}
        renderItem={({ item: areaGroup }) => {
          const areaExpanded = expandedAreaIds.has(areaGroup.id);
          const taskSummary = areaGroup.isUnassigned
            ? `${areaGroup.taskCount} ${t('common.tasks')} ${withoutAreaLabel}`
            : `${areaGroup.taskCount} ${t('common.tasks')}`;
          const areaSummary = [
            areaGroup.projectCount > 0 ? `${areaGroup.projectCount} ${projectsLabel}` : null,
            taskSummary,
            areaGroup.needsActionCount > 0
              ? `${areaGroup.needsActionCount} ${needsActionLabel}`
              : null,
          ].filter(Boolean).join(' · ');
          return (
            <View style={styles.reviewAreaSection}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: areaExpanded }}
                accessibilityLabel={`${areaGroup.title}, ${areaSummary}`}
                style={({ pressed }) => [
                  styles.reviewAreaHeader,
                  {
                    backgroundColor: pressed ? tc.filterBg : 'transparent',
                    borderBottomColor: tc.border,
                  },
                ]}
                onPress={() => toggleAreaExpanded(areaGroup.id)}
              >
                <View style={styles.reviewAreaHeaderMain}>
                  <View style={[styles.reviewAreaDot, { backgroundColor: areaGroup.color }]} />
                  <View style={styles.reviewAreaTextBlock}>
                    <Text style={[styles.reviewAreaTitle, { color: tc.text }]} numberOfLines={2}>
                      {areaGroup.title}
                    </Text>
                    <Text
                      style={[styles.reviewAreaSummaryText, { color: tc.secondaryText }]}
                      numberOfLines={2}
                    >
                      {areaSummary}
                    </Text>
                  </View>
                </View>
                {areaExpanded
                  ? <ChevronDown size={20} color={tc.secondaryText} strokeWidth={2.4} />
                  : <ChevronRight size={20} color={tc.secondaryText} strokeWidth={2.4} />}
              </Pressable>

              {areaExpanded && (
                <View style={styles.reviewAreaBody}>
                  {areaGroup.projectGroups.map((projectGroup) => {
                    const projectExpanded = expandedReviewProjectIds.has(projectGroup.id);
                    const projectStateLabel = projectGroup.nextActionState === 'next'
                      ? t('review.hasNextAction')
                      : projectGroup.nextActionState === 'waiting'
                        ? t('status.waiting')
                        : t('review.needsAction');
                    const projectSummary = projectGroup.isSingleActions
                      ? `${projectGroup.tasks.length} ${t('common.tasks')}`
                      : `${projectGroup.tasks.length} ${activeTasksLabel} · ${projectStateLabel}`;
                    return (
                      <View key={projectGroup.id} style={styles.reviewProjectGroup}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ expanded: projectExpanded }}
                          accessibilityLabel={`${projectGroup.title}, ${projectSummary}`}
                          style={({ pressed }) => [
                            styles.reviewProjectHeader,
                            {
                              backgroundColor: pressed ? tc.filterBg : 'transparent',
                              borderBottomColor: tc.border,
                            },
                          ]}
                          onPress={() => toggleReviewProjectExpanded(projectGroup.id)}
                        >
                          <View style={styles.reviewProjectTitleRow}>
                            <Text style={[styles.reviewProjectTitle, { color: tc.text }]} numberOfLines={2}>
                              {projectGroup.title}
                            </Text>
                            {projectExpanded
                              ? <ChevronDown size={17} color={tc.secondaryText} strokeWidth={2.3} />
                              : <ChevronRight size={17} color={tc.secondaryText} strokeWidth={2.3} />}
                          </View>
                          <View style={styles.reviewProjectSummaryRow}>
                            {projectGroup.projectId ? (
                              <View
                                style={[
                                  styles.reviewStatusDot,
                                  {
                                    backgroundColor: projectGroup.nextActionState === 'next'
                                      ? tc.success
                                      // Delegated (waiting) stays amber; truly stuck turns red (#1086).
                                      : projectGroup.nextActionState === 'waiting'
                                        ? tc.warning
                                        : tc.danger,
                                  },
                                ]}
                              />
                            ) : null}
                            <Text
                              style={[
                                styles.reviewProjectSummaryText,
                                {
                                  color: projectGroup.projectId && projectGroup.nextActionState === 'none'
                                    ? tc.warning
                                    : tc.secondaryText,
                                },
                              ]}
                              numberOfLines={2}
                            >
                              {projectGroup.isSingleActions
                                ? `${projectSummary} · ${singleActionsLabel}`
                                : projectSummary}
                            </Text>
                          </View>
                        </Pressable>
                        {projectExpanded && (
                          <View style={styles.reviewGroupedTasks}>
                            {projectGroup.tasks.map(renderReviewTaskItem)}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        }}
        keyExtractor={(areaGroup) => areaGroup.id}
        style={styles.taskList}
        contentContainerStyle={{ paddingBottom: 16 + insets.bottom }}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.noTasks')}</Text>
          </View>
        }
      />

      <Modal
        visible={reviewPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setReviewPickerVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setReviewPickerVisible(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: tc.cardBg }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: tc.text }]}>{startReviewLabel}</Text>
            <TouchableOpacity
              style={[styles.reviewPickerOption, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={() => {
                setReviewPickerVisible(false);
                router.push('/daily-review');
              }}
            >
              <Text style={[styles.reviewPickerOptionText, { color: tc.text }]}>{t('dailyReview.title')}</Text>
              <ChevronRight size={18} color={tc.secondaryText} strokeWidth={2.4} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.reviewPickerOption, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
              onPress={() => {
                setReviewPickerVisible(false);
                setShowReviewModal(true);
              }}
            >
              <Text style={[styles.reviewPickerOptionText, { color: tc.text }]}>{t('review.openGuide')}</Text>
              <ChevronRight size={18} color={tc.secondaryText} strokeWidth={2.4} />
            </TouchableOpacity>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={() => setReviewPickerVisible(false)}
                style={styles.modalButton}
              >
                <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={moveModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMoveModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setMoveModalVisible(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: tc.cardBg }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: tc.text }]}>{t('bulk.moveTo')}</Text>
            <View style={styles.moveOptions}>
              {bulkStatuses.map((status) => (
                <TouchableOpacity
                  key={status}
                  onPress={async () => {
                    setMoveModalVisible(false);
                    await handleBatchMove(status);
                  }}
                  disabled={!hasSelection}
                  style={[
                    styles.moveOptionButton,
                    { backgroundColor: tc.filterBg, borderColor: tc.border, opacity: hasSelection ? 1 : 0.5 },
                  ]}
                >
                  <Text style={[styles.moveOptionText, { color: tc.text }]}>{t(`status.${status}`)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={() => setMoveModalVisible(false)}
                style={styles.modalButton}
              >
                <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={tagModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTagModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setTagModalVisible(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: tc.cardBg }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: tc.text }]}>{t('bulk.addTag')}</Text>
            <TextInput
              value={tagInput}
              onChangeText={setTagInput}
              placeholder={t('taskEdit.tagsLabel')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.modalInput, { backgroundColor: tc.filterBg, color: tc.text, borderColor: tc.border }]}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={() => {
                  setTagModalVisible(false);
                  setTagInput('');
                }}
                style={styles.modalButton}
              >
                <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleBatchAddTag}
                disabled={!tagInput.trim()}
                style={[styles.modalButton, !tagInput.trim() && styles.modalButtonDisabled]}
              >
                <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <TokenPickerModal
        visible={removeTagPickerVisible}
        title={tFallback(t, 'bulk.removeTag', 'Remove tag')}
        description={tFallback(t, 'bulk.removeTag', 'Remove tag')}
        tokens={removableTagOptions}
        placeholder={t('bulk.tagPlaceholder')}
        multiSelect
        onClose={() => setRemoveTagPickerVisible(false)}
        onConfirm={(values) => {
          void handleBatchRemoveTags(values);
        }}
      />

      <TaskListBulkOrganizeModal
        areas={sortedAreas}
        isApplying={bulkActionLoading}
        onApply={async (input) => {
          await handleBatchOrganize(input);
          setBulkOrganizeVisible(false);
        }}
        onClose={() => {
          if (!bulkActionLoading) setBulkOrganizeVisible(false);
        }}
        projects={projects}
        selectedCount={selectedIdsArray.length}
        t={t}
        themeColors={tc}
        visible={bulkOrganizeVisible}
      />

      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={(taskId, updates) => updateTask(taskId, updates)}
        defaultTab="view"
        onProjectNavigate={openProjectScreen}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
        onFocusMode={(taskId) => {
          setIsModalVisible(false);
          router.push(`/check-focus?id=${taskId}`);
        }}
      />

      <ReviewModal
        visible={showReviewModal}
        onClose={() => setShowReviewModal(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  reviewActionBar: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  reviewExpansionButton: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  startReviewButton: {
    alignItems: 'center',
    borderRadius: 10,
    justifyContent: 'center',
    minWidth: 152,
    minHeight: 42,
    paddingHorizontal: 16,
    maxWidth: '100%',
  },
  startReviewButtonText: {
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  taskList: {
    flex: 1,
    padding: 16,
  },
  reviewAreaSection: {
    marginBottom: 6,
  },
  reviewAreaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    paddingVertical: 14,
  },
  reviewAreaHeaderMain: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  reviewAreaTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  reviewAreaDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  reviewAreaTitle: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  reviewAreaSummaryText: {
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 17,
  },
  reviewAreaBody: {
    marginTop: 0,
  },
  reviewProjectGroup: {
    marginLeft: 18,
    paddingLeft: 8,
  },
  reviewProjectHeader: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    paddingVertical: 12,
    gap: 5,
  },
  reviewProjectTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minWidth: 0,
  },
  reviewProjectTitle: {
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
  },
  reviewProjectSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  reviewProjectSummaryText: {
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 17,
    flex: 1,
  },
  reviewStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  reviewGroupedTasks: {
    marginTop: 8,
    marginLeft: 4,
    gap: 8,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    textAlign: 'center',
  },
  bulkBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  bulkHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  bulkCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkCancelButton: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  bulkCancelText: {
    fontSize: 12,
    fontWeight: '700',
  },
  bulkMoveRow: {
    gap: 6,
    paddingVertical: 2,
  },
  bulkMoveButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  bulkMoveText: {
    fontSize: 12,
    fontWeight: '500',
  },
  bulkActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  bulkActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  bulkActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  moveOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  moveOptionButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  moveOptionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  reviewPickerOption: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  reviewPickerOptionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modalButtonDisabled: {
    opacity: 0.5,
  },
  modalButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
