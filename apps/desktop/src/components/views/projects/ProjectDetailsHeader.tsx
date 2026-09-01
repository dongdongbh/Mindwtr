import { format } from 'date-fns';
import { safeParseDate, tFallback, type Project } from '@mindwtr/core';
import { Archive as ArchiveIcon, Calendar, CalendarClock, ChevronDown, ChevronRight, Copy, FolderOpenDot, HelpCircle, ListOrdered, Loader2, RotateCcw, Signal, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

type ProjectProgress = {
    total: number;
    doneCount: number;
    remainingCount: number;
    isArchived?: boolean;
};

type ProjectDetailsHeaderProps = {
    project: Project;
    projectColor: string;
    areaLabel?: string;
    isSequential: boolean;
    dueDate?: string;
    reviewAt?: string;
    editTitle: string;
    onEditTitleChange: (value: string) => void;
    onCommitTitle: () => void;
    onResetTitle: () => void;
    detailsExpanded: boolean;
    onToggleDetails: () => void;
    onDuplicate: () => void;
    onArchive: () => Promise<void> | void;
    onReactivate: () => void;
    onDelete: () => Promise<void> | void;
    isDeleting?: boolean;
    readOnly?: boolean;
    readOnlyHint?: string;
    projectProgress?: ProjectProgress | null;
    t: (key: string) => string;
};

export function ProjectDetailsHeader({
    project,
    projectColor,
    areaLabel,
    isSequential,
    dueDate,
    reviewAt,
    editTitle,
    onEditTitleChange,
    onCommitTitle,
    onResetTitle,
    detailsExpanded,
    onToggleDetails,
    onDuplicate,
    onArchive,
    onReactivate,
    onDelete,
    isDeleting = false,
    readOnly = false,
    readOnlyHint,
    projectProgress,
    t,
}: ProjectDetailsHeaderProps) {
    const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
    const completedRatio = projectProgress && projectProgress.total > 0
        ? projectProgress.isArchived
            ? 100
            : Math.round((projectProgress.doneCount / projectProgress.total) * 100)
        : 0;
    const progressText = projectProgress?.isArchived && projectProgress.total > 0
        ? `${projectProgress.total} ${tFallback(t, 'list.done', 'Completed')}`
        : projectProgress && projectProgress.total > 0
          ? `${projectProgress.doneCount}/${projectProgress.total} ${t('status.done')} • ${projectProgress.remainingCount} ${t('process.remaining')}`
          : t('projects.noActiveTasks');
    const [projectTypeHelpOpen, setProjectTypeHelpOpen] = useState(false);
    const projectTypeHelpLabel = tFallback(t, 'projects.projectTypeHelpLabel', 'Project type help');
    const projectTypeHelpText = tFallback(
        t,
        'projects.projectTypeHelpText',
        'Sequential projects surface one available action at a time. Parallel projects can surface multiple independent Next tasks.'
    );
    const detailsLabel = tFallback(t, 'taskEdit.details', 'Details');
    const dueDateValue = dueDate ? safeParseDate(dueDate) : null;
    const reviewDate = reviewAt ? safeParseDate(reviewAt) : null;
    const dueLabelPrefix = tFallback(t, 'taskEdit.dueDateLabel', 'Due');
    const reviewLabelPrefix = tFallback(t, 'projects.reviewAt', 'Review');
    const summaryItems = [
        {
            key: 'status',
            icon: Signal,
            label: tFallback(t, `status.${project.status}`, project.status),
        },
        ...(areaLabel ? [{
            key: 'area',
            icon: FolderOpenDot,
            label: areaLabel,
        }] : []),
        {
            key: 'sequence',
            icon: ListOrdered,
            label: isSequential
                ? tFallback(t, 'projects.sequential', 'Sequential')
                : tFallback(t, 'projects.parallel', 'Parallel'),
        },
        ...(dueDateValue ? [{
            key: 'due',
            icon: Calendar,
            label: `${dueLabelPrefix}: ${format(dueDateValue, 'MMM d')}`,
        }] : []),
        ...(reviewDate ? [{
            key: 'review',
            icon: CalendarClock,
            label: `${reviewLabelPrefix}: ${format(reviewDate, 'MMM d')}`,
        }] : []),
    ];
    useLayoutEffect(() => {
        const element = titleInputRef.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = `${element.scrollHeight}px`;
    }, [editTitle]);

    return (
        <header className="project-details-header pb-5 border-b border-border/50">
            <div className="project-details-header__content flex flex-wrap items-start justify-between gap-4">
                <div className="project-details-header__titleGroup flex items-start gap-3 min-w-0 flex-1">
                    <span
                        className="mt-2 w-3 h-3 flex-none rounded-full border border-border"
                        style={{ backgroundColor: projectColor }}
                        aria-hidden="true"
                    />
                    <div className="flex flex-col min-w-0 flex-1 gap-2">
                        <textarea
                            ref={titleInputRef}
                            value={editTitle}
                            onChange={(e) => onEditTitleChange(e.target.value.replace(/\s*\n+\s*/g, ' '))}
                            onBlur={onCommitTitle}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                    onResetTitle();
                                    e.currentTarget.blur();
                                }
                            }}
                            title={readOnly ? readOnlyHint : (editTitle || project.title)}
                            rows={1}
                            readOnly={readOnly}
                            aria-readonly={readOnly}
                            className="project-details-header__titleInput min-w-0 w-full resize-none overflow-hidden break-words bg-transparent border-b border-transparent text-2xl font-bold leading-tight focus:border-border focus:outline-none read-only:cursor-default read-only:focus:border-transparent"
                            aria-label={t('projects.title')}
                        />
                    <div className="flex flex-wrap gap-1.5">
                        {summaryItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <div key={item.key} className="inline-flex items-center gap-1">
                                    <span
                                        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[11px] text-muted-foreground"
                                    >
                                        <Icon className="h-3.5 w-3.5 flex-none" />
                                        <span className="min-w-0 truncate">{item.label}</span>
                                    </span>
                                    {item.key === 'sequence' && (
                                        <span className="relative inline-flex">
                                            <button
                                                type="button"
                                                aria-label={projectTypeHelpLabel}
                                                aria-expanded={projectTypeHelpOpen}
                                                onClick={() => setProjectTypeHelpOpen((open) => !open)}
                                                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                            >
                                                <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                            </button>
                                            {projectTypeHelpOpen && (
                                                <span
                                                    role="note"
                                                    className="absolute left-1/2 top-7 z-30 w-64 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-left text-xs leading-5 text-popover-foreground shadow-lg"
                                                >
                                                    {projectTypeHelpText}
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        </div>
                        {project.tagIds && project.tagIds.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                                {project.tagIds.map((tag) => (
                                    <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full border border-border/60 bg-muted/20 text-muted-foreground">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                <div className="project-details-header__actions flex items-center gap-2 flex-wrap justify-end">
                    <button
                        type="button"
                        onClick={onToggleDetails}
                        className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-xs font-medium border border-border bg-background hover:bg-muted/40 text-muted-foreground transition-colors whitespace-nowrap"
                        aria-expanded={detailsExpanded}
                    >
                        {detailsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        {detailsLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onDuplicate}
                        className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-xs font-medium border border-border bg-background hover:bg-muted/40 text-muted-foreground transition-colors whitespace-nowrap"
                    >
                        <Copy className="w-4 h-4" />
                        {t('projects.duplicate')}
                    </button>
                    {project.status === 'archived' ? (
                        <button
                            type="button"
                            onClick={onReactivate}
                            className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-xs font-medium border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors whitespace-nowrap"
                        >
                            <RotateCcw className="w-4 h-4" />
                            {t('projects.reactivate')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={onArchive}
                            className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-xs font-medium border border-border bg-background hover:bg-muted/40 text-muted-foreground transition-colors whitespace-nowrap"
                        >
                            <ArchiveIcon className="w-4 h-4" />
                            {t('projects.archive')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onDelete}
                        className="text-destructive hover:bg-destructive/10 h-8 w-8 rounded-md transition-colors flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                        title={readOnly ? readOnlyHint : t('common.delete')}
                        aria-label={t('common.delete')}
                        disabled={isDeleting || readOnly}
                        aria-busy={isDeleting}
                    >
                        {isDeleting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Trash2 className="w-4 h-4" />
                        )}
                    </button>
                </div>
            </div>
            {projectProgress ? (
                <div className="mt-4 space-y-1.5">
                    <div className="text-xs text-muted-foreground">
                        {progressText}
                    </div>
                    {projectProgress.total > 0 && (
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                                className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none"
                                style={{ transform: `scaleX(${completedRatio / 100})` }}
                            />
                        </div>
                    )}
                </div>
            ) : null}
        </header>
    );
}
