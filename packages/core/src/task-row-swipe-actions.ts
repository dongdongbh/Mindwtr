import { tFallback, type TranslateFn } from './i18n';
import type { Task, TaskStatus } from './types';

/**
 * The task row's swipe tray (#1464), as plain data so every app renders the same actions.
 * A swipe right uncovers `swipeRight`, a swipe left uncovers `swipeLeft`. Each list is in
 * screen order, left to right. An action runs only when its revealed button is tapped.
 * The row's accessibility actions list the same actions, so none is gesture-only.
 */
export type TaskRowSwipeActionId = 'done' | 'focus' | 'organize' | 'dates' | 'delete' | 'restore' | 'next';

export type TaskRowSwipeAction = {
    id: TaskRowSwipeActionId;
    label: string;
    /** The status that done, restore, and next write. */
    status?: TaskStatus;
    /** Focus only: true when the tap removes the star. */
    focused?: boolean;
    /** False in selection mode: the tray stays shut and screen readers are not offered the action. */
    enabled: boolean;
};

export type TaskRowSwipeActions = {
    swipeRight: TaskRowSwipeAction[];
    swipeLeft: TaskRowSwipeAction[];
};

export type TaskRowSwipeActionsInput = {
    task: Pick<Task, 'status' | 'isFocusedToday'>;
    t: TranslateFn;
    selectionMode?: boolean;
    /** A read-only or otherwise disabled row offers no actions at all. */
    interactionDisabled?: boolean;
};

export function buildTaskRowSwipeActions(input: TaskRowSwipeActionsInput): TaskRowSwipeActions {
    if (input.interactionDisabled) return { swipeRight: [], swipeLeft: [] };
    const { task, t } = input;
    const enabled = !input.selectionMode;
    const action = (id: TaskRowSwipeActionId, label: string, extra: Partial<TaskRowSwipeAction> = {}): TaskRowSwipeAction => (
        { id, label, enabled, ...extra }
    );
    const done = action('done', tFallback(t, 'common.done', 'Done'), { status: 'done' });
    const remove = action('delete', tFallback(t, 'common.delete', 'Delete'));
    const organize = action('organize', tFallback(t, 'nav.sectionOrganize', 'Organize'));
    switch (task.status) {
        case 'inbox':
        case 'next':
        case 'waiting':
        case 'someday': {
            const focused = task.isFocusedToday === true;
            return {
                swipeRight: [
                    done,
                    action('focus', focused
                        ? tFallback(t, 'agenda.removeFromFocus', 'Remove from focus')
                        : tFallback(t, 'digest.focus', 'Focus'), { focused }),
                ],
                swipeLeft: [organize, action('dates', tFallback(t, 'task.dates', 'Dates…')), remove],
            };
        }
        case 'done':
            // Organize stays: it is the done row's only swipe path to the status menu.
            return {
                swipeRight: [action('restore', tFallback(t, 'archived.restoreToInbox', 'Restore'), { status: 'inbox' })],
                swipeLeft: [organize, remove],
            };
        case 'reference':
            // A Reference row has no status control, so Organize is its swipe path to the status menu.
            return { swipeRight: [action('next', tFallback(t, 'status.next', 'Next'), { status: 'next' })], swipeLeft: [organize, remove] };
        default:
            // Archived keeps its old single status action.
            return { swipeRight: [done], swipeLeft: [remove] };
    }
}
