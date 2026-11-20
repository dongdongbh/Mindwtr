import { strToU8 } from 'fflate';
import { safeParseDate } from './date';
import { isRecord } from './entity-sync-schema';

export const SIRI_REMINDER_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const DUE_DATE = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

export type SiriReminderItem = { id: string; title: string; token: string; dueDate?: string };
export type SiriReminderReceipt = { id: string; fingerprint: string; task: SiriReminderItem };

export const isSiriReminderTitle = (title: unknown): title is string =>
    typeof title === 'string' && title.length <= 2000 && !!title.trim() && strToU8(title).length <= 2000;

export const isSiriReminderToken = (token: unknown): token is string =>
    typeof token === 'string' && token.length > 0 && token.length <= 4096 && strToU8(token).length <= 4096;

export const isSiriReminderDueDate = (value: unknown): value is string =>
    typeof value === 'string' && DUE_DATE.test(value) && safeParseDate(value) !== null;

export function readSiriReminderReceipt(id: string, fingerprint: string, rawTask: string): SiriReminderReceipt {
    if (!SIRI_REMINDER_ID.test(id) || id !== id.toLowerCase() || !/^[\da-f]{64}$/.test(fingerprint) || rawTask.length > 40_000) {
        throw new Error('Invalid Siri reminder receipt');
    }
    const task: unknown = JSON.parse(rawTask);
    if (!isRecord(task) || typeof task.id !== 'string' || !SIRI_REMINDER_ID.test(task.id) || !isSiriReminderTitle(task.title)
        || !isSiriReminderToken(task.token) || (task.dueDate !== undefined && !isSiriReminderDueDate(task.dueDate))) {
        throw new Error('Invalid Siri reminder receipt task');
    }
    return { id, fingerprint, task: { id: task.id, title: task.title, token: task.token,
        ...(task.dueDate === undefined ? {} : { dueDate: task.dueDate }) } };
}
