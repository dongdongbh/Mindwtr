import { useCallback, useEffect } from 'react';
import {
    addBreadcrumb,
    DEFAULT_PROJECT_COLOR,
    parseQuickAddDateCommands,
    tFallback,
    type AppData,
    type Area,
    type Project,
    type Task,
} from '@mindwtr/core';

import type { InboxProcessingQuickPanelProps } from '../../InboxProcessingQuickPanel';
import type { InboxProcessingWizardProps, ProcessingStep } from '../../InboxProcessingWizard';
import { reportError } from '../../../lib/report-error';
import { useUiStore } from '../../../store/ui-store';
import {
    buildDateTimeUpdate,
    parseTokenListInput,
} from './inbox-processing-utils';
import { useInboxProcessingState } from './useInboxProcessingState';

type UseInboxProcessingControllerParams = {
    t: (key: string) => string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
    addProject: (title: string, color: string) => Promise<Project | null>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
    deleteTask: (id: string) => Promise<unknown>;
    allContexts: string[];
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
    updateTask,
    deleteTask,
    allContexts,
    isProcessing,
    setIsProcessing,
}: UseInboxProcessingControllerParams): UseInboxProcessingControllerResult {
    const showToast = useUiStore((state) => state.showToast);
    const {
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
        twoMinuteEnabled,
        twoMinuteFirst,
        projectFirst,
        scheduleEnabled,
        referenceEnabled,
        prioritiesEnabled,
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

    useEffect(() => {
        if (isProcessing) return;
        resetProcessingSession();
    }, [isProcessing, resetProcessingSession]);

    const startProcessing = useCallback(() => {
        const inboxTasks = tasks.filter((task) => task.status === 'inbox' && matchesAreaFilter(task));
        if (inboxTasks.length === 0) return;
        hydrateProcessingTask(inboxTasks[0]);
        addBreadcrumb('inbox:start');
        setIsProcessing(true);
    }, [tasks, hydrateProcessingTask, setIsProcessing, matchesAreaFilter]);

    const closeProcessing = useCallback(() => {
        setIsProcessing(false);
    }, [setIsProcessing]);

    const processNext = useCallback(() => {
        const currentTaskId = processingTask?.id;
        const inboxTasks = tasks.filter((task) =>
            task.status === 'inbox'
            && task.id !== currentTaskId
            && !skippedIds.has(task.id)
            && matchesAreaFilter(task)
        );
        if (inboxTasks.length > 0) {
            hydrateProcessingTask(inboxTasks[0]);
            return;
        }
        addBreadcrumb('inbox:done');
        setIsProcessing(false);
        setProcessingTask(null);
        setSelectedContexts([]);
        setSelectedTags([]);
        setSelectedEnergyLevel(undefined);
        setSelectedAssignedTo('');
        setSelectedPriority(undefined);
        setSelectedTimeEstimate(undefined);
    }, [hydrateProcessingTask, processingTask?.id, tasks, setIsProcessing, skippedIds, matchesAreaFilter]);

    const handleSkip = useCallback(() => {
        if (processingTask) {
            setSkippedIds((prev) => {
                const next = new Set(prev);
                next.add(processingTask.id);
                return next;
            });
        }
        processNext();
    }, [processNext, processingTask]);

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

    const applyProcessingEdits = useCallback((
        updates: Partial<Task>,
        titleInput: string = processingTitle,
        fallbackTitle?: string,
    ) => {
        if (!processingTask) return false;
        const { title: parsedTitle, props: parsedDateProps, invalidDateCommands } = parseQuickAddDateCommands(
            titleInput,
            new Date(),
        );
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return false;
        }
        const trimmedTitle = parsedTitle.trim();
        const title = trimmedTitle.length > 0 ? trimmedTitle : (fallbackTitle ?? processingTask.title);
        const description = processingDescription.trim();
        void updateTask(processingTask.id, {
            title,
            description: description.length > 0 ? description : undefined,
            ...updates,
            ...parsedDateProps,
        });
        return true;
    }, [processingDescription, processingTask, processingTitle, showToast, t, updateTask]);

    const handleNotActionable = useCallback((action: 'trash' | 'someday' | 'reference') => {
        if (!processingTask) return;
        if (action === 'trash') {
            void deleteTask(processingTask.id);
            processNext();
            return;
        }
        const applied = action === 'someday'
            ? applyProcessingEdits({ status: 'someday' })
            : applyProcessingEdits({ status: 'reference' });
        if (applied) {
            processNext();
        }
    }, [applyProcessingEdits, deleteTask, processNext, processingTask]);

    const handleLater = useCallback(() => {
        if (!processingTask) return;
        handleScheduleTimeCommit();
        const startTime = buildDateTimeUpdate(scheduleDate, scheduleTimeDraft, scheduleTime);
        if (!startTime) {
            showToast(tFallback(t, 'process.laterStartRequired', 'Choose a start date for Later.'), 'error');
            return;
        }
        const projectUpdates = projectFirst && showProjectStep
            ? {
                ...(showProjectField ? { projectId: selectedProjectId || undefined } : {}),
                ...(showAreaField ? { areaId: selectedProjectId ? undefined : (selectedAreaId || undefined) } : {}),
            }
            : {};
        const applied = applyProcessingEdits({
            status: 'next',
            ...projectUpdates,
            startTime,
        });
        if (applied) {
            processNext();
        }
    }, [
        applyProcessingEdits,
        handleScheduleTimeCommit,
        processNext,
        processingTask,
        projectFirst,
        scheduleDate,
        scheduleTime,
        scheduleTimeDraft,
        selectedAreaId,
        selectedProjectId,
        showAreaField,
        showProjectField,
        showProjectStep,
        showToast,
        t,
    ]);

    const goToStep = useCallback((nextStep: ProcessingStep) => {
        setStepHistory((prev) => [...prev, processingStep]);
        setProcessingStep(nextStep);
    }, [processingStep]);

    const goBack = useCallback(() => {
        setStepHistory((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            const last = next.pop();
            if (last) setProcessingStep(last);
            return next;
        });
    }, []);

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
        const { title: parsedTitle } = parseQuickAddDateCommands(processingTitle, new Date());
        const baseTitle = parsedTitle.trim() || processingTitle.trim() || processingTask?.title || '';
        setConvertToProject(true);
        setProjectTitleDraft(baseTitle);
        setNextActionDraft(baseTitle);
        goToStep('project');
    }, [goToStep, processingTask?.title, processingTitle]);

    const handleTwoMinDone = useCallback(() => {
        if (!processingTask) return;
        if (applyProcessingEdits({ status: 'done' })) {
            processNext();
        }
    }, [applyProcessingEdits, processNext, processingTask]);

    const handleTwoMinNo = useCallback(() => {
        goToStep(twoMinuteFirst ? 'actionable' : 'decide');
    }, [goToStep, twoMinuteFirst]);

    const handleDelegate = useCallback(() => {
        setDelegateWho('');
        setDelegateFollowUp('');
        goToStep('delegate');
    }, [goToStep]);

    const handleConfirmWaiting = useCallback(() => {
        if (!processingTask) return;
        const who = delegateWho.trim();
        const scheduleUpdates = buildScheduleUpdates();
        const followUpIso = delegateFollowUp
            ? new Date(`${delegateFollowUp}T09:00:00`).toISOString()
            : scheduleUpdates.reviewAt;
        const applied = applyProcessingEdits({
            status: 'waiting',
            energyLevel: selectedEnergyLevel ?? undefined,
            assignedTo: who || undefined,
            timeEstimate: selectedTimeEstimate ?? undefined,
            ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
            ...scheduleUpdates,
            reviewAt: followUpIso,
        });
        if (applied) {
            setDelegateWho('');
            setDelegateFollowUp('');
            processNext();
        }
    }, [
        applyProcessingEdits,
        buildScheduleUpdates,
        delegateFollowUp,
        delegateWho,
        prioritiesEnabled,
        processNext,
        processingTask,
        selectedEnergyLevel,
        selectedPriority,
        selectedTimeEstimate,
    ]);

    const handleDelegateBack = useCallback(() => {
        goBack();
    }, [goBack]);

    const handleSendDelegateRequest = useCallback(() => {
        if (!processingTask) return;
        const title = processingTitle.trim() || processingTask.title;
        const baseDescription = processingDescription.trim() || processingTask.description || '';
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
        const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(mailto);
    }, [delegateWho, processingDescription, processingTask, processingTitle]);

    const toggleTag = useCallback((tag: string) => {
        setSelectedTags((prev) =>
            prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
        );
    }, []);

    const toggleContext = useCallback((ctx: string) => {
        if (ctx.startsWith('#')) {
            toggleTag(ctx);
            return;
        }
        setSelectedContexts((prev) =>
            prev.includes(ctx) ? prev.filter((item) => item !== ctx) : [...prev, ctx]
        );
    }, [toggleTag]);

    const addCustomContext = useCallback(() => {
        const trimmed = customContext.trim();
        if (!trimmed) return;
        const raw = trimmed.replace(/^@/, '');
        const ctx = `@${raw.replace(/^@/, '').trim()}`;
        if (ctx.length > 1 && !selectedContexts.includes(ctx)) {
            setSelectedContexts((prev) => [...prev, ctx]);
        }
        setCustomContext('');
    }, [customContext, selectedContexts]);

    const addCustomTag = useCallback(() => {
        const trimmed = customTag.trim();
        if (!trimmed) return;
        const tag = `#${trimmed.replace(/^#+/, '').trim()}`;
        if (tag.length > 1 && !selectedTags.includes(tag)) {
            setSelectedTags((prev) => [...prev, tag]);
        }
        setCustomTag('');
    }, [customTag, selectedTags]);

    const handleSetProject = useCallback((projectId: string | null) => {
        if (!processingTask) return;
        const applied = applyProcessingEdits({
            status: 'next',
            contexts: showContextsField ? selectedContexts : (processingTask.contexts ?? []),
            tags: showTagsField ? selectedTags : (processingTask.tags ?? []),
            energyLevel: selectedEnergyLevel ?? undefined,
            assignedTo: selectedAssignedTo.trim() || undefined,
            timeEstimate: selectedTimeEstimate ?? undefined,
            ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
            projectId: projectId || undefined,
            areaId: projectId ? undefined : (showAreaField ? (selectedAreaId || undefined) : (processingTask.areaId || undefined)),
            ...buildScheduleUpdates(),
        });
        if (applied) {
            processNext();
        }
    }, [
        applyProcessingEdits,
        buildScheduleUpdates,
        prioritiesEnabled,
        processNext,
        processingTask,
        selectedAreaId,
        selectedAssignedTo,
        selectedContexts,
        selectedEnergyLevel,
        selectedPriority,
        selectedTimeEstimate,
        selectedTags,
        showAreaField,
        showContextsField,
        showTagsField,
    ]);

    const handleConfirmContexts = useCallback(() => {
        if (projectFirst) {
            handleSetProject(selectedProjectId);
            return;
        }
        if (!showProjectStep) {
            handleSetProject(selectedProjectId);
            return;
        }
        goToStep('project');
    }, [goToStep, handleSetProject, projectFirst, selectedProjectId, showProjectStep]);

    const handleDefer = useCallback(() => {
        if (showOrganizationStep) {
            setSelectedContexts(processingTask?.contexts ?? []);
            setSelectedTags(processingTask?.tags ?? []);
            goToStep('context');
            return;
        }
        if (projectFirst) {
            handleSetProject(selectedProjectId);
            return;
        }
        if (!showProjectStep) {
            handleSetProject(selectedProjectId);
            return;
        }
        goToStep('project');
    }, [
        goToStep,
        handleSetProject,
        processingTask?.contexts,
        processingTask?.tags,
        projectFirst,
        selectedProjectId,
        showOrganizationStep,
        showProjectStep,
    ]);

    const handleConvertToProject = useCallback(async () => {
        if (!processingTask) return;
        const projectTitle = projectTitleDraft.trim() || processingTitle.trim();
        const nextAction = nextActionDraft.trim();
        if (!projectTitle) return;
        if (!nextAction) {
            alert(t('process.nextActionRequired'));
            return;
        }
        try {
            const existing = projects.find((project) => project.title.toLowerCase() === projectTitle.toLowerCase());
            const project = existing ?? await addProject(projectTitle, DEFAULT_PROJECT_COLOR);
            if (!project) return;
            const applied = applyProcessingEdits({
                status: 'next',
                contexts: showContextsField ? selectedContexts : (processingTask.contexts ?? []),
                tags: showTagsField ? selectedTags : (processingTask.tags ?? []),
                energyLevel: selectedEnergyLevel ?? undefined,
                assignedTo: selectedAssignedTo.trim() || undefined,
                timeEstimate: selectedTimeEstimate ?? undefined,
                ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
                projectId: project.id,
                ...buildScheduleUpdates(),
            }, nextAction, processingTask.title);
            if (applied) {
                processNext();
            }
        } catch (error) {
            reportError('Failed to create project from inbox processing', error);
            showToast(t('projects.createFailed') || 'Failed to create project', 'error');
        }
    }, [
        addProject,
        applyProcessingEdits,
        buildScheduleUpdates,
        nextActionDraft,
        prioritiesEnabled,
        processingTask,
        processingTitle,
        processNext,
        projectTitleDraft,
        projects,
        selectedAssignedTo,
        selectedContexts,
        selectedEnergyLevel,
        selectedPriority,
        selectedTimeEstimate,
        selectedTags,
        showContextsField,
        showTagsField,
        showToast,
        t,
    ]);

    const handleRefineNext = useCallback(() => {
        goToStep(getInitialGuidedStep());
    }, [getInitialGuidedStep, goToStep]);

    const handleContextsInputChange = useCallback((value: string) => {
        setSelectedContexts(parseTokenListInput(value, '@'));
    }, []);

    const handleTagsInputChange = useCallback((value: string) => {
        setSelectedTags(parseTokenListInput(value, '#'));
    }, []);

    const handleQuickSubmit = useCallback(async () => {
        handleScheduleTimeCommit();
        handleDueTimeCommit();
        handleReviewTimeCommit();
        if (quickActionability === 'later') {
            handleLater();
            return;
        }
        if (quickActionability !== 'actionable') {
            handleNotActionable(quickActionability);
            return;
        }
        if (quickTwoMinuteChoice === 'yes') {
            handleTwoMinDone();
            return;
        }
        if (quickExecutionChoice === 'delegate') {
            handleConfirmWaiting();
            return;
        }
        if (convertToProject) {
            await handleConvertToProject();
            return;
        }
        handleSetProject(selectedProjectId);
    }, [
        convertToProject,
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
        selectedProjectId,
    ]);

    const showStartButton = inboxCount > 0 && !isProcessing;

    const quickPanelProps = isProcessing && processingTask && processingMode === 'quick'
        ? {
            t,
            processingTask,
            remainingCount: remainingInboxCount,
            processingTitle,
            processingDescription,
            setProcessingTitle,
            setProcessingDescription,
            processingMode,
            onModeChange: setProcessingMode,
            onSkip: handleSkip,
            onClose: closeProcessing,
            showReferenceOption: referenceEnabled,
            actionabilityChoice: quickActionability,
            setActionabilityChoice: setQuickActionability,
            twoMinuteChoice: quickTwoMinuteChoice,
            setTwoMinuteChoice: setQuickTwoMinuteChoice,
            executionChoice: quickExecutionChoice,
            setExecutionChoice: setQuickExecutionChoice,
            showScheduleFields,
            scheduleFields,
            visibleScheduleFieldKeys,
            delegateWho,
            setDelegateWho,
            delegateFollowUp,
            setDelegateFollowUp,
            onSendDelegateRequest: handleSendDelegateRequest,
            selectedContexts,
            selectedTags,
            selectedEnergyLevel,
            setSelectedEnergyLevel,
            selectedAssignedTo,
            setSelectedAssignedTo,
            selectedTimeEstimate,
            setSelectedTimeEstimate,
            timeEstimateOptions,
            showContextsField,
            showTagsField,
            showEnergyLevelField,
            showAssignedToField,
            showTimeEstimateField,
            showPriorityField,
            selectedPriority,
            setSelectedPriority,
            onContextsInputChange: handleContextsInputChange,
            onTagsInputChange: handleTagsInputChange,
            toggleContext,
            toggleTag,
            suggestedContexts,
            suggestedTags,
            projects,
            areas: activeAreas,
            selectedProjectId,
            setSelectedProjectId,
            selectedAreaId,
            setSelectedAreaId,
            showProjectField,
            showAreaField,
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
        processingTitle,
        processingDescription,
        setProcessingTitle,
        setProcessingDescription,
        setIsProcessing,
        canGoBack: stepHistory.length > 0,
        onBack: goBack,
        handleRefineNext,
        handleSkip,
        handleNotActionable,
        handleLater,
        handleActionable,
        showDoneNowShortcut: twoMinuteEnabled && !twoMinuteFirst,
        showReferenceOption: referenceEnabled,
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
        selectedContexts,
        selectedTags,
        selectedEnergyLevel,
        setSelectedEnergyLevel,
        selectedAssignedTo,
        setSelectedAssignedTo,
        selectedTimeEstimate,
        setSelectedTimeEstimate,
        timeEstimateOptions,
        showContextsField,
        showTagsField,
        showEnergyLevelField,
        showAssignedToField,
        showTimeEstimateField,
        showPriorityField,
        selectedPriority,
        setSelectedPriority,
        allContexts,
        customContext,
        setCustomContext,
        addCustomContext,
        customTag,
        setCustomTag,
        addCustomTag,
        toggleContext,
        toggleTag,
        suggestedContexts,
        suggestedTags,
        handleConfirmContexts,
        convertToProject,
        setConvertToProject,
        setProjectTitleDraft,
        setNextActionDraft,
        projectTitleDraft,
        nextActionDraft,
        handleConvertToProject,
        projectSearch,
        setProjectSearch,
        projects,
        areas: activeAreas,
        filteredProjects,
        addProject,
        handleSetProject,
        hasExactProjectMatch,
        areaById,
        remainingCount: remainingInboxCount,
        showProjectInRefine: projectFirst && showProjectStep,
        selectedProjectId,
        setSelectedProjectId,
        selectedAreaId,
        setSelectedAreaId,
        showProjectField,
        showAreaField,
        showScheduleFields,
        scheduleFields,
        visibleScheduleFieldKeys,
    };

    return {
        inboxCount,
        quickPanelProps,
        showStartButton,
        startProcessing,
        wizardProps,
    };
}
