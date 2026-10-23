import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { ArrowUpDown } from 'lucide-react-native';

import { styles } from './task-list.styles';

type TaskListSortButtonProps = {
  /** Core's "Sort: <current>" label (getTaskListHeaderText's sortAccessibilityLabel). */
  accessibilityLabel: string;
  onPress: () => void;
  themeColors: { border: string; filterBg: string; secondaryText: string };
};

/** The direct Sort control (Inbox's header, Contexts' search row): opens TaskListSortModal. */
export function TaskListSortButton({ accessibilityLabel, onPress, themeColors }: TaskListSortButtonProps) {
  return (
    <TouchableOpacity
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.directControlButton}
    >
      <View style={[styles.directControlVisual, { borderColor: themeColors.border, backgroundColor: themeColors.filterBg }]}>
        <ArrowUpDown size={16} color={themeColors.secondaryText} strokeWidth={2} />
      </View>
    </TouchableOpacity>
  );
}
