import type { Attachment, Task } from '@mindwtr/core';
import {
    areDraftAttachmentsDirty,
    createTaskDraft,
    isTaskDraftDirty,
    setTaskDraftField,
    taskDraftToChangedUpdatePatch,
    type TaskDraft,
} from '@mindwtr/core/task-draft';

/**
 * Mobile keeps checklist and attachment buffers beside the shared TaskDraft:
 * both have their own editing lifecycle and deliberately do not live in the
 * scalar field table (ADR 0022 and attachment soft-delete semantics).
 */
export type TaskEditDraft = {
    draft: TaskDraft;
    checklist: Task['checklist'];
    attachments: Attachment[] | undefined;
};

export function createTaskEditDraft(task: Task): TaskEditDraft {
    return {
        draft: createTaskDraft(task),
        checklist: task.checklist,
        attachments: task.attachments,
    };
}

const areChecklistsDirty = (state: TaskEditDraft, task: Task) => (
    JSON.stringify(state.checklist ?? null) !== JSON.stringify(task.checklist ?? null)
);

export function isTaskEditDraftDirty(state: TaskEditDraft, task: Task): boolean {
    return isTaskDraftDirty(state.draft, task)
        || areChecklistsDirty(state, task)
        || areDraftAttachmentsDirty(state.attachments, task);
}

export type TaskEditDraftOverrides = {
    title?: string;
    description?: string;
    contexts?: string[];
    tags?: string[];
};

const applyDraftOverrides = (
    state: TaskEditDraft,
    overrides: TaskEditDraftOverrides,
): TaskEditDraft => {
    if (Object.keys(overrides).length === 0) return state;
    let draft = state.draft;
    if (overrides.title !== undefined) draft = setTaskDraftField(draft, 'title', overrides.title);
    if (overrides.description !== undefined) draft = setTaskDraftField(draft, 'description', overrides.description);
    if (overrides.contexts !== undefined) draft = setTaskDraftField(draft, 'contexts', overrides.contexts.join(', '));
    if (overrides.tags !== undefined) draft = setTaskDraftField(draft, 'tags', overrides.tags.join(', '));
    return draft === state.draft ? state : { ...state, draft };
};

/** Serialize a narrow update patch while comparing against TaskDraft's own
 * normalized baseline. This prevents an unrelated edit from rewriting dates
 * merely because the draft uses datetime-local values internally. */
export function buildTaskEditUpdatePatch(
    state: TaskEditDraft,
    task: Task,
    overrides: TaskEditDraftOverrides = {},
): Partial<Task> | null {
    const finalState = applyDraftOverrides(state, overrides);
    const narrowed = taskDraftToChangedUpdatePatch(finalState.draft, task, {
        attachments: finalState.attachments,
    });
    if (!narrowed) return null;
    // Blank rows are a typing convenience (return mints the next row before it
    // has text) and never content — they are dropped at save, so a saved task
    // keeps no trailing empty item (#1045).
    const cleanedChecklist = finalState.checklist?.filter((item) => item.title.trim() !== '');
    const bothEmpty = (cleanedChecklist?.length ?? 0) === 0 && (task.checklist?.length ?? 0) === 0;
    if (!bothEmpty && areChecklistsDirty({ ...finalState, checklist: cleanedChecklist }, task)) {
        narrowed.checklist = cleanedChecklist;
    }
    return narrowed;
}
