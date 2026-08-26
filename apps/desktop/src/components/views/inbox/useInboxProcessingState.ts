import { useCallback, useMemo, useState } from 'react';
import {
    createProcessInboxSession,
    createTaskDraft,
    getFrequentTaskTokens,
    getRecentTaskTokens,
    filterProjectsBySelectedArea,
    getProjectChoiceState,
    normalizeClockTimeInput,
    openProcessInboxTask,
    resolveProcessInboxPlan,
    selectProcessInboxCandidates,
    setTaskDraftField,
    type AppData,
    type Area,
    type ProcessInboxSession,
    type Project,
    type Task,
    type TaskDraft,
    type TaskDraftSetter,
    type TimeEstimate,
} from '@mindwtr/core';

import type {
    QuickActionabilityChoice,
    QuickExecutionChoice,
    QuickTwoMinuteChoice,
} from '../../InboxProcessingQuickPanel';
import type { InboxProcessingScheduleFieldKey, InboxProcessingScheduleFieldsControls } from '../../InboxProcessingScheduleFields';
import type { ProcessingStep } from '../../InboxProcessingWizard';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from '@mindwtr/core';
import {
    getDateFieldDraft,
    mergeSuggestedTokens,
    resolveCommittedTime,
    type InboxProcessingVisibility,
} from './inbox-processing-utils';

type ProcessingMode = 'guided' | 'quick';

const ALL_TIME_ESTIMATE_OPTIONS: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];

/** Nothing being processed: an all-empty draft built by the same core factory
 *  that hydrates a real task, so reset and hydrate cannot drift apart. */
