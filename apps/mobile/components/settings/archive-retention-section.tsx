import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getArchiveRetentionPreview, getDocsGuideUrl, isArchiveRetentionDays, useTaskStore } from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useSettingsLocalization } from './settings.hooks';
import { SettingsGuideLink } from './settings.shell';
import { styles } from './settings.styles';

type Review = { days: number; lines: string[]; counts: string; legacy: string };

export function ArchiveRetentionSection() {
    const tc = useThemeColors();
    const { language, tr } = useSettingsLocalization();
    const days = useTaskStore((state) => {
        const value = state.settings.gtd?.archiveRetentionDays;
        return isArchiveRetentionDays(value) ? value : 0;
    });
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(days > 0 ? String(days) : '');
    const [review, setReview] = useState<Review | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => setDraft(days > 0 ? String(days) : ''), [days]);

    const apply = async (nextDays: number) => {
        setReview(null);
        setBusy(true);
        setError('');
        try {
            const result = await useTaskStore.getState().setArchiveRetentionDays(nextDays);
            if (!result.success) setError(tr('settings.archiveRetentionSaveFailed'));
        } catch {
            setError(tr('settings.archiveRetentionSaveFailed'));
        } finally {
            setBusy(false);
        }
    };

    const save = (nextDays: number) => {
        if (busy || nextDays === days) return;
        setError('');
        if (nextDays > 0 && (days === 0 || nextDays < days)) {
            const state = useTaskStore.getState();
            const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections };
            const preview = getArchiveRetentionPreview(data, nextDays);
            const taskTitles = new Map(data.tasks.map((task) => [task.id, task.title]));
            const projectTitles = new Map(data.projects.map((project) => [project.id, project.title]));
            const sectionTitles = new Map(data.sections.map((section) => [section.id, section.title]));
            setReview({
                days: nextDays,
                lines: [
                    ...preview.projectIds.map((id) => `${tr('projects.title')}: ${projectTitles.get(id) ?? id}`),
                    ...preview.sectionIds.map((id) => `${tr('settings.archiveRetentionSection')}: ${sectionTitles.get(id) ?? id}`),
                    ...preview.taskIds.map((id) => `${tr('calendar.tasks')}: ${taskTitles.get(id) ?? id}`),
                ],
                counts: tr('settings.archiveRetentionCounts', {
                    tasks: preview.taskIds.length,
                    projects: preview.projectIds.length,
                    sections: preview.sectionIds.length,
                }),
                legacy: tr('settings.archiveRetentionLegacyCount', {
                    count: preview.legacyTaskIds.length + preview.legacyProjectIds.length,
                }),
            });
            return;
        }
        void apply(nextDays);
    };

    const current = `${tr('settings.archiveRetentionCurrent')}: ${days > 0 ? tr('settings.archiveRetentionDays', { days }) : tr('settings.archiveRetentionNever')}`;
    const valid = /^[1-9]\d*$/.test(draft) && Number.isSafeInteger(Number(draft)) && Number(draft) <= 36500;
    return (
        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
            <TouchableOpacity
                style={[styles.gtdNavigationRow, { borderTopWidth: 0 }]}
                onPress={() => setOpen((prev) => !prev)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                activeOpacity={0.75}
                testID="archive-retention-disclosure"
            >
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{tr('settings.archiveRetention')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{current}</Text>
                </View>
                <Ionicons
                    name={open ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={tc.secondaryText}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                />
            </TouchableOpacity>
            {open && <View style={{ borderTopWidth: 1, borderTopColor: tc.border, padding: 16 }}>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{tr('settings.archiveRetentionDesc')}</Text>
                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>{tr('settings.archiveRetentionSafety')}</Text>
                <SettingsGuideLink
                    title={tr('settings.archiveRetentionLearnMore')}
                    description={tr('settings.archiveRetention')}
                    url={getDocsGuideUrl('data-sync/data-lifecycle', language)}
                    style={{ marginTop: 8, marginBottom: 0 }}
                    testID="archive-retention-guide-link"
                />
                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 12 }]}>{tr('settings.archiveRetentionDaysLabel')}</Text>
                <TextInput
                    accessibilityLabel={tr('settings.archiveRetentionDaysLabel')}
                    keyboardType="number-pad"
                    value={draft}
                    onChangeText={(value) => { setDraft(value); setError(''); }}
                    style={{ borderWidth: 1, borderColor: tc.border, borderRadius: 8, padding: 10, color: tc.text, marginTop: 6 }}
                />
                {draft && !valid ? <Text accessibilityRole="alert" style={{ color: tc.text, marginTop: 6 }}>{tr('settings.archiveRetentionInvalid')}</Text> : null}
                {error ? <Text accessibilityRole="alert" style={{ color: tc.text, marginTop: 6 }}>{error}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 16, marginTop: 12 }}>
                    <TouchableOpacity accessibilityRole="button" disabled={!valid || busy || Number(draft) === days} onPress={() => save(Number(draft))} style={{ opacity: !valid || busy || Number(draft) === days ? 0.45 : 1 }}>
                        <Text style={[styles.linkText, { color: tc.tint }]}>{tr('settings.archiveRetentionSave')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" disabled={days === 0 || busy} onPress={() => save(0)} style={{ opacity: days === 0 || busy ? 0.45 : 1 }}>
                        <Text style={[styles.linkText, { color: tc.tint }]}>{tr('settings.archiveRetentionNever')}</Text>
                    </TouchableOpacity>
                </View>
            </View>}
            <Modal transparent visible={review !== null} animationType="fade" onRequestClose={() => setReview(null)}>
                <Pressable style={styles.pickerOverlay} onPress={() => setReview(null)}>
                    <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]} onStartShouldSetResponder={() => true}>
                        <Text style={[styles.pickerTitle, { color: tc.text }]}>{tr('settings.archiveRetentionConfirmTitle')}</Text>
                        <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                            <Text style={{ color: tc.text }}>{tr('settings.archiveRetentionConfirmDescription', { days: review?.days ?? 0 })}</Text>
                            <Text style={{ color: tc.text, marginTop: 12 }}>{review?.counts}</Text>
                            <Text style={{ color: tc.text, marginTop: 12 }}>{review?.legacy}</Text>
                            <Text style={{ color: tc.text, marginTop: 12 }}>{review?.lines.length ? tr('settings.archiveRetentionCandidates') : tr('settings.archiveRetentionNoCandidates')}</Text>
                            {review?.lines.map((line, index) => <Text key={index} style={{ color: tc.text, marginTop: 6 }}>{line}</Text>)}
                        </ScrollView>
                        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 24, padding: 16 }}>
                            <TouchableOpacity accessibilityRole="button" onPress={() => setReview(null)}><Text style={{ color: tc.tint }}>{tr('common.cancel')}</Text></TouchableOpacity>
                            <TouchableOpacity accessibilityRole="button" onPress={() => { if (review) void apply(review.days); }}><Text style={{ color: tc.tint }}>{tr('settings.archiveRetentionConfirmAction')}</Text></TouchableOpacity>
                        </View>
                    </View>
                </Pressable>
            </Modal>
        </View>
    );
}
