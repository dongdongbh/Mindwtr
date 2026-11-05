import type { Task, TaskStatus, TimeEstimate } from './types';

export type TaskShareContent = { title: string | undefined; message: string };


export function buildTaskShare(input: {
    task: Task | null;
    mergedTask: Partial<Task>;
    rawTitle?: string | null;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    t: (key: string) => string;
    formatDate: (dateStr?: string) => string;
    formatDueDate: (dateStr?: string) => string;
    formatTimeEstimateLabel: (estimate: TimeEstimate) => string;
}): TaskShareContent | null {
    const { task, mergedTask, rawTitle, prioritiesEnabled, timeEstimatesEnabled, t,
        formatDate, formatDueDate, formatTimeEstimateLabel } = input;
    if (!task) return null;

    const title = String(rawTitle ?? mergedTask.title ?? task.title ?? '').trim();
    const lines: string[] = [];
    if (title) lines.push(title);

    const status = (mergedTask.status ?? task.status) as TaskStatus | undefined;
    if (status) lines.push(`${t('taskEdit.statusLabel')}: ${t(`status.${status}`)}`);
    if (prioritiesEnabled) {
        const priority = mergedTask.priority ?? task.priority;
        if (priority) lines.push(`${t('taskEdit.priorityLabel')}: ${t(`priority.${priority}`)}`);
    }
    if (mergedTask.startTime) lines.push(`${t('taskEdit.startDateLabel')}: ${formatDate(mergedTask.startTime)}`);
    if (mergedTask.dueDate) lines.push(`${t('taskEdit.dueDateLabel')}: ${formatDueDate(mergedTask.dueDate)}`);
    if (mergedTask.reviewAt) lines.push(`${t('taskEdit.reviewDateLabel')}: ${formatDate(mergedTask.reviewAt)}`);
    if (timeEstimatesEnabled) {
        const estimate = mergedTask.timeEstimate as TimeEstimate | undefined;
        if (estimate) lines.push(`${t('taskEdit.timeEstimateLabel')}: ${formatTimeEstimateLabel(estimate)}`);
    }

    const contexts = (mergedTask.contexts ?? []).filter(Boolean);
    if (contexts.length) lines.push(`${t('taskEdit.contextsLabel')}: ${contexts.join(', ')}`);

    const tags = (mergedTask.tags ?? []).filter(Boolean);
    if (tags.length) lines.push(`${t('taskEdit.tagsLabel')}: ${tags.join(', ')}`);

    const description = String(mergedTask.description ?? '').trim();
    if (description) {
        lines.push('');
        lines.push(`${t('taskEdit.descriptionLabel')}:`);
        lines.push(description);
    }

    const checklist = (mergedTask.checklist ?? []).filter((item) => item && item.title);
    if (checklist.length) {
        lines.push('');
        lines.push(`${t('taskEdit.checklist')}:`);
        checklist.forEach((item) => {
            lines.push(`${item.isCompleted ? '[x]' : '[ ]'} ${item.title}`);
        });
    }

    const message = lines.join('\n').trim();
    return message ? { title: title || undefined, message } : null;
}
