import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseQuickAdd } from './quick-add';
import { executeCaptureTransaction } from './capture';
import { getTaskReminderPolicy, shouldSendTaskReminders } from './task-reminder-policy';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { mergeSettingsForSync } from './sync-merge-settings';
import { sanitizeAppDataForRemote } from './sync-helpers';
import { createNextRecurringTask } from './recurrence';
import type { AppData, Task } from './types';

const sanitizeSettingsForRemote = (settings: AppData['settings']) => sanitizeAppDataForRemote({ tasks: [], projects: [], sections: [], areas: [], settings }).settings;

const task = (patch: Partial<Task> = {}): Task => ({ id: 'legacy', title: 'Task', status: 'next',
    tags: [], contexts: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...patch });

describe('task reminder policy compatibility', () => {
    it.each([undefined, false, true])('keeps legacy suppression %s explicit regardless of the library default', (suppressed) => {
        const legacy = task({ suppressMindwtrReminders: suppressed });
        expect(getTaskReminderPolicy(legacy)).toBe(suppressed ? 'skip' : 'send');
        expect(shouldSendTaskReminders(legacy, { taskReminderDefault: 'skip' })).toBe(!suppressed);
        expect(shouldSendTaskReminders(legacy, { taskReminderDefault: 'send' })).toBe(!suppressed);
    });

    it.each(['send', 'skip'] as const)('resolves all policies with default %s', (defaultPolicy) => {
        for (const reminderPolicy of ['inherit', 'send', 'skip'] as const) {
            expect(shouldSendTaskReminders(task({ reminderPolicy }), { taskReminderDefault: defaultPolicy }))
                .toBe((reminderPolicy === 'inherit' ? defaultPolicy : reminderPolicy) === 'send');
        }
    });

    it('preserves policy in recurring successors including legacy absence', () => {
        for (const reminderPolicy of [undefined, 'inherit', 'send', 'skip'] as const) {
            const next = createNextRecurringTask(task({ reminderPolicy, dueDate: '2026-10-15T09:00:00Z',
                recurrence: { rule: 'daily' } }), new Date('2026-10-15T09:30:00Z'));
            expect(next).not.toBeNull();
            expect(next?.reminderPolicy).toBe(reminderPolicy);
        }
    });

    it('syncs the default under GTD without syncing device notification delivery switches', () => {
        const remote = sanitizeSettingsForRemote({ taskReminderDefault: 'skip', notificationsEnabled: false,
            dueDateNotificationsEnabled: false, syncPreferences: { gtd: true } });
        expect(remote.taskReminderDefault).toBe('skip');
        expect(remote.notificationsEnabled).toBeUndefined();
        expect(remote.dueDateNotificationsEnabled).toBeUndefined();
        expect(sanitizeSettingsForRemote({ taskReminderDefault: 'skip', syncPreferences: { gtd: false } }).taskReminderDefault).toBeUndefined();
        const local = { taskReminderDefault: 'send' as const, notificationsEnabled: true,
            syncPreferencesUpdatedAt: { gtd: '2026-10-01T00:00:00Z' } };
        const merged = mergeSettingsForSync(local, { ...remote, syncPreferencesUpdatedAt: { gtd: '2026-10-02T00:00:00Z' } });
        expect(merged.taskReminderDefault).toBe('skip');
        expect(merged.notificationsEnabled).toBe(true);
        expect(mergeSettingsForSync(merged, { syncPreferencesUpdatedAt: { gtd: '2026-10-03T00:00:00Z' } }).taskReminderDefault).toBe('skip');
        expect(mergeSettingsForSync(merged, merged)).toEqual(merged);
    });
});

