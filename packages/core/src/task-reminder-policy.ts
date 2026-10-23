import type { NotificationSettings, Task, TaskReminderPolicy } from './types';

export function normalizeTaskReminderPolicy(value: unknown): TaskReminderPolicy | undefined {
    return value === 'inherit' || value === 'send' || value === 'skip' ? value : undefined;
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
    return policy === 'inherit' ? settings.taskReminderDefault !== 'skip' : policy === 'send';
}

/** The library default as a prepared journal freezes it: anything but Skip sends. */
export function getTaskReminderDefault(settings: Pick<NotificationSettings, 'taskReminderDefault'> = {}): 'send' | 'skip' {
    return settings.taskReminderDefault === 'skip' ? 'skip' : 'send';
}