const EMPTY_PROCESSING_DRAFT: TaskDraft = createTaskDraft({
    id: '',
    title: '',
    status: 'inbox',
    createdAt: '',
    updatedAt: '',
} as Task);

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
    const [processingSession, setProcessingSession] = useState<ProcessInboxSession<ProcessingStep>>(
        () => createProcessInboxSession('actionable'),
    );
    const [quickActionability, setQuickActionability] = useState<QuickActionabilityChoice>('actionable');
    const [quickTwoMinuteChoice, setQuickTwoMinuteChoice] = useState<QuickTwoMinuteChoice>('no');
    const [quickExecutionChoice, setQuickExecutionChoice] = useState<QuickExecutionChoice>('defer');
    // Every task field the flow edits lives in one core draft (title,
    // description, contexts, tags, priority, energy, assignee, estimate,
    // project, area). The date fields keep their own draft/committed pairs
    // below because their inputs commit on blur.
    const [draft, setDraft] = useState<TaskDraft>(EMPTY_PROCESSING_DRAFT);
    const [delegateWho, setDelegateWho] = useState('');
    const [delegateFollowUp, setDelegateFollowUp] = useState('');
    const [projectSearch, setProjectSearch] = useState('');
    const [convertToProject, setConvertToProject] = useState(false);
    const [projectTitleDraft, setProjectTitleDraft] = useState('');
    const [nextActionDraft, setNextActionDraft] = useState('');
    const [extraActionDrafts, setExtraActionDrafts] = useState<string[]>([]);
    const [customContext, setCustomContext] = useState('');
    const [customTag, setCustomTag] = useState('');
    const [scheduleDate, setScheduleDate] = useState('');
    const [scheduleTime, setScheduleTime] = useState('');
    const [scheduleTimeDraft, setScheduleTimeDraft] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [dueTime, setDueTime] = useState('');
    const [dueTimeDraft, setDueTimeDraft] = useState('');
    const [reviewDate, setReviewDate] = useState('');
    const [reviewTime, setReviewTime] = useState('');
    const [reviewTimeDraft, setReviewTimeDraft] = useState('');

    const defaultScheduleTime = normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '';
    const processInboxPlan = useMemo(() => resolveProcessInboxPlan(settings), [settings]);
    const {
        defaultMode: defaultProcessingMode,
        twoMinuteEnabled,
        twoMinuteFirst,
        projectFirst,
        contextStepEnabled,
        scheduleEnabled,
        prioritiesEnabled,
        timeEstimatesEnabled,
        referenceEnabled,
        showProjectStep,
        showOrganizationStep,
        showScheduleFields,
    } = processInboxPlan;
    const {
        project: showProjectField,
        area: showAreaField,
        contexts: showContextsField,
        tags: showTagsField,
        priority: showPriorityField,
        energyLevel: showEnergyLevelField,
        assignedTo: showAssignedToField,
        timeEstimate: showTimeEstimateField,
    } = processInboxPlan.visibleFields;
    const visibleScheduleFieldKeys = useMemo<InboxProcessingScheduleFieldKey[]>(() => (
        processInboxPlan.visibleScheduleFields.map((field) => {
            if (field === 'startTime') return 'start';
            if (field === 'dueDate') return 'due';
            return 'review';
        })
    ), [processInboxPlan.visibleScheduleFields]);
    const visibility = useMemo<InboxProcessingVisibility>(() => ({
        showProjectField,
        showAreaField,
        showContextsField,
        showTagsField,
        showPriorityField,
        showEnergyLevelField,
        showAssignedToField,
        showTimeEstimateField,
        showScheduleFields,
        showReferenceOption: referenceEnabled,
    }), [
        referenceEnabled,
        showAreaField,
        showAssignedToField,
        showContextsField,
        showEnergyLevelField,
        showPriorityField,
        showProjectField,
        showScheduleFields,
        showTagsField,
        showTimeEstimateField,
    ]);

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

    /**
     * The one write path into the processing draft: the core reducer applies
     * the field descriptor cascades, and the inbox adds its own container rule
     * on top — picking an area drops a project that lives outside it.
     */
    const setField = useCallback<TaskDraftSetter>((field, value) => {
        setDraft((current) => {
            const next = setTaskDraftField(current, field, value);
            if (field !== 'areaId' || !next.areaId || !next.projectId) return next;
            return projectMap.get(next.projectId)?.areaId === next.areaId
                ? next
                : setTaskDraftField(next, 'projectId', '');
        });
    }, [projectMap]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilterSelection(settings?.filters, areas),
        [settings?.filters, areas],
    );
    const areaVisibility = useMemo(
        () => ({ areaById, projectById: projectMap, resolvedAreaFilter }),
        [areaById, projectMap, resolvedAreaFilter],
    );
    const processingStep = processingSession.currentStep ?? 'actionable';
    const stepHistory = processingSession.stepHistory;
    const skippedIds = processingSession.skippedTaskIds;

    const { filteredProjects, exactMatch: exactProjectMatch } = useMemo(
        () => getProjectChoiceState(
            filterProjectsBySelectedArea(projects, draft.areaId || undefined),
            projectSearch,
            projects,
        ),
        [draft.areaId, projects, projectSearch],
    );
    const hasExactProjectMatch = Boolean(exactProjectMatch);

    const activeAreas = useMemo(
        () => areas.filter((area) => !area.deletedAt).sort((a, b) => a.order - b.order),
        [areas],
    );

    const eligibleInboxTasks = useMemo(
        () => selectProcessInboxCandidates(tasks, (task) => isTaskVisibleInArea(task, areaVisibility)),
        [areaVisibility, tasks],
    );
    const processingTask = useMemo(
        () => eligibleInboxTasks.find((task) => task.id === processingSession.currentTaskId) ?? null,
        [eligibleInboxTasks, processingSession.currentTaskId],
    );
    const inboxCount = eligibleInboxTasks.length;

    const remainingInboxCount = useMemo(
        () => eligibleInboxTasks.filter((task) => !skippedIds.has(task.id)).length,
        [eligibleInboxTasks, skippedIds],
    );

    const resetProcessingSession = useCallback(() => {
        setProcessingMode(defaultProcessingMode);
        setProcessingSession(createProcessInboxSession('actionable'));
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        setDraft(EMPTY_PROCESSING_DRAFT);
        setDelegateWho('');
        setDelegateFollowUp('');
        setProjectSearch('');
        setConvertToProject(false);
        setProjectTitleDraft('');
        setNextActionDraft('');
        setExtraActionDrafts([]);
        setCustomContext('');
        setCustomTag('');
        setScheduleDate('');
        setScheduleTime('');
        setScheduleTimeDraft('');
        setDueDate('');
        setDueTime('');
        setDueTimeDraft('');
        setReviewDate('');
        setReviewTime('');
        setReviewTimeDraft('');
    }, [defaultProcessingMode]);

    const hydrateProcessingTask = useCallback((
        task: Task,
        session?: ProcessInboxSession<ProcessingStep>,
    ) => {
        setProcessingSession((current) => openProcessInboxTask(session ?? current, task.id, 'refine'));
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        // Keep an area assigned while the task sat in the inbox; a project home
        // outranks the direct area (container exclusivity).
        const taskDraft = createTaskDraft(task);
        setDraft(task.projectId ? setTaskDraftField(taskDraft, 'areaId', '') : taskDraft);
        setCustomContext('');
        setCustomTag('');
        setProjectSearch('');
        setConvertToProject(false);
        setProjectTitleDraft(task.title);
        setNextActionDraft('');
        setExtraActionDrafts([]);
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

    const setScheduleDateOnly = useCallback(() => {
        setScheduleTime('');
        setScheduleTimeDraft('');
    }, []);

    const setDueDateOnly = useCallback(() => {
        setDueTime('');
        setDueTimeDraft('');
    }, []);

    const setReviewDateOnly = useCallback(() => {
        setReviewTime('');
        setReviewTimeDraft('');
    }, []);

    const scheduleFields = useMemo<InboxProcessingScheduleFieldsControls>(() => ({
        start: {
            date: scheduleDate,
            timeDraft: scheduleTimeDraft,
            hasTime: Boolean(scheduleTime),
            onDateChange: handleScheduleDateChange,
            onTimeDraftChange: setScheduleTimeDraft,
            onTimeCommit: handleScheduleTimeCommit,
            onClear: clearScheduleDate,
            onDateOnly: setScheduleDateOnly,
        },
        due: {
            date: dueDate,
            timeDraft: dueTimeDraft,
            hasTime: Boolean(dueTime),
            onDateChange: handleDueDateChange,
            onTimeDraftChange: setDueTimeDraft,
            onTimeCommit: handleDueTimeCommit,
            onClear: clearDueDate,
            onDateOnly: setDueDateOnly,
        },
        review: {
            date: reviewDate,
            timeDraft: reviewTimeDraft,
            hasTime: Boolean(reviewTime),
            onDateChange: handleReviewDateChange,
            onTimeDraftChange: setReviewTimeDraft,
            onTimeCommit: handleReviewTimeCommit,
            onClear: clearReviewDate,
            onDateOnly: setReviewDateOnly,
        },
    }), [
        clearDueDate,
        clearReviewDate,
        clearScheduleDate,
        dueDate,
        dueTime,
        dueTimeDraft,
        handleDueDateChange,
        handleDueTimeCommit,
        handleReviewDateChange,
        handleReviewTimeCommit,
        handleScheduleDateChange,
        handleScheduleTimeCommit,
        reviewDate,
        reviewTime,
        reviewTimeDraft,
        scheduleDate,
        scheduleTime,
        scheduleTimeDraft,
        setDueDateOnly,
        setReviewDateOnly,
        setScheduleDateOnly,
    ]);

    const timeEstimateOptions = useMemo<TimeEstimate[]>(() => {
        const selectedTimeEstimate = draft.timeEstimate || undefined;
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
    }, [draft.timeEstimate, settings?.gtd?.timeEstimatePresets]);

    return {
        processInboxPlan,
        processingMode,
        setProcessingMode,
        processingSession,
        setProcessingSession,
        processingTask,
        processingStep,
        stepHistory,
        quickActionability,
        setQuickActionability,
        quickTwoMinuteChoice,
        setQuickTwoMinuteChoice,
        quickExecutionChoice,
        setQuickExecutionChoice,
        draft,
        setField,
        delegateWho,
        setDelegateWho,
        delegateFollowUp,
        setDelegateFollowUp,
        projectSearch,
        setProjectSearch,
        convertToProject,
        setConvertToProject,
        projectTitleDraft,
        setProjectTitleDraft,
        nextActionDraft,
        setNextActionDraft,
        extraActionDrafts,
        setExtraActionDrafts,
        customContext,
        setCustomContext,
        customTag,
        setCustomTag,
        skippedIds,
        defaultProcessingMode,
        twoMinuteEnabled,
        twoMinuteFirst,
        projectFirst,
        contextStepEnabled,
        scheduleEnabled,
        prioritiesEnabled,
        timeEstimatesEnabled,
        visibility,
        showProjectStep,
        visibleScheduleFieldKeys,
        showOrganizationStep,
        areaById,
        projectMap,
        filteredProjects,
        hasExactProjectMatch,
        activeAreas,
        inboxCount,
        eligibleInboxTasks,
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
