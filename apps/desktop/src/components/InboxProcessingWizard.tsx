import { ArrowRight, BookOpen, CheckCircle, ChevronLeft, Clock, Trash2, User, X } from 'lucide-react';
import { DEFAULT_PROJECT_COLOR, type Area, type Project, type Task } from '@mindwtr/core';

import { cn } from '../lib/utils';
import { ProjectSelector } from './ui/ProjectSelector';

export type ProcessingStep = 'refine' | 'actionable' | 'projectcheck' | 'twomin' | 'decide' | 'context' | 'project' | 'delegate';

type InboxProcessingWizardProps = {
    t: (key: string) => string;
    isProcessing: boolean;
    processingTask: Task | null;
    processingMode: 'guided' | 'quick';
    onModeChange: (mode: 'guided' | 'quick') => void;
    processingStep: ProcessingStep;
    processingTitle: string;
    processingDescription: string;
    setProcessingTitle: (value: string) => void;
    setProcessingDescription: (value: string) => void;
    setIsProcessing: (value: boolean) => void;
    canGoBack: boolean;
    onBack: () => void;
    handleRefineNext: () => void;
    handleSkip: () => void;
    handleNotActionable: (destination: 'trash' | 'someday' | 'reference') => void;
    handleActionable: () => void;
    showDoneNowShortcut: boolean;
    showReferenceOption: boolean;
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
    selectedContexts: string[];
    selectedTags: string[];
    allContexts: string[];
    customContext: string;
    setCustomContext: (value: string) => void;
    addCustomContext: () => void;
    customTag: string;
    setCustomTag: (value: string) => void;
    addCustomTag: () => void;
    toggleContext: (ctx: string) => void;
    toggleTag: (tag: string) => void;
    suggestedContexts: string[];
    suggestedTags: string[];
    handleConfirmContexts: () => void;
    convertToProject: boolean;
    setConvertToProject: (value: boolean) => void;
    setProjectTitleDraft: (value: string) => void;
    setNextActionDraft: (value: string) => void;
    projectTitleDraft: string;
    nextActionDraft: string;
    handleConvertToProject: () => void;
    projectSearch: string;
    setProjectSearch: (value: string) => void;
    projects: Project[];
    areas: Area[];
    filteredProjects: Project[];
    addProject: (title: string, color: string) => Promise<Project | null>;
    handleSetProject: (projectId: string | null) => void;
    hasExactProjectMatch: boolean;
    areaById: Map<string, Area>;
    remainingCount: number;
    showProjectInRefine: boolean;
    selectedProjectId: string | null;
    setSelectedProjectId: (value: string | null) => void;
    selectedAreaId: string | null;
    setSelectedAreaId: (value: string | null) => void;
    scheduleDate: string;
    scheduleTimeDraft: string;
    setScheduleDate: (value: string) => void;
    setScheduleTimeDraft: (value: string) => void;
    onScheduleTimeCommit: () => void;
    showScheduleFields: boolean;
};

