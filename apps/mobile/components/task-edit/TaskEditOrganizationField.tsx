import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
    formatTimeEstimateLabel,
    getTaskEditorTimeEstimate,
    parseTaskEditorTimeEstimate,
    parseTaskEditorTimeSpent,
    translateWithFallback,
    type TimeEstimate,
} from '@mindwtr/core';
import {
    BatteryCharging,
    BatteryFull,
    BatteryLow,
    BatteryMedium,
    CircleDot,
    CircleSlash,
    Flag,
    Folder,
    Hourglass,
    Layers,
    ListTodo,
    Timer,
    User,
    X,
    type LucideIcon,
} from 'lucide-react-native';
import { TASK_STATUS_ICONS } from '@/lib/task-status-icons';

import { PriorityFlag } from '@/components/priority-flag';
import { FieldHeading } from './FieldHeading';
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

// Status chips pair each offered status with a leading glyph so the row scans
// faster. The icon is decorative: the text label stays the accessible name.
// One status, one glyph across the app: the map lives in lib/task-status-icons (#1256).
const STATUS_ICON_BY_STATUS: Record<string, LucideIcon> = TASK_STATUS_ICONS;

const getStatusIcon = (status: string): LucideIcon => STATUS_ICON_BY_STATUS[status] ?? CircleDot;

const ENERGY_ICON_BY_LEVEL: Record<string, LucideIcon> = {
    low: BatteryLow,
    medium: BatteryMedium,
    high: BatteryFull,
};

