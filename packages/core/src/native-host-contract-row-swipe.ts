import type { NativeHostResult } from './native-host-contract';
import { buildTaskRowSwipeActions, type TaskRowSwipeActions } from './task-row-swipe-actions';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import type { Task } from './types';
import type { TranslateFn } from './i18n';
export type NativeTaskRowSwipeActionsInput = { status: Task['status']; isFocusedToday: boolean; selectionMode: boolean; interactionDisabled: boolean };
/** Presentation only: supplied flags and the current translator, with no store or persistence access. */
export const nativeTaskRowSwipeActions = (input: NativeTaskRowSwipeActionsInput, t: TranslateFn): NativeHostResult<TaskRowSwipeActions> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !isNativeJsonWithinBytes(input, 4096)
        || Object.keys(input).length !== 4 || !['status', 'isFocusedToday', 'selectionMode', 'interactionDisabled'].every(field => Object.prototype.hasOwnProperty.call(input, field))
        || !['inbox', 'next', 'waiting', 'someday', 'done', 'reference', 'archived'].includes(input.status)
        || typeof input.isFocusedToday !== 'boolean' || typeof input.selectionMode !== 'boolean' || typeof input.interactionDisabled !== 'boolean')
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'Exact swipe presentation flags are required' } };
    const result = buildTaskRowSwipeActions({ task: input, t, selectionMode: input.selectionMode, interactionDisabled: input.interactionDisabled });
    return isNativeJsonWithinBytes(result, 16_384) ? { ok: true, value: result }
        : { ok: false, error: { code: 'SAVE_FAILED', message: 'Swipe presentation exceeds its bounded response' } };
};
