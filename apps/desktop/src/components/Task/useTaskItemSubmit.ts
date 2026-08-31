import { useCallback } from 'react';
import {
    taskDraftToChangedUpdatePatch,
    flushPendingSave,
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
    editingTaskId: string | null;
    setEditingTaskId: (id: string | null) => void;
    setIsEditing: (value: boolean) => void;
    showToast: (message: string, tone?: 'info' | 'error' | 'success') => void;
    t: (key: string) => string;
    task: Task;
    updateTask: (id: string, patch: Partial<Task>) => Promise<StoreActionResult>;
    beginAttachmentSave: () => boolean;
    cancelAttachmentSaveBeforeStoreUpdate: () => void;
    settlePersistedAttachmentSave: (attachments: Attachment[]) => void;
};

type TaskItemSubmitOptions = {
    statusOverride?: TaskStatus;
    completedAtOverride?: string;
    timeSpentMinutesOverride?: number;
};

export function useTaskItemSubmit({
    baselineTask,
    draft,
    editAttachments,
    editingTaskId,
    setEditingTaskId,
    setIsEditing,
    showToast,
    t,
    task,
    updateTask,
    beginAttachmentSave,
    cancelAttachmentSaveBeforeStoreUpdate,
    settlePersistedAttachmentSave,
}: UseTaskItemSubmitParams) {
    return useCallback(async (event?: React.FormEvent, options?: TaskItemSubmitOptions) => {
        event?.preventDefault();
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

        const attachmentSaveRequiresDurability = beginAttachmentSave();
        const result = await updateTask(task.id, patch);
        if (!result.success) {
            cancelAttachmentSaveBeforeStoreUpdate();
            showToast(result.error || t('task.updateFailed'), 'error');
            return result;
        }
        if (attachmentSaveRequiresDurability) {
            try {
                await flushPendingSave();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error || t('task.updateFailed'));
                showToast(message, 'error');
                return { success: false, error: message };
            }
            settlePersistedAttachmentSave(editAttachments ?? task.attachments ?? []);
        }
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
        return result;
    }, [
        baselineTask,
        draft,
        editAttachments,
        editingTaskId,
        beginAttachmentSave,
        cancelAttachmentSaveBeforeStoreUpdate,
        setEditingTaskId,
        setIsEditing,
        settlePersistedAttachmentSave,
        showToast,
        t,
        task,
        updateTask,
    ]);
}
