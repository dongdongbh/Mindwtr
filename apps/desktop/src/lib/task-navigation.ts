import { shouldShowTaskForStart, type Task, type TaskStatus } from '@mindwtr/core';
import type { DesktopViewId } from './navigation-events';

export type TaskNavigationInput = Pick<Task, 'status' | 'startTime'> & Partial<Pick<Task, 'dueDate' | 'recurrence' | 'reviewAt'>>;

export function resolveTaskNavigationView(task: TaskNavigationInput, now: Date = new Date()): DesktopViewId {
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
    const hidesDeferredTasks = primaryView === 'next';


    if (hidesDeferredTasks && !shouldShowTaskForStart(task, { now, granularity: 'time' })) {
        return 'review';
    }
    return primaryView;
}
