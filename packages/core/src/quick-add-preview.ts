import { hasTimeComponent, safeFormatDate, type DateFormatter } from './date';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { tFallback, type TranslateFn } from './i18n';
import type { QuickAddResult } from './quick-add';
import type { Area, Project } from './types';

export type QuickAddPreviewEntryKind =
    | 'warning'
    | 'title'
    | 'due'
    | 'start'
    | 'review'
    | 'project'
    | 'area'
    | 'status'
    | 'focus'
    | 'context'
    | 'tag'
    | 'person'
    | 'priority'
    | 'energy'
    | 'estimate'
    | 'note'
    | 'link';

export interface QuickAddPreviewEntry {

    id: string;
    kind: QuickAddPreviewEntryKind;

    label?: string;
    value: string;
    tone: 'default' | 'warning';
}


export interface QuickAddPreviewOverrides {
    projectId?: string;
    dueDate?: string;
    startTime?: string;
}

export interface QuickAddPreviewOptions {
    t: TranslateFn;
    projects?: readonly Project[];
    areas?: readonly Area[];

    rawInput?: string;

    overrides?: QuickAddPreviewOverrides;

    formatDate?: DateFormatter;
}

const VALUE_PREVIEW_LIMIT = 48;

function truncate(value: string, limit = VALUE_PREVIEW_LIMIT): string {
    const trimmed = value.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1).trimEnd()}…` : trimmed;
}


function formatPreviewDate(value: string, formatDate: DateFormatter = safeFormatDate): string {
    return formatDate(value, hasTimeComponent(value) ? 'Pp' : 'P', value);
}


export function buildQuickAddPreviewEntries(
    parsed: QuickAddResult,
    options: QuickAddPreviewOptions,
): QuickAddPreviewEntry[] {
    const { t, projects, areas, rawInput, overrides, formatDate } = options;
    const props = parsed.props;
    const entries: QuickAddPreviewEntry[] = [];

    for (const command of parsed.invalidDateCommands ?? []) {
        entries.push({
            id: `warning:${command}`,
            kind: 'warning',
            label: /^\/remind(?:-|:)/i.test(command)
                ? tFallback(t, 'quickAdd.invalidReminderCommand', 'Invalid reminder: use a supported duration and an explicit date and time')
                : tFallback(t, 'quickAdd.invalidDateCommand', 'Invalid date command'),
            value: command,
            tone: 'warning',
        });
    }


    const detectedDate = parsed.detectedDate;
    const appliesDetectedDate = Boolean(detectedDate?.date && !props.dueDate && !overrides?.dueDate);
    const dueValue = overrides?.dueDate
        ?? (appliesDetectedDate && detectedDate ? detectedDate.date : props.dueDate);
    const title = (appliesDetectedDate && detectedDate ? detectedDate.titleWithoutDate : parsed.title).trim();

    if (rawInput !== undefined && title && title !== rawInput.trim()) {
        entries.push({
            id: 'title',
            kind: 'title',
            label: tFallback(t, 'taskEdit.titleLabel', 'Title'),
            value: truncate(title),
            tone: 'default',
        });
    }

    if (dueValue) {
        entries.push({
            id: 'due',
            kind: 'due',
            label: tFallback(t, 'taskEdit.dueDateLabel', 'Due Date'),
            value: formatPreviewDate(dueValue, formatDate),
            tone: 'default',
        });
    }
    const startValue = overrides?.startTime ?? props.startTime;
    if (startValue) {
        entries.push({
            id: 'start',
            kind: 'start',
            label: tFallback(t, 'taskEdit.startDateLabel', 'Start Date'),
            value: formatPreviewDate(startValue, formatDate),
            tone: 'default',
        });
    }
    for (const [id, kind, minutes, label] of [
        ['due-reminder', 'due', props.dueReminderLeadMinutes, tFallback(t, 'taskEdit.advanceReminderLabel', 'Advance reminder')],
        ['start-reminder', 'start', props.startReminderLeadMinutes, tFallback(t, 'taskEdit.startAdvanceReminderLabel', 'Before start')],
    ] as const) {
        if (minutes === undefined) continue;
        entries.push({
            id, kind, label,
            value: minutes === 0 ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                : minutes === 10080 ? tFallback(t, 'taskEdit.advanceReminderWeek', '1 week before')
                : minutes === 1440 ? tFallback(t, 'taskEdit.advanceReminderDay', '1 day before')
                : minutes === 2880 ? tFallback(t, 'taskEdit.advanceReminderTwoDays', '2 days before')
                : minutes === 60 ? tFallback(t, 'taskEdit.advanceReminderHour', '1 hour before')
                : tFallback(t, 'taskEdit.advanceReminderMinutes', '{count} min before').replace('{count}', String(minutes)),
            tone: 'default',
        });
    }
    if (props.reviewAt) {
        entries.push({
            id: 'review',
            kind: 'review',
            label: tFallback(t, 'taskEdit.reviewDateLabel', 'Review Date'),
            value: formatPreviewDate(props.reviewAt, formatDate),
            tone: 'default',
        });
    }


    const projectId = overrides?.projectId ?? props.projectId;
    const projectName = projectId
        ? projects?.find((project) => project.id === projectId)?.title
        : parsed.projectTitle;
    if (projectName) {
        entries.push({
            id: 'project',
            kind: 'project',
            label: tFallback(t, 'taskEdit.projectLabel', 'Project'),
            value: truncate(projectName),
            tone: 'default',
        });
    }

    const areaName = props.areaId ? areas?.find((area) => area.id === props.areaId)?.name : undefined;
    if (areaName) {
        entries.push({
            id: 'area',
            kind: 'area',
            label: tFallback(t, 'taskEdit.areaLabel', 'Area'),
            value: truncate(areaName),
            tone: 'default',
        });
    }

    if (props.status) {
        entries.push({
            id: 'status',
            kind: 'status',
            label: tFallback(t, 'taskEdit.statusLabel', 'Status'),
            value: tFallback(t, `status.${props.status}`, props.status),
            tone: 'default',
        });
    }

    if (props.isFocusedToday) {
        entries.push({
            id: 'focus',
            kind: 'focus',
            value: tFallback(t, 'digest.focus', 'Focus'),
            tone: 'default',
        });
    }

    for (const context of props.contexts ?? []) {
        entries.push({ id: `context:${context}`, kind: 'context', value: context, tone: 'default' });
    }
    for (const tag of props.tags ?? []) {
        entries.push({ id: `tag:${tag}`, kind: 'tag', value: tag, tone: 'default' });
    }

    if (props.assignedTo) {
        entries.push({
            id: 'person',
            kind: 'person',
            label: tFallback(t, 'taskEdit.assignedTo', 'Assigned To'),
            value: truncate(props.assignedTo),
            tone: 'default',
        });
    }

    if (props.priority) {
        entries.push({
            id: 'priority',
            kind: 'priority',
            label: tFallback(t, 'taskEdit.priorityLabel', 'Priority'),
            value: tFallback(t, `priority.${props.priority}`, props.priority),
            tone: 'default',
        });
    }

    if (props.timeEstimate) {
        entries.push({
            id: 'estimate',
            kind: 'estimate',
            label: tFallback(t, 'taskEdit.timeEstimateLabel', 'Time Estimate'),
            value: formatTimeEstimateLabel(props.timeEstimate, { t }),
            tone: 'default',
        });
    }

    if (props.energyLevel) {
        entries.push({
            id: 'energy',
            kind: 'energy',
            label: tFallback(t, 'taskEdit.energyLevel', 'Energy Level'),
            value: tFallback(t, `energyLevel.${props.energyLevel}`, props.energyLevel),
            tone: 'default',
        });
    }

    if (props.description) {
        entries.push({
            id: 'note',
            kind: 'note',
            label: tFallback(t, 'taskEdit.descriptionLabel', 'Description'),
            value: truncate(props.description),
            tone: 'default',
        });
    }

    (props.attachments ?? []).forEach((attachment, index) => {
        entries.push({
            id: `link:${attachment.id}`,
            kind: 'link',
            label: index === 0 ? tFallback(t, 'attachments.title', 'Attachments') : undefined,
            value: truncate(attachment.title || attachment.uri),
            tone: 'default',
        });
    });


    return entries.some((entry) => entry.kind !== 'title') ? entries : [];
}
