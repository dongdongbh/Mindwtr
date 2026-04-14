import { Modal, Pressable, Text, View } from 'react-native';
import type { TaskSortBy } from '@mindwtr/core';

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
  sortOptions: TaskSortBy[];
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
            {sortOptions.map((option) => (
              <Pressable
                key={option}
                onPress={() => onSelect(option)}
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
