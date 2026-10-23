import { logInfo } from '../../lib/app-log';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    updateSettingsFromLatest,
    AREA_PRESET_COLORS,
    DEFAULT_AREA_COLOR,
    DEFAULT_MANAGE_OPEN_SECTIONS,
    MANAGE_OPEN_SECTIONS_STORAGE_KEY,
    buildManagePersonRow,
    buildSomedaySectionsSettingsUpdate,
    getManageDeleteConfirm,
    getManageEditorDraft,
    getManageEditorText,
    getManageSettingsText,
    getPersonTaskCounts,
    isManageAreaNameTaken,
    isManageEditorSaveDisabled,
    normalizeManageOpenSections,
    planManageEditorSave,
    removeSomedaySection,
    sortManageAreas,
    sortManagePeople,
    sortViewSectionDefinitions,
    type Area,
    type ManageEditorTarget,
    type ManageSectionKey,
    type ManageUntranslatedText,
    type Person,
    type ViewSectionDefinition,
    useTaskStore,
} from '@mindwtr/core';
import { useRouter } from 'expo-router';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';
import { SomedaySectionManager } from '../views/someday-section-manager';

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
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
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
    const router = useRouter();
    const tc = useThemeColors();
    const { t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const areas = useTaskStore((state) => state.areas);
    const people = useTaskStore((state) => state.people);
    const settings = useTaskStore((state) => state.settings);
    const allTasks = useTaskStore((state) => state._allTasks);
    const derivedState = useTaskStore((state) => state.getDerivedState());
    const addArea = useTaskStore((state) => state.addArea);
    const addContext = useTaskStore((state) => state.addContext);
    const addTag = useTaskStore((state) => state.addTag);
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
    const resolveText = (key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    };
    // Keys not in en.ts yet: resolved here, with their English fallbacks, so the
    // mobile missing-key check keeps seeing them (the native host resolves the same).
    const untranslated: ManageUntranslatedText = {
        newAreaHint: resolveText('areas.newHint', 'Create an area for related projects and tasks.'),
        peopleEmpty: resolveText('people.empty', 'No people yet'),
        newPersonHint: resolveText('people.newHint', 'Add someone you delegate or wait on.'),
        editPerson: resolveText('people.edit', 'Edit person'),
        personNamePlaceholder: resolveText('people.namePlaceholder', 'Person name'),
        notePlaceholder: resolveText('people.notePlaceholder', 'Note'),
        referencePlaceholder: resolveText('people.referencePlaceholder', 'Reference link, including obsidian://'),
        openReference: resolveText('people.openReference', 'Open reference link'),
        openReferenceFailed: resolveText('people.openReferenceFailed', 'Could not open this reference link.'),
    };
    // Texts, rows, confirmations and the editor's writes come from core's Manage
    // model, shared with the native host.
    const text = getManageSettingsText(t, untranslated);
    const sortedAreas = sortManageAreas(areas);
    const sortedPeople = useMemo(() => sortManagePeople(people), [people]);
    const somedaySections = useMemo(
        () => sortViewSectionDefinitions(settings.gtd?.viewSections?.someday),
        [settings.gtd?.viewSections?.someday],
    );
    const personTaskCountByName = useMemo(() => getPersonTaskCounts(allTasks), [allTasks]);
    const { allContexts, allTags } = derivedState;
    const [editorTarget, setEditorTarget] = useState<ManageEditorTarget | null>(null);
    const [editorName, setEditorName] = useState('');
    const [editorSaving, setEditorSaving] = useState(false);
    const [editorFailed, setEditorFailed] = useState(false);
    const [editorColor, setEditorColor] = useState(DEFAULT_AREA_COLOR);
    const [editorNote, setEditorNote] = useState('');
    const [editorReferenceLink, setEditorReferenceLink] = useState('');
    const [openSections, setOpenSections] = useState<Record<ManageSectionKey, boolean>>(() => ({ ...DEFAULT_MANAGE_OPEN_SECTIONS }));
    const openSectionsHydratedRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        AsyncStorage.getItem(MANAGE_OPEN_SECTIONS_STORAGE_KEY)
            .then((raw) => {
                if (cancelled) return;
                if (raw) {
                    try {
                        setOpenSections(normalizeManageOpenSections(JSON.parse(raw)));
                    } catch {
                        setOpenSections({ ...DEFAULT_MANAGE_OPEN_SECTIONS });
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

    const unassignedAreaColor = settings.appearance?.unassignedAreaColor || DEFAULT_AREA_COLOR;
    // A closed editor keeps the rename texts, as before a target is chosen.
    const editorText = getManageEditorText(t, editorTarget?.type ?? 'context', untranslated);
    const saveDisabled = isManageEditorSaveDisabled(editorTarget?.type ?? 'context', editorName, areas);
    const nameTaken = isManageAreaNameTaken(editorTarget?.type ?? 'context', editorName, areas);
    const confirmDelete = (label: string, onConfirm: () => void, messageKey?: Parameters<typeof getManageDeleteConfirm>[2]) => {
        const confirm = getManageDeleteConfirm(t, label, messageKey);
        Alert.alert(
            confirm.title,
            confirm.message,
            [
                { text: confirm.cancelLabel, style: 'cancel' },
                { text: confirm.confirmLabel, style: 'destructive', onPress: onConfirm },
            ],
        );
    };

    const confirmSomedaySectionDelete = (id: string) => {
        const stored = useTaskStore.getState().settings.gtd?.viewSections?.someday;
        const section = sortViewSectionDefinitions(stored).find((candidate) => candidate.id === id);
        if (!section) return;
        const confirmedRow = JSON.stringify(section);
        confirmDelete(section.title, () => {
            const current = useTaskStore.getState().settings;
            const currentSection = sortViewSectionDefinitions(current.gtd?.viewSections?.someday)
                .find((candidate) => candidate.id === id);
            if (!currentSection) return;
            if (JSON.stringify(currentSection) !== confirmedRow) {
                // The alert described an older row; ask again for the current one.
                confirmSomedaySectionDelete(id);
                return;
            }
            // Built from the settings as stored when the write is admitted, so a sync save's newer keys stay.
            void updateSettingsFromLatest((latest) => buildSomedaySectionsSettingsUpdate(
                latest,
                removeSomedaySection(latest.gtd?.viewSections?.someday, id),
            ), { write: updateSettings, read: () => useTaskStore.getState().settings });
        });
    };

    // The manager edits the shown list; only the sections it changed (by id) go onto the latest stored list.
    const saveSomedaySections = (definitions: ViewSectionDefinition[]) => {
        const shown = new Map((settings.gtd?.viewSections?.someday ?? []).map((section) => [section.id, JSON.stringify(section)]));
        const edited = definitions.filter((section) => shown.get(section.id) !== JSON.stringify(section));
        if (edited.length === 0) return;
        const editedById = new Map(edited.map((section) => [section.id, section]));
        return updateSettingsFromLatest((latest) => {
            const stored = latest.gtd?.viewSections?.someday ?? [];
            const storedIds = new Set(stored.map((section) => section.id));
            return buildSomedaySectionsSettingsUpdate(latest, [
                ...stored.map((section) => editedById.get(section.id) ?? section),
                ...edited.filter((section) => !shown.has(section.id) && !storedIds.has(section.id)),
            ]);
        }, { write: updateSettings, read: () => useTaskStore.getState().settings }).then(() => undefined);
    };

    const tokenEditorFailed = editorFailed && (editorTarget?.type === 'context' || editorTarget?.type === 'tag'
        || editorTarget?.type === 'newContext' || editorTarget?.type === 'newTag');
    const closeEditor = () => {
        if (editorSaving) return;
        setEditorFailed(false);
        setEditorTarget(null);
        setEditorName('');
        setEditorColor(DEFAULT_AREA_COLOR);
        setEditorNote('');
        setEditorReferenceLink('');
    };

    const openEditor = (target: ManageEditorTarget) => {
        setEditorFailed(false);
        const draft = getManageEditorDraft(target);
        setEditorTarget(target);
        setEditorName(draft.name);
        setEditorColor(draft.color);
        setEditorNote(draft.note);
        setEditorReferenceLink(draft.referenceLink);
    };

    const deleteToken = async (kind: 'context' | 'tag', name: string) => {
        try {
            await (kind === 'context' ? deleteContext(name) : deleteTag(name));
        } catch {
            Alert.alert(t('common.error'), t('settings.feedback.saveFailed'));
        }
    };

    const openUnassignedAreaEditor = () => openEditor({ type: 'unassignedArea', color: unassignedAreaColor });
    const openValueEditor = (type: 'context' | 'tag', name: string) => openEditor({ type, name });
    const openAreaEditor = (area: Area) => openEditor({ type: 'area', id: area.id, name: area.name, color: area.color });
    const openNewAreaEditor = () => openEditor({ type: 'newArea' });
    const openNewPersonEditor = () => openEditor({ type: 'newPerson' });
    const openPersonEditor = (person: Person) => openEditor({
        type: 'person',
        id: person.id,
        name: person.name,
        note: person.note,
        referenceLink: person.referenceLink,
    });

    const openPersonReferenceLink = (referenceLink: string) => {
        Linking.openURL(referenceLink).catch(() => {
            Alert.alert(text.people.openReference, text.people.openReferenceFailed);
        });
    };

    const saveEditor = async () => {
        if (!editorTarget || editorSaving) return;
        const writes = planManageEditorSave(
            editorTarget,
            { name: editorName, color: editorColor, note: editorNote, referenceLink: editorReferenceLink },
            settings,
        );
        if (!writes) return;
        setEditorSaving(true);
        setEditorFailed(false);
        try {
            for (const write of writes) {
                switch (write.kind) {
                    case 'updateSettings':
                        await updateSettings(write.updates);
                        break;
                    case 'addContext':
                        await addContext(write.name);
                        void logInfo('Saved context or tag created', { scope: 'settings', force: true, extra: { releaseCheck: 'v1.3.7/saved-taxonomy', taxonomyKind: 'context', outcome: 'persisted' } });
                        break;
                    case 'addTag':
                        await addTag(write.name);
                        void logInfo('Saved context or tag created', { scope: 'settings', force: true, extra: { releaseCheck: 'v1.3.7/saved-taxonomy', taxonomyKind: 'tag', outcome: 'persisted' } });
                        break;
                    case 'addArea':
                        await addArea(write.name, write.props);
                        break;
                    case 'addPerson':
                        await addPerson(write.name, write.props);
                        break;
                    case 'updatePerson':
                        await updatePerson(write.id, write.updates);
                        break;
                    case 'renamePerson':
                        await renamePerson(write.id, write.name, write.options);
                        break;
                    case 'updateArea':
                        await updateArea(write.id, write.updates);
                        break;
                    case 'renameContext':
                        await renameContext(write.from, write.to);
                        break;
                    case 'renameTag':
                        await renameTag(write.from, write.to);
                        break;
                }
            }
            closeEditor();
        } catch {
            setEditorFailed(true);
        } finally {
            setEditorSaving(false);
        }
    };

    // Icon buttons name the item they act on, as the Someday section rows do.
    const editLabel = (name: string) => `${t('common.edit')}: ${name}`;
    const deleteLabel = (name: string) => `${t('common.delete')}: ${name}`;

    const ManageRow = ({ label, onRename, onDelete }: { label: string; onRename?: () => void; onDelete: () => void }) => (
        <View style={[styles.settingRow, { borderBottomWidth: 1, borderBottomColor: tc.border }]}>
            <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>{label}</Text>
            {onRename && (
                <TouchableOpacity accessibilityLabel={editLabel(label)} accessibilityRole="button" onPress={onRename} style={{ padding: 8 }}>
                    <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
            )}
            <TouchableOpacity accessibilityLabel={deleteLabel(label)} accessibilityRole="button" onPress={onDelete} style={{ padding: 8 }}>
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </TouchableOpacity>
        </View>
    );

    const PersonRow = ({ person }: { person: Person }) => {
        const row = buildManagePersonRow(person, personTaskCountByName, t);
        const { initial, detail, referenceLink } = row;

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
                    {detail ? (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                            {detail}
                        </Text>
                    ) : null}
                </View>
                <TouchableOpacity
                    accessibilityLabel={row.countAccessibilityLabel}
                    accessibilityHint={text.people.countHint}
                    accessibilityRole="button"
                    hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    onPress={() => router.push({
                        pathname: '/global-search',
                        params: {
                            q: row.searchQuery,
                            includeCompleted: 'true',
                        },
                    })}
                    style={{ padding: 8 }}
                    testID={`manage-person-review-${person.id}`}
                >
                    <Text style={{ color: tc.secondaryText, fontSize: 13 }}>
                        {row.countLabel}
                    </Text>
                </TouchableOpacity>
                {referenceLink ? (
                    <TouchableOpacity
                        accessibilityLabel={text.people.openReference}
                        accessibilityRole="button"
                        hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                        onPress={() => openPersonReferenceLink(referenceLink)}
                        style={{ padding: 8 }}
                    >
                        <Ionicons name="open-outline" size={18} color={tc.secondaryText} />
                    </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                    accessibilityLabel={text.people.editLabel}
                    accessibilityRole="button"
                    hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                    onPress={() => openPersonEditor(person)}
                    style={{ padding: 8 }}
                    testID={`manage-person-edit-${person.id}`}
                >
                    <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
                </TouchableOpacity>
                <TouchableOpacity
                    accessibilityLabel={text.people.deleteLabel}
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
                <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>{text.areas.unassignedLabel}</Text>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                    {text.areas.unassignedDescription}
                </Text>
            </View>
            <TouchableOpacity
                accessibilityLabel={editLabel(text.areas.unassignedLabel)}
                accessibilityRole="button"
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
                accessibilityLabel={editLabel(area.name)}
                accessibilityRole="button"
                onPress={() => openAreaEditor(area)}
                style={{ padding: 8 }}
            >
                <Ionicons name="pencil-outline" size={18} color={tc.secondaryText} />
            </TouchableOpacity>
            <TouchableOpacity
                accessibilityLabel={deleteLabel(area.name)}
                accessibilityRole="button"
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
                    {text.areas.newLabel}
                </CompactText>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                    {text.areas.newHint}
                </Text>
            </View>
            <Pressable
                accessibilityLabel={text.areas.newLabel}
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
                    {text.areas.addLabel}
                </Text>
            </Pressable>
        </View>
    );

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={text.title} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <CollapsibleSection
                    testID="manage-section-toggle-areas"
                    title={text.sections.areas}
                    count={sortedAreas.length}
                    open={openSections.areas}
                    onToggle={() => setOpenSections((current) => ({ ...current, areas: !current.areas }))}
                    tc={tc}
                >
                    <UnassignedAreaRow />
                    {sortedAreas.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{text.areas.empty}</Text>
                        </View>
                    )}
                    {sortedAreas.map((area) => (
                        <AreaRow key={area.id} area={area} />
                    ))}
                    <NewAreaRow />
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-someday-sections"
                    title={text.sections.somedaySections}
                    count={somedaySections.length}
                    open={openSections.somedaySections}
                    onToggle={() => setOpenSections((current) => ({ ...current, somedaySections: !current.somedaySections }))}
                    tc={tc}
                >
                    {somedaySections.length === 0 ? (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {text.somedaySections.emptyHint}
                            </Text>
                        </View>
                    ) : (
                        <SomedaySectionManager
                            // The stored list: an edit changes only its section and keeps
                            // every other entry, including ones this build cannot show.
                            definitions={settings.gtd?.viewSections?.someday ?? []}
                            onDelete={confirmSomedaySectionDelete}
                            onChange={saveSomedaySections}
                            t={t}
                            themeColors={tc}
                        />
                    )}
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-people"
                    title={text.sections.people}
                    count={sortedPeople.length}
                    open={openSections.people}
                    onToggle={() => setOpenSections((current) => ({ ...current, people: !current.people }))}
                    tc={tc}
                >
                    {sortedPeople.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {text.people.empty}
                            </Text>
                        </View>
                    )}
                    {sortedPeople.map((person) => (
                        <PersonRow key={person.id} person={person} />
                    ))}
                    <View style={styles.settingRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                {text.people.newLabel}
                            </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                                {text.people.newHint}
                            </Text>
                        </View>
                        <Pressable
                            accessibilityLabel={text.people.newLabel}
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
                                {text.people.addLabel}
                            </Text>
                        </Pressable>
                    </View>
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-contexts"
                    title={text.sections.contexts}
                    count={allContexts.length}
                    open={openSections.contexts}
                    onToggle={() => setOpenSections((current) => ({ ...current, contexts: !current.contexts }))}
                    tc={tc}
                >
                    {allContexts.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {text.contexts.empty}
                            </Text>
                        </View>
                    )}
                    {allContexts.map((ctx) => (
                        <ManageRow
                            key={ctx}
                            label={ctx}
                            onRename={() => openValueEditor('context', ctx)}
                            onDelete={() => confirmDelete(ctx, () => void deleteToken('context', ctx))}
                        />
                    ))}
                    <View style={styles.settingRow}>
                        <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]}>{text.contexts.newLabel}</Text>
                        <Pressable accessibilityLabel={text.contexts.newLabel} accessibilityRole="button"
                            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                            onPress={() => openEditor({ type: 'newContext' })}
                            style={[styles.manageEditorButton, styles.manageEditorButtonPrimary]}
                            testID="manage-context-add">
                            <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>{text.contexts.addLabel}</Text>
                        </Pressable>
                    </View>
                </CollapsibleSection>

                <CollapsibleSection
                    testID="manage-section-toggle-tags"
                    title={text.sections.tags}
                    count={allTags.length}
                    open={openSections.tags}
                    onToggle={() => setOpenSections((current) => ({ ...current, tags: !current.tags }))}
                    tc={tc}
                >
                    {allTags.length === 0 && (
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{text.tags.empty}</Text>
                        </View>
                    )}
                    {allTags.map((tag) => (
                        <ManageRow
                            key={tag}
                            label={tag}
                            onRename={() => openValueEditor('tag', tag)}
                            onDelete={() => confirmDelete(tag, () => void deleteToken('tag', tag))}
                        />
                    ))}
                    <View style={styles.settingRow}>
                        <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]}>{text.tags.newLabel}</Text>
                        <Pressable accessibilityLabel={text.tags.newLabel} accessibilityRole="button"
                            hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                            onPress={() => openEditor({ type: 'newTag' })}
                            style={[styles.manageEditorButton, styles.manageEditorButtonPrimary]}
                            testID="manage-tag-add">
                            <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>{text.tags.addLabel}</Text>
                        </Pressable>
                    </View>
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
                            {editorText.title}
                        </Text>
                        {editorText.namePlaceholder !== null ? (
                            <TextInput
                                testID={editorTarget?.type === 'newArea'
                                    ? 'manage-area-name-input'
                                    : editorTarget?.type === 'newPerson' || editorTarget?.type === 'person'
                                        ? 'manage-person-name-input'
                                        : editorTarget?.type === 'newContext' || editorTarget?.type === 'newTag'
                                            ? 'manage-token-name-input'
                                            : undefined}
                                accessibilityLabel={editorText.namePlaceholder}
                                editable={!editorSaving && !tokenEditorFailed}
                                value={editorName}
                                onChangeText={(name) => { if (!editorSaving && !tokenEditorFailed) setEditorName(name); }}
                                placeholder={editorText.namePlaceholder}
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
                        {nameTaken && editorText.nameTaken ? (
                            <Text style={[styles.settingDescription, { color: tc.danger, marginTop: 6 }]}>
                                {editorText.nameTaken}
                            </Text>
                        ) : null}
                        {editorText.personFields ? (
                            <>
                                <TextInput
                                    testID="manage-person-note-input"
                                    value={editorNote}
                                    onChangeText={setEditorNote}
                                    placeholder={editorText.personFields.notePlaceholder}
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
                                    placeholder={editorText.personFields.referencePlaceholder}
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
                        {editorText.changeColor !== null ? (
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
                                        accessibilityLabel={`${editorText.changeColor}: ${color}`}
                                    >
                                        {editorColor === color ? (
                                            <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                                        ) : null}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        ) : null}
                        {editorFailed && <Text accessibilityRole="alert" style={[styles.settingDescription, { color: tc.danger }]}>{t('settings.feedback.saveFailed')}</Text>}
                        <View style={styles.manageEditorActions}>
                            <TouchableOpacity
                                testID="manage-editor-cancel"
                                disabled={editorSaving}
                                onPress={closeEditor}
                                style={[styles.manageEditorButton, { borderColor: tc.border }]}
                            >
                                <Text style={[styles.manageEditorButtonText, { color: tc.secondaryText }]}>
                                    {tokenEditorFailed ? t('common.close') : editorText.cancelLabel}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                testID="manage-editor-save"
                                disabled={saveDisabled || editorSaving}
                                onPress={() => {
                                    void saveEditor();
                                }}
                                style={[
                                    styles.manageEditorButton,
                                    styles.manageEditorButtonPrimary,
                                    saveDisabled && styles.manageEditorButtonDisabled,
                                ]}
                            >
                                <Text style={[styles.manageEditorButtonText, styles.manageEditorButtonPrimaryText]}>
                                    {editorText.saveLabel}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </SafeAreaView>
    );
}
