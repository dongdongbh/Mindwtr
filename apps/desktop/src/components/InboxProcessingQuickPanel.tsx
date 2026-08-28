import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowRight, BookOpen, CheckCircle, ClipboardList, Clock, Hourglass, Trash2, User, X } from 'lucide-react';
import { DEFAULT_PROJECT_COLOR, filterProjectsBySelectedArea, formatTimeEstimateLabel, safeFormatDate, safeParseDate, setTaskViewSectionId, tFallback, type AppData, type Project, type Task, type TaskDraft, type TaskDraftSetter, type TaskPriority, type TimeEstimate,
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
import { TokenAutocompleteInput } from './Task/TokenAutocompleteInput';
import { AutocompleteTextInput } from './ui/AutocompleteTextInput';
import { AreaSelector } from './ui/AreaSelector';
import { ProjectSelector } from './ui/ProjectSelector';
import { DateField } from './ui/DateField';
import { QuickDateChips } from './QuickDateChips';
import { SomedaySectionSelector } from './ui/SomedaySectionSelector';

type QuickActionabilityChoice = 'actionable' | 'later' | 'trash' | 'someday' | 'reference' | 'incubate';
type QuickTwoMinuteChoice = 'yes' | 'no';
type QuickExecutionChoice = 'defer' | 'delegate';

export type InboxProcessingQuickPanelProps = {
    t: (key: string) => string;
    processingTask: Task;
    remainingCount: number;
    /** The task fields being clarified, and the one write path into them. */
    draft: TaskDraft;
    setField: TaskDraftSetter;
    visibility: InboxProcessingVisibility;
    options: InboxProcessingOptionLists;
    settings?: AppData['settings'];
    processingMode: 'guided' | 'quick';
    onModeChange: (mode: 'guided' | 'quick') => void;
    onSkip: () => void;
    /** This item reached the pass from Someday, not the Inbox (#1089). */
    isReturningItem: boolean;
    onClose: () => void;
    actionabilityChoice: QuickActionabilityChoice;
    setActionabilityChoice: (value: QuickActionabilityChoice) => void;
    twoMinuteChoice: QuickTwoMinuteChoice;
    setTwoMinuteChoice: (value: QuickTwoMinuteChoice) => void;
    executionChoice: QuickExecutionChoice;
    setExecutionChoice: (value: QuickExecutionChoice) => void;
    scheduleFields: InboxProcessingScheduleFieldsControls;
    visibleScheduleFieldKeys: InboxProcessingScheduleFieldKey[];
    delegateWho: string;
    setDelegateWho: (value: string) => void;
    delegateFollowUp: string;
    setDelegateFollowUp: (value: string) => void;
    onSendDelegateRequest: () => void;
    onCreatePerson: (name: string) => void | Promise<void>;
    onCreateSomedaySection: (title: string) => Promise<string | null>;
    toggleContext: (ctx: string) => void;
    toggleTag: (tag: string) => void;
    convertToProject: boolean;
    setConvertToProject: (value: boolean) => void;
    projectTitleDraft: string;
    setProjectTitleDraft: (value: string) => void;
    nextActionDraft: string;
    setNextActionDraft: (value: string) => void;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    onSubmit: () => void | Promise<void>;
};

export type {
    QuickActionabilityChoice,
    QuickExecutionChoice,
    QuickTwoMinuteChoice,
};

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: Array<NonNullable<Task['energyLevel']>> = ['low', 'medium', 'high'];

const shouldCommitQuickProcessingFromEnter = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return false;
    if (target.closest('button, [role="button"], [role="option"], [role="listbox"]')) return false;

    const tagName = target.tagName.toLowerCase();
    if (tagName === 'textarea' || tagName === 'select') return false;
    return tagName === 'input';
};

const shouldCommitQuickProcessingFromShortcut = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return true;
    if (target.isContentEditable) return false;
    if (target.closest('[role="option"], [role="listbox"]')) return false;
    return target.tagName.toLowerCase() !== 'select';
};

const isQuickProcessingSubmitShortcut = (event: Pick<KeyboardEvent | globalThis.KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>): boolean => (
    event.key === 'Enter' && !event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey)
);

