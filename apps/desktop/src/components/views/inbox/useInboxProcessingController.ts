import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    advanceProcessInboxSession,
    addBreadcrumb,
    buildQuickAddParseOptions,
    commitProcessInboxWorkflowEvent,
    createTaskSimilarityIndex,
    DEFAULT_PROJECT_COLOR,
    enterProcessInboxStep,
    getPersonOptionNames,
    findSimilarTasks,
    goBackProcessInboxStep,
    isSelectableProjectForTaskAssignment,
    isDueForReview,
    isProcessInboxReturningTask,
    parseProcessInboxTitleInput,
    saveTaskDraftOntoLatest,
    prepareProcessInboxCommit,
    setTaskViewSectionId,
    startProcessInboxSession,
    tFallback,
    useTaskStore,
    type AppData,
    type Area,
    type Project,
    type ProcessInboxDecision,
    type ProcessInboxWorkflowFields,
    type StoreActionResult,
    type Task,
} from '@mindwtr/core';

import type { InboxProcessingQuickPanelProps } from '../../InboxProcessingQuickPanel';
import type { InboxProcessingWizardProps, ProcessingStep } from '../../InboxProcessingWizard';
import { reportError } from '../../../lib/report-error';
import { isTauriRuntime } from '../../../lib/runtime';
import { useUiStore } from '../../../store/ui-store';
import {
    buildDateTimeUpdate,
    formatTokenListInput,
    parseContextsInput,
    parseTagsInput,
    parseTokenListInput,
    resolveDelegateEmail,
    type InboxProcessingOptionLists,
} from './inbox-processing-utils';
import { useInboxProcessingState } from './useInboxProcessingState';
import { createSomedaySection } from '../../../lib/someday-section-actions';

/** Organization picks a finished session must not hand to the next one. */
const CLEARED_ON_SESSION_END = ['contexts', 'tags', 'energyLevel', 'assignedTo', 'priority', 'timeEstimate'] as const;

type UseInboxProcessingControllerParams = {
    t: (key: string) => string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<StoreActionResult>;
    deleteTask: (id: string) => Promise<StoreActionResult>;
    allContexts: string[];
    allTags: string[];
    isProcessing: boolean;
    setIsProcessing: (value: boolean) => void;
};

type UseInboxProcessingControllerResult = {
    inboxCount: number;
    quickPanelProps: InboxProcessingQuickPanelProps | null;
    showStartButton: boolean;
    startProcessing: () => void;
    wizardProps: InboxProcessingWizardProps;
};

