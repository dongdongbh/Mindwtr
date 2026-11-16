import { isRecord } from './entity-sync-schema';
import { TIME_SPENT_MAX_MINUTES } from './time-spent';
import type { AppData } from './types';

export type PomodoroCredit = { id: string; taskId: string; minutes: number };
type Receipts = NonNullable<AppData['settings']['pomodoroCredits']>;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const POMODORO_CREDIT_RECEIPT_LIMIT = 10_000;
const validTaskId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const validMinutes = (value: unknown): value is number => typeof value === 'number'
    && Number.isInteger(value) && value > 0 && value <= TIME_SPENT_MAX_MINUTES;

export const normalizePomodoroCreditId = (value: unknown): string => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid Pomodoro credit identity');
    return value.toLowerCase();
};

export const parsePomodoroCredit = (value: unknown): PomodoroCredit => {
    if (!isRecord(value) || Object.keys(value).length !== 3 || !validTaskId(value.taskId) || !validMinutes(value.minutes)) {
        throw new Error('Invalid Pomodoro credit');
    }
    return { id: normalizePomodoroCreditId(value.id), taskId: value.taskId, minutes: value.minutes };
};

export const readPomodoroCreditReceipts = (value: unknown): Receipts => {
    if (value === undefined) return {};
    if (!isRecord(value) || Object.keys(value).length > POMODORO_CREDIT_RECEIPT_LIMIT) throw new Error('Invalid Pomodoro credit receipts');
    const receipts: Receipts = {};
    for (const [id, receipt] of Object.entries(value)) {
        if (!UUID.test(id) || id !== id.toLowerCase() || !isRecord(receipt) || Object.keys(receipt).length !== 2
            || !validTaskId(receipt.taskId) || !validMinutes(receipt.minutes)) throw new Error('Invalid Pomodoro credit receipt');
        receipts[id] = { taskId: receipt.taskId, minutes: receipt.minutes };
    }
    return receipts;
};
