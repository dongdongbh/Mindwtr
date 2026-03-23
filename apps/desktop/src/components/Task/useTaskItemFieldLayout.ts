import { useCallback, useMemo } from 'react';
import type { AppData, Task, TaskEditorFieldId, TaskPriority, TaskStatus, RecurrenceRule, TimeEstimate } from '@mindwtr/core';
import {
    DEFAULT_TASK_EDITOR_HIDDEN,
    DEFAULT_TASK_EDITOR_ORDER,
    TASK_EDITOR_FIXED_FIELDS,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
} from './task-item-helpers';

type UseTaskItemFieldLayoutParams = {
    settings: AppData['settings'] | undefined;
    task: Task;
    editStatus: TaskStatus;
    editProjectId: string;
    editSectionId: string;
    editAreaId: string;
    editPriority: TaskPriority | '';
    editContexts: string;
    editDescription: string;
    editDueDate: string;
    editRecurrence: RecurrenceRule | '';
    editReviewAt: string;
    editStartTime: string;
    editTags: string;
    editTimeEstimate: TimeEstimate | '';
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    visibleEditAttachmentsLength: number;
};

export function useTaskItemFieldLayout({
    settings,
    task,
    editStatus,
    editProjectId,
    editSectionId,
    editAreaId,
    editPriority,
    editContexts,
    editDescription,
    editDueDate,
    editRecurrence,
    editReviewAt,
    editStartTime,
    editTags,
    editTimeEstimate,
    prioritiesEnabled,
    timeEstimatesEnabled,
    visibleEditAttachmentsLength,
}: UseTaskItemFieldLayoutParams) {
    const savedOrder = settings?.gtd?.taskEditor?.order ?? [];
    const savedHidden = settings?.gtd?.taskEditor?.hidden ?? DEFAULT_TASK_EDITOR_HIDDEN;
    const sectionAssignments = useMemo(
        () => getTaskEditorSectionAssignments(settings?.gtd?.taskEditor),
        [settings?.gtd?.taskEditor]
    );
    const sectionOpenDefaults = useMemo(
        () => getTaskEditorSectionOpenDefaults(settings?.gtd?.taskEditor),
        [settings?.gtd?.taskEditor]
    );
    const disabledFields = useMemo(() => {
        const disabled = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) disabled.add('priority');
        if (!timeEstimatesEnabled) disabled.add('timeEstimate');
        return disabled;
    }, [prioritiesEnabled, timeEstimatesEnabled]);

    const taskEditorOrder = useMemo(() => {
        const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
        const normalized = savedOrder.filter((id) => known.has(id));
        const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
        return [...normalized, ...missing].filter((id) => !disabledFields.has(id));
    }, [savedOrder, disabledFields]);
    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        const next = new Set(savedHidden.filter((id) => known.has(id)));
        if (settings?.features?.priorities === false) next.add('priority');
        if (settings?.features?.timeEstimates === false) next.add('timeEstimate');
        return next;
    }, [savedHidden, settings?.features?.priorities, settings?.features?.timeEstimates, taskEditorOrder]);
    const isReference = editStatus === 'reference';
    const referenceHiddenFields = useMemo(() => new Set<TaskEditorFieldId>([
        'startTime',
        'dueDate',
        'reviewAt',
        'recurrence',
        'priority',
        'timeEstimate',
        'checklist',
    ]), []);

    const hasValue = useCallback((fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return editStatus !== 'inbox';
            case 'project':
                return Boolean(editProjectId || task.projectId);
            case 'section':
                return Boolean(editSectionId || task.sectionId);
            case 'area':
                return Boolean(editAreaId || task.areaId);
            case 'priority':
                if (!prioritiesEnabled) return false;
                return Boolean(editPriority);
            case 'contexts':
                return Boolean(editContexts.trim());
            case 'description':
                return Boolean(editDescription.trim());
            case 'tags':
                return Boolean(editTags.trim());
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return false;
                return Boolean(editTimeEstimate);
            case 'recurrence':
                return Boolean(editRecurrence);
            case 'startTime':
                return Boolean(editStartTime);
            case 'dueDate':
                return Boolean(editDueDate);
            case 'reviewAt':
                return Boolean(editReviewAt);
            case 'attachments':
                return visibleEditAttachmentsLength > 0;
            case 'checklist':
                return (task.checklist || []).length > 0;
            default:
                return false;
        }
    }, [
        editAreaId,
        editContexts,
        editDescription,
        editDueDate,
        editPriority,
        editProjectId,
        editRecurrence,
        editReviewAt,
        editSectionId,
        editStatus,
        editStartTime,
        editTags,
        editTimeEstimate,
        prioritiesEnabled,
        task.areaId,
        task.checklist,
        task.projectId,
        task.sectionId,
        timeEstimatesEnabled,
        visibleEditAttachmentsLength,
    ]);

    const isFieldVisible = useCallback(
        (fieldId: TaskEditorFieldId) => {
            if (isReference && referenceHiddenFields.has(fieldId)) return false;
            return !hiddenSet.has(fieldId) || hasValue(fieldId);
        },
        [hasValue, hiddenSet, isReference, referenceHiddenFields]
    );
    const showProjectField = isFieldVisible('project');
    const showAreaField = isFieldVisible('area') && !editProjectId;
    const showSectionField = isFieldVisible('section') && !!editProjectId;
    const orderFields = useCallback(
        (fields: TaskEditorFieldId[]) => {
            const ordered = taskEditorOrder.filter((id) => fields.includes(id));
            const missing = fields.filter((id) => !ordered.includes(id));
            return [...ordered, ...missing];
        },
        [taskEditorOrder]
    );
    const basicFields = useMemo(
        () => orderFields(
            ['status', ...taskEditorOrder.filter((fieldId) =>
                !TASK_EDITOR_FIXED_FIELDS.includes(fieldId) && sectionAssignments[fieldId] === 'basic'
            )]
        ).filter(isFieldVisible),
        [isFieldVisible, orderFields, sectionAssignments, taskEditorOrder]
    );
    const schedulingFields = useMemo(
        () => orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'scheduling')).filter(isFieldVisible),
        [isFieldVisible, orderFields, sectionAssignments, taskEditorOrder]
    );
    const organizationFields = useMemo(
        () => orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'organization')).filter(isFieldVisible),
        [isFieldVisible, orderFields, sectionAssignments, taskEditorOrder]
    );
    const detailsFields = useMemo(
        () => orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'details')).filter(isFieldVisible),
        [isFieldVisible, orderFields, sectionAssignments, taskEditorOrder]
    );
    const sectionCounts = useMemo(
        () => ({
            scheduling: schedulingFields.filter((fieldId) => hasValue(fieldId)).length,
            organization: organizationFields.filter((fieldId) => hasValue(fieldId)).length,
            details: detailsFields.filter((fieldId) => hasValue(fieldId)).length,
        }),
        [detailsFields, hasValue, organizationFields, schedulingFields]
    );

    return {
        showProjectField,
        showAreaField,
        showSectionField,
        basicFields,
        schedulingFields,
        organizationFields,
        detailsFields,
        sectionCounts,
        sectionOpenDefaults,
    };
}
