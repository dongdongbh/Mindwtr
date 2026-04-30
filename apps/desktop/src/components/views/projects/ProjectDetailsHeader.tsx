import { format } from 'date-fns';
import { safeParseDate, tFallback, type Project } from '@mindwtr/core';
import { Archive as ArchiveIcon, Calendar, CalendarClock, ChevronDown, ChevronRight, Copy, FolderOpenDot, ListOrdered, Loader2, RotateCcw, Signal, Trash2 } from 'lucide-react';

type ProjectProgress = {
    total: number;
    doneCount: number;
    remainingCount: number;
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
    projectProgress,
    t,
}: ProjectDetailsHeaderProps) {
    const completedRatio = projectProgress && projectProgress.total > 0
        ? Math.round((projectProgress.doneCount / projectProgress.total) * 100)
        : 0;
    const detailsLabel = tFallback(t, 'taskEdit.details', 'Details');
    const dueDateValue = dueDate ? safeParseDate(dueDate) : null;
    const reviewDate = reviewAt ? safeParseDate(reviewAt) : null;
    const dueLabelPrefix = tFallback(t, 'taskEdit.dueDateLabel', 'Due');
    const reviewLabelPrefix = tFallback(t, 'projects.reviewAt', 'Review');
    const summaryItems = [
        {
            key: 'status',
            icon: Signal,
            label: t(`status.${project.status}`) || project.status,
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

    return (
        <header className="pb-5 border-b border-border/50">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                    <span
                        className="w-3 h-3 rounded-full border border-border"
                        style={{ backgroundColor: projectColor }}
                        aria-hidden="true"
                    />
                    <div className="flex flex-col min-w-0 flex-1 gap-2">
                        <input
                            value={editTitle}
                            onChange={(e) => onEditTitleChange(e.target.value)}
                            onBlur={onCommitTitle}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    (e.currentTarget as HTMLInputElement).blur();
                                } else if (e.key === 'Escape') {
                                    onResetTitle();
                                    (e.currentTarget as HTMLInputElement).blur();
                                }
                            }}
                            className="text-2xl font-bold truncate bg-transparent border-b border-transparent focus:border-border focus:outline-none w-full"
                            aria-label={t('projects.title')}
                        />
                        {projectProgress ? (
                            <div className="space-y-1.5">
                                <div className="text-xs text-muted-foreground">
                                    {projectProgress.total > 0
                                        ? `${projectProgress.doneCount}/${projectProgress.total} ${t('status.done')} • ${projectProgress.remainingCount} ${t('process.remaining')}`
                                        : t('projects.noActiveTasks')}
                                </div>
                                {projectProgress.total > 0 && (
                                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-primary transition-[width] duration-300"
                                            style={{ width: `${completedRatio}%` }}
                                        />
                                    </div>
                                )}
                            </div>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5">
                            {summaryItems.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <span
                                        key={item.key}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[11px] text-muted-foreground"
                                    >
                                        <Icon className="h-3.5 w-3.5" />
                                        <span>{item.label}</span>
                                    </span>
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
                <div className="flex items-center gap-2 flex-wrap justify-end">
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
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                        disabled={isDeleting}
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
        </header>
    );
}
