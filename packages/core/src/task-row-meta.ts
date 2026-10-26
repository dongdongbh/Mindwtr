import { getProjectAccentColor } from './task-accent-color';
import { DEFAULT_AREA_COLOR } from './color-constants';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { createDateFormatter, hasTimeComponent, safeParseDate, safeParseDueDate, type DateFormatter, type DateFormattingConfig } from './date';
import { tFallback, type TranslateFn } from './i18n';
import type { Language } from './i18n/i18n-types';
import { getInlineMarkdownPreview } from './markdown';
import type { ProjectSequenceTaskCue } from './project-utils';
import { formatRecurrenceLabel } from './recurrence';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import { isTaskActionable, isTaskCancelled, isTaskCompleted } from './task-status';
import { getChecklistProgress, getTaskAgeLabel, getTaskUrgency } from './task-utils';
import { resolveTaskTextDirection } from './text-direction';
import { formatTimeSpentLabel } from './time-spent';
import type { AppSettings, Area, Project, Section, Task, TaskPriority, TaskStatus } from './types';

/** The optional features a task row reads, resolved from settings. */
export type TaskRowFeatures = {
    priorities: boolean;
    timeEstimates: boolean;
    /** Time spent shows only while Pomodoro is on and linked to tasks. */
    timeSpent: boolean;
    taskAge: boolean;
    /** False while the editor layout hides Status: the row flags its status control hidden (#1405, as RN's and desktop's rows). */
    status?: boolean;
};

export function resolveTaskRowFeatures(
    settings: Pick<AppSettings, 'features' | 'gtd' | 'appearance'> | null | undefined,
): TaskRowFeatures {
    const flags = resolveFeatureFlags(settings);
    return {
        priorities: flags.priorities,
        timeEstimates: flags.timeEstimates,
        timeSpent: flags.pomodoro && settings?.gtd?.pomodoro?.linkTask === true,
        taskAge: settings?.appearance?.showTaskAge === true,
        status: !settings?.gtd?.taskEditor?.hidden?.includes('status'),
    };
}

/** Clients map these to theme colors: overdue = danger, dueSoon = warning, normal = secondary text. */
export type TaskRowDueTone = 'overdue' | 'dueSoon' | 'normal';

type TaskRowMetaPartBody =
    | { kind: 'project'; projectId: string; dotColor: string | null }
    | { kind: 'area'; dotColor: string | null }
    | { kind: 'projectDeadline' }
    | { kind: 'context' | 'tag'; overflowCount: number }
    | { kind: 'assignedTo' }
    | { kind: 'completed' | 'cancelled' }
    | { kind: 'due'; tone: TaskRowDueTone }
    | { kind: 'start' | 'dateIssue' | 'recurrence' | 'estimate' }
    | { kind: 'timeSpent' | 'attachments'; accessibilityLabel: string }
    | { kind: 'checklist'; completed: number; total: number };

/**
 * One item of the row's metadata line, in display order. `text` is the whole visible
 * label, except that context and tag show "+overflowCount" after it when above zero.
 * `detail` parts hide when the view hides details (mobile lists always do; Focus has a toggle).
 * A project or area with no color gets the grey default dot, as group headers and desktop rows do (#1422).
 */
export type TaskRowMetaPart = TaskRowMetaPartBody & { text: string; detail: boolean };
export type TaskRowMetaPartKind = TaskRowMetaPart['kind'];

export type TaskRowMeta = {
    parts: TaskRowMetaPart[];
    /** Detail: hidden with the detail parts. Null when the setting is off, or for Done and Reference. */
    ageLabel: string | null;
    /** Detail: the first markdown line of the description. */
    descriptionPreview: string | null;
    /** The priority strip; null when priorities are off or for Reference. */
    priority: TaskPriority | null;
    /** The status control's label; null for Reference, which has no status control. */
    statusLabel: string | null;
    /**
     * True while the editor layout hides Status: RN's and desktop's rows show no status control then (#1405). A separate flag, so
     * a host whose row actions live in its status menu (iOS native's row Done) keeps the label.
     */
    statusHidden: boolean;
    /** Whether the Focus star can show (the view decides whether it offers one). */
    canFocus: boolean;
    swipe: { target: TaskStatus; label: string; icon: 'restore' | 'done' | 'next' };
    textDirection: 'ltr' | 'rtl';
    accessibilityLabel: string;
};

/** The containers a row names. Resolve once per task and container change: it scans the lists. */
export type TaskRowLookup = {
    project?: Project;
    projectArea?: Area;
    taskArea?: Area;
    section?: Section;
};

