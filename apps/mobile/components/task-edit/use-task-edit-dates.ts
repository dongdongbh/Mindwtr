import React from 'react';
import { Platform } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { hasTimeComponent, safeFormatDate, safeParseDate, safeParseDueDate, type Task } from '@mindwtr/core';

import type { SetEditedTask } from './use-task-edit-state';

type UseTaskEditDatesParams = {
    editedTask: Partial<Task>;
    pendingDueDate: Date | null;
    pendingStartDate: Date | null;
    setEditedTask: SetEditedTask;
    setPendingDueDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setPendingStartDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setShowDatePicker: React.Dispatch<React.SetStateAction<'start' | 'start-time' | 'due' | 'due-time' | 'review' | null>>;
    showDatePicker: 'start' | 'start-time' | 'due' | 'due-time' | 'review' | null;
    t: (key: string) => string;
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
    t,
}: UseTaskEditDatesParams) {
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
            setEditedTask((prev) => ({ ...prev, reviewAt: selectedDate.toISOString() }));
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
        editedTask.startTime,
        pendingDueDate,
        pendingStartDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
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
