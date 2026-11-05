import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  buildSomedaySectionManagerRows,
  getSomedaySectionManagerText,
  moveSomedaySection,
  renameSomedaySection,
  type ViewSectionDefinition,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

type SomedaySectionManagerProps = {
  definitions: readonly ViewSectionDefinition[];
  onChange: (definitions: ViewSectionDefinition[]) => void | Promise<void>;
  onDelete: (id: string) => void;
  t: (key: string) => string;
  themeColors: ThemeColors;
};

export function SomedaySectionManager({ definitions, onChange, onDelete, t, themeColors: tc }: SomedaySectionManagerProps) {

  const rows = useMemo(() => buildSomedaySectionManagerRows(definitions, t), [definitions, t]);
  const text = getSomedaySectionManagerText(t);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const saveRename = () => {
    if (!renamingId) return;
    const next = renameSomedaySection(definitions, renamingId, renameTitle);
    if (!next) return;
    void onChange(next);
    setRenamingId(null);
    setRenameTitle('');
  };

  const moveSection = (id: string, offset: -1 | 1) => {
    const next = moveSomedaySection(definitions, id, offset);
    if (next) void onChange(next);
  };

  return (
    <View>
      {rows.map((section) => (
        <View key={section.id} style={[styles.row, { borderBottomColor: tc.border }]}>
          {renamingId === section.id ? (
            <TextInput
              accessibilityLabel={text.nameLabel}
              autoFocus
              value={renameTitle}
              onChangeText={setRenameTitle}
              onSubmitEditing={saveRename}
              style={[styles.input, { borderColor: tc.border, color: tc.text, backgroundColor: tc.bg }]}
            />
          ) : (
            <Text style={[styles.sectionTitle, { color: tc.text }]} numberOfLines={1}>{section.title}</Text>
          )}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={section.moveUp.label}
            disabled={section.moveUp.disabled}
            hitSlop={{ top: 10, right: 6, bottom: 10, left: 6 }}
            onPress={() => moveSection(section.id, -1)}
            style={[styles.iconButton, section.moveUp.disabled && styles.disabled]}
          >
            <Ionicons name="chevron-up" size={18} color={tc.secondaryText} />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={section.moveDown.label}
            disabled={section.moveDown.disabled}
            hitSlop={{ top: 10, right: 6, bottom: 10, left: 6 }}
            onPress={() => moveSection(section.id, 1)}
            style={[styles.iconButton, section.moveDown.disabled && styles.disabled]}
          >
            <Ionicons name="chevron-down" size={18} color={tc.secondaryText} />
          </TouchableOpacity>
          {renamingId === section.id ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={text.saveLabel} onPress={saveRename} style={styles.iconButton}>
              <Ionicons name="checkmark" size={18} color={tc.tint} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={section.renameLabel}
              onPress={() => {
                setRenamingId(section.id);
                setRenameTitle(section.title);
              }}
              style={styles.iconButton}
            >
              <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={section.deleteLabel}
            onPress={() => onDelete(section.id)}
            style={styles.iconButton}
          >
            <Ionicons name="trash-outline" size={18} color={tc.danger} />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.35 },
  iconButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 36 },
  input: { borderRadius: 8, borderWidth: 1, flex: 1, fontSize: 14, paddingHorizontal: 10, paddingVertical: 7 },
  row: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', gap: 4, minHeight: 52, paddingHorizontal: 12 },
  sectionTitle: { flex: 1, fontSize: 14, fontWeight: '500' },
});