export function InboxProcessingQuickPanel({
    t,
    processingTask,
    remainingCount,
    draft,
    setField,
    visibility,
    options,
    settings,
    processingMode,
    onModeChange,
    onSkip,
    isReturningItem,
    onClose,
    actionabilityChoice,
    setActionabilityChoice,
    twoMinuteChoice,
    setTwoMinuteChoice,
    executionChoice,
    setExecutionChoice,
    scheduleFields,
    visibleScheduleFieldKeys,
    delegateWho,
    setDelegateWho,
    delegateFollowUp,
    setDelegateFollowUp,
    onSendDelegateRequest,
    onCreatePerson,
    onCreateSomedaySection,
    toggleContext,
    toggleTag,
    convertToProject,
    setConvertToProject,
    projectTitleDraft,
    setProjectTitleDraft,
    nextActionDraft,
    setNextActionDraft,
    addProject,
    onSubmit,
}: InboxProcessingQuickPanelProps) {
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
    const titleInputRef = useProcessingTitleFocus(processingTask?.id);
    const processingDescription = draft.description;
    const contextsDraft = draft.contexts;
    const tagsDraft = draft.tags;
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
    const onContextsInputChange = (value: string) => setField('contexts', value);
    const onTagsInputChange = (value: string) => setField('tags', value);
    const setSelectedEnergyLevel = (value: Task['energyLevel']) => setField('energyLevel', value ?? '');
    const setSelectedAssignedTo = (value: string) => setField('assignedTo', value);
    const setSelectedPriority = (value: TaskPriority | undefined) => setField('priority', value ?? '');
    const setSelectedTimeEstimate = (value: TimeEstimate | undefined) => setField('timeEstimate', value ?? '');
    const setSelectedProjectId = (value: string | null) => setField('projectId', value ?? '');
    const setSelectedAreaId = (value: string | null) => setField('areaId', value ?? '');
    const somedaySections = settings?.gtd?.viewSections?.someday ?? [];
    const somedaySectionField = (
        <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground font-medium">
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

    const showActionFields = actionabilityChoice === 'actionable';
    const showLaterFields = actionabilityChoice === 'later';
    const showIncubateFields = actionabilityChoice === 'incubate';
    const showDecisionFields = showActionFields && twoMinuteChoice === 'no';
    const showDelegationFields = showDecisionFields && executionChoice === 'delegate';
    const showNextActionFields = showDecisionFields && executionChoice === 'defer';
    const showReferenceOrganizationFields = actionabilityChoice === 'reference';
    const showDeferredOrganizationFields = actionabilityChoice === 'someday'
        || actionabilityChoice === 'incubate';
    const laterLabel = tFallback(t, 'process.later', 'Start later');
    const laterHint = tFallback(t, 'process.laterHint', 'Set a start date and move this to Next Actions.');
    const incubateLabel = tFallback(t, 'process.incubate', 'Incubate');
    const incubateHint = tFallback(t, 'process.incubateHint', 'Park this without deciding. It comes back to clarify on the date you choose.');
    const compareLabels = (left: string, right: string) =>
        numericTextCollator.compare(left, right);
    const sortedProjects = [...projects].sort((a, b) => compareLabels(a.title, b.title));
    const projectFilterAreaId = selectedAreaId || undefined;
    const filteredProjects = filterProjectsBySelectedArea(sortedProjects, projectFilterAreaId);
    const organizationContainerFields = showAreaField || showProjectField ? (
        <div className="space-y-3">
            {!selectedProjectId && showAreaField ? (
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
            ) : null}
            {showProjectField ? (
                <div className="space-y-1">
                    <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.projectLabel')}</label>
                    <ProjectSelector
                        projects={filteredProjects}
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
                        controlClassName="rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                        menuClassName="text-sm"
                    />
                </div>
            ) : null}
        </div>
    ) : null;
    const organizationTokenFields = showContextsField || showTagsField ? (
        <div className="grid gap-3 md:grid-cols-2">
            {showContextsField ? (
                <div className="space-y-2">
                    <label htmlFor="quick-processing-contexts" className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.contextsLabel')}</label>
                    <TokenAutocompleteInput
                        id="quick-processing-contexts"
                        aria-label={t('taskEdit.contextsLabel')}
                        value={contextsDraft}
                        onChange={onContextsInputChange}
                        suggestions={[...suggestedContexts, ...allContexts]}
                        prefix="@"
                        placeholder={t('taskEdit.contextsPlaceholder')}
                        className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                    />
                    {suggestedContexts.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                            {suggestedContexts.map((ctx) => (
                                <button
                                    key={ctx}
                                    type="button"
                                    onClick={() => toggleContext(ctx)}
                                    className={cn(
                                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors border',
                                        selectedContexts.includes(ctx)
                                            ? 'bg-primary text-primary-foreground border-primary'
                                            : 'bg-muted/40 border-border hover:bg-muted/70'
                                    )}
                                >
                                    {ctx}
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
            {showTagsField ? (
                <div className="space-y-2">
                    <label htmlFor="quick-processing-tags" className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.tagsLabel')}</label>
                    <TokenAutocompleteInput
                        id="quick-processing-tags"
                        aria-label={t('taskEdit.tagsLabel')}
                        value={tagsDraft}
                        onChange={onTagsInputChange}
                        suggestions={[...suggestedTags, ...allTags]}
                        prefix="#"
                        placeholder={t('taskEdit.tagsPlaceholder')}
                        className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                    />
                    {suggestedTags.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                            {suggestedTags.map((tag) => (
                                <button
                                    key={tag}
                                    type="button"
                                    onClick={() => toggleTag(tag)}
                                    className={cn(
                                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors border',
                                        selectedTags.includes(tag)
                                            ? 'bg-success text-success-foreground border-success'
                                            : 'bg-muted/40 border-border hover:bg-muted/70'
                                    )}
                                >
                                    {tag}
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    ) : null;

    useEffect(() => {
        const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (event.key === 'Process' || event.isComposing) return;
            if (!isQuickProcessingSubmitShortcut(event)) return;
            if (!shouldCommitQuickProcessingFromShortcut(event.target)) return;

            event.preventDefault();
            event.stopPropagation();
            void onSubmit();
        };

        document.addEventListener('keydown', handleDocumentKeyDown);
        return () => document.removeEventListener('keydown', handleDocumentKeyDown);
    }, [onSubmit]);

    // After a long form is submitted the view is left scrolled to the bottom;
    // bring the panel top (title of the next task) back into view on advance.
    const panelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        panelRef.current?.scrollIntoView?.({ block: 'start' });
    }, [processingTask.id]);

    const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.defaultPrevented) return;
        if (event.key === 'Process' || event.nativeEvent.isComposing) return;
        if (isQuickProcessingSubmitShortcut(event)) return;
        if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
        if (!shouldCommitQuickProcessingFromEnter(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        void onSubmit();
    };

    return (
        <div
            ref={panelRef}
            className="bg-card border border-border rounded-xl animate-in fade-in overflow-visible"
            onKeyDown={handlePanelKeyDown}
        >
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="flex items-center gap-2.5 min-w-0">
                    <h3 className="font-semibold text-[15px] truncate inline-flex items-center gap-2">
                        <ClipboardList className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                        <span className="truncate">{t('process.title')}</span>
                    </h3>
                    <span className="text-[11px] font-medium text-primary bg-primary/10 px-2.5 py-0.5 rounded-full shrink-0">
                        {remainingCount} {t('process.remaining')}
                    </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
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
                        onClick={onSkip}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {t('inbox.skip')} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-muted-foreground hover:text-foreground"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="h-px bg-border" />

            <div className="px-6 py-5 space-y-5">
                <div className="space-y-1">
                    {isReturningItem && (
                        <div className="flex flex-col items-center gap-1 pb-1">
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-status-someday/10 px-2.5 py-1 text-[11px] font-medium text-status-someday">
                                <Hourglass className="h-3 w-3" /> {tFallback(t, 'process.returningItem', 'Back to clarify')}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {tFallback(t, 'process.returningItemHint', 'You incubated this. Decide what it is now.')}
                            </span>
                        </div>
                    )}
                    <p className="text-center font-medium text-base leading-snug">
                        {processingTitle || processingTask.title}
                    </p>
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.quickDesc')}
                    </p>
                </div>

                <div className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.titleLabel')}</label>
                        <input
                            ref={titleInputRef}
                            aria-label={t('taskEdit.titleLabel')}
                            value={processingTitle}
                            onChange={(event) => setProcessingTitle(event.target.value)}
                            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.descriptionLabel')}</label>
                        <textarea
                            aria-label={t('taskEdit.descriptionLabel')}
                            value={processingDescription}
                            onChange={(event) => setProcessingDescription(event.target.value)}
                            placeholder={t('taskEdit.descriptionPlaceholder')}
                            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none resize-none"
                            rows={3}
                        />
                    </div>
                </div>

                <div className="space-y-3">
                    <div>
                        <div className="text-sm font-medium">{t('process.actionable')}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t('process.actionableDesc')}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <button
                            type="button"
                            onClick={() => setActionabilityChoice('actionable')}
                            className={cn(
                                'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                actionabilityChoice === 'actionable'
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-muted/40 border-border hover:bg-muted/70'
                            )}
                        >
                            <CheckCircle className="w-3.5 h-3.5 inline mr-1.5" />
                            {t('process.yesActionable')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActionabilityChoice('later')}
                            className={cn(
                                'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                actionabilityChoice === 'later'
                                    ? 'bg-info/15 text-info border-info/40'
                                    : 'bg-muted/40 border-border hover:bg-muted/70'
                            )}
                        >
                            <Clock className="w-3.5 h-3.5 inline mr-1.5" />
                            {laterLabel}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActionabilityChoice('trash')}
                            className={cn(
                                'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                actionabilityChoice === 'trash'
                                    ? 'bg-destructive/15 text-destructive border-destructive/40'
                                    : 'bg-muted/40 border-border hover:bg-muted/70'
                            )}
                        >
                            <Trash2 className="w-3.5 h-3.5 inline mr-1.5" />
                            {t('process.trash')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActionabilityChoice('someday')}
                            className={cn(
                                'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                actionabilityChoice === 'someday'
                                    ? 'bg-status-someday/15 text-status-someday border-status-someday/40'
                                    : 'bg-muted/40 border-border hover:bg-muted/70'
                            )}
                        >
                            <Clock className="w-3.5 h-3.5 inline mr-1.5" />
                            {t('process.someday')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActionabilityChoice('incubate')}
                            className={cn(
                                'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                actionabilityChoice === 'incubate'
                                    ? 'bg-status-someday/15 text-status-someday border-status-someday/40'
                                    : 'bg-muted/40 border-border hover:bg-muted/70'
                            )}
                        >
                            <Hourglass className="w-3.5 h-3.5 inline mr-1.5" />
                            {incubateLabel}
                        </button>
                        {showReferenceOption ? (
                            <button
                                type="button"
                                onClick={() => setActionabilityChoice('reference')}
                                className={cn(
                                    'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                    actionabilityChoice === 'reference'
                                        ? 'bg-status-reference/15 text-status-reference border-status-reference/40'
                                        : 'bg-muted/40 border-border hover:bg-muted/70'
                                )}
                            >
                                <BookOpen className="w-3.5 h-3.5 inline mr-1.5" />
                                {t('process.reference')}
                            </button>
                        ) : null}
                    </div>
                </div>

                {showLaterFields ? (
                    <div className="space-y-3 rounded-lg border border-info/20 bg-info/5 p-3">
                        <div className="text-xs text-muted-foreground">{laterHint}</div>
                        <InboxProcessingScheduleFields
                            t={t}
                            fields={scheduleFields}
                            visibleFieldKeys={['start']}
                            variant="quick"
                        />
                    </div>
                ) : null}

                {showIncubateFields ? (
                    <div className="space-y-3 rounded-lg border border-status-someday/20 bg-status-someday/5 p-3">
                        <div className="text-xs text-muted-foreground">{incubateHint}</div>
                        <InboxProcessingScheduleFields
                            t={t}
                            fields={scheduleFields}
                            visibleFieldKeys={['review']}
                            variant="quick"
                        />
                    </div>
                ) : null}

                {showReferenceOrganizationFields && organizationTokenFields ? (
                    <div className="rounded-lg border border-status-reference/20 bg-status-reference/5 p-3">
                        {organizationTokenFields}
                    </div>
                ) : null}

                {showDeferredOrganizationFields && (organizationContainerFields || somedaySectionField) ? (
                    <div className="rounded-lg border border-status-someday/20 bg-status-someday/5 p-3">
                        <div className="space-y-3">
                            {organizationContainerFields}
                            {somedaySectionField}
                        </div>
                    </div>
                ) : null}

                {showActionFields ? (
                    <div className="space-y-3">
                        <div>
                            <div className="text-sm font-medium">{t('process.twoMin')}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t('process.twoMinDesc')}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setTwoMinuteChoice('yes')}
                                className={cn(
                                    'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                    twoMinuteChoice === 'yes'
                                        ? 'bg-success text-success-foreground border-success'
                                        : 'bg-muted/40 border-border hover:bg-muted/70'
                                )}
                            >
                                {t('process.doneIt')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setTwoMinuteChoice('no')}
                                className={cn(
                                    'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                    twoMinuteChoice === 'no'
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'bg-muted/40 border-border hover:bg-muted/70'
                                )}
                            >
                                {t('process.takesLonger')}
                            </button>
                        </div>
                    </div>
                ) : null}

                {showDecisionFields ? (
                    <>
                        {showScheduleFields ? (
                            <InboxProcessingScheduleFields
                                t={t}
                                fields={scheduleFields}
                                visibleFieldKeys={visibleScheduleFieldKeys}
                                variant="quick"
                            />
                        ) : null}

                        <div className="space-y-3">
                            <div>
                                <div className="text-sm font-medium">{t('process.nextStep')}</div>
                                <div className="text-xs text-muted-foreground mt-1">{t('process.nextStepDesc')}</div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setExecutionChoice('defer')}
                                    className={cn(
                                        'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                        executionChoice === 'defer'
                                            ? 'bg-primary text-primary-foreground border-primary'
                                            : 'bg-muted/40 border-border hover:bg-muted/70'
                                    )}
                                >
                                    {t('process.doIt')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setExecutionChoice('delegate')}
                                    className={cn(
                                        'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                        executionChoice === 'delegate'
                                            ? 'bg-warning text-warning-foreground border-warning'
                                            : 'bg-muted/40 border-border hover:bg-muted/70'
                                    )}
                                >
                                    <User className="w-3.5 h-3.5 inline mr-1.5" />
                                    {t('process.delegate')}
                                </button>
                            </div>
                        </div>
                    </>
                ) : null}

                {showDelegationFields ? (
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground font-medium">{t('process.delegateWhoLabel')}</label>
                            <AutocompleteTextInput
                                aria-label={t('process.delegateWhoLabel')}
                                value={delegateWho}
                                onChange={setDelegateWho}
                                suggestions={personOptions}
                                createLabel={tFallback(t, 'people.new', 'New Person')}
                                onCreate={onCreatePerson}
                                placeholder={t('process.delegateWhoPlaceholder')}
                                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground font-medium">{t('process.delegateFollowUpLabel')}</label>
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
                                dateInputClassName="bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                className="max-w-none"
                                hasValue={Boolean(delegateFollowUp)}
                                onDateChange={setDelegateFollowUp}
                                onClear={() => setDelegateFollowUp('')}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={onSendDelegateRequest}
                            className="w-full py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80"
                        >
                            {t('process.delegateSendRequest')}
                        </button>
                    </div>
                ) : null}

                {showNextActionFields ? (
                    <>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    if (!convertToProject) {
                                        setProjectTitleDraft(processingTitle);
                                        setNextActionDraft('');
                                    }
                                    setConvertToProject(!convertToProject);
                                }}
                                className={cn(
                                    'px-3 py-1.5 rounded-full text-xs font-medium transition-colors border',
                                    convertToProject
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'bg-muted/40 border-border text-muted-foreground hover:text-foreground hover:bg-muted/70'
                                )}
                            >
                                {convertToProject ? t('process.useExistingProject') : t('process.makeProject')}
                            </button>
                        </div>

                        {convertToProject ? (
                            <div className="space-y-3">
                                {showAreaField ? (
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
                                ) : null}
                                <div className="space-y-1">
                                    <label className="text-[11px] text-muted-foreground font-medium">{t('projects.title')}</label>
                                    <input
                                        aria-label={t('projects.title')}
                                        value={projectTitleDraft}
                                        onChange={(event) => setProjectTitleDraft(event.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-[11px] text-muted-foreground font-medium">{t('process.nextAction')}</label>
                                    <input
                                        aria-label={t('process.nextAction')}
                                        value={nextActionDraft}
                                        onChange={(event) => setNextActionDraft(event.target.value)}
                                        placeholder={t('taskEdit.titleLabel')}
                                        className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    />
                                </div>
                            </div>
                        ) : organizationContainerFields}

                        {organizationTokenFields}

                        {showPriorityField ? (
                            <div className="space-y-2">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.priorityLabel')}</label>
                                <div className="flex flex-wrap gap-2">
                                    {PRIORITY_OPTIONS.map((priority) => {
                                        const isSelected = selectedPriority === priority;
                                        return (
                                            <button
                                                key={priority}
                                                type="button"
                                                onClick={() => setSelectedPriority(isSelected ? undefined : priority)}
                                                className={cn(
                                                    'px-2.5 py-1 rounded-full text-xs font-medium transition-colors border',
                                                    isSelected
                                                        ? 'bg-primary text-primary-foreground border-primary'
                                                        : 'bg-muted/40 border-border hover:bg-muted/70'
                                                )}
                                            >
                                                {t(`priority.${priority}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : null}

                        {showEnergyLevelField || showAssignedToField || showTimeEstimateField ? (
                            <div className="grid gap-3 md:grid-cols-2">
                                {showEnergyLevelField ? (
                                    <div className="space-y-2">
                                        <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.energyLevel')}</label>
                                        <select
                                            aria-label={t('taskEdit.energyLevel')}
                                            value={selectedEnergyLevel ?? ''}
                                            onChange={(event) => setSelectedEnergyLevel((event.target.value || undefined) as Task['energyLevel'])}
                                            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                        >
                                            <option value="">{t('common.none')}</option>
                                            {ENERGY_LEVEL_OPTIONS.map((energyLevel) => (
                                                <option key={energyLevel} value={energyLevel}>
                                                    {t(`energyLevel.${energyLevel}`)}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                ) : null}
                                {showTimeEstimateField ? (
                                    <div className="space-y-2">
                                        <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.timeEstimateLabel')}</label>
                                        <select
                                            aria-label={t('taskEdit.timeEstimateLabel')}
                                            value={selectedTimeEstimate ?? ''}
                                            onChange={(event) => setSelectedTimeEstimate((event.target.value || undefined) as TimeEstimate | undefined)}
                                            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                        >
                                            <option value="">{t('common.none')}</option>
                                            {timeEstimateOptions.map((estimate) => (
                                                <option key={estimate} value={estimate}>
                                                    {formatTimeEstimateLabel(estimate, { t })}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                ) : null}
                                {showAssignedToField ? (
                                    <div className="space-y-2">
                                        <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.assignedTo')}</label>
                                        <AutocompleteTextInput
                                            aria-label={t('taskEdit.assignedTo')}
                                            value={selectedAssignedTo}
                                            onChange={setSelectedAssignedTo}
                                            suggestions={personOptions}
                                            createLabel={tFallback(t, 'people.new', 'New Person')}
                                            onCreate={onCreatePerson}
                                            placeholder={t('taskEdit.assignedToPlaceholder')}
                                            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                        />
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </>
                ) : null}

                <div className="h-px bg-border -mx-6" />
                <div className="flex items-center justify-between gap-4 -mx-6 -mb-5 px-5 py-3.5">
                        <p className="text-xs text-muted-foreground">
                        {actionabilityChoice === 'actionable'
                            ? t('process.quickApplyHint')
                            : t('process.quickMoveHint')}
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            void onSubmit();
                        }}
                        className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shrink-0"
                    >
                        {t('process.next')} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </div>
    );
}
