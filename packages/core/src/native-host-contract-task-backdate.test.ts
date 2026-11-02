import { afterEach, describe, expect, it } from 'vitest';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { createNativeHostContract, type NativeHostResult, type NativeTaskDraftEdit } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';
import { generateUUID } from './uuid';

/**
 * Native Android's completion-time picker (RN's completed-at-picker.tsx and swipeable-task-item.tsx applyCompletedAt), one test
 * per RN rule ported: bca5e3e7e (the editor's long-press on Done edits its draft, Time Spent with it), the row's long-press on
 * Done completes at the picked time (Time Spent only when on), and a finished row's date edits only its time.
 */
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const NOW = new Date().toISOString();
const task = (id: string, status: Task['status'], fields: Partial<Task> = {}): Task => ({
    id, title: `Title ${id}`, status, tags: [], contexts: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a', ...fields,
} as Task);
/** The ISO instant of a local day and time, as the picker stores it. */
const local = (day: string, time: string) => {
    const [y, m, d] = day.split('-').map(Number);
    const [h, min] = time.split(':').map(Number);
    return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
};
const pad = (n: number) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function openHost(data: Partial<AppData>) {
    await flushPendingSave();
    resetForTests();
    let saved = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a' }, ...data };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(saved)),
        saveData: async (next) => { saved = JSON.parse(JSON.stringify(next)); },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        tasks: [], _allTasks: [], projects: [], _allProjects: [] } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
}
type Host = Awaited<ReturnType<typeof openHost>>;
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id)!;
const set = (host: Host, id: string, mode: 'complete' | 'edit', day: string, time: string, timeSpentText?: string) =>
    host.setTaskCompletedAt({ requestId: generateUUID(), taskId: id, taskRevision: taskRevisionOf(stored(id)), mode, day, time,
        ...(timeSpentText !== undefined ? { timeSpentText } : {}) });
// RN's timeSpentEnabled: Pomodoro on, with Link task.
const timeSpentOn = { deviceId: 'device-a', features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true } } } as AppData['settings'];
const lines: LogPayload[] = [];

