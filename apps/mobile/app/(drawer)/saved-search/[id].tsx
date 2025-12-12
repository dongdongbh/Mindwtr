import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useTaskStore, filterTasksBySearch, sortTasksBy, type Task, type TaskStatus, type TaskSortBy } from '@mindwtr/core';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useLanguage } from '@/contexts/language-context';
import { useTheme } from '@/contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { Trash2 } from 'lucide-react-native';

export default function SavedSearchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tasks, projects, settings, updateTask, deleteTask, fetchData, updateSettings } = useTaskStore();
  const { t } = useLanguage();
  const { isDark } = useTheme();
  const tc = useThemeColors();

  const savedSearch = settings?.savedSearches?.find(s => s.id === id);
  const query = savedSearch?.query || '';
  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

  const filteredTasks = useMemo(() => {
    if (!query) return [];
    return sortTasksBy(filterTasksBySearch(tasks, projects, query), sortBy);
  }, [tasks, projects, query, sortBy]);

  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleDeleteSearch = useCallback(() => {
    if (!savedSearch) return;
    Alert.alert(
      t('common.delete'),
      t('search.deleteConfirm') || `Delete "${savedSearch.name}"?`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const updated = (settings?.savedSearches || []).filter(s => s.id !== id);
            await updateSettings({ savedSearches: updated });
            router.back();
          },
        },
      ]
    );
  }, [savedSearch, id, settings?.savedSearches, updateSettings, t]);

  const renderTask = ({ item }: { item: Task }) => (
    <SwipeableTaskItem
      task={item}
      isDark={isDark}
      tc={tc}
      onPress={() => {
        setEditingTask(item);
        setIsModalVisible(true);
      }}
      onStatusChange={(status) => updateTask(item.id, { status: status as TaskStatus })}
      onDelete={() => deleteTask(item.id)}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { borderBottomColor: tc.border }]}>
        <View style={styles.headerContent}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: tc.text }]} accessibilityRole="header">
              {savedSearch?.name || t('search.savedSearches')}
            </Text>
            {query ? (
              <Text style={[styles.queryText, { color: tc.secondaryText }]} numberOfLines={1}>
                {query}
              </Text>
            ) : null}
          </View>
          {savedSearch && (
            <TouchableOpacity
              onPress={handleDeleteSearch}
              style={styles.deleteButton}
              accessibilityLabel={t('common.delete')}
            >
              <Trash2 size={20} color="#EF4444" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {t('search.noResults')}
            </Text>
          </View>
        }
      />

      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={(taskId, updates) => {
          updateTask(taskId, updates);
          setIsModalVisible(false);
          setEditingTask(null);
        }}
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
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
  },
  headerContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  queryText: {
    fontSize: 12,
  },
  deleteButton: {
    padding: 8,
    marginLeft: 8,
  },
  listContent: {
    padding: 16,
  },
  emptyContainer: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
  },
});
