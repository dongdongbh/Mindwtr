import { ArrowRight, BookOpen, CheckCircle, Clock, Trash2, User, X } from 'lucide-react';
import { DEFAULT_PROJECT_COLOR, type Area, type Project, type Task } from '@mindwtr/core';

import { cn } from '../lib/utils';
import { ProjectSelector } from './ui/ProjectSelector';

type QuickActionabilityChoice = 'actionable' | 'trash' | 'someday' | 'reference';
type QuickTwoMinuteChoice = 'yes' | 'no';
type QuickExecutionChoice = 'defer' | 'delegate';

type InboxProcessingQuickPanelProps = {
    t: (key: string) => string;
    processingTask: Task;
    remainingCount: number;
    processingTitle: string;
    processingDescription: string;
    setProcessingTitle: (value: string) => void;
    setProcessingDescription: (value: string) => void;
    processingMode: 'guided' | 'quick';
    onModeChange: (mode: 'guided' | 'quick') => void;
    onSkip: () => void;
    onClose: () => void;
    showReferenceOption: boolean;
    actionabilityChoice: QuickActionabilityChoice;
    setActionabilityChoice: (value: QuickActionabilityChoice) => void;
    twoMinuteChoice: QuickTwoMinuteChoice;
    setTwoMinuteChoice: (value: QuickTwoMinuteChoice) => void;
    executionChoice: QuickExecutionChoice;
    setExecutionChoice: (value: QuickExecutionChoice) => void;
    showScheduleFields: boolean;
    scheduleDate: string;
    scheduleTimeDraft: string;
    setScheduleDate: (value: string) => void;
    setScheduleTimeDraft: (value: string) => void;
    onScheduleTimeCommit: () => void;
    delegateWho: string;
    setDelegateWho: (value: string) => void;
    delegateFollowUp: string;
    setDelegateFollowUp: (value: string) => void;
    onSendDelegateRequest: () => void;
    selectedContexts: string[];
    selectedTags: string[];
    onContextsInputChange: (value: string) => void;
    onTagsInputChange: (value: string) => void;
    toggleContext: (ctx: string) => void;
    toggleTag: (tag: string) => void;
    suggestedContexts: string[];
    suggestedTags: string[];
    projects: Project[];
    areas: Area[];
    selectedProjectId: string | null;
    setSelectedProjectId: (value: string | null) => void;
    selectedAreaId: string | null;
    setSelectedAreaId: (value: string | null) => void;
    convertToProject: boolean;
    setConvertToProject: (value: boolean) => void;
    projectTitleDraft: string;
    setProjectTitleDraft: (value: string) => void;
    nextActionDraft: string;
    setNextActionDraft: (value: string) => void;
    addProject: (title: string, color: string) => Promise<Project | null>;
    onSubmit: () => void | Promise<void>;
};

export type {
    QuickActionabilityChoice,
    QuickExecutionChoice,
    QuickTwoMinuteChoice,
};

