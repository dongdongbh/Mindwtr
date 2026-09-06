import { useCallback, useMemo } from 'react';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_VISIBLE,
    filterProjectsBySelectedArea,
    formatTimeEstimateLabel as formatCoreTimeEstimateLabel,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isCustomTimeEstimate,
    normalizeTaskEditorOrder,
    parseRRuleString,
    safeParseDate,
    TASK_EDITOR_FIXED_FIELDS,
    type AppData,
    type Project,
    type RecurrenceRule,
    type RecurrenceWeekday,
    type Section,
    type Task,
    type TaskEditorFieldId,
    type TaskPriority,
    type TimeEstimate,
} from '@mindwtr/core';
import type { TaskDraft } from '@mindwtr/core/task-draft';
import {
    getRecurrenceRRuleValue,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    WEEKDAY_ORDER,
} from './recurrence-utils';
import { STATUS_OPTIONS } from './task-edit-modal.utils';
import type { PickerOption } from './TaskEditFieldRenderer.types';

const DEFAULT_TIME_ESTIMATE_PRESETS: TimeEstimate[] = ['5min', '10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const ALL_TIME_ESTIMATES: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: Array<NonNullable<Task['energyLevel']>> = ['low', 'medium', 'high'];
const REFERENCE_HIDDEN_FIELDS = new Set<TaskEditorFieldId>([
    'startTime',
    'dueDate',
    'reviewAt',
    'recurrence',
    'priority',
    'energyLevel',
    'timeEstimate',
    'checklist',
]);

type UseTaskEditDerivedStateArgs = {
    task: Task | null;
    checklist: Task['checklist'];
    draft: TaskDraft | null;
    settings: AppData['settings'];
    projects: Project[];
    sections: Section[];
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    contextInputDraft: string;
    descriptionDraft: string;
    tagInputDraft: string;
    visibleAttachmentsLength: number;
    t: (key: string) => string;
};

export function useTaskEditDerivedState({
    task,
    checklist,
    draft,
    settings,
    projects,
    sections,
    prioritiesEnabled,
    timeEstimatesEnabled,
    contextInputDraft,
    descriptionDraft,
    tagInputDraft,
    visibleAttachmentsLength,
    t,
}: UseTaskEditDerivedStateArgs) {
    const activeProjectId = draft ? draft.projectId : task?.projectId;
    const projectFilterAreaId = draft ? draft.areaId : task?.areaId;
    const filteredProjectsForPicker = useMemo(
        () => filterProjectsBySelectedArea(projects, projectFilterAreaId),
        [projectFilterAreaId, projects]
    );

    const recurrenceOptions: PickerOption<RecurrenceRule>[] = useMemo(
        () => [
            { value: '', label: t('recurrence.none') },
            { value: 'daily', label: t('recurrence.daily') },
            { value: 'weekly', label: t('recurrence.weekly') },
            { value: 'monthly', label: t('recurrence.monthly') },
            { value: 'yearly', label: t('recurrence.yearly') },
        ],
        [t]
    );
    const recurrenceRuleValue = draft?.recurrence ?? getRecurrenceRuleValue(task?.recurrence);
    const recurrenceStrategyValue = draft?.recurrenceStrategy ?? getRecurrenceStrategyValue(task?.recurrence);
    const recurrenceRRuleValue = draft?.recurrenceRRule ?? getRecurrenceRRuleValue(task?.recurrence);
    const dailyInterval = useMemo(() => {
        if (recurrenceRuleValue !== 'daily') return 1;
        const parsed = parseRRuleString(recurrenceRRuleValue);
        return parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
    }, [recurrenceRRuleValue, recurrenceRuleValue]);
    const monthlyAnchorSource = draft
        ? draft.dueDate || draft.startTime
        : task?.dueDate || task?.startTime;
    const monthlyAnchorDate = useMemo(
        () => safeParseDate(monthlyAnchorSource) ?? new Date(),
        [monthlyAnchorSource]
    );
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()] as RecurrenceWeekday;
    const monthlyPattern = useMemo<'date' | 'custom'>(() => {
        if (recurrenceRuleValue !== 'monthly') return 'date';
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const hasLast = parsed.byDay?.some((day) => String(day).startsWith('-1'));
        const hasNth = parsed.byDay?.some((day) => /^[1-4]/.test(String(day)));
        const hasByMonthDay = parsed.byMonthDay && parsed.byMonthDay.length > 0;
        // A multi-day list is always custom, even when its first day happens to
        // match the anchor.
        const isCustomDay = hasByMonthDay
            && (parsed.byMonthDay!.length > 1 || parsed.byMonthDay![0] !== monthlyAnchorDate.getDate());
        return hasNth || hasLast || isCustomDay ? 'custom' : 'date';
    }, [monthlyAnchorDate, recurrenceRRuleValue, recurrenceRuleValue]);

    const formatTimeEstimateLabel = useCallback((value: TimeEstimate) => formatCoreTimeEstimateLabel(value, { t }), [t]);

    const currentEstimate = draft ? draft.timeEstimate : task?.timeEstimate;
    const timeEstimateOptions: { value: TimeEstimate | ''; label: string }[] = useMemo(
        () => {
            const savedPresets = settings.gtd?.timeEstimatePresets;
            const basePresets = savedPresets?.length ? savedPresets : DEFAULT_TIME_ESTIMATE_PRESETS;
            const normalizedPresets = ALL_TIME_ESTIMATES.filter((value) => basePresets.includes(value));
            const effectivePresets = currentEstimate && !isCustomTimeEstimate(currentEstimate) && !normalizedPresets.includes(currentEstimate)
                ? [...normalizedPresets, currentEstimate]
                : normalizedPresets;
            return [
                { value: '', label: t('common.none') },
                ...effectivePresets.map((value) => ({ value, label: formatTimeEstimateLabel(value) })),
            ];
        },
        [currentEstimate, formatTimeEstimateLabel, settings.gtd?.timeEstimatePresets, t]
    );

    const savedOrder = useMemo(() => settings.gtd?.taskEditor?.order ?? [], [settings.gtd?.taskEditor?.order]);
    const savedHidden = useMemo(() => {
        const featureHiddenFields = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) featureHiddenFields.add('priority');
        if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');
        const defaultHidden = DEFAULT_TASK_EDITOR_ORDER.filter(
            (fieldId) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(fieldId) || featureHiddenFields.has(fieldId)
        );
        return settings.gtd?.taskEditor?.hidden ?? defaultHidden;
    }, [prioritiesEnabled, settings.gtd?.taskEditor?.hidden, timeEstimatesEnabled]);
    const editStatus = draft?.status ?? task?.status;
    const isReference = editStatus === 'reference';
    // #1021: reveal the person field while editing a task as Waiting For, so an
    // existing task can be assigned a person without first customizing the
    // editor layout. An explicit saved customization that hides the field wins.
    const isAssignedToExplicitlyHidden = settings.gtd?.taskEditor?.hidden?.includes('assignedTo') ?? false;
    const disabledFields = useMemo(() => {
        const next = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) next.add('priority');
        if (!timeEstimatesEnabled) next.add('timeEstimate');
        return next;
    }, [prioritiesEnabled, timeEstimatesEnabled]);
    const taskEditorOrder = useMemo(
        () => normalizeTaskEditorOrder(savedOrder, disabledFields),
        [disabledFields, savedOrder]
    );
    const sectionAssignments = useMemo(
        () => getTaskEditorSectionAssignments(settings.gtd?.taskEditor),
        [settings.gtd?.taskEditor]
    );
    const sectionOpenDefaults = useMemo(
        () => getTaskEditorSectionOpenDefaults(settings.gtd?.taskEditor),
        [settings.gtd?.taskEditor]
    );
    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        const next = new Set(savedHidden.filter((id) => known.has(id)));
        if (!prioritiesEnabled) next.add('priority');
        if (!timeEstimatesEnabled) next.add('timeEstimate');
        return next;
    }, [savedHidden, prioritiesEnabled, timeEstimatesEnabled, taskEditorOrder]);
    const orderFields = useCallback(
        (fields: TaskEditorFieldId[]) => {
            const ordered = taskEditorOrder.filter((id) => fields.includes(id));
            const missing = fields.filter((id) => !ordered.includes(id));
            return [...ordered, ...missing];
        },
        [taskEditorOrder]
    );
    const activeSectionId = draft ? draft.sectionId : task?.sectionId;
    const activeAreaId = draft ? draft.areaId : task?.areaId;
    const hasValue = useCallback((fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return false;
            case 'project':
                return Boolean(activeProjectId);
            case 'section':
                return Boolean(activeSectionId);
            case 'area':
                return Boolean(activeAreaId);
            case 'priority':
                if (!prioritiesEnabled) return false;
                return Boolean(draft ? draft.priority : task?.priority);
            case 'energyLevel':
                return Boolean(draft ? draft.energyLevel : task?.energyLevel);
            case 'assignedTo':
                return Boolean((draft ? draft.assignedTo : task?.assignedTo)?.trim());
            case 'contexts':
                return Boolean(contextInputDraft.trim());
            case 'description':
                return Boolean(descriptionDraft.trim());
            case 'location':
                return Boolean((draft ? draft.location : task?.location)?.trim());
            case 'tags':
                return Boolean(tagInputDraft.trim());
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return false;
                return Boolean(draft ? draft.timeEstimate : task?.timeEstimate);
            case 'recurrence':
                return Boolean(draft ? draft.recurrence : task?.recurrence);
            case 'startTime':
                return Boolean(draft ? draft.startTime : task?.startTime);
            case 'dueDate':
                return Boolean(draft ? draft.dueDate : task?.dueDate);
            case 'reviewAt':
                return Boolean(draft ? draft.reviewAt : task?.reviewAt);
            case 'attachments':
                return visibleAttachmentsLength > 0;
            case 'checklist':
                return (checklist ?? task?.checklist ?? []).length > 0;
            default:
                return false;
        }
    }, [
        activeAreaId,
        activeProjectId,
        activeSectionId,
        contextInputDraft,
        descriptionDraft,
        draft,
        checklist,
        prioritiesEnabled,
        tagInputDraft,
        task?.assignedTo,
        task?.checklist,
        task?.dueDate,
        task?.energyLevel,
        task?.location,
        task?.priority,
        task?.recurrence,
        task?.reviewAt,
        task?.startTime,
        task?.timeEstimate,
        timeEstimatesEnabled,
        visibleAttachmentsLength,
    ]);
    const isFieldVisible = useCallback(
        (fieldId: TaskEditorFieldId) => {
            if (isReference && REFERENCE_HIDDEN_FIELDS.has(fieldId)) return false;
            if (fieldId === 'assignedTo' && editStatus === 'waiting' && !isAssignedToExplicitlyHidden) return true;
            return !hiddenSet.has(fieldId) || hasValue(fieldId);
        },
        [editStatus, hasValue, hiddenSet, isAssignedToExplicitlyHidden, isReference]
    );
    const filterVisibleFields = useCallback(
        (fields: TaskEditorFieldId[]) => fields.filter(isFieldVisible),
        [isFieldVisible]
    );
    const basicFields = useMemo(
        () => filterVisibleFields(orderFields(
            taskEditorOrder.filter((fieldId) => {
                if (TASK_EDITOR_FIXED_FIELDS.includes(fieldId)) return true;
                return sectionAssignments[fieldId] === 'basic';
            })
        )),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const schedulingFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'scheduling'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const organizationFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'organization'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const detailsFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'details'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const showStatusField = isFieldVisible('status');
    const projectSections = useMemo(() => {
        if (!activeProjectId) return [];
        return sections
            .filter((section) => section.projectId === activeProjectId && !section.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? a.order : 0;
                const bOrder = Number.isFinite(b.order) ? b.order : 0;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
    }, [activeProjectId, sections]);

    return {
        activeProjectId,
        // Reference is offered from every status, matching desktop (#1155) and
        // the row status badge; the editor no longer hides it behind "already a
        // reference".
        availableStatusOptions: STATUS_OPTIONS,
        basicFields,
        dailyInterval,
        detailsFields,
        energyLevelOptions: ENERGY_LEVEL_OPTIONS,
        filteredProjectsForPicker,
        formatTimeEstimateLabel,
        monthlyAnchorDate,
        monthlyPattern,
        monthlyWeekdayCode,
        organizationFields,
        priorityOptions: PRIORITY_OPTIONS,
        projectFilterAreaId,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        schedulingFields,
        sectionOpenDefaults,
        showStatusField,
        timeEstimateOptions,
    };
}
