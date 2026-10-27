import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { getChecklistMoveTargets, tFallback, useTaskStore } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useAndroidKeyboardInset } from '@/lib/use-android-keyboard-inset';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { styles } from '../task-edit/task-edit-modal.styles';

type ChecklistTargetPickerProps = {
    sourceId: string;
    tc: Pick<ThemeColors, 'border' | 'cardBg' | 'inputBg' | 'secondaryText' | 'text'>;
    t: (key: string) => string;
    onClose: () => void;
    onSelect: (targetId: string) => void;
};

/**
 * Add to checklist's task picker (#1467): open tasks, ones that already have a checklist first, searched by title.
 * Mounted only while open, so rows do not subscribe to every task change.
 */
export function ChecklistTargetPicker({ sourceId, tc, t, onClose, onSelect }: ChecklistTargetPickerProps) {
    const [query, setQuery] = useState('');
    const tasks = useTaskStore((state) => state.tasks);
    const targets = useMemo(() => getChecklistMoveTargets(tasks, sourceId, query), [query, sourceId, tasks]);
    const keyboardInset = useAndroidKeyboardInset(true);
    const reducedMotion = useReducedMotion();
    const title = tFallback(t, 'task.addToChecklist', 'Add to checklist…');

    return (
        <Modal visible transparent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={onClose} accessibilityViewIsModal>
            <View style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}>
                <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[styles.modalTitle, { color: tc.text }]} accessibilityRole="header">{title}</Text>
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('common.search')}
                        placeholderTextColor={tc.secondaryText}
                        style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        accessibilityLabel={t('common.search')}
                    />
                    <ScrollView
                        style={[styles.pickerList, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                        contentContainerStyle={{ paddingVertical: 4 }}
                        keyboardShouldPersistTaps="handled"
                    >
                        {targets.map((target) => (
                            <Pressable
                                key={target.id}
                                onPress={() => {
                                    onSelect(target.id);
                                    onClose();
                                }}
                                style={[styles.pickerItem, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}
                                accessibilityRole="button"
                                accessibilityLabel={target.title}
                            >
                                <Text style={[styles.pickerItemText, { color: tc.text, flex: 1 }]} numberOfLines={2}>{target.title}</Text>
                                {target.checklist?.length ? (
                                    <Text style={[styles.pickerItemText, { color: tc.secondaryText }]}>
                                        {target.checklist.filter((item) => item.isCompleted).length}/{target.checklist.length}
                                    </Text>
                                ) : null}
                            </Pressable>
                        ))}
                        {targets.length === 0 ? (
                            <View style={styles.pickerItem}>
                                <Text style={[styles.pickerItemText, { color: tc.secondaryText }]} accessibilityLiveRegion="polite">
                                    {t('common.noMatches')}
                                </Text>
                            </View>
                        ) : null}
                    </ScrollView>
                    <View style={styles.modalButtons}>
                        <TouchableOpacity onPress={onClose} style={styles.modalButton} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
