import { safeParseDate, type Task, type TaskStatus } from '@mindwtr/core';
import type { DesktopViewId } from './navigation-events';

function isDeferredForPrimaryFocus(task: Task, now: Date = new Date()): boolean {
    const start = safeParseDate(task.startTime);
    if (!start) return false;
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return start > endOfToday;
}

export function resolveTaskNavigationView(task: Task, now: Date = new Date()): DesktopViewId {
    const statusViewMap: Record<TaskStatus, DesktopViewId> = {
        inbox: 'inbox',
        next: 'next',
        waiting: 'waiting',
        someday: 'someday',
        reference: 'reference',
        done: 'done',
        archived: 'archived',
    };
    const primaryView = statusViewMap[task.status] || 'next';
    const hidesDeferredTasks = primaryView === 'inbox' || primaryView === 'next';
    if (hidesDeferredTasks && isDeferredForPrimaryFocus(task, now)) {
        return 'review';
    }
    return primaryView;
}
