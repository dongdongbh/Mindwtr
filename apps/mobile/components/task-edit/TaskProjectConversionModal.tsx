import React, { useState } from 'react';
import { Modal, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { checklistProjectBlockReason, type Task } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { useThemeColors } from '../../hooks/use-theme-colors';
import { useKeyboardInset } from '../../lib/use-android-keyboard-inset';
import { styles } from './task-edit-modal.styles';

export function TaskProjectConversionModal({ task, onConfirm, onClose }: {
    task: Task; onConfirm: (title: string, expand: boolean) => Promise<void>; onClose: () => void;
}) {
    const { t } = useLanguage();
    const tc = useThemeColors();
    const [title, setTitle] = useState(task.title);
    const [expand, setExpand] = useState(false);
    const [busy, setBusy] = useState(false);
    const inset = useKeyboardInset(true);
    const blocked = checklistProjectBlockReason(task);
    return <Modal transparent animationType="fade" onRequestClose={busy ? () => {} : onClose}>
        <View style={[styles.overlay, inset > 0 && { paddingBottom: inset }]}>
            <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border, maxHeight: '100%' }]}>
                <Text style={[styles.modalTitle, { color: tc.text }]}>{t('task.createProjectFromTask')}</Text>
                <ScrollView keyboardShouldPersistTaps="handled">
                    <Text style={{ color: tc.text }}>{t('projects.projectName')}</Text>
                    <TextInput value={title} onChangeText={setTitle} editable={!busy}
                        accessibilityLabel={t('projects.projectName')}
                        style={[styles.modalInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.inputBg }]} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
                        <Text style={{ color: tc.text, flex: 1 }}>{t('task.expandChecklist')}</Text>
                        <Switch value={expand} onValueChange={setExpand} disabled={busy || (!!blocked && !expand)}
                            accessibilityLabel={t('task.expandChecklist')} />
                    </View>
                    <Text style={{ color: tc.secondaryText, marginVertical: 12 }}>{t(expand ? 'task.expandChecklistDescription' : 'task.keepChecklistDescription')}</Text>
                    {blocked && <Text style={{ color: tc.secondaryText }}>{t(blocked)}</Text>}
                </ScrollView>
                <View style={styles.modalButtons}>
                    <TouchableOpacity accessibilityRole="button" style={styles.modalButton} disabled={busy} onPress={onClose}>
                        <Text style={{ color: tc.secondaryText }}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" style={styles.modalButton} disabled={busy || !title.trim() || (expand && !!blocked)} onPress={async () => {
                        setBusy(true);
                        try { await onConfirm(title.trim(), expand); } finally { setBusy(false); }
                    }}>
                        <Text style={{ color: tc.tint }}>{t('task.createProjectFromTask')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    </Modal>;
}
