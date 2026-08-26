import { normalizeBulkTaskTokenInput } from './bulk-task-tokens';
import {
    hasTimeComponent,
    safeFormatDate,
    safeParseDate,
} from './date';
import {
    getRecurrenceCompletedOccurrencesValue,
    getRecurrenceRRuleValue,
    parseRRuleString,
} from './recurrence';
import type {
    Attachment,
    Recurrence,
    RecurrenceRule,
    RecurrenceStrategy,
    Task,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';

/**
 * The task editor draft as one module: a single field-descriptor table drives
 * initialization, reset, the dirty check, and the update patch. Adding an
 * editor field means adding one descriptor here (plus its UI), instead of
 * hand-syncing six parallel per-field lists across four files.
 *
 * Interface: createTaskDraft · setTaskDraftField · isTaskDraftDirty ·
 * areDraftAttachmentsDirty · taskDraftToUpdatePatch. Everything else is
 * implementation.
 */
export type TaskDraft = {
    title: string;
    dueDate: string;
    startTime: string;
    relativeStartOffset: Task['relativeStartOffset'];
    projectId: string;
    sectionId: string;
    areaId: string;
    completedAt: string;
    status: TaskStatus;
    focusedToday: boolean;
    contexts: string;
    tags: string;
    description: string;
    location: string;
    recurrence: RecurrenceRule | '';
    recurrenceStrategy: RecurrenceStrategy;
    recurrenceRRule: string;
    showFutureRecurrence: boolean;
    timeEstimate: TimeEstimate | '';
    timeSpentMinutes: number | undefined;
    priority: TaskPriority | '';
    energyLevel: TaskEnergyLevel | '';
    assignedTo: string;
    reviewAt: string;
    repeatReminderMinutes: number | undefined;
    suppressMindwtrReminders: boolean;
};

export type TaskDraftField = keyof TaskDraft;

/** The one write path surfaces get: bind this to setTaskDraftField. */
export type TaskDraftSetter = <K extends TaskDraftField>(field: K, value: TaskDraft[K]) => void;

type FieldSpec<K extends TaskDraftField> = {
    fromTask: (task: Task) => TaskDraft[K];
    /** Custom dirty comparison; defaults to `draftValue !== fromTask(task)`. */
    isDirty?: (draftValue: TaskDraft[K], task: Task) => boolean;
    /** Cascade applied after this field changes; returns the adjusted draft. */
    onSet?: (draft: TaskDraft) => TaskDraft;
};

const trimmedDiffers = (draftValue: string, taskValue: string) => draftValue.trim() !== taskValue.trim();

// Convert stored ISO or datetime-local strings into datetime-local input values.
export function toTaskDraftDateTimeLocalValue(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const parsed = safeParseDate(dateStr);
    if (!parsed) return dateStr;
    if (!hasTimeComponent(dateStr)) {
        return safeFormatDate(parsed, 'yyyy-MM-dd', dateStr);
    }
    return safeFormatDate(parsed, "yyyy-MM-dd'T'HH:mm", dateStr);
}

export function getTaskDraftRecurrenceRuleValue(recurrence: Task['recurrence']): RecurrenceRule | '' {
    if (!recurrence) return '';
    if (typeof recurrence === 'string') return recurrence as RecurrenceRule;
    return recurrence.rule || '';
}

export function getTaskDraftRecurrenceStrategyValue(recurrence: Task['recurrence']): RecurrenceStrategy {
    if (recurrence && typeof recurrence === 'object' && recurrence.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
}

export const getTaskDraftRecurrenceRRuleValue = getRecurrenceRRuleValue;

const TASK_DRAFT_FIELDS: { [K in TaskDraftField]: FieldSpec<K> } = {
    title: { fromTask: (task) => task.title },
    dueDate: { fromTask: (task) => toTaskDraftDateTimeLocalValue(task.dueDate) },
    startTime: { fromTask: (task) => toTaskDraftDateTimeLocalValue(task.startTime) },
    relativeStartOffset: {
        fromTask: (task) => task.relativeStartOffset,
        isDirty: (value, task) =>
            JSON.stringify(value ?? null) !== JSON.stringify(task.relativeStartOffset ?? null),
    },
    projectId: { fromTask: (task) => task.projectId || '' },
    sectionId: { fromTask: (task) => task.sectionId || '' },
    areaId: { fromTask: (task) => task.areaId || '' },
    completedAt: {
        fromTask: (task) => task.completedAt || '',
        onSet: (draft) => draft.status === 'done' || !draft.completedAt
            ? draft
            : { ...draft, completedAt: '' },
    },
    status: {
        fromTask: (task) => task.status,
        // Moving a draft to Inbox drops its star; leaving Done drops its
        // completion timestamp. The reverse star→Next transition belongs to
        // focusedToday below, so direction is explicit at the write seam.
        onSet: (draft) => {
            const focusedToday = draft.status === 'inbox' ? false : draft.focusedToday;
            const completedAt = draft.status === 'done' ? draft.completedAt : '';
            return focusedToday === draft.focusedToday && completedAt === draft.completedAt
                ? draft
                : { ...draft, focusedToday, completedAt };
        },
    },
    focusedToday: {
        fromTask: (task) => task.isFocusedToday === true,
        // Starring is a clarifying action: an Inbox draft becomes Next.
        onSet: (draft) => draft.focusedToday && draft.status === 'inbox'
            ? { ...draft, status: 'next' }
            : draft,
    },
    contexts: {
        fromTask: (task) => task.contexts?.join(', ') || '',
        isDirty: (value, task) => trimmedDiffers(value, task.contexts?.join(', ') || ''),
    },
    tags: {
        fromTask: (task) => task.tags?.join(', ') || '',
        isDirty: (value, task) => trimmedDiffers(value, task.tags?.join(', ') || ''),
    },
    description: { fromTask: (task) => task.description || '' },
    location: { fromTask: (task) => task.location || '' },
    recurrence: { fromTask: (task) => getTaskDraftRecurrenceRuleValue(task.recurrence) },
    recurrenceStrategy: { fromTask: (task) => getTaskDraftRecurrenceStrategyValue(task.recurrence) },
    recurrenceRRule: { fromTask: (task) => getTaskDraftRecurrenceRRuleValue(task.recurrence) },
    showFutureRecurrence: { fromTask: (task) => Boolean(task.showFutureRecurrence) },
    timeEstimate: { fromTask: (task) => task.timeEstimate || '' },
    timeSpentMinutes: {
        fromTask: (task) => task.timeSpentMinutes,
        isDirty: (value, task) => (value ?? undefined) !== (task.timeSpentMinutes ?? undefined),
    },
    priority: { fromTask: (task) => task.priority || '' },
    energyLevel: { fromTask: (task) => task.energyLevel || '' },
    assignedTo: { fromTask: (task) => task.assignedTo || '' },
    reviewAt: { fromTask: (task) => toTaskDraftDateTimeLocalValue(task.reviewAt) },
    repeatReminderMinutes: {
        fromTask: (task) => task.repeatReminderMinutes,
        isDirty: (value, task) => (value ?? undefined) !== (task.repeatReminderMinutes ?? undefined),
    },
    suppressMindwtrReminders: {
        fromTask: (task) => task.suppressMindwtrReminders === true,
        isDirty: (value, task) => value !== (task.suppressMindwtrReminders === true),
    },
};

export const TASK_DRAFT_FIELD_KEYS = Object.keys(TASK_DRAFT_FIELDS) as TaskDraftField[];

export function createTaskDraft(task: Task): TaskDraft {
    const draft = {} as TaskDraft;
    for (const key of TASK_DRAFT_FIELD_KEYS) {
        (draft as Record<TaskDraftField, unknown>)[key] = TASK_DRAFT_FIELDS[key].fromTask(task);
    }
    return draft;
}

/**
 * The one write path into a draft: returns the same reference when the value
 * is unchanged, otherwise a new draft with the field set and any descriptor
 * cascade applied.
 */
export function setTaskDraftField<K extends TaskDraftField>(
    draft: TaskDraft,
    field: K,
    value: TaskDraft[K],
): TaskDraft {
    if (draft[field] === value) return draft;
    const next = { ...draft, [field]: value };
    const spec = TASK_DRAFT_FIELDS[field] as FieldSpec<K>;
    return spec.onSet ? spec.onSet(next) : next;
}

export function isTaskDraftDirty(draft: TaskDraft, task: Task): boolean {
    return TASK_DRAFT_FIELD_KEYS.some((key) => {
        const spec = TASK_DRAFT_FIELDS[key] as FieldSpec<TaskDraftField>;
        if (spec.isDirty) return spec.isDirty(draft[key], task);
        return draft[key] !== spec.fromTask(task);
    });
}

const attachmentFingerprint = (attachments: Attachment[] | undefined) =>
    (attachments ?? [])
        .map((attachment) => (
            `${attachment.id}\0${attachment.uri ?? ''}\0${attachment.title ?? ''}\0${attachment.deletedAt ?? ''}`
        ))
        .join('\n');

/** Attachments are draft-buffered outside the field table (their records are
 *  edited via useTaskItemAttachments); they still count as pending edits. */
export function areDraftAttachmentsDirty(editAttachments: Attachment[] | undefined, task: Task): boolean {
    return attachmentFingerprint(editAttachments) !== attachmentFingerprint(task.attachments);
}

type TaskDraftPatchOptions = {
    statusOverride?: TaskStatus;
    attachments?: Attachment[];
};

/**
 * Serialize the draft into the `updateTask` patch. Returns null when there is
 * no usable title (empty draft title on a task that never had one).
 */
export function taskDraftToUpdatePatch(
    draft: TaskDraft,
    task: Task,
    options: TaskDraftPatchOptions = {},
): Partial<Task> | null {
    const cleanedTitle = draft.title.trim() ? draft.title.trim() : task.title;
    if (!cleanedTitle.trim()) return null;

    const resolvedProjectId = draft.projectId || undefined;
    const recurrenceValue: Recurrence | undefined = draft.recurrence
        ? { rule: draft.recurrence, strategy: draft.recurrenceStrategy }
        : undefined;
    if (recurrenceValue && draft.recurrenceRRule) {
        const parsed = parseRRuleString(draft.recurrenceRRule);
        if (parsed.byDay && parsed.byDay.length > 0) {
            recurrenceValue.byDay = parsed.byDay;
        }
        if (parsed.byMonthDay && parsed.byMonthDay.length > 0) {
            recurrenceValue.byMonthDay = parsed.byMonthDay;
        }
        if (parsed.count) {
            recurrenceValue.count = parsed.count;
        }
        if (parsed.until) {
            recurrenceValue.until = parsed.until;
        }
        const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence);
        if (typeof completedOccurrences === 'number') {
            recurrenceValue.completedOccurrences = completedOccurrences;
        }
        recurrenceValue.rrule = draft.recurrenceRRule;
    }
    // Contexts/tags are the shared draft-save path for both apps; normalizing
    // the @/# prefix here (rather than trusting typed text) is the invariant
    // desktop's typed-input path was missing — see #1013.
    const splitTokens = (value: string, field: 'contexts' | 'tags') =>
        value.split(',').map((token) => normalizeBulkTaskTokenInput(token, field)).filter(Boolean);

    // Attachment removal soft-deletes records, so a legitimate buffer is never
    // shorter than the stored list. An empty/absent buffer means the caller has
    // nothing to say about attachments — omit the key entirely; an explicit
    // `attachments: undefined` would spread-wipe stored records and tombstones.
    const attachmentsPatch = (options.attachments?.length ?? 0) > 0
        ? { attachments: options.attachments }
        : {};

    return {
        title: cleanedTitle,
        status: options.statusOverride ?? draft.status,
        completedAt: draft.status === 'done' ? (draft.completedAt || undefined) : undefined,
        isFocusedToday: draft.focusedToday,
        dueDate: draft.dueDate || undefined,
        startTime: draft.startTime || undefined,
        relativeStartOffset: draft.relativeStartOffset,
        projectId: resolvedProjectId,
        // Container exclusivity: a project home clears the direct area, and a
        // section is only valid inside its project.
        sectionId: resolvedProjectId ? (draft.sectionId || undefined) : undefined,
        areaId: resolvedProjectId ? undefined : (draft.areaId || undefined),
        contexts: splitTokens(draft.contexts, 'contexts'),
        tags: splitTokens(draft.tags, 'tags'),
        description: draft.description || undefined,
        location: draft.location.trim() || undefined,
        recurrence: recurrenceValue,
        showFutureRecurrence: recurrenceValue && draft.showFutureRecurrence ? true : undefined,
        timeEstimate: draft.timeEstimate || undefined,
        timeSpentMinutes: draft.timeSpentMinutes || undefined,
        priority: draft.priority || undefined,
        energyLevel: draft.energyLevel || undefined,
        assignedTo: draft.assignedTo.trim() || undefined,
        reviewAt: draft.reviewAt || undefined,
        repeatReminderMinutes: draft.repeatReminderMinutes || undefined,
        suppressMindwtrReminders: draft.suppressMindwtrReminders ? true : undefined,
        ...attachmentsPatch,
    };
}
