import React from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
    computeRelativeStartTime,
    editRRuleString,
    getProjectedRecurringTaskCalendarDate,
    getTaskDateCoherenceIssues,
    hasTimeComponent,
    parseRRuleString,
    RECURRENCE_INTERVAL_MAX,
    REPEAT_REMINDER_INTERVAL_OPTIONS,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type RecurrenceByDay,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
} from '@mindwtr/core';

import { QuickDateChips } from '../QuickDateChips';
import { CompactText } from '@/components/compact-text';
import { buildRecurrenceValue } from './recurrence-utils';
import type {
    ShowDatePickerMode,
    TaskEditFieldRendererProps,
} from './TaskEditFieldRenderer.types';

type ScheduleFieldId = 'recurrence' | 'startTime' | 'dueDate' | 'reviewAt';

type TaskEditScheduleFieldProps = TaskEditFieldRendererProps & {
    fieldId: ScheduleFieldId;
};

const normalizeRecurrenceIntervalInput = (value: number): number => (
    Number.isFinite(value) && value > 0
        ? Math.min(Math.round(value), RECURRENCE_INTERVAL_MAX)
        : 1
);

const isSubDayRelativeStartUnit = (unit: NonNullable<Task['relativeStartOffset']>['unit']): boolean => (
    unit === 'minute' || unit === 'hour'
);

