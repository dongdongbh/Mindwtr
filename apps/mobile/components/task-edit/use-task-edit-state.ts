import React from 'react';
import {
    areDraftAttachmentsDirty,
    flushPendingSave,
    type Attachment,
    type AttachmentDraftSettlementInput,
    type RecurrenceWeekday,
    type Task,
} from '@mindwtr/core';
import {
    setTaskDraftField,
    type TaskDraft,
    type TaskDraftField,
} from '@mindwtr/core/task-draft';
import { getRecurrenceByDayValue } from './recurrence-utils';
import {
    createTaskEditDraft,
    buildTaskEditUpdatePatch,
    isTaskEditDraftDirty,
    type TaskEditDraft,
} from './task-edit-draft-adapter';
import { parseTokenList } from './task-edit-token-utils';
import {
    getActionFailureMessage,
    getUnknownErrorMessage,
    isActionFailure,
} from '../store-action-result';

export type TaskEditTab = 'task' | 'view';
const NOOP_ATTACHMENT_DRAFT_SETTLEMENT = () => {};

export type SetTaskEditDraftValue<T> = (
    value: T | ((current: T) => T),
    markDirty?: boolean,
) => void;

export type SetTaskEditDraftField = <K extends TaskDraftField>(
    field: K,
    value: TaskDraft[K],
    markDirty?: boolean,
) => void;

export type TaskEditDraftLifecycle = {
    convertToReference: () => Promise<boolean>;
    discard: () => void;
    hasPendingChanges: () => boolean;
    save: () => Promise<boolean>;
};

export function resolveInitialTaskEditTab(target?: TaskEditTab, currentTask?: Task | null): TaskEditTab {
    if (target) return target;
    if (currentTask?.taskMode === 'list') return 'view';
    return 'view';
}

type UseTaskEditStateParams = {
    defaultTab?: TaskEditTab;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => unknown;
    onSaveError: (message?: string) => void;
    resetCopilotStateRef: React.MutableRefObject<() => void>;
    settleAttachmentDraft?: (input: AttachmentDraftSettlementInput) => void;
    sections: { id: string; projectId?: string; deletedAt?: string | null }[];
    task: Task | null;
    tasks: Task[];
    visible: boolean;
};

