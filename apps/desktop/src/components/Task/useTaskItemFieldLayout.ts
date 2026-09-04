import { useCallback, useMemo } from 'react';
import type { AppData, Task, TaskDraft, TaskEditorFieldId } from '@mindwtr/core';
import {
    DEFAULT_TASK_EDITOR_HIDDEN,
    TASK_EDITOR_FIXED_FIELDS,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    normalizeTaskEditorOrder,
} from '@mindwtr/core';

type UseTaskItemFieldLayoutParams = {
    settings: AppData['settings'] | undefined;
    task: Task;
    draft: TaskDraft;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    visibleEditAttachmentsLength: number;
};

export function useTaskItemFieldLayout({
    settings,
    task,
    draft,
    prioritiesEnabled,
    timeEstimatesEnabled,
    visibleEditAttachmentsLength,
}: UseTaskItemFieldLayoutParams) {
    const {
        status: editStatus,
        projectId: editProjectId,
        sectionId: editSectionId,
        areaId: editAreaId,
        priority: editPriority,
        energyLevel: editEnergyLevel,
        assignedTo: editAssignedTo,
        contexts: editContexts,
        description: editDescription,
        dueDate: editDueDate,
        recurrence: editRecurrence,
        reviewAt: editReviewAt,
        startTime: editStartTime,
        tags: editTags,
        location: editLocation,
        timeEstimate: editTimeEstimate,
    } = draft;
    const savedOrder = settings?.gtd?.taskEditor?.order ?? [];
    const explicitHidden = settings?.gtd?.taskEditor?.hidden;
    const savedHidden = explicitHidden ?? DEFAULT_TASK_EDITOR_HIDDEN;
    // #1021: reveal the person field while editing a task as Waiting For, so an
    // existing task can be assigned a person without first customizing the
    // editor layout. An explicit saved customization that hides the field wins.
    const isAssignedToExplicitlyHidden = explicitHidden?.includes('assignedTo') ?? false;
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

    const taskEditorOrder = useMemo(
        () => normalizeTaskEditorOrder(savedOrder, disabledFields),
        [savedOrder, disabledFields]
    );
    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        const next = new Set(savedHidden.filter((id) => known.has(id)));
        if (!prioritiesEnabled) next.add('priority');
        if (!timeEstimatesEnabled) next.add('timeEstimate');
        return next;
    }, [savedHidden, prioritiesEnabled, timeEstimatesEnabled, taskEditorOrder]);
    const isReference = editStatus === 'reference';
    const referenceHiddenFields = useMemo(() => new Set<TaskEditorFieldId>([
        'startTime',
        'dueDate',
        'reviewAt',
        'recurrence',
        'priority',
        'energyLevel',
        'timeEstimate',
        'checklist',
    ]), []);

    const hasValue = useCallback((fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return false;
            case 'project':
                return Boolean(editProjectId || task.projectId);
            case 'section':
                return Boolean(editSectionId || task.sectionId);
            case 'area':
                return Boolean(editAreaId || task.areaId);
            case 'priority':
                if (!prioritiesEnabled) return false;
                return Boolean(editPriority);
            case 'energyLevel':
                return Boolean(editEnergyLevel);
            case 'assignedTo':
                return Boolean(editAssignedTo.trim());
            case 'contexts':
                return Boolean(editContexts.trim());
            case 'description':
                return Boolean(editDescription.trim());
            case 'location':
                return Boolean(editLocation.trim());
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
        editAssignedTo,
        editContexts,
        editDescription,
        editDueDate,
        editEnergyLevel,
        editLocation,
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
            if (fieldId === 'assignedTo' && editStatus === 'waiting' && !isAssignedToExplicitlyHidden) return true;
            return !hiddenSet.has(fieldId) || hasValue(fieldId);
        },
        [editStatus, hasValue, hiddenSet, isAssignedToExplicitlyHidden, isReference, referenceHiddenFields]
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
    const organizerFields = useMemo(() => {
        const visible: TaskEditorFieldId[] = [];
        if (showAreaField) visible.push('area');
        if (showProjectField) visible.push('project');
        if (showSectionField) visible.push('section');
        return orderFields(visible);
    }, [orderFields, showAreaField, showProjectField, showSectionField]);
    // Split the ordered basic fields around the area/project/section selector row so
    // the row lands where those fields sit in the configured order (#880).
    const { basicFieldsBeforeOrganizers, basicFieldsAfterOrganizers } = useMemo(() => {
        if (organizerFields.length === 0) {
            return { basicFieldsBeforeOrganizers: basicFields, basicFieldsAfterOrganizers: [] as TaskEditorFieldId[] };
        }
        const organizerAnchor = Math.min(
            ...organizerFields.map((fieldId) => taskEditorOrder.indexOf(fieldId))
        );
        return {
            basicFieldsBeforeOrganizers: basicFields.filter((fieldId) => taskEditorOrder.indexOf(fieldId) < organizerAnchor),
            basicFieldsAfterOrganizers: basicFields.filter((fieldId) => taskEditorOrder.indexOf(fieldId) >= organizerAnchor),
        };
    }, [basicFields, organizerFields, taskEditorOrder]);
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
        organizerFields,
        basicFields,
        basicFieldsBeforeOrganizers,
        basicFieldsAfterOrganizers,
        schedulingFields,
        organizationFields,
        detailsFields,
        sectionCounts,
        sectionOpenDefaults,
    };
}
