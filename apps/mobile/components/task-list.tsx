import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, TextInput, FlatList, StyleSheet, TouchableOpacity, Text, RefreshControl, ScrollView, Modal, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import {
  useTaskStore,
  Task,
  TaskStatus,
  sortTasksBy,
  parseQuickAdd,
  safeParseDate,
  PRESET_CONTEXTS,
  PRESET_TAGS,
  createAIProvider,
  type AIProviderId,
  type TaskSortBy,
} from '@mindwtr/core';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';

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
  enableReorder?: boolean;
  staticList?: boolean;
  reorderMode?: boolean;
  onEnterReorderMode?: () => void;
  onReorderActiveChange?: (active: boolean) => void;
  enableBulkActions?: boolean;
  showSort?: boolean;
  showQuickAddHelp?: boolean;
  emptyText?: string;
  headerAccessory?: React.ReactNode;
  enableCopilot?: boolean;
  defaultEditTab?: 'task' | 'view';
  scrollEnabled?: boolean;
}

// ... inside TaskList component
export function TaskList({
  statusFilter,
  title,
  showHeader = true,
  allowAdd = true,
  projectId,
  enableReorder = false,
  staticList = false,
  reorderMode = false,
  onEnterReorderMode,
  onReorderActiveChange,
  enableBulkActions = true,
  showSort = true,
  showQuickAddHelp = true,
  emptyText,
  headerAccessory,
  enableCopilot = true,
  defaultEditTab,
  scrollEnabled = true,
}: TaskListProps) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { tasks, projects, addTask, addProject, updateTask, deleteTask, fetchData, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, reorderProjectTasks, settings, updateSettings, highlightTaskId, setHighlightTask } = useTaskStore();
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: Task['timeEstimate']; tags?: string[] } | null>(null);
  const [copilotApplied, setCopilotApplied] = useState(false);
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [inputSelection, setInputSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copilotAbortRef = useRef<AbortController | null>(null);

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
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const timeEstimatesEnabled = settings?.features?.timeEstimates === true;

  // Memoize filtered and sorted tasks for performance
  const filteredTasks = useMemo(() => {
    const now = new Date();
    const filtered = tasks.filter(t => {
      // Filter out soft-deleted tasks
      if (t.deletedAt) return false;
      const matchesStatus = statusFilter === 'all' ? true : t.status === statusFilter;
      const matchesProject = projectId ? t.projectId === projectId : true;
      if (statusFilter === 'inbox') {
        const start = safeParseDate(t.startTime);
        if (start && start > now) return false;
      }
      return matchesStatus && matchesProject;
    });
    return filtered;
  }, [tasks, statusFilter, projectId, sortBy]);

  const orderedTasks = useMemo(() => {
    if (enableReorder && projectId) {
      const list = [...filteredTasks];
      const hasOrder = list.some((task) => Number.isFinite(task.orderNum));
      list.sort((a, b) => {
        if (hasOrder) {
          const aOrder = Number.isFinite(a.orderNum) ? (a.orderNum as number) : Number.POSITIVE_INFINITY;
          const bOrder = Number.isFinite(b.orderNum) ? (b.orderNum as number) : Number.POSITIVE_INFINITY;
          if (aOrder !== bOrder) return aOrder - bOrder;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      return list;
    }
    return sortTasksBy(filteredTasks, sortBy);
  }, [enableReorder, projectId, filteredTasks, sortBy]);

  const contextOptions = useMemo(() => {
    const taskContexts = tasks.flatMap((task) => task.contexts || []);
    return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).filter(Boolean);
  }, [tasks]);
  const tagOptions = useMemo(() => {
    const taskTags = tasks.flatMap((task) => task.tags || []);
    return Array.from(new Set([...PRESET_TAGS, ...taskTags])).filter(Boolean);
  }, [tasks]);

  type TriggerType = 'project' | 'context';
  type TriggerState = { type: TriggerType; start: number; end: number; query: string };
  type Option =
    | { kind: 'create'; label: string; value: string }
    | { kind: 'project'; label: string; value: string }
    | { kind: 'context'; label: string; value: string };

  const getTrigger = useCallback((text: string, caret: number): TriggerState | null => {
    if (caret < 0) return null;
    const before = text.slice(0, caret);
    const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'));
    const start = lastSpace + 1;
    const token = before.slice(start);
    if (!token.startsWith('+') && !token.startsWith('@')) return null;
    return {
      type: token.startsWith('+') ? 'project' : 'context',
      start,
      end: caret,
      query: token.slice(1),
    };
  }, []);

  const trigger = useMemo(() => {
    return getTrigger(newTaskTitle, inputSelection.start ?? newTaskTitle.length);
  }, [getTrigger, inputSelection.start, newTaskTitle]);

  const typeaheadOptions = useMemo<Option[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    if (trigger.type === 'project') {
      const matches = projects.filter((project) => project.title.toLowerCase().includes(query));
      const hasExact = query.length > 0 && projects.some((project) => project.title.toLowerCase() === query);
      const result: Option[] = [];
      if (!hasExact && query.length > 0) {
        result.push({
          kind: 'create' as const,
          label: `Create \"${trigger.query.trim()}\"`,
          value: trigger.query.trim(),
        });
      }
      result.push(
        ...matches.map((project) => ({
          kind: 'project' as const,
          label: project.title,
          value: project.title,
        }))
      );
      return result;
    }
    const matches = contextOptions.filter((context) => {
      const raw = context.startsWith('@') || context.startsWith('#') ? context.slice(1) : context;
      return raw.toLowerCase().includes(query);
    });
    return matches.map((context) => ({
      kind: 'context' as const,
      label: context,
      value: context,
    }));
  }, [contextOptions, projects, trigger]);

  useEffect(() => {
    if (!trigger || typeaheadOptions.length === 0) {
      setTypeaheadOpen(false);
      return;
    }
    setTypeaheadOpen(true);
  }, [trigger, typeaheadOptions.length]);

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
        if (copilotAbortRef.current) copilotAbortRef.current.abort();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        copilotAbortRef.current = abortController;
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
        const suggestion = await provider.predictMetadata(
          { title, contexts: contextOptions, tags: tagOptions },
          abortController ? { signal: abortController.signal } : undefined
        );
        if (cancelled) return;
        if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate) && !suggestion.tags?.length) {
          setCopilotSuggestion(null);
        } else {
          setCopilotSuggestion(suggestion);
        }
      } catch {
        if (!cancelled) {
          setCopilotSuggestion(null);
        }
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      if (copilotAbortRef.current) {
        copilotAbortRef.current.abort();
        copilotAbortRef.current = null;
      }
    };
  }, [aiEnabled, aiKey, aiProvider, contextOptions, enableCopilot, newTaskTitle, settings, statusFilter, tagOptions, timeEstimatesEnabled]);

  useEffect(() => {
    if (!highlightTaskId) return;
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTask(null);
    }, 3500);
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, [highlightTaskId, setHighlightTask]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;

    const defaultStatus: TaskStatus = projectId
      ? 'next'
      : (statusFilter !== 'all' ? statusFilter : 'inbox');

    const { title: parsedTitle, props, projectTitle } = parseQuickAdd(newTaskTitle, projects);
    const finalTitle = parsedTitle || newTaskTitle;
    if (!finalTitle.trim()) return;

    const initialProps: Partial<Task> = { projectId, status: defaultStatus, ...props };
    if (!props.status) initialProps.status = defaultStatus;
    if (!props.projectId && projectId) initialProps.projectId = projectId;
    if (!initialProps.projectId && projectTitle) {
      const created = await addProject(projectTitle, '#94a3b8');
      initialProps.projectId = created.id;
    }
    if (copilotContext) {
      const nextContexts = Array.from(new Set([...(initialProps.contexts ?? []), copilotContext]));
      initialProps.contexts = nextContexts;
    }
    if (copilotTags.length) {
      const nextTags = Array.from(new Set([...(initialProps.tags ?? []), ...copilotTags]));
      initialProps.tags = nextTags;
    }

    await addTask(finalTitle, initialProps);
    setNewTaskTitle('');
    setTypeaheadOpen(false);
    setCopilotSuggestion(null);
    setCopilotApplied(false);
    setCopilotContext(undefined);
    setCopilotTags([]);
  };

  const applyTypeaheadOption = useCallback(async (option: Option) => {
    if (!trigger) return;
    let tokenValue = option.value;
    if (option.kind === 'create') {
      const title = option.value.trim();
      if (title) {
        await addProject(title, '#94a3b8');
      }
    }
    if (trigger.type === 'project') {
      tokenValue = `+${tokenValue}`;
    } else {
      tokenValue = tokenValue.startsWith('@') ? tokenValue : `@${tokenValue}`;
    }
    const before = newTaskTitle.slice(0, trigger.start);
    const after = newTaskTitle.slice(trigger.end);
    const needsSpace = after.length > 0 && !/^\s/.test(after);
    const nextValue = `${before}${tokenValue}${needsSpace ? ' ' : ''}${after}`;
    setNewTaskTitle(nextValue);
    const caret = before.length + tokenValue.length + (needsSpace ? 1 : 0);
    setInputSelection({ start: caret, end: caret });
    setTypeaheadOpen(false);
    setTypeaheadIndex(0);
  }, [addProject, newTaskTitle, trigger]);

  const handleEditTask = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
    setIsModalVisible(false);
    setEditingTask(null);
  }, [updateTask]);

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
    Alert.alert(t('common.done'), `${selectedIdsArray.length} ${t('common.tasks')}`);
  }, [batchMoveTasks, selectedIdsArray, hasSelection, exitSelectionMode, t]);

  const handleBatchDelete = useCallback(async () => {
    if (!hasSelection) return;
    await batchDeleteTasks(selectedIdsArray);
    exitSelectionMode();
    Alert.alert(t('common.done'), `${selectedIdsArray.length} ${t('common.tasks')}`);
  }, [batchDeleteTasks, selectedIdsArray, hasSelection, exitSelectionMode, t]);

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
    Alert.alert(t('common.done'), `${selectedIdsArray.length} ${t('common.tasks')}`);
  }, [batchUpdateTasks, selectedIdsArray, tasksById, tagInput, hasSelection, exitSelectionMode, t]);

  const sortOptions: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];
  const hideStatusBadgeForList = statusFilter === 'next' || statusFilter === 'waiting';

  const renderTask = useCallback(({ item }: { item: Task }) => (
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
      isHighlighted={item.id === highlightTaskId}
      onLongPressAction={enableReorder && !reorderMode ? onEnterReorderMode : undefined}
      disableSwipe={reorderMode}
      showDragHandle={reorderMode}
      hideStatusBadge={reorderMode || hideStatusBadgeForList}
    />
  ), [
    deleteTask,
    enableBulkActions,
    handleEditTask,
    highlightTaskId,
    isDark,
    multiSelectedIds,
    onEnterReorderMode,
    selectionMode,
    enableReorder,
    reorderMode,
    hideStatusBadgeForList,
    themeColors,
    toggleMultiSelect,
    updateTask,
  ]);

  const renderDraggableTask = useCallback(({ item, drag, isActive }: RenderItemParams<Task>) => (
    <View style={{ opacity: isActive ? 0.7 : 1 }}>
      <SwipeableTaskItem
        task={item}
        isDark={isDark}
        tc={themeColors}
        onPress={() => handleEditTask(item)}
        onDragHandlePress={() => {
          onReorderActiveChange?.(true);
          drag();
        }}
        selectionMode={false}
        onStatusChange={(status) => updateTask(item.id, { status: status as TaskStatus })}
        onDelete={() => deleteTask(item.id)}
        isHighlighted={item.id === highlightTaskId}
        disableSwipe
        showDragHandle
        hideStatusBadge
      />
    </View>
  ), [deleteTask, handleEditTask, highlightTaskId, isDark, onReorderActiveChange, themeColors, updateTask]);

  return (
    <View style={[styles.container, { backgroundColor: themeColors.bg }]}>
      {showHeader ? (
        <View style={[styles.header, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <View style={styles.headerTopRow}>
            <Text style={[styles.title, { color: themeColors.text }]} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.count, { color: themeColors.secondaryText }]} accessibilityLabel={`${orderedTasks.length} tasks`}>
              {orderedTasks.length} {t('common.tasks')}
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
                setInputSelection({ start: text.length, end: text.length });
                setTypeaheadIndex(0);
                setCopilotApplied(false);
                setCopilotContext(undefined);
                setCopilotTags([]);
              }}
              onSelectionChange={(event) => {
                const selection = event.nativeEvent.selection;
                setInputSelection(selection);
                setTypeaheadOpen(Boolean(getTrigger(newTaskTitle, selection.start ?? newTaskTitle.length)));
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
          {typeaheadOpen && trigger && typeaheadOptions.length > 0 && (
            <View style={[styles.typeaheadContainer, { backgroundColor: themeColors.cardBg, borderColor: themeColors.border }]}>
              {typeaheadOptions.map((option, index) => (
                <TouchableOpacity
                  key={`${option.kind}-${option.value}-${index}`}
                  onPress={() => applyTypeaheadOption(option)}
                  style={[
                    styles.typeaheadRow,
                    index === typeaheadIndex && { backgroundColor: themeColors.filterBg },
                  ]}
                >
                  <Text style={[styles.typeaheadText, { color: themeColors.text }]}>
                    {option.kind === 'create' ? `✨ ${option.label}` : option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {enableCopilot && aiEnabled && copilotSuggestion && !copilotApplied && (
            <TouchableOpacity
              style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}
              onPress={() => {
                setCopilotContext(copilotSuggestion.context);
                setCopilotTags(copilotSuggestion.tags ?? []);
                setCopilotApplied(true);
              }}
            >
              <Text style={[styles.copilotText, { color: themeColors.text }]}>
                ✨ {t('copilot.suggested')}{' '}
                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
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
                {copilotTags.length ? copilotTags.join(' ') : ''}
              </Text>
            </View>
          )}
          {showQuickAddHelp && !projectId && (
            <Text style={[styles.quickAddHelp, { color: themeColors.secondaryText }]}>
              {t('quickAdd.help')}
            </Text>
          )}
        </>
      )}

      {enableReorder && projectId && reorderMode ? (
        <DraggableFlatList
          data={orderedTasks}
          renderItem={renderDraggableTask}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          activationDistance={12}
          scrollEnabled={scrollEnabled}
          onDragBegin={() => onReorderActiveChange?.(true)}
          onDragEnd={({ data }) => {
            reorderProjectTasks(projectId, data.map((task) => task.id));
            onReorderActiveChange?.(false);
          }}
          onDragCancel={() => onReorderActiveChange?.(false)}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: themeColors.secondaryText }]}>
                {emptyText || t('list.noTasks')}
              </Text>
            </View>
          }
        />
      ) : staticList ? (
        <View style={styles.staticList}>
          {orderedTasks.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: themeColors.secondaryText }]}>
                {emptyText || t('list.noTasks')}
              </Text>
            </View>
          ) : (
            orderedTasks.map((item) => (
              <View key={item.id} style={styles.staticItem}>
                {renderTask({ item })}
              </View>
            ))
          )}
        </View>
      ) : (
        <FlatList
          data={orderedTasks}
          renderItem={renderTask}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          scrollEnabled={scrollEnabled}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
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
      )}

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
        defaultTab={defaultEditTab}
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
  typeaheadContainer: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  typeaheadRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  typeaheadText: {
    fontSize: 13,
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
  staticList: {
    flex: 1,
  },
  staticItem: {
    marginBottom: 0,
  },
  listContent: {
    padding: 12,
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
