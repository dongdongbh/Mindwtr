import { normalizeCancellationTimestamp } from './task-status';
import type { ProjectCalendarReference } from './types';

const boundedString = (value: unknown, maximum: number, nonempty = false): value is string =>
    typeof value === 'string' && value.length <= maximum && (!nonempty || value.trim().length > 0);

const timestamp = (value: unknown): value is string =>
    boundedString(value, 40) && normalizeCancellationTimestamp(value) !== undefined;

const civilDate = (value: unknown): value is string => boundedString(value, 10) && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && normalizeCancellationTimestamp(`${value}T00:00:00.000Z`) !== undefined;

export const isProjectCalendarReference = (value: unknown): value is ProjectCalendarReference => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return 'sourceId' in value && boundedString(value.sourceId, 2048, true)
        && 'uid' in value && boundedString(value.uid, 2048, true)
        && (!('recurrenceId' in value) || value.recurrenceId === undefined || boundedString(value.recurrenceId, 2048, true))
        && 'sourceName' in value && boundedString(value.sourceName, 1000)
        && 'title' in value && boundedString(value.title, 1000)
        && 'allDay' in value && typeof value.allDay === 'boolean'
        && 'start' in value && 'end' in value
        && (timestamp(value.start) && timestamp(value.end)
            || value.allDay && civilDate(value.start) && civilDate(value.end))
        && Date.parse(String(value.end)) >= Date.parse(String(value.start))
        && Object.keys(value).every((field) => ['sourceId', 'uid', 'recurrenceId', 'sourceName', 'title', 'start', 'end', 'allDay'].includes(field));
};

export const normalizeProjectCalendarReference = (value: unknown): ProjectCalendarReference | null | undefined => {
    if (value === null) return null;
    if (!isProjectCalendarReference(value)) return undefined;
    return {
        sourceId: value.sourceId, uid: value.uid,
        ...(value.recurrenceId === undefined ? {} : { recurrenceId: value.recurrenceId }),
        sourceName: value.sourceName, title: value.title, start: value.start, end: value.end, allDay: value.allDay,
    };
};
