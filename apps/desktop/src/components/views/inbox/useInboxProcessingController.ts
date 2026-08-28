import { useCallback, useEffect, useMemo } from 'react';
import {
    advanceProcessInboxSession,
    addBreadcrumb,
    buildQuickAddParseOptions,
    commitProcessInboxWorkflowEvent,
    DEFAULT_PROJECT_COLOR,
    enterProcessInboxStep,
    getPersonOptionNames,
    goBackProcessInboxStep,
    isProcessInboxReturningTask,
    mergeParsedProcessInboxFields,
    parseProcessInboxTitleInput,
    prepareProcessInboxDecision,
    setTaskViewSectionId,
    sortViewSectionDefinitions,
    startProcessInboxSession,
    tFallback,
    useTaskStore,
    type AppData,
    type Area,
    type Project,
    type ProcessInboxDecision,
    type ProcessInboxDecisionDraft,
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
    const people = useTaskStore((state) => state.people);
    const addPerson = useTaskStore((state) => state.addPerson);
    const updateSettings = useTaskStore((state) => state.updateSettings);
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
    const { showAreaField, showContextsField, showTagsField } = visibility;
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

    const buildDecisionFields = useCallback((
        overrides: ProcessInboxWorkflowFields = {},
    ): ProcessInboxWorkflowFields => ({
        projectId: draft.projectId || undefined,
        areaId: draft.areaId || undefined,
        contexts: selectedContexts,
        tags: selectedTags,
        priority: draft.priority || undefined,
        energyLevel: draft.energyLevel || undefined,
        assignedTo: draft.assignedTo.trim() || undefined,
        timeEstimate: draft.timeEstimate || undefined,
        ...buildScheduleUpdates(),
        ...overrides,
    }), [
        buildScheduleUpdates,
        draft.areaId,
        draft.assignedTo,
        draft.energyLevel,
        draft.priority,
        draft.projectId,
        draft.timeEstimate,
        selectedContexts,
        selectedTags,
    ]);

    const prepareProcessingEdits = useCallback((
        titleInput: string = draft.title,
        fallbackTitle?: string,
    ): {
        taskUpdates: Partial<Task>;
        parsedFields: ProcessInboxWorkflowFields;
        explicitDateFields: ProcessInboxDecisionDraft['explicitDateFields'];
    } | null => {
        if (!processingTask) return null;
        const parsed = titleInput === draft.title ? parsedTitle : parseProcessingTitle(titleInput);
        const { invalidDateCommands } = parsed;
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return null;
        }
        const trimmedTitle = parsed.title.trim();
        const title = trimmedTitle.length > 0 ? trimmedTitle : (fallbackTitle ?? processingTask.title);
        const description = [draft.description.trim(), parsed.props.description?.trim()]
            .filter(Boolean)
            .join('\n');
        return {
            taskUpdates: {
                title,
                description: description.length > 0 ? description : undefined,
                ...(parsed.props.attachments
                    ? { attachments: [...(processingTask.attachments ?? []), ...parsed.props.attachments] }
                    : {}),
                ...(parsed.props.isFocusedToday ? { isFocusedToday: true } : {}),
            },
            parsedFields: parsed.props,
            explicitDateFields: {
                ...(parsed.props.startTime ? { startTime: parsed.props.startTime } : {}),
                ...(parsed.props.dueDate ? { dueDate: parsed.props.dueDate } : {}),
                ...(parsed.props.reviewAt ? { reviewAt: parsed.props.reviewAt } : {}),
            },
        };
    }, [draft.description, draft.title, parseProcessingTitle, parsedTitle, processingTask, showToast, t]);

    const applyWorkflowDecision = useCallback(async (
        decision: ProcessInboxDecision,
        options: {
            fields?: ProcessInboxWorkflowFields;
            titleInput?: string;
            fallbackTitle?: string;
            advance?: boolean;
        } = {},
    ): Promise<boolean> => {
        if (!processingTask) return false;
        const edits = decision.type === 'discard'
            ? undefined
            : prepareProcessingEdits(options.titleInput, options.fallbackTitle);
        if (decision.type !== 'discard' && !edits) return false;
        const fields = mergeParsedProcessInboxFields(
            buildDecisionFields(options.fields),
            edits?.parsedFields ?? {},
        );
        const dateControlFields: ProcessInboxDecisionDraft['dateControlFields'] = {
            ...(dirtyScheduleFieldKeys.has('start') ? { startTime: fields.startTime } : {}),
            ...(dirtyScheduleFieldKeys.has('due') ? { dueDate: fields.dueDate } : {}),
            ...(dirtyScheduleFieldKeys.has('review') ? { reviewAt: fields.reviewAt } : {}),
        };
        const prepared = prepareProcessInboxDecision({
            task: processingTask,
            draft: {
                fields,
                explicitDateFields: edits?.explicitDateFields,
                dateControlFields,
                taskUpdates: edits?.taskUpdates,
            },
            decision,
            plan: processInboxPlan,
        });
        if (!prepared.ok) {
            if (prepared.reason === 'later-start-required') {
                showToast(tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'), 'error');
            }
            return false;
        }
        try {
            const outcome = await commitProcessInboxWorkflowEvent(
                processingSession,
                eligibleInboxTasks,
                prepared.event,
                { deleteTask, updateTask },
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
        buildDecisionFields,
        deleteTask,
        dirtyScheduleFieldKeys,
        eligibleInboxTasks,
        processInboxPlan,
        prepareProcessingEdits,
        processingSession,
        processingTask,
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
            if (processingMode === 'guided' && (showContextsField || showTagsField)) {
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
        await applyWorkflowDecision({ type: 'someday' }, { fields: buildSomedayFields() });
    }, [
        applyWorkflowDecision,
        buildSomedayFields,
        goToStep,
        processingMode,
        processingTask,
        showContextsField,
        showTagsField,
    ]);

    const handleConfirmReference = useCallback(async () => {
        if (!processingTask) return;
        await applyWorkflowDecision({ type: 'reference' });
    }, [applyWorkflowDecision, processingTask]);

    const handleConfirmSomeday = useCallback(async () => {
        if (!processingTask) return;
        await applyWorkflowDecision({ type: 'someday' }, { fields: buildSomedayFields() });
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
        setProjectTitleDraft(baseTitle);
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
        if (!processingTask) return;
        const projectTitle = projectTitleDraft.trim() || draft.title.trim();
        const nextAction = nextActionDraft.trim();
        if (!projectTitle) return;
        if (!nextAction) {
            alert(t('process.nextActionRequired'));
            return;
        }
        try {
            const existing = projects.find((project) => project.title.toLowerCase() === projectTitle.toLowerCase());
            const project = existing ?? await addProject(
                projectTitle,
                DEFAULT_PROJECT_COLOR,
                showAreaField && draft.areaId ? { areaId: draft.areaId } : undefined,
            );
            if (!project) return;
            const applied = await applyWorkflowDecision({ type: 'next' }, {
                fields: { projectId: project.id },
                titleInput: nextAction,
                fallbackTitle: processingTask.title,
                advance: false,
            });
            if (applied) {
                // The converted capture becomes the project's clarified next
                // action. Extra actions typed at the split step are raw
                // captures, so they return to the Inbox (project attached)
                // for their own clarify pass — same semantics as a quick-add
                // with a +Project token (#827).
                const extraActions = extraActionDrafts.map((title) => title.trim()).filter(Boolean);
                for (const title of extraActions) {
                    const result = await addTask(title, { status: 'inbox', projectId: project.id });
                    if (!result.success) {
                        showToast(result.error || t('task.addFailed'), 'error');
                        return;
                    }
                }
                setExtraActionDrafts([]);
                processNext();
            }
        } catch (error) {
            reportError('Failed to create project from inbox processing', error);
            showToast(tFallback(t, 'projects.createFailed', 'Failed to create project'), 'error');
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
        projectTitleDraft,
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
        await addPerson(trimmed);
    }, [addPerson]);

    const handleCreateSomedaySection = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const currentSections = sortViewSectionDefinitions(settings?.gtd?.viewSections?.someday);
        const existing = currentSections.find((section) => section.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const id = globalThis.crypto?.randomUUID?.()
            ?? `someday-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const maxOrder = currentSections.reduce(
            (maximum, section) => Number.isFinite(section.order) ? Math.max(maximum, section.order) : maximum,
            -1,
        );
        try {
            await updateSettings({
                gtd: {
                    ...(settings?.gtd ?? {}),
                    viewSections: {
                        ...(settings?.gtd?.viewSections ?? {}),
                        someday: [...currentSections, { id, title: trimmed, order: maxOrder + 1 }],
                    },
                },
            });
            return id;
        } catch (error) {
            reportError('Failed to create Someday section during Inbox Processing', error);
            showToast(tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'), 'error');
            return null;
        }
    }, [settings?.gtd, showToast, t, updateSettings]);

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
            projectTitleDraft,
            setProjectTitleDraft,
            nextActionDraft,
            setNextActionDraft,
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
        setProjectTitleDraft,
        setNextActionDraft,
        projectTitleDraft,
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
