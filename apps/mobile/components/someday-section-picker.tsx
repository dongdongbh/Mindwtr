import React, { useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { getSomedaySectionChoices, tFallback, type ViewSectionDefinition } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { logError } from '@/lib/app-log';
import { useAndroidKeyboardInset } from '@/lib/use-android-keyboard-inset';

type SomedaySectionPickerProps = {
  sections: readonly ViewSectionDefinition[];
  selectedId?: string;
  selectionMixed?: boolean;
  onSelect: (sectionId: string | undefined) => void;
  onCreate: (title: string) => Promise<string | null>;
  t: (key: string) => string;
  themeColors: ThemeColors;
  optionsStyle?: StyleProp<ViewStyle>;
  optionStyle?: StyleProp<ViewStyle>;
  optionTextStyle?: StyleProp<TextStyle>;
  /** Open the existing name prompt directly from a list-level New section action. */
  createOnly?: boolean;
  onCancelCreate?: () => void;
};

export function SomedaySectionPicker({
  sections,
  selectedId,
  selectionMixed = false,
  onSelect,
  onCreate,
  t,
  themeColors: tc,
  optionsStyle,
  optionStyle,
  optionTextStyle,
  createOnly = false,
  onCancelCreate,
}: SomedaySectionPickerProps) {
  const [createOpen, setCreateOpen] = useState(createOnly);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const keyboardInset = useAndroidKeyboardInset(createOpen);
  const newSectionLabel = `+ ${tFallback(t, 'viewSections.add', 'New section…')}`;
  const nameLabel = tFallback(t, 'viewSections.nameHint', 'Section name');

  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setTitle('');
    setCreateError(false);
    if (createOnly) onCancelCreate?.();
  };

  const createSection = async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(false);
    try {
      const createdId = await onCreate(trimmed);
      if (!createdId) {
        setCreateError(true);
        return;
      }
      onSelect(createdId);
      setCreateOpen(false);
      setTitle('');
    } catch (error) {
      void logError(error, { scope: 'task', extra: { message: 'Failed to create Someday section' } });
      setCreateError(true);
    } finally {
      setCreating(false);
    }
  };

  const options = getSomedaySectionChoices(
    sections,
    selectedId,
    tFallback(t, 'viewSections.noSection', 'No section'),
    selectionMixed,
  );

  return (
    <>
      {!createOnly ? <View style={optionsStyle}>
        {options.map((section) => {
          const { selected } = section;
          return (
            <TouchableOpacity
              key={section.id || 'no-section'}
              accessibilityRole="button"
              accessibilityLabel={section.title}
              accessibilityState={{ selected }}
              onPress={() => onSelect(section.id || undefined)}
              style={[
                optionStyle,
                {
                  backgroundColor: selected ? tc.tint : tc.filterBg,
                  borderColor: selected ? tc.tint : tc.border,
                },
              ]}
            >
              <Text style={[optionTextStyle, { color: selected ? tc.onTint : tc.text }]}>
                {section.title}
              </Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={newSectionLabel}
          onPress={() => {
            setCreateError(false);
            setCreateOpen(true);
          }}
          style={[optionStyle, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
        >
          <Text style={[optionTextStyle, { color: tc.tint }]}>{newSectionLabel}</Text>
        </TouchableOpacity>
      </View> : null}

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={closeCreate} accessibilityViewIsModal>
        <View style={keyboardInset > 0 ? [pickerStyles.overlay, { paddingBottom: keyboardInset }] : pickerStyles.overlay}>
          <View style={[pickerStyles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[pickerStyles.title, { color: tc.text }]} accessibilityRole="header">
              {tFallback(t, 'viewSections.add', 'New section…')}
            </Text>
            <TextInput
              accessibilityLabel={nameLabel}
              autoFocus
              value={title}
              onChangeText={setTitle}
              onSubmitEditing={() => { void createSection(); }}
              placeholder={tFallback(t, 'viewSections.namePlaceholder', 'Books to read')}
              placeholderTextColor={tc.secondaryText}
              style={[pickerStyles.input, { backgroundColor: tc.bg, borderColor: tc.border, color: tc.text }]}
            />
            {createError ? (
              <Text accessibilityRole="alert" style={{ color: tc.danger }}>
                {tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.')}
              </Text>
            ) : null}
            <View style={pickerStyles.actions}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                onPress={closeCreate}
                style={[pickerStyles.button, { borderColor: tc.border }]}
              >
                <Text style={{ color: tc.secondaryText }}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('common.save')}
                disabled={creating || !title.trim()}
                onPress={() => { void createSection(); }}
                style={[pickerStyles.button, { backgroundColor: tc.tint, borderColor: tc.tint }, (creating || !title.trim()) && pickerStyles.disabledButton]}
              >
                <Text style={[pickerStyles.primaryButtonText, { color: tc.onTint }]}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const pickerStyles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  button: { alignItems: 'center', borderRadius: 8, borderWidth: 1, justifyContent: 'center', minHeight: 44, minWidth: 88, paddingHorizontal: 14 },
  card: { borderRadius: 14, borderWidth: 1, gap: 14, padding: 16, width: '88%' },
  disabledButton: { opacity: 0.5 },
  input: { borderRadius: 8, borderWidth: 1, fontSize: 16, minHeight: 44, paddingHorizontal: 12 },
  overlay: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.45)', flex: 1, justifyContent: 'center' },
  primaryButtonText: { fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700' },
});
