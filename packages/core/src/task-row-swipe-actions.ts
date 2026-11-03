import { tFallback, type TranslateFn } from './i18n';
import type { Task, TaskStatus } from './types';


export type TaskRowSwipeActionId = 'done' | 'focus' | 'organize' | 'dates' | 'delete' | 'restore' | 'next';

export type TaskRowSwipeAction = {
    id: TaskRowSwipeActionId;
    label: string;

    status?: TaskStatus;

    focused?: boolean;

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

            return {
                swipeRight: [action('restore', tFallback(t, 'archived.restoreToInbox', 'Restore'), { status: 'inbox' })],
                swipeLeft: [organize, remove],
            };
        case 'reference':

            return { swipeRight: [action('next', tFallback(t, 'status.next', 'Next'), { status: 'next' })], swipeLeft: [organize, remove] };
        default:

            return { swipeRight: [done], swipeLeft: [remove] };
    }
}