export function resolveTaskRowLookup(
    task: Pick<Task, 'projectId' | 'areaId' | 'sectionId'>,
    projects: readonly Project[],
    areas: readonly Area[],
    sectionById?: ReadonlyMap<string, Section>,
): TaskRowLookup {
    const project = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
    return {
        project,
        projectArea: project?.areaId ? areas.find((area) => area.id === project.areaId) : undefined,
        taskArea: task.areaId ? areas.find((area) => area.id === task.areaId) : undefined,
        section: task.sectionId ? sectionById?.get(task.sectionId) : undefined,
    };
}

export type TaskRowMetaInput = {
    task: Task;
    lookup: TaskRowLookup;
    features: TaskRowFeatures;
    /** The app language; the age label reads it. */
    language: Language;
    /** Every date label is formatted with this, never with the globally configured formatting. */
    dateFormatting: DateFormattingConfig;
    t: TranslateFn;
    now?: Date;
    hideProjectMeta?: boolean;
    hideContexts?: boolean;
    hideChecklistProgress?: boolean;
    projectDeadlineLabel?: string;
    sequenceCue?: ProjectSequenceTaskCue;
    sequenceLabel?: string;
};

const DETAIL_PART_KINDS = new Set<TaskRowMetaPartKind>(['assignedTo', 'tag', 'recurrence', 'estimate', 'timeSpent', 'attachments']);

const formatScheduleDate = (
    formatDate: DateFormatter,
    value: string | undefined,
    parse: (value: string | undefined) => Date | null,
): string | null => {
    const date = parse(value);
    return date ? formatDate(date, hasTimeComponent(value) ? 'Pp' : 'P') : null;
};

const dueToneFor = (task: Task, now: Date): TaskRowDueTone => {
    const urgency = getTaskUrgency(task, now);
    if (urgency === 'overdue') return 'overdue';
    return urgency === 'urgent' || urgency === 'upcoming' ? 'dueSoon' : 'normal';
};

const swipeFor = (status: TaskStatus, t: TranslateFn): TaskRowMeta['swipe'] => {
    if (status === 'done') return { target: 'inbox', label: tFallback(t, 'archived.restoreToInbox', 'Restore'), icon: 'restore' };
    if (status === 'next' || status === 'waiting') return { target: 'done', label: tFallback(t, 'common.done', 'Done'), icon: 'done' };
    if (status === 'someday' || status === 'reference' || status === 'inbox') {
        return { target: 'next', label: tFallback(t, 'status.next', 'Next'), icon: 'next' };
    }
    return { target: 'done', label: tFallback(t, 'common.done', 'Done'), icon: 'done' };
};

