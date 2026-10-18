import { useCallback, useRef } from 'react';
import {
    taskDraftToChangedUpdatePatch,
    flushPendingSave,
    saveTaskDraftOntoLatest,
    useTaskStore,
    type Attachment,
    type StoreActionResult,
    type Task,
    type TaskDraft,
    type TaskStatus,
} from '@mindwtr/core';

type UseTaskItemSubmitParams = {
    baselineTask: Task;
    draft: TaskDraft;
    editAttachments: Attachment[] | undefined;
    isImportingFiles?: boolean;
    editingTaskId: string | null;
    setEditingTaskId: (id: string | null) => void;
    setIsEditing: (value: boolean) => void;
    showToast: (message: string, tone?: 'info' | 'error' | 'success') => void;
    t: (key: string) => string;
    task: Task;
    beginAttachmentSave: () => boolean;
    cancelAttachmentSaveBeforeStoreUpdate: () => void;
    settlePersistedAttachmentSave: (attachments: Attachment[]) => void;
};

/**
 * The editor save as one store command, merged field by field onto the latest row by core's saveTaskDraftOntoLatest:
 * only the fields the draft changed since [base] are written, and a list another device changed too is merged (tags and
 * contexts by token, the checklist by item id, attachments by mergeTaskDraftAttachments). A single value takes the
 * draft's (last write wins). Answers the row it saved, read before any sync save can publish over it, as the base for
 * the next save of this session.
 */
const saveDraftOnLatest = async (id: string, base: Task, patch: Partial<Task>) => {
    let saved: Task | undefined;
    const result = await saveTaskDraftOntoLatest(id, base, patch, {
        write: async (taskId, updates): Promise<StoreActionResult> => {
            const written = Object.keys(updates).length > 0
                ? await useTaskStore.getState().updateTask(taskId, updates)
                : { success: true, id: taskId };
            saved = useTaskStore.getState()._tasksById.get(taskId);
            return written;
        },
    });
    return { result, saved };
};

type TaskItemSubmitOptions = {
    statusOverride?: TaskStatus;
    completedAtOverride?: string;
    timeSpentMinutesOverride?: number;
    /** Save the draft but leave the editor mounted for a chained durable action. */
    keepEditing?: boolean;
};

export function useTaskItemSubmit({
    baselineTask,
    draft,
    editAttachments,
    isImportingFiles = false,
    editingTaskId,
    setEditingTaskId,
    setIsEditing,
    showToast,
    t,
    task,
    beginAttachmentSave,
    cancelAttachmentSaveBeforeStoreUpdate,
    settlePersistedAttachmentSave,
}: UseTaskItemSubmitParams) {
    // The row this edit session last saved: the next save's base, so the editor's own saves are not conflicts.
    const savedRef = useRef<{ opened: Task; saved: Task } | null>(null);
    return useCallback(async (event?: React.FormEvent, options?: TaskItemSubmitOptions) => {
        event?.preventDefault();
        if (isImportingFiles) return { success: false };
        const patch = taskDraftToChangedUpdatePatch(draft, baselineTask, {
            statusOverride: options?.statusOverride,
            attachments: editAttachments,
        });
        if (!patch) return;
        if (options?.completedAtOverride !== undefined) {
            patch.completedAt = options.completedAtOverride;
        }
        // Presence check, not `!== undefined`: an explicit undefined override
        // means "the time-spent field was shown but left blank," which clears
        // timeSpentMinutes rather than leaving it untouched (mirrors mobile's
        // completed-at-picker.tsx / #896).
        if (options && 'timeSpentMinutesOverride' in options) {
            patch.timeSpentMinutes = options.timeSpentMinutesOverride;
        }

        const base = savedRef.current?.opened === baselineTask ? savedRef.current.saved : baselineTask;
        const attachmentSaveRequiresDurability = beginAttachmentSave();
        const { result, saved } = await saveDraftOnLatest(task.id, base, patch);
        if (!result.success) {
            cancelAttachmentSaveBeforeStoreUpdate();
            showToast(result.error || t('task.updateFailed'), 'error');
            return result;
        }
        if (saved) savedRef.current = { opened: baselineTask, saved };
        if (attachmentSaveRequiresDurability) {
            try {
                await flushPendingSave();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || t('task.updateFailed'));
                showToast(message, 'error');
                return { success: false, error: message };
            }
            settlePersistedAttachmentSave(saved?.attachments ?? editAttachments ?? task.attachments ?? []);
        }
        if (!options?.keepEditing) {
            setIsEditing(false);
            if (editingTaskId === task.id) {
                setEditingTaskId(null);
            }
        }
        return result;
    }, [
        baselineTask,
        draft,
        editAttachments,
        isImportingFiles,
        editingTaskId,
        beginAttachmentSave,
        cancelAttachmentSaveBeforeStoreUpdate,
        setEditingTaskId,
        setIsEditing,
        settlePersistedAttachmentSave,
        showToast,
        t,
        task,
    ]);
}
