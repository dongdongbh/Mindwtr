import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import {
    buildTaskMovePatch,
    compareAreasByOrder,
    getProjectChoiceState,
    groupProjectsForPicker,
    tFallback,
    type Area,
    type Project,
    type TaskMoveDestination,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useAndroidKeyboardInset } from '@/lib/use-android-keyboard-inset';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { logError } from '@/lib/app-log';
import { styles } from './task-edit-modal.styles';

/** Writes core's move patch into the draft, where '' is this screen's "none". */
export function applyTaskEditDestination(
    setDraftField: (field: 'projectId' | 'areaId' | 'sectionId', value: string) => void,
    currentProjectId: string | undefined,
    currentSectionId: string | undefined,
    destination: TaskMoveDestination,
) {
    const patch = buildTaskMovePatch(destination, {
        projectId: currentProjectId,
        sectionId: currentSectionId,
    });
    setDraftField('projectId', patch.projectId ?? '');
    setDraftField('areaId', patch.areaId ?? '');
    setDraftField('sectionId', patch.sectionId ?? '');
}

type DestinationPickerThemeColors = Pick<
    ThemeColors,
    'border' | 'cardBg' | 'danger' | 'inputBg' | 'secondaryText' | 'text' | 'tint'
>;

type TaskEditDestinationPickerProps = {
    visible: boolean;
    projects: Project[];
    allProjects?: Project[];
    areas: Area[];
    allowProjects?: boolean;
    allowAreas?: boolean;
    selectedProjectId?: string | null;
    selectedAreaId?: string | null;
    tc: DestinationPickerThemeColors;
    t: (key: string) => string;
    onClose: () => void;
    onSelect: (destination: TaskMoveDestination) => void;
    onCreateProject?: (title: string) => Promise<Project | null>;
    onCreateArea?: (name: string) => Promise<Area | null>;
};