const normalizeRelativeStartUnitForDueDate = (
    dueDate: string | undefined,
    unit: NonNullable<Task['relativeStartOffset']>['unit'],
): NonNullable<Task['relativeStartOffset']>['unit'] => (
    dueDate && !hasTimeComponent(dueDate) && isSubDayRelativeStartUnit(unit) ? 'day' : unit
);

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
            safeParseDate(draft.dueDate || draft.startTime || task?.dueDate || task?.startTime) ?? new Date(),
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
        const completedOccurrences = task?.recurrence && typeof task.recurrence === 'object'
            ? task.recurrence.completedOccurrences
            : undefined;
        const byDay = hasOverride('byDay')
            ? overrides.byDay
            : parsedRecurrenceRRule.byDay;
        const byMonthDay = hasOverride('byMonthDay') ? overrides.byMonthDay : parsedRecurrenceRRule.byMonthDay;
        const count = hasOverride('count') ? overrides.count : parsedRecurrenceRRule.count;
        const until = hasOverride('until') ? overrides.until : parsedRecurrenceRRule.until;
        const rrule = hasOverride('rrule')
            ? overrides.rrule
            : editRRuleString(recurrenceRRuleValue, rule, {
                ...(hasOverride('byDay') ? { byDay: overrides.byDay } : {}),
                ...(hasOverride('interval') ? { interval: overrides.interval } : {}),
                ...(hasOverride('byMonthDay') ? { byMonthDay: overrides.byMonthDay } : {}),
                ...(hasOverride('count') ? { count: overrides.count } : {}),
                ...(hasOverride('until') ? { until: overrides.until } : {}),
            });
        return buildRecurrenceValue(rule, hasOverride('strategy') ? overrides.strategy ?? recurrenceStrategyValue : recurrenceStrategyValue, {
            byDay,
            byMonthDay,
            count,
            until,
            completedOccurrences,
            rrule,
        });
    };
    const applyRecurrence = (recurrence: Task['recurrence']) => {
        if (!recurrence) {
            setDraftField('recurrence', '');
            setDraftField('recurrenceStrategy', 'strict');
            setDraftField('recurrenceRRule', '');
            return;
        }
        if (typeof recurrence === 'string') {
            setDraftField('recurrence', recurrence);
            setDraftField('recurrenceStrategy', 'strict');
            setDraftField('recurrenceRRule', '');
            return;
        }
        setDraftField('recurrence', recurrence.rule);
        setDraftField('recurrenceStrategy', recurrence.strategy === 'fluid' ? 'fluid' : 'strict');
        setDraftField('recurrenceRRule', recurrence.rrule ?? '');
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
            return getSafePickerDateValue(parsedRecurrenceRRule.until || recurrenceDefaultEndDate);
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
                    display="spinner"
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
    const formatStartDateTime = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        return safeFormatDate(
            parsed,
            hasTimeComponent(dateStr) ? 'P p' : 'P',
            t('common.notSet')
        ) || t('common.notSet');
    };
    const dateOnlyLabel = t('taskEdit.dateOnly');
    const dateIssueLabel = getTaskDateCoherenceIssues({
        startTime: draft.startTime,
        dueDate: draft.dueDate,
    }).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : '';
    const renderDateIssue = () => (
        dateIssueLabel ? (
            <Text style={[styles.dateIssueText, { color: tc.warning }]}>
                {dateIssueLabel}
            </Text>
        ) : null
    );
    const clearTimePart = (value?: string): string => {
        const parsed = safeParseDate(value);
        return parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
    };
    const projectedRecurrenceDateLabel = (() => {
        const recurrence = draft.recurrence ? buildEditedRecurrence(draft.recurrence) : undefined;
        if (!recurrenceRuleValue || !recurrence) return '';
        const nowIso = new Date().toISOString();
        const splitTokens = (value: string) => value.split(',').map((token) => token.trim()).filter(Boolean);
        const previewTask = {
            ...(task ?? {}),
            id: task?.id ?? 'draft-recurrence-preview',
            title: draft.title,
            status: draft.status,
            tags: splitTokens(draft.tags),
            contexts: splitTokens(draft.contexts),
            createdAt: task?.createdAt ?? nowIso,
            updatedAt: task?.updatedAt ?? nowIso,
            startTime: draft.startTime || undefined,
            dueDate: draft.dueDate || undefined,
            reviewAt: draft.reviewAt || undefined,
            recurrence,
            showFutureRecurrence: true,
        } as Task;
        return safeFormatDate(getProjectedRecurringTaskCalendarDate(previewTask, nowIso), 'PP');
    })();
    const projectedRecurrenceDateHint = projectedRecurrenceDateLabel
        ? `${tFallback(t, 'recurrence.nextCalendarPreview', 'Next calendar preview')}: ${projectedRecurrenceDateLabel}.`
        : '';
    const hasReminderHandoffSchedule = hasTimeComponent(draft.startTime) || hasTimeComponent(draft.dueDate);
    const renderReminderHandoffControl = () => {
        if (fieldId !== 'dueDate' || !hasReminderHandoffSchedule) return null;
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
        if (fieldId !== 'dueDate' || !hasTimeComponent(draft.dueDate)) return null;
        if (draft.suppressMindwtrReminders === true) return null;
        const label = tFallback(t, 'taskEdit.repeatReminderLabel', 'Repeat reminder');
        const current = draft.repeatReminderMinutes ?? 0;
        const options = [0, ...REPEAT_REMINDER_INTERVAL_OPTIONS];
        const formatValue = (minutes: number) => (
            minutes === 0
                ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                : tFallback(t, 'taskEdit.repeatReminderEveryMinutes', 'Every {count} min').replace('{count}', String(minutes))
        );
        const formatOption = (minutes: number) => (
            minutes === 0
                ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                : tFallback(t, 'taskEdit.repeatReminderMinutesShort', '{count} min').replace('{count}', String(minutes))
        );
        return (
            <View style={{ marginTop: 8 }}>
                <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${label}: ${formatValue(current)}`}
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
                            {formatValue(current)}
                        </Text>
                    </View>
                </TouchableOpacity>
                {repeatReminderOptionsExpanded && (
                    <View style={[styles.statusContainer, { marginTop: 8 }]}>
                        {options.map((minutes) => (
                            <TouchableOpacity
                                key={minutes}
                                accessibilityRole="button"
                                accessibilityLabel={formatOption(minutes)}
                                style={getStatusChipStyle(current === minutes)}
                                onPress={() => {
                                    setDraftField('repeatReminderMinutes', minutes > 0 ? minutes : undefined);
                                    setRepeatReminderOptionsExpanded(false);
                                }}
                            >
                                <Text style={getStatusTextStyle(current === minutes)}>
                                    {formatOption(minutes)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </View>
        );
    };

    const applyRelativeStartOffset = (amountValue: number, unitValue: NonNullable<Task['relativeStartOffset']>['unit']) => {
        if (!draft.dueDate || !Number.isFinite(amountValue)) return;
        const unit = normalizeRelativeStartUnitForDueDate(draft.dueDate, unitValue);
        // 0 is valid: start on the due date itself.
        const magnitude = Math.max(0, Math.floor(amountValue));
        const offset = { amount: magnitude === 0 ? 0 : -magnitude, unit };
        const computedStart = computeRelativeStartTime(draft.dueDate, offset);
        if (!computedStart) {
            setDraftField('relativeStartOffset', undefined);
            return;
        }
        setDraftField('relativeStartOffset', offset);
        setDraftField('startTime', computedStart);
    };

    const updateDueDate = (dueDate: string | undefined) => {
        setDraftField('dueDate', dueDate ?? '');
        if (!dueDate) {
            setDraftField('relativeStartOffset', undefined);
            return;
        }
        const computedStart = computeRelativeStartTime(dueDate, draft.relativeStartOffset);
        if (computedStart) setDraftField('startTime', computedStart);
        if (draft.relativeStartOffset && !computedStart) setDraftField('relativeStartOffset', undefined);
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
                                        applyRecurrence(undefined);
                                        return;
                                    }
                                    if (option.value === 'daily') {
                                        applyRecurrence(buildEditedRecurrence('daily', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval: parsedRecurrenceRRule.rule === 'daily' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                ? parsedRecurrenceRRule.interval
                                                : 1,
                                        }));
                                        return;
                                    }
                                    if (option.value === 'monthly') {
                                        applyRecurrence(buildEditedRecurrence('monthly', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval: parsedRecurrenceRRule.rule === 'monthly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                ? parsedRecurrenceRRule.interval
                                                : 1,
                                        }));
                                        return;
                                    }
                                    if (option.value === 'weekly') {
                                        applyRecurrence(buildEditedRecurrence('weekly', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval: undefined,
                                        }));
                                        return;
                                    }
                                    if (option.value === 'yearly') {
                                        applyRecurrence(buildEditedRecurrence('yearly', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval: parsedRecurrenceRRule.rule === 'yearly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                ? parsedRecurrenceRRule.interval
                                                : 1,
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
                                        const interval = normalizeRecurrenceIntervalInput(parsed);
                                        applyRecurrence(buildEditedRecurrence('weekly', {
                                            ...(customWeekdays.length > 0 ? { byDay: customWeekdays } : {}),
                                            byMonthDay: undefined,
                                            interval,
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
                                                    borderColor: active ? tc.tint : tc.border,
                                                    backgroundColor: active ? tc.tint : tc.cardBg,
                                                },
                                            ]}
                                            onPress={() => {
                                                const next = active
                                                    ? customWeekdays.filter((value) => value !== day.key)
                                                    : [...customWeekdays, day.key];
                                                setCustomWeekdays(next);
                                                applyRecurrence(buildEditedRecurrence('weekly', {
                                                    byDay: next,
                                                    byMonthDay: undefined,
                                                }));
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
                            <TextInput
                                value={String(dailyInterval)}
                                onChangeText={(value) => {
                                    const parsed = Number.parseInt(value, 10);
                                    const interval = normalizeRecurrenceIntervalInput(parsed);
                                    applyRecurrence(buildEditedRecurrence('daily', {
                                        byDay: undefined,
                                        byMonthDay: undefined,
                                        interval,
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
                                        const interval = normalizeRecurrenceIntervalInput(parsed);
                                        applyRecurrence(buildEditedRecurrence('monthly', { interval }));
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
                                        applyRecurrence(buildEditedRecurrence('monthly', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
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
                    {recurrenceRuleValue === 'yearly' && (
                        <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                            <TextInput
                                value={String(Math.max(parsedRecurrenceRRule.interval ?? 1, 1))}
                                onChangeText={(value) => {
                                    const parsed = Number.parseInt(value, 10);
                                    const interval = normalizeRecurrenceIntervalInput(parsed);
                                    applyRecurrence(buildEditedRecurrence('yearly', {
                                        byDay: undefined,
                                        byMonthDay: undefined,
                                        interval,
                                    }));
                                }}
                                keyboardType="number-pad"
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
                                        applyRecurrence(buildEditedRecurrence(recurrenceRuleValue, {
                                            count: undefined,
                                            until: undefined,
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
                                        applyRecurrence(buildEditedRecurrence(recurrenceRuleValue, {
                                            count: undefined,
                                            until: parsedRecurrenceRRule.until || recurrenceDefaultEndDate,
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
                                        applyRecurrence(buildEditedRecurrence(recurrenceRuleValue, {
                                            count: parsedRecurrenceRRule.count ?? 1,
                                            until: undefined,
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
                                            applyRecurrence(buildEditedRecurrence(recurrenceRuleValue, {
                                                count,
                                                until: undefined,
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
                                    applyRecurrence(buildEditedRecurrence(recurrenceRuleValue, {
                                        strategy: nextStrategy,
                                        byDay: recurrenceRuleValue === 'weekly' && customWeekdays.length > 0
                                            ? customWeekdays
                                            : undefined,
                                    }));
                                }}
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
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.startDateLabel')}</Text>
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
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                        {hasTime && timeOnly ? timeOnly : (tFallback(t, 'calendar.changeTime', 'Add time'))}
                                    </Text>
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
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('start', parsed)}
                        {renderDateIssue()}
                        {!!draft.dueDate && (() => {
                            const dueDateHasTime = hasTimeComponent(draft.dueDate);
                            const relativeUnit = normalizeRelativeStartUnitForDueDate(
                                draft.dueDate,
                                draft.relativeStartOffset?.unit ?? 'day'
                            );
                            const relativeAmount = draft.relativeStartOffset ? Math.abs(draft.relativeStartOffset.amount) : 3;
                            const modeOptions = [
                                { label: t('taskEdit.startModeAbsolute'), active: !draft.relativeStartOffset, onPress: () => setDraftField('relativeStartOffset', undefined) },
                                { label: t('taskEdit.startModeRelative'), active: Boolean(draft.relativeStartOffset), onPress: () => applyRelativeStartOffset(relativeAmount, relativeUnit) },
                            ];
                            const unitOptions: Array<{ value: NonNullable<Task['relativeStartOffset']>['unit']; label: string }> = dueDateHasTime
                                ? [
                                    { value: 'minute', label: t('taskEdit.relativeStartMinutesShort') },
                                    { value: 'hour', label: t('taskEdit.relativeStartHoursShort') },
                                    { value: 'day', label: t('taskEdit.relativeStartDaysShort') },
                                    { value: 'week', label: t('taskEdit.relativeStartWeeksShort') },
                                ]
                                : [
                                    { value: 'day', label: t('taskEdit.relativeStartDaysShort') },
                                    { value: 'week', label: t('taskEdit.relativeStartWeeksShort') },
                                ];
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
                                    {!!draft.relativeStartOffset && (
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
                            <CompactText
                                style={[styles.compactFieldLabel, { color: tc.secondaryText }]}
                            >
                                {t('taskEdit.dueDateLabel')}
                            </CompactText>
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
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.dueDateLabel')}</Text>
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
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                        {hasTime && timeOnly ? timeOnly : (tFallback(t, 'calendar.changeTime', 'Add time'))}
                                    </Text>
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
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
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
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
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
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
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
