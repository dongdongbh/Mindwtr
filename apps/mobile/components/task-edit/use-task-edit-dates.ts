import React from 'react';
import { Platform } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { buildRRuleString, hasTimeComponent, parseRRuleString, safeFormatDate, safeParseDate, safeParseDueDate, type Task } from '@mindwtr/core';

import type { SetEditedTask } from './use-task-edit-state';
import { buildRecurrenceValue } from './recurrence-utils';

type UseTaskEditDatesParams = {
    editedTask: Partial<Task>;
    pendingDueDate: Date | null;
    pendingStartDate: Date | null;
    setEditedTask: SetEditedTask;
    setPendingDueDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setPendingStartDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setShowDatePicker: React.Dispatch<React.SetStateAction<'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'recurrence-end' | null>>;
    showDatePicker: 'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'recurrence-end' | null;
    defaultScheduleTime?: string;
    t: (key: string) => string;
};

const buildDateWithTimeValue = (date: Date, time: string): string => {
    const dateOnly = safeFormatDate(date, 'yyyy-MM-dd');
    return time ? `${dateOnly}T${time}` : dateOnly;
};

const applyClockTime = (date: Date, time: string): Date => {
    const combined = new Date(date);
    const [hour, minute] = time.split(':').map((part) => Number.parseInt(part, 10));
    combined.setHours(
        Number.isFinite(hour) ? hour : 0,
        Number.isFinite(minute) ? minute : 0,
        0,
        0
    );
    return combined;
};

export function useTaskEditDates({
    editedTask,
    pendingDueDate,
    pendingStartDate,
    setEditedTask,
    setPendingDueDate,
    setPendingStartDate,
    setShowDatePicker,
    showDatePicker,
    defaultScheduleTime = '',
    t,
}: UseTaskEditDatesParams) {
    const updateRecurrenceEndDate = React.useCallback((until: string) => {
        setEditedTask((prev) => {
            const recurrence = prev.recurrence;
            if (!recurrence) return prev;
            const rule = typeof recurrence === 'string' ? recurrence : recurrence.rule;
            if (!rule) return prev;
            const strategy = typeof recurrence === 'object' && recurrence.strategy === 'fluid' ? 'fluid' : 'strict';
            const parsed = typeof recurrence === 'object' && recurrence.rrule
                ? parseRRuleString(recurrence.rrule)
                : {};
            const byDay = typeof recurrence === 'object' && recurrence.byDay?.length
                ? recurrence.byDay
                : parsed.byDay;
            const completedOccurrences = typeof recurrence === 'object'
                ? recurrence.completedOccurrences
                : undefined;
            const rrule = buildRRuleString(rule, byDay, parsed.interval, {
                byMonthDay: parsed.byMonthDay,
                until,
            });
            return {
                ...prev,
                recurrence: buildRecurrenceValue(rule, strategy, {
                    byDay,
                    until,
                    completedOccurrences,
                    rrule,
                }),
            };
        });
    }, [setEditedTask]);

    const onDateChange = React.useCallback((event: DateTimePickerEvent, selectedDate?: Date) => {
        const currentMode = showDatePicker;
        if (!currentMode) return;

        if (event.type === 'dismissed') {
            if (currentMode === 'start-time') setPendingStartDate(null);
            if (currentMode === 'due-time') setPendingDueDate(null);
            setShowDatePicker(null);
            return;
        }

        if (!selectedDate) return;

        if (currentMode === 'start') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.startTime && hasTimeComponent(editedTask.startTime)
                ? safeParseDate(editedTask.startTime)
                : null;
            if (existing) {
                const combined = new Date(selectedDate);
                combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
                setPendingStartDate(combined);
                setEditedTask((prev) => ({ ...prev, startTime: combined.toISOString() }));
            } else if (defaultScheduleTime) {
                const combined = applyClockTime(selectedDate, defaultScheduleTime);
                setPendingStartDate(combined);
                setEditedTask((prev) => ({ ...prev, startTime: buildDateWithTimeValue(selectedDate, defaultScheduleTime) }));
            } else {
                setPendingStartDate(new Date(selectedDate));
                setEditedTask((prev) => ({ ...prev, startTime: dateOnly }));
            }
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'start-time') {
            const base = pendingStartDate ?? safeParseDate(editedTask.startTime) ?? new Date();
            const combined = new Date(base);
            combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
            setEditedTask((prev) => ({ ...prev, startTime: combined.toISOString() }));
            setPendingStartDate(null);
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'review') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.reviewAt && hasTimeComponent(editedTask.reviewAt)
                ? safeParseDate(editedTask.reviewAt)
                : null;
            if (existing) {
                const existingTime = safeFormatDate(existing, 'HH:mm');
                setEditedTask((prev) => ({ ...prev, reviewAt: buildDateWithTimeValue(selectedDate, existingTime) }));
            } else if (defaultScheduleTime) {
                setEditedTask((prev) => ({ ...prev, reviewAt: buildDateWithTimeValue(selectedDate, defaultScheduleTime) }));
            } else {
                setEditedTask((prev) => ({ ...prev, reviewAt: dateOnly }));
            }
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'recurrence-end') {
            updateRecurrenceEndDate(safeFormatDate(selectedDate, 'yyyy-MM-dd'));
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'due') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.dueDate && hasTimeComponent(editedTask.dueDate)
                ? safeParseDate(editedTask.dueDate)
                : null;
            if (existing) {
                const combined = new Date(selectedDate);
                combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
                setPendingDueDate(combined);
                setEditedTask((prev) => ({ ...prev, dueDate: combined.toISOString() }));
            } else if (defaultScheduleTime) {
                const combined = applyClockTime(selectedDate, defaultScheduleTime);
                setPendingDueDate(combined);
                setEditedTask((prev) => ({ ...prev, dueDate: buildDateWithTimeValue(selectedDate, defaultScheduleTime) }));
            } else {
                setPendingDueDate(new Date(selectedDate));
                setEditedTask((prev) => ({ ...prev, dueDate: dateOnly }));
            }
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        const base = pendingDueDate ?? safeParseDate(editedTask.dueDate) ?? new Date();
        const combined = new Date(base);
        combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
        setEditedTask((prev) => ({ ...prev, dueDate: combined.toISOString() }));
        setPendingDueDate(null);
        if (Platform.OS === 'android') setShowDatePicker(null);
    }, [
        editedTask.dueDate,
        editedTask.reviewAt,
        editedTask.startTime,
        defaultScheduleTime,
        pendingDueDate,
        pendingStartDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
        updateRecurrenceEndDate,
    ]);

    const formatDate = React.useCallback((dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        return parsed.toLocaleDateString();
    }, [t]);

    const formatDueDate = React.useCallback((dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDueDate(dateStr);
        if (!parsed) return t('common.notSet');
        const hasTime = hasTimeComponent(dateStr);
        if (!hasTime) return parsed.toLocaleDateString();
        return parsed.toLocaleString(undefined, {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }, [t]);

    const getSafePickerDateValue = React.useCallback((dateStr?: string) => {
        if (!dateStr) return new Date();
        const parsed = safeParseDate(dateStr);
        if (!parsed) return new Date();
        return parsed;
    }, []);

    return {
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    };
}