const getEnergyIcon = (level: string): LucideIcon => ENERGY_ICON_BY_LEVEL[level] ?? BatteryMedium;

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
    destinationFields,
    prioritiesEnabled,
    priorityOptions,
    projectSections,
    projects,
    requestBackdatedCompletion,
    requestStatusChange,
    setDraftField,
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
    const timeEstimateModel = getTaskEditorTimeEstimate(currentTimeEstimate ?? '', t);
    const isCustomTimeEstimateSelected = timeEstimateModel.customSelected;

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

    const setCustomTimeEstimate = (next: TimeEstimate) => {
        customTimeEstimateDraftSourceRef.current = next;
        setDraftField('timeEstimate', next);
        return next;
    };

    const beginCustomTimeEstimate = () => {
        const next = setCustomTimeEstimate(timeEstimateModel.customValue);
        setCustomTimeEstimateDraft(formatTimeEstimateLabel(next));
    };

    const applyCustomTimeEstimateDraft = (draft: string): boolean => {
        const next = parseTaskEditorTimeEstimate(draft);
        if (next === null) return false;
        setCustomTimeEstimate(next);
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
    const assignedToDraft = draft.assignedTo.trim();
    const assignedToCreateLabel = translateWithFallback(t, 'people.new', 'New Person');
    const canCreateAssignedToPerson = assignedToDraft.length > 0
        && !assignedToSuggestions.some((name) => name.trim().toLowerCase() === assignedToDraft.toLowerCase());

    switch (fieldId) {
        case 'status':
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={ListTodo}
                        label={t('taskEdit.statusLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View style={styles.statusContainerCompact}>
                        {availableStatusOptions.map((status) => {
                            const StatusIcon = getStatusIcon(status);
                            const active = draft.status === status;
                            const statusColor = active ? tc.onTint : tc.secondaryText;
                            return (
                                <TouchableOpacity
                                    key={status}
                                    style={[styles.statusChipCompact, {
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: 6,
                                    }, ...getStatusChipStyle(active)]}
                                    onPress={() => requestStatusChange(status)}
                                    onLongPress={status === 'done' ? requestBackdatedCompletion : undefined}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: active }}
                                    accessibilityLabel={`${t('taskEdit.statusLabel')}: ${getStatusLabel(status)}`}
                                    accessibilityHint={status === 'done'
                                        ? translateWithFallback(t, 'task.completeBackdateHintMobile', 'Long-press to complete with a different time')
                                        : undefined}
                                >
                                    <StatusIcon
                                        size={14}
                                        color={statusColor}
                                        aria-hidden
                                        accessible={false}
                                        pointerEvents="none"
                                    />
                                    <Text
                                        style={[...getStatusTextStyle(active, true), { width: undefined, flexShrink: 1 }]}
                                        numberOfLines={1}
                                        ellipsizeMode="tail"
                                        adjustsFontSizeToFit
                                        minimumFontScale={0.8}
                                    >
                                        {getStatusLabel(status)}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>
            );
        case 'project':
        case 'area': {
            const destinationFieldId = destinationFields.find(
                (candidate) => candidate === 'project' || candidate === 'area',
            );
            if (fieldId !== destinationFieldId) return null;
            const projectId = draft.projectId;
            const areaId = draft.areaId;
            const destination = projectId
                ? projects.find((project) => project.id === projectId)?.title || t('taskEdit.noProjectOption')
                : areaId
                    ? areas.find((area) => area.id === areaId)?.name || t('taskEdit.noAreaOption')
                    : t('common.none');
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={Folder}
                        label={t('task.destination')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <TouchableOpacity
                        style={[styles.dateBtn, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                        onPress={() => setShowProjectPicker(true)}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('task.destination')}: ${destination}`}
                    >
                        <Text style={{ color: tc.text }}>{destination}</Text>
                    </TouchableOpacity>
                </View>
            );
        }
        case 'section': {
            const projectId = draft.projectId;
            if (!projectId) return null;
            const section = projectSections.find((item) => item.id === draft.sectionId);
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={Layers}
                        label={t('taskEdit.sectionLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
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
                                accessibilityRole="button"
                                accessibilityLabel={t('common.clear')}
                            >
                                <X size={14} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
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
                    <FieldHeading
                        icon={Flag}
                        label={t('taskEdit.priorityLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={[...getStatusChipStyle(!draft.priority), {
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }]}
                            onPress={() => setDraftField('priority', '')}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.none')}
                        >
                            <CircleSlash
                                size={16}
                                color={!draft.priority ? tc.onTint : tc.secondaryText}
                                aria-hidden
                                accessible={false}
                                pointerEvents="none"
                            />
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
                    <FieldHeading
                        icon={BatteryCharging}
                        label={t('taskEdit.energyLevel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={[...getStatusChipStyle(!draft.energyLevel), {
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }]}
                            onPress={() => setDraftField('energyLevel', '')}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.none')}
                        >
                            <CircleSlash
                                size={16}
                                color={!draft.energyLevel ? tc.onTint : tc.secondaryText}
                                aria-hidden
                                accessible={false}
                                pointerEvents="none"
                            />
                        </TouchableOpacity>
                        {energyLevelOptions.map((energyLevel) => {
                            const EnergyIcon = getEnergyIcon(energyLevel);
                            const active = draft.energyLevel === energyLevel;
                            return (
                                <TouchableOpacity
                                    key={energyLevel}
                                    style={[...getStatusChipStyle(active), {
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                    }]}
                                    onPress={() => setDraftField('energyLevel', energyLevel)}
                                >
                                    <EnergyIcon
                                        size={14}
                                        color={active ? tc.onTint : tc.secondaryText}
                                        aria-hidden
                                        accessible={false}
                                        pointerEvents="none"
                                    />
                                    <Text style={getStatusTextStyle(active)}>
                                        {t(`energyLevel.${energyLevel}`)}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>
            );
        case 'assignedTo':
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={User}
                        label={t('taskEdit.assignedTo')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
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
            const customTimeEstimateLabel = timeEstimateModel.customLabel;
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={Hourglass}
                        label={t('taskEdit.timeEstimateLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View style={styles.statusContainer}>
                        {timeEstimateOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value || 'none'}
                                style={option.value
                                    ? getStatusChipStyle(draft.timeEstimate === option.value)
                                    : [...getStatusChipStyle(!draft.timeEstimate), {
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }]}
                                onPress={() => setDraftField('timeEstimate', option.value)}
                                accessibilityLabel={option.value ? undefined : t('common.none')}
                            >
                                {option.value ? (
                                    <Text style={getStatusTextStyle(draft.timeEstimate === option.value)}>
                                        {option.label}
                                    </Text>
                                ) : (
                                    <CircleSlash
                                        size={16}
                                        color={!draft.timeEstimate ? tc.onTint : tc.secondaryText}
                                        aria-hidden
                                        accessible={false}
                                        pointerEvents="none"
                                    />
                                )}
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
                                const next = parseTaskEditorTimeEstimate(draft);
                                if (next === null) return;
                                setCustomTimeEstimate(next);
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
                            <FieldHeading
                                icon={Timer}
                                label={translateWithFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent')}
                                iconColor={tc.secondaryText}
                                labelStyle={[styles.label, { color: tc.secondaryText }]}
                                rowStyle={{ marginTop: 12 }}
                            />
                            <TextInput
                                style={[styles.input, inputStyle]}
                                value={typeof draft.timeSpentMinutes === 'number' ? String(draft.timeSpentMinutes) : ''}
                                onChangeText={(text) => setDraftField('timeSpentMinutes', parseTaskEditorTimeSpent(text))}
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
