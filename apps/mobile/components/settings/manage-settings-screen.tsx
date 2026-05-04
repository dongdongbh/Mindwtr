import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR, type Area, useTaskStore } from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

type ManageSectionKey = 'areas' | 'contexts' | 'tags';
const MANAGE_OPEN_SECTIONS_STORAGE_KEY = 'mindwtr:settings:manage:openSections';
const DEFAULT_OPEN_SECTIONS: Record<ManageSectionKey, boolean> = {
    areas: false,
    contexts: false,
    tags: false,
};

const normalizeOpenSections = (value: unknown): Record<ManageSectionKey, boolean> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ...DEFAULT_OPEN_SECTIONS };
    }
    const record = value as Record<string, unknown>;
    return {
        areas: record.areas === true,
        contexts: record.contexts === true,
        tags: record.tags === true,
    };
};

function CollapsibleSection({
    children,
    count,
    onToggle,
    open,
    tc,
    testID,
    title,
}: {
    children: React.ReactNode;
    count: number;
    onToggle: () => void;
    open: boolean;
    tc: ReturnType<typeof useThemeColors>;
    testID?: string;
    title: string;
}) {
    return (
        <View style={{ marginBottom: 16 }}>
            <TouchableOpacity
                testID={testID}
                onPress={onToggle}
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
}

export function ManageSettingsScreen() {
    const tc = useThemeColors();
    const { localize, t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const areas = useTaskStore((state) => state.areas);
    const settings = useTaskStore((state) => state.settings);
    const derivedState = useTaskStore((state) => state.getDerivedState());
    const deleteArea = useTaskStore((state) => state.deleteArea);
    const updateArea = useTaskStore((state) => state.updateArea);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const deleteTag = useTaskStore((state) => state.deleteTag);
    const renameTag = useTaskStore((state) => state.renameTag);
    const deleteContext = useTaskStore((state) => state.deleteContext);
    const renameContext = useTaskStore((state) => state.renameContext);
    const sortedAreas = [...areas].sort((a, b) => a.order - b.order);
    const { allContexts, allTags } = derivedState;
    const [editorTarget, setEditorTarget] = useState<
        | { type: 'area'; id: string; name: string; color?: string }
        | { type: 'unassignedArea'; color?: string }
        | { type: 'context' | 'tag'; name: string }
        | null
    >(null);
    const [editorName, setEditorName] = useState('');
    const [editorColor, setEditorColor] = useState(DEFAULT_AREA_COLOR);
    const [openSections, setOpenSections] = useState<Record<ManageSectionKey, boolean>>(() => ({ ...DEFAULT_OPEN_SECTIONS }));
    const openSectionsHydratedRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        AsyncStorage.getItem(MANAGE_OPEN_SECTIONS_STORAGE_KEY)
            .then((raw) => {
                if (cancelled) return;
                if (raw) {
                    try {
                        setOpenSections(normalizeOpenSections(JSON.parse(raw)));
                    } catch {
                        setOpenSections({ ...DEFAULT_OPEN_SECTIONS });
                    }
                }
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) {
                    openSectionsHydratedRef.current = true;
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!openSectionsHydratedRef.current) return;
        AsyncStorage.setItem(MANAGE_OPEN_SECTIONS_STORAGE_KEY, JSON.stringify(openSections)).catch(() => {});
    }, [openSections]);

    const localize2 = (en: string, zh: string) => localize(en, zh);
    const resolveText = (key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    };
    const unassignedAreaLabel = resolveText('review.unassigned', 'Unassigned');
    const unassignedAreaColorLabel = localize2('Unassigned color', '未分配颜色');
    const unassignedAreaDescription = localize2('Used for tasks and projects without an area.', '用于没有领域的任务和项目。');
    const unassignedAreaColor = settings.appearance?.unassignedAreaColor || DEFAULT_AREA_COLOR;
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

    const closeEditor = () => {
        setEditorTarget(null);
        setEditorName('');
        setEditorColor(DEFAULT_AREA_COLOR);
    };

    const openUnassignedAreaEditor = () => {
        setEditorTarget({ type: 'unassignedArea', color: unassignedAreaColor });
        setEditorName('');
        setEditorColor(unassignedAreaColor);
    };

    const openValueEditor = (type: 'context' | 'tag', name: string) => {
        setEditorTarget({ type, name });
        setEditorName(name);
        setEditorColor(DEFAULT_AREA_COLOR);
    };

    const openAreaEditor = (area: Area) => {
        setEditorTarget({ type: 'area', id: area.id, name: area.name, color: area.color });
        setEditorName(area.name);
        setEditorColor(area.color || DEFAULT_AREA_COLOR);
    };

    const saveEditor = async () => {
        if (!editorTarget) return;
        const trimmed = editorName.trim();

        if (editorTarget.type === 'unassignedArea') {
            await updateSettings({
                appearance: {
                    ...(settings.appearance ?? {}),
                    unassignedAreaColor: editorColor,
                },
            });
            closeEditor();
            return;
        }

        if (!trimmed) return;

        if (editorTarget.type === 'area') {
            const updates: Partial<Area> = {};
            if (trimmed !== editorTarget.name) {
                updates.name = trimmed;
            }
            if (editorColor !== (editorTarget.color || DEFAULT_AREA_COLOR)) {
                updates.color = editorColor;
            }
            if (Object.keys(updates).length > 0) {
                await updateArea(editorTarget.id, updates);
            }
            closeEditor();
            return;
        }

        if (trimmed === editorTarget.name) {
            closeEditor();
            return;
        }

        if (editorTarget.type === 'context') {
            void renameContext(editorTarget.name, trimmed);
        } else {
            void renameTag(editorTarget.name, trimmed);
        }
        closeEditor();
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

    const UnassignedAreaRow = () => (
        <View
            testID="manage-unassigned-area-color"
            style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}
        >
            <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: unassignedAreaColor, marginRight: 12 }} />
            <View style={{ flex: 1 }}>
                <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>{unassignedAreaLabel}</Text>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                    {unassignedAreaDescription}
                </Text>
            </View>
            <TouchableOpacity
                onPress={openUnassignedAreaEditor}
                style={{ padding: 8 }}
            >
                <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
            </TouchableOpacity>
        </View>
    );

    const AreaRow = ({ area }: { area: typeof sortedAreas[number] }) => (
        <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}>
            <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: area.color || DEFAULT_AREA_COLOR, marginRight: 12 }} />
            <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>{area.name}</Text>
            <TouchableOpacity
                onPress={() => openAreaEditor(area)}
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

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.manage')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <CollapsibleSection
                    testID="manage-section-toggle-areas"
                    title={t('areas.manage')}
                    count={sortedAreas.length}
                    open={openSections.areas}
                    onToggle={() => setOpenSections((current) => ({ ...current, areas: !current.areas }))}
                    tc={tc}
                >
                    <UnassignedAreaRow />
                    {sortedAreas.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('projects.noArea')}</Text>
                        </View>
                    )}
                    {sortedAreas.map((area) => (
                        <AreaRow key={area.id} area={area} />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-contexts"
                    title={t('contexts.title')}
                    count={allContexts.length}
                    open={openSections.contexts}
                    onToggle={() => setOpenSections((current) => ({ ...current, contexts: !current.contexts }))}
                    tc={tc}
                >
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
                            onRename={() => openValueEditor('context', ctx)}
                            onDelete={() => confirmDelete(ctx, () => void deleteContext(ctx))}
                        />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-tags"
                    title={localize2('Tags', '标签')}
                    count={allTags.length}
                    open={openSections.tags}
                    onToggle={() => setOpenSections((current) => ({ ...current, tags: !current.tags }))}
                    tc={tc}
                >
                    {allTags.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('projects.noTags')}</Text>
                        </View>
                    )}
                    {allTags.map((tag) => (
                        <ManageRow
                            key={tag}
                            label={tag}
                            onRename={() => openValueEditor('tag', tag)}
                            onDelete={() => confirmDelete(tag, () => void deleteTag(tag))}
                        />
                    ))}
                </CollapsibleSection>
            </ScrollView>
            <Modal
                visible={Boolean(editorTarget)}
                transparent
                animationType="fade"
                onRequestClose={closeEditor}
            >
                <Pressable style={styles.pickerOverlay} onPress={closeEditor}>
                    <Pressable
                        style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                        onPress={(event) => event.stopPropagation()}
                    >
                        <Text style={[styles.pickerTitle, { color: tc.text }]}>
                            {editorTarget?.type === 'area'
                                ? localize2('Edit area', '编辑领域')
                                : editorTarget?.type === 'unassignedArea'
                                    ? unassignedAreaColorLabel
                                : localize2('Rename', '重命名')}
                        </Text>
                        {editorTarget?.type !== 'unassignedArea' ? (
                            <TextInput
                                value={editorName}
                                onChangeText={setEditorName}
                                placeholder={
                                    editorTarget?.type === 'area'
                                        ? t('projects.areaLabel')
                                        : localize2('Name', '名称')
                                }
                                placeholderTextColor={tc.secondaryText}
                                style={[
                                    styles.textInput,
                                    {
                                        marginTop: 0,
                                        backgroundColor: tc.bg,
                                        borderColor: tc.border,
                                        color: tc.text,
                                    },
                                ]}
                                autoFocus
                            />
                        ) : null}
                        {editorTarget?.type === 'area' || editorTarget?.type === 'unassignedArea' ? (
                            <View style={styles.manageColorPicker}>
                                {AREA_PRESET_COLORS.map((color) => (
                                    <TouchableOpacity
                                        key={color}
                                        onPress={() => setEditorColor(color)}
                                        style={[
                                            styles.manageColorOption,
                                            { backgroundColor: color },
                                            editorColor === color && styles.manageColorOptionSelected,
                                        ]}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${t('projects.changeColor')}: ${color}`}
                                    >
                                        {editorColor === color ? (
                                            <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                                        ) : null}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        ) : null}
                        <View style={styles.manageEditorActions}>
                            <TouchableOpacity
                                onPress={closeEditor}
                                style={[styles.manageEditorButton, { borderColor: tc.border }]}
                            >
                                <Text style={[styles.manageEditorButtonText, { color: tc.secondaryText }]}>
                                    {localize2('Cancel', '取消')}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                testID="manage-editor-save"
                                disabled={editorTarget?.type !== 'unassignedArea' && !editorName.trim()}
                                onPress={() => {
                                    void saveEditor();
                                }}
                                style={[
                                    styles.manageEditorButton,
                                    styles.manageEditorButtonPrimary,
                                    editorTarget?.type !== 'unassignedArea' && !editorName.trim() && styles.manageEditorButtonDisabled,
                                ]}
                            >
                                <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>
                                    {localize2('Save', '保存')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </SafeAreaView>
    );
}
