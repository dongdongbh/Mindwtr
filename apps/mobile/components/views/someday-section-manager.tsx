import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { sortViewSectionDefinitions, tFallback, type ViewSectionDefinition } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

type SomedaySectionManagerProps = {
  definitions: readonly ViewSectionDefinition[];
  onChange: (definitions: ViewSectionDefinition[]) => void | Promise<void>;
  t: (key: string) => string;
  themeColors: ThemeColors;
};

const makeSectionId = () => `someday-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function SomedaySectionManager({ definitions, onChange, t, themeColors: tc }: SomedaySectionManagerProps) {
  const sorted = useMemo(() => sortViewSectionDefinitions(definitions), [definitions]);
  const [newTitle, setNewTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const addSection = () => {
    const title = newTitle.trim();
    if (!title) return;
    const order = sorted.reduce(
      (maximum, section) => Number.isFinite(section.order) ? Math.max(maximum, section.order) : maximum,
      -1,
    ) + 1;
    void onChange([...sorted, { id: makeSectionId(), title, order }]);
    setNewTitle('');
  };

  const saveRename = () => {
    const title = renameTitle.trim();
    if (!renamingId || !title) return;
    void onChange(sorted.map((section) => section.id === renamingId ? { ...section, title } : section));
    setRenamingId(null);
    setRenameTitle('');
  };

  return (
    <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
      <Text style={[styles.title, { color: tc.text }]}>
        {tFallback(t, 'viewSections.somedaySections', 'Someday sections')}
      </Text>
      <Text style={[styles.hint, { color: tc.secondaryText }]}>
        {tFallback(t, 'viewSections.manageHint', 'Organize ideas without changing their projects or project sections.')}
      </Text>

      {sorted.map((section) => (
        <View key={section.id} style={styles.row}>
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
            <Text style={[styles.sectionTitle, { color: tc.text }]}>{section.title}</Text>
          )}
          {renamingId === section.id ? (
            <TouchableOpacity accessibilityRole="button" onPress={saveRename}>
              <Text style={[styles.action, { color: tc.tint }]}>{t('common.save')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`${tFallback(t, 'viewSections.rename', 'Rename section')}: ${section.title}`}
              onPress={() => {
                setRenamingId(section.id);
                setRenameTitle(section.title);
              }}
            >
              <Text style={[styles.action, { color: tc.tint }]}>{tFallback(t, 'common.rename', 'Rename')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${t('common.delete')}: ${section.title}`}
            onPress={() => { void onChange(sorted.filter((candidate) => candidate.id !== section.id)); }}
          >
            <Text style={[styles.action, { color: tc.danger }]}>{t('common.delete')}</Text>
          </TouchableOpacity>
        </View>
      ))}

      <View style={styles.row}>
        <TextInput
          accessibilityLabel={tFallback(t, 'viewSections.nameHint', 'Section name')}
          placeholder={tFallback(t, 'viewSections.namePlaceholder', 'Books to read')}
          placeholderTextColor={tc.secondaryText}
          value={newTitle}
          onChangeText={setNewTitle}
          onSubmitEditing={addSection}
          style={[styles.input, { borderColor: tc.border, color: tc.text, backgroundColor: tc.bg }]}
        />
        <TouchableOpacity accessibilityRole="button" onPress={addSection}>
          <Text style={[styles.action, { color: tc.tint }]}>{tFallback(t, 'viewSections.add', 'Add section')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  action: { fontSize: 13, fontWeight: '600' },
  card: { borderRadius: 12, borderWidth: 1, marginBottom: 8, padding: 12 },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: 10 },
  input: { borderRadius: 8, borderWidth: 1, flex: 1, fontSize: 14, paddingHorizontal: 10, paddingVertical: 7 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 8 },
  sectionTitle: { flex: 1, fontSize: 14, fontWeight: '500' },
  title: { fontSize: 15, fontWeight: '700', marginBottom: 3 },
});
