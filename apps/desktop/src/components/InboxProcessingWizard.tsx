import { CheckCircle, Moon, Trash2, User, X } from 'lucide-react';
import type { Area, Project, Task } from '@mindwtr/core';

import { cn } from '../lib/utils';

export type ProcessingStep = 'refine' | 'actionable' | 'twomin' | 'decide' | 'context' | 'project' | 'delegate';

type InboxProcessingWizardProps = {
    t: (key: string) => string;
    isProcessing: boolean;
    processingTask: Task | null;
    processingStep: ProcessingStep;
    processingTitle: string;
    processingDescription: string;
    setProcessingTitle: (value: string) => void;
    setProcessingDescription: (value: string) => void;
    setIsProcessing: (value: boolean) => void;
    handleRefineNext: () => void;
    handleNotActionable: (destination: 'trash' | 'someday') => void;
    handleActionable: () => void;
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
    allContexts: string[];
    customContext: string;
    setCustomContext: (value: string) => void;
    addCustomContext: () => void;
    toggleContext: (ctx: string) => void;
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
    filteredProjects: Project[];
    addProject: (title: string, color: string) => Promise<Project>;
    handleSetProject: (projectId: string | null) => void;
    hasExactProjectMatch: boolean;
    areaById: Map<string, Area>;
    remainingCount: number;
};

export function InboxProcessingWizard({
    t,
    isProcessing,
    processingTask,
    processingStep,
    processingTitle,
    processingDescription,
    setProcessingTitle,
    setProcessingDescription,
    setIsProcessing,
    handleRefineNext,
    handleNotActionable,
    handleActionable,
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
    allContexts,
    customContext,
    setCustomContext,
    addCustomContext,
    toggleContext,
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
    filteredProjects,
    addProject,
    handleSetProject,
    hasExactProjectMatch,
    areaById,
    remainingCount,
}: InboxProcessingWizardProps) {
    if (!isProcessing || !processingTask) return null;

    const currentProject = processingTask.projectId
        ? projects.find((project) => project.id === processingTask.projectId) ?? null
        : null;

    return (
        <div className="bg-card border border-border rounded-xl p-6 space-y-4 animate-in fade-in">
            <div className="flex items-center justify-between">
                <h3 className="font-semibold text-lg">📋 {t('process.title')}</h3>
                <button
                    onClick={() => setIsProcessing(false)}
                    className="text-muted-foreground hover:text-foreground"
                >
                    <X className="w-5 h-5" />
                </button>
            </div>

            {processingStep === 'refine' ? (
                <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.titleLabel')}</label>
                        <input
                            autoFocus
                            value={processingTitle}
                            onChange={(e) => setProcessingTitle(e.target.value)}
                            className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.descriptionLabel')}</label>
                        <textarea
                            value={processingDescription}
                            onChange={(e) => setProcessingDescription(e.target.value)}
                            placeholder={t('taskEdit.descriptionPlaceholder')}
                            className="w-full bg-card border border-border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary resize-none"
                            rows={3}
                        />
                    </div>
                </div>
            ) : (
                <div className="bg-muted/50 rounded-lg p-4 space-y-1">
                    <p className="font-medium">{processingTitle || processingTask.title}</p>
                    {processingDescription && (
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{processingDescription}</p>
                    )}
                </div>
            )}

            {processingStep === 'refine' && (
                <div className="space-y-4">
                    <p className="text-center font-medium">{t('process.refineTitle')}</p>
                    <p className="text-center text-sm text-muted-foreground">{t('process.refineDesc')}</p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleRefineNext}
                            className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                        >
                            {t('process.refineNext')}
                        </button>
                        <button
                            onClick={() => handleNotActionable('trash')}
                            className="flex-1 flex items-center justify-center gap-2 bg-destructive/10 text-destructive py-3 rounded-lg font-medium hover:bg-destructive/20"
                        >
                            <Trash2 className="w-4 h-4" /> {t('process.refineDelete')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'actionable' && (
                <div className="space-y-4">
                    <p className="text-center font-medium">{t('process.actionable')}</p>
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.actionableDesc')}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleActionable}
                            className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                        >
                            {t('process.yesActionable')}
                        </button>
                    </div>
                    <p className="text-xs text-muted-foreground text-center pt-2">{t('process.ifNotActionable')}</p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => handleNotActionable('trash')}
                            className="flex-1 flex items-center justify-center gap-2 bg-destructive/10 text-destructive py-2 rounded-lg font-medium hover:bg-destructive/20"
                        >
                            <Trash2 className="w-4 h-4" /> {t('process.trash')}
                        </button>
                        <button
                            onClick={() => handleNotActionable('someday')}
                            className="flex-1 flex items-center justify-center gap-2 bg-purple-500/10 text-purple-600 py-2 rounded-lg font-medium hover:bg-purple-500/20"
                        >
                            <Moon className="w-4 h-4" /> {t('process.someday')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'twomin' && (
                <div className="space-y-4">
                    <p className="text-center font-medium">{t('process.twoMin')}</p>
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
                    <p className="text-center font-medium">{t('process.nextStep')}</p>
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.nextStepDesc')}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleDefer}
                            className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                        >
                            {t('process.doIt')}
                        </button>
                        <button
                            onClick={handleDelegate}
                            className="flex-1 flex items-center justify-center gap-2 bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600"
                        >
                            <User className="w-4 h-4" /> {t('process.delegate')}
                        </button>
                    </div>
                </div>
            )}

            {processingStep === 'delegate' && (
                <div className="space-y-4">
                    <p className="text-center font-medium">👤 {t('process.delegateTitle')}</p>
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
                    <p className="text-center font-medium">{t('process.context')}</p>
                    <p className="text-center text-sm text-muted-foreground">
                        {t('process.contextDesc')} {t('process.selectMultipleHint')}
                    </p>

                    {selectedContexts.length > 0 && (
                        <div className="flex flex-wrap gap-2 justify-center p-3 bg-primary/10 rounded-lg">
                            <span className="text-xs text-primary font-medium">{t('process.selectedLabel')}</span>
                            {selectedContexts.map(ctx => (
                                <span key={ctx} className="px-2 py-1 bg-primary text-primary-foreground rounded-full text-xs">
                                    {ctx}
                                </span>
                            ))}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder={t('process.newContextPlaceholder')}
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
                            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
                        >
                            +
                        </button>
                    </div>

                    {allContexts.length > 0 && (
                        <div className="flex flex-wrap gap-2 justify-center">
                            {allContexts.map(ctx => (
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
                    <p className="text-center font-medium">{t('process.project')}</p>
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
                                        const created = await addProject(title, '#94a3b8');
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
                                            const created = await addProject(title, '#94a3b8');
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
                                                processingTask.projectId === project.id
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

            <p className="text-xs text-center text-muted-foreground pt-2">
                {remainingCount} {t('process.remaining')}
            </p>
        </div>
    );
}
