import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
    createCustomTimeEstimate,
    formatTimeEstimateLabel,
    isCustomTimeEstimate,
    parseTimeEstimateInput,
    timeEstimateToMinutes,
    translateWithFallback,
} from '@mindwtr/core';

import { PriorityFlag } from '@/components/priority-flag';
import { CompactText } from '@/components/compact-text';
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
    applyAssignedToSuggestion,
    areas,
    assignedToSuggestions,
    availableStatusOptions,
    createAssignedToPerson,
    draft,
    energyLevelOptions,
    fieldId,
    handleInputFocus,
    prioritiesEnabled,
    priorityOptions,
    projectSections,
    projects,
    requestBackdatedCompletion,
    requestStatusChange,
    setDraftField,
    setShowAreaPicker,
    setShowProjectPicker,
    setShowSectionPicker,
    styles,
    t,
    task,
    tc,
    timeEstimateOptions,
    timeEstimatesEnabled,
    timeSpentEnabled,
}: TaskEditOrganizationFieldProps) {
    const customTimeEstimateDraftSourceRef = React.useRef<string | undefined>(undefined);
    const [customTimeEstimateDraft, setCustomTimeEstimateDraft] = React.useState('');
    const currentTimeEstimate = draft?.timeEstimate;
    const isCustomTimeEstimateSelected = isCustomTimeEstimate(currentTimeEstimate || undefined);

    React.useEffect(() => {
        if (!isCustomTimeEstimateSelected) {
            customTimeEstimateDraftSourceRef.current = currentTimeEstimate;
            setCustomTimeEstimateDraft('');
            return;
        }
        if (!currentTimeEstimate) return;

        if (customTimeEstimateDraftSourceRef.current !== currentTimeEstimate) {
            customTimeEstimateDraftSourceRef.current = currentTimeEstimate;
            setCustomTimeEstimateDraft(formatTimeEstimateLabel(currentTimeEstimate));
        }
    }, [currentTimeEstimate, isCustomTimeEstimateSelected]);

    if (!draft) return null;
    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };

    const setCustomTimeEstimate = (minutes: number) => {
        const next = createCustomTimeEstimate(minutes);
        customTimeEstimateDraftSourceRef.current = next;
        setDraftField('timeEstimate', next);
        return next;
    };

    const beginCustomTimeEstimate = () => {
        const next = setCustomTimeEstimate(timeEstimateToMinutes(currentTimeEstimate || undefined));
        setCustomTimeEstimateDraft(formatTimeEstimateLabel(next));
    };

    const applyCustomTimeEstimateDraft = (draft: string): boolean => {
        const minutes = parseTimeEstimateInput(draft);
        if (minutes === null) return false;
        setCustomTimeEstimate(minutes);
        return true;
    };
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean, compact = false) => ([
        styles.statusText,
        compact ? styles.statusTextCompact : null,
        { color: active ? tc.onTint : tc.secondaryText },
    ]);
    const getStatusLabel = (status: string) => {
        const key = `status.${status}` as const;
        return translateWithFallback(t, key, status);
    };
    const renderCompactPicker = (label: string, value: string, onPress: () => void) => (
        <View style={styles.formGroup}>
            <TouchableOpacity
                style={[styles.compactFieldRow, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${value}`}
            >
                <CompactText
                    style={[styles.compactFieldLabel, { color: tc.secondaryText }]}
                >
                    {label}
                </CompactText>
                <CompactText
                    style={[styles.compactFieldValue, { color: tc.tint }]}
                    numberOfLines={2}
                >
                    {value}
                </CompactText>
            </TouchableOpacity>
        </View>
    );
    const assignedToDraft = draft.assignedTo.trim();
    const assignedToCreateLabel = translateWithFallback(t, 'people.new', 'New Person');
    const canCreateAssignedToPerson = assignedToDraft.length > 0
        && !assignedToSuggestions.some((name) => name.trim().toLowerCase() === assignedToDraft.toLowerCase());

    switch (fieldId) {
        case 'status':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.statusLabel')}</Text>
                    <View style={styles.statusContainerCompact}>
                        {availableStatusOptions.map((status) => (
                            <TouchableOpacity
                                key={status}
                                style={[styles.statusChipCompact, ...getStatusChipStyle(draft.status === status)]}
                                onPress={() => requestStatusChange(status)}
                                onLongPress={status === 'done' ? requestBackdatedCompletion : undefined}
                                accessibilityRole="button"
                                accessibilityState={{ selected: draft.status === status }}
                                accessibilityLabel={`${t('taskEdit.statusLabel')}: ${getStatusLabel(status)}`}
                                accessibilityHint={status === 'done'
                                    ? translateWithFallback(t, 'task.completeBackdateHintMobile', 'Long-press to complete with a different time')
                                    : undefined}
                            >
                                <Text
                                    style={getStatusTextStyle(draft.status === status, true)}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    adjustsFontSizeToFit
                                    minimumFontScale={0.8}
                                >
                                    {getStatusLabel(status)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'project': {
            const projectId = draft.projectId;
            if (!projectId) {
                return renderCompactPicker(
                    t('taskEdit.projectLabel'),
                    t('taskEdit.noProjectOption'),
                    () => setShowProjectPicker(true)
                );
            }
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.projectLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowProjectPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {projects.find((project) => project.id === projectId)?.title || t('taskEdit.noProjectOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!projectId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => {
                                    const areaId = draft.areaId
                                        || projects.find((project) => project.id === draft.projectId)?.areaId
                                        || '';
                                    setDraftField('projectId', '');
                                    setDraftField('sectionId', '');
                                    setDraftField('areaId', areaId);
                                }}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'section': {
            const projectId = draft.projectId;
            if (!projectId) return null;
            const section = projectSections.find((item) => item.id === draft.sectionId);
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
                        {!!draft.sectionId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setDraftField('sectionId', '')}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'area': {
            const areaId = draft.areaId;
            if (draft.projectId) return null;
            if (!areaId) {
                return renderCompactPicker(
                    t('taskEdit.areaLabel'),
                    t('taskEdit.noAreaOption'),
                    () => setShowAreaPicker(true)
                );
            }
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.areaLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowAreaPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {areas.find((area) => area.id === areaId)?.name || t('taskEdit.noAreaOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!areaId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setDraftField('areaId', '')}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'priority':
            if (!prioritiesEnabled) return null;
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.priorityLabel')}</Text>
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={getStatusChipStyle(!draft.priority)}
                            onPress={() => setDraftField('priority', '')}
                        >
                            <Text style={getStatusTextStyle(!draft.priority)}>
                                {t('common.none')}
                            </Text>
                        </TouchableOpacity>
                        {priorityOptions.map((priority) => (
                            <TouchableOpacity
                                key={priority}
                                style={[getStatusChipStyle(draft.priority === priority), { flexDirection: 'row', alignItems: 'center', gap: 6 }]}
                                onPress={() => setDraftField('priority', priority)}
                            >
                                <PriorityFlag priority={priority} />
                                <Text style={getStatusTextStyle(draft.priority === priority)}>
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
                            style={getStatusChipStyle(!draft.energyLevel)}
                            onPress={() => setDraftField('energyLevel', '')}
                        >
                            <Text style={getStatusTextStyle(!draft.energyLevel)}>
                                {t('common.none')}
                            </Text>
                        </TouchableOpacity>
                        {energyLevelOptions.map((energyLevel) => (
                            <TouchableOpacity
                                key={energyLevel}
                                style={getStatusChipStyle(draft.energyLevel === energyLevel)}
                                onPress={() => setDraftField('energyLevel', energyLevel)}
                            >
                                <Text style={getStatusTextStyle(draft.energyLevel === energyLevel)}>
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
                        value={draft.assignedTo}
                        onChangeText={(assignedTo) => setDraftField('assignedTo', assignedTo)}
                        onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                        placeholder={t('taskEdit.assignedToPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        accessibilityLabel={t('taskEdit.assignedTo')}
                        accessibilityHint={t('taskEdit.assignedToPlaceholder')}
                    />
                    {(assignedToSuggestions.length > 0 || canCreateAssignedToPerson) && (
                        <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            {canCreateAssignedToPerson && (
                                <TouchableOpacity
                                    style={[
                                        styles.tokenSuggestionItem,
                                        assignedToSuggestions.length === 0 ? styles.tokenSuggestionItemLast : null,
                                    ]}
                                    onPress={() => {
                                        void createAssignedToPerson(assignedToDraft);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${assignedToCreateLabel}: ${assignedToDraft}`}
                                >
                                    <Text style={[styles.tokenSuggestionText, { color: tc.tint }]}>+ {assignedToCreateLabel} &quot;{assignedToDraft}&quot;</Text>
                                </TouchableOpacity>
                            )}
                            {assignedToSuggestions.map((name, index) => (
                                <TouchableOpacity
                                    key={name}
                                    style={[
                                        styles.tokenSuggestionItem,
                                        index === assignedToSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                    ]}
                                    onPress={() => applyAssignedToSuggestion(name)}
                                >
                                    <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{name}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    )}
                </View>
            );
        case 'timeEstimate': {
            if (!timeEstimatesEnabled) return null;
            const customTimeEstimateLabel = translateWithFallback(t, 'recurrence.custom', 'Custom…');
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.timeEstimateLabel')}</Text>
                    <View style={styles.statusContainer}>
                        {timeEstimateOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value || 'none'}
                                style={getStatusChipStyle(
                                    draft.timeEstimate === option.value || (!option.value && !draft.timeEstimate)
                                )}
                                onPress={() => setDraftField('timeEstimate', option.value)}
                            >
                                <Text style={getStatusTextStyle(
                                    draft.timeEstimate === option.value || (!option.value && !draft.timeEstimate)
                                )}>
                                    {option.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            key="custom"
                            style={getStatusChipStyle(isCustomTimeEstimateSelected)}
                            onPress={beginCustomTimeEstimate}
                        >
                            <Text style={getStatusTextStyle(isCustomTimeEstimateSelected)}>
                                {customTimeEstimateLabel}
                            </Text>
                        </TouchableOpacity>
                    </View>
                    {isCustomTimeEstimateSelected && (
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={customTimeEstimateDraft}
                            onChangeText={(draft) => {
                                setCustomTimeEstimateDraft(draft);
                                const minutes = parseTimeEstimateInput(draft);
                                if (minutes === null) return;
                                setCustomTimeEstimate(minutes);
                            }}
                            onBlur={() => {
                                if (!applyCustomTimeEstimateDraft(customTimeEstimateDraft) && currentTimeEstimate) {
                                    setCustomTimeEstimateDraft(formatTimeEstimateLabel(currentTimeEstimate));
                                }
                            }}
                            onSubmitEditing={() => {
                                if (!applyCustomTimeEstimateDraft(customTimeEstimateDraft) && currentTimeEstimate) {
                                    setCustomTimeEstimateDraft(formatTimeEstimateLabel(currentTimeEstimate));
                                }
                            }}
                            onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                            placeholder="2h30"
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={`${t('taskEdit.timeEstimateLabel')}: ${customTimeEstimateLabel}`}
                        />
                    )}
                    {timeSpentEnabled && (
                        <>
                            <Text style={[styles.label, { color: tc.secondaryText, marginTop: 12 }]}>
                                {translateWithFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent')}
                            </Text>
                            <TextInput
                                style={[styles.input, inputStyle]}
                                value={typeof draft.timeSpentMinutes === 'number' ? String(draft.timeSpentMinutes) : ''}
                                onChangeText={(text) => {
                                    const digits = text.replace(/[^0-9]/g, '');
                                    setDraftField('timeSpentMinutes', digits ? Number(digits) : undefined);
                                }}
                                keyboardType="number-pad"
                                onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                                placeholder={translateWithFallback(t, 'taskEdit.timeSpentPlaceholder', 'minutes')}
                                placeholderTextColor={tc.secondaryText}
                                accessibilityLabel={translateWithFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent')}
                            />
                        </>
                    )}
                </View>
            );
        }
        default:
            return null;
    }
}
