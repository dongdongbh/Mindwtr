import { format } from 'date-fns';
import { safeParseDate, tFallback, type Project } from '@mindwtr/core';
import { Archive as ArchiveIcon, Calendar, CalendarClock, CalendarRange, Check, Copy, FolderOpenDot, HelpCircle, Info, ListOrdered, Loader2, MoreHorizontal, RotateCcw, Signal, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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

const MENU_ITEM_CLASS = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60';

// One compact row: dot, title, inline summary chips, then progress and a "..."
// menu on the right. The project-management actions (Details, Duplicate,
// Archive/Reactivate, Delete) live in the menu so the task list starts higher (#1160).
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
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
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
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    // Task rows carry the bare "More options" label; name the project so assistive tech
    // (and tests) can tell this menu apart from the rows below it.
    const menuLabel = `${moreOptionsLabel}: ${editTitle.trim() || project.title}`;
    const startDateValue = project.startDate ? safeParseDate(project.startDate) : null;
    const dueDateValue = dueDate ? safeParseDate(dueDate) : null;
    const reviewDate = reviewAt ? safeParseDate(reviewAt) : null;
    const startLabelPrefix = tFallback(t, 'taskEdit.startDateLabel', 'Start');
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
        ...(startDateValue ? [{
            key: 'start',
            icon: CalendarRange,
            label: `${startLabelPrefix}: ${format(startDateValue, 'MMM d')}`,
        }] : []),
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

    useEffect(() => {
        if (!menuOpen) return;
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const handlePointer = (event: Event) => {
            if (menuRef.current && menuRef.current.contains(event.target as Node)) return;
            setMenuOpen(false);
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setMenuOpen(false);
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('keydown', handleKey);
        };
    }, [menuOpen]);

    const runMenuAction = (action: () => unknown) => {
        setMenuOpen(false);
        action();
    };

    // .project-details-header is a size container (index.css), which makes it a stacking
    // context: the menu's z-40 only competes inside the header, and the sticky task toolbar
    // rendered after it (z-20) paints over the open menu. Lift the whole header above the
    // toolbar only while a popover is open, so the header still scrolls under the toolbar
    // the rest of the time.
    const popoverOpen = menuOpen || projectTypeHelpOpen;

    return (
        <header className={`project-details-header pb-3 border-b border-border/50 ${popoverOpen ? 'relative z-30' : ''}`}>
            <div className="project-details-header__content flex items-center justify-between gap-3">
                <div className="project-details-header__titleGroup flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 flex-1">
                    <span
                        className="w-3 h-3 flex-none rounded-full border border-border"
                        style={{ backgroundColor: projectColor }}
                        aria-hidden="true"
                    />
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
                        className="project-details-header__titleInput min-w-0 flex-1 basis-40 resize-none overflow-hidden break-words bg-transparent border-b border-transparent text-xl font-bold leading-tight focus:border-border focus:outline-none read-only:cursor-default read-only:focus:border-transparent"
                        aria-label={t('projects.title')}
                    />
                    <div className="flex flex-wrap items-center gap-1">
                        {summaryItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <div key={item.key} className="inline-flex items-center gap-1">
                                    <span
                                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[11px] text-muted-foreground"
                                    >
                                        <Icon className="h-3 w-3 flex-none" />
                                        <span className="min-w-0 truncate">{item.label}</span>
                                    </span>
                                    {item.key === 'sequence' && (
                                        <span className="relative inline-flex">
                                            <button
                                                type="button"
                                                aria-label={projectTypeHelpLabel}
                                                aria-expanded={projectTypeHelpOpen}
                                                onClick={() => setProjectTypeHelpOpen((open) => !open)}
                                                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                            >
                                                <HelpCircle className="h-3 w-3" aria-hidden="true" />
                                            </button>
                                            {projectTypeHelpOpen && (
                                                <span
                                                    role="note"
                                                    className="absolute left-1/2 top-6 z-30 w-64 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-left text-xs leading-5 text-popover-foreground shadow-lg"
                                                >
                                                    {projectTypeHelpText}
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        {project.tagIds?.map((tag) => (
                            <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full border border-border/60 bg-muted/20 text-muted-foreground">
                                {tag}
                            </span>
                        ))}
                    </div>
                </div>
                <div className="project-details-header__actions flex items-center gap-3 flex-none">
                    {projectProgress ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                            <span>{progressText}</span>
                            {projectProgress.total > 0 && (
                                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                                    <div
                                        className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none"
                                        style={{ transform: `scaleX(${completedRatio / 100})` }}
                                    />
                                </div>
                            )}
                        </div>
                    ) : null}
                    <div ref={menuRef} className="relative">
                        <button
                            type="button"
                            onClick={() => setMenuOpen((open) => !open)}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={menuLabel}
                            title={moreOptionsLabel}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                            {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
                        </button>
                        {menuOpen && (
                            <div
                                role="menu"
                                className="absolute right-0 top-full z-40 mt-1 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-lg"
                            >
                                <button
                                    type="button"
                                    role="menuitem"
                                    aria-expanded={detailsExpanded}
                                    onClick={() => runMenuAction(onToggleDetails)}
                                    className={MENU_ITEM_CLASS}
                                >
                                    <Info className="w-4 h-4" />
                                    <span className="flex-1">{detailsLabel}</span>
                                    {detailsExpanded && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => runMenuAction(onDuplicate)}
                                    className={MENU_ITEM_CLASS}
                                >
                                    <Copy className="w-4 h-4" />
                                    {t('projects.duplicate')}
                                </button>
                                {project.status === 'archived' ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => runMenuAction(onReactivate)}
                                        className={MENU_ITEM_CLASS}
                                    >
                                        <RotateCcw className="w-4 h-4" />
                                        {t('projects.reactivate')}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => runMenuAction(onArchive)}
                                        className={MENU_ITEM_CLASS}
                                    >
                                        <ArchiveIcon className="w-4 h-4" />
                                        {t('projects.archive')}
                                    </button>
                                )}
                                <div className="my-1 border-t border-border/60" role="separator" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => runMenuAction(onDelete)}
                                    className={`${MENU_ITEM_CLASS} text-destructive hover:bg-destructive/10 focus:bg-destructive/10`}
                                    title={readOnly ? readOnlyHint : undefined}
                                    disabled={isDeleting || readOnly}
                                >
                                    <Trash2 className="w-4 h-4" />
                                    {t('common.delete')}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </header>
    );
}
