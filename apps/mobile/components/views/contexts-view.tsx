import {
  View,
  Text,
  FlatList,
  ScrollView,
  Pressable,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import {
  useTaskStore,
  shallow,
  buildContextsTokenIndex,
  buildContextsViewModel,
  collectBulkTaskTokens,
  CONTEXTS_BULK_STATUSES,
  editContextsTaskTokens,
  formatListItemCount,
  getContextsChipLabels,
  getContextsEmptyState,
  getContextsMatchModeLabels,
  getContextsRouteTokens,
  getContextsTokenPicker,
  getContextsTokenPickerTitle,
  getTaskListHeaderText,
  getTaskSortByLabel,
  resolveContextsMatchMode,
  runStoreCommand,
  selectContextsRouteTokens,
  selectContextsToken,
  toggleContextsNoContext,
  toggleContextsToken,
  TASK_LIST_SORT_OPTIONS,
  type ContextOrTagMatchMode,
  type Task,
  type TaskStatus,
} from '@mindwtr/core';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openProjectScreen } from '@/lib/task-meta-navigation';
import { useToast } from '@/contexts/toast-context';
import { TaskEditModal } from '../task-edit-modal';
import { TokenPickerModal } from '../token-picker-modal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableTaskItem, type TaskRowActions } from '../swipeable-task-item';
import { Tag, CheckCircle2, X } from 'lucide-react-native';
import { styles as bulkStyles } from '../task-list/task-list.styles';
import { assertBulkActionSucceeded, useTaskListSelection } from '../use-task-list-selection';
import { TASK_LIST_WINDOWING_PROPS } from '../task-list-windowing';
import { TaskListSortButton } from '../task-list/TaskListSortButton';
import { TaskListSortModal } from '../task-list/TaskListSortModal';

type BulkTokenPickerState = {
  field: 'tags' | 'contexts';
  action: 'add' | 'remove';
} | null;

