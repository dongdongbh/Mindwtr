import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import {
  useTaskStore,
  getUsedTaskTokens,
  getFrequentTaskTokens,
  sortTasksBy,
  matchesHierarchicalToken,
  buildBulkTaskTokenUpdates,
  collectBulkTaskTokens,
  type Task,
  type TaskSortBy,
  type TaskStatus,
} from '@mindwtr/core';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { openProjectScreen } from '@/lib/task-meta-navigation';
import { useToast } from '@/contexts/toast-context';
import { TaskEditModal } from '../task-edit-modal';
import { TokenPickerModal } from '../token-picker-modal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableTaskItem } from '../swipeable-task-item';
import { Tag, CheckCircle2 } from 'lucide-react-native';

type BulkTokenPickerState = {
  field: 'tags' | 'contexts';
  action: 'add' | 'remove';
} | null;

export function ContextsView() {
  const {
    tasks,
    projects,
    updateTask,
    deleteTask,
    batchMoveTasks,
    batchDeleteTasks,
    batchUpdateTasks,
    settings,
  } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkActionLabel, setBulkActionLabel] = useState('');
  const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);

  const tc = useThemeColors();
  const { showToast } = useToast();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
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

  // Combine preset contexts with contexts from tasks
  const contextSourceTasks = tasks.filter((task) => (
    !task.deletedAt
    && task.status !== 'archived'
    && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
  ));
  const allContexts = getUsedTaskTokens(
    contextSourceTasks,
    (task) => [...(task.contexts || []), ...(task.tags || [])]
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
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  // Filter contexts by search query
  const filteredContexts = searchQuery
    ? allContexts.filter((ctx) => ctx.toLowerCase().includes(searchQuery.toLowerCase()))
    : allContexts;

  // ...

  const activeTasks = contextSourceTasks;
  const hasContext = (task: Task) => (task.contexts?.length || 0) > 0 || (task.tags?.length || 0) > 0;
  const matchesSelected = (task: Task, context: string) => {
    const tokens = [...(task.contexts || []), ...(task.tags || [])];
    return tokens.some(token => matchesHierarchicalToken(context, token));
  };
  const noContextSelected = selectedContexts.includes(NO_CONTEXT_TOKEN);
  const filteredTasks = noContextSelected
    ? activeTasks.filter((t) => !hasContext(t))
    : selectedContexts.length > 0
      ? activeTasks.filter((t) => selectedContexts.every((ctx) => matchesSelected(t, ctx)))
      : activeTasks.filter((t) => hasContext(t));

  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
  const sortedTasks = sortTasksBy(filteredTasks, sortBy);
  const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
  const hasSelection = selectedIdsArray.length > 0;
  const removableTagOptions = useMemo(
    () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
    [selectedIdsArray, tasksById]
  );
  const removableContextOptions = useMemo(
    () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'contexts'),
    [selectedIdsArray, tasksById]
  );

  const handleStatusChange = (taskId: string, newStatus: TaskStatus) => {
    updateTask(taskId, { status: newStatus });
  };

  const handleDelete = (taskId: string) => {
    deleteTask(taskId);
  };

  const handleSaveTask = (taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setMultiSelectedIds(new Set());
  };

  const toggleMultiSelect = (taskId: string) => {
    if (!selectionMode) {
      setSelectionMode(true);
    }
    setMultiSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  useEffect(() => {
    setMultiSelectedIds((prev) => {
      const visibleIds = new Set(sortedTasks.map((task) => task.id));
      const next = new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [sortedTasks]);

  const runBulkAction = async (label: string, action: () => Promise<void>) => {
    if (bulkActionLoading) return;
    setBulkActionLabel(label);
    setBulkActionLoading(true);
    try {
      await action();
    } finally {
      setBulkActionLoading(false);
      setBulkActionLabel('');
    }
  };

  const handleBatchMove = async (newStatus: TaskStatus) => {
    if (!hasSelection || bulkActionLoading) return;
    await runBulkAction(t('bulk.moveTo'), async () => {
      await batchMoveTasks(selectedIdsArray, newStatus);
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: `${selectedIdsArray.length} ${t('common.tasks')}`,
        tone: 'success',
      });
    });
  };

  const handleBatchDelete = () => {
    if (!hasSelection || bulkActionLoading) return;
    Alert.alert(
      t('bulk.confirmDeleteTitle') || t('common.delete'),
      t('bulk.confirmDeleteBody') || t('list.confirmBatchDelete'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            void runBulkAction(t('common.delete'), async () => {
              await batchDeleteTasks(selectedIdsArray);
              exitSelectionMode();
              showToast({
                title: t('common.done'),
                message: `${selectedIdsArray.length} ${t('common.tasks')}`,
                tone: 'success',
              });
            });
          },
        },
      ]
    );
  };

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
  const tokenPickerPlaceholder = bulkTokenPicker?.field === 'tags' ? '#tag' : '@context';

  const handleBulkTokenConfirm = async (value: string) => {
    if (!bulkTokenPicker || !hasSelection) return;
    await runBulkAction(tokenPickerTitle, async () => {
      const updates = buildBulkTaskTokenUpdates(
        selectedIdsArray,
        tasksById,
        bulkTokenPicker.field,
        value,
        bulkTokenPicker.action
      );
      setBulkTokenPicker(null);
      if (updates.length === 0) return;
      await batchUpdateTasks(updates);
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

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.contextsBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}
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
                { color: selectedContexts.length === 0 ? '#FFFFFF' : tc.text },
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
                      ? 'rgba(255, 255, 255, 0.25)'
                      : isDark
                        ? 'rgba(255, 255, 255, 0.12)'
                        : 'rgba(0, 0, 0, 0.08)',
                },
              ]}
            >
              <Text style={[styles.contextBadgeText, { color: selectedContexts.length === 0 ? '#FFFFFF' : tc.secondaryText }]}>
              {activeTasks.filter((t) => (t.contexts?.length || 0) > 0 || (t.tags?.length || 0) > 0).length}
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
                { color: noContextSelected ? '#FFFFFF' : tc.text },
              ]}
            >
              {t('contexts.none')}
            </Text>
            <View
              style={[
                styles.contextBadge,
                {
                  backgroundColor: noContextSelected
                    ? 'rgba(255, 255, 255, 0.25)'
                    : isDark
                      ? 'rgba(255, 255, 255, 0.12)'
                      : 'rgba(0, 0, 0, 0.08)',
                },
              ]}
            >
              <Text style={[styles.contextBadgeText, { color: noContextSelected ? '#FFFFFF' : tc.secondaryText }]}>
                {activeTasks.filter((t) => !hasContext(t)).length}
              </Text>
            </View>
          </Pressable>

          {filteredContexts.map((context) => {
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
                    { color: isActive ? '#FFFFFF' : tc.text },
                  ]}
                >
                  {context}
                </Text>
                <View
                  style={[
                    styles.contextBadge,
                    {
                      backgroundColor: isActive
                        ? 'rgba(255, 255, 255, 0.25)'
                        : isDark
                          ? 'rgba(255, 255, 255, 0.12)'
                          : 'rgba(0, 0, 0, 0.08)',
                    },
                  ]}
                >
                  <Text style={[styles.contextBadgeText, { color: isActive ? '#FFFFFF' : tc.secondaryText }]}>{count}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.content}>
          <View style={[styles.contentHeader, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
            <View style={styles.contentHeaderMain}>
              <Text style={[styles.contentTitle, { color: tc.text }]}>
                {noContextSelected
                  ? t('contexts.none')
                  : (selectedContexts.length > 0 ? selectedContexts.join(', ') : t('contexts.all'))}
              </Text>
              <Text style={[styles.contentCount, { color: tc.secondaryText }]}>
                {sortedTasks.length} {t('common.tasks')}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
              style={[
                styles.selectButton,
                {
                  borderColor: tc.border,
                  backgroundColor: selectionMode ? tc.filterBg : 'transparent',
                },
              ]}
            >
              <Text style={[styles.selectButtonText, { color: tc.text }]}>
                {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
              </Text>
            </TouchableOpacity>
          </View>

          {selectionMode ? (
            <View style={[styles.bulkBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
              <View style={styles.bulkHeaderRow}>
                <Text style={[styles.bulkCount, { color: tc.secondaryText }]}>
                  {selectedIdsArray.length} {t('bulk.selected')}
                </Text>
                {bulkActionLoading ? (
                  <View style={styles.bulkLoadingRow}>
                    <ActivityIndicator size="small" color={tc.tint} />
                    <Text style={[styles.bulkLoadingText, { color: tc.secondaryText }]}>
                      {bulkActionLabel || t('common.loading')}
                    </Text>
                  </View>
                ) : null}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkRow}>
                {(['inbox', 'next', 'waiting', 'someday', 'reference', 'done'] as TaskStatus[]).map((status) => (
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
                  <Text style={[styles.bulkButtonText, { color: tc.text }]}>{t('bulk.delete')}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          ) : null}

          <ScrollView style={[styles.taskList, { backgroundColor: tc.bg }]} showsVerticalScrollIndicator={false}>
            {sortedTasks.length > 0 ? (
              sortedTasks.map((task) => (
                <SwipeableTaskItem
                  key={task.id}
                  task={task}
                  isDark={isDark}
                  tc={tc}
                  onPress={() => setEditingTask(task)}
                  selectionMode={selectionMode}
                  isMultiSelected={multiSelectedIds.has(task.id)}
                  onToggleSelect={() => toggleMultiSelect(task.id)}
                  onStatusChange={(status) => handleStatusChange(task.id, status)}
                  onDelete={() => handleDelete(task.id)}
                  onProjectPress={openProjectScreen}
                  onContextPress={(context) => setSelectedContexts([context])}
                  onTagPress={(tag) => setSelectedContexts([tag])}
                />
              ))
            ) : (
              <View style={styles.emptyState}>
                {allContexts.length === 0 ? (
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
          </ScrollView>
        </View>

        <TokenPickerModal
          visible={bulkTokenPicker !== null}
          title={tokenPickerTitle}
          description={tokenPickerTitle}
          tokens={tokenPickerOptions}
          placeholder={tokenPickerPlaceholder}
          allowCustomValue={bulkTokenPicker?.action === 'add'}
          onClose={() => setBulkTokenPicker(null)}
          onConfirm={(value) => {
            void handleBulkTokenConfirm(value);
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
  contextsBar: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    maxHeight: 48,
  },
  contextsBarContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
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
  contentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  contentHeaderMain: {
    flex: 1,
    marginRight: 12,
    gap: 4,
  },
  contentTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  contentCount: {
    fontSize: 14,
    color: '#6B7280',
  },
  selectButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  selectButtonText: {
    fontSize: 13,
    fontWeight: '600',
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
  bulkLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  bulkLoadingText: {
    fontSize: 12,
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
