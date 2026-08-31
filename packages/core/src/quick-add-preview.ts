import { hasTimeComponent, safeFormatDate } from './date';
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
    | 'note'
    | 'link';

export interface QuickAddPreviewEntry {
    /** Stable across keystrokes so a chip is never remounted while typing. */
    id: string;
    kind: QuickAddPreviewEntryKind;
    /** Localized field name; absent where the value speaks for itself (@context, #tag). */
    label?: string;
    value: string;
    tone: 'default' | 'warning';
}

/**
 * What a surface's own pickers will force onto the saved task, mirroring its
 * `CaptureTransactionOptions.transformProps`. A picked value always wins over
 * the parsed one, so the chip has to show the picked value too. Each field is
 * exactly the string the task will store — date-only stays date-only (#797).
 */
export interface QuickAddPreviewOverrides {
    projectId?: string;
    dueDate?: string;
    startTime?: string;
}

export interface QuickAddPreviewOptions {
    t: TranslateFn;
    projects?: readonly Project[];
    areas?: readonly Area[];
    /** The draft as typed; the title chip shows only when parsing changed it. */
    rawInput?: string;
    /** Surfaces without pickers (desktop, capture modal) leave this unset. */
    overrides?: QuickAddPreviewOverrides;
}

const VALUE_PREVIEW_LIMIT = 48;

function truncate(value: string, limit = VALUE_PREVIEW_LIMIT): string {
    const trimmed = value.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1).trimEnd()}…` : trimmed;
}

/**
 * Formats a value the parser already resolved. Never re-parses: the string here
 * is exactly what the task will store, date-only stays date-only (#797).
 */
function formatPreviewDate(value: string): string {
    return safeFormatDate(value, hasTimeComponent(value) ? 'Pp' : 'P', value);
}

/**
 * Shape a parsed quick-add draft into the chips a capture surface shows while
 * the user types. Read-only: everything here comes out of the single
 * `parseQuickAdd` result the submit path uses, so the preview cannot disagree
 * with what saving will produce.
 *
 * Returns an empty list when nothing beyond a plain title was recognized, so a
 * surface can render the strip unconditionally and have it stay invisible.
 */
export function buildQuickAddPreviewEntries(
    parsed: QuickAddResult,
    options: QuickAddPreviewOptions,
): QuickAddPreviewEntry[] {
    const { t, projects, areas, rawInput, overrides } = options;
    const props = parsed.props;
    const entries: QuickAddPreviewEntry[] = [];

    for (const command of parsed.invalidDateCommands ?? []) {
        entries.push({
            id: `warning:${command}`,
            kind: 'warning',
            label: tFallback(t, 'quickAdd.invalidDateCommand', 'Invalid date command'),
            value: command,
            tone: 'warning',
        });
    }

    // Same rule as buildCaptureTaskProps: a trailing natural-language date only
    // becomes the due date when nothing more explicit set one.
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
            value: formatPreviewDate(dueValue),
            tone: 'default',
        });
    }
    const startValue = overrides?.startTime ?? props.startTime;
    if (startValue) {
        entries.push({
            id: 'start',
            kind: 'start',
            label: tFallback(t, 'taskEdit.startDateLabel', 'Start Date'),
            value: formatPreviewDate(startValue),
            tone: 'default',
        });
    }
    if (props.reviewAt) {
        entries.push({
            id: 'review',
            kind: 'review',
            label: tFallback(t, 'taskEdit.reviewDateLabel', 'Review Date'),
            value: formatPreviewDate(props.reviewAt),
            tone: 'default',
        });
    }

    // A `+Project` naming no existing project is reported as projectTitle: the
    // capture creates it, so the chip shows the name either way.
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

    // A cleaned title on its own is not feedback that anything was recognized.
    return entries.some((entry) => entry.kind !== 'title') ? entries : [];
}
