import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  getQuickDate,
  getQuickDateLabel,
  isQuickDatePresetSelected,
  QUICK_DATE_PRESETS,
  type QuickDatePreset,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

type QuickDateChipsProps = {
  t: (key: string) => string;
  tc: Pick<ThemeColors, 'tint' | 'onTint' | 'filterBg' | 'border' | 'secondaryText'>;
  disabled?: boolean;
  allowClear?: boolean;
  accessibilityLabelPrefix?: string;
  selectedDate?: Date | null;
  selectedPreset?: QuickDatePreset | null;
  onSelect: (date: Date | null, preset: QuickDatePreset) => void;

  presets?: readonly QuickDatePreset[];

  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  chipStyle?: StyleProp<ViewStyle>;
};

export function QuickDateChips({
  t,
  tc,
  disabled = false,
  allowClear = true,
  accessibilityLabelPrefix,
  selectedDate,
  selectedPreset,
  onSelect,
  presets = QUICK_DATE_PRESETS,
  trailing,
  style,
  contentContainerStyle,
  chipStyle,
}: QuickDateChipsProps) {
  const now = new Date();

  return (
    <View
      testID="quick-date-chips-row"
      style={[styles.content, style, contentContainerStyle]}
    >
      {presets.filter((preset) => allowClear || preset !== 'no_date').map((preset) => {
        const label = getQuickDateLabel(preset, t);
        const active = selectedPreset === preset || isQuickDatePresetSelected(preset, selectedDate, now);

        return (
          <Pressable
            key={preset}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled }}
            disabled={disabled}
            accessibilityLabel={accessibilityLabelPrefix ? `${accessibilityLabelPrefix}: ${label}` : label}

            onPress={() => onSelect(active && allowClear ? null : getQuickDate(preset, now), preset)}
            style={[
              styles.chip,
              {
                backgroundColor: active ? tc.tint : tc.filterBg,
                borderColor: active ? tc.tint : tc.border,
              },
              chipStyle,
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
