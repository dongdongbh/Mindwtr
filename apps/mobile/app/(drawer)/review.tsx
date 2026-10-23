import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View, Text, FlatList, Pressable, StyleSheet, TouchableOpacity, Modal, TextInput, Share } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import {
  REVIEW_BULK_STATUSES,
  buildReviewShareText,
  decorateReviewOverviewGroups,
  flushPendingSave,
  getAdvancedReviewDate,
  getReviewExpansionControl,
  getReviewOverviewGroups,
  getReviewOverviewSortBy,
  getReviewOverviewText,
  isTaskDueForReview,
  toggleReviewExpandedId,
  useTaskStore,
  shallow,
  type Task,
  type TaskStatus,
  type ReviewOverviewScope,
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
import { useToast } from '../../contexts/toast-context';

import { TaskEditModal } from '@/components/task-edit-modal';
import { SwipeableTaskItem, type TaskRowActions } from '@/components/swipeable-task-item';
import { TaskListBulkOrganizeModal } from '@/components/task-list/TaskListBulkOrganizeModal';
import { TokenPickerModal } from '@/components/token-picker-modal';
import { useTaskListSelection } from '@/components/use-task-list-selection';

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
  const [scope, setScope] = useState<ReviewOverviewScope>('due');
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [reviewWriteBusy, setReviewWriteBusy] = useState(false);
  const [reviewSavePending, setReviewSavePending] = useState(false);

  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { areaById, resolvedAreaFilter, sortedAreas } = useMobileAreaFilter();

  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);
  const dueIds = useMemo(() => new Set(tasks.filter((task) => isTaskDueForReview(task, new Date(nowTick))).map((task) => task.id)), [nowTick, tasks]);

  useEffect(() => {
    const refresh = () => setNowTick(Date.now());
    const interval = setInterval(refresh, 60_000);
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { clearInterval(interval); listener.remove(); };
  }, []);

  const text = useMemo(() => getReviewOverviewText(t), [t]);
  const sortBy = getReviewOverviewSortBy(settings);
  const reviewOverviewGroups = useMemo(() => getReviewOverviewGroups({
    tasks,
    projects,
    orderedAreas: sortedAreas,
    areaFilter: resolvedAreaFilter,
    sortBy,
    scope,
    now: new Date(nowTick),
  }), [nowTick, projects, resolvedAreaFilter, scope, sortBy, sortedAreas, tasks]);
  const unassignedAreaColor = settings?.appearance?.unassignedAreaColor;
  const reviewTaskGroups = useMemo(
    () => decorateReviewOverviewGroups(reviewOverviewGroups, { areaById, unassignedAreaColor, text, scope }),
    [areaById, reviewOverviewGroups, scope, text, unassignedAreaColor],
  );
  const renderedTaskIds = useMemo(() => new Set(reviewTaskGroups.flatMap((area) => (
    !expandedAreaIds.has(area.id) ? [] : area.projectGroups.flatMap((project) => (
      expandedReviewProjectIds.has(project.id) ? project.tasks.map((task) => task.id) : []
    ))
  ))), [expandedAreaIds, expandedReviewProjectIds, reviewTaskGroups]);
  const canSelectTaskId = useCallback((id: string) => renderedTaskIds.has(id), [renderedTaskIds]);
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
    // The hook gates its own tag dialogs; these are the screen's.
    backExitsSelection: !(isModalVisible || moveModalVisible || bulkOrganizeVisible || showReviewModal || reviewPickerVisible),
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    canSelectTaskId,
    restoreTask,
    t,
    tasksById,
  });

  useEffect(() => {
    if (selectionMode && (multiSelectedIds.size === 0 || [...multiSelectedIds].some((id) => !renderedTaskIds.has(id)))) {
      exitSelectionMode();
    }
  }, [exitSelectionMode, multiSelectedIds, renderedTaskIds, selectionMode]);

  useFocusEffect(
    useCallback(() => {
      setExpandedAreaIds(new Set());
      setExpandedReviewProjectIds(new Set());
      return undefined;
    }, []),
  );

  const handleBatchShare = useCallback(async () => {
    if (!hasSelection) return;
    const message = buildReviewShareText(selectedIdsArray.map((id) => tasksById[id]).filter(Boolean));
    if (!message) return;

    try {
      await Share.share({ message });
      exitSelectionMode();
    } catch (error) {
      void logError(error, { scope: 'review', extra: { message: 'Share failed' } });
    }
  }, [hasSelection, selectedIdsArray, tasksById, exitSelectionMode]);

  const persistReviewWrite = useCallback(async (write: () => Promise<{ success: boolean; error?: string }>) => {
    if (reviewWriteBusy || reviewSavePending) return;
    setReviewWriteBusy(true);
    try {
      const result = await write();
      if (!result.success) throw new Error(result.error || 'Review update failed');
      setReviewSavePending(true);
      await flushPendingSave();
      setReviewSavePending(false);
      exitSelectionMode();
      showToast({ message: t('review.markReviewedDone'), tone: 'success' });
    } catch (error) {
      void logError(error, { scope: 'review', extra: { message: 'Mark reviewed failed' } });
      showToast({ message: t('bulk.updateFailed'), tone: 'warning' });
    } finally {
      setReviewWriteBusy(false);
    }
  }, [exitSelectionMode, reviewSavePending, reviewWriteBusy, showToast, t]);

  const retryReviewSave = useCallback(async () => {
    setReviewWriteBusy(true);
    try {
      if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
      else await flushPendingSave();
      setReviewSavePending(false);
      exitSelectionMode();
      showToast({ message: t('persistence.saved'), tone: 'success' });
    } catch {
      showToast({ message: t('bulk.updateFailed'), tone: 'warning' });
    } finally {
      setReviewWriteBusy(false);
    }
  }, [exitSelectionMode, showToast, t]);

  const markReviewed = useCallback((task: Task, advance = false) => {
    if (!isTaskDueForReview(task, new Date(nowTick))) return;
    void persistReviewWrite(() => updateTask(task.id, { reviewAt: advance ? getAdvancedReviewDate(task.reviewAt) : undefined }));
  }, [nowTick, persistReviewWrite, updateTask]);

  const markSelectedReviewed = useCallback(() => {
    if (scope !== 'due') return;
    const ids = selectedIdsArray.filter((id) => dueIds.has(id));
    if (ids.length === 0) return;
    void persistReviewWrite(() => batchUpdateTasks(ids.map((id) => ({ id, updates: { reviewAt: undefined } }))));
  }, [batchUpdateTasks, dueIds, persistReviewWrite, scope, selectedIdsArray]);

  const expansionControl = useMemo(() => getReviewExpansionControl(
    reviewTaskGroups,
    { areaIds: expandedAreaIds, projectIds: expandedReviewProjectIds },
    text,
  ), [expandedAreaIds, expandedReviewProjectIds, reviewTaskGroups, text]);

  const toggleAreaExpanded = useCallback((areaId: string) => {
    setExpandedAreaIds((prev) => toggleReviewExpandedId(prev, areaId));
  }, []);

  const nextExpansion = expansionControl.next;
  const cycleReviewExpansion = useCallback(() => {
    if (!nextExpansion) return;
    setExpandedAreaIds(new Set(nextExpansion.areaIds));
    setExpandedReviewProjectIds(new Set(nextExpansion.projectIds));
  }, [nextExpansion]);

  const toggleReviewProjectExpanded = useCallback((projectGroupId: string) => {
    setExpandedReviewProjectIds((prev) => toggleReviewExpandedId(prev, projectGroupId));
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
    <View key={task.id}>
    <SwipeableTaskItem
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
    {dueIds.has(task.id) && <View style={styles.reviewTaskActions}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${text.markReviewed}: ${task.title}`} disabled={reviewWriteBusy || reviewSavePending} onPress={() => markReviewed(task)} style={styles.reviewTaskActionButton}>
        <Text style={{ color: tc.tint }}>{text.markReviewed}</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${t('review.advanceWeek')}: ${task.title}`} disabled={reviewWriteBusy || reviewSavePending} onPress={() => markReviewed(task, true)} style={styles.reviewTaskActionButton}>
        <Text style={{ color: tc.tint }}>{t('review.advanceWeek')}</Text>
      </TouchableOpacity>
    </View>}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.scopeBar, { borderBottomColor: tc.border }]}>
        {(['due', 'all'] as const).map((choice) => <TouchableOpacity
          key={choice}
          accessibilityRole="button"
          accessibilityState={{ selected: scope === choice }}
          onPress={() => { if (choice !== scope) { exitSelectionMode(); setScope(choice); } }}
          style={[styles.scopeButton, { backgroundColor: scope === choice ? tc.tint : tc.filterBg }]}
        ><Text style={{ color: scope === choice ? tc.onTint : tc.text }}>{choice === 'due' ? text.scopeDue : text.scopeAll}</Text></TouchableOpacity>)}
        <Text style={[styles.scopeHelp, { color: tc.secondaryText }]}>{scope === 'due' ? text.dueHelp : text.overviewHelp}</Text>
        {scope === 'all' && <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${t('nav.done')} ${t('common.tasks')}`} onPress={() => router.push('/history')} style={styles.reviewTaskActionButton}><Text style={{ color: tc.tint }}>{t('nav.done')}</Text></TouchableOpacity>}
      </View>
      {reviewSavePending && <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.retry')} disabled={reviewWriteBusy} onPress={() => { void retryReviewSave(); }} style={styles.retryButton}>
        <Text style={{ color: tc.danger }}>{t('common.retry')}</Text>
      </TouchableOpacity>}
      {!selectionMode && (
        <View style={[styles.reviewActionBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={expansionControl.label}
            accessibilityState={{ disabled: expansionControl.disabled }}
            style={[
              styles.reviewExpansionButton,
              {
                backgroundColor: tc.filterBg,
                borderColor: tc.border,
                opacity: expansionControl.disabled ? 0.45 : 1,
              },
            ]}
            onPress={cycleReviewExpansion}
            disabled={expansionControl.disabled}
            activeOpacity={0.75}
          >
            {expansionControl.allExpanded
              ? <ChevronsUp size={20} color={tc.secondaryText} strokeWidth={2.4} />
              : <ChevronsDown size={20} color={tc.secondaryText} strokeWidth={2.4} />}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.startReviewButton, { backgroundColor: filledButton.backgroundColor }]}
            onPress={() => setReviewPickerVisible(true)}
            activeOpacity={0.85}
          >
            <Text style={[styles.startReviewButtonText, { color: filledButton.textColor ?? tc.onTint }]} numberOfLines={2} ellipsizeMode="tail">
              {text.startReview}
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
            <TouchableOpacity onPress={exitSelectionMode} style={styles.bulkCancelButton} accessibilityRole="button">
              <Text style={[styles.bulkCancelText, { color: tc.tint }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.bulkActions}>
            {scope === 'due' && <TouchableOpacity
              accessibilityRole="button"
              onPress={markSelectedReviewed}
              disabled={!hasSelection || reviewWriteBusy || reviewSavePending}
              style={[styles.bulkActionButton, styles.reviewTaskActionButton, { backgroundColor: tc.tint, opacity: hasSelection && !reviewWriteBusy && !reviewSavePending ? 1 : 0.5 }]}
            ><Text style={[styles.bulkActionText, { color: tc.onTint }]}>{text.markReviewed}</Text></TouchableOpacity>}
            <TouchableOpacity
              accessibilityRole="button"
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
                {text.organize}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setMoveModalVisible(true)}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('bulk.moveTo')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setTagModalVisible(true)}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('bulk.addTag')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
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
                {text.removeTag}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={handleBatchShare}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: tc.text }]}>{t('common.share')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
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
          return (
            <View style={styles.reviewAreaSection}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: areaExpanded }}
                accessibilityLabel={areaGroup.accessibilityLabel}
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
                  <View style={[styles.reviewAreaDot, { backgroundColor: areaGroup.color ?? tc.tint }]} />
                  <View style={styles.reviewAreaTextBlock}>
                    <Text style={[styles.reviewAreaTitle, { color: tc.text }]} numberOfLines={2}>
                      {areaGroup.title}
                    </Text>
                    <Text
                      style={[styles.reviewAreaSummaryText, { color: tc.secondaryText }]}
                      numberOfLines={2}
                    >
                      {areaGroup.summary}
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
                    return (
                      <View key={projectGroup.id} style={styles.reviewProjectGroup}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ expanded: projectExpanded }}
                          accessibilityLabel={projectGroup.accessibilityLabel}
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
                            {projectGroup.statusTone ? (
                              <View
                                style={[
                                  styles.reviewStatusDot,
                                  { backgroundColor: tc[projectGroup.statusTone] },
                                ]}
                              />
                            ) : null}
                            <Text
                              style={[
                                styles.reviewProjectSummaryText,
                                { color: projectGroup.summaryTone === 'warning' ? tc.warning : tc.secondaryText },
                              ]}
                              numberOfLines={2}
                            >
                              {projectGroup.summaryText}
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
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{scope === 'due' ? text.dueEmpty : text.overviewEmpty}</Text>
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
            <Text style={[styles.modalTitle, { color: tc.text }]}>{text.startReview}</Text>
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
              {REVIEW_BULK_STATUSES.map((status) => (
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
        title={text.removeTag}
        description={text.removeTag}
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
      />

      <ReviewModal
        visible={showReviewModal}
        onClose={() => setShowReviewModal(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scopeBar: { borderBottomWidth: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 12 },
  scopeButton: { borderRadius: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  scopeHelp: { width: '100%', fontSize: 12 },
  reviewTaskActions: { flexDirection: 'row', gap: 20, paddingHorizontal: 12, paddingVertical: 8 },
  reviewTaskActionButton: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
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
