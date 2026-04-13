import React from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import {
    type Attachment,
    type Area,
    buildRRuleString,
    generateUUID,
    getAttachmentDisplayTitle,
    hasTimeComponent,
    parseRRuleString,
    RecurrenceRule,
    resolveAutoTextDirection,
    type Project,
    type Section,
    safeFormatDate,
    safeParseDate,
    type Task,
    TaskEditorFieldId,
    type TaskEnergyLevel,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type TaskPriority,
    TaskStatus,
    type TimeEstimate,
    type RecurrenceWeekday,
    type RecurrenceStrategy,
} from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

import { MarkdownFormatToolbar } from '../markdown-format-toolbar';
import { MarkdownText } from '../markdown-text';
import { buildRecurrenceValue } from './recurrence-utils';
import type { SetEditedTask } from './use-task-edit-state';

type ShowDatePickerMode = 'start' | 'start-time' | 'due' | 'due-time' | 'review' | null;

type PickerOption<T extends string> = {
    value: T | '';
    label: string;
};

type WeekdayButton = {
    key: RecurrenceWeekday;
    label: string;
};

type TaskEditFieldRendererProps = {
    fieldId: TaskEditorFieldId;
    addFileAttachment: () => void | Promise<void>;
    addImageAttachment: () => void | Promise<void>;
    applyContextSuggestion: (token: string) => void;
    applyTagSuggestion: (token: string) => void;
    areas: Area[];
    availableStatusOptions: TaskStatus[];
    commitContextDraft: () => void;
    commitTagDraft: () => void;
    contextInputDraft: string;
    contextTokenSuggestions: string[];
    customWeekdays: RecurrenceWeekday[];
    dailyInterval: number;
    descriptionDraft: string;
    descriptionInputRef: React.RefObject<TextInput | null>;
    descriptionSelection: MarkdownSelection;
    setDescriptionSelection: (selection: MarkdownSelection) => void;
    descriptionUndoDepth: number;
    isDescriptionInputFocused: boolean;
    setIsDescriptionInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    handleDescriptionChange: (text: string) => void;
    handleDescriptionUndo: () => MarkdownSelection | undefined;
    handleDescriptionApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult;
    openDescriptionExpandedEditor: () => void;
    downloadAttachment: (attachment: Attachment) => void | Promise<void>;
    editedTask: Partial<Task>;
    formatDate: (dateStr?: string) => string;
    formatDueDate: (dateStr?: string) => string;
    frequentContextSuggestions: string[];
    frequentTagSuggestions: string[];
    getSafePickerDateValue: (dateStr?: string) => Date;
    handleInputFocus: (targetInput?: number | string) => void;
    handleResetChecklist: () => void;
    language: string;
    monthlyPattern: 'date' | 'custom';
    onDateChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
    openAttachment: (attachment: Attachment) => void | Promise<void>;
    openCustomRecurrence: () => void;
    pendingDueDate: Date | null;
    pendingStartDate: Date | null;
    prioritiesEnabled: boolean;
    energyLevelOptions: TaskEnergyLevel[];
    priorityOptions: TaskPriority[];
    projects: Project[];
    projectSections: Section[];
    recurrenceOptions: PickerOption<RecurrenceRule>[];
    recurrenceRRuleValue: string;
    recurrenceRuleValue: RecurrenceRule | '';
    recurrenceStrategyValue: RecurrenceStrategy;
    recurrenceWeekdayButtons: WeekdayButton[];
    removeAttachment: (attachmentId: string) => void | Promise<void>;
    selectedContextTokens: Set<string>;
    selectedTagTokens: Set<string>;
    setCustomWeekdays: React.Dispatch<React.SetStateAction<RecurrenceWeekday[]>>;
    setEditedTask: SetEditedTask;
    setIsContextInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    setIsTagInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    setLinkInputTouched: React.Dispatch<React.SetStateAction<boolean>>;
    setLinkModalVisible: React.Dispatch<React.SetStateAction<boolean>>;
    setShowAreaPicker: React.Dispatch<React.SetStateAction<boolean>>;
    setShowDatePicker: React.Dispatch<React.SetStateAction<ShowDatePickerMode>>;
    setShowDescriptionPreview: React.Dispatch<React.SetStateAction<boolean>>;
    setShowProjectPicker: React.Dispatch<React.SetStateAction<boolean>>;
    setShowSectionPicker: React.Dispatch<React.SetStateAction<boolean>>;
    showDatePicker: ShowDatePickerMode;
    showDescriptionPreview: boolean;
    styles: Record<string, any>;
    tagInputDraft: string;
    tagTokenSuggestions: string[];
    task: Task | null;
    t: (key: string) => string;
    tc: ThemeColors;
    timeEstimateOptions: PickerOption<TimeEstimate>[];
    timeEstimatesEnabled: boolean;
    titleDraft: string;
    toggleQuickContextToken: (token: string) => void;
    toggleQuickTagToken: (token: string) => void;
    updateContextInput: (text: string) => void;
    updateTagInput: (text: string) => void;
    visibleAttachments: Attachment[];
};

