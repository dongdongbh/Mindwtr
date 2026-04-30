import React from 'react';
import { getRecurrenceCompletedOccurrencesValue, getRecurrenceCountValue, getRecurrenceUntilValue, type RecurrenceWeekday, type Task } from '@mindwtr/core';
import {
    getRecurrenceByDayValue,
    getRecurrenceRRuleValue,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
} from './recurrence-utils';

export type TaskEditTab = 'task' | 'view';

export type SetEditedTask = (
    value: React.SetStateAction<Partial<Task>>,
    markDirty?: boolean,
) => void;

export function resolveInitialTaskEditTab(target?: TaskEditTab, currentTask?: Task | null): TaskEditTab {
    if (target) return target;
    if (currentTask?.taskMode === 'list') return 'view';
    return 'view';
}

type UseTaskEditStateParams = {
    defaultTab?: TaskEditTab;
    resetCopilotStateRef: React.MutableRefObject<() => void>;
    task: Task | null;
    tasks: Task[];
    visible: boolean;
};

export function useTaskEditState({
    defaultTab,
    resetCopilotStateRef,
    task,
    tasks,
    visible,
}: UseTaskEditStateParams) {
    const liveTask = React.useMemo(() => {
        if (!task?.id) return task ?? null;
        return tasks.find((item) => item.id === task.id) ?? task;
    }, [task, tasks]);

    const [editedTask, setEditedTaskState] = React.useState<Partial<Task>>({});
    const isDirtyRef = React.useRef(false);
    const baseTaskRef = React.useRef<Task | null>(null);
    const setEditedTask = React.useCallback<SetEditedTask>(
        (value, markDirty = true) => {
            if (markDirty) {
                isDirtyRef.current = true;
            }
            setEditedTaskState(value);
        },
        []
    );

    const [showDatePicker, setShowDatePicker] = React.useState<'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'recurrence-end' | null>(null);
    const [pendingStartDate, setPendingStartDate] = React.useState<Date | null>(null);
    const [pendingDueDate, setPendingDueDate] = React.useState<Date | null>(null);
    const [editTab, setEditTab] = React.useState<TaskEditTab>(() => resolveInitialTaskEditTab(defaultTab, task));
    const [showDescriptionPreview, setShowDescriptionPreview] = React.useState(false);
    const [showAreaPicker, setShowAreaPicker] = React.useState(false);
    const [titleDraft, setTitleDraft] = React.useState('');
    const titleDraftRef = React.useRef('');
    const titleDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const [descriptionDraft, setDescriptionDraft] = React.useState('');
    const descriptionDraftRef = React.useRef('');
    const descriptionDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const [contextInputDraft, setContextInputDraft] = React.useState('');
    const [tagInputDraft, setTagInputDraft] = React.useState('');
    const [isContextInputFocused, setIsContextInputFocused] = React.useState(false);
    const [isTagInputFocused, setIsTagInputFocused] = React.useState(false);
    const [showProjectPicker, setShowProjectPicker] = React.useState(false);
    const [showSectionPicker, setShowSectionPicker] = React.useState(false);
    const [customWeekdays, setCustomWeekdays] = React.useState<RecurrenceWeekday[]>([]);
    const [isAIWorking, setIsAIWorking] = React.useState(false);
    const [aiModal, setAiModal] = React.useState<{ title: string; message?: string; actions: { label: string; variant?: 'primary' | 'secondary'; onPress: () => void }[] } | null>(null);

    React.useEffect(() => {
        if (!visible) {
            setEditedTaskState({});
            baseTaskRef.current = null;
            isDirtyRef.current = false;
            setShowDescriptionPreview(false);
            if (titleDebounceRef.current) {
                clearTimeout(titleDebounceRef.current);
                titleDebounceRef.current = null;
            }
            titleDraftRef.current = '';
            setTitleDraft('');
            descriptionDraftRef.current = '';
            setDescriptionDraft('');
            setContextInputDraft('');
            setTagInputDraft('');
            setIsContextInputFocused(false);
            setIsTagInputFocused(false);
            setEditTab(resolveInitialTaskEditTab(defaultTab, null));
            setCustomWeekdays([]);
            return;
        }

        if (liveTask) {
            const recurrenceRule = getRecurrenceRuleValue(liveTask.recurrence);
            const recurrenceStrategy = getRecurrenceStrategyValue(liveTask.recurrence);
            const byDay = getRecurrenceByDayValue(liveTask.recurrence);
            const rrule = getRecurrenceRRuleValue(liveTask.recurrence);
            const count = getRecurrenceCountValue(liveTask.recurrence);
            const until = getRecurrenceUntilValue(liveTask.recurrence);
            const completedOccurrences = getRecurrenceCompletedOccurrencesValue(liveTask.recurrence);
            const normalizedTask: Task = {
                ...liveTask,
                recurrence: recurrenceRule
                    ? {
                        rule: recurrenceRule,
                        strategy: recurrenceStrategy,
                        ...(rrule ? { rrule } : {}),
                        ...(byDay.length ? { byDay } : {}),
                        ...(count ? { count } : {}),
                        ...(until ? { until } : {}),
                        ...(typeof completedOccurrences === 'number' ? { completedOccurrences } : {}),
                    }
                    : undefined,
            };
            const taskChanged = baseTaskRef.current?.id !== normalizedTask.id;
            const updatedChanged = baseTaskRef.current?.updatedAt !== normalizedTask.updatedAt;
            if (taskChanged || (!isDirtyRef.current && updatedChanged)) {
                setCustomWeekdays(byDay);
                setEditedTaskState(normalizedTask);
                baseTaskRef.current = normalizedTask;
                isDirtyRef.current = false;
                setShowDescriptionPreview(false);
                const nextTitle = String(normalizedTask.title ?? '');
                if (titleDebounceRef.current) {
                    clearTimeout(titleDebounceRef.current);
                    titleDebounceRef.current = null;
                }
                titleDraftRef.current = nextTitle;
                setTitleDraft(nextTitle);
                const nextDescription = String(normalizedTask.description ?? '');
                descriptionDraftRef.current = nextDescription;
                setDescriptionDraft(nextDescription);
                setContextInputDraft((normalizedTask.contexts ?? []).join(', '));
                setTagInputDraft((normalizedTask.tags ?? []).join(', '));
                setIsContextInputFocused(false);
                setIsTagInputFocused(false);
                setEditTab(resolveInitialTaskEditTab(defaultTab, normalizedTask));
                resetCopilotStateRef.current();
            }
        } else {
            setEditedTaskState({});
            baseTaskRef.current = null;
            isDirtyRef.current = false;
            setShowDescriptionPreview(false);
            if (titleDebounceRef.current) {
                clearTimeout(titleDebounceRef.current);
                titleDebounceRef.current = null;
            }
            titleDraftRef.current = '';
            setTitleDraft('');
            descriptionDraftRef.current = '';
            setDescriptionDraft('');
            setContextInputDraft('');
            setTagInputDraft('');
            setIsContextInputFocused(false);
            setIsTagInputFocused(false);
            setEditTab(resolveInitialTaskEditTab(defaultTab, null));
            setCustomWeekdays([]);
        }
    }, [defaultTab, liveTask, resetCopilotStateRef, visible]);

    React.useEffect(() => {
        if (!visible) {
            setAiModal(null);
        }
    }, [visible]);

    React.useEffect(() => {
        if (!visible) {
            if (titleDebounceRef.current) {
                clearTimeout(titleDebounceRef.current);
                titleDebounceRef.current = null;
            }
            if (descriptionDebounceRef.current) {
                clearTimeout(descriptionDebounceRef.current);
                descriptionDebounceRef.current = null;
            }
        }
    }, [visible]);

    React.useEffect(() => {
        if (!visible || isContextInputFocused) return;
        const normalized = (editedTask.contexts ?? []).join(', ');
        if (contextInputDraft !== normalized) {
            setContextInputDraft(normalized);
        }
    }, [contextInputDraft, editedTask.contexts, isContextInputFocused, visible]);

    React.useEffect(() => {
        if (!visible || isTagInputFocused) return;
        const normalized = (editedTask.tags ?? []).join(', ');
        if (tagInputDraft !== normalized) {
            setTagInputDraft(normalized);
        }
    }, [editedTask.tags, isTagInputFocused, tagInputDraft, visible]);

    React.useEffect(() => () => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }
    }, []);

    return {
        aiModal,
        baseTaskRef,
        contextInputDraft,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        editTab,
        editedTask,
        isAIWorking,
        isContextInputFocused,
        isDirtyRef,
        isTagInputFocused,
        liveTask,
        pendingDueDate,
        pendingStartDate,
        setAiModal,
        setContextInputDraft,
        setCustomWeekdays,
        setDescriptionDraft,
        setEditTab,
        setEditedTask,
        setEditedTaskState,
        setIsAIWorking,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setPendingDueDate,
        setPendingStartDate,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        setTagInputDraft,
        setTitleDraft,
        showAreaPicker,
        showDatePicker,
        showDescriptionPreview,
        showProjectPicker,
        showSectionPicker,
        tagInputDraft,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    };
}
