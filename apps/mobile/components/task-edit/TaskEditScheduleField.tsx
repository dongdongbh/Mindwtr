import React from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
    buildRRuleString,
    getRecurrenceUntilValue,
    hasTimeComponent,
    parseRRuleString,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type RecurrenceByDay,
    type RecurrenceRule,
    type RecurrenceStrategy,
} from '@mindwtr/core';

import { buildRecurrenceValue } from './recurrence-utils';
import type {
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
    const parsedRecurrenceRRule = parseRRuleString(recurrenceRRuleValue);
    const monthlyInterval = recurrenceRuleValue === 'monthly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
        ? parsedRecurrenceRRule.interval
        : 1;
    const recurrenceEndMode: 'never' | 'until' | 'count' = parsedRecurrenceRRule.count
        ? 'count'
        : parsedRecurrenceRRule.until
            ? 'until'
            : 'never';
    const recurrenceDefaultEndDate = parsedRecurrenceRRule.until
        || safeFormatDate(
            safeParseDate(editedTask.dueDate ?? editedTask.startTime ?? task?.dueDate ?? task?.startTime) ?? new Date(),
            'yyyy-MM-dd'
        );
    const buildEditedRecurrence = (
        rule: RecurrenceRule,
        overrides: {
            strategy?: RecurrenceStrategy;
            byDay?: RecurrenceByDay[];
            interval?: number;
            byMonthDay?: number[];
            count?: number;
            until?: string;
            rrule?: string;
        } = {}
    ) => {
        const hasOverride = <TKey extends keyof typeof overrides>(key: TKey) =>
            Object.prototype.hasOwnProperty.call(overrides, key);
        const completedOccurrences = editedTask.recurrence && typeof editedTask.recurrence === 'object'
            ? editedTask.recurrence.completedOccurrences
            : undefined;
        const byDay = hasOverride('byDay')
            ? overrides.byDay
            : (editedTask.recurrence && typeof editedTask.recurrence === 'object' && editedTask.recurrence.byDay?.length
                ? editedTask.recurrence.byDay
                : parsedRecurrenceRRule.byDay);
        const interval = hasOverride('interval') ? overrides.interval : parsedRecurrenceRRule.interval;
        const byMonthDay = hasOverride('byMonthDay') ? overrides.byMonthDay : parsedRecurrenceRRule.byMonthDay;
        const count = hasOverride('count') ? overrides.count : parsedRecurrenceRRule.count;
        const until = hasOverride('until') ? overrides.until : parsedRecurrenceRRule.until;
        const rrule = hasOverride('rrule')
            ? overrides.rrule
            : buildRRuleString(rule, byDay, interval, { byMonthDay, count, until });
        return buildRecurrenceValue(rule, hasOverride('strategy') ? overrides.strategy ?? recurrenceStrategyValue : recurrenceStrategyValue, {
            byDay,
            count,
            until,
            completedOccurrences,
            rrule,
        });
    };
    const openDatePicker = (mode: NonNullable<ShowDatePickerMode>) => {
        Keyboard.dismiss();
        setShowDatePicker(mode);
    };
    const getDatePickerValue = (mode: NonNullable<ShowDatePickerMode>) => {
        if (mode === 'start') return getSafePickerDateValue(editedTask.startTime);
        if (mode === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
        if (mode === 'review') return getSafePickerDateValue(editedTask.reviewAt);
        if (mode === 'recurrence-end') {
            return getSafePickerDateValue(getRecurrenceUntilValue(editedTask.recurrence) || recurrenceDefaultEndDate);
        }
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
    const dateOnlyLabel = tFallback(t, 'taskEdit.dateOnly', 'Date only');
    const clearTimePart = (value?: string): string | undefined => {
        const parsed = safeParseDate(value);
        return parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : undefined;
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
                                    if (!option.value) {
                                        setEditedTask((prev) => ({ ...prev, recurrence: undefined }));
                                        return;
                                    }
                                    if (option.value === 'daily') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('daily', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: parsedRecurrenceRRule.rule === 'daily' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                    ? parsedRecurrenceRRule.interval
                                                    : 1,
                                            }),
                                        }));
                                        return;
                                    }
                                    if (option.value === 'monthly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('monthly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: parsedRecurrenceRRule.rule === 'monthly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                    ? parsedRecurrenceRRule.interval
                                                    : 1,
                                            }),
                                        }));
                                        return;
                                    }
                                    if (option.value === 'weekly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('weekly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: undefined,
                                            }),
                                        }));
                                        return;
                                    }
                                    if (option.value === 'yearly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('yearly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: undefined,
                                            }),
                                        }));
                                        return;
                                    }
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
                                <TextInput
                                    value={String(Math.max(parsedRecurrenceRRule.interval ?? 1, 1))}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        const interval = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 52) : 1;
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('weekly', {
                                                ...(customWeekdays.length > 0 ? { byDay: customWeekdays } : {}),
                                                byMonthDay: undefined,
                                                interval,
                                            }),
                                        }));
                                    }}
                                    keyboardType="number-pad"
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
                                                    recurrence: buildEditedRecurrence('weekly', {
                                                        byDay: next,
                                                        byMonthDay: undefined,
                                                    }),
                                                }));
                                            }}
                                        >
                                            <Text style={[styles.weekdayButtonText, { color: tc.text }]}>{day.label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </>
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
                                        recurrence: buildEditedRecurrence('daily', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval,
                                        }),
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
                        <>
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <TextInput
                                    value={String(monthlyInterval)}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        const interval = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 1;
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('monthly', { interval }),
                                        }));
                                    }}
                                    keyboardType="number-pad"
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.monthUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.monthUnit')}</Text>
                            </View>
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'date')}
                                    onPress={() => {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('monthly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                            }),
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
                        </>
                    )}
                    {!!recurrenceRuleValue && (
                        <View style={{ marginTop: 8 }}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.endsLabel')}</Text>
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'never')}
                                    onPress={() => {
                                        setShowDatePicker(null);
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                count: undefined,
                                                until: undefined,
                                            }),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'never')}>
                                        {t('recurrence.endsNever')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'until')}
                                    onPress={() => {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                count: undefined,
                                                until: parsedRecurrenceRRule.until || recurrenceDefaultEndDate,
                                            }),
                                        }));
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
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                count: parsedRecurrenceRRule.count ?? 1,
                                                until: undefined,
                                            }),
                                        }));
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
                                            {formatDate(parsedRecurrenceRRule.until || recurrenceDefaultEndDate)}
                                        </Text>
                                    </TouchableOpacity>
                                    {renderInlineIOSDatePicker(['recurrence-end'])}
                                </View>
                            )}
                            {recurrenceEndMode === 'count' && (
                                <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                    <TextInput
                                        value={String(Math.max(parsedRecurrenceRRule.count ?? 1, 1))}
                                        onChangeText={(value) => {
                                            const parsed = Number.parseInt(value, 10);
                                            const count = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 999) : 1;
                                            setEditedTask((prev) => ({
                                                ...prev,
                                                recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                    count,
                                                    until: undefined,
                                                }),
                                            }));
                                        }}
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
                                onPress={() => {
                                    const nextStrategy = recurrenceStrategyValue === 'fluid' ? 'strict' : 'fluid';
                                    setEditedTask((prev) => ({
                                        ...prev,
                                        recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                            strategy: nextStrategy,
                                            byDay: recurrenceRuleValue === 'weekly' && customWeekdays.length > 0
                                                ? customWeekdays
                                                : undefined,
                                        }),
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
                            {!!editedTask.startTime && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask((prev) => ({ ...prev, startTime: clearTimePart(prev.startTime) }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
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
                            {!!editedTask.dueDate && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask((prev) => ({ ...prev, dueDate: clearTimePart(prev.dueDate) }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
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
        case 'reviewAt': {
            const hasTime = hasTimeComponent(editedTask.reviewAt);
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => openDatePicker('review')}
                        >
                            <Text style={{ color: tc.text }}>{formatStartDateTime(editedTask.reviewAt)}</Text>
                        </TouchableOpacity>
                        {!!editedTask.reviewAt && hasTime && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, reviewAt: clearTimePart(prev.reviewAt) }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                            </TouchableOpacity>
                        )}
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
        }
        default:
            return null;
    }
}
