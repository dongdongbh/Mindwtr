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
    parseProcessInboxTitleInput,
    resolveProcessInboxContainerFields,
    skipCurrentProcessInboxTask,
    startProcessInboxSession,
    tFallback,
    withParsedProcessInboxFields,
    useTaskStore,
    type AppData,
    type Area,
    type Project,
    type ProcessInboxWorkflowEvent,
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
    const personOptions = useMemo(() => getPersonOptionNames(people, tasks), [people, tasks]);
    const {
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
        prioritiesEnabled,
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
    // One options bag for every parse in this flow, from the same builder the
    // capture surfaces use — a hand-rolled bag is how surfaces drift apart.
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
    // The title the user is holding, parsed once: the commit reads its title and
    // the decision's fields read its tokens, so the two cannot disagree.
    const parsedTitle = useMemo(() => parseProcessingTitle(draft.title), [draft.title, parseProcessingTitle]);
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

    const handleSkip = useCallback(() => {
        if (!processingTask) return;
        applySessionTransition(skipCurrentProcessInboxTask(
            processingSession,
            eligibleInboxTasks,
            { entryStep: 'refine' },
        ));
    }, [applySessionTransition, eligibleInboxTasks, processingSession, processingTask]);

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

    const prepareProcessingEdits = useCallback((
        titleInput: string = draft.title,
        fallbackTitle?: string,
    ): Partial<Task> | null => {
        if (!processingTask) return null;
        const parsed = titleInput === draft.title ? parsedTitle : parseProcessingTitle(titleInput);
        const { invalidDateCommands } = parsed;
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return null;
        }
        const trimmedTitle = parsed.title.trim();
        const title = trimmedTitle.length > 0 ? trimmedTitle : (fallbackTitle ?? processingTask.title);
        // `/note:` adds to the note the user can see rather than replacing it —
        // clarifying must never quietly drop the text the capture arrived with.
        const description = [draft.description.trim(), parsed.props.description?.trim()]
            .filter(Boolean)
            .join('\n');
        return {
            title,
            description: description.length > 0 ? description : undefined,
            ...(parsed.props.startTime ? { startTime: parsed.props.startTime } : {}),
            ...(parsed.props.dueDate ? { dueDate: parsed.props.dueDate } : {}),
            ...(parsed.props.reviewAt ? { reviewAt: parsed.props.reviewAt } : {}),
            // A `/link:` adds to what the capture already carried; assigning the
            // parsed list alone would drop the task's existing attachments.
            ...(parsed.props.attachments
                ? { attachments: [...(processingTask.attachments ?? []), ...parsed.props.attachments] }
                : {}),
            ...(parsed.props.isFocusedToday ? { isFocusedToday: true } : {}),
        };
    }, [draft.description, draft.title, parseProcessingTitle, parsedTitle, processingTask, showToast, t]);

    const applyWorkflowEvent = useCallback(async (
        incoming: ProcessInboxWorkflowEvent,
        titleInput?: string,
        fallbackTitle?: string,
        options: { advance?: boolean } = {},
    ): Promise<boolean> => {
        if (!processingTask) return false;
        const taskUpdates = incoming.type === 'discard'
            ? undefined
            : prepareProcessingEdits(titleInput, fallbackTitle);
        if (incoming.type !== 'discard' && !taskUpdates) return false;
        // Every decision routes through here, so the title's tokens fold into
        // the fields once instead of at each of the six call sites.
        const event = withParsedProcessInboxFields(incoming, parsedTitle.props);
        try {
            const outcome = await commitProcessInboxWorkflowEvent(
                processingSession,
                eligibleInboxTasks,
                event,
                { deleteTask, updateTask },
                {
                    entryStep: 'refine',
                    taskUpdates: taskUpdates ?? undefined,
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
        deleteTask,
        eligibleInboxTasks,
        parsedTitle.props,
        prepareProcessingEdits,
        processingSession,
        processingTask,
        showToast,
        t,
        updateTask,
    ]);

    const goToStep = useCallback((nextStep: ProcessingStep) => {
        setProcessingSession((current) => enterProcessInboxStep(current, nextStep));
    }, [setProcessingSession]);

    const goBack = useCallback(() => {
        setProcessingSession((current) => goBackProcessInboxStep(current));
    }, [setProcessingSession]);

    // Terminal destinations that skip the project step still carry whatever the
    // user already picked; the state is hydrated from the task, so an untouched
    // selection writes back unchanged (#958).
    const buildSelectionFields = useCallback((): ProcessInboxWorkflowFields => ({
        ...resolveProcessInboxContainerFields(draft.projectId, draft.areaId),
        ...(showContextsField ? { contexts: selectedContexts } : {}),
        ...(showTagsField ? { tags: selectedTags } : {}),
    }), [draft.areaId, draft.projectId, selectedContexts, selectedTags, showContextsField, showTagsField]);

    const handleNotActionable = useCallback(async (action: 'trash' | 'someday' | 'reference') => {
        if (!processingTask) return;
        if (action === 'trash') {
            await applyWorkflowEvent({ type: 'discard' });
            return;
        }
        if (action === 'reference') {
            if (processingMode === 'guided' && (showContextsField || showTagsField)) {
                goToStep('reference');
                return;
            }
            await applyWorkflowEvent({ type: 'reference', fields: buildSelectionFields() });
            return;
        }
        await applyWorkflowEvent({ type: 'someday', fields: buildSelectionFields() });
    }, [
        applyWorkflowEvent,
        buildSelectionFields,
        goToStep,
        processingMode,
        processingTask,
        showContextsField,
        showTagsField,
    ]);

    const handleConfirmReference = useCallback(async () => {
        if (!processingTask) return;
        await applyWorkflowEvent({ type: 'reference', fields: buildSelectionFields() });
    }, [applyWorkflowEvent, buildSelectionFields, processingTask]);

    const handleLater = useCallback(async () => {
        if (!processingTask) return;
        handleScheduleTimeCommit();
        const startTime = buildDateTimeUpdate(scheduleDate, scheduleTimeDraft, scheduleTime);
        if (!startTime) {
            showToast(tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'), 'error');
            return;
        }
        await applyWorkflowEvent({
            type: 'later',
            fields: { ...resolveProcessInboxContainerFields(draft.projectId, draft.areaId), startTime },
        });
    }, [
        applyWorkflowEvent,
        draft.areaId,
        draft.projectId,
        handleScheduleTimeCommit,
        processingTask,
        scheduleDate,
        scheduleTime,
        scheduleTimeDraft,
        showToast,
        t,
    ]);

    const getInitialGuidedStep = useCallback<() => ProcessingStep>(() => (
        twoMinuteEnabled && twoMinuteFirst ? 'twomin' : 'actionable'
    ), [twoMinuteEnabled, twoMinuteFirst]);

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
        await applyWorkflowEvent({ type: 'complete', fields: buildSelectionFields() });
    }, [applyWorkflowEvent, buildSelectionFields, processingTask]);

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
        const applied = await applyWorkflowEvent({
            type: 'waiting',
            fields: {
                ...buildSelectionFields(),
                energyLevel: draft.energyLevel || undefined,
                assignedTo: who || undefined,
                timeEstimate: draft.timeEstimate || undefined,
                ...(prioritiesEnabled ? { priority: draft.priority || undefined } : {}),
                ...scheduleUpdates,
                reviewAt: scheduleUpdates.reviewAt,
            },
            followUpAt: delegateFollowUp
                ? new Date(`${delegateFollowUp}T09:00:00`).toISOString()
                : undefined,
        });
        if (applied) {
            setDelegateWho('');
            setDelegateFollowUp('');
        }
    }, [
        applyWorkflowEvent,
        buildSelectionFields,
        buildScheduleUpdates,
        delegateFollowUp,
        delegateWho,
        draft.energyLevel,
        draft.priority,
        draft.timeEstimate,
        prioritiesEnabled,
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
        await applyWorkflowEvent({
            type: 'next',
            fields: {
                contexts: showContextsField ? selectedContexts : (processingTask.contexts ?? []),
                tags: showTagsField ? selectedTags : (processingTask.tags ?? []),
                energyLevel: draft.energyLevel || undefined,
                assignedTo: draft.assignedTo.trim() || undefined,
                timeEstimate: draft.timeEstimate || undefined,
                ...(prioritiesEnabled ? { priority: draft.priority || undefined } : {}),
                projectId: projectId || undefined,
                areaId: projectId ? undefined : (showAreaField ? (draft.areaId || undefined) : (processingTask.areaId || undefined)),
                ...buildScheduleUpdates(),
            },
        });
    }, [
        applyWorkflowEvent,
        buildScheduleUpdates,
        draft.areaId,
        draft.assignedTo,
        draft.energyLevel,
        draft.priority,
        draft.timeEstimate,
        prioritiesEnabled,
        processingTask,
        selectedContexts,
        selectedTags,
        showAreaField,
        showContextsField,
        showTagsField,
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
            const applied = await applyWorkflowEvent({
                type: 'next',
                fields: {
                    contexts: showContextsField ? selectedContexts : (processingTask.contexts ?? []),
                    tags: showTagsField ? selectedTags : (processingTask.tags ?? []),
                    energyLevel: draft.energyLevel || undefined,
                    assignedTo: draft.assignedTo.trim() || undefined,
                    timeEstimate: draft.timeEstimate || undefined,
                    ...(prioritiesEnabled ? { priority: draft.priority || undefined } : {}),
                    projectId: project.id,
                    ...buildScheduleUpdates(),
                },
            }, nextAction, processingTask.title, { advance: false });
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
        applyWorkflowEvent,
        buildScheduleUpdates,
        draft.areaId,
        draft.assignedTo,
        draft.energyLevel,
        draft.priority,
        draft.timeEstimate,
        draft.title,
        nextActionDraft,
        prioritiesEnabled,
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

    const handleQuickSubmit = useCallback(async () => {
        handleScheduleTimeCommit();
        handleDueTimeCommit();
        handleReviewTimeCommit();
        if (quickActionability === 'later') {
            await handleLater();
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
            processingMode,
            onModeChange: setProcessingMode,
            onSkip: handleSkip,
            onClose: closeProcessing,
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
        handleActionable,
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
        onCreatePerson: handleCreatePerson,
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
