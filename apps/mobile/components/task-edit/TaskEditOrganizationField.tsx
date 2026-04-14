import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { TaskEditFieldRendererProps } from './TaskEditFieldRenderer.types';

type OrganizationFieldId =
    | 'status'
    | 'project'
    | 'section'
    | 'area'
    | 'priority'
    | 'energyLevel'
    | 'assignedTo'
    | 'timeEstimate';

type TaskEditOrganizationFieldProps = TaskEditFieldRendererProps & {
    fieldId: OrganizationFieldId;
};

export function TaskEditOrganizationField({
    areas,
    availableStatusOptions,
    editedTask,
    energyLevelOptions,
    fieldId,
    handleInputFocus,
    prioritiesEnabled,
    priorityOptions,
    projectSections,
    projects,
    setEditedTask,
    setShowAreaPicker,
    setShowProjectPicker,
    setShowSectionPicker,
    styles,
    t,
    task,
    tc,
    timeEstimateOptions,
    timeEstimatesEnabled,
}: TaskEditOrganizationFieldProps) {
    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const getStatusLabel = (status: string) => {
        const key = `status.${status}` as const;
        const translated = t(key);
        return translated === key ? status : translated;
    };

    switch (fieldId) {
        case 'status':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.statusLabel')}</Text>
                    <View style={styles.statusContainerCompact}>
                        {availableStatusOptions.map((status) => (
                            <TouchableOpacity
                                key={status}
                                style={[styles.statusChipCompact, ...getStatusChipStyle(editedTask.status === status)]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, status }))}
                            >
                                <Text style={getStatusTextStyle(editedTask.status === status)}>
                                    {getStatusLabel(status)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'project':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.projectLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowProjectPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {projects.find((project) => project.id === editedTask.projectId)?.title || t('taskEdit.noProjectOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!editedTask.projectId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, projectId: undefined, sectionId: undefined }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        case 'section': {
            const projectId = editedTask.projectId ?? task?.projectId;
            if (!projectId) return null;
            const section = projectSections.find((item) => item.id === editedTask.sectionId);
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.sectionLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowSectionPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {section?.title || t('taskEdit.noSectionOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!editedTask.sectionId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, sectionId: undefined }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'area':
            if (editedTask.projectId) return null;
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.areaLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowAreaPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {areas.find((area) => area.id === editedTask.areaId)?.name || t('taskEdit.noAreaOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!editedTask.areaId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, areaId: undefined }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        case 'priority':
            if (!prioritiesEnabled) return null;
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.priorityLabel')}</Text>
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={getStatusChipStyle(!editedTask.priority)}
                            onPress={() => setEditedTask((prev) => ({ ...prev, priority: undefined }))}
                        >
                            <Text style={getStatusTextStyle(!editedTask.priority)}>
                                {t('common.none')}
                            </Text>
                        </TouchableOpacity>
                        {priorityOptions.map((priority) => (
                            <TouchableOpacity
                                key={priority}
                                style={getStatusChipStyle(editedTask.priority === priority)}
                                onPress={() => setEditedTask((prev) => ({ ...prev, priority }))}
                            >
                                <Text style={getStatusTextStyle(editedTask.priority === priority)}>
                                    {t(`priority.${priority}`)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'energyLevel':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.energyLevel')}</Text>
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={getStatusChipStyle(!editedTask.energyLevel)}
                            onPress={() => setEditedTask((prev) => ({ ...prev, energyLevel: undefined }))}
                        >
                            <Text style={getStatusTextStyle(!editedTask.energyLevel)}>
                                {t('common.none')}
                            </Text>
                        </TouchableOpacity>
                        {energyLevelOptions.map((energyLevel) => (
                            <TouchableOpacity
                                key={energyLevel}
                                style={getStatusChipStyle(editedTask.energyLevel === energyLevel)}
                                onPress={() => setEditedTask((prev) => ({ ...prev, energyLevel }))}
                            >
                                <Text style={getStatusTextStyle(editedTask.energyLevel === energyLevel)}>
                                    {t(`energyLevel.${energyLevel}`)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'assignedTo':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.assignedTo')}</Text>
                    <TextInput
                        style={[styles.input, inputStyle]}
                        value={String(editedTask.assignedTo ?? '')}
                        onChangeText={(assignedTo) => setEditedTask((prev) => ({ ...prev, assignedTo }))}
                        onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                        placeholder={t('taskEdit.assignedToPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        accessibilityLabel={t('taskEdit.assignedTo')}
                        accessibilityHint={t('taskEdit.assignedToPlaceholder')}
                    />
                </View>
            );
        case 'timeEstimate':
            if (!timeEstimatesEnabled) return null;
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.timeEstimateLabel')}</Text>
                    <View style={styles.statusContainer}>
                        {timeEstimateOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value || 'none'}
                                style={getStatusChipStyle(
                                    editedTask.timeEstimate === option.value || (!option.value && !editedTask.timeEstimate)
                                )}
                                onPress={() => setEditedTask((prev) => ({ ...prev, timeEstimate: option.value || undefined }))}
                            >
                                <Text style={getStatusTextStyle(
                                    editedTask.timeEstimate === option.value || (!option.value && !editedTask.timeEstimate)
                                )}>
                                    {option.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        default:
            return null;
    }
}
