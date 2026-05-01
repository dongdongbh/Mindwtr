import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { safeFormatDate } from '@mindwtr/core';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  label: string;
  value: Date | null;
  onOpen: () => void;
  onClear: () => void;
  dateOnly?: boolean;
  onDateOnly?: () => void;
  onUseDefaultTime?: () => void;
  defaultScheduleTime?: string | null;
  dateOnlyLabel: string;
  notSetLabel: string;
  clearLabel: string;
  tc: ThemeColors;
};

export function InboxDateSelectorRow({
  label,
  value,
  onOpen,
  onClear,
  dateOnly,
  onDateOnly,
  onUseDefaultTime,
  defaultScheduleTime,
  dateOnlyLabel,
  notSetLabel,
  clearLabel,
  tc,
}: Props) {
  return (
    <View style={styles.startDateRow}>
      <Text style={[styles.tokenSectionTitle, { color: tc.secondaryText }]}>{label}</Text>
      <View style={styles.startDateActions}>
        <TouchableOpacity
          style={[styles.startDateButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
          onPress={onOpen}
        >
          <Text style={[styles.startDateButtonText, { color: tc.text }]}>
            {value ? safeFormatDate(value.toISOString(), 'P') : notSetLabel}
          </Text>
        </TouchableOpacity>
        {value && (
          <TouchableOpacity
            style={[styles.startDateClear, { borderColor: tc.border }]}
            onPress={onClear}
          >
            <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>{clearLabel}</Text>
          </TouchableOpacity>
        )}
        {value && defaultScheduleTime && onDateOnly && onUseDefaultTime && (
          <TouchableOpacity
            style={[styles.startDateClear, { borderColor: tc.border }]}
            onPress={dateOnly ? onUseDefaultTime : onDateOnly}
          >
            <Text style={[styles.startDateClearText, { color: tc.secondaryText }]}>
              {dateOnly ? defaultScheduleTime : dateOnlyLabel}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
