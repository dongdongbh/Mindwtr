import { getAttachmentDisplayTitle } from './attachment-link-utils';
import { isAttachmentKeptWithoutFile } from './unreachable-attachments';
import { tFallback } from './i18n';
import { formatRecurrenceLabel, getRecurringTaskPreviewDate } from './recurrence';
import { hasTimeComponent } from './date';
import { isTaskCancelled } from './task-status';
import { shouldSendTaskReminders } from './task-reminder-policy';
import type { NotificationSettings } from './types';
import type { Area, Attachment, Project, Section, Task, TaskStatus, TimeEstimate } from './types';

/**
 * The task editor's View tab, as the React Native editor shows it: the task's
 * facts, its notes, its checklist and its attachments, in display order. A
 * done task opens on this tab.
 */

export type TaskViewField =
    | 'priority' | 'energyLevel' | 'assignedTo' | 'project' | 'section' | 'area' | 'startTime' | 'dueDate'
    | 'reminders' | 'reviewAt' | 'timeEstimate' | 'location' | 'recurrence';

export type TaskViewRow =
    | { type: 'title'; label: string; value: string }
    /** `editable`: the status can be changed from here (not read-only, and the task has a status). */
    | { type: 'status'; label: string; value: string; status: TaskStatus | null; editable: boolean }
    /** `project`: the Project row opens the project. */
    | { type: 'field'; field: TaskViewField; label: string; value: string; project: { id: string; accessibilityLabel: string } | null }
    /** Contexts and tags, each one opening its list. */
    | { type: 'tokens'; field: 'contexts' | 'tags'; label: string; items: Array<{ value: string; accessibilityLabel: string }> }
    /** The notes, trimmed; draw them as Markdown. */
    | { type: 'description'; label: string; markdown: string }
    | {
        type: 'checklist';
        label: string;
        /** A tap ticks the item (toggle by its `index`) when not read-only; a reference list too. */
        tappable: boolean;
        /** Titles are inline Markdown. `accessibilityLabel` names a static item: "Step. Done". */
        items: Array<{ index: number; id: string; title: string; completed: boolean; accessibilityLabel: string }>;
        /** The add input after the items (append on submit). */
        add: { placeholder: string; label: string } | null;
    }
    | {
        type: 'attachments';
        label: string;
        /** `image`: show the image itself. `note`: Loading, Download or Missing under the title. `disabled` while downloading. */
        items: Array<{ attachment: Attachment; title: string; image: boolean; note: string | null; disabled: boolean }>;
    };

/** The React Native editor's image rule: an image MIME type, or an image file extension. */
export function isImageAttachment(attachment: Pick<Attachment, 'mimeType' | 'uri'>): boolean {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
}

export type TaskViewModelInput = {
    /** The task with the editor's unsaved draft applied; the saved task when read-only. */
    task: Partial<Task>;
    projects: readonly Project[];
    /** The sections the task's project shows. */
    sections: readonly Section[];
    areas: readonly Area[];
    /** Attachments that are not deleted. */
    attachments: readonly Attachment[];
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    /** From the editor layout (getTaskEditorFieldLayout). */
    showStatusField: boolean;
    /** A task in an archived project. */
    readOnly: boolean;
    settings?: Pick<NotificationSettings, 'taskReminderDefault' | 'notificationsEnabled'>;
    t: (key: string) => string;
    formatDate: (value: string) => string;
    formatDueDate: (value: string) => string;
    formatTimeEstimateLabel: (value: TimeEstimate) => string;
    isImageAttachment?: (attachment: Attachment) => boolean;
    now?: Date;
};

