import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { getProjectChoiceState, tFallback, type Project } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { styles } from './task-edit-modal.styles';
import { logError } from '../../lib/app-log';
import { useAndroidKeyboardInset } from '../../lib/use-android-keyboard-inset';

type ProjectPickerThemeColors = Pick<ThemeColors, 'border' | 'cardBg' | 'inputBg' | 'secondaryText' | 'text' | 'tint'> & {
    danger?: ThemeColors['danger'];
};

const byOrder = (a: Project, b: Project) => {
    const orderA = Number.isFinite(a.order) ? a.order : 0;
    const orderB = Number.isFinite(b.order) ? b.order : 0;
    return orderA - orderB;
};

type ProjectPickerLeadingOption = {
    key: string;
    label: string;
    accessibilityLabel?: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
};

interface TaskEditProjectPickerProps {
    visible: boolean;
    projects: Project[];
    allProjects?: Project[];
    tc: ProjectPickerThemeColors;
    t: (key: string) => string;
    onClose: () => void;
    onSelectProject: (projectId?: string) => void;
    onCreateProject: (title: string) => Promise<Project | null>;
    allowCreate?: boolean;
    leadingOptions?: ProjectPickerLeadingOption[];
    selectedProjectId?: string | null;
    emptyLabel?: string;
    noMatchesLabel?: string;
}

