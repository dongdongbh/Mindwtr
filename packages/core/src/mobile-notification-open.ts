


import { isTaskActionable } from './task-status';
import type { Task } from './types';

export type NotificationOpenPayload = {
    notificationId?: string;
    actionIdentifier?: string;
    taskId?: string;
    projectId?: string;
    context?: string;
    kind?: string;
};

export type NotificationOpenRoute =
    | { type: 'none' }
    | { type: 'complete'; taskId: string; actionKey: string }
    | { type: 'review'; openToken: string; taskId?: string; projectId?: string }
    | { type: 'task'; taskId: string; openToken: string }
    | { type: 'project'; projectId: string }
    | { type: 'contexts'; token: string }
    | { type: 'daily-review'; openToken: string }
    | { type: 'weekly-review'; openToken: string };


export const REMINDER_COMPLETE_UPDATE = { status: 'done', isFocusedToday: false } as const;

export type ReminderCompletionBlocker = 'task-not-found' | 'task-deleted' | 'not-actionable';


export function getReminderCompletionBlocker(task: Pick<Task, 'status' | 'deletedAt'> | undefined): ReminderCompletionBlocker | null {
    if (!task) return 'task-not-found';
    if (task.deletedAt) return 'task-deleted';
    if (!isTaskActionable(task)) return 'not-actionable';
    return null;
}

function isReviewReminderKind(kind: string | undefined): boolean {
    return kind === 'task-review' || kind === 'project-review';
}

function isWeeklyReviewOpen(kind: string | undefined, notificationId: string): boolean {
    return kind === 'weekly-review' || notificationId === 'digest:weekly-review';
}

function isDailyReviewOpen(kind: string | undefined, notificationId: string): boolean {
    return kind === 'daily-digest' || notificationId === 'digest:morning' || notificationId === 'digest:evening';
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);


export function resolveNotificationOpenRoute(
    payload: unknown,
    clock: { now: () => number; nextTaskOpenSequence: () => number },
): NotificationOpenRoute {
    const fields = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const rawNotificationId = text(fields.notificationId);
    const notificationId = rawNotificationId === undefined ? undefined : rawNotificationId.trim();
    const openToken = notificationId || String(clock.now());
    const actionIdentifier = text(fields.actionIdentifier);
    const taskId = text(fields.taskId);
    const projectId = text(fields.projectId);
    const context = text(fields.context);
    const kind = text(fields.kind);
    const normalizedAction = String(actionIdentifier || '').trim().toLowerCase();
    if (normalizedAction === 'dismiss' || normalizedAction === 'dismiss_action' || normalizedAction === 'snooze' || normalizedAction === 'snooze_action') {
        return { type: 'none' };
    }
    if ((normalizedAction === 'complete' || normalizedAction === 'complete_action') && taskId) {
        return { type: 'complete', taskId, actionKey: `${openToken}:${taskId}:complete` };
    }
    if (isReviewReminderKind(kind)) {
        return {
            type: 'review',
            openToken,
            ...(taskId ? { taskId } : {}),
            ...(projectId ? { projectId } : {}),
        };
    }
    if (taskId) {
        const sequence = clock.nextTaskOpenSequence();
        return { type: 'task', taskId, openToken: `${notificationId || 'notification'}:${clock.now()}:${sequence}` };
    }
    if (projectId) return { type: 'project', projectId };
    if (kind === 'context-automation' && context) return { type: 'contexts', token: context };
    if (isDailyReviewOpen(kind, openToken)) return { type: 'daily-review', openToken };
    if (isWeeklyReviewOpen(kind, openToken)) return { type: 'weekly-review', openToken };
    return { type: 'none' };
}
