import { memo, useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, CheckCircle, ChevronLeft, ClipboardList, Clock, Hourglass, Loader2, Sparkles, Trash2, User, X } from 'lucide-react';
import { DEFAULT_PROJECT_COLOR, filterProjectsBySelectedArea, formatTimeEstimateLabel, safeFormatDate, safeParseDate, setTaskViewSectionId, tFallback, type AppData, type Area, type Project, type Task, type TaskDraft, type TaskDraftSetter, type TaskPriority, type TimeEstimate,
    numericTextCollator,
} from '@mindwtr/core';

import { cn } from '../lib/utils';
import { useNativeDateInputLocale } from '../hooks/use-native-date-input-locale';
import {
    InboxProcessingScheduleFields,
    type InboxProcessingScheduleFieldKey,
    type InboxProcessingScheduleFieldsControls,
} from './InboxProcessingScheduleFields';
import {
    parseContextsInput,
    parseTagsInput,
    useProcessingTitleFocus,
    type InboxProcessingOptionLists,
    type InboxProcessingVisibility,
} from './views/inbox/inbox-processing-utils';
import { TaskEditorAiPanels } from './Task/TaskEditorAiPanels';
import { useTaskItemAi } from './Task/useTaskItemAi';
import { TokenAutocompleteInput } from './Task/TokenAutocompleteInput';
import { AutocompleteTextInput } from './ui/AutocompleteTextInput';
import { AreaSelector } from './ui/AreaSelector';
import { ProjectSelector } from './ui/ProjectSelector';
import { DateField } from './ui/DateField';
import { QuickDateChips } from './QuickDateChips';
import { SomedaySectionSelector } from './ui/SomedaySectionSelector';

export type ProcessingStep = 'refine' | 'actionable' | 'projectcheck' | 'twomin' | 'decide' | 'context' | 'reference' | 'someday' | 'project' | 'delegate';

export type InboxProcessingWizardProps = {
    t: (key: string) => string;
    isProcessing: boolean;
    processingTask: Task | null;
    processingMode: 'guided' | 'quick';
    onModeChange: (mode: 'guided' | 'quick') => void;
    processingStep: ProcessingStep;
    /** The task fields being clarified, and the one write path into them. */
    draft: TaskDraft;
    setField: TaskDraftSetter;
    visibility: InboxProcessingVisibility;
    options: InboxProcessingOptionLists;
    setIsProcessing: (value: boolean) => void;
    canGoBack: boolean;
    onBack: () => void;
    handleRefineNext: () => void;
    handleSkip: () => void;
    handleNotActionable: (destination: 'trash' | 'someday' | 'reference') => void;
    handleLater: () => void;
    handleIncubate: () => void;
    handleActionable: () => void;
    /** This item reached the pass from Someday, not the Inbox (#1089). */
    isReturningItem: boolean;
    showDoneNowShortcut: boolean;
    handleProjectCheckNo: () => void;
    handleProjectCheckYes: () => void;
    handleTwoMinDone: () => void;
    handleTwoMinNo: () => void;
    handleDefer: () => void;
    handleDelegate: () => void;
    delegateWho: string;
    setDelegateWho: (value: string) => void;
    delegateFollowUp: string;
    setDelegateFollowUp: (value: string) => void;
    handleDelegateBack: () => void;
    handleSendDelegateRequest: () => void;
    handleConfirmWaiting: () => void;
    handleConfirmReference: () => void;
    handleConfirmSomeday: () => void;
    onCreatePerson: (name: string) => void | Promise<void>;
    onCreateSomedaySection: (title: string) => Promise<string | null>;
    customContext: string;
    setCustomContext: (value: string) => void;
    addCustomContext: (value?: string) => void;
    customTag: string;
    setCustomTag: (value: string) => void;
    addCustomTag: (value?: string) => void;
    toggleContext: (ctx: string) => void;
    toggleTag: (tag: string) => void;
    handleConfirmContexts: () => void;
    convertToProject: boolean;
    setConvertToProject: (value: boolean) => void;
    setProjectTitleDraft: (value: string) => void;
    setNextActionDraft: (value: string) => void;
    extraActionDrafts: string[];
    setExtraActionDrafts: (value: string[]) => void;
    projectTitleDraft: string;
    nextActionDraft: string;
    handleConvertToProject: () => void;
    projectSearch: string;
    setProjectSearch: (value: string) => void;
    filteredProjects: Project[];
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    handleSetProject: (projectId: string | null) => void;
    hasExactProjectMatch: boolean;
    areaById: Map<string, Area>;
    remainingCount: number;
    showProjectInRefine: boolean;
    scheduleFields: InboxProcessingScheduleFieldsControls;
    visibleScheduleFieldKeys: InboxProcessingScheduleFieldKey[];
    /** Only for the AI-enabled switch behind the clarify step's assistant. */
    settings?: AppData['settings'];
};

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: Array<NonNullable<Task['energyLevel']>> = ['low', 'medium', 'high'];

