import type { NotificationSettings, Task, TaskReminderPolicy } from './types';

export function normalizeTaskReminderPolicy(value: unknown): TaskReminderPolicy | undefined {
    return value === 'inherit' || value === 'send' || value === 'skip' || value === 'start' || value === 'due' ? value : undefined;
}

export function getTaskReminderPolicy(task: Pick<Task, 'reminderPolicy' | 'suppressMindwtrReminders'>): TaskReminderPolicy {
    const policy = normalizeTaskReminderPolicy(task.reminderPolicy);
    if (policy) return policy;
    return task.suppressMindwtrReminders === true ? 'skip' : 'send';
}

export function shouldSendTaskReminders(
    task: Pick<Task, 'reminderPolicy' | 'suppressMindwtrReminders'>,
    settings: Pick<NotificationSettings, 'taskReminderDefault'> = {},
): boolean {
    const policy = getTaskReminderPolicy(task);
    return policy === 'inherit' ? settings.taskReminderDefault !== 'skip' : policy !== 'skip';
}


export function getTaskReminderDefault(settings: Pick<NotificationSettings, 'taskReminderDefault'> = {}): 'send' | 'skip' {
    return settings.taskReminderDefault === 'skip' ? 'skip' : 'send';
}

export function isSingleTaskReminder(task: Pick<Task, 'reminderPolicy' | 'suppressMindwtrReminders'>): boolean {
    const policy = getTaskReminderPolicy(task);
    return policy === 'start' || policy === 'due';
}

export function shouldSendTaskReminderKind(
    task: Pick<Task, 'reminderPolicy' | 'suppressMindwtrReminders'>,
    kind: 'start' | 'due',
    settings: Pick<NotificationSettings, 'taskReminderDefault'> = {},
): boolean {
    return shouldSendTaskReminders(task, settings) && (!isSingleTaskReminder(task) || getTaskReminderPolicy(task) === kind);
}

export function suppressLegacyTaskReminders(
    task: Pick<Task, 'reminderPolicy' | 'suppressMindwtrReminders'>,
    settings: Pick<NotificationSettings, 'taskReminderDefault'> = {},
): boolean {
    return isSingleTaskReminder(task) || !shouldSendTaskReminders(task, settings);
}

export function isTaskReminderSelectionCurrent(
    task: Pick<Task, 'reminderPolicy' | 'suppressMindwtrReminders'>,
    data: Record<string, unknown>,
    settings: NotificationSettings = {},
): boolean {
    if (data.kind === 'task-review') return true;
    if (isSingleTaskReminder(task) && (settings.notificationsEnabled === false
        || (getTaskReminderPolicy(task) === 'start' ? settings.startDateNotificationsEnabled === false : settings.dueDateNotificationsEnabled === false))) return false;
    if (isSingleTaskReminder(task) || data.reminderSelection !== undefined) {
        return data.reminderSelection === getTaskReminderPolicy(task);
    }
    return true;
}
