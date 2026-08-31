import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
    createTaskDraft,
    setTaskDraftField,
    type Attachment,
    type Task,
    type TaskDraft,
    type TaskDraftSetter,
} from '@mindwtr/core';

type UseTaskItemEditStateOptions = {
    task: Task;
    resetAttachmentState: (attachments: Attachment[] | undefined) => void;
};

export type TaskItemEditState = {
    baselineTask: Task;
    draft: TaskDraft;
    setField: TaskDraftSetter;
    showDescriptionPreview: boolean;
    setShowDescriptionPreview: Dispatch<SetStateAction<boolean>>;
    resetEditState: () => void;
};

const hasPreviewableDescription = (task: Task) => Boolean(task.description?.trim());

/**
 * React adapter over the TaskDraft module: one draft object in state, one
 * setter. Initialization, reset, dirty-checking, field cascades, and the
 * update patch all live in core task-draft.ts — this hook only binds the
 * draft to React.
 */
export function useTaskItemEditState({
    task,
    resetAttachmentState,
}: UseTaskItemEditStateOptions): TaskItemEditState {
    // This advances only when an edit session resets. Keeping it separate from
    // the live task prop lets submit distinguish user edits from later updates.
    const [baselineTask, setBaselineTask] = useState(task);
    const [draft, setDraft] = useState<TaskDraft>(() => createTaskDraft(task));
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(() => hasPreviewableDescription(task));

    const setField = useCallback<TaskDraftSetter>((field, value) => {
        setDraft((current) => setTaskDraftField(current, field, value));
    }, []);

    const resetEditState = useCallback(() => {
        setBaselineTask(task);
        setDraft(createTaskDraft(task));
        resetAttachmentState(task.attachments);
        setShowDescriptionPreview(hasPreviewableDescription(task));
    }, [resetAttachmentState, task]);

    return useMemo(() => ({
        baselineTask,
        draft,
        setField,
        showDescriptionPreview,
        setShowDescriptionPreview,
        resetEditState,
    }), [baselineTask, draft, resetEditState, setField, showDescriptionPreview]);
}
