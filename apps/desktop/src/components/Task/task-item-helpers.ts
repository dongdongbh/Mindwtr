import {
    Task,
    TaskEditorFieldId,
    type TaskPriority,
    type TaskEditorSectionId,
    type RecurrenceRule,
    type RecurrenceStrategy,
    getRecurrenceRRuleValue,
} from '@mindwtr/core';
import { joinDateTime, splitDateTime } from '@mindwtr/core/date-draft';

export { getRecurrenceRRuleValue };

// Leading-edge strip on a task row: a fixed "heat ramp", not theme tokens, so a
// priority reads the same in all eight themes — the same call project/area
// accent colors already make with arbitrary user hex.
export const TASK_PRIORITY_STRIP_COLORS: Record<TaskPriority, string> = {
    urgent: '#dc2626',
    high: '#f97316',
    medium: '#ca8a04',
    low: '#3b82f6',
};

// Attachments can be reassigned (Settings -> GTD -> Task Editor Layout) to any
// of the three collapsible sections. A dropped file needs to know which one
// to expand; null means attachments aren't in a collapsible section (basic,
// or hidden), so there's nothing to expand.
export function findAttachmentsSection(
    schedulingFields: TaskEditorFieldId[],
    organizationFields: TaskEditorFieldId[],
    detailsFields: TaskEditorFieldId[],
): Extract<TaskEditorSectionId, 'scheduling' | 'organization' | 'details'> | null {
    if (schedulingFields.includes('attachments')) return 'scheduling';
    if (organizationFields.includes('attachments')) return 'organization';
    if (detailsFields.includes('attachments')) return 'details';
    return null;
}

// Convert stored ISO or date-only strings into datetime-local input values.
// A date-only value never gains an implicit time here — see date-draft.ts.
export function toDateTimeLocalValue(dateStr: string | undefined): string {
    const { date, time } = splitDateTime(dateStr);
    return joinDateTime(date, time);
}

export function normalizeDateInputValue(value: string, now: Date = new Date()): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) return trimmed;

    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    const nowDay = now.getDate();

    let year = Number(match[1]);
    let month = Number(match[2]);
    let day = Number(match[3]);

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return trimmed;
    }

    if (year === 0) year = nowYear;
    if (month === 0) month = nowMonth;
    if (day === 0) day = nowDay;

    if (month < 1 || month > 12) return trimmed;

    const maxDay = new Date(year, month, 0).getDate();
    if (day < 1) day = 1;
    if (day > maxDay) day = maxDay;

    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getRecurrenceRuleValue(recurrence: Task['recurrence']): RecurrenceRule | '' {
    if (!recurrence) return '';
    if (typeof recurrence === 'string') return recurrence as RecurrenceRule;
    return recurrence.rule || '';
}

export function getRecurrenceStrategyValue(recurrence: Task['recurrence']): RecurrenceStrategy {
    if (recurrence && typeof recurrence === 'object' && recurrence.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
}
