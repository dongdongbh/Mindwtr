


import { buildBulkOrganizeTaskUpdates, parseBulkOrganizeTokenInput, type BulkOrganizeStatus, type BulkOrganizeTaskUpdateInput } from './bulk-organize';
import { buildBulkTaskTokenUpdates, type BulkTaskTokenMode } from './bulk-task-tokens';
import { getQuickDate, isQuickDatePresetSelected, safeFormatDate, safeParseDate, type DateFormatter } from './date';
import { tFallback } from './i18n';
import { formatListItemCount } from './list-count';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import type { StoreActionResult, TaskStore } from './store-types';
import { getQuickDateLabel } from './task-editor-schedule';
import { compareAreasByOrder } from './task-utils';
import { getTrashUndoLabel } from './trash-view-model';
import type { Area, Project, Task, TaskStatus } from './types';

type Translate = (key: string) => string;


export const BULK_MOVE_STATUS_ORDER: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];


export function getBulkMoveStatusOptions(currentStatus?: TaskStatus | 'all'): TaskStatus[] {
    if (!currentStatus || currentStatus === 'all') return BULK_MOVE_STATUS_ORDER;
    if (currentStatus === 'done') {
        return [...BULK_MOVE_STATUS_ORDER.filter((status) => status !== currentStatus), 'archived'];
    }
    return BULK_MOVE_STATUS_ORDER.filter((status) => status !== currentStatus);
}

export type TaskListBulkScreen = 'inbox' | 'waiting' | 'someday' | 'reference' | 'done' | 'project';


export const TASK_LIST_BULK_SCREENS: Record<TaskListBulkScreen, {
    status: TaskStatus | 'all';
    organize: boolean;
    moveToSection: boolean;
    removeTags: boolean;
}> = {
    inbox: { status: 'inbox', organize: true, moveToSection: false, removeTags: true },
    waiting: { status: 'waiting', organize: false, moveToSection: false, removeTags: false },
    someday: { status: 'someday', organize: false, moveToSection: true, removeTags: false },
    reference: { status: 'reference', organize: false, moveToSection: false, removeTags: true },
    done: { status: 'done', organize: false, moveToSection: false, removeTags: true },
    project: { status: 'all', organize: true, moveToSection: false, removeTags: true },
};

type BarAction = { label: string; enabled: boolean };
export type TaskListBulkBarModel = {

    countLabel: string;

    busyLabel: string;
    exit: { accessibilityLabel: string; enabled: boolean };
    statuses: (BarAction & { status: TaskStatus; accessibilityLabel: string })[];
    moveToSection: BarAction | null;
    organize: BarAction | null;

    range: BarAction & { active: boolean };
    addTag: BarAction;

    removeTag: BarAction | null;
    delete: BarAction;
};


export function buildTaskListBulkBarModel(input: {
    selectedCount: number;
    hasSelection: boolean;
    busy: boolean;

    busyLabel?: string;
    rangeSelectMode: boolean;
    statuses: readonly TaskStatus[];
    moveToSection: boolean;
    organize: boolean;

    removeTag: { canRemove: boolean } | null;
    t: Translate;
}): TaskListBulkBarModel {
    const { t } = input;
    const enabled = input.hasSelection && !input.busy;
    const moveTo = t('bulk.moveTo');
    return {
        countLabel: `${input.selectedCount} ${t('bulk.selected')}`,
        busyLabel: input.busyLabel || t('common.loading'),
        exit: { accessibilityLabel: tFallback(t, 'bulk.exitSelect', 'Done'), enabled: !input.busy },
        statuses: input.statuses.map((status) => {
            const label = t(`status.${status}`);
            return { status, label, accessibilityLabel: `${moveTo} ${label}`, enabled };
        }),
        moveToSection: input.moveToSection ? { label: tFallback(t, 'viewSections.moveToSection', 'Move to section…'), enabled } : null,
        organize: input.organize ? { label: tFallback(t, 'bulk.organize', 'Bulk organize'), enabled } : null,
        range: {
            label: input.rangeSelectMode ? tFallback(t, 'bulk.selectRangeActive', 'Pick end') : tFallback(t, 'bulk.selectRange', 'Range'),
            active: input.rangeSelectMode,
            enabled,
        },
        addTag: { label: t('bulk.addTag'), enabled },
        removeTag: input.removeTag ? { label: tFallback(t, 'bulk.removeTag', 'Remove tag'), enabled: enabled && input.removeTag.canRemove } : null,
        delete: { label: tFallback(t, 'common.delete', 'Delete'), enabled },
    };
}


export function getTaskListAddTagDialogText(t: Translate) {
    return {
        title: t('bulk.addTag'),
        placeholder: t('taskEdit.tagsLabel'),
        cancelLabel: t('common.cancel'),
        saveLabel: t('common.save'),
    };
}
export const canSaveTaskListTag = (input: string): boolean => input.trim().length > 0;