describe('native host contract: completion-time picker', () => {
    afterEach(() => {
        setLogger(consoleLogger);
        lines.length = 0;
    });

    it('a row\'s long-press on Done starts now and completes at the picked minute, with no Time Spent while it is off', async () => {
        const host = await openHost({ tasks: [task('a', 'next')] });
        const picker = value(host.getCompletedAtPicker({ taskId: 'a', mode: 'complete' })).picker!;
        expect(picker).toMatchObject({ mode: 'complete', taskId: 'a', day: today(), timeSpent: null });
        expect(picker.time).toMatch(/^\d{2}:\d{2}$/);
        expect(value(await set(host, 'a', 'complete', '2026-09-20', '08:30'))).toEqual({ id: 'a', completed: true });
        expect(stored('a')).toMatchObject({ status: 'done', completedAt: local('2026-09-20', '08:30') });
    });

    it('offers the Done picker for any task not done yet, an archived one too, as RN\'s canBackdateCompletion (bca5e3e7e)', async () => {
        const host = await openHost({ tasks: [task('ar', 'archived', { completedAt: NOW })] });
        expect(value(host.getCompletedAtPicker({ taskId: 'ar', mode: 'complete' })).picker).toMatchObject({ mode: 'complete', taskId: 'ar' });
        value(await set(host, 'ar', 'complete', '2026-09-20', '08:30'));
        expect(stored('ar')).toMatchObject({ status: 'done', completedAt: local('2026-09-20', '08:30') });
    });

    it('with Time Spent on, the Done shows RN\'s card with the task\'s minutes and stores the minutes typed', async () => {
        const host = await openHost({ tasks: [task('a', 'next', { timeSpentMinutes: 20 })], settings: timeSpentOn });
        const picker = value(host.getCompletedAtPicker({ taskId: 'a', mode: 'complete' })).picker!;
        expect(picker.timeSpent).toEqual({ title: 'Completion time', label: 'Time Spent', placeholder: 'minutes', value: '20', cancel: 'Cancel', save: 'Save' });
        value(await set(host, 'a', 'complete', '2026-09-20', '08:30', '45'));
        expect(stored('a')).toMatchObject({ status: 'done', timeSpentMinutes: 45 });
    });

    it('a finished row\'s date edits only its time, starting at the stored completion; never for a cancelled or open task', async () => {
        // Recent days, so core's auto-archive leaves the done row done.
        const yesterday = new Date(Date.now() - 24 * 3600_000);
        const day = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
        const completedAt = local(day, '17:05');
        const host = await openHost({ tasks: [task('d', 'done', { completedAt, timeSpentMinutes: 30 }), task('open', 'next'),
            task('x', 'done', { cancelledAt: completedAt } as Partial<Task>)], settings: timeSpentOn });
        expect(value(host.getCompletedAtPicker({ taskId: 'd', mode: 'edit' })).picker).toMatchObject({ day, time: '17:05', timeSpent: null });
        value(await set(host, 'd', 'edit', today(), '00:01'));
        expect(stored('d')).toMatchObject({ status: 'done', completedAt: local(today(), '00:01'), timeSpentMinutes: 30 });
        expect(value(host.getCompletedAtPicker({ taskId: 'open', mode: 'edit' })).picker).toBeNull();
        expect(value(host.getCompletedAtPicker({ taskId: 'd', mode: 'complete' })).picker).toBeNull();
        expect(await set(host, 'open', 'edit', '2026-07-31', '09:00')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('refuses a task changed since the row showed it, a malformed day, and a replay writes once', async () => {
        const host = await openHost({ tasks: [task('a', 'next')] });
        const request = { requestId: generateUUID(), taskId: 'a', taskRevision: taskRevisionOf(stored('a')), mode: 'complete' as const, day: '2026-09-20', time: '08:30' };
        value(await host.setTaskCompletedAt(request));
        const revision = taskRevisionOf(stored('a'));
        expect(value(await host.setTaskCompletedAt(request))).toEqual({ id: 'a', completed: true });
        expect(taskRevisionOf(stored('a'))).toBe(revision);
        expect(await host.setTaskCompletedAt({ ...request, requestId: generateUUID(), mode: 'edit' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await host.setTaskCompletedAt({ ...request, requestId: generateUUID(), day: '2026-02-30' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('the editor\'s Done starts at its draft and edits the draft only, from the dialogs\' local day and time (bca5e3e7e)', async () => {
        const host = await openHost({ tasks: [task('e', 'next', { timeSpentMinutes: 35 })], settings: timeSpentOn });
        const draftCompletedAt = local('2026-09-19', '07:45');
        expect(value(host.getCompletedAtPicker({ taskId: 'e', mode: 'editor', draft: { completedAt: draftCompletedAt, timeSpentMinutes: 35 } })).picker)
            .toMatchObject({ day: '2026-09-19', time: '07:45', timeSpent: { value: '35' } });
        const draft = value(host.getTaskEditorModel({ id: 'e' })).draft;
        const edited = value(host.editTaskDraft({ id: 'e', draft, edit: { type: 'backdatedCompletion', day: '2026-09-20', time: '10:15', timeSpentText: '50' } as NativeTaskDraftEdit }));
        expect(edited.draft).toMatchObject({ status: 'done', completedAt: local('2026-09-20', '10:15'), timeSpentMinutes: 50 });
        expect(host.editTaskDraft({ id: 'e', draft, edit: { type: 'backdatedCompletion', day: '2026-02-30', time: '10:15' } as NativeTaskDraftEdit }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(stored('e').status).toBe('next');
    });

    it('labels the picked minute in the app\'s format, and logs a save with no title', async () => {
        const host = await openHost({ tasks: [task('a', 'next')] });
        expect(value(host.getPickedCompletedAtLabel({ day: '2026-09-20', time: '08:30' })).label).toMatch(/2026.*8:30/);
        setLogger((payload) => lines.push(payload));
        value(await set(host, 'a', 'complete', '2026-09-20', '08:30'));
        // Forced, as every release line: a tester's log shows it with debug logging off.
        expect(lines.find((line) => line.context?.releaseCheck === 'v1.3.8/native-backdated-completion')).toMatchObject({ force: true, context: { outcome: 'complete' } });
        expect(JSON.stringify(lines)).not.toContain('Title a');
    });
});