export function useTaskEditState({
    defaultTab,
    onClose,
    onSave,
    onSaveError,
    resetCopilotStateRef,
    settleAttachmentDraft = NOOP_ATTACHMENT_DRAFT_SETTLEMENT,
    sections,
    task,
    tasks,
    visible,
}: UseTaskEditStateParams) {
    const liveTask = React.useMemo(() => {
        if (!task?.id) return task ?? null;
        return tasks.find((item) => item.id === task.id) ?? task;
    }, [task, tasks]);

    const [taskEditDraft, setTaskEditDraftState] = React.useState<TaskEditDraft | null>(null);
    const taskEditDraftRef = React.useRef<TaskEditDraft | null>(null);
    taskEditDraftRef.current = taskEditDraft;
    const isDirtyRef = React.useRef(false);
    const baseTaskRef = React.useRef<Task | null>(null);
    const attachmentDraftSettledRef = React.useRef(true);
    const attachmentSaveAwaitingDurabilityRef = React.useRef(false);
    const setDraftField = React.useCallback<SetTaskEditDraftField>((field, value, markDirty = true) => {
        if (markDirty) isDirtyRef.current = true;
        setTaskEditDraftState((current) => {
            if (!current) return current;
            const draft = setTaskDraftField(current.draft, field, value);
            return draft === current.draft ? current : { ...current, draft };
        });
    }, []);
    const setChecklist = React.useCallback<SetTaskEditDraftValue<Task['checklist']>>((value, markDirty = true) => {
        if (markDirty) isDirtyRef.current = true;
        setTaskEditDraftState((current) => {
            if (!current) return current;
            const checklist = typeof value === 'function' ? value(current.checklist) : value;
            return checklist === current.checklist ? current : { ...current, checklist };
        });
    }, []);
    const setAttachments = React.useCallback<SetTaskEditDraftValue<Attachment[] | undefined>>((value, markDirty = true) => {
        if (markDirty) isDirtyRef.current = true;
        setTaskEditDraftState((current) => {
            if (!current) return current;
            const attachments = typeof value === 'function' ? value(current.attachments) : value;
            return attachments === current.attachments ? current : { ...current, attachments };
        });
    }, []);

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

    const clearPendingTextChanges = React.useCallback(() => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }
    }, []);

    const settleCurrentAttachmentDraft = React.useCallback((committedAttachments?: readonly Attachment[]) => {
        if (attachmentDraftSettledRef.current) return;
        // A successful store action is still optimistic: its immediate SQLite
        // write may be in flight. On a durability failure preserve every file
        // that either the old snapshot or the retrying new snapshot can own.
        if (attachmentSaveAwaitingDurabilityRef.current) return;
        const baselineTask = baseTaskRef.current ?? liveTask;
        const currentDraft = taskEditDraftRef.current;
        if (baselineTask && currentDraft) {
            settleAttachmentDraft({
                baselineAttachments: baselineTask.attachments,
                draftAttachments: currentDraft.attachments,
                committedAttachments,
            });
        }
        attachmentDraftSettledRef.current = true;
    }, [liveTask, settleAttachmentDraft]);
    const settleCurrentAttachmentDraftRef = React.useRef(settleCurrentAttachmentDraft);
    settleCurrentAttachmentDraftRef.current = settleCurrentAttachmentDraft;

    React.useEffect(() => () => {
        settleCurrentAttachmentDraftRef.current(baseTaskRef.current?.attachments);
    }, []);

    const writePatch = React.useCallback((taskId: string, updates: Partial<Task>): boolean | Promise<boolean> => {
        // This prop boundary intentionally retains its synchronous branch:
        // void-returning modal callbacks must close in the same tick.
        const settle = (result: unknown) => {
            if (!isActionFailure(result)) return true;
            onSaveError(getActionFailureMessage(result));
            return false;
        };
        try {
            const result = onSave(taskId, updates);
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                return Promise.resolve(result).then(settle).catch((error) => {
                    onSaveError(getUnknownErrorMessage(error));
                    return false;
                });
            }
            return settle(result);
        } catch (error) {
            onSaveError(getUnknownErrorMessage(error));
        }
        return false;
    }, [onSave, onSaveError]);

    const saveDraft = React.useCallback(async (): Promise<boolean> => {
        const currentTask = baseTaskRef.current ?? liveTask;
        if (!currentTask || !taskEditDraft) return Promise.resolve(false);
        clearPendingTextChanges();

        let saveDraftState = taskEditDraft;
        const nextProjectId = saveDraftState.draft.projectId;
        const nextSectionId = saveDraftState.draft.sectionId;
        if (nextProjectId && nextSectionId) {
            const isValid = sections.some((section) =>
                section.id === nextSectionId && section.projectId === nextProjectId && !section.deletedAt
            );
            if (!isValid) {
                saveDraftState = {
                    ...saveDraftState,
                    draft: setTaskDraftField(saveDraftState.draft, 'sectionId', ''),
                };
            }
        }

        const updates = buildTaskEditUpdatePatch(saveDraftState, currentTask, {
            title: titleDraftRef.current,
            description: descriptionDraftRef.current,
        });
        const wasAwaitingDurability = attachmentSaveAwaitingDurabilityRef.current;
        if (updates && Object.keys(updates).length > 0) {
            const attachmentSaveRequiresDurability = areDraftAttachmentsDirty(
                saveDraftState.attachments,
                currentTask,
            );
            attachmentSaveAwaitingDurabilityRef.current = wasAwaitingDurability
                || attachmentSaveRequiresDurability;
            const saved = await Promise.resolve(writePatch(currentTask.id, updates));
            if (!saved) {
                attachmentSaveAwaitingDurabilityRef.current = wasAwaitingDurability;
                return false;
            }
        }
        if (attachmentSaveAwaitingDurabilityRef.current) {
            try {
                await flushPendingSave();
            } catch (error) {
                onSaveError(getUnknownErrorMessage(error));
                // Keep the guard raised. The store retains a retry snapshot, so
                // neither the baseline bytes nor newly submitted bytes are yet
                // safe to classify as orphaned.
                return false;
            }
        }
        attachmentSaveAwaitingDurabilityRef.current = false;
        settleCurrentAttachmentDraft(saveDraftState.attachments ?? currentTask.attachments);
        onClose();
        return true;
    }, [
        clearPendingTextChanges,
        liveTask,
        onClose,
        onSaveError,
        sections,
        settleCurrentAttachmentDraft,
        taskEditDraft,
        writePatch,
    ]);

    const discardDraft = React.useCallback(() => {
        clearPendingTextChanges();
        const currentTask = baseTaskRef.current ?? liveTask;
        settleCurrentAttachmentDraft(currentTask?.attachments);
        onClose();
    }, [clearPendingTextChanges, liveTask, onClose, settleCurrentAttachmentDraft]);

    const hasPendingChanges = React.useCallback(() => {
        const currentTask = baseTaskRef.current ?? liveTask;
        if (!currentTask || !taskEditDraft) return false;
        let pendingDraft = taskEditDraft.draft;
        pendingDraft = setTaskDraftField(pendingDraft, 'title', titleDraftRef.current);
        pendingDraft = setTaskDraftField(pendingDraft, 'description', descriptionDraftRef.current);
        if (isContextInputFocused) {
            pendingDraft = setTaskDraftField(
                pendingDraft,
                'contexts',
                parseTokenList(contextInputDraft, '@').join(', '),
            );
        }
        if (isTagInputFocused) {
            pendingDraft = setTaskDraftField(
                pendingDraft,
                'tags',
                parseTokenList(tagInputDraft, '#').join(', '),
            );
        }
        return isTaskEditDraftDirty({ ...taskEditDraft, draft: pendingDraft }, currentTask);
    }, [
        contextInputDraft,
        isContextInputFocused,
        isTagInputFocused,
        liveTask,
        tagInputDraft,
        taskEditDraft,
    ]);

    const convertToReference = React.useCallback((): Promise<boolean> => {
        const currentTask = baseTaskRef.current ?? liveTask;
        if (!currentTask) return Promise.resolve(false);
        const referenceUpdate: Partial<Task> = {
            status: 'reference',
            startTime: undefined,
            dueDate: undefined,
            reviewAt: undefined,
            recurrence: undefined,
            showFutureRecurrence: undefined,
            priority: undefined,
            timeEstimate: undefined,
            isFocusedToday: false,
            pushCount: 0,
        };
        const applyReference = (saved: boolean) => {
            if (!saved) return false;
            const nextBaseTask = { ...currentTask, ...referenceUpdate };
            baseTaskRef.current = nextBaseTask;
            setTaskEditDraftState((current) => {
                if (!current) return current;
                let draft = current.draft;
                draft = setTaskDraftField(draft, 'status', 'reference');
                draft = setTaskDraftField(draft, 'startTime', '');
                draft = setTaskDraftField(draft, 'dueDate', '');
                draft = setTaskDraftField(draft, 'reviewAt', '');
                draft = setTaskDraftField(draft, 'recurrence', '');
                draft = setTaskDraftField(draft, 'recurrenceRRule', '');
                draft = setTaskDraftField(draft, 'showFutureRecurrence', false);
                draft = setTaskDraftField(draft, 'priority', '');
                draft = setTaskDraftField(draft, 'timeEstimate', '');
                draft = setTaskDraftField(draft, 'focusedToday', false);
                const next = { ...current, draft };
                isDirtyRef.current = isTaskEditDraftDirty(next, nextBaseTask);
                return next;
            });
            return true;
        };
        const saved = writePatch(currentTask.id, referenceUpdate);
        return saved instanceof Promise
            ? saved.then(applyReference)
            : Promise.resolve(applyReference(saved));
    }, [liveTask, writePatch]);

    const draftLifecycle = React.useMemo<TaskEditDraftLifecycle>(() => ({
        convertToReference,
        discard: discardDraft,
        hasPendingChanges,
        save: saveDraft,
    }), [convertToReference, discardDraft, hasPendingChanges, saveDraft]);

    React.useEffect(() => {
        if (!visible) {
            const currentTask = baseTaskRef.current ?? liveTask;
            settleCurrentAttachmentDraft(currentTask?.attachments);
            setTaskEditDraftState(null);
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
            const byDay = getRecurrenceByDayValue(liveTask.recurrence);
            const taskChanged = baseTaskRef.current?.id !== liveTask.id;
            const updatedChanged = baseTaskRef.current?.updatedAt !== liveTask.updatedAt;
            if (taskChanged || (!isDirtyRef.current && updatedChanged)) {
                if (taskChanged) {
                    settleCurrentAttachmentDraft(baseTaskRef.current?.attachments);
                }
                setCustomWeekdays(byDay);
                setTaskEditDraftState(createTaskEditDraft(liveTask));
                baseTaskRef.current = liveTask;
                attachmentDraftSettledRef.current = false;
                isDirtyRef.current = false;
                setShowDescriptionPreview(false);
                const nextTitle = String(liveTask.title ?? '');
                if (titleDebounceRef.current) {
                    clearTimeout(titleDebounceRef.current);
                    titleDebounceRef.current = null;
                }
                titleDraftRef.current = nextTitle;
                setTitleDraft(nextTitle);
                const nextDescription = String(liveTask.description ?? '');
                descriptionDraftRef.current = nextDescription;
                setDescriptionDraft(nextDescription);
                setContextInputDraft((liveTask.contexts ?? []).join(', '));
                setTagInputDraft((liveTask.tags ?? []).join(', '));
                setIsContextInputFocused(false);
                setIsTagInputFocused(false);
                setEditTab(resolveInitialTaskEditTab(defaultTab, liveTask));
                resetCopilotStateRef.current();
            }
        } else {
            setTaskEditDraftState(null);
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
    }, [defaultTab, liveTask, resetCopilotStateRef, settleCurrentAttachmentDraft, visible]);

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
        const normalized = taskEditDraft?.draft.contexts ?? '';
        if (contextInputDraft !== normalized) {
            setContextInputDraft(normalized);
        }
    }, [contextInputDraft, isContextInputFocused, taskEditDraft?.draft.contexts, visible]);

    React.useEffect(() => {
        if (!visible || isTagInputFocused) return;
        const normalized = taskEditDraft?.draft.tags ?? '';
        if (tagInputDraft !== normalized) {
            setTagInputDraft(normalized);
        }
    }, [isTagInputFocused, tagInputDraft, taskEditDraft?.draft.tags, visible]);

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
        contextInputDraft,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        editTab,
        isAIWorking,
        isContextInputFocused,
        isDirtyRef,
        isTagInputFocused,
        liveTask,
        pendingDueDate,
        pendingStartDate,
        setAiModal,
        setAttachments,
        setChecklist,
        setContextInputDraft,
        setCustomWeekdays,
        setDescriptionDraft,
        setDraftField,
        setEditTab,
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
        taskEditDraft,
        draftLifecycle,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    };
}