export function getTaskListRemoveTagPickerText(t: Translate) {
    const title = tFallback(t, 'bulk.removeTag', 'Remove tag');
    return { title, description: title, placeholder: t('bulk.tagPlaceholder') };
}


export function getTaskListBulkBusyLabels(t: Translate) {
    return {
        move: t('bulk.moveTo'),
        addTag: t('bulk.addTag'),
        removeTag: tFallback(t, 'bulk.removeTag', 'Remove tag'),
        organize: tFallback(t, 'bulk.organize', 'Bulk organize'),
        delete: t('common.delete'),
        undo: getTrashUndoLabel(t),
    };
}


export const BULK_ORGANIZE_STATUS_OPTIONS: BulkOrganizeStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];

export const BULK_ORGANIZE_KEEP = '__KEEP__';

export const BULK_ORGANIZE_NONE = '__NONE__';

export type BulkOrganizeTextField = 'contexts' | 'tags' | 'startDate' | 'dueDate' | 'reviewDate' | 'delegateWho';
export type BulkOrganizeDateField = Extract<BulkOrganizeTextField, 'startDate' | 'dueDate' | 'reviewDate'>;
export const BULK_ORGANIZE_DATE_FIELDS: BulkOrganizeDateField[] = ['startDate', 'dueDate', 'reviewDate'];


export type BulkOrganizeDraft = {
    status: BulkOrganizeStatus | typeof BULK_ORGANIZE_KEEP;

    projectChoice: string;

    areaChoice: string;

    contexts: string;
    tags: string;

    startDate: string;
    dueDate: string;
    reviewDate: string;

    delegateWho: string;
};

export const EMPTY_BULK_ORGANIZE_DRAFT: BulkOrganizeDraft = {
    status: BULK_ORGANIZE_KEEP,
    projectChoice: BULK_ORGANIZE_KEEP,
    areaChoice: BULK_ORGANIZE_KEEP,
    contexts: '',
    tags: '',
    startDate: '',
    dueDate: '',
    reviewDate: '',
    delegateWho: '',
};

export type BulkOrganizeDraftEdit =
    | { type: 'setStatus'; value: BulkOrganizeStatus | typeof BULK_ORGANIZE_KEEP }

    | { type: 'setProject'; value: string }
    | { type: 'setArea'; value: string }
    | { type: 'setText'; field: BulkOrganizeTextField; value: string };

export function applyBulkOrganizeDraftEdit(draft: BulkOrganizeDraft, edit: BulkOrganizeDraftEdit): BulkOrganizeDraft {
    switch (edit.type) {
        case 'setStatus':
            return { ...draft, status: edit.value };
        case 'setProject':
            return { ...draft, projectChoice: edit.value, areaChoice: BULK_ORGANIZE_KEEP };
        case 'setArea':
            return { ...draft, areaChoice: edit.value };
        case 'setText':
            return { ...draft, [edit.field]: edit.value };
    }
}

const chosenId = (choice: string): string | undefined => (
    choice !== BULK_ORGANIZE_KEEP && choice !== BULK_ORGANIZE_NONE ? choice : undefined
);


export function getBulkOrganizeProjectOptions(projects: readonly Project[]): Project[] {
    return projects
        .filter(isSelectableProjectForTaskAssignment)
        .sort((a, b) => a.title.localeCompare(b.title));
}


export function getBulkOrganizeAreaOptions(areas: readonly Area[]): Area[] {
    return areas.filter((area) => !area.deletedAt).sort(compareAreasByOrder);
}

export type BulkOrganizeDialogModel = {
    title: string;

    subtitle: string;
    closeLabel: string;
    cancelLabel: string;
    applyLabel: string;
    statusLabel: string;

    statuses: { value: BulkOrganizeStatus | typeof BULK_ORGANIZE_KEEP; label: string; selected: boolean }[];
    project: { label: string; value: string; accessibilityLabel: string; keepLabel: string; selectedId: string | undefined };

    area: { label: string; value: string; accessibilityLabel: string; keepLabel: string; selectedId: string | undefined; disabled: boolean };

    waitingFor: { label: string; placeholder: string } | null;

    dates: { field: BulkOrganizeDateField; label: string }[];
    contexts: { label: string; placeholder: string };
    tags: { label: string; placeholder: string };

    canApply: boolean;
    validationMessage: string;

    createFailed: { project: string; area: string };
};

