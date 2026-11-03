


import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
    safeParseDate,
    hasTimeComponent,
    safeParseDueDate,
    type ExternalCalendarEvent,
    type Task,
} from '@mindwtr/core';

export type CalendarSelectedDayTaskRow = {
    id: string;
    kind: 'scheduled' | 'deadline';
    start: Date | null;
    task: Task;
};

export function useCalendarScheduleFeedback() {
    const [scheduleQuery, setScheduleQuery] = useState('');
    const [scheduleError, setScheduleError] = useState<string | null>(null);
    const [editingTimeTaskId, setEditingTimeTaskId] = useState<string | null>(null);
    const [editingTimeValue, setEditingTimeValue] = useState<string>('');


    const updateScheduleQuery = useCallback((query: string) => {
        setScheduleQuery(query);
        setScheduleError(null);
    }, []);
    const showScheduleError = useCallback((message: string | null) => setScheduleError(message), []);
    const clearScheduleFeedback = useCallback(() => {
        setScheduleQuery('');
        setScheduleError(null);
    }, []);
    const startEditingTime = useCallback((taskId: string, timeValue: string) => {
        setEditingTimeTaskId(taskId);
        setEditingTimeValue(timeValue);
    }, []);
    const updateEditingTimeValue = useCallback((value: string) => setEditingTimeValue(value), []);
    const stopEditingTime = useCallback(() => {
        setEditingTimeTaskId(null);
        setEditingTimeValue('');
    }, []);
    const resetSelectedDayState = useCallback(() => {
        clearScheduleFeedback();
        stopEditingTime();
    }, [clearScheduleFeedback, stopEditingTime]);

    return {
        clearScheduleFeedback,
        editingTimeTaskId,
        editingTimeValue,
        resetSelectedDayState,
        scheduleError,
        scheduleQuery,
        showScheduleError,
        startEditingTime,
        stopEditingTime,
        updateEditingTimeValue,
        updateScheduleQuery,
    };
}

export type CalendarScheduleFeedback = ReturnType<typeof useCalendarScheduleFeedback>;

export type CalendarSelectedDayOptions = {
    feedback: CalendarScheduleFeedback;
    findFreeSlotForDay: (day: Date, durationMinutes: number, excludeTaskId?: string) => Date | null;
    getDeadlinesForDay: (date: Date) => Task[];
    getExternalEventsForDay: (date: Date) => ExternalCalendarEvent[];
    getScheduledForDay: (date: Date) => Task[];
    isSlotFreeForDay: (day: Date, startTime: Date, durationMinutes: number, excludeTaskId?: string) => boolean;
    openTaskComposerAt: (
        start: Date,
        options?: { durationMinutes?: number; mode?: 'new' | 'existing'; taskId?: string },
    ) => void;
    resolveText: (key: string, fallback: string) => string;
    schedulableTasks: Task[];
    selectedDate: Date | null;
    t: (key: string) => string;
    tasks: Task[];
    timeEstimateToMinutes: (estimate: Task['timeEstimate']) => number;
    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
};

