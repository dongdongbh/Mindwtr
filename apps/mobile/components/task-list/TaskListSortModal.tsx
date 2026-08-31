import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { resolveFeatureFlags, useTaskStore, type TaskSortBy } from '@mindwtr/core';

import { styles } from './task-list.styles';

type ThemeColors = {
  border: string;
  cardBg: string;
  filterBg: string;
  text: string;
};

type TaskListSortModalProps = {
  onClose: () => void;
  onSelect: (option: TaskSortBy) => void;
  sortBy: TaskSortBy;
  sortOptions: readonly TaskSortBy[];
  t: (key: string) => string;
  themeColors: ThemeColors;
  visible: boolean;
};

export function TaskListSortModal({
  onClose,
  onSelect,
  sortBy,
  sortOptions,
  t,
  themeColors,
  visible,
}: TaskListSortModalProps) {
  // Gated here rather than at each caller (task list + project detail) so a new
  // caller cannot leak a disabled feature's sort. Callers pass the resolved sort
  // ('timeEstimate' reads as 'default' while the feature is off), so dropping the
  // option can never hide the row that is actually selected (#1107).
  const timeEstimatesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).timeEstimates);
  const visibleSortOptions = sortOptions.filter(
    (option) => option !== 'timeEstimate' || timeEstimatesEnabled,
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={[styles.modalCard, { backgroundColor: themeColors.cardBg }]}>
          <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('sort.label')}</Text>
          <View style={styles.sortList}>
            {visibleSortOptions.map((option) => (
              <Pressable
                key={option}
                onPress={() => onSelect(option)}
                testID={`sort-option-${option}`}
                style={[
                  styles.sortItem,
                  option === sortBy && { backgroundColor: themeColors.filterBg },
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
  );
}