export function InboxProcessingQuickPanel({
    t,
    processingTask,
    remainingCount,
    processingTitle,
    processingDescription,
    setProcessingTitle,
    setProcessingDescription,
    processingMode,
    onModeChange,
    onSkip,
    onClose,
    showReferenceOption,
    actionabilityChoice,
    setActionabilityChoice,
    twoMinuteChoice,
    setTwoMinuteChoice,
    executionChoice,
    setExecutionChoice,
    showScheduleFields,
    scheduleDate,
    scheduleTimeDraft,
    setScheduleDate,
    setScheduleTimeDraft,
    onScheduleTimeCommit,
    delegateWho,
    setDelegateWho,
    delegateFollowUp,
    setDelegateFollowUp,
    onSendDelegateRequest,
    selectedContexts,
    selectedTags,
    onContextsInputChange,
    onTagsInputChange,
    toggleContext,
    toggleTag,
    suggestedContexts,
    suggestedTags,
    projects,
    areas,
    selectedProjectId,
    setSelectedProjectId,
    selectedAreaId,
    setSelectedAreaId,
    convertToProject,
    setConvertToProject,
    projectTitleDraft,
    setProjectTitleDraft,
    nextActionDraft,
    setNextActionDraft,
    addProject,
    onSubmit,
}: InboxProcessingQuickPanelProps) {
    const showActionFields = actionabilityChoice === 'actionable';
    const showDecisionFields = showActionFields && twoMinuteChoice === 'no';
    const showDelegationFields = showDecisionFields && executionChoice === 'delegate';
    const showNextActionFields = showDecisionFields && executionChoice === 'defer';

    return (
        <div className="bg-card border border-border rounded-xl animate-in fade-in overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="flex items-center gap-2.5 min-w-0">
                    <h3 className="font-semibold text-[15px] truncate">📋 {t('process.title')}</h3>
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
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                                    ? 'bg-purple-500/15 text-purple-500 border-purple-500/40'
                                    : 'bg-muted/40 border-border hover:bg-muted/70'
                            )}
                        >
                            <Clock className="w-3.5 h-3.5 inline mr-1.5" />
                            {t('process.someday')}
                        </button>
                        {showReferenceOption ? (
                            <button
                                type="button"
                                onClick={() => setActionabilityChoice('reference')}
                                className={cn(
                                    'rounded-lg px-3 py-2 text-xs font-medium transition-colors border',
                                    actionabilityChoice === 'reference'
                                        ? 'bg-cyan-500/15 text-cyan-500 border-cyan-500/40'
                                        : 'bg-muted/40 border-border hover:bg-muted/70'
                                )}
                            >
                                <BookOpen className="w-3.5 h-3.5 inline mr-1.5" />
                                {t('process.reference')}
                            </button>
                        ) : null}
                    </div>
                </div>

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
                                        ? 'bg-green-500 text-white border-green-600'
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
                            <div className="space-y-2">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.startDateLabel')}</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="date"
                                        aria-label={t('taskEdit.startDateLabel')}
                                        value={scheduleDate}
                                        onChange={(event) => setScheduleDate(event.target.value)}
                                        className="flex-1 text-sm bg-muted/50 border border-border rounded px-3 py-2 text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    />
                                    <input
                                        type="text"
                                        aria-label={t('task.aria.startTime')}
                                        value={scheduleTimeDraft}
                                        inputMode="numeric"
                                        placeholder="HH:MM"
                                        onChange={(event) => setScheduleTimeDraft(event.target.value)}
                                        onBlur={onScheduleTimeCommit}
                                        className="w-28 text-sm bg-muted/50 border border-border rounded px-3 py-2 text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                    />
                                </div>
                            </div>
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
                                            ? 'bg-orange-500 text-white border-orange-600'
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
                            <input
                                aria-label={t('process.delegateWhoLabel')}
                                value={delegateWho}
                                onChange={(event) => setDelegateWho(event.target.value)}
                                placeholder={t('process.delegateWhoPlaceholder')}
                                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground font-medium">{t('process.delegateFollowUpLabel')}</label>
                            <input
                                type="date"
                                aria-label={t('process.delegateFollowUpLabel')}
                                value={delegateFollowUp}
                                onChange={(event) => setDelegateFollowUp(event.target.value)}
                                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
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
                        ) : (
                            <div className="space-y-3">
                                <div className="space-y-1">
                                    <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.projectLabel')}</label>
                                    <ProjectSelector
                                        projects={projects}
                                        value={selectedProjectId ?? ''}
                                        onChange={(value) => {
                                            const nextProjectId = value || null;
                                            setSelectedProjectId(nextProjectId);
                                            if (nextProjectId) {
                                                setSelectedAreaId(null);
                                            }
                                        }}
                                        onCreateProject={async (title) => {
                                            const created = await addProject(title, DEFAULT_PROJECT_COLOR);
                                            return created?.id ?? null;
                                        }}
                                        placeholder={t('process.project')}
                                        noProjectLabel={t('process.noProject')}
                                        searchPlaceholder={t('projects.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        createProjectLabel={t('projects.create')}
                                    />
                                </div>
                                {!selectedProjectId ? (
                                    <div className="space-y-1">
                                        <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                        <select
                                            aria-label={t('taskEdit.areaLabel')}
                                            value={selectedAreaId ?? ''}
                                            onChange={(event) => setSelectedAreaId(event.target.value || null)}
                                            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
                                        >
                                            <option value="">{t('projects.noArea')}</option>
                                            {areas.map((area) => (
                                                <option key={area.id} value={area.id}>
                                                    {area.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                ) : null}
                            </div>
                        )}

                        <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.contextsLabel')}</label>
                                <input
                                    aria-label={t('taskEdit.contextsLabel')}
                                    value={selectedContexts.join(', ')}
                                    onChange={(event) => onContextsInputChange(event.target.value)}
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
                            <div className="space-y-2">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.tagsLabel')}</label>
                                <input
                                    aria-label={t('taskEdit.tagsLabel')}
                                    value={selectedTags.join(', ')}
                                    onChange={(event) => onTagsInputChange(event.target.value)}
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
                                                        ? 'bg-emerald-500 text-white border-emerald-600'
                                                        : 'bg-muted/40 border-border hover:bg-muted/70'
                                                )}
                                            >
                                                {tag}
                                            </button>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>
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
                            onScheduleTimeCommit();
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