export function useCalendarSelectedDay({
    feedback,
    findFreeSlotForDay,
    getDeadlinesForDay,
    getExternalEventsForDay,
    getScheduledForDay,
    isSlotFreeForDay,
    openTaskComposerAt,
    resolveText,
    schedulableTasks,
    selectedDate,
    t,
    tasks,
    timeEstimateToMinutes,
    updateTask,
}: CalendarSelectedDayOptions) {
    const {
        editingTimeTaskId,
        editingTimeValue,
        scheduleError,
        scheduleQuery,
        showScheduleError,
        startEditingTime,
        stopEditingTime,
        updateEditingTimeValue,
        updateScheduleQuery,
    } = feedback;

    useEffect(() => {
        stopEditingTime();
    }, [selectedDate, stopEditingTime]);

    const scheduleCandidates = useMemo(() => {
        if (!selectedDate) return [];
        const query = scheduleQuery.trim().toLowerCase();
        if (!query) return [];

        return schedulableTasks
            .filter((task) => task.title.toLowerCase().includes(query))
            .slice(0, 12);
    }, [schedulableTasks, scheduleQuery, selectedDate]);

    const selectedExternalEvents = selectedDate ? getExternalEventsForDay(selectedDate) : [];
    const selectedAllDayEvents = selectedExternalEvents.filter((event) => event.allDay);
    const selectedTimedEvents = selectedExternalEvents.filter((event) => !event.allDay);
    const selectedDeadlines = selectedDate ? getDeadlinesForDay(selectedDate) : [];
    const selectedScheduled = selectedDate ? getScheduledForDay(selectedDate) : [];
    const selectedScheduledIds = new Set(selectedScheduled.map((task) => task.id));
    const selectedTaskRows: CalendarSelectedDayTaskRow[] = [
        ...selectedScheduled.map((task) => ({
            id: `scheduled-${task.id}`,
            kind: 'scheduled' as const,
            task,
            start: task.startTime ? safeParseDate(task.startTime) : null,
        })),
        ...selectedDeadlines
            .filter((task) => !selectedScheduledIds.has(task.id) || hasTimeComponent(task.dueDate))
            .map((task) => ({
                id: `deadline-${task.id}`,
                kind: 'deadline' as const,
                task,
                start: task.dueDate ? safeParseDueDate(task.dueDate) : null,
            })),
    ].sort((a, b) => {
        const aTime = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return a.task.title.localeCompare(b.task.title);
    });

    const scheduleTaskOnSelectedDate = (taskId: string) => {
        if (!selectedDate) return;
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) return;

        const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
        const slot = findFreeSlotForDay(selectedDate, durationMinutes, taskId);
        if (!slot) {
            showScheduleError(t('calendar.noFreeTime'));
            return;
        }

        openTaskComposerAt(slot, { mode: 'existing', taskId });
        showScheduleError(null);
    };

    const schedulePlanningTask = (taskId: string) => {
        if (selectedDate) {
            scheduleTaskOnSelectedDate(taskId);
            return;
        }
        showScheduleError(resolveText('calendar.selectDayToPlan', 'Select a day to plan first.'));
    };

    const beginEditScheduledTime = (taskId: string) => {
        if (!selectedDate) return;
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task?.startTime) return;
        const start = safeParseDate(task.startTime);
        if (!start) return;
        startEditingTime(taskId, format(start, 'HH:mm'));
    };

    const commitEditScheduledTime = async () => {
        if (!selectedDate) return;
        if (!editingTimeTaskId) return;
        const task = tasks.find((candidate) => candidate.id === editingTimeTaskId);
        if (!task) return;

        const [hh, mm] = editingTimeValue.split(':').map((v) => Number(v));
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;

        const nextStart = new Date(selectedDate);
        nextStart.setHours(hh, mm, 0, 0);

        const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
        const ok = isSlotFreeForDay(selectedDate, nextStart, durationMinutes, task.id);
        if (!ok) {
            showScheduleError(t('calendar.overlapWarning'));
            return;
        }

        await updateTask(task.id, { startTime: nextStart.toISOString() });
        stopEditingTime();
        showScheduleError(null);
    };

    const cancelEditScheduledTime = () => {
        stopEditingTime();
    };

    return {
        beginEditScheduledTime,
        cancelEditScheduledTime,
        commitEditScheduledTime,
        editingTimeTaskId,
        editingTimeValue,
        scheduleCandidates,
        scheduleError,
        schedulePlanningTask,
        scheduleQuery,
        scheduleTaskOnSelectedDate,
        selectedAllDayEvents,
        selectedExternalEvents,
        selectedTaskRows,
        selectedTimedEvents,
        updateEditingTimeValue,
        updateScheduleQuery,
    };
}

export type CalendarSelectedDay = ReturnType<typeof useCalendarSelectedDay>;
