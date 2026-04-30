import { useCallback, useMemo, useState } from 'react';
import {
    getFrequentTaskTokens,
    getRecentTaskTokens,
    normalizeClockTimeInput,
    type AppData,
    type Area,
    type Project,
    type Task,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskEditorFieldId,
    type TimeEstimate,
} from '@mindwtr/core';

import type {
    QuickActionabilityChoice,
    QuickExecutionChoice,
    QuickTwoMinuteChoice,
} from '../../InboxProcessingQuickPanel';
import type { InboxProcessingScheduleFieldKey, InboxProcessingScheduleFieldsControls } from '../../InboxProcessingScheduleFields';
import type { ProcessingStep } from '../../InboxProcessingWizard';
import { DEFAULT_TASK_EDITOR_HIDDEN } from '../../Task/task-item-helpers';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../../lib/area-filter';
import {
    getDateFieldDraft,
    mergeSuggestedTokens,
    resolveCommittedTime,
} from './inbox-processing-utils';

type ProcessingMode = 'guided' | 'quick';

const ALL_TIME_ESTIMATE_OPTIONS: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];

type UseInboxProcessingStateParams = {
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
};

export function useInboxProcessingState({
    tasks,
    projects,
    areas,
    settings,
}: UseInboxProcessingStateParams) {
    const [processingMode, setProcessingMode] = useState<ProcessingMode>('guided');
    const [processingTask, setProcessingTask] = useState<Task | null>(null);
    const [processingStep, setProcessingStep] = useState<ProcessingStep>('actionable');
    const [stepHistory, setStepHistory] = useState<ProcessingStep[]>([]);
    const [quickActionability, setQuickActionability] = useState<QuickActionabilityChoice>('actionable');
    const [quickTwoMinuteChoice, setQuickTwoMinuteChoice] = useState<QuickTwoMinuteChoice>('no');
    const [quickExecutionChoice, setQuickExecutionChoice] = useState<QuickExecutionChoice>('defer');
    const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedEnergyLevel, setSelectedEnergyLevel] = useState<TaskEnergyLevel | undefined>(undefined);
    const [selectedAssignedTo, setSelectedAssignedTo] = useState('');
    const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);
    const [selectedTimeEstimate, setSelectedTimeEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [delegateWho, setDelegateWho] = useState('');
    const [delegateFollowUp, setDelegateFollowUp] = useState('');
    const [projectSearch, setProjectSearch] = useState('');
    const [processingTitle, setProcessingTitle] = useState('');
    const [processingDescription, setProcessingDescription] = useState('');
    const [convertToProject, setConvertToProject] = useState(false);
    const [projectTitleDraft, setProjectTitleDraft] = useState('');
    const [nextActionDraft, setNextActionDraft] = useState('');
    const [customContext, setCustomContext] = useState('');
    const [customTag, setCustomTag] = useState('');
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
    const [scheduleDate, setScheduleDate] = useState('');
    const [scheduleTime, setScheduleTime] = useState('');
    const [scheduleTimeDraft, setScheduleTimeDraft] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [dueTime, setDueTime] = useState('');
    const [dueTimeDraft, setDueTimeDraft] = useState('');
    const [reviewDate, setReviewDate] = useState('');
    const [reviewTime, setReviewTime] = useState('');
    const [reviewTimeDraft, setReviewTimeDraft] = useState('');
    const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());

    const inboxProcessing = settings?.gtd?.inboxProcessing ?? {};
    const defaultScheduleTime = normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '';
    const defaultProcessingMode = inboxProcessing.defaultMode === 'quick' ? 'quick' : 'guided';
    const twoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const twoMinuteFirst = inboxProcessing.twoMinuteFirst === true;
    const projectFirst = inboxProcessing.projectFirst === true;
    const contextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const scheduleEnabled = inboxProcessing.scheduleEnabled === true;
    const referenceEnabled = true;
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const defaultHiddenTaskEditorFields = useMemo(() => {
        const featureHiddenFields = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) featureHiddenFields.add('priority');
        if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');
        return DEFAULT_TASK_EDITOR_HIDDEN.filter((fieldId) => !featureHiddenFields.has(fieldId));
    }, [prioritiesEnabled, timeEstimatesEnabled]);
    const hiddenTaskEditorFields = useMemo(() => {
        const next = new Set(settings?.gtd?.taskEditor?.hidden ?? defaultHiddenTaskEditorFields);
        if (!prioritiesEnabled) next.add('priority');
        if (!timeEstimatesEnabled) next.add('timeEstimate');
        return next;
    }, [defaultHiddenTaskEditorFields, prioritiesEnabled, settings?.gtd?.taskEditor?.hidden, timeEstimatesEnabled]);
    const showProjectField = !hiddenTaskEditorFields.has('project');
    const showAreaField = !hiddenTaskEditorFields.has('area');
    const showContextsField = !hiddenTaskEditorFields.has('contexts');
    const showTagsField = !hiddenTaskEditorFields.has('tags');
    const showPriorityField = prioritiesEnabled && !hiddenTaskEditorFields.has('priority');
    const showEnergyLevelField = !hiddenTaskEditorFields.has('energyLevel');
    const showAssignedToField = !hiddenTaskEditorFields.has('assignedTo');
    const showTimeEstimateField = timeEstimatesEnabled && !hiddenTaskEditorFields.has('timeEstimate');
    const showProjectStep = showProjectField || showAreaField;
    const visibleScheduleFieldKeys = useMemo<InboxProcessingScheduleFieldKey[]>(() => {
        if (!scheduleEnabled) return [];
        const next: InboxProcessingScheduleFieldKey[] = [];
        if (!hiddenTaskEditorFields.has('startTime')) next.push('start');
        if (!hiddenTaskEditorFields.has('dueDate')) next.push('due');
        if (!hiddenTaskEditorFields.has('reviewAt')) next.push('review');
        return next;
    }, [hiddenTaskEditorFields, scheduleEnabled]);
    const showScheduleFields = visibleScheduleFieldKeys.length > 0;
    const showOrganizationStep = (
        (contextStepEnabled && (showContextsField || showTagsField))
        || showPriorityField
        || showEnergyLevelField
        || showAssignedToField
        || showTimeEstimateField
    );

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const matchesAreaFilter = useCallback(
        (task: Task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById),
        [resolvedAreaFilter, projectMap, areaById],
    );

    const filteredProjects = useMemo(() => {
        if (!projectSearch.trim()) return projects;
        const query = projectSearch.trim().toLowerCase();
        return projects.filter((project) => project.title.toLowerCase().includes(query));
    }, [projects, projectSearch]);

    const hasExactProjectMatch = useMemo(() => {
        if (!projectSearch.trim()) return false;
        const query = projectSearch.trim().toLowerCase();
        return projects.some((project) => project.title.toLowerCase() === query);
    }, [projects, projectSearch]);

    const activeAreas = useMemo(
        () => areas.filter((area) => !area.deletedAt).sort((a, b) => a.order - b.order),
        [areas],
    );

    const inboxCount = useMemo(() => (
        tasks.filter((task) => {
            if (task.status !== 'inbox' || task.deletedAt) return false;
            if (!matchesAreaFilter(task)) return false;
            return true;
        }).length
    ), [tasks, matchesAreaFilter]);

    const remainingInboxCount = useMemo(
        () => tasks.filter((task) => task.status === 'inbox' && !skippedIds.has(task.id) && matchesAreaFilter(task)).length,
        [tasks, skippedIds, matchesAreaFilter],
    );

    const resetProcessingSession = useCallback(() => {
        setProcessingMode(defaultProcessingMode);
        setProcessingTask(null);
        setProcessingStep('actionable');
        setStepHistory([]);
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        setSelectedContexts([]);
        setSelectedTags([]);
        setSelectedEnergyLevel(undefined);
        setSelectedAssignedTo('');
        setSelectedPriority(undefined);
        setSelectedTimeEstimate(undefined);
        setDelegateWho('');
        setDelegateFollowUp('');
        setProjectSearch('');
        setProcessingTitle('');
        setProcessingDescription('');
        setConvertToProject(false);
        setProjectTitleDraft('');
        setNextActionDraft('');
        setCustomContext('');
        setCustomTag('');
        setSelectedProjectId(null);
        setSelectedAreaId(null);
        setScheduleDate('');
        setScheduleTime('');
        setScheduleTimeDraft('');
        setDueDate('');
        setDueTime('');
        setDueTimeDraft('');
        setReviewDate('');
        setReviewTime('');
        setReviewTimeDraft('');
        setSkippedIds(new Set());
    }, [defaultProcessingMode]);

    const hydrateProcessingTask = useCallback((task: Task) => {
        setProcessingTask(task);
        setProcessingStep('refine');
        setStepHistory([]);
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        setSelectedContexts(task.contexts ?? []);
        setSelectedTags(task.tags ?? []);
        setSelectedEnergyLevel(task.energyLevel);
        setSelectedAssignedTo(task.assignedTo ?? '');
        setSelectedPriority(task.priority);
        setSelectedTimeEstimate(task.timeEstimate);
        setCustomContext('');
        setCustomTag('');
        setProjectSearch('');
        setProcessingTitle(task.title);
        setProcessingDescription(task.description || '');
        setConvertToProject(false);
        setProjectTitleDraft(task.title);
        setNextActionDraft('');
        setSelectedProjectId(task.projectId ?? null);
        setSelectedAreaId(task.projectId ? null : (task.areaId ?? null));
        const startDraft = getDateFieldDraft(task.startTime);
        setScheduleDate(startDraft.date);
        setScheduleTime(startDraft.time);
        setScheduleTimeDraft(startDraft.timeDraft);
        const dueDraft = getDateFieldDraft(task.dueDate);
        setDueDate(dueDraft.date);
        setDueTime(dueDraft.time);
        setDueTimeDraft(dueDraft.timeDraft);
        const reviewDraft = getDateFieldDraft(task.reviewAt);
        setReviewDate(reviewDraft.date);
        setReviewTime(reviewDraft.time);
        setReviewTimeDraft(reviewDraft.timeDraft);
    }, []);

    const suggestedContexts = useMemo(
        () => mergeSuggestedTokens(
            getRecentTaskTokens(tasks, (task) => task.contexts, 6, { prefix: '@' }),
            getFrequentTaskTokens(tasks, (task) => task.contexts, 6, { prefix: '@' }),
        ).slice(0, 8),
        [tasks],
    );

    const suggestedTags = useMemo(
        () => mergeSuggestedTokens(
            getRecentTaskTokens(tasks, (task) => task.tags, 6, { prefix: '#' }),
            getFrequentTaskTokens(tasks, (task) => task.tags, 6, { prefix: '#' }),
        ).slice(0, 8),
        [tasks],
    );

    const handleProcessingTimeCommit = useCallback((
        draft: string,
        committed: string,
        setDraft: (value: string) => void,
        setTime: (value: string) => void,
    ) => {
        const resolved = resolveCommittedTime(draft, committed);
        setDraft(resolved.timeDraft);
        setTime(resolved.time);
    }, []);

    const handleDateFieldChange = useCallback((
        value: string,
        setDateValue: (value: string) => void,
        setTimeValue: (value: string) => void,
        setTimeDraftValue: (value: string) => void,
        currentTime: string,
        currentTimeDraft: string,
    ) => {
        setDateValue(value);
        if (!value) {
            setTimeValue('');
            setTimeDraftValue('');
            return;
        }
        if (defaultScheduleTime && !currentTime && !currentTimeDraft) {
            setTimeValue(defaultScheduleTime);
            setTimeDraftValue(defaultScheduleTime);
        }
    }, [defaultScheduleTime]);

    const handleScheduleTimeCommit = useCallback(() => {
        handleProcessingTimeCommit(scheduleTimeDraft, scheduleTime, setScheduleTimeDraft, setScheduleTime);
    }, [handleProcessingTimeCommit, scheduleTime, scheduleTimeDraft]);

    const handleDueTimeCommit = useCallback(() => {
        handleProcessingTimeCommit(dueTimeDraft, dueTime, setDueTimeDraft, setDueTime);
    }, [dueTime, dueTimeDraft, handleProcessingTimeCommit]);

    const handleReviewTimeCommit = useCallback(() => {
        handleProcessingTimeCommit(reviewTimeDraft, reviewTime, setReviewTimeDraft, setReviewTime);
    }, [handleProcessingTimeCommit, reviewTime, reviewTimeDraft]);

    const handleScheduleDateChange = useCallback((value: string) => {
        handleDateFieldChange(value, setScheduleDate, setScheduleTime, setScheduleTimeDraft, scheduleTime, scheduleTimeDraft);
    }, [handleDateFieldChange, scheduleTime, scheduleTimeDraft]);

    const handleDueDateChange = useCallback((value: string) => {
        handleDateFieldChange(value, setDueDate, setDueTime, setDueTimeDraft, dueTime, dueTimeDraft);
    }, [dueTime, dueTimeDraft, handleDateFieldChange]);

    const handleReviewDateChange = useCallback((value: string) => {
        handleDateFieldChange(value, setReviewDate, setReviewTime, setReviewTimeDraft, reviewTime, reviewTimeDraft);
    }, [handleDateFieldChange, reviewTime, reviewTimeDraft]);

    const clearScheduleDate = useCallback(() => {
        setScheduleDate('');
        setScheduleTime('');
        setScheduleTimeDraft('');
    }, []);

    const clearDueDate = useCallback(() => {
        setDueDate('');
        setDueTime('');
        setDueTimeDraft('');
    }, []);

    const clearReviewDate = useCallback(() => {
        setReviewDate('');
        setReviewTime('');
        setReviewTimeDraft('');
    }, []);

    const scheduleFields = useMemo<InboxProcessingScheduleFieldsControls>(() => ({
        start: {
            date: scheduleDate,
            timeDraft: scheduleTimeDraft,
            onDateChange: handleScheduleDateChange,
            onTimeDraftChange: setScheduleTimeDraft,
            onTimeCommit: handleScheduleTimeCommit,
            onClear: clearScheduleDate,
        },
        due: {
            date: dueDate,
            timeDraft: dueTimeDraft,
            onDateChange: handleDueDateChange,
            onTimeDraftChange: setDueTimeDraft,
            onTimeCommit: handleDueTimeCommit,
            onClear: clearDueDate,
        },
        review: {
            date: reviewDate,
            timeDraft: reviewTimeDraft,
            onDateChange: handleReviewDateChange,
            onTimeDraftChange: setReviewTimeDraft,
            onTimeCommit: handleReviewTimeCommit,
            onClear: clearReviewDate,
        },
    }), [
        clearDueDate,
        clearReviewDate,
        clearScheduleDate,
        dueDate,
        dueTimeDraft,
        handleDueDateChange,
        handleDueTimeCommit,
        handleReviewDateChange,
        handleReviewTimeCommit,
        handleScheduleDateChange,
        handleScheduleTimeCommit,
        reviewDate,
        reviewTimeDraft,
        scheduleDate,
        scheduleTimeDraft,
    ]);

    const timeEstimateOptions = useMemo<TimeEstimate[]>(() => {
        const savedPresets = settings?.gtd?.timeEstimatePresets ?? [];
        const normalizedPresets = ALL_TIME_ESTIMATE_OPTIONS.filter((value) => savedPresets.includes(value));
        if (normalizedPresets.length > 0) {
            return selectedTimeEstimate && !normalizedPresets.includes(selectedTimeEstimate)
                ? [...normalizedPresets, selectedTimeEstimate]
                : normalizedPresets;
        }
        return selectedTimeEstimate && !ALL_TIME_ESTIMATE_OPTIONS.includes(selectedTimeEstimate)
            ? [...ALL_TIME_ESTIMATE_OPTIONS, selectedTimeEstimate]
            : ALL_TIME_ESTIMATE_OPTIONS;
    }, [selectedTimeEstimate, settings?.gtd?.timeEstimatePresets]);

    return {
        processingMode,
        setProcessingMode,
        processingTask,
        setProcessingTask,
        processingStep,
        setProcessingStep,
        stepHistory,
        setStepHistory,
        quickActionability,
        setQuickActionability,
        quickTwoMinuteChoice,
        setQuickTwoMinuteChoice,
        quickExecutionChoice,
        setQuickExecutionChoice,
        selectedContexts,
        setSelectedContexts,
        selectedTags,
        setSelectedTags,
        selectedEnergyLevel,
        setSelectedEnergyLevel,
        selectedAssignedTo,
        setSelectedAssignedTo,
        selectedPriority,
        setSelectedPriority,
        selectedTimeEstimate,
        setSelectedTimeEstimate,
        delegateWho,
        setDelegateWho,
        delegateFollowUp,
        setDelegateFollowUp,
        projectSearch,
        setProjectSearch,
        processingTitle,
        setProcessingTitle,
        processingDescription,
        setProcessingDescription,
        convertToProject,
        setConvertToProject,
        projectTitleDraft,
        setProjectTitleDraft,
        nextActionDraft,
        setNextActionDraft,
        customContext,
        setCustomContext,
        customTag,
        setCustomTag,
        selectedProjectId,
        setSelectedProjectId,
        selectedAreaId,
        setSelectedAreaId,
        skippedIds,
        setSkippedIds,
        defaultProcessingMode,
        twoMinuteEnabled,
        twoMinuteFirst,
        projectFirst,
        contextStepEnabled,
        scheduleEnabled,
        referenceEnabled,
        prioritiesEnabled,
        timeEstimatesEnabled,
        showProjectField,
        showAreaField,
        showContextsField,
        showTagsField,
        showPriorityField,
        showEnergyLevelField,
        showAssignedToField,
        showTimeEstimateField,
        showProjectStep,
        visibleScheduleFieldKeys,
        showScheduleFields,
        showOrganizationStep,
        areaById,
        projectMap,
        matchesAreaFilter,
        filteredProjects,
        hasExactProjectMatch,
        activeAreas,
        inboxCount,
        remainingInboxCount,
        resetProcessingSession,
        hydrateProcessingTask,
        suggestedContexts,
        suggestedTags,
        scheduleDate,
        scheduleTime,
        scheduleTimeDraft,
        dueDate,
        dueTime,
        dueTimeDraft,
        reviewDate,
        reviewTime,
        reviewTimeDraft,
        setScheduleTimeDraft,
        setDueTimeDraft,
        setReviewTimeDraft,
        handleScheduleTimeCommit,
        handleDueTimeCommit,
        handleReviewTimeCommit,
        scheduleFields,
        timeEstimateOptions,
    };
}