export function InboxProcessingWizard({
    t,
    isProcessing,
    processingTask,
    processingMode,
    onModeChange,
    processingStep,
    processingTitle,
    processingDescription,
    setProcessingTitle,
    setProcessingDescription,
    setIsProcessing,
    canGoBack,
    onBack,
    handleRefineNext,
    handleSkip,
    handleNotActionable,
    handleActionable,
    showDoneNowShortcut,
    showReferenceOption,
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
    areas,
    filteredProjects,
    addProject,
    handleSetProject,
    hasExactProjectMatch,
    areaById,
    remainingCount,
    showProjectInRefine,
    selectedProjectId,
    setSelectedProjectId,
    selectedAreaId,
    setSelectedAreaId,
    scheduleDate,
    scheduleTimeDraft,
    setScheduleDate,
    setScheduleTimeDraft,
    onScheduleTimeCommit,
    showScheduleFields,
}: InboxProcessingWizardProps) {
    if (!isProcessing || !processingTask) return null;

    const currentProject = selectedProjectId
        ? projects.find((project) => project.id === selectedProjectId) ?? null
        : null;

    const stepLabel: Record<ProcessingStep, string> = {
        refine: t('process.refineTitle'),
        actionable: t('process.actionable'),
        projectcheck: t('process.moreThanOneStep'),
        twomin: t('process.twoMin'),
        decide: t('process.nextStep'),
        context: t('process.context'),
        project: t('process.project'),
        delegate: t('process.delegateTitle'),
    };

    return (
        <div className="bg-card border border-border rounded-xl animate-in fade-in overflow-hidden">
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
                    <h3 className="font-semibold text-[15px]">📋 {t('process.title')}</h3>
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
                        {showProjectInRefine && (
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
                        )}
                        {showProjectInRefine && !selectedProjectId && (
                            <div className="space-y-1">
                                <label className="text-[11px] text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                <select
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
                            className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
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
                    <div className="flex gap-2">
                        <button
                            onClick={() => handleNotActionable('trash')}
                            className="flex-1 flex items-center justify-center gap-1.5 bg-destructive/10 text-destructive py-2.5 rounded-lg text-xs font-medium hover:bg-destructive/20 transition-colors"
                        >
                            <Trash2 className="w-3.5 h-3.5" /> {t('process.trash')}
                        </button>
                        <button
                            onClick={() => handleNotActionable('someday')}
                            className="flex-1 flex items-center justify-center gap-1.5 bg-purple-500/10 text-purple-400 py-2.5 rounded-lg text-xs font-medium hover:bg-purple-500/20 transition-colors"
                        >
                            <Clock className="w-3.5 h-3.5" /> {t('process.someday')}
                        </button>
                        {showReferenceOption && (
                            <button
                                onClick={() => handleNotActionable('reference')}
                                className="flex-1 flex items-center justify-center gap-1.5 bg-cyan-500/10 text-cyan-400 py-2.5 rounded-lg text-xs font-medium hover:bg-cyan-500/20 transition-colors"
                            >
                                <BookOpen className="w-3.5 h-3.5" /> {t('process.reference')}
                            </button>
                        )}
                    </div>
                    <div className={cn('gap-3', showDoneNowShortcut ? 'flex' : 'block')}>
                        <button
                            onClick={handleActionable}
                            className={cn(
                                'flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 rounded-lg font-semibold hover:bg-primary/90 transition-colors',
                                showDoneNowShortcut ? 'flex-1' : 'w-full'
                            )}
                        >
                            {t('process.yesActionable')} <CheckCircle className="w-4 h-4" />
                        </button>
                        {showDoneNowShortcut && (
                            <button
                                onClick={handleTwoMinDone}
                                className="flex-1 flex items-center justify-center gap-2 bg-green-500 text-white py-3 rounded-lg font-semibold hover:bg-green-600 transition-colors"
                            >
                                <CheckCircle className="w-4 h-4" /> {t('process.doneIt')}
                            </button>
                        )}
                    </div>
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
                            className="flex-1 flex items-center justify-center gap-2 bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600"
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
                        <div className="space-y-1">
                            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.startDateLabel')}</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="date"
                                    value={scheduleDate}
                                    onChange={(e) => setScheduleDate(e.target.value)}
                                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                                />
                                <input
                                    type="text"
                                    value={scheduleTimeDraft}
                                    inputMode="numeric"
                                    placeholder="HH:MM"
                                    onChange={(e) => setScheduleTimeDraft(e.target.value)}
                                    onBlur={onScheduleTimeCommit}
                                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                                />
                            </div>
                        </div>
                    )}
                    <div className="flex gap-3">
                        <button
                            onClick={handleDelegate}
                            className="flex-1 flex items-center justify-center gap-2 bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600"
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
                        <input
                            value={delegateWho}
                            onChange={(e) => setDelegateWho(e.target.value)}
                            placeholder={t('process.delegateWhoPlaceholder')}
                            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground font-medium">{t('process.delegateFollowUpLabel')}</label>
                        <input
                            type="date"
                            value={delegateFollowUp}
                            onChange={(e) => setDelegateFollowUp(e.target.value)}
                            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
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
                            className="flex-1 py-3 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600"
                        >
                            {t('process.delegateMoveToWaiting')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'context' && (
                <div className="space-y-4">
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.contextDesc')} {t('process.selectMultipleHint')}
                    </p>

                    {(selectedContexts.length > 0 || selectedTags.length > 0) && (
                        <div className="flex flex-wrap gap-2 justify-center p-3 bg-primary/10 rounded-lg">
                            <span className="text-xs text-primary font-medium">{t('process.selectedLabel')}</span>
                            {selectedContexts.map(ctx => (
                                <span key={ctx} className="px-2 py-1 bg-primary text-primary-foreground rounded-full text-xs">
                                    {ctx}
                                </span>
                            ))}
                            {selectedTags.map(tag => (
                                <button
                                    key={tag}
                                    onClick={() => toggleTag(tag)}
                                    className="px-2 py-1 bg-emerald-500 text-white rounded-full text-xs"
                                >
                                    {tag}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder="@home"
                            value={customContext}
                            onChange={(e) => setCustomContext(e.target.value)}
                            className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    addCustomContext();
                                }
                            }}
                        />
                        <button
                            onClick={addCustomContext}
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

                    {allContexts.length > 0 && (
                        <div className="flex flex-wrap gap-2 justify-center">
                            {allContexts.filter((ctx) => !suggestedContexts.includes(ctx)).map(ctx => (
                                <button
                                    key={ctx}
                                    onClick={() => toggleContext(ctx)}
                                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${selectedContexts.includes(ctx)
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted hover:bg-muted/80'
                                        }`}
                                >
                                    {ctx}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="space-y-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                            {t('taskEdit.tagsLabel')}
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="#deep-work"
                                value={customTag}
                                onChange={(e) => setCustomTag(e.target.value)}
                                className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        addCustomTag();
                                    }
                                }}
                            />
                            <button
                                onClick={addCustomTag}
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
                                                ? 'bg-emerald-500 text-white'
                                                : 'bg-muted hover:bg-muted/80'
                                        )}
                                    >
                                        {tag}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <button
                        onClick={handleConfirmContexts}
                        className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                    >
                        {selectedContexts.length > 0
                            ? `${t('process.next')} → (${selectedContexts.length})`
                            : `${t('process.next')} → (${t('process.noContext')})`}
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
                            ✓ {currentProject.title}
                        </button>
                    )}

                    <div className="flex flex-wrap gap-2 justify-center">
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
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('projects.title')}</label>
                                <input
                                    value={projectTitleDraft}
                                    onChange={(e) => setProjectTitleDraft(e.target.value)}
                                    className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary"
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('process.nextAction')}</label>
                                <input
                                    value={nextActionDraft}
                                    onChange={(e) => setNextActionDraft(e.target.value)}
                                    placeholder={t('taskEdit.titleLabel')}
                                    className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary"
                                />
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
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                <select
                                    value={selectedAreaId ?? ''}
                                    onChange={(event) => setSelectedAreaId(event.target.value || null)}
                                    className="w-full bg-card border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary focus:border-transparent"
                                >
                                    <option value="">{t('projects.noArea')}</option>
                                    {areas.map((area) => (
                                        <option key={area.id} value={area.id}>
                                            {area.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="space-y-2">
                                <input
                                    value={projectSearch}
                                    onChange={(e) => setProjectSearch(e.target.value)}
                                    onKeyDown={async (e) => {
                                        if (e.key !== 'Enter') return;
                                        if (!projectSearch.trim()) return;
                                        e.preventDefault();
                                        const title = projectSearch.trim();
                                        const existing = projects.find((project) => project.title.toLowerCase() === title.toLowerCase());
                                        if (existing) {
                                            handleSetProject(existing.id);
                                            return;
                                        }
                                        const created = await addProject(title, DEFAULT_PROJECT_COLOR);
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
                                            const created = await addProject(title, DEFAULT_PROJECT_COLOR);
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
                                className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
                            >
                                ✓ {t('process.noProject')}
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
                                                style={{ backgroundColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || '#6B7280' }}
                                            />
                                            <span>{project.title}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            </div>
        </div>
    );
}
