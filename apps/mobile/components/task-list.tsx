import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { View, TextInput, FlatList, StyleSheet, TouchableOpacity, Text, RefreshControl, ScrollView, Modal, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useTaskStore, Task, TaskStatus, sortTasksBy, parseQuickAdd, isTaskBlocked, safeParseDate, PRESET_CONTEXTS, createAIProvider } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';


import { TaskEditModal } from './task-edit-modal';
import { SwipeableTaskItem } from './swipeable-task-item';
import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { buildCopilotConfig, loadAIKey } from '../lib/ai-config';

export interface TaskListProps {
  statusFilter: TaskStatus | 'all';
  title: string;
  showHeader?: boolean;
  allowAdd?: boolean;
  projectId?: string;
  enableBulkActions?: boolean;
  showSort?: boolean;
  showQuickAddHelp?: boolean;
  emptyText?: string;
  headerAccessory?: React.ReactNode;
  enableCopilot?: boolean;
}

// ... inside TaskList component
export function TaskList({
  statusFilter,
  title,
  showHeader = true,
  allowAdd = true,
  projectId,
  enableBulkActions = true,
  showSort = true,
  showQuickAddHelp = true,
  emptyText,
  headerAccessory,
  enableCopilot = true,
}: TaskListProps) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { tasks, projects, addTask, updateTask, deleteTask, fetchData, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, settings, updateSettings } = useTaskStore();
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: Task['timeEstimate'] } | null>(null);
  const [copilotApplied, setCopilotApplied] = useState(false);
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotEstimate, setCopilotEstimate] = useState<Task['timeEstimate'] | undefined>(undefined);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [sortModalVisible, setSortModalVisible] = useState(false);

  // Dynamic colors based on theme
  const themeColors = useThemeColors();

  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);

  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as 'openai' | 'gemini';

  // Memoize filtered and sorted tasks for performance
  const filteredTasks = useMemo(() => {
    const now = new Date();
    const filtered = tasks.filter(t => {
      // Filter out soft-deleted tasks
      if (t.deletedAt) return false;
      const matchesStatus = statusFilter === 'all' ? true : t.status === statusFilter;
      const matchesProject = projectId ? t.projectId === projectId : true;
      if (statusFilter === 'next' && isTaskBlocked(t, tasksById)) return false;
      if (statusFilter === 'inbox') {
        const start = safeParseDate(t.startTime);
        if (start && start > now) return false;
      }
      return matchesStatus && matchesProject;
    });
    return sortTasksBy(filtered, sortBy);
  }, [tasks, statusFilter, projectId, tasksById, sortBy]);

  const contextOptions = useMemo(() => {
    const taskContexts = tasks.flatMap((task) => task.contexts || []);
    return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).filter(Boolean);
  }, [tasks]);

  useEffect(() => {
    loadAIKey(aiProvider).then(setAiKey).catch(console.error);
  }, [aiProvider]);

  useEffect(() => {
    if (!enableCopilot || !aiEnabled || !aiKey) {
      setCopilotSuggestion(null);
      return;
    }
    const title = newTaskTitle.trim();
    if (title.length < 4) {
      setCopilotSuggestion(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
        const suggestion = await provider.predictMetadata({ title, contexts: contextOptions });
        if (cancelled) return;
        if (!suggestion.context && !suggestion.timeEstimate) {
          setCopilotSuggestion(null);
        } else {
          setCopilotSuggestion(suggestion);
        }
      } catch (error) {
        if (!cancelled) {
          setCopilotSuggestion(null);
        }
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [aiEnabled, aiKey, aiProvider, contextOptions, enableCopilot, newTaskTitle, settings, statusFilter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleAddTask = () => {
    if (!newTaskTitle.trim()) return;

    const defaultStatus: TaskStatus = projectId
      ? 'next'
      : (statusFilter !== 'all' ? statusFilter : 'inbox');

    const { title: parsedTitle, props } = parseQuickAdd(newTaskTitle, projects);
    const finalTitle = parsedTitle || newTaskTitle;
    if (!finalTitle.trim()) return;

    const initialProps: Partial<Task> = { projectId, status: defaultStatus, ...props };
    if (!props.status) initialProps.status = defaultStatus;
    if (!props.projectId && projectId) initialProps.projectId = projectId;
    if (copilotContext) {
      const nextContexts = Array.from(new Set([...(initialProps.contexts ?? []), copilotContext]));
      initialProps.contexts = nextContexts;
    }
    if (copilotEstimate && !props.timeEstimate) {
      initialProps.timeEstimate = copilotEstimate;
    }

    addTask(finalTitle, initialProps);
    setNewTaskTitle('');
    setCopilotSuggestion(null);
    setCopilotApplied(false);
    setCopilotContext(undefined);
    setCopilotEstimate(undefined);
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  };

  const onSaveTask = (taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
    setIsModalVisible(false);
    setEditingTask(null);
  };

  const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
  const hasSelection = selectedIdsArray.length > 0;

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setMultiSelectedIds(new Set());
  }, []);

  const toggleMultiSelect = useCallback((taskId: string) => {
    if (!selectionMode) setSelectionMode(true);
    setMultiSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [selectionMode]);

  const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
    if (!hasSelection) return;
    await batchMoveTasks(selectedIdsArray, newStatus);
    exitSelectionMode();
  }, [batchMoveTasks, selectedIdsArray, hasSelection, exitSelectionMode]);

  const handleBatchDelete = useCallback(async () => {
    if (!hasSelection) return;
    await batchDeleteTasks(selectedIdsArray);
    exitSelectionMode();
  }, [batchDeleteTasks, selectedIdsArray, hasSelection, exitSelectionMode]);

  const handleBatchAddTag = useCallback(async () => {
    const input = tagInput.trim();
    if (!hasSelection || !input) return;
    const tag = input.startsWith('#') ? input : `#${input}`;
    await batchUpdateTasks(selectedIdsArray.map((id) => {
      const task = tasksById[id];
      const existingTags = task?.tags || [];
      const nextTags = Array.from(new Set([...existingTags, tag]));
      return { id, updates: { tags: nextTags } };
    }));
    setTagInput('');
    setTagModalVisible(false);
    exitSelectionMode();
  }, [batchUpdateTasks, selectedIdsArray, tasksById, tagInput, hasSelection, exitSelectionMode]);

  const sortOptions: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];

  const renderTask = ({ item }: { item: Task }) => (
    <SwipeableTaskItem
      task={item}
      isDark={isDark}
      tc={themeColors}
      onPress={() => handleEditTask(item)}
      selectionMode={enableBulkActions ? selectionMode : false}
      isMultiSelected={enableBulkActions && multiSelectedIds.has(item.id)}
      onToggleSelect={enableBulkActions ? () => toggleMultiSelect(item.id) : undefined}
      onStatusChange={(status) => updateTask(item.id, { status: status as TaskStatus })}
      onDelete={() => deleteTask(item.id)}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: themeColors.bg }]}>
      {showHeader ? (
        <View style={[styles.header, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <View style={styles.headerTopRow}>
            <Text style={[styles.title, { color: themeColors.text }]} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.count, { color: themeColors.secondaryText }]} accessibilityLabel={`${filteredTasks.length} tasks`}>
              {filteredTasks.length} {t('common.tasks')}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {showSort && (
              <TouchableOpacity
                onPress={() => setSortModalVisible(true)}
                style={[styles.sortButton, { borderColor: themeColors.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('sort.label')}
              >
                <Text style={[styles.sortButtonText, { color: themeColors.secondaryText }]}>
                  {t(`sort.${sortBy}`)}
                </Text>
              </TouchableOpacity>
            )}
            {headerAccessory}
            {enableBulkActions && (
              <TouchableOpacity
                onPress={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                style={[
                  styles.selectButton,
                  { borderColor: themeColors.border, backgroundColor: selectionMode ? themeColors.filterBg : 'transparent' }
                ]}
                accessibilityRole="button"
                accessibilityLabel={selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
              >
                <Text style={[styles.selectButtonText, { color: themeColors.text }]}>
                  {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ) : headerAccessory ? (
        <View style={styles.headerAccessoryRow}>{headerAccessory}</View>
      ) : null}

      {enableBulkActions && selectionMode && (
        <View style={[styles.bulkBar, { backgroundColor: themeColors.cardBg, borderBottomColor: themeColors.border }]}>
          <Text style={[styles.bulkCount, { color: themeColors.secondaryText }]}>
            {selectedIdsArray.length} {t('bulk.selected')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkMoveRow}>
            {(['inbox', 'next', 'waiting', 'someday', 'done'] as TaskStatus[]).map((status) => (
              <TouchableOpacity
                key={status}
                onPress={() => handleBatchMove(status)}
                disabled={!hasSelection}
                style={[styles.bulkMoveButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
              >
                <Text style={[styles.bulkMoveText, { color: themeColors.text }]}>{t(`status.${status}`)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.bulkActions}>
            <TouchableOpacity
              onPress={() => setTagModalVisible(true)}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('bulk.addTag')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleBatchDelete}
              disabled={!hasSelection}
              style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection ? 1 : 0.5 }]}
            >
              <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('bulk.delete')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {allowAdd && (
        <>
          <View style={[styles.inputContainer, { borderBottomColor: themeColors.border }]}>
            <TextInput
              style={[styles.input, { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text }]}
              placeholder={t('inbox.addPlaceholder')}
              placeholderTextColor={themeColors.secondaryText}
              value={newTaskTitle}
              onChangeText={(text) => {
                setNewTaskTitle(text);
                setCopilotApplied(false);
                setCopilotContext(undefined);
                setCopilotEstimate(undefined);
              }}
              onSubmitEditing={handleAddTask}
              returnKeyType="done"
              accessibilityLabel={`Input new task for ${title}`}
              accessibilityHint="Type task title, then tap add button or enter"
            />
            <TouchableOpacity
              onPress={handleAddTask}
              style={[
                styles.addButton,
                { backgroundColor: themeColors.tint },
                !newTaskTitle.trim() && styles.addButtonDisabled
              ]}
              disabled={!newTaskTitle.trim()}
              accessibilityLabel="Add Task"
              accessibilityRole="button"
              accessibilityState={{ disabled: !newTaskTitle.trim() }}
            >
              <Text style={styles.addButtonText}>+</Text>
            </TouchableOpacity>
          </View>
          {enableCopilot && aiEnabled && copilotSuggestion && !copilotApplied && (
            <TouchableOpacity
              style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}
              onPress={() => {
                setCopilotContext(copilotSuggestion.context);
                setCopilotEstimate(copilotSuggestion.timeEstimate);
                setCopilotApplied(true);
              }}
            >
              <Text style={[styles.copilotText, { color: themeColors.text }]}>
                ✨ {t('copilot.suggested')}{' '}
                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                {copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
              </Text>
              <Text style={[styles.copilotHint, { color: themeColors.secondaryText }]}>
                {t('copilot.applyHint')}
              </Text>
            </TouchableOpacity>
          )}
          {enableCopilot && aiEnabled && copilotApplied && (
            <View style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
              <Text style={[styles.copilotText, { color: themeColors.text }]}>
                ✅ {t('copilot.applied')}{' '}
                {copilotContext ? `${copilotContext} ` : ''}
                {copilotEstimate ? `${copilotEstimate}` : ''}
              </Text>
            </View>
          )}
          {showQuickAddHelp && (
            <Text style={[styles.quickAddHelp, { color: themeColors.secondaryText }]}>
              {t('quickAdd.help')}
            </Text>
          )}
        </>
      )}

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: themeColors.secondaryText }]}>
              {emptyText || t('list.noTasks')}
            </Text>
          </View>
        }
      />

      <Modal
        visible={tagModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTagModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setTagModalVisible(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: themeColors.cardBg }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('bulk.addTag')}</Text>
            <TextInput
              value={tagInput}
              onChangeText={setTagInput}
              placeholder="#tag"
              placeholderTextColor={themeColors.secondaryText}
              style={[
                styles.modalInput,
                { backgroundColor: themeColors.inputBg, color: themeColors.text, borderColor: themeColors.border }
              ]}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={() => {
                  setTagModalVisible(false);
                  setTagInput('');
                }}
                style={styles.modalButton}
              >
                <Text style={[styles.modalButtonText, { color: themeColors.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleBatchAddTag}
                disabled={!tagInput.trim()}
                style={[styles.modalButton, !tagInput.trim() && styles.modalButtonDisabled]}
              >
                <Text style={[styles.modalButtonText, { color: themeColors.tint }]}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={sortModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSortModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setSortModalVisible(false)}>
          <View style={[styles.modalCard, { backgroundColor: themeColors.cardBg }]}>
            <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('sort.label')}</Text>
            <View style={styles.sortList}>
              {sortOptions.map((option) => (
                <Pressable
                  key={option}
                  onPress={() => {
                    updateSettings({ taskSortBy: option });
                    setSortModalVisible(false);
                  }}
                  style={[
                    styles.sortItem,
                    option === sortBy && { backgroundColor: themeColors.filterBg }
                  ]}
                >
                  <Text style={[styles.sortItemText, { color: themeColors.text }]}>
                    {t(`sort.${option}`)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>

      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={onSaveTask}
        onFocusMode={(taskId) => {
          setIsModalVisible(false);
          router.push(`/check-focus?id=${taskId}`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 22,
    fontWeight: '700',
  },
  count: {
    fontSize: 13,
    fontWeight: '500',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 10,
  },
  headerAccessoryRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    alignItems: 'flex-end',
  },
  sortButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sortButtonText: {
    fontSize: 12,
  },
  selectButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selectButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  bulkCount: {
    fontSize: 12,
    fontWeight: '600',
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
  sortList: {
    gap: 6,
  },
  sortItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  sortItemText: {
    fontSize: 14,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
  copilotPill: {
    marginTop: 8,
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  copilotText: {
    fontSize: 12,
    fontWeight: '600',
  },
  copilotHint: {
    fontSize: 11,
    marginTop: 2,
  },
  addButton: {
    width: 44,
    height: 44,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  quickAddHelp: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
  },
  taskItem: {
    flexDirection: 'row',
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    alignItems: 'center',
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  taskDescription: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  taskMeta: {
    fontSize: 12,
    color: '#666',
  },
  deleteButton: {
    display: 'none', // Hidden in favor of swipe
  },
  deleteAction: {
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  promoteAction: {
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  actionText: {
    color: '#fff',
    fontWeight: '600',
    padding: 20,
  },
  emptyContainer: {
    padding: 48,
    alignItems: 'center',
  },
  emptyText: {
    color: '#999',
    fontSize: 16,
  },
  badgeContainer: {
    justifyContent: 'center',
    paddingLeft: 8,
  },
  searchInput: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    fontSize: 16,
    backgroundColor: '#f9f9f9',
  },
});
