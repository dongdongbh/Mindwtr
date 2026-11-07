import { useCallback, useRef } from 'react';
import {
    taskDraftToChangedSincePatch,
    taskDraftToChangedUpdatePatch,
    taskDraftToUpdatePatch,
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
    incrementalSessionRef?: React.MutableRefObject<IncrementalSaveSession | null>;
};

export type IncrementalSaveBase = { draft: TaskDraft; rawAttachments: Attachment[] | undefined; preparedAttachments: Attachment[] | undefined };
export type IncrementalSaveSession = { baselineTask: Task; base: IncrementalSaveBase; tail: Promise<unknown> };
export type TaskItemSubmitOutcome = 'saved' | 'noop' | 'blocked' | 'failed';
export type TaskItemSubmitResult = (StoreActionResult & { outcome?: TaskItemSubmitOutcome }) | undefined;

const BLOCKED: TaskItemSubmitResult = { success: false, outcome: 'blocked' };

export const draftSinceLastSave = (draft: TaskDraft, base: IncrementalSaveBase): TaskDraft =>
    draft.title.trim() ? draft : { ...draft, title: base.draft.title };


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
    incrementalSessionRef,
}: UseTaskItemSubmitParams) {

    const savedRef = useRef<{ opened: Task; saved: Task } | null>(null);
    const inFlightRef = useRef<Promise<StoreActionResult | undefined> | null>(null);
    const latestRef = useRef({ draft, editAttachments, baselineTask, isImportingFiles, prepareAttachmentsForSave });
    latestRef.current = { draft, editAttachments, baselineTask, isImportingFiles, prepareAttachmentsForSave };
    return useCallback((event?: React.FormEvent, options?: TaskItemSubmitOptions): Promise<TaskItemSubmitResult> => {
        event?.preventDefault();
        const session = incrementalSessionRef?.current;
        if (session) {
            const failWithAttachmentError = (error: unknown): TaskItemSubmitResult => {
                const message = webAttachmentUploadMessage(error, t);
                setAttachmentError?.(message);
                showToast(message, 'error');
                return { success: false, error: message, outcome: 'failed' };
            };
            const dropped = () => incrementalSessionRef?.current === null;
            const run = async (): Promise<TaskItemSubmitResult> => {
                const opened = latestRef.current.baselineTask;
                if (dropped() || latestRef.current.isImportingFiles || session.baselineTask !== opened) return BLOCKED;
                const generation = getAttachmentDraftGeneration?.();
                const isCurrent = () => generation === getAttachmentDraftGeneration?.();
                const { editAttachments: rawAttachments, prepareAttachmentsForSave: prepare } = latestRef.current;
                let preparedAttachments = rawAttachments;
                try {
                    if (prepare) preparedAttachments = await prepare();
                } catch (error) {
                    if (!isCurrent()) return BLOCKED;
                    return failWithAttachmentError(error);
                }
                const latest = latestRef.current;
                if (dropped() || !isCurrent() || latest.baselineTask !== opened) return BLOCKED;
                const draft = draftSinceLastSave(latest.draft, session.base);
                const nextBase: IncrementalSaveBase = { draft, rawAttachments, preparedAttachments };
                const changed = taskDraftToChangedSincePatch(draft, session.base.draft, opened, {
                    statusOverride: options?.statusOverride,
                    attachments: preparedAttachments,
                    previousAttachments: session.base.preparedAttachments,
                });
                const hasOverride = options?.completedAtOverride !== undefined || (!!options && 'timeSpentMinutesOverride' in options);
                if (!changed && !hasOverride) {
                    session.base = nextBase;
                    return { success: true, outcome: 'noop' };
                }
                const patch = changed ?? {};
                if (options?.completedAtOverride !== undefined) {
                    patch.completedAt = options.completedAtOverride;
                }
                if (options && 'timeSpentMinutesOverride' in options) {
                    patch.timeSpentMinutes = options.timeSpentMinutesOverride;
                }

                const lastSaved = taskDraftToUpdatePatch(session.base.draft, opened, { attachments: session.base.preparedAttachments });
                const base: Task = { ...opened, ...lastSaved };
                const attachmentSaveRequiresDurability = beginAttachmentSave();
                try { retainWebAttachmentsBeforeStore?.(preparedAttachments ?? []); }
                catch (error) {
                    cancelAttachmentSaveBeforeStoreUpdate();
                    return failWithAttachmentError(error);
                }
                let written: Awaited<ReturnType<typeof saveDraftOnLatest>>;
                try {
                    written = await saveDraftOnLatest(task.id, base, patch, () => {
                        if (!isCurrent()) throw new Error('attachments.webUploadChanged');
                        retainWebAttachmentsBeforeStore?.(preparedAttachments ?? []);
                    });
                } catch (error) {
                    if (!isCurrent()) return BLOCKED;
                    return failWithAttachmentError(error);
                }
                const { result, saved } = written;
                if (result.success) {
                    session.base = nextBase;
                    if (saved) savedRef.current = { opened, saved };
                }
                if (!isCurrent()) return BLOCKED;
                if (!result.success) {
                    cancelAttachmentSaveBeforeStoreUpdate();
                    showToast(result.error || t('task.updateFailed'), 'error');
                    return { ...result, outcome: 'failed' };
                }
                if (attachmentSaveRequiresDurability) {
                    try {
                        await flushPendingSave();
                    } catch (error) {
                        if (!isCurrent()) return BLOCKED;
                        const message = error instanceof Error ? error.message : String(error || t('task.updateFailed'));
                        showToast(message, 'error');
                        return { success: false, error: message, outcome: 'failed' };
                    }
                    if (!isCurrent()) return BLOCKED;
                    settlePersistedAttachmentSave(saved?.attachments ?? rawAttachments ?? task.attachments ?? []);
                }
                const changedDuringSave = latestRef.current.draft !== latest.draft
                    || latestRef.current.editAttachments !== latest.editAttachments;
                if (!options?.keepEditing && !changedDuringSave) {
                    setIsEditing(false);
                    if (editingTaskId === task.id) {
                        setEditingTaskId(null);
                    }
                }
                return { ...result, outcome: 'saved' };
            };
            const queued = session.tail.catch(() => {}).then(run);
            session.tail = queued;
            return queued;
        }
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
        incrementalSessionRef,
    ]);
}
