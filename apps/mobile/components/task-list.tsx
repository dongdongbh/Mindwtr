import React, { useState, useMemo, useCallback } from 'react';
import { View, TextInput, FlatList, StyleSheet, TouchableOpacity, Text, RefreshControl, ScrollView, Modal, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useTaskStore, Task, TaskStatus, sortTasksBy, parseQuickAdd, isTaskBlocked } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';


import { TaskEditModal } from './task-edit-modal';
import { SwipeableTaskItem } from './swipeable-task-item';
import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';

export interface TaskListProps {
  statusFilter: TaskStatus | 'all';
  title: string;
  allowAdd?: boolean;
  projectId?: string;
}

// ... inside TaskList component
export function TaskList({ statusFilter, title, allowAdd = true, projectId }: TaskListProps) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { tasks, projects, addTask, updateTask, deleteTask, fetchData, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, settings, updateSettings } = useTaskStore();
  const [newTaskTitle, setNewTaskTitle] = useState('');
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

  // Memoize filtered and sorted tasks for performance
  const filteredTasks = useMemo(() => {
    const filtered = tasks.filter(t => {
      // Filter out soft-deleted tasks
      if (t.deletedAt) return false;
      const matchesStatus = statusFilter === 'all' ? true : t.status === statusFilter;
      const matchesProject = projectId ? t.projectId === projectId : true;
      if (statusFilter === 'next' && isTaskBlocked(t, tasksById)) return false;
      return matchesStatus && matchesProject;
    });
    return sortTasksBy(filtered, sortBy);
  }, [tasks, statusFilter, projectId, tasksById, sortBy]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleAddTask = () => {
    if (!newTaskTitle.trim()) return;

    const defaultStatus: TaskStatus = projectId
      ? 'todo'
      : (statusFilter !== 'all' ? statusFilter : 'inbox');

    const { title: parsedTitle, props } = parseQuickAdd(newTaskTitle, projects);
    const finalTitle = parsedTitle || newTaskTitle;
    if (!finalTitle.trim()) return;

    const initialProps: Partial<Task> = { projectId, status: defaultStatus, ...props };
    if (!props.status) initialProps.status = defaultStatus;
    if (!props.projectId && projectId) initialProps.projectId = projectId;

    addTask(finalTitle, initialProps);
    setNewTaskTitle('');
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
    setMultiSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

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
      selectionMode={selectionMode}
      isMultiSelected={multiSelectedIds.has(item.id)}
      onToggleSelect={() => toggleMultiSelect(item.id)}
      onStatusChange={(status) => updateTask(item.id, { status: status as TaskStatus })}
      onDelete={() => deleteTask(item.id)}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: themeColors.bg }]}>
      <View style={[styles.header, { borderBottomColor: themeColors.border }]}>
        <Text style={[styles.title, { color: themeColors.text }]} accessibilityRole="header">{title}</Text>
        <View style={styles.headerActions}>
          <Text style={[styles.count, { color: themeColors.secondaryText }]} accessibilityLabel={`${filteredTasks.length} tasks`}>
            {filteredTasks.length} {t('common.tasks')}
          </Text>
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
        </View>
      </View>

      {selectionMode && (
        <View style={[styles.bulkBar, { backgroundColor: themeColors.cardBg, borderBottomColor: themeColors.border }]}>
          <Text style={[styles.bulkCount, { color: themeColors.secondaryText }]}>
            {selectedIdsArray.length} {t('bulk.selected')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkMoveRow}>
            {(['inbox', 'todo', 'next', 'in-progress', 'waiting', 'someday', 'done', 'archived'] as TaskStatus[]).map((status) => (
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
              onChangeText={setNewTaskTitle}
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
          <Text style={[styles.quickAddHelp, { color: themeColors.secondaryText }]}>
            {t('quickAdd.help')}
          </Text>
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
            <Text style={styles.emptyText}>
              {t('list.noTasks')}
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  count: {
    fontSize: 14,
    color: '#666',
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