export function TaskEditFieldRenderer(input: TaskEditFieldRendererProps) {
    const { fieldId } = input;
    const {
        addFileAttachment,
        addImageAttachment,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        contextInputDraft,
        contextTokenSuggestions,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionInputRef,
        descriptionSelection,
        setDescriptionSelection,
        descriptionUndoDepth,
        isDescriptionInputFocused,
        setIsDescriptionInputFocused,
        handleDescriptionChange,
        handleDescriptionUndo,
        handleDescriptionApplyAction,
        openDescriptionExpandedEditor,
        downloadAttachment,
        editedTask,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        language,
        monthlyPattern,
        onDateChange,
        openAttachment,
        openCustomRecurrence,
        pendingDueDate,
        pendingStartDate,
        prioritiesEnabled,
        energyLevelOptions,
        priorityOptions,
        projects,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        recurrenceWeekdayButtons,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setEditedTask,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setLinkInputTouched,
        setLinkModalVisible,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        showDatePicker,
        showDescriptionPreview,
        styles,
        tagInputDraft,
        tagTokenSuggestions,
        task,
        t,
        tc,
        timeEstimateOptions,
        timeEstimatesEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
        applyContextSuggestion,
        applyTagSuggestion,
        areas,
    } = input;
    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = {
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    } as const;
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const getStatusLabel = (status: TaskStatus) => {
        const key = `status.${status}` as const;
        const translated = t(key);
        return translated === key ? status : translated;
    };
    const getQuickTokenChipStyle = (active: boolean) => ([
        styles.quickTokenChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getQuickTokenTextStyle = (active: boolean) => ([
        styles.quickTokenText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const formatStartDateTime = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        if (!hasTimeComponent(dateStr)) {
            return parsed.toLocaleDateString();
        }
        return parsed.toLocaleString(undefined, {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };
    const openDatePicker = (mode: NonNullable<typeof showDatePicker>) => {
        Keyboard.dismiss();
        setShowDatePicker(mode);
    };
    const getDatePickerValue = (mode: NonNullable<typeof showDatePicker>) => {
        if (mode === 'start') return getSafePickerDateValue(editedTask.startTime);
        if (mode === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
        if (mode === 'review') return getSafePickerDateValue(editedTask.reviewAt);
        if (mode === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
        return getSafePickerDateValue(editedTask.dueDate);
    };
    const getDatePickerMode = (mode: NonNullable<typeof showDatePicker>) =>
        mode === 'start-time' || mode === 'due-time' ? 'time' : 'date';
    const renderInlineIOSDatePicker = (targetModes: NonNullable<typeof showDatePicker>[]) => {
        if (Platform.OS !== 'ios' || !showDatePicker || !targetModes.includes(showDatePicker)) {
            return null;
        }
        return (
            <View style={{ marginTop: 8 }}>
                <View style={styles.pickerToolbar}>
                    <View style={styles.pickerSpacer} />
                    <Pressable onPress={() => setShowDatePicker(null)} style={styles.pickerDone}>
                        <Text style={styles.pickerDoneText}>{t('common.done')}</Text>
                    </Pressable>
                </View>
                <DateTimePicker
                    value={getDatePickerValue(showDatePicker)}
                    mode={getDatePickerMode(showDatePicker)}
                    display="spinner"
                    onChange={onDateChange}
                />
            </View>
        );
    };

    const renderField = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.statusLabel')}</Text>
                        <View style={styles.statusContainerCompact}>
                            {availableStatusOptions.map(status => (
                                <TouchableOpacity
                                    key={status}
                                    style={[styles.statusChipCompact, ...getStatusChipStyle(editedTask.status === status)]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, status }))}
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
                                    {projects.find((p) => p.id === editedTask.projectId)?.title || t('taskEdit.noProjectOption')}
                                </Text>
                            </TouchableOpacity>
                            {!!editedTask.projectId && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, projectId: undefined, sectionId: undefined }))}
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
                                    onPress={() => setEditedTask(prev => ({ ...prev, sectionId: undefined }))}
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
                                    onPress={() => setEditedTask(prev => ({ ...prev, areaId: undefined }))}
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
                                onPress={() => setEditedTask(prev => ({ ...prev, priority: undefined }))}
                            >
                                <Text style={getStatusTextStyle(!editedTask.priority)}>
                                    {t('common.none')}
                                </Text>
                            </TouchableOpacity>
                            {priorityOptions.map(priority => (
                                <TouchableOpacity
                                    key={priority}
                                    style={getStatusChipStyle(editedTask.priority === priority)}
                                    onPress={() => setEditedTask(prev => ({ ...prev, priority }))}
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
                                onPress={() => setEditedTask(prev => ({ ...prev, energyLevel: undefined }))}
                            >
                                <Text style={getStatusTextStyle(!editedTask.energyLevel)}>
                                    {t('common.none')}
                                </Text>
                            </TouchableOpacity>
                            {energyLevelOptions.map((energyLevel) => (
                                <TouchableOpacity
                                    key={energyLevel}
                                    style={getStatusChipStyle(editedTask.energyLevel === energyLevel)}
                                    onPress={() => setEditedTask(prev => ({ ...prev, energyLevel }))}
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
                            onChangeText={(assignedTo) => setEditedTask(prev => ({ ...prev, assignedTo }))}
                            onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                            placeholder={t('taskEdit.assignedToPlaceholder')}
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={t('taskEdit.assignedTo')}
                            accessibilityHint={t('taskEdit.assignedToPlaceholder')}
                        />
                    </View>
                );
            case 'contexts':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.contextsLabel')}</Text>
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={contextInputDraft}
                            onChangeText={updateContextInput}
                            onFocus={(event) => {
                                setIsContextInputFocused(true);
                                handleInputFocus(event.nativeEvent.target);
                            }}
                            onBlur={commitContextDraft}
                            onSubmitEditing={() => {
                                commitContextDraft();
                                Keyboard.dismiss();
                            }}
                            returnKeyType="done"
                            blurOnSubmit
                            placeholder={t('taskEdit.contextsPlaceholder')}
                            autoCapitalize="none"
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={t('taskEdit.contextsLabel')}
                            accessibilityHint={t('taskEdit.contextsPlaceholder')}
                        />
                        {contextTokenSuggestions.length > 0 && (
                            <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                {contextTokenSuggestions.map((token, index) => (
                                    <TouchableOpacity
                                        key={token}
                                        style={[
                                            styles.tokenSuggestionItem,
                                            index === contextTokenSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                        ]}
                                        onPress={() => applyContextSuggestion(token)}
                                    >
                                        <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                        {frequentContextSuggestions.length > 0 && (
                            <View style={styles.quickTokensRow}>
                                {frequentContextSuggestions.map((token) => {
                                    const isActive = selectedContextTokens.has(token);
                                    return (
                                        <TouchableOpacity
                                            key={token}
                                            style={getQuickTokenChipStyle(isActive)}
                                            onPress={() => toggleQuickContextToken(token)}
                                        >
                                            <Text style={getQuickTokenTextStyle(isActive)}>{token}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                );
            case 'tags':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.tagsLabel')}</Text>
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={tagInputDraft}
                            onChangeText={updateTagInput}
                            onFocus={(event) => {
                                setIsTagInputFocused(true);
                                handleInputFocus(event.nativeEvent.target);
                            }}
                            onBlur={commitTagDraft}
                            onSubmitEditing={() => {
                                commitTagDraft();
                                Keyboard.dismiss();
                            }}
                            returnKeyType="done"
                            blurOnSubmit
                            placeholder={t('taskEdit.tagsPlaceholder')}
                            autoCapitalize="none"
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={t('taskEdit.tagsLabel')}
                            accessibilityHint={t('taskEdit.tagsPlaceholder')}
                        />
                        {tagTokenSuggestions.length > 0 && (
                            <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                {tagTokenSuggestions.map((token, index) => (
                                    <TouchableOpacity
                                        key={token}
                                        style={[
                                            styles.tokenSuggestionItem,
                                            index === tagTokenSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                        ]}
                                        onPress={() => applyTagSuggestion(token)}
                                    >
                                        <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                        {frequentTagSuggestions.length > 0 && (
                            <View style={styles.quickTokensRow}>
                                {frequentTagSuggestions.map((token) => {
                                    const isActive = selectedTagTokens.has(token);
                                    return (
                                        <TouchableOpacity
                                            key={token}
                                            style={getQuickTokenChipStyle(isActive)}
                                            onPress={() => toggleQuickTagToken(token)}
                                        >
                                            <Text style={getQuickTokenTextStyle(isActive)}>{token}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                );
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return null;
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.timeEstimateLabel')}</Text>
                        <View style={styles.statusContainer}>
                            {timeEstimateOptions.map(opt => (
                                <TouchableOpacity
                                    key={opt.value || 'none'}
                                    style={getStatusChipStyle(
                                        editedTask.timeEstimate === opt.value || (!opt.value && !editedTask.timeEstimate)
                                    )}
                                    onPress={() => setEditedTask(prev => ({ ...prev, timeEstimate: opt.value || undefined }))}
                                >
                                    <Text style={getStatusTextStyle(
                                        editedTask.timeEstimate === opt.value || (!opt.value && !editedTask.timeEstimate)
                                    )}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                );
            case 'recurrence':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.recurrenceLabel')}</Text>
                        <View style={styles.statusContainer}>
                            {recurrenceOptions.map(opt => (
                                <TouchableOpacity
                                    key={opt.value || 'none'}
                                    style={getStatusChipStyle(
                                        recurrenceRuleValue === opt.value || (!opt.value && !recurrenceRuleValue)
                                    )}
                                    onPress={() => {
                                        if (opt.value !== 'weekly') {
                                            setCustomWeekdays([]);
                                        }
                                        if (opt.value === 'daily') {
                                            const parsed = parseRRuleString(recurrenceRRuleValue);
                                            const interval = parsed.rule === 'daily' && parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
                                            setEditedTask(prev => ({
                                                ...prev,
                                                recurrence: {
                                                    rule: 'daily',
                                                    strategy: recurrenceStrategyValue,
                                                    rrule: buildRRuleString('daily', undefined, interval),
                                                },
                                            }));
                                            return;
                                        }
                                        if (opt.value === 'monthly') {
                                            setEditedTask(prev => ({
                                                ...prev,
                                                recurrence: {
                                                    rule: 'monthly',
                                                    strategy: recurrenceStrategyValue,
                                                    rrule: buildRRuleString('monthly'),
                                                },
                                            }));
                                            return;
                                        }
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: buildRecurrenceValue(opt.value as RecurrenceRule | '', recurrenceStrategyValue),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(
                                        recurrenceRuleValue === opt.value || (!opt.value && !recurrenceRuleValue)
                                    )}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        {recurrenceRuleValue === 'weekly' && (
                            <View style={[styles.weekdayRow, { marginTop: 10 }]}>
                                {recurrenceWeekdayButtons.map((day) => {
                                    const active = customWeekdays.includes(day.key);
                                    return (
                                        <TouchableOpacity
                                            key={day.key}
                                            style={[
                                                styles.weekdayButton,
                                                {
                                                    borderColor: tc.border,
                                                    backgroundColor: active ? tc.filterBg : tc.cardBg,
                                                },
                                            ]}
                                            onPress={() => {
                                                const next = active
                                                    ? customWeekdays.filter((d) => d !== day.key)
                                                    : [...customWeekdays, day.key];
                                                setCustomWeekdays(next);
                                                setEditedTask(prev => ({
                                                    ...prev,
                                                    recurrence: {
                                                        rule: 'weekly',
                                                        strategy: recurrenceStrategyValue,
                                                        byDay: next,
                                                        rrule: buildRRuleString('weekly', next),
                                                    },
                                                }));
                                            }}
                                        >
                                            <Text style={[styles.weekdayButtonText, { color: tc.text }]}>{day.label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}
                        {recurrenceRuleValue === 'daily' && (
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <TextInput
                                    value={String(dailyInterval)}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        const interval = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 1;
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: {
                                                rule: 'daily',
                                                strategy: recurrenceStrategyValue,
                                                rrule: buildRRuleString('daily', undefined, interval),
                                            },
                                        }));
                                    }}
                                    keyboardType="number-pad"
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.dayUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.dayUnit')}</Text>
                            </View>
                        )}
                        {recurrenceRuleValue === 'monthly' && (
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'date')}
                                    onPress={() => {
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: {
                                                rule: 'monthly',
                                                strategy: recurrenceStrategyValue,
                                                rrule: buildRRuleString('monthly'),
                                            },
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(monthlyPattern === 'date')}>
                                        {t('recurrence.monthlyOnDay')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'custom')}
                                    onPress={openCustomRecurrence}
                                >
                                    <Text style={getStatusTextStyle(monthlyPattern === 'custom')}>
                                        {t('recurrence.custom')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        {!!recurrenceRuleValue && (
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceStrategyValue === 'fluid')}
                                    onPress={() => {
                                        const nextStrategy: RecurrenceStrategy = recurrenceStrategyValue === 'fluid' ? 'strict' : 'fluid';
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence:
                                                recurrenceRuleValue === 'weekly' && customWeekdays.length > 0
                                                    ? {
                                                        rule: 'weekly',
                                                        strategy: nextStrategy,
                                                        byDay: customWeekdays,
                                                        rrule: buildRRuleString('weekly', customWeekdays),
                                                    }
                                                    : recurrenceRuleValue && recurrenceRRuleValue
                                                        ? { rule: recurrenceRuleValue, strategy: nextStrategy, ...(parseRRuleString(recurrenceRRuleValue).byDay ? { byDay: parseRRuleString(recurrenceRRuleValue).byDay } : {}), rrule: recurrenceRRuleValue }
                                                        : buildRecurrenceValue(recurrenceRuleValue, nextStrategy),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceStrategyValue === 'fluid')}>
                                        {t('recurrence.afterCompletion')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                );
            case 'startTime':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.startDateLabel')}</Text>
                        {(() => {
                            const parsed = editedTask.startTime ? safeParseDate(editedTask.startTime) : null;
                            const hasTime = hasTimeComponent(editedTask.startTime);
                            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                            return (
                                <View>
                                    <View style={styles.dateRow}>
                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => openDatePicker('start')}>
                                            <Text style={{ color: tc.text }}>{formatStartDateTime(editedTask.startTime)}</Text>
                                        </TouchableOpacity>
                                        {!!editedTask.startTime && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => openDatePicker('start-time')}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                                    {hasTime && timeOnly ? timeOnly : (t('calendar.changeTime') || 'Add time')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        {!!editedTask.startTime && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => setEditedTask(prev => ({ ...prev, startTime: undefined }))}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                    {renderInlineIOSDatePicker(['start', 'start-time'])}
                                </View>
                            );
                        })()}
                    </View>
                );
            case 'dueDate':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.dueDateLabel')}</Text>
                        {(() => {
                            const parsed = editedTask.dueDate ? safeParseDate(editedTask.dueDate) : null;
                            const hasTime = hasTimeComponent(editedTask.dueDate);
                            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                            return (
                                <View>
                                    <View style={styles.dateRow}>
                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => openDatePicker('due')}>
                                            <Text style={{ color: tc.text }}>{formatDueDate(editedTask.dueDate)}</Text>
                                        </TouchableOpacity>
                                        {!!editedTask.dueDate && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => openDatePicker('due-time')}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                                    {hasTime && timeOnly ? timeOnly : (t('calendar.changeTime') || 'Add time')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        {!!editedTask.dueDate && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => setEditedTask(prev => ({ ...prev, dueDate: undefined }))}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                    {renderInlineIOSDatePicker(['due', 'due-time'])}
                                </View>
                            );
                        })()}
                    </View>
                );
            case 'reviewAt':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => openDatePicker('review')}>
                                <Text style={{ color: tc.text }}>{formatDate(editedTask.reviewAt)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.reviewAt && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, reviewAt: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderInlineIOSDatePicker(['review'])}
                    </View>
                );
            case 'description':
                return (
                    <View style={styles.formGroup}>
                        <View style={styles.inlineHeader}>
                            <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
                            <View style={styles.inlineActions}>
                                <TouchableOpacity onPress={() => setShowDescriptionPreview((v) => !v)}>
                                    <Text style={[styles.inlineAction, { color: tc.tint }]}>
                                        {showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={openDescriptionExpandedEditor}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('markdown.expand')}
                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                >
                                    <Ionicons name="expand-outline" size={20} color={tc.tint} />
                                </TouchableOpacity>
                            </View>
                        </View>
                        {showDescriptionPreview ? (
                            <View style={[styles.markdownPreview, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                                <MarkdownText markdown={descriptionDraft || ''} tc={tc} direction={resolvedDirection} />
                            </View>
                        ) : (
                            <>
                                <MarkdownFormatToolbar
                                    selection={descriptionSelection}
                                    onSelectionChange={setDescriptionSelection}
                                    inputRef={descriptionInputRef}
                                    t={t}
                                    tc={tc}
                                    visible={isDescriptionInputFocused}
                                    canUndo={descriptionUndoDepth > 0}
                                    onUndo={handleDescriptionUndo}
                                    onApplyAction={handleDescriptionApplyAction}
                                />
                                <TextInput
                                    ref={descriptionInputRef}
                                    style={[styles.input, styles.textArea, inputStyle, textDirectionStyle]}
                                    value={descriptionDraft}
                                    onFocus={(event) => {
                                        setIsDescriptionInputFocused(true);
                                        handleInputFocus(event.nativeEvent.target);
                                    }}
                                    onBlur={() => setIsDescriptionInputFocused(false)}
                                    onChangeText={handleDescriptionChange}
                                    onSelectionChange={(event) => setDescriptionSelection(event.nativeEvent.selection)}
                                    selection={descriptionSelection}
                                    placeholder={t('taskEdit.descriptionPlaceholder')}
                                    multiline
                                    placeholderTextColor={tc.secondaryText}
                                    accessibilityLabel={t('taskEdit.descriptionLabel')}
                                    accessibilityHint={t('taskEdit.descriptionPlaceholder')}
                                />
                            </>
                        )}
                    </View>
                );
            case 'attachments':
                return (
                    <View style={styles.formGroup}>
                        <View style={styles.inlineHeader}>
                            <Text style={[styles.label, { color: tc.secondaryText }]}>{t('attachments.title')}</Text>
                            <View style={styles.inlineActions}>
                                <TouchableOpacity
                                    onPress={addFileAttachment}
                                    style={[styles.smallButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addFile')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={addImageAttachment}
                                    style={[styles.smallButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addPhoto')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={() => {
                                        setLinkInputTouched(false);
                                        setLinkModalVisible(true);
                                    }}
                                    style={[styles.smallButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addLink')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                        {visibleAttachments.length === 0 ? (
                            <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('common.none')}</Text>
                        ) : (
                            <View style={[styles.attachmentsList, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                                {visibleAttachments.map((attachment) => {
                                    const displayTitle = getAttachmentDisplayTitle(attachment);
                                    const isMissing = attachment.kind === 'file'
                                        && (!attachment.uri || attachment.localStatus === 'missing');
                                    const canDownload = isMissing && Boolean(attachment.cloudKey);
                                    const isDownloading = attachment.localStatus === 'downloading';
                                    return (
                                        <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                            <TouchableOpacity
                                                style={styles.attachmentTitleWrap}
                                                onPress={() => openAttachment(attachment)}
                                                disabled={isDownloading}
                                            >
                                                <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                                    {displayTitle}
                                                </Text>
                                            </TouchableOpacity>
                                            {isDownloading ? (
                                                <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                    {t('common.loading')}
                                                </Text>
                                            ) : canDownload ? (
                                                <TouchableOpacity onPress={() => downloadAttachment(attachment)}>
                                                    <Text style={[styles.attachmentDownload, { color: tc.tint }]}>
                                                        {t('attachments.download')}
                                                    </Text>
                                                </TouchableOpacity>
                                            ) : isMissing ? (
                                                <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                    {t('attachments.missing')}
                                                </Text>
                                            ) : null}
                                            <TouchableOpacity onPress={() => removeAttachment(attachment.id)}>
                                                <Text style={[styles.attachmentRemove, { color: tc.secondaryText }]}>
                                                    {t('attachments.remove')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                );
            case 'checklist':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.checklist')}</Text>
                        <View style={[styles.checklistContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            {editedTask.checklist?.map((item, index) => (
                                <View key={item.id || index} style={[styles.checklistItem, { borderBottomColor: tc.border }]}>
                                    <TouchableOpacity
                                        onPress={() => {
                                            const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                i === index ? { ...item, isCompleted: !item.isCompleted } : item
                                            );
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        style={styles.checkboxTouch}
                                    >
                                        <View style={[styles.checkbox, item.isCompleted && styles.checkboxChecked]}>
                                            {item.isCompleted && <Text style={styles.checkmark}>✓</Text>}
                                        </View>
                                    </TouchableOpacity>
                                    <TextInput
                                        style={[
                                            styles.checklistInput,
                                            textDirectionStyle,
                                            { color: item.isCompleted ? tc.secondaryText : tc.text },
                                            item.isCompleted && styles.completedText,
                                        ]}
                                        value={item.title}
                                        onFocus={(event) => {
                                            handleInputFocus(event.nativeEvent.target);
                                        }}
                                        onChangeText={(text) => {
                                            const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                i === index ? { ...item, title: text } : item
                                            );
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        placeholder={t('taskEdit.itemNamePlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                        accessibilityLabel={`${t('taskEdit.checklist')} ${index + 1}`}
                                        accessibilityHint={t('taskEdit.itemNamePlaceholder')}
                                    />
                                    <TouchableOpacity
                                        onPress={() => {
                                            const newChecklist = (editedTask.checklist || []).filter((_, i) => i !== index);
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        style={styles.deleteBtn}
                                    >
                                        <Text style={[styles.deleteBtnText, { color: tc.secondaryText }]}>×</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}
                            <TouchableOpacity
                                style={styles.addChecklistBtn}
                                onPress={() => {
                                    const newItem = {
                                        id: generateUUID(),
                                        title: '',
                                        isCompleted: false
                                    };
                                    setEditedTask(prev => ({
                                        ...prev,
                                        checklist: [...(prev.checklist || []), newItem]
                                    }));
                                }}
                            >
                                <Text style={styles.addChecklistText}>+ {t('taskEdit.addItem')}</Text>
                            </TouchableOpacity>
                            {(editedTask.checklist?.length ?? 0) > 0 && (
                                <View style={styles.checklistActions}>
                                    <TouchableOpacity
                                        style={[styles.checklistActionButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                        onPress={handleResetChecklist}
                                    >
                                        <Text style={[styles.checklistActionText, { color: tc.secondaryText }]}>
                                            {t('taskEdit.resetChecklist')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    </View>
                );
            default:
                return null;
        }
    };
    return renderField(fieldId);
}