export function buildBulkOrganizeDialogModel(input: {
    draft: BulkOrganizeDraft;

    projects: readonly Project[];
    areas: readonly Area[];
    selectedCount: number;
    t: Translate;
}): BulkOrganizeDialogModel {
    const { draft, t } = input;
    const selectedProjectId = chosenId(draft.projectChoice);
    const selectedAreaId = chosenId(draft.areaChoice);
    const selectedProject = selectedProjectId ? input.projects.find((project) => project.id === selectedProjectId) : undefined;
    const selectedArea = selectedAreaId ? input.areas.find((area) => area.id === selectedAreaId) : undefined;
    const projectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');
    const areaLabel = tFallback(t, 'projects.areaLabel', 'Area');
    const keepProjectLabel = tFallback(t, 'bulk.keepProject', 'Keep project');
    const keepAreaLabel = tFallback(t, 'bulk.keepArea', 'Keep area');
    const projectValue = draft.projectChoice === BULK_ORGANIZE_KEEP
        ? keepProjectLabel
        : draft.projectChoice === BULK_ORGANIZE_NONE
            ? tFallback(t, 'taskEdit.noProjectOption', 'No project')
            : selectedProject?.title ?? projectLabel;
    const areaValue = draft.areaChoice === BULK_ORGANIZE_KEEP
        ? keepAreaLabel
        : draft.areaChoice === BULK_ORGANIZE_NONE
            ? tFallback(t, 'taskEdit.noAreaOption', 'No area')
            : selectedArea?.name ?? areaLabel;
    const isWaiting = draft.status === 'waiting';
    return {
        title: tFallback(t, 'bulk.organize', 'Bulk organize'),
        subtitle: `${input.selectedCount} ${tFallback(t, 'bulk.selected', 'selected')} - ${tFallback(t, 'bulk.organizeHintShort', 'Titles and descriptions stay unchanged.')}`,
        closeLabel: tFallback(t, 'common.close', 'Close'),
        cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
        applyLabel: tFallback(t, 'bulk.applyToSelected', 'Apply to selected'),
        statusLabel: tFallback(t, 'bulk.organizeStatus', 'Status'),
        statuses: [
            { value: BULK_ORGANIZE_KEEP, label: tFallback(t, 'bulk.keepStatus', 'Keep status'), selected: draft.status === BULK_ORGANIZE_KEEP },
            ...BULK_ORGANIZE_STATUS_OPTIONS.map((option) => ({ value: option, label: tFallback(t, `status.${option}`, option), selected: draft.status === option })),
        ],
        project: {
            label: projectLabel,
            value: projectValue,
            accessibilityLabel: `${projectLabel}: ${projectValue}`,
            keepLabel: keepProjectLabel,
            selectedId: selectedProjectId,
        },
        area: {
            label: areaLabel,
            value: areaValue,
            accessibilityLabel: `${areaLabel}: ${areaValue}`,
            keepLabel: keepAreaLabel,
            selectedId: selectedAreaId,
            disabled: Boolean(selectedProjectId),
        },
        waitingFor: isWaiting
            ? { label: tFallback(t, 'process.delegateWhoLabel', 'Waiting for'), placeholder: tFallback(t, 'process.delegateWhoPlaceholder', 'Person or team') }
            : null,
        dates: [
            { field: 'startDate', label: tFallback(t, 'taskEdit.startDateLabel', 'Start') },
            { field: 'dueDate', label: tFallback(t, 'taskEdit.dueDateLabel', 'Due') },
            {
                field: 'reviewDate',
                label: isWaiting ? tFallback(t, 'process.followUpLabel', 'Follow-up') : tFallback(t, 'taskEdit.reviewDateLabel', 'Review'),
            },
        ],
        contexts: { label: tFallback(t, 'taskEdit.contextsLabel', 'Contexts'), placeholder: '@computer, @office' },
        tags: { label: tFallback(t, 'taskEdit.tagsLabel', 'Tags'), placeholder: '#project, #admin' },
        canApply: input.selectedCount > 0 && (!isWaiting || draft.delegateWho.trim().length > 0),
        validationMessage: tFallback(t, 'bulk.waitingPersonRequired', 'Choose who these items are waiting for.'),
        createFailed: {
            project: tFallback(t, 'projects.createFailed', 'Failed to create project.'),
            area: tFallback(t, 'projects.createAreaFailed', 'Failed to create area.'),
        },
    };
}


export function buildBulkOrganizeInput(draft: BulkOrganizeDraft): BulkOrganizeTaskUpdateInput {
    const input: BulkOrganizeTaskUpdateInput = {
        contexts: parseBulkOrganizeTokenInput(draft.contexts, '@'),
        tags: parseBulkOrganizeTokenInput(draft.tags, '#'),
    };
    if (draft.status !== BULK_ORGANIZE_KEEP) input.status = draft.status;
    if (draft.projectChoice !== BULK_ORGANIZE_KEEP) {
        input.projectId = draft.projectChoice === BULK_ORGANIZE_NONE ? null : draft.projectChoice;
    }
    if (!chosenId(draft.projectChoice) && draft.areaChoice !== BULK_ORGANIZE_KEEP) {
        input.areaId = draft.areaChoice === BULK_ORGANIZE_NONE ? null : draft.areaChoice;
    }
    if (draft.startDate.trim()) input.startTime = draft.startDate.trim();
    if (draft.dueDate.trim()) input.dueDate = draft.dueDate.trim();
    if (draft.reviewDate.trim()) input.reviewAt = draft.reviewDate.trim();
    if (draft.status === 'waiting') input.assignedTo = draft.delegateWho.trim();
    return input;
}


