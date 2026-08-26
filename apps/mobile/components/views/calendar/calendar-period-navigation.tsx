import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { styles } from './calendar-view.styles';

type CalendarPeriodNavigationProps = {
  label: string;
  nextLabel: string;
  onNext: () => void;
  onPrevious: () => void;
  onToday: () => void;
  previousLabel: string;
  tc: {
    border: string;
    text: string;
    tint: string;
  };
  titleVariant?: 'day' | 'standard';
  todayLabel: string;
};

export function CalendarPeriodNavigation({
  label,
  nextLabel,
  onNext,
  onPrevious,
  onToday,
  previousLabel,
  tc,
  titleVariant = 'standard',
  todayLabel,
}: CalendarPeriodNavigationProps) {
  const dayTitle = titleVariant === 'day';

  return (
    <View style={styles.headerTopRow}>
      <Pressable
        accessibilityLabel={previousLabel}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onPrevious}
        style={styles.navButton}
      >
        <Text style={[styles.navButtonText, { color: tc.text }]}>‹</Text>
      </Pressable>
      <View style={dayTitle ? styles.dayModeTitleWrap : styles.monthTitleWrap}>
        <Text
          numberOfLines={1}
          style={[dayTitle ? styles.dayModeTitle : styles.title, { color: tc.text }]}
        >
          {label}
        </Text>
        <Pressable
          accessibilityLabel={todayLabel}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onToday}
          style={[styles.todayButton, { borderColor: tc.border }]}
        >
          <Text style={[styles.todayButtonText, { color: tc.tint }]}>{todayLabel}</Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityLabel={nextLabel}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onNext}
        style={styles.navButton}
      >
        <Text style={[styles.navButtonText, { color: tc.text }]}>›</Text>
      </Pressable>
    </View>
  );
}
