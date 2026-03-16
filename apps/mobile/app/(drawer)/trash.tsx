import { View, Text, ScrollView, Pressable, StyleSheet, Alert } from 'react-native';
import { useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors, ThemeColors } from '@/hooks/use-theme-colors';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect, useRef } from 'react';

function TrashTaskItem({
  task,
  tc,
  onRestore,
  onDelete,
  isHighlighted,
}: {
  task: Task;
  tc: ThemeColors;
  onRestore: () => void;
  onDelete: () => void;
  isHighlighted?: boolean;
}) {
  const swipeableRef = useRef<Swipeable>(null);

  const renderLeftActions = () => (
    <Pressable
      style={styles.swipeActionRestore}
      onPress={() => {
        swipeableRef.current?.close();
        onRestore();
      }}
    >
      <Text style={styles.swipeActionText}>↩️ Restore</Text>
    </Pressable>
  );

  const renderRightActions = () => (
    <Pressable
      style={styles.swipeActionDelete}
      onPress={() => {
        swipeableRef.current?.close();
        onDelete();
      }}
    >
      <Text style={styles.swipeActionText}>🗑️ Delete</Text>
    </Pressable>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      overshootLeft={false}
      overshootRight={false}
    >
      <View
        style={[
          styles.taskItem,
          { backgroundColor: tc.taskItemBg },
          isHighlighted && { borderWidth: 2, borderColor: tc.tint },
        ]}
      >
        <View style={styles.taskContent}>
          <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
            {task.title}
          </Text>
          {task.description && (
            <Text style={[styles.taskDescription, { color: tc.secondaryText }]} numberOfLines={1}>
              {task.description}
            </Text>
          )}
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>
            Deleted: {task.deletedAt ? new Date(task.deletedAt).toLocaleDateString() : 'Unknown'}
          </Text>
        </View>
        <View style={[styles.statusIndicator, { backgroundColor: '#6B7280' }]} />
      </View>
    </Swipeable>
  );
}

export default function TrashScreen() {
  const { _allTasks, projects, restoreTask, purgeTask, purgeDeletedTasks, highlightTaskId, setHighlightTask } = useTaskStore();
  const { t } = useLanguage();
  useTheme();
  const tc = useThemeColors();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = new Map(projects.map((project) => [project.id, project]));

  const trashedTasks = _allTasks.filter((task) => (
    task.deletedAt
    && !task.purgedAt
    && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
  ));

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const handleRestore = (taskId: string) => {
    restoreTask(taskId);
  };

  const handleDelete = (taskId: string) => {
    Alert.alert(
      t('trash.deleteConfirm') || 'Delete Permanently?',
      t('trash.deleteConfirmBody') || 'This action cannot be undone.',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('trash.deletePermanently') || 'Delete',
          style: 'destructive',
          onPress: () => purgeTask(taskId),
        },
      ]
    );
  };

  const handleClearAll = () => {
    if (trashedTasks.length === 0) return;
    Alert.alert(
      t('trash.clearAllConfirm') || 'Clear trash?',
      t('trash.clearAllConfirmBody') || 'This will permanently delete all trashed tasks.',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('trash.clearAll') || 'Clear Trash',
          style: 'destructive',
          onPress: () => purgeDeletedTasks(),
        },
      ]
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        {trashedTasks.length > 0 && (
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
              {trashedTasks.length} {t('common.tasks') || 'tasks'}
            </Text>
            <Pressable
              onPress={handleClearAll}
              style={[styles.clearButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
            >
              <Text style={[styles.clearButtonText, { color: tc.secondaryText }]}>
                {t('trash.clearAll') || 'Clear Trash'}
              </Text>
            </Pressable>
          </View>
        )}
        <ScrollView style={styles.taskList} showsVerticalScrollIndicator={false}>
          {trashedTasks.length > 0 ? (
            trashedTasks.map((task) => (
              <TrashTaskItem
                key={task.id}
                task={task}
                tc={tc}
                onRestore={() => handleRestore(task.id)}
                onDelete={() => handleDelete(task.id)}
                isHighlighted={task.id === highlightTaskId}
              />
            ))
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>🗑️</Text>
              <Text style={[styles.emptyTitle, { color: tc.text }]}>
                {t('trash.empty') || 'Trash is empty'}
              </Text>
              <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                {t('trash.emptyHint') || 'Deleted tasks will appear here'}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  summaryRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  summaryText: {
    fontSize: 13,
    fontWeight: '500',
  },
  clearButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  clearButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  taskList: {
    flex: 1,
    padding: 16,
  },
  taskItem: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
    textDecorationLine: 'line-through',
  },
  taskDescription: {
    fontSize: 14,
    marginBottom: 4,
  },
  archivedDate: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  statusIndicator: {
    width: 4,
    borderRadius: 2,
    marginLeft: 12,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
  },
  swipeActionRestore: {
    backgroundColor: '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
    width: 120,
    borderRadius: 12,
    marginBottom: 12,
  },
  swipeActionDelete: {
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 120,
    borderRadius: 12,
    marginBottom: 12,
  },
  swipeActionText: {
    color: 'white',
    fontWeight: '600',
  },
});