describe('reminder intent through task writes', () => {
    let saved: AppData;
    beforeEach(() => {
        saved = { tasks: [task()], projects: [], sections: [], areas: [], settings: { deviceId: 'test-device', taskReminderDefault: 'skip' } };
        setStorageAdapter({ getData: async () => saved,
            saveData: async data => { saved = structuredClone(data); } });
        useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: [], _allSections: [], _allAreas: [],
            settings: saved.settings, persistenceFailure: null, isLoading: false, editLockCount: 0 });
    });
    afterEach(async () => { await flushPendingSave(); resetForTests(); });

    it.each(['send', 'skip'] as const)('persists capture lead fields while inheriting %s policy and retaining device preferences', async policy => {
        useTaskStore.setState({ settings: { ...saved.settings, taskReminderDefault: policy, notificationsEnabled: false } });
        const input = 'Call /due:2030-11-12 17:00 /remind-due:1d /start:2030-11-12 09:00 /remind-start:30m';
        const result = await executeCaptureTransaction({ parsed: parseQuickAdd(input), rawInput: input, projects: [] }, useTaskStore.getState());
        expect(result.success).toBe(true);
        await flushPendingSave();
        const captured = saved.tasks.find(row => row.title === 'Call');
        expect(captured).toMatchObject({ dueReminderLeadMinutes: 1440, startReminderLeadMinutes: 30, reminderPolicy: 'inherit' });
        if (!captured) throw new Error('Capture missing');
        expect(shouldSendTaskReminders(captured, saved.settings)).toBe(policy === 'send');
        expect(saved.settings.notificationsEnabled).toBe(false);
    });

    it('new tasks inherit, survive unrelated edits, and legacy tasks keep sending', async () => {
        const created = await useTaskStore.getState().addTask('New');
        if (!created.success) throw new Error(created.error);
        expect(useTaskStore.getState()._allTasks.find(row => row.id === created.id)).toMatchObject({ reminderPolicy: 'inherit', suppressMindwtrReminders: true });
        await useTaskStore.getState().updateTask(created!.id, { description: 'Changed' });
        await flushPendingSave();
        const persisted = saved.tasks.find(row => row.id === created!.id)!;
        expect(persisted.reminderPolicy).toBe('inherit');
        expect(shouldSendTaskReminders(saved.tasks.find(row => row.id === 'legacy')!, saved.settings)).toBe(true);
        const olderClientCopy = { ...persisted };
        delete olderClientCopy.reminderPolicy;
        expect(getTaskReminderPolicy(olderClientCopy)).toBe('skip');
        await useTaskStore.getState().updateSettings({ taskReminderDefault: 'send' });
        await flushPendingSave();
        expect(shouldSendTaskReminders(saved.tasks.find(row => row.id === created!.id)!, saved.settings)).toBe(true);
        expect(saved.tasks.find(row => row.id === 'legacy')!.reminderPolicy).toBeUndefined();
    });

    it('new Getting Started tasks inherit with a compatible snapshot', async () => {
        await useTaskStore.getState().seedGettingStarted();
        await flushPendingSave();
        const seeded = saved.tasks.filter(row => row.id !== 'legacy');
        expect(seeded.length).toBeGreaterThan(0);
        expect(seeded.every(row => row.reminderPolicy === 'inherit' && row.suppressMindwtrReminders === true)).toBe(true);
    });

    it('explicit policy and legacy boolean edits preserve their intent', async () => {
        const created = await useTaskStore.getState().addTask('Explicit', { suppressMindwtrReminders: false });
        if (!created.success) throw new Error(created.error);
        expect(useTaskStore.getState()._allTasks.find(row => row.id === created.id)).toMatchObject({ reminderPolicy: 'send', suppressMindwtrReminders: false });
        await useTaskStore.getState().updateTask(created!.id, { reminderPolicy: 'inherit' });
        await flushPendingSave();
        expect(saved.tasks.find(row => row.id === created!.id)).toMatchObject({ reminderPolicy: 'inherit', suppressMindwtrReminders: true });
        await useTaskStore.getState().updateTask(created!.id, { suppressMindwtrReminders: false });
        await flushPendingSave();
        expect(saved.tasks.find(row => row.id === created!.id)).toMatchObject({ reminderPolicy: 'send', suppressMindwtrReminders: false });
    });
});