export const InboxProcessingWizard = memo(function InboxProcessingWizard({
    t,
    isProcessing,
    processingTask,
    processingMode,
    onModeChange,
    processingStep,
    draft,
    setField,
    visibility,
    options,
    setIsProcessing,
    canGoBack,
    onBack,
    handleRefineNext,
    handleSkip,
    handleNotActionable,
    handleLater,
    handleIncubate,
    handleActionable,
    isReturningItem,
    showDoneNowShortcut,
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
    onCreatePerson,
    onCreateSomedaySection,
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
    extraActionDrafts,
    setExtraActionDrafts,
    projectTitleDraft,
    nextActionDraft,
    handleConvertToProject,
    projectSearch,
    setProjectSearch,
    filteredProjects,
    addProject,
    handleSetProject,
    hasExactProjectMatch,
    areaById,
    remainingCount,
    showProjectInRefine,
    scheduleFields,
    visibleScheduleFieldKeys,
    settings,
}: InboxProcessingWizardProps) {
    const { nativeDateInputLocale, dateFormatSetting } = useNativeDateInputLocale();
    const {
        allContexts,
        allTags,
        areas,
        personOptions,
        projects,
        suggestedContexts,
        suggestedTags,
        timeEstimateOptions,
    } = options;
    const {
        showAreaField,
        showAssignedToField,
        showContextsField,
        showEnergyLevelField,
        showPriorityField,
        showProjectField,
        showReferenceOption,
        showScheduleFields,
        showTagsField,
        showTimeEstimateField,
    } = visibility;
    // The body keeps its own names for the draft fields: one alias block beats
    // rewriting every reference (and re-growing the prop list to do it).
    const processingTitle = draft.title;
    const titleInputRef = useProcessingTitleFocus(processingTask?.id, processingStep);
    const processingDescription = draft.description;
    const selectedContexts = parseContextsInput(draft.contexts);
    const selectedTags = parseTagsInput(draft.tags);
    const selectedEnergyLevel = draft.energyLevel || undefined;
    const selectedAssignedTo = draft.assignedTo;
    const selectedPriority = draft.priority || undefined;
    const selectedTimeEstimate = draft.timeEstimate || undefined;
    const selectedProjectId = draft.projectId || null;
    const selectedAreaId = draft.areaId || null;
    const setProcessingTitle = (value: string) => setField('title', value);
    const setProcessingDescription = (value: string) => setField('description', value);
    const setSelectedEnergyLevel = (value: Task['energyLevel']) => setField('energyLevel', value ?? '');
    const setSelectedAssignedTo = (value: string) => setField('assignedTo', value);
    const setSelectedPriority = (value: TaskPriority | undefined) => setField('priority', value ?? '');
    const setSelectedTimeEstimate = (value: TimeEstimate | undefined) => setField('timeEstimate', value ?? '');
    const setSelectedProjectId = (value: string | null) => setField('projectId', value ?? '');
    const setSelectedAreaId = (value: string | null) => setField('areaId', value ?? '');
    const somedaySections = settings?.gtd?.viewSections?.someday ?? [];
    const somedaySectionField = (
        <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">
                {tFallback(t, 'viewSections.somedaySection', 'Someday section')}
            </label>
            <SomedaySectionSelector
                sections={somedaySections}
                value={draft.viewSectionIds?.someday}
                onChange={(sectionId) => setField(
                    'viewSectionIds',
                    setTaskViewSectionId(draft.viewSectionIds, 'someday', sectionId),
                )}
                onCreateSection={onCreateSomedaySection}
                t={t}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
        </div>
    );

    // The same clarify action the task editor offers, on the task being
    // processed (#1022). Copilot stays off: the wizard makes no background AI
    // calls, only the one the user asks for.
    const ai = useTaskItemAi({
        taskId: processingTask?.id ?? '',
        settings,
        t,
        editTitle: draft.title,
        editDescription: draft.description,
        editContexts: draft.contexts,
        editTags: draft.tags,
        editStartTime: draft.startTime,
        editDueDate: draft.dueDate,
        editReviewAt: draft.reviewAt,
        contextOptions: allContexts,
        tagOptions: allTags,
        projectContext: null,
        timeEstimatesEnabled: showTimeEstimateField,
        setField,
        copilotEnabled: false,
    });

    // After a long step is submitted the view is left scrolled to the bottom;
    // bring the panel top (title of the next task) back into view on advance.
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [actionableChoice, setActionableChoice] = useState<'initial' | 'not-actionable' | 'later' | 'incubate'>('initial');
    const processingTaskId = processingTask?.id;
    useEffect(() => {
        if (!processingTaskId) return;
        panelRef.current?.scrollIntoView?.({ block: 'start' });
    }, [processingTaskId]);

    useEffect(() => {
        setActionableChoice('initial');
    }, [processingStep, processingTaskId]);

    if (!isProcessing || !processingTask) return null;

    const currentProject = selectedProjectId
        ? projects.find((project) => project.id === selectedProjectId) ?? null
        : null;
    const laterLabel = tFallback(t, 'process.later', 'Start later');
    const laterHint = tFallback(t, 'process.laterHint', 'Set a start date and move this to Next Actions.');
    const incubateLabel = tFallback(t, 'process.incubate', 'Incubate');
    const incubateHint = tFallback(t, 'process.incubateHint', 'Park this without deciding. It comes back to clarify on the date you choose.');
    const isReferenceOrganizationStep = processingStep === 'reference';
    const selectedOrganizationCount = selectedContexts.length + selectedTags.length;
    const compareLabels = (left: string, right: string) =>
        numericTextCollator.compare(left, right);
    const sortedProjects = [...projects].sort((a, b) => compareLabels(a.title, b.title));
    const projectFilterAreaId = selectedAreaId || undefined;
    const areaFilteredProjects = filterProjectsBySelectedArea(sortedProjects, projectFilterAreaId);
    const projectAssignmentFields = showAreaField || showProjectField ? (
        <div className="space-y-3">
            {!selectedProjectId && showAreaField ? (
                <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                    <AreaSelector
                        areas={areas}
                        value={selectedAreaId ?? ''}
                        onChange={(value) => setSelectedAreaId(value || null)}
                        placeholder={t('projects.noArea')}
                        noAreaLabel={t('projects.noArea')}
                        searchPlaceholder={t('areas.search')}
                        noMatchesLabel={t('common.noMatches')}
                        controlClassName="bg-card rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                        menuClassName="text-sm"
                    />
                </div>
            ) : null}
            {showProjectField ? (
                <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.projectLabel')}</label>
                    <ProjectSelector
                        projects={areaFilteredProjects}
                        allProjects={sortedProjects}
                        value={selectedProjectId ?? ''}
                        onChange={(value) => {
                            const nextProjectId = value || null;
                            setSelectedProjectId(nextProjectId);
                            if (nextProjectId) setSelectedAreaId(null);
                        }}
                        onCreateProject={async (title) => {
                            const created = await addProject(
                                title,
                                DEFAULT_PROJECT_COLOR,
                                projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined,
                            );
                            return created?.id ?? null;
                        }}
                        placeholder={t('process.project')}
                        noProjectLabel={t('process.noProject')}
                        searchPlaceholder={t('projects.search')}
                        noMatchesLabel={t('common.noMatches')}
                        emptyLabel={projectFilterAreaId ? t('projects.noProjectsInArea') : undefined}
                        createProjectLabel={t('projects.create')}
                        controlClassName="bg-card rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                        menuClassName="text-sm"
                    />
                </div>
            ) : null}
        </div>
    ) : null;

    const stepLabel: Record<ProcessingStep, string> = {
        refine: t('process.refineTitle'),
        actionable: t('process.actionable'),
        projectcheck: t('process.moreThanOneStep'),
        twomin: t('process.twoMin'),
        decide: t('process.nextStep'),
        context: t('process.context'),
        reference: t('process.reference'),
        someday: t('process.someday'),
        project: t('process.project'),
        delegate: t('process.delegateTitle'),
    };

    return (
        <div ref={panelRef} className="bg-card border border-border rounded-xl animate-in fade-in overflow-visible">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5">
                <div className="flex items-center gap-2.5">
                    {canGoBack && (
                        <button
                            type="button"
                            onClick={onBack}
                            className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                            aria-label={t('common.back')}
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                    )}
                    <h3 className="font-semibold text-[15px] inline-flex items-center gap-2">
                        <ClipboardList className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                        {t('process.title')}
                    </h3>
                    <span className="text-[11px] font-medium text-primary bg-primary/10 px-2.5 py-0.5 rounded-full">
                        {remainingCount} {t('process.remaining')}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                        <button
                            type="button"
                            onClick={() => onModeChange('guided')}
                            className={cn(
                                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                                processingMode === 'guided'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('process.modeGuided')}
                        </button>
                        <button
                            type="button"
                            onClick={() => onModeChange('quick')}
                            className={cn(
                                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                                processingMode === 'quick'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('process.modeQuick')}
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={handleSkip}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {t('inbox.skip')} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={() => setIsProcessing(false)}
                        className="text-muted-foreground hover:text-foreground"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="h-px bg-border" />

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
                {/* Step indicator */}
                <div className="flex items-center justify-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    <span className="text-xs font-medium text-primary">{stepLabel[processingStep]}</span>
                </div>

                {isReturningItem && (
                    <div className="flex flex-col items-center gap-1">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-someday/10 px-2.5 py-1 text-[11px] font-medium text-status-someday">
                            <Hourglass className="h-3 w-3" /> {tFallback(t, 'process.returningItem', 'Back to clarify')}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {tFallback(t, 'process.returningItemHint', 'You incubated this. Decide what it is now.')}
                        </span>
                    </div>
                )}

                {/* Task title */}
                <p className="text-center font-medium text-base leading-snug">
                    {processingTitle || processingTask.title}
                </p>

            {processingStep === 'refine' ? (
                <div className="space-y-3">
                    <p className="text-center text-sm text-muted-foreground">{t('process.refineDesc')}</p>
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.titleLabel')}</label>
                            <input
                                ref={titleInputRef}
                                value={processingTitle}
                                onChange={(e) => setProcessingTitle(e.target.value)}
                                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.descriptionLabel')}</label>
                            <textarea
                                value={processingDescription}
                                onChange={(e) => setProcessingDescription(e.target.value)}
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none resize-none"
                                rows={2}
                            />
                        </div>
                        {showProjectInRefine && showAreaField && !selectedProjectId && (
                            <div className="space-y-1">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                <AreaSelector
                                    areas={areas}
                                    value={selectedAreaId ?? ''}
                                    onChange={(value) => setSelectedAreaId(value || null)}
                                    placeholder={t('projects.noArea')}
                                    noAreaLabel={t('projects.noArea')}
                                    searchPlaceholder={t('areas.search')}
                                    noMatchesLabel={t('common.noMatches')}
                                    controlClassName="rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    menuClassName="text-sm"
                                />
                            </div>
                        )}
                        {showProjectInRefine && showProjectField && (
                            <div className="space-y-1">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.projectLabel')}</label>
                                <ProjectSelector
                                    projects={areaFilteredProjects}
                                    allProjects={sortedProjects}
                                    value={selectedProjectId ?? ''}
                                    onChange={(value) => {
                                        const nextProjectId = value || null;
                                        setSelectedProjectId(nextProjectId);
                                        if (nextProjectId) {
                                            setSelectedAreaId(null);
                                        }
                                    }}
                                    onCreateProject={async (title) => {
                                        const created = await addProject(
                                            title,
                                            DEFAULT_PROJECT_COLOR,
                                            projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined,
                                        );
                                        return created?.id ?? null;
                                    }}
                                    placeholder={t('process.project')}
                                    noProjectLabel={t('process.noProject')}
                                    searchPlaceholder={t('projects.search')}
                                    noMatchesLabel={t('common.noMatches')}
                                    emptyLabel={projectFilterAreaId ? t('projects.noProjectsInArea') : undefined}
                                    createProjectLabel={t('projects.create')}
                                    controlClassName="rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    menuClassName="text-sm"
                                />
                            </div>
                        )}
                        {ai.aiEnabled && (
                            <div className="flex flex-col gap-2 text-xs">
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={ai.handleAIClarify}
                                        disabled={ai.isAIWorking}
                                        aria-busy={ai.isAIWorking}
                                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {ai.isAIWorking
                                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            : <Sparkles className="h-3.5 w-3.5" />}
                                        {t('taskEdit.aiClarify')}
                                    </button>
                                    {ai.isAIWorking && (
                                        <span role="status" aria-live="polite" className="text-muted-foreground">
                                            {tFallback(t, 'ai.working', 'Working...')}
                                        </span>
                                    )}
                                </div>
                                <TaskEditorAiPanels ai={ai} timeEstimatesEnabled={showTimeEstimateField} t={t} />
                            </div>
                        )}
                    </div>
                </div>
            ) : null}

            {processingStep === 'refine' && (
                <>
                    <div className="h-px bg-border -mx-6" />
                    <div className="flex items-center justify-between -mx-6 -mb-5 px-5 py-3.5">
                        <button
                            onClick={() => handleNotActionable('trash')}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-destructive/10 text-destructive text-sm font-medium hover:bg-destructive/20 transition-colors"
                        >
                            <Trash2 className="w-3.5 h-3.5" /> {t('process.refineDelete')}
                        </button>
                        <button
                            onClick={handleRefineNext}
                            className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('process.refineNext')} <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </>
            )}

            {processingStep === 'actionable' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.actionableDesc')}
                    </p>
                    {actionableChoice === 'initial' && (
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <button
                                    onClick={handleActionable}
                                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                                >
                                    {t('process.yesActionable')} <CheckCircle className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setActionableChoice('not-actionable')}
                                    className="flex flex-1 items-center justify-center rounded-lg border border-border bg-card py-3 font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                    {t('inbox.no')}
                                </button>
                            </div>
                            {showDoneNowShortcut && (
                                <button
                                    onClick={handleTwoMinDone}
                                    className="mx-auto flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-success transition-colors hover:bg-success/10"
                                >
                                    <CheckCircle className="h-4 w-4" /> {t('process.doneIt')}
                                </button>
                            )}
                            {/* Deferring an action you have already decided on is
                                an actionable outcome, so it sits on this side of
                                the question rather than under "No" (#1089). */}
                            <button
                                type="button"
                                onClick={() => setActionableChoice('later')}
                                className="mx-auto flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-info transition-colors hover:bg-info/10"
                            >
                                <Clock className="h-4 w-4" /> {laterLabel}
                            </button>
                        </div>
                    )}
                    {actionableChoice === 'not-actionable' && (
                        <div className="space-y-3">
                            <button
                                type="button"
                                onClick={() => setActionableChoice('initial')}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" /> {t('common.back')}
                            </button>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                <button
                                    onClick={() => handleNotActionable('trash')}
                                    className="flex items-center justify-center gap-1.5 rounded-lg bg-destructive/10 py-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
                                >
                                    <Trash2 className="h-3.5 w-3.5" /> {t('process.trash')}
                                </button>
                                <button
                                    onClick={() => handleNotActionable('someday')}
                                    className="flex items-center justify-center gap-1.5 rounded-lg bg-status-someday/10 py-2.5 text-xs font-medium text-status-someday transition-colors hover:bg-status-someday/20"
                                >
                                    <Clock className="h-3.5 w-3.5" /> {t('process.someday')}
                                </button>
                                {showReferenceOption && (
                                    <button
                                        onClick={() => handleNotActionable('reference')}
                                        className="flex items-center justify-center gap-1.5 rounded-lg bg-status-reference/10 py-2.5 text-xs font-medium text-status-reference transition-colors hover:bg-status-reference/20"
                                    >
                                        <BookOpen className="h-3.5 w-3.5" /> {t('process.reference')}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setActionableChoice('incubate')}
                                    className="flex items-center justify-center gap-1.5 rounded-lg bg-status-someday/10 py-2.5 text-xs font-medium text-status-someday transition-colors hover:bg-status-someday/20"
                                >
                                    <Hourglass className="h-3.5 w-3.5" /> {incubateLabel}
                                </button>
                            </div>
                        </div>
                    )}
                    {actionableChoice === 'later' && (
                        <div className="space-y-3 border-t border-border pt-3">
                            <button
                                type="button"
                                onClick={() => setActionableChoice('initial')}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" /> {t('common.back')}
                            </button>
                            <div className="text-xs text-muted-foreground">{laterHint}</div>
                            <InboxProcessingScheduleFields
                                t={t}
                                fields={scheduleFields}
                                visibleFieldKeys={['start']}
                                variant="guided"
                            />
                            <button
                                type="button"
                                onClick={handleLater}
                                className="flex w-full items-center justify-center gap-2 rounded-lg bg-info py-2.5 text-sm font-medium text-info-foreground transition-colors hover:bg-info/90"
                            >
                                <Clock className="h-4 w-4" /> {laterLabel}
                            </button>
                        </div>
                    )}
                    {actionableChoice === 'incubate' && (
                        <div className="space-y-3 border-t border-border pt-3">
                            <button
                                type="button"
                                onClick={() => setActionableChoice('not-actionable')}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" /> {t('common.back')}
                            </button>
                            <div className="text-xs text-muted-foreground">{incubateHint}</div>
                            {projectAssignmentFields}
                            {somedaySectionField}
                            <InboxProcessingScheduleFields
                                t={t}
                                fields={scheduleFields}
                                visibleFieldKeys={['review']}
                                variant="guided"
                            />
                            <button
                                type="button"
                                onClick={handleIncubate}
                                className="flex w-full items-center justify-center gap-2 rounded-lg bg-status-someday py-2.5 text-sm font-medium text-white transition-colors hover:bg-status-someday/90"
                            >
                                <Hourglass className="h-4 w-4" /> {incubateLabel}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {processingStep === 'projectcheck' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.moreThanOneStepDesc')}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleProjectCheckYes}
                            className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                        >
                            {t('process.moreThanOneStepYes')}
                        </button>
                        <button
                            onClick={handleProjectCheckNo}
                            className="flex-1 bg-muted py-3 rounded-lg font-medium hover:bg-muted/80"
                        >
                            {t('process.moreThanOneStepNo')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'twomin' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.twoMinDesc')}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleTwoMinDone}
                            className="flex-1 flex items-center justify-center gap-2 bg-success text-success-foreground py-3 rounded-lg font-medium hover:bg-success/90"
                        >
                            <CheckCircle className="w-4 h-4" /> {t('process.doneIt')}
                        </button>
                        <button
                            onClick={handleTwoMinNo}
                            className="flex-1 bg-muted py-3 rounded-lg font-medium hover:bg-muted/80"
                        >
                            {t('process.takesLonger')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'decide' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.nextStepDesc')}
                    </p>
                    {showScheduleFields && (
                        <InboxProcessingScheduleFields
                            t={t}
                            fields={scheduleFields}
                            visibleFieldKeys={visibleScheduleFieldKeys}
                            variant="guided"
                        />
                    )}
                    <div className="flex gap-3">
                        <button
                            onClick={handleDelegate}
                            className="flex-1 flex items-center justify-center gap-2 bg-warning text-warning-foreground py-3 rounded-lg font-medium hover:bg-warning/90"
                        >
                            <User className="w-4 h-4" /> {t('process.delegate')}
                        </button>
                        <button
                            onClick={handleDefer}
                            className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                        >
                            {t('process.doIt')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'delegate' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.delegateDesc')}
                    </p>
                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground font-medium">{t('process.delegateWhoLabel')}</label>
                        <AutocompleteTextInput
                            value={delegateWho}
                            onChange={setDelegateWho}
                            suggestions={personOptions}
                            createLabel={tFallback(t, 'people.new', 'New Person')}
                            onCreate={onCreatePerson}
                            placeholder={t('process.delegateWhoPlaceholder')}
                            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground font-medium">{t('process.delegateFollowUpLabel')}</label>
                        <QuickDateChips
                            t={t}
                            selectedDate={safeParseDate(delegateFollowUp)}
                            onSelect={(date) => setDelegateFollowUp(date ? safeFormatDate(date, 'yyyy-MM-dd') : '')}
                        />
                        <DateField
                            t={t}
                            dateAriaLabel={t('process.delegateFollowUpLabel')}
                            dateValue={delegateFollowUp}
                            selectedDate={safeParseDate(delegateFollowUp)}
                            dateFormatSetting={dateFormatSetting}
                            nativeDateInputLocale={nativeDateInputLocale}
                            dateInputClassName="bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                            className="max-w-none"
                            hasValue={Boolean(delegateFollowUp)}
                            onDateChange={setDelegateFollowUp}
                            onClear={() => setDelegateFollowUp('')}
                        />
                    </div>
                    <button
                        type="button"
                        onClick={handleSendDelegateRequest}
                        className="w-full py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80"
                    >
                        {t('process.delegateSendRequest')}
                    </button>
                    <div className="flex gap-3">
                        <button
                            onClick={handleDelegateBack}
                            className="flex-1 py-3 bg-muted text-muted-foreground rounded-lg font-medium hover:bg-muted/80"
                        >
                            {t('common.back')}
                        </button>
                        <button
                            onClick={handleConfirmWaiting}
                            className="flex-1 py-3 bg-warning text-warning-foreground rounded-lg font-medium hover:bg-warning/90"
                        >
                            {t('process.delegateMoveToWaiting')}
                        </button>
                    </div>
                </div>
            )}

            {(processingStep === 'context' || processingStep === 'reference') && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.contextDesc')} {t('process.selectMultipleHint')}
                    </p>

                    {((showContextsField && selectedContexts.length > 0) || (showTagsField && selectedTags.length > 0)) && (
                        <div className="flex flex-wrap gap-2 justify-center p-3 bg-primary/10 rounded-lg">
                            <span className="text-xs text-primary font-medium">{t('process.selectedLabel')}</span>
                            {showContextsField
                                ? selectedContexts.map(ctx => (
                                    <span key={ctx} className="px-2 py-1 bg-primary text-primary-foreground rounded-full text-xs">
                                        {ctx}
                                    </span>
                                ))
                                : null}
                            {showTagsField
                                ? selectedTags.map(tag => (
                                    <button
                                        key={tag}
                                        onClick={() => toggleTag(tag)}
                                        className="px-2 py-1 bg-success text-success-foreground rounded-full text-xs"
                                    >
                                        {tag}
                                    </button>
                                ))
                                : null}
                        </div>
                    )}

                    {showContextsField ? (
                        <>
                            <div className="flex gap-2">
                                <TokenAutocompleteInput
                                    placeholder="@home"
                                    value={customContext}
                                    onChange={setCustomContext}
                                    suggestions={[...suggestedContexts, ...allContexts]}
                                    prefix="@"
                                    onAcceptToken={(token) => addCustomContext(token)}
                                    className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            addCustomContext();
                                        }
                                    }}
                                />
                                <button
                                    onClick={() => addCustomContext()}
                                    disabled={!customContext.trim()}
                                    className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    +
                                </button>
                            </div>

                            {suggestedContexts.length > 0 && (
                                <div className="space-y-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                                        {t('taskEdit.contextsLabel')}
                                    </div>
                                    <div className="flex flex-wrap gap-2 justify-center">
                                        {suggestedContexts.map(ctx => (
                                            <button
                                                key={ctx}
                                                onClick={() => toggleContext(ctx)}
                                                className={cn(
                                                    'px-4 py-2 rounded-full text-sm font-medium transition-colors',
                                                    selectedContexts.includes(ctx)
                                                        ? 'bg-primary text-primary-foreground'
                                                        : 'bg-muted hover:bg-muted/80'
                                                )}
                                            >
                                                {ctx}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    ) : null}

                    {showTagsField ? (
                        <div className="space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                                {t('taskEdit.tagsLabel')}
                            </div>
                            <div className="flex gap-2">
                                <TokenAutocompleteInput
                                    placeholder="#deep-work"
                                    value={customTag}
                                    onChange={setCustomTag}
                                    suggestions={[...suggestedTags, ...allTags]}
                                    prefix="#"
                                    onAcceptToken={(token) => addCustomTag(token)}
                                    className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            addCustomTag();
                                        }
                                    }}
                                />
                                <button
                                    onClick={() => addCustomTag()}
                                    disabled={!customTag.trim()}
                                    className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    +
                                </button>
                            </div>
                            {suggestedTags.length > 0 && (
                                <div className="flex flex-wrap gap-2 justify-center">
                                    {suggestedTags.map(tag => (
                                        <button
                                            key={tag}
                                            onClick={() => toggleTag(tag)}
                                            className={cn(
                                                'px-4 py-2 rounded-full text-sm font-medium transition-colors',
                                                selectedTags.includes(tag)
                                                    ? 'bg-success text-success-foreground'
                                                    : 'bg-muted hover:bg-muted/80'
                                            )}
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : null}

                    {!isReferenceOrganizationStep && showPriorityField && (
                        <div className="space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                                {t('taskEdit.priorityLabel')}
                            </div>
                            <div className="flex flex-wrap gap-2 justify-center">
                                {PRIORITY_OPTIONS.map((priority) => {
                                    const isSelected = selectedPriority === priority;
                                    return (
                                        <button
                                            key={priority}
                                            onClick={() => setSelectedPriority(isSelected ? undefined : priority)}
                                            className={cn(
                                                'px-4 py-2 rounded-full text-sm font-medium transition-colors',
                                                isSelected
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted hover:bg-muted/80'
                                            )}
                                        >
                                            {t(`priority.${priority}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {!isReferenceOrganizationStep && (showEnergyLevelField || showAssignedToField || showTimeEstimateField) && (
                        <div className="grid gap-3 md:grid-cols-2">
                            {showEnergyLevelField && (
                                <div className="space-y-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                                        {t('taskEdit.energyLevel')}
                                    </div>
                                    <select
                                        aria-label={t('taskEdit.energyLevel')}
                                        value={selectedEnergyLevel ?? ''}
                                        onChange={(event) => setSelectedEnergyLevel((event.target.value || undefined) as Task['energyLevel'])}
                                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    >
                                        <option value="">{t('common.none')}</option>
                                        {ENERGY_LEVEL_OPTIONS.map((energyLevel) => (
                                            <option key={energyLevel} value={energyLevel}>
                                                {t(`energyLevel.${energyLevel}`)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {showTimeEstimateField && (
                                <div className="space-y-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                                        {t('taskEdit.timeEstimateLabel')}
                                    </div>
                                    <select
                                        aria-label={t('taskEdit.timeEstimateLabel')}
                                        value={selectedTimeEstimate ?? ''}
                                        onChange={(event) => setSelectedTimeEstimate((event.target.value || undefined) as TimeEstimate | undefined)}
                                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    >
                                        <option value="">{t('common.none')}</option>
                                        {timeEstimateOptions.map((estimate) => (
                                            <option key={estimate} value={estimate}>
                                                {formatTimeEstimateLabel(estimate, { t })}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {showAssignedToField && (
                                <div className="space-y-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                                        {t('taskEdit.assignedTo')}
                                    </div>
                                    <AutocompleteTextInput
                                        aria-label={t('taskEdit.assignedTo')}
                                        value={selectedAssignedTo}
                                        onChange={setSelectedAssignedTo}
                                        suggestions={personOptions}
                                        createLabel={tFallback(t, 'people.new', 'New Person')}
                                        onCreate={onCreatePerson}
                                        placeholder={t('taskEdit.assignedToPlaceholder')}
                                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    />
                                </div>
                            )}
                        </div>
                    )}

                    <button
                        onClick={isReferenceOrganizationStep ? handleConfirmReference : handleConfirmContexts}
                        className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                    >
                        {selectedOrganizationCount > 0
                            ? `${t('process.next')} (${selectedOrganizationCount})`
                            : `${t('process.next')} (${t('process.noContext')})`} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {processingStep === 'someday' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.someday')}
                    </p>
                    {projectAssignmentFields}
                    {somedaySectionField}
                    <button
                        type="button"
                        onClick={handleConfirmSomeday}
                        className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                    >
                        {t('process.someday')}
                    </button>
                </div>
            )}

            {processingStep === 'project' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.projectDesc')}
                    </p>

                    {!convertToProject && currentProject && (
                        <button
                            type="button"
                            onClick={() => handleSetProject(currentProject.id)}
                            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-primary bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20"
                        >
                            <Check className="w-4 h-4" /> {currentProject.title}
                        </button>
                    )}

                    <div className="flex flex-wrap gap-2 justify-center">
                        <button
                            type="button"
                            onClick={() => {
                                if (!convertToProject) {
                                    setProjectTitleDraft(processingTitle);
                                    setNextActionDraft('');
                                    setExtraActionDrafts([]);
                                }
                                setConvertToProject(!convertToProject);
                            }}
                            className={cn(
                                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                convertToProject
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted hover:bg-muted/80 text-muted-foreground"
                            )}
                        >
                            {convertToProject ? t('process.useExistingProject') : t('process.makeProject')}
                        </button>
                    </div>

                    {convertToProject ? (
                        <div className="space-y-3">
                            {showAreaField ? (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                    <AreaSelector
                                        areas={areas}
                                        value={selectedAreaId ?? ''}
                                        onChange={(value) => setSelectedAreaId(value || null)}
                                        placeholder={t('projects.noArea')}
                                        noAreaLabel={t('projects.noArea')}
                                        searchPlaceholder={t('areas.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        controlClassName="bg-card rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                        menuClassName="text-sm"
                                    />
                                </div>
                            ) : null}
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('projects.projectName')}</label>
                                <input
                                    value={projectTitleDraft}
                                    onChange={(e) => setProjectTitleDraft(e.target.value)}
                                    placeholder={draft.title}
                                    className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary"
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('process.nextAction')}</label>
                                <input
                                    value={nextActionDraft}
                                    onChange={(e) => setNextActionDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key !== 'Enter' || !nextActionDraft.trim()) return;
                                        e.preventDefault();
                                        setExtraActionDrafts([...extraActionDrafts, '']);
                                    }}
                                    placeholder={t('taskEdit.titleLabel')}
                                    className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary"
                                />
                                {extraActionDrafts.map((draft, index) => (
                                    <div key={index} className="flex gap-2">
                                        <input
                                            autoFocus
                                            value={draft}
                                            onChange={(e) => setExtraActionDrafts(
                                                extraActionDrafts.map((value, i) => (i === index ? e.target.value : value)),
                                            )}
                                            onKeyDown={(e) => {
                                                if (e.key !== 'Enter' || index !== extraActionDrafts.length - 1 || !draft.trim()) return;
                                                e.preventDefault();
                                                setExtraActionDrafts([...extraActionDrafts, '']);
                                            }}
                                            placeholder={t('taskEdit.titleLabel')}
                                            className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary"
                                        />
                                        <button
                                            type="button"
                                            aria-label={t('process.removeAction')}
                                            onClick={() => setExtraActionDrafts(extraActionDrafts.filter((_, i) => i !== index))}
                                            className="px-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setExtraActionDrafts([...extraActionDrafts, ''])}
                                    className="text-xs font-medium text-primary hover:underline"
                                >
                                    + {t('process.addAnotherAction')}
                                </button>
                            </div>
                            <button
                                type="button"
                                onClick={handleConvertToProject}
                                className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                            >
                                {t('process.createProject')}
                            </button>
                        </div>
                    ) : (
                        <>
                            {showAreaField ? (
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                    <AreaSelector
                                        areas={areas}
                                        value={selectedAreaId ?? ''}
                                        onChange={(value) => setSelectedAreaId(value || null)}
                                        placeholder={t('projects.noArea')}
                                        noAreaLabel={t('projects.noArea')}
                                        searchPlaceholder={t('areas.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        controlClassName="bg-card rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                        menuClassName="text-sm"
                                    />
                                </div>
                            ) : null}
                            {showProjectField ? (
                                <>
                                    <div className="space-y-2">
                                        <input
                                            value={projectSearch}
                                            onChange={(e) => setProjectSearch(e.target.value)}
                                            onKeyDown={async (e) => {
                                                if (e.key !== 'Enter') return;
                                                if (!projectSearch.trim()) return;
                                                e.preventDefault();
                                                const title = projectSearch.trim();
                                                const existing = filteredProjects.find((project) => project.title.toLowerCase() === title.toLowerCase());
                                                if (existing) {
                                                    handleSetProject(existing.id);
                                                    return;
                                                }
                                                const created = await addProject(
                                                    title,
                                                    DEFAULT_PROJECT_COLOR,
                                                    projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined,
                                                );
                                                if (!created) return;
                                                handleSetProject(created.id);
                                                setProjectSearch('');
                                            }}
                                            placeholder={t('projects.addPlaceholder')}
                                            className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary focus:border-transparent"
                                        />
                                        {!hasExactProjectMatch && projectSearch.trim() && (
                                            <button
                                                type="button"
                                                onClick={async () => {
                                                    const title = projectSearch.trim();
                                                    if (!title) return;
                                                    const created = await addProject(
                                                        title,
                                                        DEFAULT_PROJECT_COLOR,
                                                        projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined,
                                                    );
                                                    if (!created) return;
                                                    handleSetProject(created.id);
                                                    setProjectSearch('');
                                                }}
                                                className="w-full py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                                            >
                                                {t('projects.create')} "{projectSearch.trim()}"
                                            </button>
                                        )}
                                    </div>

                                    <button
                                        onClick={() => handleSetProject(null)}
                                        className="w-full py-3 bg-muted rounded-lg font-medium hover:bg-muted/80"
                                    >
                                        {t('process.noProject')}
                                    </button>

                                    {filteredProjects.length > 0 && (
                                        <div className="space-y-2 max-h-48 overflow-y-auto">
                                            {filteredProjects.map(project => (
                                                <button
                                                    key={project.id}
                                                    onClick={() => handleSetProject(project.id)}
                                                    className={cn(
                                                        "w-full flex items-center gap-3 p-3 rounded-lg text-left border",
                                                        selectedProjectId === project.id
                                                            ? "bg-primary/10 border-primary"
                                                            : "bg-muted border-transparent hover:bg-muted/80"
                                                    )}
                                                >
                                                    <div
                                                        className="w-3 h-3 rounded-full"
                                                        style={{ backgroundColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || 'hsl(var(--muted-foreground))' }}
                                                    />
                                                    <span>{project.title}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <button
                                    onClick={() => handleSetProject(null)}
                                    className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                                >
                                    {t('process.next')} <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}

            </div>
        </div>
    );
});

InboxProcessingWizard.displayName = 'InboxProcessingWizard';
