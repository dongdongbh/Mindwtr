import { useCallback, useMemo, useRef, useState } from 'react';
import {
    createProcessInboxSession,
    createTaskDraft,
    getFrequentTaskTokens,
    getRecentTaskTokens,
    filterProjectsBySelectedArea,
    getProjectChoiceState,
    normalizeClockTimeInput,
    openProcessInboxTask,
    resolveDefaultNewTaskAreaId,
    resolveProcessInboxPlan,
    selectProcessInboxCandidates,
    setTaskDraftField,
    type AppData,
    type Area,
    resolveTimeEstimateOptions,
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
import { isTaskVisibleInInbox } from '@mindwtr/core';
import {
    getDateFieldDraft,
    mergeSuggestedTokens,
    resolveCommittedTime,
    type InboxProcessingVisibility,
} from './inbox-processing-utils';

type ProcessingMode = 'guided' | 'quick';


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
    const [dirtyScheduleFieldKeys, setDirtyScheduleFieldKeys] = useState<ReadonlySet<InboxProcessingScheduleFieldKey>>(
        () => new Set(),
    );

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
        () => selectProcessInboxCandidates(tasks, (task) => isTaskVisibleInInbox(task, { projectById: projectMap })),
        [projectMap, tasks],
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
        setDirtyScheduleFieldKeys(new Set());
    }, [defaultProcessingMode]);

    // The task the draft was hydrated from: a step's write merges against it.
    const processingBaseRef = useRef<Task | null>(null);
    // Read at hydrate time only, so a settings change never re-hydrates an open draft.
    const defaultAreaIdRef = useRef<string | undefined>(undefined);
    defaultAreaIdRef.current = resolveDefaultNewTaskAreaId(settings, areas);
    const hydrateProcessingTask = useCallback((
        task: Task,
        session?: ProcessInboxSession<ProcessingStep>,
    ) => {
        processingBaseRef.current = task;
        setProcessingSession((current) => openProcessInboxTask(session ?? current, task.id, 'refine'));
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        // Keep an area assigned while the task sat in the inbox; a project home
        // outranks the direct area (container exclusivity). A capture with neither
        // starts in the default area (#1445).
        const taskDraft = createTaskDraft(task);
        const defaultAreaId = defaultAreaIdRef.current;
        setDraft(task.projectId
            ? setTaskDraftField(taskDraft, 'areaId', '')
            : !task.areaId && defaultAreaId ? setTaskDraftField(taskDraft, 'areaId', defaultAreaId) : taskDraft);
        setCustomContext('');
        setCustomTag('');
        setProjectSearch('');
        setConvertToProject(false);
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
        setDirtyScheduleFieldKeys(new Set());
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

    const markScheduleFieldDirty = useCallback((field: InboxProcessingScheduleFieldKey) => {
        setDirtyScheduleFieldKeys((current) => {
            if (current.has(field)) return current;
            return new Set([...current, field]);
        });
    }, []);

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
        markScheduleFieldDirty('start');
        handleDateFieldChange(value, setScheduleDate, setScheduleTime, setScheduleTimeDraft, scheduleTime, scheduleTimeDraft);
    }, [handleDateFieldChange, markScheduleFieldDirty, scheduleTime, scheduleTimeDraft]);

    const handleDueDateChange = useCallback((value: string) => {
        markScheduleFieldDirty('due');
        handleDateFieldChange(value, setDueDate, setDueTime, setDueTimeDraft, dueTime, dueTimeDraft);
    }, [dueTime, dueTimeDraft, handleDateFieldChange, markScheduleFieldDirty]);

    const handleReviewDateChange = useCallback((value: string) => {
        markScheduleFieldDirty('review');
        handleDateFieldChange(value, setReviewDate, setReviewTime, setReviewTimeDraft, reviewTime, reviewTimeDraft);
    }, [handleDateFieldChange, markScheduleFieldDirty, reviewTime, reviewTimeDraft]);

    const clearScheduleDate = useCallback(() => {
        markScheduleFieldDirty('start');
        setScheduleDate('');
        setScheduleTime('');
        setScheduleTimeDraft('');
    }, [markScheduleFieldDirty]);

    const clearDueDate = useCallback(() => {
        markScheduleFieldDirty('due');
        setDueDate('');
        setDueTime('');
        setDueTimeDraft('');
    }, [markScheduleFieldDirty]);

    const clearReviewDate = useCallback(() => {
        markScheduleFieldDirty('review');
        setReviewDate('');
        setReviewTime('');
        setReviewTimeDraft('');
    }, [markScheduleFieldDirty]);

    const setScheduleDateOnly = useCallback(() => {
        markScheduleFieldDirty('start');
        setScheduleTime('');
        setScheduleTimeDraft('');
    }, [markScheduleFieldDirty]);

    const setDueDateOnly = useCallback(() => {
        markScheduleFieldDirty('due');
        setDueTime('');
        setDueTimeDraft('');
    }, [markScheduleFieldDirty]);

    const setReviewDateOnly = useCallback(() => {
        markScheduleFieldDirty('review');
        setReviewTime('');
        setReviewTimeDraft('');
    }, [markScheduleFieldDirty]);

    const handleScheduleTimeDraftChange = useCallback((value: string) => {
        markScheduleFieldDirty('start');
        setScheduleTimeDraft(value);
    }, [markScheduleFieldDirty]);

    const handleDueTimeDraftChange = useCallback((value: string) => {
        markScheduleFieldDirty('due');
        setDueTimeDraft(value);
    }, [markScheduleFieldDirty]);

    const handleReviewTimeDraftChange = useCallback((value: string) => {
        markScheduleFieldDirty('review');
        setReviewTimeDraft(value);
    }, [markScheduleFieldDirty]);

    const scheduleFields = useMemo<InboxProcessingScheduleFieldsControls>(() => ({
        start: {
            date: scheduleDate,
            timeDraft: scheduleTimeDraft,
            hasTime: Boolean(scheduleTime),
            onDateChange: handleScheduleDateChange,
            onTimeDraftChange: handleScheduleTimeDraftChange,
            onTimeCommit: handleScheduleTimeCommit,
            onClear: clearScheduleDate,
            onDateOnly: setScheduleDateOnly,
        },
        due: {
            date: dueDate,
            timeDraft: dueTimeDraft,
            hasTime: Boolean(dueTime),
            onDateChange: handleDueDateChange,
            onTimeDraftChange: handleDueTimeDraftChange,
            onTimeCommit: handleDueTimeCommit,
            onClear: clearDueDate,
            onDateOnly: setDueDateOnly,
        },
        review: {
            date: reviewDate,
            timeDraft: reviewTimeDraft,
            hasTime: Boolean(reviewTime),
            onDateChange: handleReviewDateChange,
            onTimeDraftChange: handleReviewTimeDraftChange,
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
        handleDueTimeDraftChange,
        handleDueTimeCommit,
        handleReviewDateChange,
        handleReviewTimeDraftChange,
        handleReviewTimeCommit,
        handleScheduleDateChange,
        handleScheduleTimeDraftChange,
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

    const timeEstimateOptions = useMemo<TimeEstimate[]>(
        () => resolveTimeEstimateOptions(draft.timeEstimate || undefined),
        [draft.timeEstimate],
    );

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
        processingBaseRef,
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
        dirtyScheduleFieldKeys,
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
