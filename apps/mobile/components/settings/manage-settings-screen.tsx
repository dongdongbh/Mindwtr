import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    AREA_PRESET_COLORS,
    DEFAULT_AREA_COLOR,
    formatI18nTemplate,
    getPersonNameKey,
    sortViewSectionDefinitions,
    type Area,
    type Person,
    useTaskStore,
    baseTextCollator,
} from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';
import { SomedaySectionManager } from '../views/someday-section-manager';

type ManageSectionKey = 'areas' | 'people' | 'somedaySections' | 'contexts' | 'tags';
const MANAGE_OPEN_SECTIONS_STORAGE_KEY = 'mindwtr:settings:manage:openSections';
const DEFAULT_OPEN_SECTIONS: Record<ManageSectionKey, boolean> = {
    areas: false,
    people: false,
    somedaySections: false,
    contexts: false,
    tags: false,
};

const SAFE_PERSON_REFERENCE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'obsidian:']);

const isSafePersonReferenceLink = (value: string | undefined): value is string => {
    const trimmed = value?.trim();
    if (!trimmed) return false;
    try {
        const url = new URL(trimmed);
        return SAFE_PERSON_REFERENCE_PROTOCOLS.has(url.protocol);
    } catch {
        return false;
    }
};

const normalizeOpenSections = (value: unknown): Record<ManageSectionKey, boolean> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ...DEFAULT_OPEN_SECTIONS };
    }
    const record = value as Record<string, unknown>;
    return {
        areas: record.areas === true,
        people: record.people === true,
        somedaySections: record.somedaySections === true,
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
    const { t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const areas = useTaskStore((state) => state.areas);
    const people = useTaskStore((state) => state.people);
    const settings = useTaskStore((state) => state.settings);
    const tasks = useTaskStore((state) => state.tasks);
    const derivedState = useTaskStore((state) => state.getDerivedState());
    const addArea = useTaskStore((state) => state.addArea);
    const deleteArea = useTaskStore((state) => state.deleteArea);
    const updateArea = useTaskStore((state) => state.updateArea);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const deleteTag = useTaskStore((state) => state.deleteTag);
    const renameTag = useTaskStore((state) => state.renameTag);
    const deleteContext = useTaskStore((state) => state.deleteContext);
    const renameContext = useTaskStore((state) => state.renameContext);
    const addPerson = useTaskStore((state) => state.addPerson);
    const updatePerson = useTaskStore((state) => state.updatePerson);
    const renamePerson = useTaskStore((state) => state.renamePerson);
    const deletePerson = useTaskStore((state) => state.deletePerson);
    const sortedAreas = [...areas].sort((a, b) => a.order - b.order);
    const sortedPeople = useMemo(
        () => [...people].sort((a, b) => baseTextCollator.compare(a.name, b.name)),
        [people],
    );
    const somedaySections = useMemo(
        () => sortViewSectionDefinitions(settings.gtd?.viewSections?.someday),
        [settings.gtd?.viewSections?.someday],
    );
    const assignedTaskCountByPerson = useMemo(() => {
        const counts = new Map<string, number>();
        tasks.forEach((task) => {
            if (task.deletedAt) return;
            const key = getPersonNameKey(task.assignedTo);
            if (!key) return;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        });
        return counts;
    }, [tasks]);
    const { allContexts, allTags } = derivedState;
    const [editorTarget, setEditorTarget] = useState<
        | { type: 'area'; id: string; name: string; color?: string }
        | { type: 'newArea' }
        | { type: 'unassignedArea'; color?: string }
        | { type: 'newPerson' }
        | { type: 'person'; id: string; name: string; note?: string; referenceLink?: string }
        | { type: 'context' | 'tag'; name: string }
        | null
    >(null);
    const [editorName, setEditorName] = useState('');
    const [editorColor, setEditorColor] = useState(DEFAULT_AREA_COLOR);
    const [editorNote, setEditorNote] = useState('');
    const [editorReferenceLink, setEditorReferenceLink] = useState('');
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

    const resolveText = (key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    };
    const unassignedAreaLabel = resolveText('review.unassigned', 'Unassigned');
    const unassignedAreaColorLabel = t('settings.unassignedAreaColor');
    const unassignedAreaDescription = t('settings.unassignedAreaColorDesc');
    const unassignedAreaColor = settings.appearance?.unassignedAreaColor || DEFAULT_AREA_COLOR;
    const confirmDelete = (label: string, onConfirm: () => void, messageKey = 'settings.deleteNamed') => {
        const fallback = messageKey === 'areas.deleteConfirm'
            ? 'Delete this area? Projects and tasks in this area will be kept and moved to unassigned.'
            : messageKey === 'people.deleteConfirm'
                ? 'Delete this person? Tasks assigned to them will be kept and moved to unassigned.'
                : 'Delete \"{{name}}\"?';
        Alert.alert(
            t('common.delete'),
            formatI18nTemplate(resolveText(messageKey, fallback), { name: label }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('common.delete'), style: 'destructive', onPress: onConfirm },
            ],
        );
    };

    const closeEditor = () => {
        setEditorTarget(null);
        setEditorName('');
        setEditorColor(DEFAULT_AREA_COLOR);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openUnassignedAreaEditor = () => {
        setEditorTarget({ type: 'unassignedArea', color: unassignedAreaColor });
        setEditorName('');
        setEditorColor(unassignedAreaColor);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openValueEditor = (type: 'context' | 'tag', name: string) => {
        setEditorTarget({ type, name });
        setEditorName(name);
        setEditorColor(DEFAULT_AREA_COLOR);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openAreaEditor = (area: Area) => {
        setEditorTarget({ type: 'area', id: area.id, name: area.name, color: area.color });
        setEditorName(area.name);
        setEditorColor(area.color || DEFAULT_AREA_COLOR);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openNewAreaEditor = () => {
        setEditorTarget({ type: 'newArea' });
        setEditorName('');
        setEditorColor(DEFAULT_AREA_COLOR);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openNewPersonEditor = () => {
        setEditorTarget({ type: 'newPerson' });
        setEditorName('');
        setEditorColor(DEFAULT_AREA_COLOR);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openPersonEditor = (person: Person) => {
        setEditorTarget({
            type: 'person',
            id: person.id,
            name: person.name,
            note: person.note,
            referenceLink: person.referenceLink,
        });
        setEditorName(person.name);
        setEditorColor(DEFAULT_AREA_COLOR);
        setEditorNote(person.note ?? '');
        setEditorReferenceLink(person.referenceLink ?? '');
    };

    const openPersonReferenceLink = (referenceLink: string | undefined) => {
        if (!isSafePersonReferenceLink(referenceLink)) return;
        Linking.openURL(referenceLink).catch(() => {
            Alert.alert(
                resolveText('people.openReference', 'Open reference link'),
                resolveText('people.openReferenceFailed', 'Could not open this reference link.'),
            );
        });
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

        if (editorTarget.type === 'newArea') {
            await addArea(trimmed, { color: editorColor });
            closeEditor();
            return;
        }

        if (editorTarget.type === 'newPerson') {
            const note = editorNote.trim();
            const referenceLink = editorReferenceLink.trim();
            const initialProps: Partial<Person> = {};
            if (note) initialProps.note = note;
            if (referenceLink) initialProps.referenceLink = referenceLink;
            await addPerson(trimmed, Object.keys(initialProps).length > 0 ? initialProps : undefined);
            closeEditor();
            return;
        }

        if (editorTarget.type === 'person') {
            const note = editorNote.trim();
            const referenceLink = editorReferenceLink.trim();
            const updates: Partial<Person> = {};
            if ((editorTarget.note ?? '') !== note) {
                updates.note = note || undefined;
            }
            if ((editorTarget.referenceLink ?? '') !== referenceLink) {
                updates.referenceLink = referenceLink || undefined;
            }
            if (Object.keys(updates).length > 0) {
                await updatePerson(editorTarget.id, updates);
            }
            if (trimmed !== editorTarget.name) {
                await renamePerson(editorTarget.id, trimmed, { updateTasks: true });
            }
            closeEditor();
            return;
        }

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

    const PersonRow = ({ person }: { person: Person }) => {
        const taskCount = assignedTaskCountByPerson.get(getPersonNameKey(person.name)) ?? 0;
        const referenceLink = person.referenceLink?.trim();
        const canOpenReferenceLink = isSafePersonReferenceLink(referenceLink);
        const initial = person.name.trim().slice(0, 1).toUpperCase() || '?';
        const detail = person.note?.trim() || person.referenceLink?.trim() || `${taskCount} ${t('common.tasks')}`;

        return (
            <View
                testID={`manage-person-row-${person.id}`}
                style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}
            >
                <View
                    style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: tc.bg,
                        borderWidth: 1,
                        borderColor: tc.border,
                    }}
                >
                    <Text style={{ color: tc.text, fontSize: 14, fontWeight: '700' }}>{initial}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>{person.name}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                        {detail}
                    </Text>
                </View>
                {canOpenReferenceLink ? (
                    <TouchableOpacity
                        accessibilityLabel={resolveText('people.openReference', 'Open reference link')}
                        accessibilityRole="button"
                        hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                        onPress={() => openPersonReferenceLink(referenceLink)}
                        style={{ padding: 8 }}
                    >
                        <Ionicons name="open-outline" size={18} color={tc.secondaryText} />
                    </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                    accessibilityLabel={t('common.edit')}
                    accessibilityRole="button"
                    hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    onPress={() => openPersonEditor(person)}
                    style={{ padding: 8 }}
                    testID={`manage-person-edit-${person.id}`}
                >
                    <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
                <TouchableOpacity
                    accessibilityLabel={t('common.delete')}
                    accessibilityRole="button"
                    hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    onPress={() => confirmDelete(person.name, () => void deletePerson(person.id), 'people.deleteConfirm')}
                    style={{ padding: 8 }}
                >
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                </TouchableOpacity>
            </View>
        );
    };

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
                onPress={() => confirmDelete(area.name, () => void deleteArea(area.id), 'areas.deleteConfirm')}
                style={{ padding: 8 }}
            >
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </TouchableOpacity>
        </View>
    );

    const NewAreaRow = () => (
        <View style={styles.settingRow}>
            <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: DEFAULT_AREA_COLOR, marginRight: 12 }} />
            <View style={{ flex: 1, minWidth: 0 }}>
                <CompactText style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                    {resolveText('areas.new', 'New Area')}
                </CompactText>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                    {resolveText('areas.newHint', 'Create an area for related projects and tasks.')}
                </Text>
            </View>
            <Pressable
                accessibilityLabel={resolveText('areas.new', 'New Area')}
                accessibilityRole="button"
                hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                onPress={openNewAreaEditor}
                style={[
                    styles.manageEditorButton,
                    styles.manageEditorButtonPrimary,
                    { minWidth: 86, flexDirection: 'row', gap: 6 },
                ]}
                testID="manage-area-add"
            >
                <Ionicons name="add" size={17} color="#FFFFFF" />
                <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>
                    {resolveText('common.add', 'Add')}
                </Text>
            </Pressable>
        </View>
    );

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.manage')} />
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
                    <NewAreaRow />
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-someday-sections"
                    title={resolveText('viewSections.somedaySections', 'Someday sections')}
                    count={somedaySections.length}
                    open={openSections.somedaySections}
                    onToggle={() => setOpenSections((current) => ({ ...current, somedaySections: !current.somedaySections }))}
                    tc={tc}
                >
                    {somedaySections.length === 0 ? (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {resolveText('viewSections.manageHint', 'Organize ideas without changing their projects or project sections.')}
                            </Text>
                        </View>
                    ) : (
                        <SomedaySectionManager
                            definitions={somedaySections}
                            onDelete={(id) => {
                                const section = somedaySections.find((candidate) => candidate.id === id);
                                if (!section) return;
                                confirmDelete(section.title, () => void updateSettings({
                                    gtd: {
                                        ...(settings.gtd ?? {}),
                                        viewSections: {
                                            ...(settings.gtd?.viewSections ?? {}),
                                            someday: somedaySections.filter((candidate) => candidate.id !== id),
                                        },
                                    },
                                }));
                            }}
                            onChange={(definitions) => updateSettings({
                                gtd: {
                                    ...(settings.gtd ?? {}),
                                    viewSections: {
                                        ...(settings.gtd?.viewSections ?? {}),
                                        someday: definitions,
                                    },
                                },
                            })}
                            t={t}
                            themeColors={tc}
                        />
                    )}
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-people"
                    title={resolveText('people.title', 'People')}
                    count={sortedPeople.length}
                    open={openSections.people}
                    onToggle={() => setOpenSections((current) => ({ ...current, people: !current.people }))}
                    tc={tc}
                >
                    {sortedPeople.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {resolveText('people.empty', 'No people yet')}
                            </Text>
                        </View>
                    )}
                    {sortedPeople.map((person) => (
                        <PersonRow key={person.id} person={person} />
                    ))}
                    <View style={styles.settingRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                {resolveText('people.new', 'New Person')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                                {resolveText('people.newHint', 'Add someone you delegate or wait on.')}
                            </Text>
                        </View>
                        <Pressable
                            accessibilityLabel={resolveText('people.new', 'New Person')}
                            accessibilityRole="button"
                            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                            onPress={openNewPersonEditor}
                            style={[
                                styles.manageEditorButton,
                                styles.manageEditorButtonPrimary,
                                { minWidth: 86, flexDirection: 'row', gap: 6 },
                            ]}
                            testID="manage-person-add"
                        >
                            <Ionicons name="add" size={17} color="#FFFFFF" />
                            <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>
                                {resolveText('common.add', 'Add')}
                            </Text>
                        </Pressable>
                    </View>
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
                                {t('contexts.empty')}
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
                    title={t('tags.title')}
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
                                ? t('areas.edit')
                                : editorTarget?.type === 'newArea'
                                    ? resolveText('areas.new', 'New Area')
                                : editorTarget?.type === 'unassignedArea'
                                    ? unassignedAreaColorLabel
                                : editorTarget?.type === 'newPerson'
                                    ? resolveText('people.new', 'New Person')
                                : editorTarget?.type === 'person'
                                    ? resolveText('people.edit', 'Edit person')
                                : t('common.rename')}
                        </Text>
                        {editorTarget?.type !== 'unassignedArea' ? (
                            <TextInput
                                testID={editorTarget?.type === 'newArea'
                                    ? 'manage-area-name-input'
                                    : editorTarget?.type === 'newPerson' || editorTarget?.type === 'person'
                                        ? 'manage-person-name-input'
                                        : undefined}
                                value={editorName}
                                onChangeText={setEditorName}
                                placeholder={
                                    editorTarget?.type === 'area'
                                        || editorTarget?.type === 'newArea'
                                        ? t('projects.areaLabel')
                                        : editorTarget?.type === 'newPerson' || editorTarget?.type === 'person'
                                            ? resolveText('people.namePlaceholder', 'Person name')
                                        : t('common.name')
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
                        {editorTarget?.type === 'newPerson' || editorTarget?.type === 'person' ? (
                            <>
                                <TextInput
                                    testID="manage-person-note-input"
                                    value={editorNote}
                                    onChangeText={setEditorNote}
                                    placeholder={resolveText('people.notePlaceholder', 'Note')}
                                    placeholderTextColor={tc.secondaryText}
                                    style={[
                                        styles.textInput,
                                        {
                                            backgroundColor: tc.bg,
                                            borderColor: tc.border,
                                            color: tc.text,
                                        },
                                    ]}
                                />
                                <TextInput
                                    testID="manage-person-reference-input"
                                    value={editorReferenceLink}
                                    onChangeText={setEditorReferenceLink}
                                    placeholder={resolveText('people.referencePlaceholder', 'Reference link, including obsidian://')}
                                    placeholderTextColor={tc.secondaryText}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    style={[
                                        styles.textInput,
                                        {
                                            backgroundColor: tc.bg,
                                            borderColor: tc.border,
                                            color: tc.text,
                                        },
                                    ]}
                                />
                            </>
                        ) : null}
                        {editorTarget?.type === 'area' || editorTarget?.type === 'newArea' || editorTarget?.type === 'unassignedArea' ? (
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
                                    {t('common.cancel')}
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
                                    {t('common.save')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </SafeAreaView>
    );
}