export const toBulkOrganizeDateValue = (date: Date | null, formatDate: DateFormatter = safeFormatDate): string => (
    date ? formatDate(date, 'yyyy-MM-dd') : ''
);

export type BulkOrganizeDateFieldModel = {
    label: string;
    value: string;

    displayValue: string;
    placeholder: string;
    calendarAccessibilityLabel: string;

    doneText: string;
    doneLabel: string;

    pickerStart: string;

    quickDates: { preset: 'today' | 'tomorrow'; label: string; accessibilityLabel: string; selected: boolean; value: string }[];
};

export function buildBulkOrganizeDateFieldModel(input: {
    label: string;
    value: string;
    now: Date;
    t: Translate;
    formatDate?: DateFormatter;
}): BulkOrganizeDateFieldModel {
    const { label, value, now, t } = input;
    const formatDate = input.formatDate ?? safeFormatDate;
    const selectedDate = safeParseDate(value);
    const doneText = tFallback(t, 'common.done', 'Done');
    return {
        label,
        value,
        displayValue: selectedDate ? formatDate(selectedDate, 'P') : value,
        placeholder: 'YYYY-MM-DD',
        calendarAccessibilityLabel: `${label}: ${tFallback(t, 'calendar.title', 'Calendar')}`,
        doneText,
        doneLabel: `${label}: ${doneText}`,
        pickerStart: toBulkOrganizeDateValue(selectedDate ?? now, formatDate),
        quickDates: (['today', 'tomorrow'] as const).map((preset) => {
            const chipLabel = getQuickDateLabel(preset, t);
            const selected = isQuickDatePresetSelected(preset, selectedDate, now);
            return {
                preset,
                label: chipLabel,
                accessibilityLabel: `${label}: ${chipLabel}`,
                selected,
                value: selected ? '' : toBulkOrganizeDateValue(getQuickDate(preset, now), formatDate),
            };
        }),
    };
}


export type TaskListBulkWrite =
    | { kind: 'move'; taskIds: string[]; status: TaskStatus }
    | { kind: 'update'; updates: { id: string; updates: Partial<Task> }[] }
    | { kind: 'trash'; taskIds: string[] }
    | { kind: 'restore'; taskIds: string[] };

type TaskLookup = Map<string, Task> | Record<string, Task | undefined>;


export function planBulkTagEdit(
    taskIds: string[],
    tasksById: TaskLookup,
    mode: BulkTaskTokenMode,
    value: string | readonly string[],
): TaskListBulkWrite | null {
    const updates = buildBulkTaskTokenUpdates(taskIds, tasksById, 'tags', value, mode);
    return updates.length > 0 ? { kind: 'update', updates } : null;
}


export function planBulkOrganize(
    taskIds: readonly string[],
    tasksById: ReadonlyMap<string, Task> | Record<string, Task | undefined>,
    input: BulkOrganizeTaskUpdateInput,
): TaskListBulkWrite | null {
    const updates = buildBulkOrganizeTaskUpdates(taskIds, tasksById, input);
    return updates.length > 0 ? { kind: 'update', updates } : null;
}


export function runTaskListBulkWrite(
    store: Pick<TaskStore, 'batchMoveTasks' | 'batchUpdateTasks' | 'batchDeleteTasks' | 'restoreTask'>,
    write: TaskListBulkWrite,
): Promise<void | StoreActionResult | (void | StoreActionResult)[]> {
    switch (write.kind) {
        case 'move': return store.batchMoveTasks(write.taskIds, write.status);
        case 'update': return store.batchUpdateTasks(write.updates);
        case 'trash': return store.batchDeleteTasks(write.taskIds);
        case 'restore': return Promise.all(write.taskIds.map((id) => store.restoreTask(id)));
    }
}


export function getTaskListBulkToast(write: TaskListBulkWrite, t: Translate): {
    tone: 'success';
    title: string;
    message: string;
    undo: { label: string; taskIds: string[] } | null;
} | null {
    if (write.kind === 'restore') return null;
    const count = write.kind === 'update' ? write.updates.length : write.taskIds.length;
    return {
        tone: 'success',
        title: t('common.done'),
        message: formatListItemCount(count, 'task', t),
        undo: write.kind === 'trash' ? { label: getTrashUndoLabel(t), taskIds: [...write.taskIds] } : null,
    };
}
