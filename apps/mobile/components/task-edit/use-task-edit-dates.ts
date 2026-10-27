import React from 'react';
import { Platform } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
    editTaskDraftRecurrence,
    formatTaskEditorDate,
    getTaskDraftDateEdit,
    hasTimeComponent,
    safeFormatDate,
    safeParseDate,
    setTaskDraftDate,
    setTaskDraftReviewTime,
    setTaskDraftTime,
    type TaskEditorDateField,
} from '@mindwtr/core';
import type { TaskDraft, TaskDraftField, TaskDraftSetter } from '@mindwtr/core/task-draft';


type TaskEditDatePickerMode = 'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'review-time' | 'recurrence-end';

type UseTaskEditDatesParams = {
    draft: TaskDraft | null;
    pendingDueDate: Date | null;
    pendingStartDate: Date | null;
    setDraftField: TaskDraftSetter;
    setPendingDueDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setPendingStartDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setShowDatePicker: React.Dispatch<React.SetStateAction<'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'review-time' | 'recurrence-end' | null>>;
    showDatePicker: 'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'review-time' | 'recurrence-end' | null;
    defaultScheduleTime?: string;
    t: (key: string) => string;
};

// Core's date edit writes each field in order; a due date moves a relative start
// through the draft's cascade.
const applyDateEdit = (setDraftField: TaskDraftSetter, field: TaskEditorDateField, value: string) => {
    for (const [key, fieldValue] of Object.entries(getTaskDraftDateEdit(field, value))) {
        setDraftField(key as TaskDraftField, fieldValue as never);
    }
};

const pickedTime = (selectedDate: Date) => ({ hours: selectedDate.getHours(), minutes: selectedDate.getMinutes() });

// The picker's day for the time picker that may follow: the written value when it
// has a time, else the picked day.
const pendingDateFor = (value: string, selectedDate: Date): Date => (
    hasTimeComponent(value) ? safeParseDate(value) ?? new Date(selectedDate) : new Date(selectedDate)
);

export function useTaskEditDates({
    draft,
    pendingDueDate,
    pendingStartDate,
    setDraftField,
    setPendingDueDate,
    setPendingStartDate,
    setShowDatePicker,
    showDatePicker,
    defaultScheduleTime = '',
    t,
}: UseTaskEditDatesParams) {
    const updateRecurrenceEndDate = React.useCallback((until: string) => {
        if (!draft?.recurrence) return;
        const edited = editTaskDraftRecurrence(draft, { kind: 'until', date: until }, { weekdays: [], defaultUntil: until });
        setDraftField('recurrenceRRule', edited.recurrenceRRule);
    }, [draft, setDraftField]);

    const applySelectedDate = React.useCallback((
        currentMode: TaskEditDatePickerMode,
        selectedDate: Date,
        closePicker: boolean
    ) => {
        const dateOptions = { defaultScheduleTime, formatDate: safeFormatDate };
        if (currentMode === 'start') {
            const value = setTaskDraftDate('startTime', draft?.startTime, selectedDate, dateOptions);
            setPendingStartDate(pendingDateFor(value, selectedDate));
            applyDateEdit(setDraftField, 'startTime', value);
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'start-time') {
            applyDateEdit(setDraftField, 'startTime', setTaskDraftTime(draft?.startTime, pickedTime(selectedDate), pendingStartDate));
            setPendingStartDate(null);
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'review') {
            applyDateEdit(setDraftField, 'reviewAt', setTaskDraftDate('reviewAt', draft?.reviewAt, selectedDate, dateOptions));
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'review-time') {
            applyDateEdit(setDraftField, 'reviewAt', setTaskDraftReviewTime(draft?.reviewAt, pickedTime(selectedDate), safeFormatDate));
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'recurrence-end') {
            updateRecurrenceEndDate(safeFormatDate(selectedDate, 'yyyy-MM-dd'));
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'due') {
            const value = setTaskDraftDate('dueDate', draft?.dueDate, selectedDate, dateOptions);
            setPendingDueDate(pendingDateFor(value, selectedDate));
            applyDateEdit(setDraftField, 'dueDate', value);
            if (closePicker) setShowDatePicker(null);
            return;
        }

        applyDateEdit(setDraftField, 'dueDate', setTaskDraftTime(draft?.dueDate, pickedTime(selectedDate), pendingDueDate));
        setPendingDueDate(null);
        if (closePicker) setShowDatePicker(null);
    }, [
        draft,
        defaultScheduleTime,
        pendingDueDate,
        pendingStartDate,
        setDraftField,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        updateRecurrenceEndDate,
    ]);

    const applyQuickDate = React.useCallback((
        mode: Extract<TaskEditDatePickerMode, 'start' | 'due' | 'review'>,
        selectedDate: Date | null
    ) => {
        if (!selectedDate) {
            if (mode === 'start') {
                setPendingStartDate(null);
                applyDateEdit(setDraftField, 'startTime', '');
            } else if (mode === 'due') {
                setPendingDueDate(null);
                applyDateEdit(setDraftField, 'dueDate', '');
            } else {
                applyDateEdit(setDraftField, 'reviewAt', '');
            }
            setShowDatePicker(null);
            return;
        }

        applySelectedDate(mode, selectedDate, true);
    }, [
        applySelectedDate,
        setDraftField,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
    ]);

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
        applySelectedDate(currentMode, selectedDate, Platform.OS === 'android');
    }, [
        applySelectedDate,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
    ]);

    const formatDate = React.useCallback((dateStr?: string) => (
        formatTaskEditorDate(dateStr, safeFormatDate, t('common.notSet'))
    ), [t]);

    const formatDueDate = React.useCallback((dateStr?: string) => (
        formatTaskEditorDate(dateStr, safeFormatDate, t('common.notSet'), { due: true })
    ), [t]);

    const getSafePickerDateValue = React.useCallback((dateStr?: string) => {
        if (!dateStr) return new Date();
        const parsed = safeParseDate(dateStr);
        if (!parsed) return new Date();
        return parsed;
    }, []);

    return {
        applyQuickDate,
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    };
}
