import {
    Task,
    TaskEditorFieldId,
    type TaskEditorSettings,
    type TaskEditorSectionId,
    type RecurrenceRule,
    type RecurrenceStrategy,
    getRecurrenceRRuleValue,
} from '@mindwtr/core';
import { joinDateTime, splitDateTime } from '@mindwtr/core/date-draft';

export { getRecurrenceRRuleValue };

export const DEFAULT_TASK_EDITOR_ORDER: TaskEditorFieldId[] = [
    'status',
    'project',
    'area',
    'contexts',
    'dueDate',
    'section',
    // Dates group together in Scheduling; the recurrence editor follows them.
    'startTime',
    'reviewAt',
    'recurrence',
    'tags',
    'description',
    'attachments',
    'checklist',
    'priority',
    'energyLevel',
    'timeEstimate',
    'assignedTo',
    'location',
];

export const DEFAULT_TASK_EDITOR_VISIBLE: TaskEditorFieldId[] = [
    'status',
    'project',
    'area',
    'contexts',
    'dueDate',
    'recurrence',
    'startTime',
    'reviewAt',
    'tags',
    'description',
    'attachments',
    'checklist',
];

export const DEFAULT_TASK_EDITOR_HIDDEN: TaskEditorFieldId[] = DEFAULT_TASK_EDITOR_ORDER.filter(
    (fieldId) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(fieldId)
);

export const TASK_EDITOR_FIXED_FIELDS: TaskEditorFieldId[] = ['status', 'project', 'section', 'area'];

export const TASK_EDITOR_SECTION_ORDER: TaskEditorSectionId[] = ['basic', 'scheduling', 'organization', 'details'];

export const DEFAULT_TASK_EDITOR_SECTION_BY_FIELD: Record<TaskEditorFieldId, TaskEditorSectionId> = {
    status: 'basic',
    project: 'basic',
    section: 'basic',
    area: 'basic',
    priority: 'organization',
    energyLevel: 'organization',
    assignedTo: 'organization',
    contexts: 'basic',
    tags: 'organization',
    location: 'details',
    timeEstimate: 'organization',
    recurrence: 'scheduling',
    startTime: 'scheduling',
    dueDate: 'basic',
    reviewAt: 'scheduling',
    description: 'details',
    textDirection: 'details',
    attachments: 'details',
    checklist: 'details',
};

export const TASK_EDITOR_SECTIONABLE_FIELDS: TaskEditorFieldId[] = DEFAULT_TASK_EDITOR_ORDER.filter(
    (fieldId) => !TASK_EDITOR_FIXED_FIELDS.includes(fieldId) && fieldId !== 'textDirection'
);

export const DEFAULT_TASK_EDITOR_SECTION_OPEN: Record<TaskEditorSectionId, boolean> = {
    basic: true,
    scheduling: false,
    organization: false,
    details: false,
};

const isTaskEditorSectionId = (value: unknown): value is TaskEditorSectionId =>
    value === 'basic' || value === 'scheduling' || value === 'organization' || value === 'details';

export const isTaskEditorSectionableField = (fieldId: TaskEditorFieldId): boolean =>
    TASK_EDITOR_SECTIONABLE_FIELDS.includes(fieldId);

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

export const getTaskEditorSectionAssignments = (
    taskEditor: TaskEditorSettings | undefined
): Record<TaskEditorFieldId, TaskEditorSectionId> => {
    const savedSections = taskEditor?.sections ?? {};
    const next = { ...DEFAULT_TASK_EDITOR_SECTION_BY_FIELD };
    (Object.keys(savedSections) as TaskEditorFieldId[]).forEach((fieldId) => {
        const sectionId = savedSections[fieldId];
        if (!isTaskEditorSectionableField(fieldId) || !isTaskEditorSectionId(sectionId)) return;
        next[fieldId] = sectionId;
    });
    return next;
};

export const getTaskEditorSectionOpenDefaults = (
    taskEditor: TaskEditorSettings | undefined
): Record<TaskEditorSectionId, boolean> => {
    const savedSectionOpen = taskEditor?.sectionOpen ?? {};
    return {
        basic: DEFAULT_TASK_EDITOR_SECTION_OPEN.basic,
        scheduling: typeof savedSectionOpen.scheduling === 'boolean'
            ? savedSectionOpen.scheduling
            : DEFAULT_TASK_EDITOR_SECTION_OPEN.scheduling,
        organization: typeof savedSectionOpen.organization === 'boolean'
            ? savedSectionOpen.organization
            : DEFAULT_TASK_EDITOR_SECTION_OPEN.organization,
        details: typeof savedSectionOpen.details === 'boolean'
            ? savedSectionOpen.details
            : DEFAULT_TASK_EDITOR_SECTION_OPEN.details,
    };
};

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
