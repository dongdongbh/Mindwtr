import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { formatI18nTemplate, tFallback } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { styles } from './swipeable-task-item.styles';

type ProjectNextActionPromptModalProps = {
    candidates: Task[];
    newTitle: string;
    projectTitle: string;
    scope?: 'project' | 'section';
    sectionTitle?: string;
    submitting?: boolean;
    titleLocked?: boolean;
    tc: ThemeColors;
    t: (key: string) => string;
    visible: boolean;
    onDismiss?: () => void;
    onAddTask: () => void;
    onSaveAndEdit?: () => void;
    onCancel: () => void;
    onChooseTask: (taskId: string) => void;
    onCompleteProject: () => void;
    onNewTitleChange: (value: string) => void;
};

export function ProjectNextActionPromptModal({
    candidates,
    newTitle,
    projectTitle,
    scope = 'project',
    sectionTitle,
    submitting = false,
    titleLocked = false,
    tc,
    t,
    visible,
    onDismiss,
    onAddTask,
    onSaveAndEdit,
    onCancel,
    onChooseTask,
    onCompleteProject,
    onNewTitleChange,
}: ProjectNextActionPromptModalProps) {
    const canAddTask = newTitle.trim().length > 0;
    const addDisabled = !canAddTask || submitting;
    const description = scope === 'section' && sectionTitle
        ? formatI18nTemplate(tFallback(
            t,
            'projects.nextActionPromptSectionDesc',
            'Choose or add the next action for {{section}} in {{project}}.',
        ), { section: sectionTitle, project: projectTitle })
        : formatI18nTemplate(tFallback(
            t,
            'projects.nextActionPromptDesc',
            'Choose or add the next action for {{project}}.',
        ), { project: projectTitle });

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onCancel}
            onDismiss={onDismiss}
            accessibilityViewIsModal
        >
            <Pressable style={styles.modalOverlay} onPress={onCancel}>
                <Pressable
                    style={[styles.nextActionContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={() => {}}
                    accessibilityLabel={tFallback(t, 'projects.nextActionPromptTitle', "What's the next action?")}
                >
                    <Text style={[styles.menuTitle, { color: tc.text }]} accessibilityRole="header">
                        {tFallback(t, 'projects.nextActionPromptTitle', "What's the next action?")}
                    </Text>
                    <Text style={[styles.nextActionDescription, { color: tc.secondaryText }]}>
                        {description}
                    </Text>

                    {candidates.length > 0 ? (
                        <View style={styles.nextActionSection}>
                            <Text style={[styles.nextActionSectionLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'projects.nextActionPromptChooseExisting', 'Choose an existing task')}
                            </Text>
                            <ScrollView style={styles.nextActionCandidateList} keyboardShouldPersistTaps="handled">
                                {candidates.map((candidate) => (
                                    <Pressable
                                        key={candidate.id}
                                        style={[
                                            styles.nextActionCandidate,
                                            {
                                                borderColor: tc.border,
                                                backgroundColor: tc.inputBg,
                                                opacity: submitting ? 0.6 : 1,
                                            },
                                        ]}
                                        onPress={() => onChooseTask(candidate.id)}
                                        disabled={submitting}
                                        accessibilityRole="button"
                                        accessibilityLabel={candidate.title}
                                        accessibilityState={{ disabled: submitting }}
                                    >
                                        <Text style={[styles.nextActionCandidateTitle, { color: tc.text }]}>
                                            {candidate.title}
                                        </Text>
                                        <Text style={[styles.nextActionCandidateMeta, { color: tc.secondaryText }]}>
                                            {t(`status.${candidate.status}`)}
                                        </Text>
                                    </Pressable>
                                ))}
                            </ScrollView>
                        </View>
                    ) : null}

                    <View style={styles.nextActionSection}>
                        <Text style={[styles.nextActionSectionLabel, { color: tc.secondaryText }]}>
                            {tFallback(t, 'projects.nextActionPromptAddNew', 'Add a new next action')}
                        </Text>
                        <TextInput
                            value={newTitle}
                            onChangeText={onNewTitleChange}
                            placeholder={tFallback(t, 'projects.nextActionPromptPlaceholder', 'New next action...')}
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={tFallback(t, 'projects.nextActionPromptAddNew', 'Add a new next action')}
                            editable={!submitting && !titleLocked}
                            style={[
                                styles.nextActionInput,
                                { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border },
                            ]}
                            returnKeyType="done"
                            onSubmitEditing={() => {
                                if (!addDisabled) onAddTask();
                            }}
                        />
                        {onSaveAndEdit ? (
                            <Pressable
                                onPress={onSaveAndEdit}
                                disabled={addDisabled}
                                style={styles.nextActionEditButton}
                                accessibilityRole="button"
                                accessibilityLabel={tFallback(t, 'quickAdd.saveAndEdit', 'Save & edit')}
                                accessibilityState={{ disabled: addDisabled }}
                            >
                                <Text style={[styles.nextActionSecondaryText, { color: addDisabled ? tc.secondaryText : tc.tint }]}>
                                    {tFallback(t, 'quickAdd.saveAndEdit', 'Save & edit')}
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>

                    <View style={styles.nextActionActions}>
                        {scope !== 'section' && (
                            <Pressable
                                style={styles.nextActionCompleteButton}
                                onPress={onCompleteProject}
                                disabled={submitting}
                                accessibilityRole="button"
                                accessibilityLabel={tFallback(t, 'projects.nextActionPromptComplete', 'Complete project')}
                                accessibilityState={{ disabled: submitting }}
                            >
                                <Text
                                    style={[styles.nextActionSecondaryText, { color: submitting ? tc.secondaryText : tc.tint }]}
                                >
                                    {tFallback(t, 'projects.nextActionPromptComplete', 'Complete project')}
                                </Text>
                            </Pressable>
                        )}
                        <Pressable
                            style={[styles.nextActionSecondaryButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                            onPress={onCancel}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'common.skip', 'Skip')}
                        >
                            <Text style={[styles.nextActionSecondaryText, { color: tc.text }]}>
                                {tFallback(t, 'common.skip', 'Skip')}
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[
                                styles.nextActionPrimaryButton,
                                { backgroundColor: addDisabled ? tc.filterBg : tc.tint },
                            ]}
                            onPress={onAddTask}
                            disabled={addDisabled}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'projects.nextActionPromptAddButton', 'Add next action')}
                            accessibilityState={{ disabled: addDisabled }}
                        >
                            {submitting ? (
                                <ActivityIndicator color={tc.secondaryText} />
                            ) : (
                                <Text style={[styles.nextActionPrimaryText, { color: canAddTask ? tc.onTint : tc.secondaryText }]}>
                                    {tFallback(t, 'projects.nextActionPromptAddButton', 'Add next action')}
                                </Text>
                            )}
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