export function ContextsView() {
  const {
    tasks,
    updateTask,
    deleteTask,
    restoreTask,
    batchMoveTasks,
    batchDeleteTasks,
    batchUpdateTasks,
    settings,
    updateSettings,
  } = useTaskStore((state) => ({
    tasks: state.tasks,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    settings: state.settings,
    updateSettings: state.updateSettings,
  }), shallow);
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<ContextOrTagMatchMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);
  const [sortModalVisible, setSortModalVisible] = useState(false);

  const tc = useThemeColors();
  const { showToast } = useToast();
  const { visibleTasks } = useVisibleTaskContext();
  const requestedTokens = useMemo(() => getContextsRouteTokens(token), [token]);

  useEffect(() => {
    if (requestedTokens.length === 0) return;
    setSelectedContexts(selectContextsRouteTokens(requestedTokens));
    setMatchMode('all');
  }, [requestedTokens]);

  // The counts depend only on the tasks: count once per store change, not per selection.
  const contextsIndex = useMemo(() => buildContextsTokenIndex(visibleTasks), [visibleTasks]);
  const model = buildContextsViewModel({
    index: contextsIndex,
    settings,
    selectedTokens: selectedContexts,
    matchMode,
    searchQuery,
  });
  // Aligned with model.tokenChips: a child chip after its parent shows "/leaf" (#1428).
  const chipLabels = model.filterSections.flatMap((section) => getContextsChipLabels(section.tokens));
  const tasksById = useMemo(
    () => tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>),
    [tasks],
  );

  const noContextSelected = model.noContextSelected;
  useEffect(() => {
    const resolved = resolveContextsMatchMode(selectedContexts, matchMode);
    if (resolved !== matchMode) setMatchMode(resolved);
  }, [selectedContexts, matchMode]);
  const sortedTasks = model.tasks;
  const {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchDelete,
    handleBatchMove,
    hasSelection,
    multiSelectedIds,
    runBulkAction,
    selectedIdsArray,
    selectionMode,
    setMultiSelectedIds,
    toggleMultiSelect,
  } = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreTask,
    t,
    tasksById,
  });
  const removableTagOptions = useMemo(
    () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
    [selectedIdsArray, tasksById]
  );
  const removableContextOptions = useMemo(
    () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'contexts'),
    [selectedIdsArray, tasksById]
  );

  const handleStatusChange = (taskId: string, newStatus: TaskStatus) => {
    return updateTask(taskId, { status: newStatus });
  };

  const handleDelete = (taskId: string) => {
    return deleteTask(taskId);
  };

  const handleSaveTask = (taskId: string, updates: Partial<Task>) => {
    return updateTask(taskId, updates);
  };

  // The row handlers are re-created on every render of this screen, so rows
  // reach them through one object that never changes identity and reads the
  // latest values from a ref (#766).
  const rowSourcesRef = useRef({ handleStatusChange, handleDelete, toggleMultiSelect });
  rowSourcesRef.current = { handleStatusChange, handleDelete, toggleMultiSelect };
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: (task) => setEditingTask(task),
    changeStatus: (task, status) => rowSourcesRef.current.handleStatusChange(task.id, status),
    remove: (task) => rowSourcesRef.current.handleDelete(task.id),
    toggleSelect: (task) => rowSourcesRef.current.toggleMultiSelect(task.id),
  }), []);
  const focusToken = useCallback((token: string) => {
    setSelectedContexts([token]);
    setMatchMode('all');
  }, []);

  useEffect(() => {
    setMultiSelectedIds((prev) => {
      const visibleIds = new Set(sortedTasks.map((task) => task.id));
      const next = new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [setMultiSelectedIds, sortedTasks]);

  useEffect(() => {
    if (selectionMode && multiSelectedIds.size === 0) {
      exitSelectionMode();
    }
  }, [exitSelectionMode, multiSelectedIds.size, selectionMode]);

  const removeTagLabel = getContextsTokenPickerTitle('tags', 'remove', t);
  const tokenPicker = bulkTokenPicker
    ? getContextsTokenPicker({
      ...bulkTokenPicker,
      activeTasks: model.activeTasks,
      settings,
      selectedIds: selectedIdsArray,
      tasksById,
      t,
    })
    : null;
  const tokenPickerTitle = tokenPicker?.title ?? '';
  const tokenPickerOptions = tokenPicker?.tokens ?? [];
  const tokenPickerPlaceholder = bulkTokenPicker?.field === 'tags'
    ? t('taskEdit.tagsPlaceholder')
    : t('taskEdit.contextsPlaceholder');
  const matchModeLabels = getContextsMatchModeLabels(t);
  const emptyState = getContextsEmptyState({ hasTokens: model.hasTokens, selectedTokens: selectedContexts }, t);
  // The shared list sort (settings.taskSortBy), as Inbox's direct Sort control shows it (#1415).
  const sortAccessibilityLabel = getTaskListHeaderText({
    sortByLabel: getTaskSortByLabel(model.sortBy, t),
    hasActiveFilters: false,
    filterActiveCount: 0,
    t,
  }).sortAccessibilityLabel;

  const handleBulkTokenConfirm = async (values: string[]) => {
    if (!bulkTokenPicker || !hasSelection) return;
    await runBulkAction(tokenPickerTitle, async () => {
      setBulkTokenPicker(null);
      // One store command builds each list from the task as stored and writes it: a sync save admitted
      // first may have published a token another device added, and the rows on screen lack it.
      const outcome = await runStoreCommand(() => editContextsTaskTokens({ batchUpdateTasks }, {
        taskIds: selectedIdsArray,
        tasksById: Object.fromEntries(useTaskStore.getState()._tasksById),
        field: bulkTokenPicker.field,
        mode: bulkTokenPicker.action,
        values,
      }));
      if (!outcome.changed) return;
      assertBulkActionSucceeded(outcome.result);
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: formatListItemCount(outcome.count, 'task', t),
        tone: 'success',
      });
    });
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        {/* Search box for contexts */}
        <View style={[styles.searchContainer, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: tc.inputBg, color: tc.text }]}
            placeholder={t('contexts.search')}
            placeholderTextColor={tc.secondaryText}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          <TaskListSortButton
            accessibilityLabel={sortAccessibilityLabel}
            onPress={() => setSortModalVisible(true)}
            themeColors={tc}
          />
        </View>

        <View style={[styles.contextFiltersPanel, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.contextsBar}
            contentContainerStyle={styles.contextsBarContent}
          >
            <Pressable
              style={[
                styles.contextButton,
                {
                  backgroundColor: selectedContexts.length === 0 ? tc.tint : tc.filterBg,
                  borderColor: tc.border,
                },
              ]}
              onPress={() => { setSelectedContexts([]); setMatchMode('all'); }}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedContexts.length === 0 }}
              accessibilityLabel={t('contexts.all')}
            >
              <Text
                style={[
                  styles.contextButtonText,
                  { color: selectedContexts.length === 0 ? tc.onTint : tc.text },
                ]}
              >
                {t('common.all')}
              </Text>
              <View
                style={[
                  styles.contextBadge,
                  {
                    backgroundColor:
                      selectedContexts.length === 0
                        ? tc.cardBg
                        : isDark
                          ? 'rgba(255, 255, 255, 0.12)'
                          : 'rgba(0, 0, 0, 0.08)',
                  },
                ]}
              >
                <Text style={[styles.contextBadgeText, { color: selectedContexts.length === 0 ? tc.text : tc.secondaryText }]}>
                  {model.allCount}
                </Text>
              </View>
            </Pressable>

            <Pressable
              style={[
                styles.contextButton,
                {
                  backgroundColor: noContextSelected ? tc.tint : tc.filterBg,
                  borderColor: tc.border,
                },
              ]}
              onPress={() => {
                setSelectedContexts(toggleContextsNoContext(selectedContexts));
                setMatchMode('all');
              }}
              accessibilityRole="button"
              accessibilityLabel={t('contexts.none')}
              accessibilityState={{ selected: noContextSelected }}
            >
              <Text
                style={[
                  styles.contextButtonText,
                  { color: noContextSelected ? tc.onTint : tc.text },
                ]}
              >
                {t('contexts.none')}
              </Text>
              <View
                style={[
                  styles.contextBadge,
                  {
                    backgroundColor: noContextSelected
                      ? tc.cardBg
                      : isDark
                        ? 'rgba(255, 255, 255, 0.12)'
                        : 'rgba(0, 0, 0, 0.08)',
                  },
                ]}
              >
                <Text style={[styles.contextBadgeText, { color: noContextSelected ? tc.text : tc.secondaryText }]}>
                  {model.noContextCount}
                </Text>
              </View>
            </Pressable>
            {model.tokenChips.map(({ token: context, count, selected: isActive }, chipIndex) => {
              return (
                <Pressable
                  key={context}
                  style={[
                    styles.contextButton,
                    { backgroundColor: isActive ? tc.tint : tc.filterBg, borderColor: tc.border },
                  ]}
                  onPress={() => setSelectedContexts((prev) => selectContextsToken(prev, context))}
                  onLongPress={() => setSelectedContexts((prev) => toggleContextsToken(prev, context))}
                  accessibilityRole="button"
                  accessibilityLabel={`${context} (${count})`}
                  accessibilityState={{ selected: isActive }}
                  accessibilityActions={[{ name: 'longpress', label: isActive ? t('filters.remove') : t('common.add') }]}
                  onAccessibilityAction={(event) => {
                    if (event.nativeEvent.actionName === 'longpress') setSelectedContexts((prev) => toggleContextsToken(prev, context));
                  }}
                >
                  <Text
                    style={[
                      styles.contextButtonText,
                      { color: isActive ? tc.onTint : tc.text },
                    ]}
                  >
                    {chipLabels[chipIndex]?.label ?? context}
                  </Text>
                  <View
                    style={[
                      styles.contextBadge,
                      {
                        backgroundColor: isActive
                          ? tc.cardBg
                          : isDark
                            ? 'rgba(255, 255, 255, 0.12)'
                            : 'rgba(0, 0, 0, 0.08)',
                      },
                    ]}
                  >
                    <Text style={[styles.contextBadgeText, { color: isActive ? tc.text : tc.secondaryText }]}>{count}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          {model.showMatchMode ? (
            <View style={styles.matchModeRow} accessibilityRole="radiogroup">
              <Text style={[styles.matchModeLabel, { color: tc.secondaryText }]}>
                {matchModeLabels.label}
              </Text>
              <View style={[styles.matchModeControl, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                {(['all', 'any'] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    onPress={() => setMatchMode(mode)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: matchMode === mode }}
                    style={[styles.matchModeButton, matchMode === mode && { backgroundColor: tc.tint }]}
                  >
                    <Text style={[styles.matchModeButtonText, { color: matchMode === mode ? tc.onTint : tc.text }]}>
                      {mode === 'all' ? matchModeLabels.all : matchModeLabels.any}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.content}>
          {selectionMode ? (
            // Same look as the task lists' bulk bar (TaskListBulkBar); Contexts keeps its own actions.
            <View style={[bulkStyles.bulkBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
              <View style={bulkStyles.bulkStatusRow}>
                <Text style={[bulkStyles.bulkCount, { color: tc.secondaryText }]}>
                  {selectedIdsArray.length} {t('bulk.selected')}
                </Text>
                <View style={bulkStyles.bulkStatusActions}>
                  {bulkActionLoading ? (
                    <View style={bulkStyles.bulkLoadingRow}>
                      <ActivityIndicator size="small" color={tc.tint} />
                      <Text style={[bulkStyles.bulkLoadingText, { color: tc.secondaryText }]}>
                        {bulkActionLabel || t('common.loading')}
                      </Text>
                    </View>
                  ) : null}
                  <TouchableOpacity
                    onPress={exitSelectionMode}
                    disabled={bulkActionLoading}
                    style={[bulkStyles.bulkExitButton, { backgroundColor: tc.filterBg, opacity: bulkActionLoading ? 0.5 : 1 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('bulk.exitSelect')}
                  >
                    <X size={16} color={tc.secondaryText} strokeWidth={2} />
                  </TouchableOpacity>
                </View>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={bulkStyles.bulkMoveRow}>
                {CONTEXTS_BULK_STATUSES.map((status) => (
                  <TouchableOpacity
                    key={status}
                    onPress={() => void handleBatchMove(status)}
                    disabled={!hasSelection || bulkActionLoading}
                    style={[bulkStyles.bulkMoveButton, { backgroundColor: tc.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
                    accessibilityRole="button"
                  >
                    <Text style={[bulkStyles.bulkMoveText, { color: tc.text }]}>{t(`status.${status}`)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <View style={bulkStyles.bulkActions}>
                {([
                  { label: t('bulk.addTag'), onPress: () => setBulkTokenPicker({ field: 'tags', action: 'add' }), canRun: true },
                  { label: removeTagLabel, onPress: () => setBulkTokenPicker({ field: 'tags', action: 'remove' }), canRun: removableTagOptions.length > 0 },
                  { label: t('bulk.addContext'), onPress: () => setBulkTokenPicker({ field: 'contexts', action: 'add' }), canRun: true },
                  { label: t('bulk.removeContext'), onPress: () => setBulkTokenPicker({ field: 'contexts', action: 'remove' }), canRun: removableContextOptions.length > 0 },
                  { label: t('common.delete'), onPress: handleBatchDelete, canRun: true },
                ]).map(({ label, onPress, canRun }) => {
                  const enabled = hasSelection && !bulkActionLoading && canRun;
                  return (
                    <TouchableOpacity
                      key={label}
                      onPress={onPress}
                      disabled={!enabled}
                      style={[bulkStyles.bulkActionButton, { backgroundColor: tc.filterBg, opacity: enabled ? 1 : 0.5 }]}
                      accessibilityRole="button"
                    >
                      <Text style={[bulkStyles.bulkActionText, { color: tc.text }]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          <FlatList
            data={sortedTasks}
            renderItem={({ item: task }) => (
              <SwipeableTaskItem
                task={task}
                isDark={isDark}
                tc={tc}
                actions={rowActions}
                selectionMode={selectionMode}
                isMultiSelected={multiSelectedIds.has(task.id)}
                onProjectPress={openProjectScreen}
                onContextPress={focusToken}
                onTagPress={focusToken}
              />
            )}
            keyExtractor={(task) => task.id}
            style={[styles.taskList, { backgroundColor: tc.bg }]}
            contentContainerStyle={styles.taskListContent}
            {...TASK_LIST_WINDOWING_PROPS}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={(
              <View style={styles.emptyState}>
                {emptyState.icon === 'tag' ? (
                  <Tag size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                ) : (
                  <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                )}
                <Text style={[styles.emptyTitle, { color: tc.text }]}>{emptyState.title}</Text>
                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                  {emptyState.message}
                </Text>
              </View>
            )}
          />
        </View>

        <TokenPickerModal
          visible={bulkTokenPicker !== null}
          title={tokenPickerTitle}
          description={tokenPickerTitle}
          tokens={tokenPickerOptions}
          placeholder={tokenPickerPlaceholder}
          allowCustomValue={bulkTokenPicker?.action === 'add'}
          multiSelect={bulkTokenPicker?.action === 'remove'}
          onClose={() => setBulkTokenPicker(null)}
          onConfirm={(values) => {
            void handleBulkTokenConfirm(values);
          }}
        />

        <TaskListSortModal
          onClose={() => setSortModalVisible(false)}
          onSelect={(option) => {
            void updateSettings({ taskSortBy: option });
            setSortModalVisible(false);
          }}
          sortBy={model.sortBy}
          sortOptions={TASK_LIST_SORT_OPTIONS}
          t={t}
          themeColors={tc}
          visible={sortModalVisible}
        />

        {/* Task Edit Modal */}
        <TaskEditModal
          visible={editingTask !== null}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={handleSaveTask}
          defaultTab="view"
          onProjectNavigate={openProjectScreen}
          onContextNavigate={(context) => setSelectedContexts([context])}
          onTagNavigate={(tag) => setSelectedContexts([tag])}
        />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  searchInput: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  contextFiltersPanel: {
    borderBottomWidth: 1,
    paddingTop: 4,
    paddingBottom: 6,
  },
  matchModeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 8,
  },
  matchModeLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  matchModeControl: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 8,
    padding: 2,
  },
  matchModeButton: {
    minWidth: 52,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  matchModeButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  contextsBar: {
    flexGrow: 0,
  },
  contextsBarContent: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
    alignItems: 'center',
  },
  contextButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
  },
  contextButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#4B5563',
  },
  contextBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 18,
    alignItems: 'center',
  },
  contextBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  taskList: {
    flex: 1,
  },
  taskListContent: {
    padding: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
});
