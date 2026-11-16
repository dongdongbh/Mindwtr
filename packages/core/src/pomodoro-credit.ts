import { runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { logInfo } from './logger';
import { flushPendingSave, getStorageAdapter, useTaskStore } from './store';
import { ensureDeviceId, getNextDataChangeAt, nextRevision } from './store-helpers';
import { runSyncStoreSave } from './store-write-gate';
import { applySyncedDataToStore } from './sync-client-helpers';
import { addTimeSpentMinutes } from './time-spent';
import type { AppData } from './types';
import { normalizePomodoroCreditId, parsePomodoroCredit, readPomodoroCreditReceipts, POMODORO_CREDIT_RECEIPT_LIMIT, type PomodoroCredit } from './pomodoro-credit-receipts';
export { readPomodoroCreditReceipts, POMODORO_CREDIT_RECEIPT_LIMIT, type PomodoroCredit } from './pomodoro-credit-receipts';

export type PomodoroCreditOutcome = 'applied' | 'already-applied' | 'missing-task';

const writeCreditDocument = <T>(change: (current: AppData) => { data: AppData; result: T; changedTask?: boolean }): Promise<T> => (
    runSerializedSyncDocumentWriteOperation(() => runSyncStoreSave(async () => {
        await flushPendingSave();
        if (useTaskStore.getState().persistenceFailure) throw new Error('The task store has an unsaved change');
        const storage = getStorageAdapter();
        if (!storage.saveDataIfUnchanged) throw new Error('Pomodoro credit storage is unavailable');
        let changedTask = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = await storage.getData();
            const planned = change(current);
            try {
                await storage.saveDataIfUnchanged(planned.data, current);
                changedTask ||= planned.changedTask === true;
                const canonical = planned.data === current ? current : await storage.getData();
                if (getStorageAdapter() !== storage) throw new Error('Pomodoro credit workspace changed');
                applySyncedDataToStore(canonical);
                if (changedTask) useTaskStore.setState((state) => ({ lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) }));
                return planned.result;
            } catch (error) {
                if (attempt === 2) throw error;
            }
        }
        throw new Error('Pomodoro credit could not be saved');
    }))
);

export const applyPomodoroCredit = async (input: PomodoroCredit): Promise<PomodoroCreditOutcome> => {
    const { id, taskId, minutes } = parsePomodoroCredit(input);
    const result = await writeCreditDocument<PomodoroCreditOutcome>((current) => {
        const receipts = readPomodoroCreditReceipts(current.settings.pomodoroCredits);
        const receipt = receipts[id];
        if (receipt) {
            if (receipt.taskId !== taskId || receipt.minutes !== minutes) throw new Error('Pomodoro credit identity changed');
            return { data: current, result: 'already-applied' };
        }
        const task = current.tasks.find((candidate) => candidate.id === taskId);
        if (!task || task.purgedAt) return { data: current, result: 'missing-task' };
        if (Object.keys(receipts).length >= POMODORO_CREDIT_RECEIPT_LIMIT) throw new Error('Pomodoro credit receipt capacity reached');
        const device = ensureDeviceId(current.settings);
        const timeSpentMinutes = addTimeSpentMinutes(task.timeSpentMinutes, minutes);
        const changedTask = timeSpentMinutes !== task.timeSpentMinutes;
        const updated = changedTask ? { ...task, timeSpentMinutes, rev: nextRevision(task.rev), revBy: device.deviceId, updatedAt: new Date().toISOString() } : task;
        return {
            data: { ...current, tasks: current.tasks.map((candidate) => candidate.id === taskId ? updated : candidate),
                settings: { ...device.settings, pomodoroCredits: { ...receipts, [id]: { taskId, minutes } } } },
            result: 'applied', changedTask,
        };
    });
    logInfo('Pomodoro work credit confirmed', { scope: 'pomodoro', category: 'storage', force: true,
        context: { releaseCheck: 'v1.3.9/pomodoro-partial-work', outcome: result } });
    return result;
};

export const acknowledgePomodoroCredits = async (ids: string[]): Promise<void> => {
    if (!Array.isArray(ids) || ids.length > POMODORO_CREDIT_RECEIPT_LIMIT) throw new Error('Invalid Pomodoro credit acknowledgment');
    const done = new Set(ids.map(normalizePomodoroCreditId));
    if (done.size === 0) return;
    await writeCreditDocument((current) => {
        const receipts = readPomodoroCreditReceipts(current.settings.pomodoroCredits);
        const left = Object.fromEntries(Object.entries(receipts).filter(([id]) => !done.has(id)));
        if (Object.keys(left).length === Object.keys(receipts).length) return { data: current, result: undefined };
        const settings = { ...current.settings };
        if (Object.keys(left).length > 0) settings.pomodoroCredits = left; else delete settings.pomodoroCredits;
        return { data: { ...current, settings }, result: undefined };
    });
};