export function TaskEditDestinationPicker({
    visible,
    projects,
    allProjects,
    areas,
    allowProjects = true,
    allowAreas = true,
    selectedProjectId,
    selectedAreaId,
    tc,
    t,
    onClose,
    onSelect,
    onCreateProject,
    onCreateArea,
}: TaskEditDestinationPickerProps) {
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState<'project' | 'area' | null>(null);
    const [createError, setCreateError] = useState<string | null>(null);
    const attemptRef = useRef(0);
    const keyboardInset = useAndroidKeyboardInset(visible);
    const reducedMotion = useReducedMotion();

    useEffect(() => {
        attemptRef.current += 1;
        setCreating(null);
        setCreateError(null);
        if (visible) setQuery('');
        return () => {
            attemptRef.current += 1;
        };
    }, [visible]);

    const normalizedQuery = query.trim().toLowerCase();
    const projectChoices = useMemo(
        () => getProjectChoiceState(projects, query, allProjects ?? projects),
        [allProjects, projects, query],
    );
    // Active projects first, then Someday / Waiting under their own heading (#1467).
    const projectGroups = useMemo(() => groupProjectsForPicker(projectChoices.filteredProjects, areas), [areas, projectChoices.filteredProjects]);
    const activeAreas = useMemo(
        () => areas.filter((area) => !area.deletedAt).sort(compareAreasByOrder),
        [areas],
    );
    const filteredAreas = useMemo(
        () => normalizedQuery
            ? activeAreas.filter((area) => area.name.toLowerCase().includes(normalizedQuery))
            : activeAreas,
        [activeAreas, normalizedQuery],
    );
    const exactArea = useMemo(
        () => normalizedQuery
            ? activeAreas.find((area) => area.name.toLowerCase() === normalizedQuery)
            : undefined,
        [activeAreas, normalizedQuery],
    );

    const closePicker = () => {
        if (creating) return;
        attemptRef.current += 1;
        setCreateError(null);
        onClose();
    };

    const selectAndClose = (destination: TaskMoveDestination) => {
        onSelect(destination);
        closePicker();
    };

    const createDestination = async (kind: 'project' | 'area') => {
        if (creating) return;
        const name = query.trim();
        if (!name) return;
        const create = kind === 'project' ? onCreateProject : onCreateArea;
        if (!create) return;
        if (kind === 'project' && projectChoices.exactMatch) {
            selectAndClose({ kind: 'project', id: projectChoices.exactMatch.id });
            return;
        }
        if (kind === 'area' && exactArea) {
            selectAndClose({ kind: 'area', id: exactArea.id });
            return;
        }

        const attempt = ++attemptRef.current;
        setCreating(kind);
        setCreateError(null);
        try {
            const created = await create(name);
            if (attempt !== attemptRef.current) return;
            if (!created) {
                setCreateError(kind === 'project'
                    ? tFallback(t, 'projects.createFailed', 'Failed to create project')
                    : tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
                return;
            }
            onSelect({ kind, id: created.id });
            onClose();
        } catch (error) {
            if (attempt !== attemptRef.current) return;
            setCreateError(kind === 'project'
                ? tFallback(t, 'projects.createFailed', 'Failed to create project')
                : tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
            void logError(error, {
                scope: 'project',
                extra: { message: `Failed to create ${kind} from task destination picker` },
            });
        } finally {
            if (attempt === attemptRef.current) setCreating(null);
        }
    };

    const destinationLabel = t('task.destination');
    const projectsLabel = t('nav.projects');
    const deferredLabel = tFallback(t, 'projects.deferredSection', 'Someday / Waiting');
    const areasLabel = t('taskEdit.areaLabel');
    const noneLabel = t('common.none');

    return (
        <Modal
            visible={visible}
            transparent
            animationType={reducedMotion ? 'none' : 'fade'}
            onRequestClose={closePicker}
            accessibilityViewIsModal
        >
            <View style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}>
                <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[styles.modalTitle, { color: tc.text }]} accessibilityRole="header">
                        {destinationLabel}
                    </Text>
                    <TextInput
                        value={query}
                        onChangeText={(value) => {
                            setQuery(value);
                            setCreateError(null);
                        }}
                        placeholder={t('common.search')}
                        placeholderTextColor={tc.secondaryText}
                        style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        editable={!creating}
                        accessibilityLabel={destinationLabel}
                        accessibilityHint={t('common.search')}
                    />
                    {normalizedQuery ? (
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            {allowProjects && !projectChoices.exactMatch && onCreateProject ? (
                                <Pressable
                                    onPress={() => void createDestination('project')}
                                    disabled={Boolean(creating)}
                                    style={[styles.pickerItem, { flex: 1 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${t('projects.new')}: ${query.trim()}`}
                                    accessibilityState={{ disabled: Boolean(creating), busy: creating === 'project' }}
                                >
                                    {creating === 'project' ? (
                                        <ActivityIndicator size="small" color={tc.tint} />
                                    ) : (
                                        <Text style={[styles.pickerItemText, { color: tc.tint }]} numberOfLines={2}>
                                            + {t('projects.new')}
                                        </Text>
                                    )}
                                </Pressable>
                            ) : null}
                            {allowAreas && !exactArea && onCreateArea ? (
                                <Pressable
                                    onPress={() => void createDestination('area')}
                                    disabled={Boolean(creating)}
                                    style={[styles.pickerItem, { flex: 1 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${t('areas.new')}: ${query.trim()}`}
                                    accessibilityState={{ disabled: Boolean(creating), busy: creating === 'area' }}
                                >
                                    {creating === 'area' ? (
                                        <ActivityIndicator size="small" color={tc.tint} />
                                    ) : (
                                        <Text style={[styles.pickerItemText, { color: tc.tint }]} numberOfLines={2}>
                                            + {t('areas.new')}
                                        </Text>
                                    )}
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                    {createError ? (
                        <View style={styles.pickerItem}>
                            <Text
                                testID="destination-create-error"
                                style={[styles.pickerItemText, { color: tc.danger }]}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="assertive"
                            >
                                {createError}
                            </Text>
                        </View>
                    ) : null}
                    <ScrollView
                        style={[styles.pickerList, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                        contentContainerStyle={{ paddingVertical: 4 }}
                        keyboardShouldPersistTaps="handled"
                    >
                        <Pressable
                            onPress={() => selectAndClose({ kind: 'none' })}
                            disabled={Boolean(creating)}
                            style={styles.pickerItem}
                            accessibilityRole="button"
                            accessibilityLabel={noneLabel}
                            accessibilityState={{
                                selected: !selectedProjectId && !selectedAreaId,
                                disabled: Boolean(creating),
                            }}
                        >
                            <Text style={[styles.pickerItemText, { color: tc.text }]}>{noneLabel}</Text>
                        </Pressable>

                        {allowProjects ? [[projectsLabel, projectGroups.active] as const, [deferredLabel, projectGroups.deferred] as const]
                            .filter(([label, group]) => label === projectsLabel || group.length > 0)
                            .map(([label, group]) => (
                            <React.Fragment key={label}>
                                <Text style={[styles.pickerItemText, { color: tc.secondaryText, fontWeight: '700' }]}>
                                    {label}
                                </Text>
                                {group.map((project) => (
                                    <Pressable
                                        key={`project:${project.id}`}
                                        onPress={() => selectAndClose({ kind: 'project', id: project.id })}
                                        disabled={Boolean(creating)}
                                        style={styles.pickerItem}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${projectsLabel}: ${project.title}`}
                                        accessibilityState={{ selected: selectedProjectId === project.id, disabled: Boolean(creating) }}
                                    >
                                        <Text style={[styles.pickerItemText, { color: tc.text }]}>{project.title}</Text>
                                    </Pressable>
                                ))}
                            </React.Fragment>
                        )) : null}

                        {allowAreas ? (
                            <>
                                <Text style={[styles.pickerItemText, { color: tc.secondaryText, fontWeight: '700' }]}>
                                    {areasLabel}
                                </Text>
                                {filteredAreas.map((area) => (
                                    <Pressable
                                        key={`area:${area.id}`}
                                        onPress={() => selectAndClose({ kind: 'area', id: area.id })}
                                        disabled={Boolean(creating)}
                                        style={styles.pickerItem}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${areasLabel}: ${area.name}`}
                                        accessibilityState={{ selected: selectedAreaId === area.id, disabled: Boolean(creating) }}
                                    >
                                        <Text style={[styles.pickerItemText, { color: tc.text }]}>{area.name}</Text>
                                    </Pressable>
                                ))}
                            </>
                        ) : null}
                        {(!allowProjects || projectChoices.filteredProjects.length === 0)
                            && (!allowAreas || filteredAreas.length === 0) ? (
                            <View style={styles.pickerItem}>
                                <Text style={[styles.pickerItemText, { color: tc.secondaryText }]} accessibilityLiveRegion="polite">
                                    {t('common.noMatches')}
                                </Text>
                            </View>
                        ) : null}
                    </ScrollView>
                    <View style={styles.modalButtons}>
                        <TouchableOpacity
                            onPress={closePicker}
                            disabled={Boolean(creating)}
                            style={styles.modalButton}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                            accessibilityState={{ disabled: Boolean(creating) }}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
