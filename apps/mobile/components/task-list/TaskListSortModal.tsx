import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { getTaskSortByLabel, getVisibleTaskSortOptions, useTaskStore, type TaskSortBy } from '@mindwtr/core';

import { styles } from './task-list.styles';

type ThemeColors = {
  border: string;
  cardBg: string;
  filterBg: string;
  text: string;
};

type TaskListSortModalProps = {

  inheritOption?: { label: string; selected: boolean; onSelect: () => void };
  onClose: () => void;
  onSelect: (option: TaskSortBy) => void;
  sortBy: TaskSortBy;
  sortOptions: readonly TaskSortBy[];
  t: (key: string) => string;
  themeColors: ThemeColors;
  visible: boolean;
};

export function TaskListSortModal({
  inheritOption,
  onClose,
  onSelect,
  sortBy,
  sortOptions,
  t,
  themeColors,
  visible,
}: TaskListSortModalProps) {


  const features = useTaskStore((state) => state.settings?.features);
  const visibleSortOptions = getVisibleTaskSortOptions(sortOptions, { features });
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
            {inheritOption ? (
              <Pressable
                onPress={inheritOption.onSelect}
                testID="sort-option-inherit"
                style={[
                  styles.sortItem,
                  inheritOption.selected && { backgroundColor: themeColors.filterBg },
                ]}
              >
                <Text style={[styles.sortItemText, { color: themeColors.text }]}>
                  {inheritOption.label}
                </Text>
              </Pressable>
            ) : null}
            {visibleSortOptions.map((option) => (
              <Pressable
                key={option}
                onPress={() => onSelect(option)}
                testID={`sort-option-${option}`}
                style={[
                  styles.sortItem,
                  !inheritOption?.selected && option === sortBy && { backgroundColor: themeColors.filterBg },
                ]}
              >
                <Text style={[styles.sortItemText, { color: themeColors.text }]}>
                  {getTaskSortByLabel(option, t)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
