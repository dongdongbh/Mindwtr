import { describe, expect, it } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';
import { generateUUID } from './uuid';

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const NOW = new Date().toISOString();
const task = (id: string, status: Task['status'], fields: Partial<Task> = {}): Task => ({
    id, title: `Title ${id}`, status, tags: [], contexts: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a', ...fields,
} as Task);
const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id)!;

describe('native host contract: swipe tray', () => {
    it('gives each status its RN tray in screen order, Remove from focus on a starred row (#1464)', async () => {
        const host = await openHost({});
        const { trays } = value(host.getTaskRowSwipeTrays());
        const ids = (key: string) => [trays[key].swipeRight.map((a) => a.id), trays[key].swipeLeft.map((a) => a.id)];
        for (const status of ['inbox', 'next', 'waiting', 'someday']) expect(ids(status)).toEqual([['done', 'focus'], ['organize', 'dates', 'delete']]);
        expect(ids('done')).toEqual([['restore'], ['organize', 'delete']]);
        expect(ids('reference')).toEqual([['next'], ['organize', 'delete']]);
        expect(ids('archived')).toEqual([['done'], ['delete']]);
        expect(trays.next.swipeRight.map((a) => a.label)).toEqual(['Done', 'Focus']);
        expect(trays['next:focused'].swipeRight[1]).toMatchObject({ label: 'Remove from focus', focused: true });
        expect(trays.next.swipeLeft.map((a) => a.label)).toEqual(['Organize', 'Dates…', 'Delete']);
    });

    it('Focus on an Inbox task stars it and makes it Next in one write; a second Focus unstars (RN toggleFocus(true))', async () => {
        const host = await openHost({ tasks: [task('a', 'inbox')] });
        expect(value(await host.setTaskSwipeFocus({ requestId: generateUUID(), taskId: 'a', taskRevision: taskRevisionOf(stored('a')) })))
            .toEqual({ id: 'a', focused: true });
        expect(stored('a')).toMatchObject({ status: 'next', isFocusedToday: true });
        expect(value(await host.setTaskSwipeFocus({ requestId: generateUUID(), taskId: 'a', taskRevision: taskRevisionOf(stored('a')) })))
            .toEqual({ id: 'a', focused: false });
        expect(stored('a').isFocusedToday).toBeFalsy();
        expect(stored('a').status).toBe('next');
    });

    it('a refused Focus writes nothing and answers RN\'s warning words; a stale row is refused', async () => {
        const host = await openHost({ tasks: [task('a', 'inbox'), task('b', 'next', { isFocusedToday: true })],
            settings: { deviceId: 'device-a', gtd: { focusTaskLimit: 1 } } as AppData['settings'] });
        const before = taskRevisionOf(stored('a'));
        const reply = value(await host.setTaskSwipeFocus({ requestId: generateUUID(), taskId: 'a', taskRevision: before }));
        expect(reply).toMatchObject({ blockedTitle: 'Focus' });
        expect((reply as { blocked: string }).blocked).not.toBe('');
        expect(stored('a')).toMatchObject({ status: 'inbox' });
        expect(taskRevisionOf(stored('a'))).toBe(before);
        const stale = await host.setTaskSwipeFocus({ requestId: generateUUID(), taskId: 'b', taskRevision: 'old' });
        expect(stale.ok ? '' : stale.error.code).toBe('STALE_REVISION');
    });

    it('the Dates sheet shows the task\'s dates, the editor\'s quick dates, and RN\'s start-after-due warning', async () => {
        const host = await openHost({ tasks: [task('a', 'next', { dueDate: '2030-05-10' })] });
        const { sheet } = value(host.getTaskDatesSheet({ taskId: 'a' }));
        expect(sheet).toMatchObject({ title: 'Task dates', cancel: 'Cancel', save: 'Save', base: { startTime: '', dueDate: '2030-05-10' } });
        expect(sheet.fields.map((f) => f.label)).toEqual(['Start Date', 'Due Date']);
        expect(sheet.fields[0]).toMatchObject({ value: 'Not set', pickerStart: dayOf(new Date()) });
        expect(sheet.fields[1].pickerStart).toBe('2030-05-10');
        expect(sheet.fields[0].quickDates.map((q) => q.label)).toContain('Tomorrow');
        expect(sheet.issue).toBe('');
        const later = value(host.getTaskDatesSheet({ taskId: 'a', base: sheet.base, draft: sheet.base, pick: { field: 'startTime', day: '2030-06-01' } })).sheet;
        expect(later.draft).toEqual({ startTime: '2030-06-01', dueDate: '2030-05-10' });
        expect(later.base).toEqual(sheet.base);
        expect(later.issue).toBe('Starts after due date');
        expect(stored('a').startTime).toBeUndefined();
    });

    it('Save sends the editor\'s patch: a start date on an Inbox task makes it Next, and a sync rename is kept', async () => {
        const host = await openHost({ tasks: [task('a', 'inbox')] });
        const { sheet } = value(host.getTaskDatesSheet({ taskId: 'a' }));
        const tomorrow = sheet.fields[0].quickDates.find((q) => q.label === 'Tomorrow')!.value;
        await useTaskStore.getState().updateTask('a', { title: 'Renamed elsewhere' });
        expect(value(await host.saveTaskDates({ requestId: generateUUID(), taskId: 'a', base: sheet.base, draft: { startTime: tomorrow, dueDate: '' } })))
            .toEqual({ id: 'a', changed: true });
        expect(stored('a')).toMatchObject({ title: 'Renamed elsewhere', startTime: tomorrow, status: 'next' });
    });

    it('Save with no change writes nothing; dates changed since the sheet opened are refused', async () => {
        const host = await openHost({ tasks: [task('a', 'next', { dueDate: '2030-05-10' })] });
        const { sheet } = value(host.getTaskDatesSheet({ taskId: 'a' }));
        const before = taskRevisionOf(stored('a'));
        expect(value(await host.saveTaskDates({ requestId: generateUUID(), taskId: 'a', base: sheet.base, draft: sheet.base })))
            .toEqual({ id: 'a', changed: false });
        expect(taskRevisionOf(stored('a'))).toBe(before);
        await useTaskStore.getState().updateTask('a', { dueDate: '2030-07-01' });
        const stale = await host.saveTaskDates({ requestId: generateUUID(), taskId: 'a', base: sheet.base, draft: { startTime: '', dueDate: '' } });
        expect(stale.ok ? '' : stale.error.code).toBe('STALE_REVISION');
        expect(stored('a').dueDate).toBe('2030-07-01');
    });

    it('No date clears a due date', async () => {
        const host = await openHost({ tasks: [task('a', 'next', { dueDate: '2030-05-10' })] });
        const { sheet } = value(host.getTaskDatesSheet({ taskId: 'a' }));
        const noDate = sheet.fields[1].quickDates.at(-1)!;
        expect(noDate).toMatchObject({ label: 'No date', value: '' });
        value(await host.saveTaskDates({ requestId: generateUUID(), taskId: 'a', base: sheet.base, draft: { startTime: '', dueDate: noDate.value } }));
        expect(stored('a').dueDate).toBeUndefined();
    });
});
