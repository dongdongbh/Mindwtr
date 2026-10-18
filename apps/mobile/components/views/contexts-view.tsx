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
  getContextsEmptyState,
  getContextsMatchModeLabels,
  getContextsRouteTokens,
  getContextsTokenPicker,
  getContextsTokenPickerTitle,
  resolveContextsMatchMode,
  runStoreCommand,
  selectContextsRouteTokens,
  toggleContextsNoContext,
  toggleContextsToken,
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
import { Tag, CheckCircle2 } from 'lucide-react-native';
import { assertBulkActionSucceeded, useTaskListSelection } from '../use-task-list-selection';
import { TASK_LIST_WINDOWING_PROPS } from '../task-list-windowing';

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
  } = useTaskStore((state) => ({
    tasks: state.tasks,
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
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<ContextOrTagMatchMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);

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
            {model.tokenChips.map(({ token: context, count, selected: isActive }) => {
              return (
                <Pressable
                  key={context}
                  style={[
                    styles.contextButton,
                    { backgroundColor: isActive ? tc.tint : tc.filterBg, borderColor: tc.border },
                  ]}
                  onPress={() => setSelectedContexts((prev) => toggleContextsToken(prev, context))}
                  accessibilityRole="button"
                  accessibilityLabel={`${context} (${count})`}
                  accessibilityState={{ selected: isActive }}
                >
                  <Text
                    style={[
                      styles.contextButtonText,
                      { color: isActive ? tc.onTint : tc.text },
                    ]}
                  >
                    {context}
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
            <View style={[styles.bulkBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
              <View style={styles.bulkHeaderRow}>
                <Text style={[styles.bulkCount, { color: tc.secondaryText }]}>
                  {selectedIdsArray.length} {t('bulk.selected')}
                </Text>
                <View style={styles.bulkHeaderActions}>
                  {bulkActionLoading ? (
                    <View style={styles.bulkLoadingRow}>
                      <ActivityIndicator size="small" color={tc.tint} />
                      <Text style={[styles.bulkLoadingText, { color: tc.secondaryText }]}>
                        {bulkActionLabel || t('common.loading')}
                      </Text>
                    </View>
                  ) : null}
                  <TouchableOpacity
                    onPress={exitSelectionMode}
                    disabled={bulkActionLoading}
                    style={[
                      styles.bulkDoneButton,
                      {
                        borderColor: tc.border,
                        backgroundColor: tc.filterBg,
                        opacity: bulkActionLoading ? 0.5 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.bulkDoneButtonText, { color: tc.text }]}>
                      {t('bulk.exitSelect')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkRow}>
                {CONTEXTS_BULK_STATUSES.map((status) => (
                  <TouchableOpacity
                    key={status}
                    onPress={() => void handleBatchMove(status)}
                    disabled={!hasSelection || bulkActionLoading}
                    style={[
                      styles.bulkButton,
                      {
                        backgroundColor: tc.filterBg,
                        borderColor: tc.border,
                        opacity: hasSelection && !bulkActionLoading ? 1 : 0.5,
                      },
                    ]}
                  >
                    <Text style={[styles.bulkButtonText, { color: tc.text }]}>{t(`status.${status}`)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkRow}>
                <TouchableOpacity
                  onPress={() => setBulkTokenPicker({ field: 'tags', action: 'add' })}
                  disabled={!hasSelection || bulkActionLoading}
                  style={[
                    styles.bulkButton,
                    {
                      backgroundColor: tc.filterBg,
                      borderColor: tc.border,
                      opacity: hasSelection && !bulkActionLoading ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text style={[styles.bulkButtonText, { color: tc.text }]}>{t('bulk.addTag')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setBulkTokenPicker({ field: 'tags', action: 'remove' })}
                  disabled={!hasSelection || bulkActionLoading || removableTagOptions.length === 0}
                  style={[
                    styles.bulkButton,
                    {
                      backgroundColor: tc.filterBg,
                      borderColor: tc.border,
                      opacity: hasSelection && !bulkActionLoading && removableTagOptions.length > 0 ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text style={[styles.bulkButtonText, { color: tc.text }]}>{removeTagLabel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setBulkTokenPicker({ field: 'contexts', action: 'add' })}
                  disabled={!hasSelection || bulkActionLoading}
                  style={[
                    styles.bulkButton,
                    {
                      backgroundColor: tc.filterBg,
                      borderColor: tc.border,
                      opacity: hasSelection && !bulkActionLoading ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text style={[styles.bulkButtonText, { color: tc.text }]}>{t('bulk.addContext')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setBulkTokenPicker({ field: 'contexts', action: 'remove' })}
                  disabled={!hasSelection || bulkActionLoading || removableContextOptions.length === 0}
                  style={[
                    styles.bulkButton,
                    {
                      backgroundColor: tc.filterBg,
                      borderColor: tc.border,
                      opacity: hasSelection && !bulkActionLoading && removableContextOptions.length > 0 ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text style={[styles.bulkButtonText, { color: tc.text }]}>{t('bulk.removeContext')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleBatchDelete}
                  disabled={!hasSelection || bulkActionLoading}
                  style={[
                    styles.bulkButton,
                    {
                      backgroundColor: tc.filterBg,
                      borderColor: tc.border,
                      opacity: hasSelection && !bulkActionLoading ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text style={[styles.bulkButtonText, { color: tc.text }]}>{t('common.delete')}</Text>
                </TouchableOpacity>
              </ScrollView>
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
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  searchInput: {
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
  bulkBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  bulkHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bulkCount: {
    fontSize: 13,
    fontWeight: '600',
  },
  bulkHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  bulkLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  bulkLoadingText: {
    fontSize: 12,
  },
  bulkDoneButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bulkDoneButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  bulkRow: {
    gap: 8,
  },
  bulkButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bulkButtonText: {
    fontSize: 13,
    fontWeight: '600',
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
