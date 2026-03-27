import React, { useState } from 'react';
import { Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTaskStore } from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

export function ManageSettingsScreen() {
    const tc = useThemeColors();
    const { localize, t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const areas = useTaskStore((state) => state.areas);
    const derivedState = useTaskStore((state) => state.getDerivedState());
    const deleteArea = useTaskStore((state) => state.deleteArea);
    const updateArea = useTaskStore((state) => state.updateArea);
    const deleteTag = useTaskStore((state) => state.deleteTag);
    const renameTag = useTaskStore((state) => state.renameTag);
    const deleteContext = useTaskStore((state) => state.deleteContext);
    const renameContext = useTaskStore((state) => state.renameContext);
    const sortedAreas = [...areas].sort((a, b) => a.order - b.order);
    const { allContexts, allTags } = derivedState;

    const localize2 = (en: string, zh: string) => localize(en, zh);
    const confirmDelete = (label: string, onConfirm: () => void) => {
        Alert.alert(
            localize2('Delete', '删除'),
            localize2(`Delete "${label}"?`, `删除"${label}"？`),
            [
                { text: localize2('Cancel', '取消'), style: 'cancel' },
                { text: localize2('Delete', '删除'), style: 'destructive', onPress: onConfirm },
            ],
        );
    };

    const promptRename = (currentValue: string, onRename: (newValue: string) => void) => {
        Alert.prompt(
            localize2('Rename', '重命名'),
            undefined,
            [
                { text: localize2('Cancel', '取消'), style: 'cancel' },
                {
                    text: localize2('Save', '保存'),
                    onPress: (newValue: string | undefined) => {
                        const trimmed = (newValue ?? '').trim();
                        if (trimmed && trimmed !== currentValue) {
                            onRename(trimmed);
                        }
                    },
                },
            ],
            'plain-text',
            currentValue,
        );
    };

    const ManageRow = ({ label, onRename, onDelete }: { label: string; onRename?: () => void; onDelete: () => void }) => (
        <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}>
            <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>{label}</Text>
            {onRename && (
                <TouchableOpacity onPress={onRename} style={{ padding: 8 }}>
                    <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onDelete} style={{ padding: 8 }}>
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </TouchableOpacity>
        </View>
    );

    const AreaRow = ({ area }: { area: typeof sortedAreas[number] }) => (
        <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}>
            <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: area.color || '#94a3b8', marginRight: 12 }} />
            <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>{area.name}</Text>
            <TouchableOpacity
                onPress={() => promptRename(area.name, (name) => void updateArea(area.id, { name }))}
                style={{ padding: 8 }}
            >
                <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
            </TouchableOpacity>
            <TouchableOpacity
                onPress={() => confirmDelete(area.name, () => void deleteArea(area.id))}
                style={{ padding: 8 }}
            >
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </TouchableOpacity>
        </View>
    );

    const CollapsibleSection = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => {
        const [open, setOpen] = useState(false);
        return (
            <View style={{ marginBottom: 16 }}>
                <TouchableOpacity
                    onPress={() => setOpen((prev) => !prev)}
                    style={[
                        styles.settingCard,
                        {
                            backgroundColor: tc.cardBg,
                            flexDirection: 'row',
                            alignItems: 'center',
                            padding: 16,
                        },
                    ]}
                >
                    <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={tc.secondaryText} />
                    <Text style={[styles.settingLabel, { color: tc.text, flex: 1, marginLeft: 8 }]}>{title}</Text>
                    <Text style={{ fontSize: 13, color: tc.secondaryText }}>{count}</Text>
                </TouchableOpacity>
                {open && <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 1 }]}>{children}</View>}
            </View>
        );
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.manage')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <CollapsibleSection title={t('areas.manage')} count={sortedAreas.length}>
                    {sortedAreas.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('projects.noArea')}</Text>
                        </View>
                    )}
                    {sortedAreas.map((area) => (
                        <AreaRow key={area.id} area={area} />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title={t('contexts.title')} count={allContexts.length}>
                    {allContexts.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {localize2('No contexts', '无情境')}
                            </Text>
                        </View>
                    )}
                    {allContexts.map((ctx) => (
                        <ManageRow
                            key={ctx}
                            label={ctx}
                            onRename={() => promptRename(ctx, (newVal) => void renameContext(ctx, newVal))}
                            onDelete={() => confirmDelete(ctx, () => void deleteContext(ctx))}
                        />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title={localize2('Tags', '标签')} count={allTags.length}>
                    {allTags.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('projects.noTags')}</Text>
                        </View>
                    )}
                    {allTags.map((tag) => (
                        <ManageRow
                            key={tag}
                            label={tag}
                            onRename={() => promptRename(tag, (newVal) => void renameTag(tag, newVal))}
                            onDelete={() => confirmDelete(tag, () => void deleteTag(tag))}
                        />
                    ))}
                </CollapsibleSection>
            </ScrollView>
        </SafeAreaView>
    );
}
