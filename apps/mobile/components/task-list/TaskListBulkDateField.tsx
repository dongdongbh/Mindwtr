import React from 'react';
import { Keyboard, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'lucide-react-native';
import { buildBulkOrganizeDateFieldModel, safeParseDate, toBulkOrganizeDateValue } from '@mindwtr/core';

import { QuickDateChips } from '../QuickDateChips';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { styles } from './task-list.styles';

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  pickerVisible: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  disabled: boolean;
  t: (key: string) => string;
  tc: Pick<ThemeColors, 'tint' | 'onTint' | 'filterBg' | 'border' | 'secondaryText' | 'inputBg' | 'text'>;
};

export function TaskListBulkDateField({
  label, value, onChange, pickerVisible, onOpenPicker, onClosePicker, disabled, t, tc,
}: Props) {
  const [editing, setEditing] = React.useState(false);
  const selectedDate = safeParseDate(value);
  // Display value, labels and the stored day come from core, as the native host shows them.
  const field = buildBulkOrganizeDateFieldModel({ label, value, now: new Date(), t });
  const selectDate = (date: Date | null) => {
    if (disabled) return;
    // Bulk dates are date-only: never introduce a time or convert through UTC.
    onChange(toBulkOrganizeDateValue(date));
  };

  return (
    <View style={styles.bulkOrganizeDateField}>
      <Text style={[styles.bulkOrganizeLabel, { color: tc.secondaryText }]}>{label}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          accessibilityLabel={label}
          value={editing ? value : field.displayValue}
          onChangeText={onChange}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          editable={!disabled}
          placeholder={field.placeholder}
          placeholderTextColor={tc.secondaryText}
          style={[
            styles.bulkOrganizeInput,
            { flex: 1, backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text },
          ]}
        />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={field.calendarAccessibilityLabel}
          accessibilityState={{ disabled, expanded: pickerVisible }}
          disabled={disabled}
          onPress={() => {
            Keyboard.dismiss();
            onOpenPicker();
          }}
          style={[
            styles.bulkOrganizeInput,
            {
              minWidth: 44,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderColor: tc.border,
              backgroundColor: tc.inputBg,
            },
          ]}
        >
          <Calendar size={18} color={tc.secondaryText} accessible={false} />
        </TouchableOpacity>
      </View>
      <QuickDateChips
        t={t}
        tc={tc}
        disabled={disabled}
        accessibilityLabelPrefix={label}
        selectedDate={selectedDate}
        presets={['today', 'tomorrow']}
        chipStyle={{ minWidth: 44, minHeight: 44 }}
        onSelect={(date) => {
          selectDate(date);
          onClosePicker();
        }}
        style={{ marginTop: 0 }}
      />
      {pickerVisible && !disabled && (
        <View>
          {Platform.OS === 'ios' && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={field.doneLabel}
              onPress={onClosePicker}
              style={{ minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
            >
              <Text style={{ color: tc.tint }}>{field.doneText}</Text>
            </TouchableOpacity>
          )}
          <DateTimePicker
            value={selectedDate ?? new Date()}
            mode="date"
            display={Platform.OS === 'ios' ? 'inline' : 'default'}
            textColor={tc.text}
            onChange={(event, date) => {
              if (event.type === 'dismissed') {
                onClosePicker();
                return;
              }
              if (Platform.OS !== 'ios') onClosePicker();
              if (date) selectDate(date);
            }}
          />
        </View>
      )}
    </View>
  );
}
