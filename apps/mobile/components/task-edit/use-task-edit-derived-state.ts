import { useCallback, useMemo } from 'react';
import {
    filterProjectsBySelectedArea,
    formatTimeEstimateLabel as formatCoreTimeEstimateLabel,
    getTaskEditorDailyInterval,
    getTaskEditorFieldLayout,
    getTaskEditorMonthlyAnchorSource,
    getTaskEditorMonthlyPattern,
    getTaskEditorProjectSections,
    getTaskEditorSectionOpenDefaults,
    getTaskEditorTimeEstimateValues,
    resolveTaskEditorMonthlyAnchorDate,
    TASK_EDITOR_ENERGY_LEVEL_OPTIONS,
    TASK_EDITOR_PRIORITY_OPTIONS,
    TASK_EDITOR_RECURRENCE_OPTIONS,
    TASK_EDITOR_STATUS_OPTIONS,
    type AppData,
    type Project,
    type RecurrenceRule,
    type RecurrenceWeekday,
    type Section,
    type Task,
    type TimeEstimate,
} from '@mindwtr/core';
import type { TaskDraft } from '@mindwtr/core/task-draft';
import {
    getRecurrenceRRuleValue,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    WEEKDAY_ORDER,
} from './recurrence-utils';
import type { PickerOption } from './TaskEditFieldRenderer.types';

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
        () => TASK_EDITOR_RECURRENCE_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) })),
        [t]
    );
    const recurrenceRuleValue = draft?.recurrence ?? getRecurrenceRuleValue(task?.recurrence);
    const recurrenceStrategyValue = draft?.recurrenceStrategy ?? getRecurrenceStrategyValue(task?.recurrence);
    const recurrenceRRuleValue = draft?.recurrenceRRule ?? getRecurrenceRRuleValue(task?.recurrence);
    const dailyInterval = useMemo(
        () => getTaskEditorDailyInterval(recurrenceRuleValue, recurrenceRRuleValue),
        [recurrenceRRuleValue, recurrenceRuleValue]
    );
    const monthlyAnchorSource = getTaskEditorMonthlyAnchorSource(task, draft);
    const monthlyAnchorDate = useMemo(
        () => resolveTaskEditorMonthlyAnchorDate(monthlyAnchorSource),
        [monthlyAnchorSource]
    );
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()] as RecurrenceWeekday;
    const monthlyPattern = useMemo(
        () => getTaskEditorMonthlyPattern(recurrenceRuleValue, recurrenceRRuleValue, monthlyAnchorDate),
        [monthlyAnchorDate, recurrenceRRuleValue, recurrenceRuleValue]
    );

    const formatTimeEstimateLabel = useCallback((value: TimeEstimate) => formatCoreTimeEstimateLabel(value, { t }), [t]);

    const currentEstimate = draft ? draft.timeEstimate : task?.timeEstimate;
    const timeEstimateOptions: { value: TimeEstimate | ''; label: string }[] = useMemo(
        () => getTaskEditorTimeEstimateValues(currentEstimate).map((value) => ({
            value,
            label: value ? formatTimeEstimateLabel(value) : t('common.none'),
        })),
        [currentEstimate, formatTimeEstimateLabel, t]
    );

    const taskEditor = settings.gtd?.taskEditor;
    const sectionOpenDefaults = useMemo(() => getTaskEditorSectionOpenDefaults(taskEditor), [taskEditor]);
    const projectSections = useMemo(
        () => getTaskEditorProjectSections(sections, activeProjectId),
        [activeProjectId, sections]
    );
    const hasProjectSections = projectSections.length > 0;
    const layout = useMemo(() => getTaskEditorFieldLayout({
        task,
        draft,
        checklist,
        taskEditor,
        hasProjectSections,
        prioritiesEnabled,
        timeEstimatesEnabled,
        contextInputDraft,
        descriptionDraft,
        tagInputDraft,
        visibleAttachmentsLength,
    }), [
        checklist,
        contextInputDraft,
        descriptionDraft,
        draft,
        hasProjectSections,
        prioritiesEnabled,
        tagInputDraft,
        task,
        taskEditor,
        timeEstimatesEnabled,
        visibleAttachmentsLength,
    ]);

    return {
        activeProjectId,
        availableStatusOptions: TASK_EDITOR_STATUS_OPTIONS,
        basicFields: layout.sections.basic,
        dailyInterval,
        detailsFields: layout.sections.details,
        energyLevelOptions: TASK_EDITOR_ENERGY_LEVEL_OPTIONS,
        filteredProjectsForPicker,
        formatTimeEstimateLabel,
        monthlyAnchorDate,
        monthlyPattern,
        monthlyWeekdayCode,
        organizationFields: layout.sections.organization,
        priorityOptions: TASK_EDITOR_PRIORITY_OPTIONS,
        projectFilterAreaId,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        schedulingFields: layout.sections.scheduling,
        sectionOpenDefaults,
        showStatusField: layout.showStatusField,
        timeEstimateOptions,
    };
}
