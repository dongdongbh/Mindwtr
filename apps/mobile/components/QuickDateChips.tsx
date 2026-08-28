import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  getQuickDate,
  isQuickDatePresetSelected,
  QUICK_DATE_PRESETS,
  tFallback,
  type QuickDatePreset,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

const QUICK_DATE_LABELS: Record<QuickDatePreset, { key: string; fallback: string }> = {
  today: { key: 'quickDate.today', fallback: 'Today' },
  tomorrow: { key: 'quickDate.tomorrow', fallback: 'Tomorrow' },
  in_2_days: { key: 'quickDate.in2Days', fallback: '+2 days' },
  in_3_days: { key: 'quickDate.in3Days', fallback: '+3 days' },
  next_week: { key: 'quickDate.nextWeek', fallback: 'Next week' },
  next_month: { key: 'quickDate.nextMonth', fallback: 'Next month' },
  no_date: { key: 'quickDate.noDate', fallback: 'No date' },
};

type QuickDateChipsProps = {
  t: (key: string) => string;
  tc: ThemeColors;
  accessibilityLabelPrefix?: string;
  selectedDate?: Date | null;
  selectedPreset?: QuickDatePreset | null;
  onSelect: (date: Date | null, preset: QuickDatePreset) => void;
  /** Which presets to render. Defaults to the full core set. */
  presets?: readonly QuickDatePreset[];
  /** Optional node rendered as the last item inside the same wrapping row (e.g. a custom-date chip). */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
};

export function QuickDateChips({
  t,
  tc,
  accessibilityLabelPrefix,
  selectedDate,
  selectedPreset,
  onSelect,
  presets = QUICK_DATE_PRESETS,
  trailing,
  style,
  contentContainerStyle,
}: QuickDateChipsProps) {
  const now = new Date();

  return (
    <View
      testID="quick-date-chips-row"
      style={[styles.content, style, contentContainerStyle]}
    >
      {presets.map((preset) => {
        const labelConfig = QUICK_DATE_LABELS[preset];
        const label = tFallback(t, labelConfig.key, labelConfig.fallback);
        const active = selectedPreset === preset || isQuickDatePresetSelected(preset, selectedDate, now);

        return (
          <Pressable
            key={preset}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={accessibilityLabelPrefix ? `${accessibilityLabelPrefix}: ${label}` : label}
            // Tapping the active chip clears the date (replaces the standalone "No date" chip).
            onPress={() => onSelect(active ? null : getQuickDate(preset, now), preset)}
            style={[
              styles.chip,
              {
                backgroundColor: active ? tc.tint : tc.filterBg,
                borderColor: active ? tc.tint : tc.border,
              },
            ]}
          >
            <CompactText
              style={[
                styles.chipText,
                { color: active ? tc.onTint : tc.secondaryText },
              ]}
              numberOfLines={2}
            >
              {label}
            </CompactText>
          </Pressable>
        );
      })}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingRight: 4,
  },
  chip: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    flexBasis: 92,
    flexGrow: 1,
    flexShrink: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    justifyContent: 'center',
    maxWidth: '100%',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
