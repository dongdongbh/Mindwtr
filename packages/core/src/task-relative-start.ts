import { hasTimeComponent, safeParseDate } from './date';
import type { RelativeStartOffset, RelativeStartOffsetUnit, Task } from './types';

const RELATIVE_START_OFFSET_UNITS = new Set<RelativeStartOffsetUnit>(['minute', 'hour', 'day', 'week']);
const RELATIVE_START_OFFSET_MIN_AMOUNT = -10_000;

const RELATIVE_START_OFFSET_MAX_AMOUNT = 0;

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatLocalDate = (date: Date): string => (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
);

const formatLocalDateTime = (date: Date): string => (
    `${formatLocalDate(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
);

const hasTimezoneComponent = (value: string): boolean => /Z$|[+-]\d{2}:?\d{2}$/.test(value);

const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);

const isSubDayOffset = (offset: RelativeStartOffset): boolean => offset.unit === 'minute' || offset.unit === 'hour';

export const normalizeRelativeStartOffset = (value: unknown): RelativeStartOffset | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const unit = record.unit;
    const amount = record.amount;
    if (typeof unit !== 'string' || !RELATIVE_START_OFFSET_UNITS.has(unit as RelativeStartOffsetUnit)) return undefined;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount)) return undefined;
    if (amount < RELATIVE_START_OFFSET_MIN_AMOUNT || amount > RELATIVE_START_OFFSET_MAX_AMOUNT) return undefined;
    return { amount: amount === 0 ? 0 : amount, unit: unit as RelativeStartOffsetUnit };
};

const addOffset = (date: Date, offset: RelativeStartOffset): Date => {
    const next = new Date(date);
    switch (offset.unit) {
        case 'minute':
            next.setMinutes(next.getMinutes() + offset.amount);
            return next;
        case 'hour':
            next.setHours(next.getHours() + offset.amount);
            return next;
        case 'day':
            next.setDate(next.getDate() + offset.amount);
            return next;
        case 'week':
            next.setDate(next.getDate() + offset.amount * 7);
            return next;
    }
};

export const computeRelativeStartTime = (
    dueDate: string | undefined,
    offset: RelativeStartOffset | undefined,
): string | undefined => {
    if (!dueDate || !offset) return undefined;
    const due = safeParseDate(dueDate);
    if (!due) return undefined;
    if (!hasTimeComponent(dueDate) && isSubDayOffset(offset)) return undefined;
    const computed = addOffset(due, offset);
    if (hasTimezoneComponent(dueDate)) return computed.toISOString();
    if (!hasTimeComponent(dueDate) && (offset.unit === 'day' || offset.unit === 'week')) {
        return formatLocalDate(computed);
    }
    return formatLocalDateTime(computed);
};

export const resolveRelativeStartUpdates = (
    oldTask: Pick<Task, 'dueDate' | 'startTime' | 'relativeStartOffset'>,
    updates: Partial<Task>,
): Partial<Task> => {
    const hasDueDateUpdate = hasOwnField(updates, 'dueDate');
    const hasStartTimeUpdate = hasOwnField(updates, 'startTime');
    const hasOffsetUpdate = hasOwnField(updates, 'relativeStartOffset');
    if (!hasDueDateUpdate && !hasStartTimeUpdate && !hasOffsetUpdate) return updates;

    let nextUpdates = updates;
    const nextDueDate = hasDueDateUpdate ? updates.dueDate : oldTask.dueDate;
    const meaningfulStartEdit = hasStartTimeUpdate
        && (updates.startTime ?? undefined) !== (oldTask.startTime ?? undefined);

    if (hasOffsetUpdate) {
        const offset = normalizeRelativeStartOffset(updates.relativeStartOffset);
        nextUpdates = { ...nextUpdates, relativeStartOffset: offset };
        if (!offset || !nextDueDate) {
            return { ...nextUpdates, relativeStartOffset: undefined };
        }
        const startTime = computeRelativeStartTime(nextDueDate, offset);
        return startTime ? { ...nextUpdates, startTime } : { ...nextUpdates, relativeStartOffset: undefined };
    }

    if (meaningfulStartEdit) {
        return { ...nextUpdates, relativeStartOffset: undefined };
    }

    const existingOffset = normalizeRelativeStartOffset(oldTask.relativeStartOffset);
    if (hasDueDateUpdate && existingOffset) {
        if (!nextDueDate) {
            return { ...nextUpdates, relativeStartOffset: undefined };
        }
        const startTime = computeRelativeStartTime(nextDueDate, existingOffset);
        return startTime
            ? { ...nextUpdates, startTime, relativeStartOffset: existingOffset }
            : { ...nextUpdates, relativeStartOffset: undefined };
    }

    return nextUpdates;
};