/** The View tab's rows, in order. A row without a value is left out. */
export function buildTaskViewModel(input: TaskViewModelInput): TaskViewRow[] {
    const { task, t, readOnly } = input;
    const rows: TaskViewRow[] = [];
    const field = (name: TaskViewField, label: string, value: string | undefined, project: { id: string; accessibilityLabel: string } | null = null) => {
        if (value) rows.push({ type: 'field', field: name, label, value, project });
    };
    const project = input.projects.find((item) => item.id === task.projectId);
    const section = input.sections.find((item) => item.id === task.sectionId);
    const area = input.areas.find((item) => item.id === (task.areaId || project?.areaId));
    const title = String(task.title || '').trim();
    const description = String(task.description || '').trim();
    const checklist = task.checklist || [];
    const isReference = task.status === 'reference';

    const statusLabel = isTaskCancelled(task as Task)
        ? tFallback(t, 'task.cancelled', 'Cancelled')
        : task.status ? tFallback(t, `status.${task.status}`, task.status) : undefined;
    const timeEstimateLabel = task.timeEstimate
        ? (input.formatTimeEstimateLabel(task.timeEstimate) || String(task.timeEstimate))
        : undefined;
    const recurrenceLabel = formatRecurrenceLabel({ recurrence: task.recurrence, t, formatDate: input.formatDate }) || undefined;
    const previewDate = (() => {
        if (!recurrenceLabel || !task.recurrence) return '';
        const nowIso = (input.now ?? new Date()).toISOString();
        const previewTask = {
            ...task,
            id: task.id ?? 'draft-recurrence-preview',
            title: String(task.title ?? ''),
            status: task.status ?? 'next',
            tags: task.tags ?? [],
            contexts: task.contexts ?? [],
            createdAt: task.createdAt ?? nowIso,
            updatedAt: task.updatedAt ?? nowIso,
            recurrence: task.recurrence,
        } as Task;
        const date = getRecurringTaskPreviewDate(previewTask, nowIso);
        return date ? input.formatDate(date) : '';
    })();
    const recurrenceValue = recurrenceLabel && previewDate
        ? `${recurrenceLabel} · ${tFallback(t, 'recurrence.nextCalendarPreview', 'Next calendar preview')}: ${previewDate}`
        : recurrenceLabel;

    if (title) rows.push({ type: 'title', label: t('taskEdit.titleLabel'), value: title });
    if (!isReference && input.showStatusField && statusLabel) {
        rows.push({ type: 'status', label: t('taskEdit.statusLabel'), value: statusLabel, status: task.status ?? null, editable: !readOnly && Boolean(task.status) });
    }
    if (!isReference && input.prioritiesEnabled) {
        field('priority', t('taskEdit.priorityLabel'), task.priority ? tFallback(t, `priority.${task.priority}`, task.priority) : undefined);
    }
    if (!isReference) {
        field('energyLevel', t('taskEdit.energyLevel'), task.energyLevel ? tFallback(t, `energyLevel.${task.energyLevel}`, task.energyLevel) : undefined);
    }
    field('assignedTo', t('taskEdit.assignedTo'), task.assignedTo);
    field('project', t('taskEdit.projectLabel'), project?.title, project?.id ? { id: project.id, accessibilityLabel: `Open project ${project.title}` } : null);
    if (project?.id) field('section', t('taskEdit.sectionLabel'), section?.title);
    if (!project?.id || isReference) field('area', t('taskEdit.areaLabel'), area?.name);
    if (!isReference) {
        field('startTime', t('taskEdit.startDateLabel'), task.startTime ? input.formatDate(task.startTime) : undefined);
        field('dueDate', t('taskEdit.dueDateLabel'), task.dueDate ? input.formatDueDate(task.dueDate) : undefined);
        if ((hasTimeComponent(task.startTime) || hasTimeComponent(task.dueDate)) && !shouldSendTaskReminders(task, input.settings)) {
            field(
                'reminders',
                tFallback(t, 'taskEdit.suppressMindwtrReminders', 'Skip reminders'),
                tFallback(t, 'taskEdit.suppressMindwtrRemindersViewValue', 'Mindwtr reminders off'),
            );
        }
        field('reviewAt', t('taskEdit.reviewDateLabel'), task.reviewAt ? input.formatDate(task.reviewAt) : undefined);
        if (input.timeEstimatesEnabled) field('timeEstimate', t('taskEdit.timeEstimateLabel'), timeEstimateLabel);
    }
    if (!isReference && task.contexts?.length) {
        rows.push({ type: 'tokens', field: 'contexts', label: t('taskEdit.contextsLabel'), items: task.contexts.map((value) => ({ value, accessibilityLabel: `Open context ${value}` })) });
    }
    if (task.tags?.length) {
        rows.push({ type: 'tokens', field: 'tags', label: t('taskEdit.tagsLabel'), items: task.tags.map((value) => ({ value, accessibilityLabel: `Open tag ${value}` })) });
    }
    if (!isReference) {
        field('location', t('taskEdit.locationLabel'), task.location);
        field('recurrence', t('taskEdit.recurrenceLabel'), recurrenceValue);
    }
    if (description) rows.push({ type: 'description', label: t('taskEdit.descriptionLabel'), markdown: description });
    if (checklist.length) {
        const tappable = !readOnly;
        rows.push({
            type: 'checklist',
            label: t(isReference ? 'taskEdit.tab.list' : 'taskEdit.checklist'),
            tappable,
            items: checklist.map((item, index) => ({
                index,
                id: item.id,
                title: item.title,
                completed: item.isCompleted,
                accessibilityLabel: tappable
                    ? item.title
                    : `${item.title}. ${item.isCompleted ? t('common.done') : t('status.active')}`,
            })),
            add: tappable ? { placeholder: `+ ${t('taskEdit.addItem')}`, label: t('taskEdit.addItem') } : null,
        });
    }
    if (input.attachments.length) {
        const isImage = input.isImageAttachment ?? isImageAttachment;
        rows.push({
            type: 'attachments',
            label: t('attachments.title'),
            items: input.attachments.map((attachment) => {
                const isMissing = attachment.kind === 'file' && (!attachment.uri || attachment.localStatus === 'missing');
                const isDownloading = attachment.localStatus === 'downloading';
                const note = isDownloading
                    ? t('common.loading')
                    : isMissing && attachment.cloudKey && !isAttachmentKeptWithoutFile(attachment)
                        ? t('attachments.download')
                        : isMissing ? t('attachments.missing') : null;
                return {
                    attachment,
                    title: getAttachmentDisplayTitle(attachment),
                    image: isImage(attachment) && !isMissing,
                    note,
                    disabled: isDownloading,
                };
            }),
        });
    }
    return rows;
}