/** The React Native task row's meta line and labels, as data. The output depends only on the input. */
export function buildTaskRowMeta(input: TaskRowMetaInput): TaskRowMeta {
    const { task, features, t } = input;
    const { project, projectArea, taskArea, section } = input.lookup;
    const now = input.now ?? new Date();
    const formatDate = createDateFormatter(input.dateFormatting);
    const isReference = task.status === 'reference';
    const area = taskArea ?? projectArea;
    const startLabel = formatScheduleDate(formatDate, task.startTime, safeParseDate);
    const dueLabel = formatScheduleDate(formatDate, task.dueDate, safeParseDueDate);
    const startText = startLabel ? `${tFallback(t, 'taskEdit.startDateLabel', 'Start')}: ${startLabel}` : null;
    const recurrenceLabel = formatRecurrenceLabel({
        recurrence: task.recurrence,
        t,
        formatDate: (value) => formatDate(value, 'P'),
    });
    const visibleAttachmentCount = (task.attachments ?? []).filter((attachment) => !attachment.deletedAt).length;

    const parts: TaskRowMetaPart[] = [];
    const add = (part: TaskRowMetaPartBody & { text: string }) => {
        parts.push({ ...part, detail: DETAIL_PART_KINDS.has(part.kind) && (part.kind !== 'assignedTo' || task.status !== 'waiting') } as TaskRowMetaPart);
    };

    if (!input.hideProjectMeta && project) {
        add({
            kind: 'project',
            text: section ? `${project.title} · ${section.title}` : project.title,
            projectId: project.id,
            dotColor: getProjectAccentColor(project, new Map(projectArea ? [[projectArea.id, projectArea]] : [])) ?? DEFAULT_AREA_COLOR,
        });
    }
    // A task filed straight under an area names the area; a project already
    // carries its area through the dot (#1246).
    if ((isReference || !project) && area) {
        add({ kind: 'area', text: area.name, dotColor: area.color || DEFAULT_AREA_COLOR });
    }
    if (!isReference && input.projectDeadlineLabel) {
        add({ kind: 'projectDeadline', text: input.projectDeadlineLabel });
    }
    if (!isReference && !input.hideContexts && task.contexts?.length) {
        add({ kind: 'context', text: task.contexts[0], overflowCount: task.contexts.length - 1 });
    }
    if ((isReference || task.status === 'waiting') && task.assignedTo?.trim()) {
        add({ kind: 'assignedTo', text: task.assignedTo.trim() });
    }
    if (task.tags?.length) {
        add({ kind: 'tag', text: task.tags[0], overflowCount: task.tags.length - 1 });
    }
    if (!isReference) {
        if (isTaskCancelled(task)) {
            if (task.cancelledAt) {
                add({
                    kind: 'cancelled',
                    text: `${tFallback(t, 'task.cancelled', 'Cancelled')}: ${formatDate(task.cancelledAt, 'Pp', task.cancelledAt)}`,
                });
            }
        } else if (isTaskCompleted(task)) {
            const completedAt = task.completedAt || task.updatedAt;
            if (completedAt) {
                add({
                    kind: 'completed',
                    text: `${tFallback(t, 'list.done', 'Completed')}: ${formatDate(completedAt, 'Pp', completedAt)}`,
                });
            }
        }
        if (dueLabel) add({ kind: 'due', text: dueLabel, tone: dueToneFor(task, now) });
        if (startText) add({ kind: 'start', text: startText });
        if (getTaskDateCoherenceIssues(task).some((issue) => issue.code === 'start_after_due')) {
            add({ kind: 'dateIssue', text: tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date') });
        }
        if (recurrenceLabel) add({ kind: 'recurrence', text: recurrenceLabel });
        if (features.timeEstimates && task.timeEstimate) {
            add({ kind: 'estimate', text: formatTimeEstimateLabel(task.timeEstimate) });
        }
        const timeSpentLabel = features.timeSpent ? formatTimeSpentLabel(task.timeSpentMinutes) : null;
        if (timeSpentLabel) {
            add({
                kind: 'timeSpent',
                text: timeSpentLabel,
                accessibilityLabel: `${tFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent')}: ${timeSpentLabel}`,
            });
        }
        const checklistProgress = input.hideChecklistProgress ? null : getChecklistProgress(task);
        if (checklistProgress) {
            add({
                kind: 'checklist',
                text: `${checklistProgress.completed}/${checklistProgress.total}`,
                completed: checklistProgress.completed,
                total: checklistProgress.total,
            });
        }
    } else if (visibleAttachmentCount > 0) {
        add({
            kind: 'attachments',
            text: String(visibleAttachmentCount),
            accessibilityLabel: `${tFallback(t, 'attachments.title', 'Attachments')}: ${visibleAttachmentCount}`,
        });
    }

    const ageLabel = features.taskAge && task.status !== 'done' && !isReference
        ? getTaskAgeLabel(task.createdAt, input.language, now)
        : null;

    return {
        parts,
        ageLabel,
        descriptionPreview: getInlineMarkdownPreview(task.description ?? '') || null,
        priority: !isReference && features.priorities ? task.priority ?? null : null,
        statusLabel: isReference ? null : t(`status.${task.status}`),
        statusHidden: features.status === false,
        canFocus: isTaskActionable(task),
        swipe: swipeFor(task.status, t),
        textDirection: resolveTaskTextDirection(task),
        accessibilityLabel: isReference
            ? referenceAccessibilityLabel(input, visibleAttachmentCount)
            : [
                task.title,
                `${tFallback(t, 'taskEdit.statusLabel', 'Status')}: ${t(`status.${task.status}`)}`,
                startText,
                dueLabel ? `${tFallback(t, 'taskEdit.dueDateLabel', 'Due')}: ${dueLabel}` : null,
                // The strip is the only priority signal on a row, so the level
                // has to reach screen readers as text, not color alone.
                features.priorities && task.priority
                    ? `${tFallback(t, 'taskEdit.priorityLabel', 'Priority')}: ${t(`priority.${task.priority}`)}`
                    : null,
                input.sequenceCue === 'available' ? input.sequenceLabel : null,
                input.projectDeadlineLabel,
                recurrenceLabel ? `${tFallback(t, 'taskEdit.recurrenceLabel', 'Recurrence')}: ${recurrenceLabel}` : null,
            ].filter(Boolean).join('. '),
    };
}

function referenceAccessibilityLabel({ task, lookup, t }: TaskRowMetaInput, visibleAttachmentCount: number): string {
    const { project } = lookup;
    // A task's own area id wins even when that area is missing; only then the project's.
    const area = task.areaId ? lookup.taskArea : lookup.projectArea;
    return [
        task.title,
        project ? `${tFallback(t, 'taskEdit.projectLabel', 'Project')}: ${project.title}` : null,
        area ? `${tFallback(t, 'taskEdit.areaLabel', 'Area')}: ${area.name}` : null,
        task.assignedTo ? `${tFallback(t, 'taskEdit.assignedTo', 'Assigned To')}: ${task.assignedTo}` : null,
        ...(task.tags ?? []),
        visibleAttachmentCount > 0 ? `${tFallback(t, 'attachments.title', 'Attachments')}: ${visibleAttachmentCount}` : null,
    ].filter(Boolean).join('. ');
}
