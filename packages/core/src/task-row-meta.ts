import { getProjectAccentColor } from './task-accent-color';
import { DEFAULT_AREA_COLOR, einkSafeColor } from './color-constants';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { createDateFormatter, hasTimeComponent, safeParseDate, safeParseDueDate, type DateFormatter, type DateFormattingConfig } from './date';
import { tFallback, type TranslateFn } from './i18n';
import type { Language } from './i18n/i18n-types';
import { getInlineMarkdownPreview } from './markdown';
import type { ProjectSequenceTaskCue } from './project-utils';
import { formatRecurrenceLabel } from './recurrence';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import { formatTaskScheduleDisplay } from './task-schedule-display';
import { isTaskActionable, isTaskCancelled, isTaskCompleted } from './task-status';
import { getChecklistProgress, getTaskAgeLabel, getTaskUrgency } from './task-utils';
import { resolveTaskTextDirection } from './text-direction';
import { formatTimeSpentLabel } from './time-spent';
import type { AppSettings, Area, Project, Section, Task, TaskPriority, TaskStatus } from './types';


export type TaskRowFeatures = {
    priorities: boolean;
    timeEstimates: boolean;

    timeSpent: boolean;
    taskAge: boolean;

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


export type TaskRowDueTone = 'overdue' | 'dueSoon' | 'normal';

type TaskRowMetaPartBody =
    | { kind: 'project'; projectId: string; dotColor: string | null }
    | { kind: 'area'; dotColor: string | null }
    | { kind: 'projectDeadline' }
    | { kind: 'context' | 'tag'; overflowCount: number }
    | { kind: 'assignedTo' }
    | { kind: 'completed' | 'cancelled' }
    | { kind: 'due'; tone: TaskRowDueTone; accessibilityLabel?: string }
    | { kind: 'start'; accessibilityLabel?: string }
    | { kind: 'dateIssue' | 'recurrence' | 'estimate' }
    | { kind: 'timeSpent' | 'attachments'; accessibilityLabel: string }
    | { kind: 'checklist'; completed: number; total: number };


export type TaskRowMetaPart = TaskRowMetaPartBody & { text: string; detail: boolean };
export type TaskRowMetaPartKind = TaskRowMetaPart['kind'];

export type TaskRowMeta = {
    parts: TaskRowMetaPart[];
    relativeScheduleDates?: boolean;

    ageLabel: string | null;

    descriptionPreview: string | null;

    priority: TaskPriority | null;

    statusLabel: string | null;


    statusHidden: boolean;

    canFocus: boolean;

    swipe: { target: TaskStatus; label: string; icon: 'restore' | 'done' | 'next' };
    textDirection: 'ltr' | 'rtl';
    accessibilityLabel: string;
};


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

    language: Language;

    dateFormatting: DateFormattingConfig;
    t: TranslateFn;
    now?: Date;
    hideProjectMeta?: boolean;
    hideContexts?: boolean;
    hideChecklistProgress?: boolean;
    projectDeadlineLabel?: string;
    sequenceCue?: ProjectSequenceTaskCue;
    sequenceLabel?: string;
    relativeScheduleDates?: boolean;
    themePreset?: string | null;
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;


export function getTaskRowMetaValidUntil(task: Task, now: Date, features: Pick<TaskRowFeatures, 'taskAge'>, options: Pick<TaskRowMetaInput, 'relativeScheduleDates'> = {}): number | null {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs) || task.status === 'reference') return null;
    let next = Infinity;
    const consider = (at: number) => { if (at > nowMs && at < next) next = at; };
    if (options.relativeScheduleDates && (safeParseDate(task.startTime) || safeParseDueDate(task.dueDate))) {
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        consider(midnight.getTime());
    }
    const due = isTaskActionable(task) ? safeParseDueDate(task.dueDate)?.getTime() : undefined;

    if (due !== undefined) for (const before of [72 * HOUR_MS, 0]) consider(due - before + 1);
    const created = Date.parse(task.createdAt);
    if (features.taskAge && task.status !== 'done' && Number.isFinite(created)) {

        const days = Math.floor((nowMs - created) / DAY_MS);
        const label = getTaskAgeLabel(task.createdAt, 'en', now);
        for (let day = Math.max(days + 1, 1); day <= days + 31; day += 1) {
            if (getTaskAgeLabel(task.createdAt, 'en', new Date(created + day * DAY_MS)) !== label) { consider(created + day * DAY_MS); break; }
        }
    }
    return Number.isFinite(next) ? next : null;
}


export function buildTaskRowMeta(input: TaskRowMetaInput): TaskRowMeta {
    const { task, features, t } = input;
    const { project, projectArea, taskArea, section } = input.lookup;
    const now = input.now ?? new Date();
    const formatDate = createDateFormatter(input.dateFormatting);
    const isReference = task.status === 'reference';
    const area = taskArea ?? projectArea;
    const startDisplay = input.relativeScheduleDates ? formatTaskScheduleDisplay({ value: task.startTime, kind: 'start',
        relative: true, now, dateFormatting: input.dateFormatting, t }) : null;
    const dueDisplay = input.relativeScheduleDates ? formatTaskScheduleDisplay({ value: task.dueDate, kind: 'due',
        relative: true, now, dateFormatting: input.dateFormatting, t }) : null;
    const startLabel = input.relativeScheduleDates ? startDisplay?.label : formatScheduleDate(formatDate, task.startTime, safeParseDate);
    const dueLabel = input.relativeScheduleDates ? dueDisplay?.label : formatScheduleDate(formatDate, task.dueDate, safeParseDueDate);
    const startText = startLabel ? `${tFallback(t, 'taskEdit.startDateLabel', 'Start')}: ${startLabel}` : null;
    const exactStartText = startDisplay ? `${tFallback(t, 'taskEdit.startDateLabel', 'Start')}: ${startDisplay.exactLabel}` : null;
    const exactDueText = dueDisplay ? `${tFallback(t, 'taskEdit.dueDateLabel', 'Due')}: ${dueDisplay.exactLabel}` : null;
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
            dotColor: einkSafeColor(getProjectAccentColor(project, new Map(projectArea ? [[projectArea.id, projectArea]] : []), input.themePreset) ?? DEFAULT_AREA_COLOR, input.themePreset),
        });
    }


    if ((isReference || !project) && area) {
        add({ kind: 'area', text: area.name, dotColor: einkSafeColor(area.color || DEFAULT_AREA_COLOR, input.themePreset) });
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
        if (dueLabel) add({ kind: 'due', text: dueLabel, tone: dueToneFor(task, now), ...(exactDueText ? { accessibilityLabel: exactDueText } : {}) });
        if (startText) add({ kind: 'start', text: startText, ...(exactStartText ? { accessibilityLabel: exactStartText } : {}) });
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
        ...(input.relativeScheduleDates ? { relativeScheduleDates: true } : {}),
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
                exactStartText ?? startText,
                exactDueText ?? (dueLabel ? `${tFallback(t, 'taskEdit.dueDateLabel', 'Due')}: ${dueLabel}` : null),


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
