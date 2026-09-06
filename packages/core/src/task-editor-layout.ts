import type { TaskEditorFieldId, TaskEditorSectionId, TaskEditorSettings } from './types';

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

// Reconciles a saved field order against the current roster: unknown ids (a
// field removed since the order was saved) are dropped, a field added to the
// roster since is appended in roster order, and a field disabled by a
// feature flag (priorities/timeEstimates off) is removed entirely. Desktop
// and mobile computed this identically in their own memo bodies; this is the
// one home now.
export function normalizeTaskEditorOrder(
    savedOrder: TaskEditorFieldId[],
    disabledFields: ReadonlySet<TaskEditorFieldId>
): TaskEditorFieldId[] {
    const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
    const normalized = savedOrder.filter((id) => known.has(id));
    const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
    return [...normalized, ...missing].filter((id) => !disabledFields.has(id));
}
