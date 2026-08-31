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
  getUsedTaskTokens,
  getFrequentTaskTokens,
  sortTasksBy,
  buildBulkTaskTokenUpdates,
  collectBulkTaskTokens,
  isTaskFinished,
  tFallback,
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
import {
  buildContextsViewFilterSections,
  taskHasContextOrTag,
  taskMatchesContextOrTagFilter,
} from './contexts-view-filter-utils';
import { assertBulkActionSucceeded, useTaskListSelection } from '../use-task-list-selection';
import { TASK_LIST_WINDOWING_PROPS } from '../task-list-windowing';
import { resolveNonDoneTaskSortBy } from '@/lib/task-list-sort';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);

  const tc = useThemeColors();
  const { showToast } = useToast();
  const { visibleTasks } = useVisibleTaskContext();
  const requestedTokens = useMemo(() => {
    if (Array.isArray(token)) return token.filter(Boolean);
    if (typeof token === 'string' && token.trim()) return [token];
    return [];
  }, [token]);

  const NO_CONTEXT_TOKEN = '__no_context__';

  useEffect(() => {
    if (requestedTokens.length === 0) return;
    setSelectedContexts(requestedTokens);
  }, [requestedTokens]);

  const contextSourceTasks = visibleTasks.filter((task) => !isTaskFinished(task));
  const allContextTokens = getUsedTaskTokens(contextSourceTasks, (task) => task.contexts, { prefix: '@' });
  const allTagTokens = getUsedTaskTokens(contextSourceTasks, (task) => task.tags, { prefix: '#' });
  const filterSections = useMemo(
    () => buildContextsViewFilterSections({
      contextTokens: allContextTokens,
      searchQuery,
      tagTokens: allTagTokens,
    }),
    [allContextTokens, allTagTokens, searchQuery]
  );
  const allFilterTokens = useMemo(
    () => [...allContextTokens, ...allTagTokens],
    [allContextTokens, allTagTokens]
  );
  const addTagOptions = useMemo(
    () => Array.from(new Set([
      ...getFrequentTaskTokens(contextSourceTasks, (task) => task.tags, 12, { prefix: '#' }),
      ...getUsedTaskTokens(contextSourceTasks, (task) => task.tags, { prefix: '#' }),
    ])),
    [contextSourceTasks]
  );
  const addContextOptions = useMemo(
    () => Array.from(new Set([
      ...getFrequentTaskTokens(contextSourceTasks, (task) => task.contexts, 12, { prefix: '@' }),
      ...getUsedTaskTokens(contextSourceTasks, (task) => task.contexts, { prefix: '@' }),
    ])),
    [contextSourceTasks]
  );
  const tasksById = useMemo(
    () => tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>),
    [tasks],
  );

  const activeTasks = contextSourceTasks;
  const hasContext = taskHasContextOrTag;
  const matchesSelected = taskMatchesContextOrTagFilter;
  const noContextSelected = selectedContexts.includes(NO_CONTEXT_TOKEN);
  const filteredTasks = noContextSelected
    ? activeTasks.filter((t) => !hasContext(t))
    : selectedContexts.length > 0
      ? activeTasks.filter((t) => selectedContexts.every((ctx) => matchesSelected(t, ctx)))
      : activeTasks;

  const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
  const sortedTasks = sortTasksBy(filteredTasks, sortBy);
  const restoreActionLabel = tFallback(t, 'trash.restoreToInbox', 'Restore');
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
    restoreActionLabel,
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
  const focusToken = useCallback((token: string) => setSelectedContexts([token]), []);

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

  const removeTagLabelRaw = t('bulk.removeTag');
  const removeTagLabel = removeTagLabelRaw === 'bulk.removeTag' ? 'Remove tag' : removeTagLabelRaw;
  const tokenPickerTitle = (() => {
    if (!bulkTokenPicker) return '';
    if (bulkTokenPicker.field === 'tags') {
      return bulkTokenPicker.action === 'add' ? t('bulk.addTag') : removeTagLabel;
    }
    return bulkTokenPicker.action === 'add' ? t('bulk.addContext') : t('bulk.removeContext');
  })();
  const tokenPickerOptions = (() => {
    if (!bulkTokenPicker) return [] as string[];
    if (bulkTokenPicker.field === 'tags') {
      return bulkTokenPicker.action === 'add' ? addTagOptions : removableTagOptions;
    }
    return bulkTokenPicker.action === 'add' ? addContextOptions : removableContextOptions;
  })();
  const tokenPickerPlaceholder = bulkTokenPicker?.field === 'tags'
    ? t('taskEdit.tagsPlaceholder')
    : t('taskEdit.contextsPlaceholder');

  const handleBulkTokenConfirm = async (values: string[]) => {
    if (!bulkTokenPicker || !hasSelection) return;
    await runBulkAction(tokenPickerTitle, async () => {
      const updates = buildBulkTaskTokenUpdates(
        selectedIdsArray,
        tasksById,
        bulkTokenPicker.field,
        values,
        bulkTokenPicker.action
      );
      setBulkTokenPicker(null);
      if (updates.length === 0) return;
      assertBulkActionSucceeded(await batchUpdateTasks(updates));
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: `${selectedIdsArray.length} ${t('common.tasks')}`,
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
              onPress={() => setSelectedContexts([])}
            >
              <Text
                style={[
                  styles.contextButtonText,
                  { color: selectedContexts.length === 0 ? tc.onTint : tc.text },
                ]}
              >
                {t('contexts.all')}
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
                  {activeTasks.length}
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
              onPress={() => setSelectedContexts(noContextSelected ? [] : [NO_CONTEXT_TOKEN])}
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
                  {activeTasks.filter((t) => !hasContext(t)).length}
                </Text>
              </View>
            </Pressable>
          </ScrollView>

          {filterSections.map((section) => (
            <View key={section.kind} style={styles.contextFilterSection}>
              <Text style={[styles.contextFilterSectionLabel, { color: tc.secondaryText }]}>
                {section.kind === 'contexts' ? t('contexts.title') : t('tags.title')}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.contextsBar}
                contentContainerStyle={styles.contextsBarContent}
              >
                {section.tokens.map((context) => {
                  const count = activeTasks.filter((t) => matchesSelected(t, context)).length;
                  const isActive = selectedContexts.includes(context);
                  return (
                    <Pressable
                      key={context}
                      style={[
                        styles.contextButton,
                        { backgroundColor: isActive ? tc.tint : tc.filterBg, borderColor: tc.border },
                      ]}
                      onPress={() => setSelectedContexts((prev) => {
                        if (prev.includes(NO_CONTEXT_TOKEN)) {
                          return [context];
                        }
                        return prev.includes(context) ? prev.filter((item) => item !== context) : [...prev, context];
                      })}
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
            </View>
          ))}
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
                {(['inbox', 'next', 'waiting', 'someday', 'done', 'reference'] as TaskStatus[]).map((status) => (
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
                {allFilterTokens.length === 0 ? (
                  <>
                    <Tag size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                    <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('contexts.noContexts').split('.')[0]}</Text>
                    <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                      {t('contexts.noContexts')}
                    </Text>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                    <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('contexts.noTasks')}</Text>
                    <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                      {selectedContexts.length > 0
                        ? `${t('contexts.noTasks')} ${selectedContexts.join(', ')}`
                        : t('contexts.noTasks')}
                    </Text>
                  </>
                )}
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
  contextFilterSection: {
    gap: 2,
  },
  contextFilterSectionLabel: {
    paddingHorizontal: 12,
    paddingTop: 6,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  contextsBar: {
    maxHeight: 48,
  },
  contextsBarContent: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
    alignItems: 'center',
  },
  contextButton: {
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
