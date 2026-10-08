import React from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
    editTaskDraftRecurrence,
    formatTaskEditorDate,
    getTaskDraftDateOnly,
    getTaskDraftRelativeStartEdit,
    getTaskEditorDateIssueLabel,
    getTaskEditorRecurrenceDefaultUntil,
    getTaskEditorRecurrenceDetails,
    getTaskEditorRecurrenceCalendarPreviewHint,
    getTaskEditorRelativeStart,
    getTaskEditorReminders,
    hasTimeComponent,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type RelativeStartOffsetUnit,
    type TaskDraftRecurrenceEdit,
} from '@mindwtr/core';
import {
    Calendar,
    CalendarClock,
    CalendarDays,
    CalendarX,
    Clock,
    Repeat,
} from 'lucide-react-native';

import { QuickDateChips } from '../QuickDateChips';
import { CompactText } from '@/components/compact-text';
import { FieldHeading } from './FieldHeading';
import { RecurrenceIntervalInput } from './RecurrenceIntervalInput';
import type {
    ShowDatePickerMode,
    TaskEditFieldRendererProps,
} from './TaskEditFieldRenderer.types';

type ScheduleFieldId = 'recurrence' | 'startTime' | 'dueDate' | 'reviewAt';

type TaskEditScheduleFieldProps = TaskEditFieldRendererProps & {
    fieldId: ScheduleFieldId;
};

