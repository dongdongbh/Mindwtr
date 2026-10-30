import React from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ClipboardCheck, X } from 'lucide-react-native';
import { BULK_MOVE_STATUS_ORDER, buildTaskListBulkBarModel, type TaskStatus } from '@mindwtr/core';

import { styles } from './task-list.styles';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

// The statuses a list offers live in core, shared with the native host; re-exported for existing imports.
export { BULK_MOVE_STATUS_ORDER, getBulkMoveStatusOptions } from '@mindwtr/core';

type ThemeColors = {
  border: string;
  cardBg: string;
  filterBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

export type TaskListBulkBarProps = {
  bulkActionLabel: string;
  bulkActionLoading: boolean;
  handleBatchDelete: () => void;
  handleBatchMove: (status: TaskStatus) => void;
  hasSelection: boolean;
  onExitSelectionMode: () => void;
  onOpenOrganize?: () => void;
  onReorder?: () => void;
  onMoveToSection?: () => void;
  onToggleRangeSelectMode: () => void;
  onOpenTagModal: () => void;
  onOpenRemoveTagPicker?: () => void;
  canRemoveTags?: boolean;
  rangeSelectMode: boolean;
  selectedCount: number;
  statusOptions?: readonly TaskStatus[];
  t: (key: string) => string;
  themeColors: ThemeColors;
};

export function TaskListBulkBar({
  bulkActionLabel,
  bulkActionLoading,
  handleBatchDelete,
  handleBatchMove,
  hasSelection,
  onExitSelectionMode,
  onOpenOrganize,
  onReorder,
  onMoveToSection,
  onToggleRangeSelectMode,
  onOpenTagModal,
  onOpenRemoveTagPicker,
  canRemoveTags = false,
  rangeSelectMode,
  selectedCount,
  statusOptions,
  t,
  themeColors,
}: TaskListBulkBarProps) {
  const filledButton = useFilledButtonColors();
  // Labels and enabled states come from core, as the native host shows them.
  const bar = buildTaskListBulkBarModel({
    selectedCount,
    hasSelection,
    busy: bulkActionLoading,
    busyLabel: bulkActionLabel,
    rangeSelectMode,
    statuses: statusOptions ?? BULK_MOVE_STATUS_ORDER,
    moveToSection: Boolean(onMoveToSection),
    organize: Boolean(onOpenOrganize),
    removeTag: onOpenRemoveTagPicker ? { canRemove: canRemoveTags } : null,
    t,
  });

  return (
    <View style={[styles.bulkBar, { backgroundColor: themeColors.cardBg, borderBottomColor: themeColors.border }]}>
      <View style={styles.bulkStatusRow}>
        <Text style={[styles.bulkCount, { color: themeColors.secondaryText }]}>
          {bar.countLabel}
        </Text>
        <View style={styles.bulkStatusActions}>
          {bulkActionLoading && (
            <View style={styles.bulkLoadingRow}>
              <ActivityIndicator size="small" color={themeColors.tint} />
              <Text style={[styles.bulkLoadingText, { color: themeColors.secondaryText }]}>
                {bar.busyLabel}
              </Text>
            </View>
          )}
          <TouchableOpacity
            onPress={onExitSelectionMode}
            disabled={!bar.exit.enabled}
            style={[
              styles.bulkExitButton,
              { backgroundColor: themeColors.filterBg, opacity: bar.exit.enabled ? 1 : 0.5 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={bar.exit.accessibilityLabel}
          >
            <X size={16} color={themeColors.secondaryText} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkMoveRow}>
        {bar.statuses.map((option) => (
          <TouchableOpacity
            key={option.status}
            onPress={() => handleBatchMove(option.status)}
            disabled={!option.enabled}
            style={[styles.bulkMoveButton, { backgroundColor: themeColors.filterBg, opacity: option.enabled ? 1 : 0.5 }]}
            accessibilityRole="button"
            accessibilityLabel={option.accessibilityLabel}
          >
            <Text style={[styles.bulkMoveText, { color: themeColors.text }]}>{option.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={styles.bulkActions}>
        {onReorder ? (
          <TouchableOpacity
            onPress={onReorder}
            disabled={bulkActionLoading}
            style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: bulkActionLoading ? 0.5 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={t('projects.reorderTasks')}
            testID="task-list-reorder-shortcut"
          >
            <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('projects.reorderTasks')}</Text>
          </TouchableOpacity>
        ) : null}
        {onMoveToSection && bar.moveToSection ? (
          <TouchableOpacity
            onPress={onMoveToSection}
            disabled={!bar.moveToSection.enabled}
            style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: bar.moveToSection.enabled ? 1 : 0.5 }]}
            accessibilityRole="button"
            accessibilityLabel={bar.moveToSection.label}
          >
            <Text style={[styles.bulkActionText, { color: themeColors.text }]}>
              {bar.moveToSection.label}
            </Text>
          </TouchableOpacity>
        ) : null}
        {onOpenOrganize && bar.organize ? (
          <TouchableOpacity
            onPress={onOpenOrganize}
            disabled={!bar.organize.enabled}
            style={[styles.bulkActionButton, { backgroundColor: filledButton.backgroundColor, opacity: bar.organize.enabled ? 1 : 0.5 }]}
            accessibilityRole="button"
            accessibilityLabel={bar.organize.label}
          >
            <ClipboardCheck size={14} color={filledButton.textColor ?? themeColors.onTint} />
            <Text style={[styles.bulkActionText, { color: filledButton.textColor ?? themeColors.onTint }]}>
              {bar.organize.label}
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={onToggleRangeSelectMode}
          disabled={!bar.range.enabled}
          style={[
            styles.bulkActionButton,
            {
              backgroundColor: bar.range.active ? themeColors.tint : themeColors.filterBg,
              opacity: bar.range.enabled ? 1 : 0.5,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={bar.range.label}
          accessibilityState={{ disabled: !bar.range.enabled, selected: bar.range.active }}
          testID="task-list-range-select-toggle"
        >
          <Text style={[styles.bulkActionText, { color: bar.range.active ? themeColors.onTint : themeColors.text }]}>
            {bar.range.label}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onOpenTagModal}
          disabled={!bar.addTag.enabled}
          style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: bar.addTag.enabled ? 1 : 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={bar.addTag.label}
        >
          <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{bar.addTag.label}</Text>
        </TouchableOpacity>
        {onOpenRemoveTagPicker && bar.removeTag ? (
          <TouchableOpacity
            onPress={onOpenRemoveTagPicker}
            disabled={!bar.removeTag.enabled}
            style={[
              styles.bulkActionButton,
              {
                backgroundColor: themeColors.filterBg,
                opacity: bar.removeTag.enabled ? 1 : 0.5,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={bar.removeTag.label}
          >
            <Text style={[styles.bulkActionText, { color: themeColors.text }]}>
              {bar.removeTag.label}
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={handleBatchDelete}
          disabled={!bar.delete.enabled}
          style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: bar.delete.enabled ? 1 : 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={bar.delete.label}
        >
          <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{bar.delete.label}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
