import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { sortViewSectionDefinitions, tFallback, type ViewSectionDefinition } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

type SomedaySectionManagerProps = {
  definitions: readonly ViewSectionDefinition[];
  onChange: (definitions: ViewSectionDefinition[]) => void | Promise<void>;
  onDelete: (id: string) => void;
  t: (key: string) => string;
  themeColors: ThemeColors;
};

export function SomedaySectionManager({ definitions, onChange, onDelete, t, themeColors: tc }: SomedaySectionManagerProps) {
  const sorted = useMemo(() => sortViewSectionDefinitions(definitions), [definitions]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const saveRename = () => {
    const title = renameTitle.trim();
    if (!renamingId || !title) return;
    void onChange(sorted.map((section) => section.id === renamingId ? { ...section, title } : section));
    setRenamingId(null);
    setRenameTitle('');
  };

  const moveSection = (index: number, offset: -1 | 1) => {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= sorted.length) return;
    const reordered = [...sorted];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    void onChange(reordered.map((section, order) => ({ ...section, order })));
  };

  return (
    <View>
      {sorted.map((section, index) => (
        <View key={section.id} style={[styles.row, { borderBottomColor: tc.border }]}>
          {renamingId === section.id ? (
            <TextInput
              accessibilityLabel={tFallback(t, 'viewSections.nameHint', 'Section name')}
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
            accessibilityLabel={`${tFallback(t, 'projects.moveUp', 'Move up')}: ${section.title}`}
            disabled={index === 0}
            hitSlop={{ top: 10, right: 6, bottom: 10, left: 6 }}
            onPress={() => moveSection(index, -1)}
            style={[styles.iconButton, index === 0 && styles.disabled]}
          >
            <Ionicons name="chevron-up" size={18} color={tc.secondaryText} />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${tFallback(t, 'projects.moveDown', 'Move down')}: ${section.title}`}
            disabled={index === sorted.length - 1}
            hitSlop={{ top: 10, right: 6, bottom: 10, left: 6 }}
            onPress={() => moveSection(index, 1)}
            style={[styles.iconButton, index === sorted.length - 1 && styles.disabled]}
          >
            <Ionicons name="chevron-down" size={18} color={tc.secondaryText} />
          </TouchableOpacity>
          {renamingId === section.id ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.save')} onPress={saveRename} style={styles.iconButton}>
              <Ionicons name="checkmark" size={18} color={tc.tint} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`${tFallback(t, 'viewSections.rename', 'Rename section')}: ${section.title}`}
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
            accessibilityLabel={`${t('common.delete')}: ${section.title}`}
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