export function useInboxProcessingController({
    t,
    tasks,
    projects,
    areas,
    settings,
    addProject,
    addTask,
    updateTask,
    deleteTask,
    allContexts,
    allTags,
    isProcessing,
    setIsProcessing,
}: UseInboxProcessingControllerParams): UseInboxProcessingControllerResult {
    const showToast = useUiStore((state) => state.showToast);
    const projectConversionInFlightRef = useRef(false);
    const allTasks = useTaskStore((state) => state._allTasks);
    const people = useTaskStore((state) => state.people);
    const addPerson = useTaskStore((state) => state.addPerson);
    const personOptions = useMemo(() => getPersonOptionNames(people, tasks), [people, tasks]);
    const {
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
        twoMinuteEnabled,
        twoMinuteFirst,
        projectFirst,
        scheduleEnabled,
        visibility,
        showProjectStep,
        visibleScheduleFieldKeys,
        showOrganizationStep,
        areaById,
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
        handleScheduleTimeCommit,
        handleDueTimeCommit,
        handleReviewTimeCommit,
        scheduleFields,
        timeEstimateOptions,
    } = useInboxProcessingState({
        tasks,
        projects,
        areas,
        settings,
    });
    const { showAreaField, showContextsField, showProjectField, showTagsField } = visibility;
    const quickAddParseOptions = useMemo(
        () => buildQuickAddParseOptions(settings, { tasks, people }),
        [people, settings, tasks],
    );
    const parseProcessingTitle = useCallback(
        (input: string) => parseProcessInboxTitleInput(input, {
            projects,
            areas,
            parseOptions: quickAddParseOptions,
        }),
        [areas, projects, quickAddParseOptions],
    );
    const parsedTitle = useMemo(
        () => parseProcessingTitle(draft.title),
        [draft.title, parseProcessingTitle],
    );
    const isReturningItem = Boolean(processingTask && isProcessInboxReturningTask(processingTask));
    // The draft holds the raw token text; the commit path needs the parsed
    // lists, keyed on the text so callbacks keep their identity between edits.
    const selectedContexts = useMemo(() => parseContextsInput(draft.contexts), [draft.contexts]);
    const selectedTags = useMemo(() => parseTagsInput(draft.tags), [draft.tags]);
    const similarityIndex = useMemo(
        () => (isProcessing ? createTaskSimilarityIndex(allTasks) : null),
        [allTasks, isProcessing],
    );
    const similarTasks = useMemo(() => (
        isProcessing && processingTask && similarityIndex
            ? findSimilarTasks(similarityIndex, draft.title, processingTask.id)
            : []
    ), [draft.title, isProcessing, processingTask, similarityIndex]);

    useEffect(() => {
        if (isProcessing) return;
        resetProcessingSession();
    }, [isProcessing, resetProcessingSession]);

    const startProcessing = useCallback(() => {
        if (eligibleInboxTasks.length === 0) return;
        const session = startProcessInboxSession(eligibleInboxTasks, { entryStep: 'refine' });
        hydrateProcessingTask(eligibleInboxTasks[0], session);
        addBreadcrumb('inbox:start');
        setIsProcessing(true);
    }, [eligibleInboxTasks, hydrateProcessingTask, setIsProcessing]);

    const closeProcessing = useCallback(() => {
        setIsProcessing(false);
    }, [setIsProcessing]);

    const applySessionTransition = useCallback((nextSession: typeof processingSession) => {
        const nextTask = nextSession.currentTaskId
            ? eligibleInboxTasks.find((task) => task.id === nextSession.currentTaskId)
            : undefined;
        if (nextTask) {
            hydrateProcessingTask(nextTask, nextSession);
            return;
        }
        addBreadcrumb('inbox:done');
        setProcessingSession(nextSession);
        setIsProcessing(false);
        // Queue drained: drop the organization picks so they cannot leak into a
        // later session (closing also resets the whole draft one tick later).
        for (const field of CLEARED_ON_SESSION_END) setField(field, '');
    }, [
        eligibleInboxTasks,
        hydrateProcessingTask,
        setField,
        setIsProcessing,
        setProcessingSession,
    ]);

    useEffect(() => {
        if (!isProcessing || processingTask) return;
        applySessionTransition(advanceProcessInboxSession(
            processingSession,
            eligibleInboxTasks,
            { entryStep: 'refine' },
        ));
    }, [applySessionTransition, eligibleInboxTasks, isProcessing, processingSession, processingTask]);

    const processNext = useCallback(() => {
        applySessionTransition(advanceProcessInboxSession(
            processingSession,
            eligibleInboxTasks,
            { entryStep: 'refine' },
        ));
    }, [applySessionTransition, eligibleInboxTasks, processingSession]);

    const buildScheduleUpdates = useCallback(
        () => (scheduleEnabled
            ? {
                startTime: buildDateTimeUpdate(scheduleDate, scheduleTimeDraft, scheduleTime),
                dueDate: buildDateTimeUpdate(dueDate, dueTimeDraft, dueTime),
                reviewAt: buildDateTimeUpdate(reviewDate, reviewTimeDraft, reviewTime),
            }
            : {}),
        [
            dueDate,
            dueTime,
            dueTimeDraft,
            reviewDate,
            reviewTime,
            reviewTimeDraft,
            scheduleDate,
            scheduleEnabled,
            scheduleTime,
            scheduleTimeDraft,
        ],
    );

    const applyWorkflowDecision = useCallback(async (
        decision: ProcessInboxDecision,
        options: {
            fields?: ProcessInboxWorkflowFields;
            titleInput?: string;
            fallbackTitle?: string;
            clearStaleReviewAt?: boolean;
            advance?: boolean;
        } = {},
    ): Promise<boolean> => {
        if (!processingTask) return false;
        // The same draft-to-write builder the mobile modal uses, so both
        // platforms write the same fields for the same input.
        const prepared = prepareProcessInboxCommit({
            task: processingTask,
            plan: processInboxPlan,
            decision,
            title: draft.title,
            description: draft.description,
            parseTitle: (input) => (input === draft.title ? parsedTitle : parseProcessingTitle(input)),
            selection: {
                projectId: draft.projectId || null,
                areaId: draft.areaId || null,
                contexts: selectedContexts,
                tags: selectedTags,
                priority: draft.priority || undefined,
                energyLevel: draft.energyLevel || undefined,
                assignedTo: draft.assignedTo,
                timeEstimate: draft.timeEstimate || undefined,
            },
            scheduleUpdates: buildScheduleUpdates(),
            dirtyScheduleFields: new Set([
                ...(dirtyScheduleFieldKeys.has('start') ? ['startTime' as const] : []),
                ...(dirtyScheduleFieldKeys.has('due') ? ['dueDate' as const] : []),
                ...(dirtyScheduleFieldKeys.has('review') ? ['reviewAt' as const] : []),
            ]),
            options: {
                fields: options.fields,
                titleOverride: options.titleInput,
                fallbackTitle: options.fallbackTitle,
                clearStaleReviewAt: options.clearStaleReviewAt,
            },
        });
        if (!prepared.ok) {
            if (prepared.reason === 'invalid-date-command') {
                showToast(`${t('quickAdd.invalidDateCommand')}: ${prepared.invalidDateCommands.join(', ')}`, 'error');
            } else if (prepared.reason === 'later-start-required') {
                showToast(tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'), 'error');
            }
            return false;
        }
        // The write as one store command, merged field by field onto the row as stored when it is admitted, against
        // the task the draft was hydrated from (core's mergeTaskDraftOntoLatest, as mobile's): a field another device
        // changed is written only if the step changed it too; tags and contexts merge by token, and
        // attachments by mergeTaskDraftAttachments, which appends the title's /link attachments to the latest list. A
        // token or an attachment a sync save brought stays.
        const base = processingBaseRef.current?.id === processingTask.id ? processingBaseRef.current : processingTask;
        const updateTaskFromDraft = (id: string, updates: Partial<Task>) => saveTaskDraftOntoLatest(id, base, updates, {
            write: (taskId, merged): Promise<StoreActionResult> | StoreActionResult => (Object.keys(merged).length > 0
                ? updateTask(taskId, merged) : { success: true, id: taskId }),
            keepUntouched: true,
        });
        try {
            const outcome = await commitProcessInboxWorkflowEvent(
                processingSession,
                eligibleInboxTasks,
                prepared.event,
                { deleteTask, updateTask: updateTaskFromDraft },
                {
                    entryStep: 'refine',
                    taskUpdates: prepared.taskUpdates,
                    advance: options.advance,
                },
            );
            if (!outcome.writeResult.success) {
                showToast(outcome.writeResult.error || t('task.updateFailed'), 'error');
                return false;
            }
            if (options.advance !== false) applySessionTransition(outcome.session);
            return true;
        } catch (error) {
            reportError('Failed to commit inbox processing decision', error);
            showToast(t('task.updateFailed'), 'error');
            return false;
        }
    }, [
        applySessionTransition,
        buildScheduleUpdates,
        deleteTask,
        dirtyScheduleFieldKeys,
        draft.areaId,
        draft.assignedTo,
        draft.description,
        draft.energyLevel,
        draft.priority,
        draft.projectId,
        draft.timeEstimate,
        draft.title,
        eligibleInboxTasks,
        parseProcessingTitle,
        parsedTitle,
        processInboxPlan,
        processingSession,
        processingTask,
        selectedContexts,
        selectedTags,
        showToast,
        t,
        updateTask,
    ]);

    const handleSkip = useCallback(() => {
        void applyWorkflowDecision({ type: 'skip' });
    }, [applyWorkflowDecision]);

    const goToStep = useCallback((nextStep: ProcessingStep) => {
        setProcessingSession((current) => enterProcessInboxStep(current, nextStep));
    }, [setProcessingSession]);

    const goBack = useCallback(() => {
        setProcessingSession((current) => goBackProcessInboxStep(current));
    }, [setProcessingSession]);

    const buildSomedayFields = useCallback((): ProcessInboxWorkflowFields => ({
        viewSectionIds: setTaskViewSectionId(
            processingTask?.viewSectionIds,
            'someday',
            draft.viewSectionIds?.someday,
        ),
    }), [draft.viewSectionIds?.someday, processingTask?.viewSectionIds]);

    const handleNotActionable = useCallback(async (action: 'trash' | 'someday' | 'reference') => {
        if (!processingTask) return;
        if (action === 'trash') {
            await applyWorkflowDecision({ type: 'discard' });
            return;
        }
        if (action === 'reference') {
            if (
                processingMode === 'guided'
                && (showContextsField || showTagsField || showProjectField || showAreaField)
            ) {
                goToStep('reference');
                return;
            }
            await applyWorkflowDecision({ type: 'reference' });
            return;
        }
        if (processingMode === 'guided') {
            goToStep('someday');
            return;
        }
        await applyWorkflowDecision({ type: 'someday' }, {
            fields: buildSomedayFields(),
            clearStaleReviewAt: isDueForReview(processingTask.reviewAt),
        });
    }, [
        applyWorkflowDecision,
        buildSomedayFields,
        goToStep,
        processingMode,
        processingTask,
        showAreaField,
        showContextsField,
        showProjectField,
        showTagsField,
    ]);

    const handleConfirmReference = useCallback(async () => {
        if (!processingTask) return;
        await applyWorkflowDecision({ type: 'reference' });
    }, [applyWorkflowDecision, processingTask]);

    const handleConfirmSomeday = useCallback(async () => {
        if (!processingTask) return;
        await applyWorkflowDecision({ type: 'someday' }, {
            fields: buildSomedayFields(),
            clearStaleReviewAt: isDueForReview(processingTask.reviewAt),
        });
    }, [applyWorkflowDecision, buildSomedayFields, processingTask]);

    const handleIncubate = useCallback(async () => {
        if (!processingTask) return;
        handleReviewTimeCommit();
        const reviewAt = buildDateTimeUpdate(reviewDate, reviewTimeDraft, reviewTime);
        if (!reviewAt) {
            showToast(tFallback(t, 'process.incubateDateRequired', 'Choose a date to bring this back.'), 'error');
            return;
        }
        await applyWorkflowDecision({ type: 'someday' }, {
            fields: { ...buildSomedayFields(), reviewAt },
        });
    }, [
        applyWorkflowDecision,
        buildSomedayFields,
        handleReviewTimeCommit,
        processingTask,
        reviewDate,
        reviewTime,
        reviewTimeDraft,
        showToast,
        t,
    ]);

    const handleLater = useCallback(async () => {
        if (!processingTask) return;
        handleScheduleTimeCommit();
        const startTime = buildDateTimeUpdate(scheduleDate, scheduleTimeDraft, scheduleTime);
        await applyWorkflowDecision({ type: 'later' }, { fields: { startTime } });
    }, [
        applyWorkflowDecision,
        handleScheduleTimeCommit,
        processingTask,
        scheduleDate,
        scheduleTime,
        scheduleTimeDraft,
    ]);

    const getInitialGuidedStep = useCallback<() => ProcessingStep>(() => (
        processInboxPlan.initialGuidedStep === 'two-minute' ? 'twomin' : 'actionable'
    ), [processInboxPlan.initialGuidedStep]);

    const continueFromProjectCheck = useCallback(() => {
        if (!twoMinuteEnabled) {
            goToStep('decide');
            return;
        }
        goToStep(twoMinuteFirst ? 'decide' : 'twomin');
    }, [goToStep, twoMinuteEnabled, twoMinuteFirst]);

    const handleActionable = useCallback(() => {
        goToStep('projectcheck');
    }, [goToStep]);

    const handleProjectCheckNo = useCallback(() => {
        continueFromProjectCheck();
    }, [continueFromProjectCheck]);

    const handleProjectCheckYes = useCallback(() => {
        const baseTitle = parsedTitle.title.trim() || draft.title.trim() || processingTask?.title || '';
        setConvertToProject(true);
        setNextActionDraft(baseTitle);
        setExtraActionDrafts([]);
        goToStep('project');
    }, [draft.title, goToStep, parsedTitle.title, processingTask?.title, setExtraActionDrafts]);

    const handleTwoMinDone = useCallback(async () => {
        if (!processingTask) return;
        await applyWorkflowDecision({ type: 'complete' });
    }, [applyWorkflowDecision, processingTask]);

    const handleTwoMinNo = useCallback(() => {
        goToStep(twoMinuteFirst ? 'actionable' : 'decide');
    }, [goToStep, twoMinuteFirst]);

    const handleDelegate = useCallback(() => {
        setDelegateWho('');
        setDelegateFollowUp('');
        goToStep('delegate');
    }, [goToStep]);

    const handleConfirmWaiting = useCallback(async () => {
        if (!processingTask) return;
        const who = delegateWho.trim();
        const scheduleUpdates = buildScheduleUpdates();
        const applied = await applyWorkflowDecision({
            type: 'waiting',
            followUpAt: delegateFollowUp
                ? new Date(`${delegateFollowUp}T09:00:00`).toISOString()
                : undefined,
        }, {
            fields: {
                ...scheduleUpdates,
                assignedTo: who || undefined,
            },
        });
        if (applied) {
            setDelegateWho('');
            setDelegateFollowUp('');
        }
    }, [
        applyWorkflowDecision,
        buildScheduleUpdates,
        delegateFollowUp,
        delegateWho,
        processingTask,
    ]);

    const handleDelegateBack = useCallback(() => {
        goBack();
    }, [goBack]);

    const handleSendDelegateRequest = useCallback(async () => {
        if (!processingTask) return;
        const title = draft.title.trim() || processingTask.title;
        const baseDescription = draft.description.trim() || processingTask.description || '';
        const who = delegateWho.trim();
        const greeting = who ? `Hi ${who},` : 'Hi,';
        const bodyParts = [
            greeting,
            '',
            `Could you please handle: ${title}`,
            baseDescription ? `\nDetails:\n${baseDescription}` : '',
            '',
            'Thanks!',
        ];
        const body = bodyParts.join('\n');
        const subject = `Delegation: ${title}`;
        // The saved person's mailto: reference doubles as the recipient; the
        // shell-open scope also requires one (a bare "mailto:?..." is refused).
        const email = resolveDelegateEmail(people, who);
        const mailto = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        if (!isTauriRuntime()) {
            window.open(mailto);
            return;
        }
        if (email) {
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(mailto);
                return;
            } catch {
                // No mail handler (or scope refusal) — fall through to the clipboard.
            }
        }
        try {
            await navigator.clipboard.writeText(`${subject}\n\n${body}`);
            showToast(tFallback(t, 'process.delegateRequestCopied', 'Request copied — paste it into an email or chat.'), 'success');
        } catch (error) {
            reportError('Failed to prepare delegation request', error);
            showToast(tFallback(t, 'process.delegateSendError', 'Could not prepare the request.'), 'error');
        }
    }, [delegateWho, draft.description, draft.title, people, processingTask, showToast, t]);

    const updateSelectedContexts = useCallback((contexts: string[]) => {
        setField('contexts', formatTokenListInput(contexts));
    }, [setField]);

    const updateSelectedTags = useCallback((tags: string[]) => {
        setField('tags', formatTokenListInput(tags));
    }, [setField]);

    const toggleTag = useCallback((tag: string) => {
        const nextTags = selectedTags.includes(tag)
            ? selectedTags.filter((item) => item !== tag)
            : [...selectedTags, tag];
        updateSelectedTags(nextTags);
    }, [selectedTags, updateSelectedTags]);

    const toggleContext = useCallback((ctx: string) => {
        if (ctx.startsWith('#')) {
            toggleTag(ctx);
            return;
        }
        const nextContexts = selectedContexts.includes(ctx)
            ? selectedContexts.filter((item) => item !== ctx)
            : [...selectedContexts, ctx];
        updateSelectedContexts(nextContexts);
    }, [selectedContexts, toggleTag, updateSelectedContexts]);

    const addCustomContext = useCallback((value?: string) => {
        const contexts = parseTokenListInput(value ?? customContext, '@');
        if (contexts.length > 0) {
            updateSelectedContexts(Array.from(new Set([...selectedContexts, ...contexts])));
        }
        setCustomContext('');
    }, [customContext, selectedContexts, setCustomContext, updateSelectedContexts]);

    const addCustomTag = useCallback((value?: string) => {
        const tags = parseTokenListInput(value ?? customTag, '#');
        if (tags.length > 0) {
            updateSelectedTags(Array.from(new Set([...selectedTags, ...tags])));
        }
        setCustomTag('');
    }, [customTag, selectedTags, setCustomTag, updateSelectedTags]);

    const handleSetProject = useCallback(async (projectId: string | null) => {
        if (!processingTask) return;
        await applyWorkflowDecision({ type: 'next' }, {
            fields: { projectId: projectId || undefined },
        });
    }, [
        applyWorkflowDecision,
        processingTask,
    ]);

    const handleConfirmContexts = useCallback(() => {
        if (projectFirst) {
            handleSetProject(draft.projectId || null);
            return;
        }
        if (!showProjectStep) {
            handleSetProject(draft.projectId || null);
            return;
        }
        goToStep('project');
    }, [draft.projectId, goToStep, handleSetProject, projectFirst, showProjectStep]);

    const handleDefer = useCallback(() => {
        if (showOrganizationStep) {
            const taskContexts = processingTask?.contexts ?? [];
            const taskTags = processingTask?.tags ?? [];
            updateSelectedContexts(taskContexts);
            updateSelectedTags(taskTags);
            goToStep('context');
            return;
        }
        if (projectFirst) {
            handleSetProject(draft.projectId || null);
            return;
        }
        if (!showProjectStep) {
            handleSetProject(draft.projectId || null);
            return;
        }
        goToStep('project');
    }, [
        draft.projectId,
        goToStep,
        handleSetProject,
        processingTask?.contexts,
        processingTask?.tags,
        projectFirst,
        showOrganizationStep,
        showProjectStep,
        updateSelectedContexts,
        updateSelectedTags,
    ]);

    const handleConvertToProject = useCallback(async () => {
        if (!processingTask || projectConversionInFlightRef.current) return;
        const projectTitle = draft.title.trim();
        const nextAction = nextActionDraft.trim();
        if (!projectTitle) return;
        if (!nextAction) {
            alert(t('process.nextActionRequired'));
            return;
        }
        projectConversionInFlightRef.current = true;
        try {
            const existing = projects.find((project) => (
                isSelectableProjectForTaskAssignment(project)
                && project.title.toLowerCase() === projectTitle.toLowerCase()
            ));
            const project = existing ?? await addProject(
                projectTitle,
                DEFAULT_PROJECT_COLOR,
                showAreaField && draft.areaId ? { areaId: draft.areaId } : undefined,
            );
            if (!project) return;

            // Extra actions are independent durable writes. Commit and remove
            // each one before moving the original Inbox task, so a failure can
            // be retried without losing or duplicating actions already saved.
            const extraActions = extraActionDrafts
                .map((draftValue) => ({ draftValue, title: draftValue.trim() }))
                .filter(({ title }) => Boolean(title));
            for (const { draftValue, title } of extraActions) {
                const result = await addTask(title, { status: 'inbox', projectId: project.id });
                if (!result.success) {
                    showToast(result.error || t('task.addFailed'), 'error');
                    return;
                }
                setExtraActionDrafts((currentDrafts) => {
                    const committedIndex = currentDrafts.indexOf(draftValue);
                    return committedIndex < 0
                        ? currentDrafts
                        : currentDrafts.filter((_, index) => index !== committedIndex);
                });
            }

            const applied = await applyWorkflowDecision({ type: 'next' }, {
                fields: { projectId: project.id },
                titleInput: nextAction,
                fallbackTitle: processingTask.title,
                advance: false,
            });
            if (!applied) return;
            setExtraActionDrafts([]);
            processNext();
        } catch (error) {
            reportError('Failed to create project from inbox processing', error);
            showToast(tFallback(t, 'projects.createFailed', 'Failed to create project'), 'error');
        } finally {
            projectConversionInFlightRef.current = false;
        }
    }, [
        addProject,
        addTask,
        extraActionDrafts,
        setExtraActionDrafts,
        applyWorkflowDecision,
        draft.areaId,
        draft.title,
        nextActionDraft,
        processingTask,
        processNext,
        projects,
        selectedContexts,
        selectedTags,
        showAreaField,
        showContextsField,
        showTagsField,
        showToast,
        t,
    ]);

    const handleRefineNext = useCallback(() => {
        goToStep(getInitialGuidedStep());
    }, [getInitialGuidedStep, goToStep]);

    const handleCreatePerson = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const person = await addPerson(trimmed);
        if (!person) showToast(tFallback(t, 'task.addFailed', 'Failed to add task'), 'error');
    }, [addPerson, showToast, t]);

    const handleCreateSomedaySection = useCallback(async (title: string) => {
        try {
            return await createSomedaySection(title);
        } catch (error) {
            reportError('Failed to create Someday section during Inbox Processing', error);
            showToast(tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'), 'error');
            return null;
        }
    }, [showToast, t]);

    const handleQuickSubmit = useCallback(async () => {
        handleScheduleTimeCommit();
        handleDueTimeCommit();
        handleReviewTimeCommit();
        if (quickActionability === 'later') {
            await handleLater();
            return;
        }
        if (quickActionability === 'incubate') {
            await handleIncubate();
            return;
        }
        if (quickActionability !== 'actionable') {
            await handleNotActionable(quickActionability);
            return;
        }
        if (quickTwoMinuteChoice === 'yes') {
            await handleTwoMinDone();
            return;
        }
        if (quickExecutionChoice === 'delegate') {
            await handleConfirmWaiting();
            return;
        }
        if (convertToProject) {
            await handleConvertToProject();
            return;
        }
        await handleSetProject(draft.projectId || null);
    }, [
        convertToProject,
        draft.projectId,
        handleConfirmWaiting,
        handleConvertToProject,
        handleDueTimeCommit,
        handleIncubate,
        handleLater,
        handleNotActionable,
        handleReviewTimeCommit,
        handleScheduleTimeCommit,
        handleSetProject,
        handleTwoMinDone,
        quickActionability,
        quickExecutionChoice,
        quickTwoMinuteChoice,
    ]);

    const showStartButton = inboxCount > 0 && !isProcessing;

    const options = useMemo<InboxProcessingOptionLists>(() => ({
        projects,
        areas: activeAreas,
        allContexts,
        allTags,
        suggestedContexts,
        suggestedTags,
        personOptions,
        timeEstimateOptions,
    }), [
        activeAreas,
        allContexts,
        allTags,
        personOptions,
        projects,
        suggestedContexts,
        suggestedTags,
        timeEstimateOptions,
    ]);

    const quickPanelProps = isProcessing && processingTask && processingMode === 'quick'
        ? {
            t,
            processingTask,
            remainingCount: remainingInboxCount,
            draft,
            setField,
            similarTasks,
            visibility,
            options,
            settings,
            processingMode,
            onModeChange: setProcessingMode,
            onSkip: handleSkip,
            onClose: closeProcessing,
            isReturningItem,
            actionabilityChoice: quickActionability,
            setActionabilityChoice: setQuickActionability,
            twoMinuteChoice: quickTwoMinuteChoice,
            setTwoMinuteChoice: setQuickTwoMinuteChoice,
            executionChoice: quickExecutionChoice,
            setExecutionChoice: setQuickExecutionChoice,
            scheduleFields,
            visibleScheduleFieldKeys,
            delegateWho,
            setDelegateWho,
            delegateFollowUp,
            setDelegateFollowUp,
            onSendDelegateRequest: handleSendDelegateRequest,
            onCreatePerson: handleCreatePerson,
            onCreateSomedaySection: handleCreateSomedaySection,
            toggleContext,
            toggleTag,
            convertToProject,
            setConvertToProject,
            nextActionDraft,
            setNextActionDraft,
            extraActionDrafts,
            setExtraActionDrafts,
            addProject,
            onSubmit: handleQuickSubmit,
        }
        : null;

    const wizardProps: InboxProcessingWizardProps = {
        t,
        isProcessing,
        processingTask,
        processingMode,
        onModeChange: setProcessingMode,
        processingStep,
        draft,
        setField,
        similarTasks,
        visibility,
        options,
        setIsProcessing,
        canGoBack: stepHistory.length > 0,
        onBack: goBack,
        handleRefineNext,
        handleSkip,
        handleNotActionable,
        handleLater,
        handleIncubate,
        handleActionable,
        isReturningItem,
        showDoneNowShortcut: twoMinuteEnabled && !twoMinuteFirst,
        handleProjectCheckNo,
        handleProjectCheckYes,
        handleTwoMinDone,
        handleTwoMinNo,
        handleDefer,
        handleDelegate,
        delegateWho,
        setDelegateWho,
        delegateFollowUp,
        setDelegateFollowUp,
        handleDelegateBack,
        handleSendDelegateRequest,
        handleConfirmWaiting,
        handleConfirmReference,
        handleConfirmSomeday,
        onCreatePerson: handleCreatePerson,
        onCreateSomedaySection: handleCreateSomedaySection,
        customContext,
        setCustomContext,
        addCustomContext,
        customTag,
        setCustomTag,
        addCustomTag,
        toggleContext,
        toggleTag,
        handleConfirmContexts,
        convertToProject,
        setConvertToProject,
        setNextActionDraft,
        nextActionDraft,
        extraActionDrafts,
        setExtraActionDrafts,
        handleConvertToProject,
        projectSearch,
        setProjectSearch,
        filteredProjects,
        addProject,
        handleSetProject,
        hasExactProjectMatch,
        areaById,
        remainingCount: remainingInboxCount,
        showProjectInRefine: projectFirst && showProjectStep,
        scheduleFields,
        visibleScheduleFieldKeys,
        settings,
    };

    return {
        inboxCount,
        quickPanelProps,
        showStartButton,
        startProcessing,
        wizardProps,
    };
}