export function TaskEditScheduleField({
    applyQuickDate,
    customWeekdays,
    dailyInterval,
    draft,
    fieldId,
    formatDate,
    formatDueDate,
    getSafePickerDateValue,
    monthlyPattern,
    onDateChange,
    openCustomRecurrence,
    pendingDueDate,
    pendingStartDate,
    recurrenceOptions,
    recurrenceRRuleValue,
    recurrenceRuleValue,
    recurrenceStrategyValue,
    recurrenceWeekdayButtons,
    setCustomWeekdays,
    setDraftField,
    setShowDatePicker,
    showDatePicker,
    styles,
    t,
    tc,
    task,
}: TaskEditScheduleFieldProps) {
    const [repeatReminderOptionsExpanded, setRepeatReminderOptionsExpanded] = React.useState(false);
    if (!draft) return null;
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? tc.onTint : tc.secondaryText },
    ]);
    const recurrenceDraft = {
        ...draft,
        recurrence: recurrenceRuleValue,
        recurrenceStrategy: recurrenceStrategyValue,
        recurrenceRRule: recurrenceRRuleValue,
    };
    const recurrenceDetails = getTaskEditorRecurrenceDetails({
        draft: recurrenceDraft,
        task,
        dailyInterval,
        t,
        formatDate: safeFormatDate,
        now: new Date(),
    });
    const recurrenceEndMode = recurrenceDetails.ends;
    const applyRecurrenceEdit = (edit: TaskDraftRecurrenceEdit) => {
        const next = editTaskDraftRecurrence(recurrenceDraft, edit, {
            weekdays: customWeekdays,
            defaultUntil: getTaskEditorRecurrenceDefaultUntil(recurrenceDraft, task, safeFormatDate),
        });
        setDraftField('recurrence', next.recurrence);
        setDraftField('recurrenceStrategy', next.recurrenceStrategy);
        setDraftField('recurrenceRRule', next.recurrenceRRule);
    };
    const openDatePicker = (mode: NonNullable<ShowDatePickerMode>) => {
        Keyboard.dismiss();
        setShowDatePicker(mode);
    };
    const getDatePickerValue = (mode: NonNullable<ShowDatePickerMode>) => {
        if (mode === 'start') return getSafePickerDateValue(draft.startTime);
        if (mode === 'start-time') return pendingStartDate ?? getSafePickerDateValue(draft.startTime);
        if (mode === 'review') return getSafePickerDateValue(draft.reviewAt);
        if (mode === 'recurrence-end') {
            return getSafePickerDateValue(recurrenceDetails.until);
        }
        if (mode === 'due-time') return pendingDueDate ?? getSafePickerDateValue(draft.dueDate);
        return getSafePickerDateValue(draft.dueDate);
    };
    const getDatePickerMode = (mode: NonNullable<ShowDatePickerMode>) =>
        mode === 'start-time' || mode === 'due-time' ? 'time' : 'date';
    const renderInlineIOSDatePicker = (targetModes: NonNullable<ShowDatePickerMode>[]) => {
        if (Platform.OS !== 'ios' || !showDatePicker || !targetModes.includes(showDatePicker)) {
            return null;
        }
        return (
            <View style={{ marginTop: 8 }}>
                <View style={styles.pickerToolbar}>
                    <View style={styles.pickerSpacer} />
                    <Pressable
                        onPress={() => setShowDatePicker(null)}
                        style={[styles.pickerDone, { backgroundColor: tc.tint }]}
                    >
                        <Text style={[styles.pickerDoneText, { color: tc.onTint }]}>{t('common.done')}</Text>
                    </Pressable>
                </View>
                <DateTimePicker
                    key={showDatePicker}
                    value={getDatePickerValue(showDatePicker)}
                    mode={getDatePickerMode(showDatePicker)}
                    display={getDatePickerMode(showDatePicker) === 'date' ? 'inline' : 'spinner'}
                    textColor={tc.text}
                    onChange={onDateChange}
                />
            </View>
        );
    };
    const renderQuickDateChips = (
        mode: 'start' | 'due' | 'review',
        selectedDate: Date | null
    ) => {
        return (
            <QuickDateChips
                t={t}
                tc={tc}
                selectedDate={selectedDate}
                onSelect={(date) => applyQuickDate(mode, date)}
            />
        );
    };
    const formatStartDateTime = (dateStr?: string) => formatTaskEditorDate(dateStr, safeFormatDate, t('common.notSet'));
    const dateOnlyLabel = t('taskEdit.dateOnly');
    const dateIssueLabel = getTaskEditorDateIssueLabel(draft, t);
    const renderDateIssue = () => (
        dateIssueLabel ? (
            <Text style={[styles.dateIssueText, { color: tc.warning }]}>
                {dateIssueLabel}
            </Text>
        ) : null
    );
    const clearTimePart = (value?: string): string => getTaskDraftDateOnly(value, safeFormatDate);
    const projectedRecurrenceDateHint = getTaskEditorRecurrenceCalendarPreviewHint({ draft, task, t, formatDate: safeFormatDate });
    const reminders = getTaskEditorReminders(draft, t);
    const renderReminderHandoffControl = () => {
        if (fieldId !== 'dueDate' || !reminders.showSkip) return null;
        const enabled = draft.suppressMindwtrReminders === true;
        return (
            <TouchableOpacity
                accessibilityRole="switch"
                accessibilityState={{ checked: enabled }}
                style={[
                    styles.dateBtn,
                    {
                        marginTop: 8,
                        backgroundColor: enabled ? tc.filterBg : tc.cardBg,
                        borderColor: enabled ? tc.tint : tc.border,
                    },
                ]}
                onPress={() => setDraftField('suppressMindwtrReminders', !draft.suppressMindwtrReminders)}
            >
                <Text style={[styles.modalLabel, { color: tc.text }]}>
                    {tFallback(t, 'taskEdit.suppressMindwtrReminders', 'Skip reminders')}
                </Text>
                <Text style={{ marginTop: 4, color: tc.secondaryText, fontSize: 12, lineHeight: 16 }}>
                    {tFallback(t, 'taskEdit.suppressMindwtrRemindersHint', 'Skip start and due reminders for this task. It still appears in Focus and your lists.')}
                </Text>
            </TouchableOpacity>
        );
    };
    const renderRepeatReminderControl = () => {
        if (fieldId !== 'dueDate' || !reminders.showRepeat) return null;
        const label = reminders.repeatLabel;
        const current = draft.repeatReminderMinutes ?? 0;
        return (
            <View style={{ marginTop: 8 }}>
                <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${label}: ${reminders.repeatValueLabel}`}
                    style={[
                        styles.dateBtn,
                        {
                            backgroundColor: current > 0 ? tc.filterBg : tc.cardBg,
                            borderColor: repeatReminderOptionsExpanded || current > 0 ? tc.tint : tc.border,
                        },
                    ]}
                    onPress={() => setRepeatReminderOptionsExpanded((expanded) => !expanded)}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={[styles.modalLabel, { color: tc.text, flexShrink: 1 }]} numberOfLines={1}>{label}</Text>
                        <Text style={{ color: current > 0 ? tc.tint : tc.secondaryText, fontSize: 13, flexShrink: 0 }} numberOfLines={1}>
                            {reminders.repeatValueLabel}
                        </Text>
                    </View>
                </TouchableOpacity>
                {repeatReminderOptionsExpanded && (
                    <View style={[styles.statusContainer, { marginTop: 8 }]}>
                        {reminders.repeatOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value ?? 0}
                                accessibilityRole="button"
                                accessibilityLabel={option.label}
                                style={getStatusChipStyle(option.selected)}
                                onPress={() => {
                                    setDraftField('repeatReminderMinutes', option.value ?? undefined);
                                    setRepeatReminderOptionsExpanded(false);
                                }}
                            >
                                <Text style={getStatusTextStyle(option.selected)}>
                                    {option.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </View>
        );
    };

    const relativeStart = getTaskEditorRelativeStart(draft, t);
    const applyRelativeStartOffset = (amountValue: number, unitValue: RelativeStartOffsetUnit) => {
        const edit = getTaskDraftRelativeStartEdit(draft.dueDate, amountValue, unitValue);
        if (!edit) return;
        for (const [field, value] of Object.entries(edit)) {
            setDraftField(field as 'relativeStartOffset' | 'startTime', value as never);
        }
    };

    // A new due date moves a relative start, or ends the link, through the draft's cascade.
    const updateDueDate = (dueDate: string | undefined) => {
        setDraftField('dueDate', dueDate ?? '');
    };

    switch (fieldId) {
        case 'recurrence':
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={Repeat}
                        label={t('taskEdit.recurrenceLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View style={styles.statusContainer}>
                        {recurrenceOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value || 'none'}
                                style={getStatusChipStyle(
                                    recurrenceRuleValue === option.value || (!option.value && !recurrenceRuleValue)
                                )}
                                onPress={() => {
                                    if (option.value !== 'weekly') {
                                        setCustomWeekdays([]);
                                    }
                                    applyRecurrenceEdit({ kind: 'rule', rule: option.value });
                                }}
                            >
                                <Text style={getStatusTextStyle(
                                    recurrenceRuleValue === option.value || (!option.value && !recurrenceRuleValue)
                                )}>
                                    {option.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {recurrenceRuleValue === 'weekly' && (
                        <>
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <RecurrenceIntervalInput
                                    interval={recurrenceDetails.interval}
                                    onIntervalChange={(interval) => applyRecurrenceEdit({ kind: 'interval', interval })}
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.weekUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.weekUnit')}</Text>
                            </View>
                            <View style={[styles.weekdayRow, { marginTop: 10 }]}>
                                {recurrenceWeekdayButtons.map((day) => {
                                    const active = customWeekdays.includes(day.key);
                                    return (
                                        <TouchableOpacity
                                            key={day.key}
                                            style={[
                                                styles.weekdayButton,
                                                {
                                                    borderColor: active ? tc.tint : tc.border,
                                                    backgroundColor: active ? tc.tint : tc.cardBg,
                                                },
                                            ]}
                                            onPress={() => {
                                                const next = active
                                                    ? customWeekdays.filter((value) => value !== day.key)
                                                    : [...customWeekdays, day.key];
                                                setCustomWeekdays(next);
                                                applyRecurrenceEdit({ kind: 'weekdays', weekdays: next });
                                            }}
                                        >
                                            <Text style={[styles.weekdayButtonText, { color: active ? tc.onTint : tc.text }]}>{day.label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </>
                    )}
                    {recurrenceRuleValue === 'daily' && (
                        <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                            <RecurrenceIntervalInput
                                interval={recurrenceDetails.interval}
                                onIntervalChange={(interval) => applyRecurrenceEdit({ kind: 'interval', interval })}
                                style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                accessibilityLabel={t('recurrence.repeatEvery')}
                                accessibilityHint={t('recurrence.dayUnit')}
                            />
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.dayUnit')}</Text>
                        </View>
                    )}
                    {recurrenceRuleValue === 'monthly' && (
                        <>
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <RecurrenceIntervalInput
                                    interval={recurrenceDetails.interval}
                                    onIntervalChange={(interval) => applyRecurrenceEdit({ kind: 'interval', interval })}
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.monthUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.monthUnit')}</Text>
                            </View>
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'date')}
                                    onPress={() => applyRecurrenceEdit({ kind: 'monthlyOnDay' })}
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
                        </>
                    )}
                    {recurrenceRuleValue === 'yearly' && (
                        <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                            <RecurrenceIntervalInput
                                interval={recurrenceDetails.interval}
                                onIntervalChange={(interval) => applyRecurrenceEdit({ kind: 'interval', interval })}
                                style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                accessibilityLabel={t('recurrence.repeatEvery')}
                                accessibilityHint={t('recurrence.yearUnit')}
                            />
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.yearUnit')}</Text>
                        </View>
                    )}
                    {!!recurrenceRuleValue && (
                        <View style={{ marginTop: 8 }}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.endsLabel')}</Text>
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'never')}
                                    onPress={() => {
                                        setShowDatePicker(null);
                                        applyRecurrenceEdit({ kind: 'ends', ends: 'never' });
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'never')}>
                                        {t('recurrence.endsNever')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'until')}
                                    onPress={() => {
                                        applyRecurrenceEdit({ kind: 'ends', ends: 'until' });
                                        openDatePicker('recurrence-end');
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'until')}>
                                        {t('recurrence.endsOnDate')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'count')}
                                    onPress={() => {
                                        setShowDatePicker(null);
                                        applyRecurrenceEdit({ kind: 'ends', ends: 'count' });
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'count')}>
                                        {t('recurrence.endsAfterCount')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                            {recurrenceEndMode === 'until' && (
                                <View style={{ marginTop: 8 }}>
                                    <TouchableOpacity
                                        style={[styles.dateBtn, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                        onPress={() => openDatePicker('recurrence-end')}
                                    >
                                        <Text style={{ color: tc.text }}>
                                            {recurrenceDetails.untilLabel}
                                        </Text>
                                    </TouchableOpacity>
                                    {renderInlineIOSDatePicker(['recurrence-end'])}
                                </View>
                            )}
                            {recurrenceEndMode === 'count' && (
                                <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                    <TextInput
                                        value={String(recurrenceDetails.count)}
                                        onChangeText={(value) => applyRecurrenceEdit({ kind: 'count', text: value })}
                                        keyboardType="number-pad"
                                        style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                        accessibilityLabel={t('recurrence.endsAfterCount')}
                                        accessibilityHint={t('recurrence.occurrenceUnit')}
                                    />
                                    <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.occurrenceUnit')}</Text>
                                </View>
                            )}
                        </View>
                    )}
                    {!!recurrenceRuleValue && (
                        <View style={[styles.statusContainer, { marginTop: 8 }]}>
                            <TouchableOpacity
                                style={getStatusChipStyle(recurrenceStrategyValue === 'fluid')}
                                onPress={() => applyRecurrenceEdit({ kind: 'strategy' })}
                            >
                                <Text style={getStatusTextStyle(recurrenceStrategyValue === 'fluid')}>
                                    {t('recurrence.afterCompletion')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    {!!recurrenceRuleValue && (
                        <TouchableOpacity
                            accessibilityRole="switch"
                            accessibilityState={{ checked: draft.showFutureRecurrence === true }}
                            style={[
                                styles.dateBtn,
                                {
                                    marginTop: 8,
                                    backgroundColor: draft.showFutureRecurrence ? tc.filterBg : tc.cardBg,
                                    borderColor: draft.showFutureRecurrence ? tc.tint : tc.border,
                                },
                            ]}
                            onPress={() => setDraftField('showFutureRecurrence', !draft.showFutureRecurrence)}
                        >
                            <Text style={[styles.modalLabel, { color: tc.text }]}>
                                {tFallback(t, 'recurrence.showFutureInCalendar', 'Show next occurrence in Calendar')}
                            </Text>
                            <Text style={{ marginTop: 4, color: tc.secondaryText, fontSize: 12, lineHeight: 16 }}>
                                {tFallback(t, 'recurrence.showFutureInCalendarHint', 'Planning-only preview; the next task is still created when this one is completed.')}
                                {projectedRecurrenceDateHint ? ` ${projectedRecurrenceDateHint}` : ''}
                            </Text>
                        </TouchableOpacity>
                    )}
                </View>
            );
        case 'startTime': {
            const parsed = draft.startTime ? safeParseDate(draft.startTime) : null;
            const hasTime = hasTimeComponent(draft.startTime);
            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={Calendar}
                        label={t('taskEdit.startDateLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('start')}
                            >
                                <Text style={{ color: tc.text }}>{formatStartDateTime(draft.startTime)}</Text>
                            </TouchableOpacity>
                            {!!draft.startTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => openDatePicker('start-time')}
                                    accessibilityRole="button"
                                    accessibilityLabel={hasTime && timeOnly
                                        ? `${t('task.aria.startTime')}: ${timeOnly}`
                                        : tFallback(t, 'calendar.changeTime', 'Add time')}
                                >
                                    <Clock size={14} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
                                </TouchableOpacity>
                            )}
                            {!!draft.startTime && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => {
                                        setDraftField('startTime', clearTimePart(draft.startTime));
                                        setDraftField('relativeStartOffset', undefined);
                                    }}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                                </TouchableOpacity>
                            )}
                            {!!draft.startTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => {
                                        setDraftField('startTime', '');
                                        setDraftField('relativeStartOffset', undefined);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.clear')}
                                >
                                    <CalendarX size={14} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('start', parsed)}
                        {renderDateIssue()}
                        {relativeStart && (() => {
                            const relativeUnit = relativeStart.unit;
                            const relativeAmount = relativeStart.amount;
                            const modeOptions = [
                                { label: t('taskEdit.startModeAbsolute'), active: !relativeStart.active, onPress: () => setDraftField('relativeStartOffset', undefined) },
                                { label: t('taskEdit.startModeRelative'), active: relativeStart.active, onPress: () => applyRelativeStartOffset(relativeAmount, relativeUnit) },
                            ];
                            const unitOptions = relativeStart.units.map(({ unit, label }) => ({ value: unit, label }));
                            return (
                                <View style={{ marginTop: 10, gap: 8 }}>
                                    <View style={{ flexDirection: 'row', gap: 8 }}>
                                        {modeOptions.map((option) => (
                                            <TouchableOpacity
                                                key={option.label}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected: option.active }}
                                                style={[
                                                    styles.statusChip,
                                                    { backgroundColor: option.active ? tc.tint : tc.filterBg, borderColor: option.active ? tc.tint : tc.border },
                                                ]}
                                                onPress={option.onPress}
                                            >
                                                <Text style={[styles.statusText, { color: option.active ? tc.onTint : tc.secondaryText }]}>{option.label}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                    {relativeStart.active && (
                                        <View style={{ gap: 8 }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                <TextInput
                                                    value={String(relativeAmount)}
                                                    keyboardType="number-pad"
                                                    onChangeText={(text) => applyRelativeStartOffset(Number(text), relativeUnit)}
                                                    style={[styles.input, { width: 74, color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                    accessibilityLabel={t('taskEdit.relativeStartAmount')}
                                                />
                                                <Text style={{ color: tc.secondaryText }}>
                                                    {t('taskEdit.relativeStartBeforeDue')}
                                                </Text>
                                            </View>
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                                {unitOptions.map((option) => {
                                                    const active = relativeUnit === option.value;
                                                    return (
                                                        <TouchableOpacity
                                                            key={option.value}
                                                            accessibilityRole="button"
                                                            accessibilityState={{ selected: active }}
                                                            style={[
                                                                styles.statusChip,
                                                                { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
                                                            ]}
                                                            onPress={() => applyRelativeStartOffset(relativeAmount, option.value)}
                                                        >
                                                            <Text style={[styles.statusText, { color: active ? tc.onTint : tc.secondaryText }]}>{option.label}</Text>
                                                        </TouchableOpacity>
                                                    );
                                                })}
                                            </View>
                                        </View>
                                    )}
                                </View>
                            );
                        })()}
                        {renderInlineIOSDatePicker(['start', 'start-time'])}
                    </View>
                </View>
            );
        }
        case 'dueDate': {
            const parsed = draft.dueDate ? safeParseDate(draft.dueDate) : null;
            const hasTime = hasTimeComponent(draft.dueDate);
            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
            if (!draft.dueDate) {
                const notSetLabel = t('common.notSet');
                return (
                    <View style={styles.formGroup}>
                        <TouchableOpacity
                            style={[styles.compactFieldRow, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                            onPress={() => openDatePicker('due')}
                            accessibilityRole="button"
                            accessibilityLabel={`${t('taskEdit.dueDateLabel')}: ${notSetLabel}`}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                                <CalendarDays
                                    size={14}
                                    color={tc.secondaryText}
                                    aria-hidden
                                    accessible={false}
                                    pointerEvents="none"
                                />
                                <CompactText
                                    style={[styles.compactFieldLabel, { color: tc.secondaryText }]}
                                >
                                    {t('taskEdit.dueDateLabel')}
                                </CompactText>
                            </View>
                            <CompactText
                                style={[styles.compactFieldValue, { color: tc.tint }]}
                                numberOfLines={2}
                            >
                                {notSetLabel}
                            </CompactText>
                        </TouchableOpacity>
                        {renderQuickDateChips('due', parsed)}
                        {renderInlineIOSDatePicker(['due'])}
                        {renderReminderHandoffControl()}
                        {renderRepeatReminderControl()}
                    </View>
                );
            }
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={CalendarDays}
                        label={t('taskEdit.dueDateLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('due')}
                            >
                                <Text style={{ color: tc.text }}>{formatDueDate(draft.dueDate)}</Text>
                            </TouchableOpacity>
                            {!!draft.dueDate && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => openDatePicker('due-time')}
                                    accessibilityRole="button"
                                    accessibilityLabel={hasTime && timeOnly
                                        ? `${t('task.aria.dueTime')}: ${timeOnly}`
                                        : tFallback(t, 'calendar.changeTime', 'Add time')}
                                >
                                    <Clock size={14} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
                                </TouchableOpacity>
                            )}
                            {!!draft.dueDate && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => updateDueDate(clearTimePart(draft.dueDate))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                                </TouchableOpacity>
                            )}
                            {!!draft.dueDate && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => updateDueDate(undefined)}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.clear')}
                                >
                                    <CalendarX size={14} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('due', parsed)}
                        {renderDateIssue()}
                        {renderInlineIOSDatePicker(['due', 'due-time'])}
                        {renderReminderHandoffControl()}
                        {renderRepeatReminderControl()}
                    </View>
                </View>
            );
        }
        case 'reviewAt': {
            const parsed = draft.reviewAt ? safeParseDate(draft.reviewAt) : null;
            const hasTime = hasTimeComponent(draft.reviewAt);
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={CalendarClock}
                        label={t('taskEdit.reviewDateLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('review')}
                            >
                                <Text style={{ color: tc.text }}>{formatStartDateTime(draft.reviewAt)}</Text>
                            </TouchableOpacity>
                            {!!draft.reviewAt && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setDraftField('reviewAt', clearTimePart(draft.reviewAt))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                                </TouchableOpacity>
                            )}
                            {!!draft.reviewAt && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setDraftField('reviewAt', '')}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.clear')}
                                >
                                    <CalendarX size={14} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('review', parsed)}
                        {renderInlineIOSDatePicker(['review'])}
                    </View>
                </View>
            );
        }
        default:
            return null;
    }
}
