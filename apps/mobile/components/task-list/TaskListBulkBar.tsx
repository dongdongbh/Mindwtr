import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { TaskStatus } from '@mindwtr/core';

import { styles } from './task-list.styles';

type ThemeColors = {
  border: string;
  cardBg: string;
  filterBg: string;
  secondaryText: string;
  text: string;
  tint: string;
};

type TaskListBulkBarProps = {
  bulkActionLabel: string;
  bulkActionLoading: boolean;
  handleBatchDelete: () => void;
  handleBatchMove: (status: TaskStatus) => void;
  hasSelection: boolean;
  onOpenTagModal: () => void;
  selectedCount: number;
  t: (key: string) => string;
  themeColors: ThemeColors;
};

export function TaskListBulkBar({
  bulkActionLabel,
  bulkActionLoading,
  handleBatchDelete,
  handleBatchMove,
  hasSelection,
  onOpenTagModal,
  selectedCount,
  t,
  themeColors,
}: TaskListBulkBarProps) {
  return (
    <View style={[styles.bulkBar, { backgroundColor: themeColors.cardBg, borderBottomColor: themeColors.border }]}>
      <View style={styles.bulkStatusRow}>
        <Text style={[styles.bulkCount, { color: themeColors.secondaryText }]}>
          {selectedCount} {t('bulk.selected')}
        </Text>
        {bulkActionLoading && (
          <View style={styles.bulkLoadingRow}>
            <ActivityIndicator size="small" color={themeColors.tint} />
            <Text style={[styles.bulkLoadingText, { color: themeColors.secondaryText }]}>
              {bulkActionLabel || t('common.loading')}
            </Text>
          </View>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkMoveRow}>
        {(['inbox', 'next', 'waiting', 'someday', 'reference', 'done'] as TaskStatus[]).map((status) => (
          <TouchableOpacity
            key={status}
            onPress={() => handleBatchMove(status)}
            disabled={!hasSelection || bulkActionLoading}
            style={[styles.bulkMoveButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
            accessibilityRole="button"
            accessibilityLabel={`${t('bulk.moveTo')} ${t(`status.${status}`)}`}
          >
            <Text style={[styles.bulkMoveText, { color: themeColors.text }]}>{t(`status.${status}`)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={styles.bulkActions}>
        <TouchableOpacity
          onPress={onOpenTagModal}
          disabled={!hasSelection || bulkActionLoading}
          style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={t('bulk.addTag')}
        >
          <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('bulk.addTag')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleBatchDelete}
          disabled={!hasSelection || bulkActionLoading}
          style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={t('bulk.delete')}
        >
          <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('bulk.delete')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