export function TaskEditProjectPicker({
    visible,
    projects,
    allProjects,
    tc,
    t,
    onClose,
    onSelectProject,
    onCreateProject,
    allowCreate = true,
    leadingOptions = [],
    selectedProjectId,
    emptyLabel,
    noMatchesLabel,
}: TaskEditProjectPickerProps) {
    const [projectQuery, setProjectQuery] = useState('');
    const [createError, setCreateError] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const createAttemptRef = useRef(0);
    const creatingRef = useRef(false);
    const keyboardInset = useAndroidKeyboardInset(visible);

    useEffect(() => {
        createAttemptRef.current += 1;
        creatingRef.current = false;
        setIsCreating(false);
        setCreateError(null);
        if (visible) setProjectQuery('');
        return () => {
            createAttemptRef.current += 1;
            creatingRef.current = false;
        };
    }, [visible]);

    const normalizedProjectQuery = projectQuery.trim().toLowerCase();
    const { filteredProjects, exactMatch, canCreate } = useMemo(
        () => getProjectChoiceState(
            [...projects].sort(byOrder),
            projectQuery,
            [...(allProjects ?? projects)].sort(byOrder),
        ),
        [allProjects, projectQuery, projects],
    );

    const handleCreateProject = async () => {
        if (!allowCreate || creatingRef.current) return;
        const title = projectQuery.trim();
        if (!title) return;
        if (exactMatch) {
            onSelectProject(exactMatch.id);
            onClose();
            return;
        }
        const attempt = ++createAttemptRef.current;
        creatingRef.current = true;
        setIsCreating(true);
        setCreateError(null);
        try {
            const created = await onCreateProject(title);
            if (attempt !== createAttemptRef.current) return;
            if (!created) {
                setCreateError(tFallback(t, 'projects.createFailed', 'Failed to create project'));
                return;
            }
            onSelectProject(created.id);
            onClose();
        } catch (error) {
            if (attempt !== createAttemptRef.current) return;
            setCreateError(tFallback(t, 'projects.createFailed', 'Failed to create project'));
            void logError(error, { scope: 'project', extra: { message: 'Failed to create project' } });
        } finally {
            if (attempt === createAttemptRef.current) {
                creatingRef.current = false;
                setIsCreating(false);
            }
        }
    };

    const closePicker = () => {
        if (creatingRef.current) return;
        createAttemptRef.current += 1;
        setCreateError(null);
        onClose();
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={closePicker}
            accessibilityViewIsModal
        >
            <View style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}>
                <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[styles.modalTitle, { color: tc.text }]} accessibilityRole="header">
                        {t('taskEdit.projectLabel')}
                    </Text>
                    <TextInput
                        value={projectQuery}
                        onChangeText={(value) => {
                            setProjectQuery(value);
                            setCreateError(null);
                        }}
                        placeholder={t('common.search')}
                        placeholderTextColor={tc.secondaryText}
                        style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        blurOnSubmit
                        onSubmitEditing={handleCreateProject}
                        editable={!isCreating}
                        accessibilityLabel={t('taskEdit.projectLabel')}
                        accessibilityHint={t('common.search')}
                    />
                    {allowCreate && canCreate && (
                        <Pressable
                            onPress={handleCreateProject}
                            disabled={isCreating}
                            style={styles.pickerItem}
                            accessibilityRole="button"
                            accessibilityLabel={`${t('projects.create')}: ${projectQuery.trim()}`}
                            accessibilityState={{ disabled: isCreating, busy: isCreating }}
                        >
                            {isCreating ? (
                                <ActivityIndicator size="small" color={tc.tint} />
                            ) : (
                                <Text
                                    style={[styles.pickerItemText, { color: tc.tint }]}
                                >
                                    + {t('projects.create')} &quot;{projectQuery.trim()}&quot;
                                </Text>
                            )}
                        </Pressable>
                    )}
                    {createError ? (
                        <View style={styles.pickerItem}>
                            <Text
                                testID="project-create-error"
                                style={[styles.pickerItemText, { color: tc.danger ?? tc.secondaryText }]}
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
                    >
                        {leadingOptions.map((option) => (
                            <Pressable
                                key={option.key}
                                onPress={() => {
                                    option.onPress();
                                    closePicker();
                                }}
                                disabled={option.disabled || isCreating}
                                style={styles.pickerItem}
                                accessibilityRole="button"
                                accessibilityLabel={option.accessibilityLabel ?? option.label}
                                accessibilityState={{ selected: Boolean(option.selected), disabled: Boolean(option.disabled) || isCreating }}
                            >
                                <Text style={[styles.pickerItemText, { color: option.disabled ? tc.secondaryText : tc.text }]}>{option.label}</Text>
                            </Pressable>
                        ))}
                        <Pressable
                            onPress={() => {
                                onSelectProject(undefined);
                                closePicker();
                            }}
                            disabled={isCreating}
                            style={styles.pickerItem}
                            accessibilityRole="button"
                            accessibilityLabel={t('taskEdit.noProjectOption')}
                            accessibilityState={{ selected: selectedProjectId === null, disabled: isCreating }}
                        >
                            <Text style={[styles.pickerItemText, { color: tc.text }]}>{t('taskEdit.noProjectOption')}</Text>
                        </Pressable>
                        {filteredProjects.map((project) => (
                            <Pressable
                                key={project.id}
                                onPress={() => {
                                    onSelectProject(project.id);
                                    closePicker();
                                }}
                                disabled={isCreating}
                                style={styles.pickerItem}
                                accessibilityRole="button"
                                accessibilityLabel={project.title}
                                accessibilityState={{ selected: selectedProjectId === project.id, disabled: isCreating }}
                            >
                                <Text style={[styles.pickerItemText, { color: tc.text }]}>{project.title}</Text>
                            </Pressable>
                        ))}
                        {filteredProjects.length === 0 && (
                            <View style={styles.pickerItem}>
                                <Text
                                    style={[styles.pickerItemText, { color: tc.secondaryText }]}
                                    accessibilityRole="text"
                                    accessibilityLiveRegion="polite"
                                >
                                    {normalizedProjectQuery ? (noMatchesLabel ?? t('common.noMatches')) : (emptyLabel ?? noMatchesLabel ?? t('common.noMatches'))}
                                </Text>
                            </View>
                        )}
                    </ScrollView>
                    <View style={styles.modalButtons}>
                        <TouchableOpacity
                            onPress={closePicker}
                            disabled={isCreating}
                            style={styles.modalButton}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                            accessibilityState={{ disabled: isCreating }}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
