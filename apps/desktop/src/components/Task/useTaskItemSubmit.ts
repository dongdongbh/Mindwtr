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
import { webAttachmentUploadMessage } from '../../lib/web-attachment-upload';
import { useInboxCompletion } from '../../contexts/inbox-session-context';

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
    isImportingFiles?: boolean;
    prepareAttachmentsForSave?: () => Promise<Attachment[]>;
    getAttachmentDraftGeneration?: () => number;
    retainWebAttachmentsBeforeStore?: (attachments: Attachment[]) => void;
    setAttachmentError?: (error: string | null) => void;
    beginAttachmentSave: () => boolean;
    cancelAttachmentSaveBeforeStoreUpdate: () => void;
    settlePersistedAttachmentSave: (attachments: Attachment[]) => void;
};


const saveDraftOnLatest = async (id: string, base: Task, patch: Partial<Task>, beforeWrite?: () => void) => {
    let saved: Task | undefined;
    const result = await saveTaskDraftOntoLatest(id, base, patch, {
        write: async (taskId, updates): Promise<StoreActionResult> => {
            beforeWrite?.();
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

    keepEditing?: boolean;
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
    isImportingFiles,
    prepareAttachmentsForSave,
    getAttachmentDraftGeneration,
    retainWebAttachmentsBeforeStore,
    setAttachmentError,
    beginAttachmentSave,
    cancelAttachmentSaveBeforeStoreUpdate,
    settlePersistedAttachmentSave,
}: UseTaskItemSubmitParams) {
    const trackInboxCompletion = useInboxCompletion();

    const savedRef = useRef<{ opened: Task; saved: Task } | null>(null);
    const inFlightRef = useRef<Promise<StoreActionResult | undefined> | null>(null);
    const latestRef = useRef({ draft, editAttachments, baselineTask });
    latestRef.current = { draft, editAttachments, baselineTask };
    return useCallback((event?: React.FormEvent, options?: TaskItemSubmitOptions) => {
        event?.preventDefault();
        if (inFlightRef.current) return inFlightRef.current;
        if (isImportingFiles) return Promise.resolve(undefined);
        const generation = getAttachmentDraftGeneration?.();
        const isCurrent = () => generation === getAttachmentDraftGeneration?.();
        const operation = async (): Promise<StoreActionResult | undefined> => {
            let preparedAttachments = editAttachments;
            try {
                if (prepareAttachmentsForSave) preparedAttachments = await prepareAttachmentsForSave();
            } catch (error) {
                if (!isCurrent()) return;
                const message = webAttachmentUploadMessage(error, t);
                setAttachmentError?.(message);
                showToast(message, 'error');
                return { success: false, error: message };
            }
            const latest = latestRef.current;
            if (!isCurrent()) return;
            if (latest.baselineTask !== baselineTask) return;
            const patch = taskDraftToChangedUpdatePatch(latest.draft, baselineTask, {
                statusOverride: options?.statusOverride,
                attachments: preparedAttachments,
            });
            if (!patch) return;
            if (options?.completedAtOverride !== undefined) {
                patch.completedAt = options.completedAtOverride;
            }


            if (options && 'timeSpentMinutesOverride' in options) {
                patch.timeSpentMinutes = options.timeSpentMinutesOverride;
            }

            const savePreparedDraft = async () => {
                const base = savedRef.current?.opened === baselineTask ? savedRef.current.saved : baselineTask;
                const attachmentSaveRequiresDurability = beginAttachmentSave();
                try { retainWebAttachmentsBeforeStore?.(preparedAttachments ?? []); }
                catch (error) {
                    cancelAttachmentSaveBeforeStoreUpdate();
                    const message = webAttachmentUploadMessage(error, t);
                    setAttachmentError?.(message);
                    showToast(message, 'error');
                    return { success: false, error: message };
                }
                let outcome: Awaited<ReturnType<typeof saveDraftOnLatest>>;
                try {
                    outcome = await saveDraftOnLatest(task.id, base, patch, () => {
                        if (!isCurrent()) throw new Error('attachments.webUploadChanged');
                        retainWebAttachmentsBeforeStore?.(preparedAttachments ?? []);
                    });
                } catch (error) {
                    if (!isCurrent()) return;
                    const message = webAttachmentUploadMessage(error, t);
                    setAttachmentError?.(message);
                    showToast(message, 'error');
                    return { success: false, error: message };
                }
                const { result, saved } = outcome;
                if (!isCurrent()) return result;
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
                        if (!isCurrent()) return;
                        const message = error instanceof Error ? error.message : String(error || t('task.updateFailed'));
                        showToast(message, 'error');
                        return { success: false, error: message };
                    }
                    if (!isCurrent()) return result;
                    settlePersistedAttachmentSave(saved?.attachments ?? editAttachments ?? task.attachments ?? []);
                }
                const changedDuringSave = latestRef.current.draft !== latest.draft
                    || latestRef.current.editAttachments !== latest.editAttachments;
                if (!options?.keepEditing && !changedDuringSave) {
                    setIsEditing(false);
                    if (editingTaskId === task.id) {
                        setEditingTaskId(null);
                    }
                }
                return result;
            };
            return patch.status === 'done'
                ? trackInboxCompletion([task.id], savePreparedDraft)
                : savePreparedDraft();
        };
        const running = operation().finally(() => { if (inFlightRef.current === running) inFlightRef.current = null; });
        inFlightRef.current = running;
        return running;
    }, [
        isImportingFiles,
        prepareAttachmentsForSave,
        getAttachmentDraftGeneration,
        retainWebAttachmentsBeforeStore,
        setAttachmentError,
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
        trackInboxCompletion,
    ]);
}
