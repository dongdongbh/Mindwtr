import { View, Text, ScrollView, Pressable, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useTaskStore, sortTasksBy, type Task, type TaskStatus, type TaskSortBy } from '@mindwtr/core';
import { useState } from 'react';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { ReviewModal } from '../../../components/review-modal';

import { TaskEditModal } from '@/components/task-edit-modal';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';

const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];



const getStatusLabels = (lang: 'en' | 'zh'): Record<TaskStatus, string> => {
  if (lang === 'zh') {
    return {
      inbox: '📥 收集箱',
      todo: '📝 待办',
      next: '▶️ 下一步',
      'in-progress': '🚧 进行中',
      waiting: '⏸️ 等待中',
      someday: '💭 将来',
      done: '✅ 完成',
      archived: '🗄️ 归档',
    };
  }
  return {
    inbox: '📥 Inbox',
    todo: '📝 Todo',
    next: '▶️ Next',
    'in-progress': '🚧 In Progress',
    waiting: '⏸️ Waiting',
    someday: '💭 Someday',
    done: '✅ Done',
    archived: '🗄️ Archived',
  };
};

export default function ReviewScreen() {
  const router = useRouter();
  const { tasks, updateTask, deleteTask, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { language, t } = useLanguage();
  const [filterStatus, setFilterStatus] = useState<TaskStatus | 'all'>('all');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);

  const STATUS_LABELS = getStatusLabels(language as 'en' | 'zh');

  // Theme-aware colors
  // Theme-aware colors
  const tc = useThemeColors();

  // Filter out archived and deleted tasks first, then apply status filter
  const activeTasks = tasks.filter((t) => t.status !== 'archived' && !t.deletedAt);
  const filteredTasks = activeTasks.filter((task) =>
    filterStatus === 'all' ? true : task.status === filterStatus
  );

  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
  const sortedTasks = sortTasksBy(filteredTasks, sortBy);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <View>
          <Text style={[styles.title, { color: tc.text }]}>📋 {language === 'zh' ? '回顾任务' : 'Review'}</Text>
          <Text style={[styles.count, { color: tc.secondaryText }]}>{filteredTasks.length} {language === 'zh' ? '个任务' : 'tasks'}</Text>
        </View>
        <TouchableOpacity
          style={styles.weeklyReviewButton}
          onPress={() => setShowReviewModal(true)}
        >
          <Text style={styles.weeklyReviewButtonText}>🔄 {language === 'zh' ? '周回顾' : 'Weekly Review'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView horizontal style={[styles.filterBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]} showsHorizontalScrollIndicator={false}>
        <Pressable
          style={[styles.filterButton, { backgroundColor: tc.filterBg }, filterStatus === 'all' && styles.filterButtonActive]}
          onPress={() => setFilterStatus('all')}
        >
          <Text style={[styles.filterText, { color: tc.secondaryText }, filterStatus === 'all' && styles.filterTextActive]}>
            {t('common.all')} ({activeTasks.length})
          </Text>
        </Pressable>
        {STATUS_OPTIONS.map((status) => (
          <Pressable
            key={status}
            style={[styles.filterButton, { backgroundColor: tc.filterBg }, filterStatus === status && styles.filterButtonActive]}
            onPress={() => setFilterStatus(status)}
          >
            <Text style={[styles.filterText, { color: tc.secondaryText }, filterStatus === status && styles.filterTextActive]}>
              {STATUS_LABELS[status]} ({activeTasks.filter((t) => t.status === status).length})
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView style={styles.taskList}>
        {sortedTasks.map((task) => (
          <SwipeableTaskItem
            key={task.id}
            task={task}
            isDark={isDark}
            tc={tc}
            onPress={() => {
              setEditingTask(task);
              setIsModalVisible(true);
            }}
            onStatusChange={(status) => updateTask(task.id, { status: status as TaskStatus })}
            onDelete={() => deleteTask(task.id)}
          />
        ))}
        {sortedTasks.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.noTasks')}</Text>
          </View>
        )}
      </ScrollView>

      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={(taskId, updates) => updateTask(taskId, updates)}
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
    backgroundColor: '#F9FAFB',
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  count: {
    fontSize: 14,
  },
  filterBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    maxHeight: 60,
  },
  filterButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  filterButtonActive: {
    backgroundColor: '#3B82F6',
  },
  filterText: {
    fontSize: 14,
    fontWeight: '500',
  },
  filterTextActive: {
    color: '#FFFFFF',
  },
  taskList: {
    flex: 1,
    padding: 16,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    textAlign: 'center',
  },
  weeklyReviewButton: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  weeklyReviewButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
