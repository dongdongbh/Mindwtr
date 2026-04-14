import React from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
    buildRRuleString,
    hasTimeComponent,
    parseRRuleString,
    safeFormatDate,
    safeParseDate,
} from '@mindwtr/core';

import { buildRecurrenceValue } from './recurrence-utils';
import type {
    MonthlyRecurrenceByDay,
    ShowDatePickerMode,
    TaskEditFieldRendererProps,
} from './TaskEditFieldRenderer.types';

type ScheduleFieldId = 'recurrence' | 'startTime' | 'dueDate' | 'reviewAt';

type TaskEditScheduleFieldProps = TaskEditFieldRendererProps & {
    fieldId: ScheduleFieldId;
};

export function TaskEditScheduleField({
    customWeekdays,
    dailyInterval,
    editedTask,
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
    setEditedTask,
    setShowDatePicker,
    showDatePicker,
    styles,
    t,
    tc,
    task,
}: TaskEditScheduleFieldProps) {
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const openDatePicker = (mode: NonNullable<ShowDatePickerMode>) => {
        Keyboard.dismiss();
        setShowDatePicker(mode);
    };
    const getDatePickerValue = (mode: NonNullable<ShowDatePickerMode>) => {
        if (mode === 'start') return getSafePickerDateValue(editedTask.startTime);
        if (mode === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
        if (mode === 'review') return getSafePickerDateValue(editedTask.reviewAt);
        if (mode === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
        return getSafePickerDateValue(editedTask.dueDate);
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

    switch (fieldId) {
        case 'recurrence':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.recurrenceLabel')}</Text>
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
                                    if (option.value === 'daily') {
                                        const parsed = parseRRuleString(recurrenceRRuleValue);
                                        const interval = parsed.rule === 'daily' && parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: {
                                                rule: 'daily',
                                                strategy: recurrenceStrategyValue,
                                                rrule: buildRRuleString('daily', undefined, interval),
                                            },
                                        }));
                                        return;
                                    }
                                    if (option.value === 'monthly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: {
                                                rule: 'monthly',
                                                strategy: recurrenceStrategyValue,
                                                rrule: buildRRuleString('monthly'),
                                            },
                                        }));
                                        return;
                                    }
                                    setEditedTask((prev) => ({
                                        ...prev,
                                        recurrence: buildRecurrenceValue(option.value, recurrenceStrategyValue),
                                    }));
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
                                                ? customWeekdays.filter((value) => value !== day.key)
                                                : [...customWeekdays, day.key];
                                            setCustomWeekdays(next);
                                            setEditedTask((prev) => ({
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
                                    setEditedTask((prev) => ({
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
                                    setEditedTask((prev) => ({
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
                                    const nextStrategy = recurrenceStrategyValue === 'fluid' ? 'strict' : 'fluid';
                                    setEditedTask((prev) => ({
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
                                                    ? {
                                                        rule: recurrenceRuleValue,
                                                        strategy: nextStrategy,
                                                        ...(parseRRuleString(recurrenceRRuleValue).byDay
                                                            ? { byDay: parseRRuleString(recurrenceRRuleValue).byDay }
                                                            : {}),
                                                        rrule: recurrenceRRuleValue,
                                                    }
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
        case 'startTime': {
            const parsed = editedTask.startTime ? safeParseDate(editedTask.startTime) : null;
            const hasTime = hasTimeComponent(editedTask.startTime);
            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.startDateLabel')}</Text>
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('start')}
                            >
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
                                    onPress={() => setEditedTask((prev) => ({ ...prev, startTime: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderInlineIOSDatePicker(['start', 'start-time'])}
                    </View>
                </View>
            );
        }
        case 'dueDate': {
            const parsed = editedTask.dueDate ? safeParseDate(editedTask.dueDate) : null;
            const hasTime = hasTimeComponent(editedTask.dueDate);
            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.dueDateLabel')}</Text>
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('due')}
                            >
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
                                    onPress={() => setEditedTask((prev) => ({ ...prev, dueDate: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderInlineIOSDatePicker(['due', 'due-time'])}
                    </View>
                </View>
            );
        }
        case 'reviewAt':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => openDatePicker('review')}
                        >
                            <Text style={{ color: tc.text }}>{formatDate(editedTask.reviewAt)}</Text>
                        </TouchableOpacity>
                        {!!editedTask.reviewAt && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, reviewAt: undefined }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    {renderInlineIOSDatePicker(['review'])}
                </View>
            );
        default:
            return null;
    }
}
