import { format } from 'date-fns';
import { safeParseDate, tFallback, type Project } from '@mindwtr/core';
import { Calendar, CheckCircle, Copy, FolderOpenDot, FolderPlus, Loader2, MoreHorizontal, RotateCcw, Signal, SlidersHorizontal, Trash2, XCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

type ProjectProgress = {
    total: number;
    doneCount: number;
    remainingCount: number;
    isArchived?: boolean;
};

type ProjectDetailsHeaderProps = {
    primaryAction?: ReactNode;
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
    onConvertToSection?: () => void;
    convertToSectionBlockedReason?: string;
    onArchive: () => Promise<void> | void;
    onCancel?: () => Promise<void> | void;
    onReactivate: () => void;
    onDelete: () => Promise<void> | void;
    isDeleting?: boolean;
    readOnly?: boolean;
    readOnlyHint?: string;
    projectProgress?: ProjectProgress | null;
    t: (key: string) => string;
};

const MENU_ITEM_CLASS = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60';

// The title owns the primary line; only the essential project summary stays below it.
// Project management and the full settings grid remain available from the "..." menu
// without competing with long titles (#1160).
export function ProjectDetailsHeader({
    primaryAction,
    project,
    projectColor,
    areaLabel,
    dueDate,
    editTitle,
    onEditTitleChange,
    onCommitTitle,
    onResetTitle,
    detailsExpanded,
    onToggleDetails,
    onDuplicate,
    onConvertToSection,
    convertToSectionBlockedReason,
    onArchive,
    onCancel,
    onReactivate,
    onDelete,
    isDeleting = false,
    readOnly = false,
    readOnlyHint,
    projectProgress,
    t,
}: ProjectDetailsHeaderProps) {
    const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
    const skipTitleCommitOnBlurRef = useRef(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
    const menuPanelRef = useRef<HTMLDivElement | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const progressText = project.cancelledAt
        ? tFallback(t, 'projects.cancelled', 'Cancelled')
        : projectProgress?.isArchived && projectProgress.total > 0
        ? `${projectProgress.total} ${tFallback(t, 'list.done', 'Completed')}`
        : projectProgress && projectProgress.total > 0
          ? `${projectProgress.doneCount}/${projectProgress.total} ${t('status.done')} • ${projectProgress.remainingCount} ${t('process.remaining')}`
          : t('projects.noActiveTasks');
    const detailsLabel = tFallback(t, 'taskEdit.details', 'Details');
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    // Task rows carry the bare "More options" label; name the project so assistive tech
    // (and tests) can tell this menu apart from the rows below it.
    const menuLabel = `${moreOptionsLabel}: ${editTitle.trim() || project.title}`;
    const dueDateValue = dueDate ? safeParseDate(dueDate) : null;
    const dueLabelPrefix = tFallback(t, 'taskEdit.dueDateLabel', 'Due');
    const summaryItems = [
        {
            key: 'status',
            icon: Signal,
            label: project.cancelledAt
                ? tFallback(t, 'projects.cancelled', 'Cancelled')
                : tFallback(t, `status.${project.status}`, project.status),
        },
        ...(areaLabel ? [{
            key: 'area',
            icon: FolderOpenDot,
            label: areaLabel,
        }] : []),
        ...(dueDateValue ? [{
            key: 'due',
            icon: Calendar,
            label: `${dueLabelPrefix}: ${format(dueDateValue, 'MMM d')}`,
        }] : []),
    ];
    useLayoutEffect(() => {
        const element = titleInputRef.current;
        if (!element) return;
        const resizeTitle = () => {
            element.style.height = 'auto';
            element.style.height = `${element.scrollHeight}px`;
        };
        resizeTitle();
        let width = element.clientWidth;
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
            if (width === element.clientWidth) return;
            width = element.clientWidth;
            resizeTitle();
        }) : null;
        observer?.observe(element);
        return () => observer?.disconnect();
    }, [editTitle]);

    // The menu renders through a portal with fixed coordinates. Inside the header it
    // sat in the header's own stacking context (container-type makes one), and on
    // macOS WebKit the sticky task toolbar below still painted over it whenever the
    // header's actions wrapped under the chips, even with the header lifted to z-30
    // (reported twice from 1.2.8 builds, the second time on an archived project).
    const [menuStyle, setMenuStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, right: 0 });
    useLayoutEffect(() => {
        if (!menuOpen) return;
        const place = () => {
            const rect = menuRef.current?.getBoundingClientRect();
            if (!rect) return;
            setMenuStyle({
                position: 'fixed',
                top: rect.bottom + 4,
                right: Math.max(8, window.innerWidth - rect.right),
            });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [menuOpen]);

    useEffect(() => {
        if (!menuOpen) return;
        menuPanelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const handlePointer = (event: Event) => {
            const target = event.target as Node;
            if (menuRef.current?.contains(target) || menuPanelRef.current?.contains(target)) return;
            setMenuOpen(false);
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setMenuOpen(false);
            menuTriggerRef.current?.focus();
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
    const popoverOpen = menuOpen;

    return (
        <header className={`project-details-header pb-4 ${popoverOpen ? 'relative z-30' : ''}`}>
            <div className="project-details-header__content flex items-start justify-between gap-3">
                <div className="project-details-header__titleGroup flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex min-w-0 items-start gap-2">
                        <span
                            className="mt-[1.1rem] h-3 w-3 flex-none rounded-full border border-border"
                            style={{ backgroundColor: projectColor }}
                            aria-hidden="true"
                        />
                        <textarea
                            ref={titleInputRef}
                            value={editTitle}
                            onChange={(e) => onEditTitleChange(e.target.value.replace(/\s*\n+\s*/g, ' '))}
                            onBlur={() => {
                                if (skipTitleCommitOnBlurRef.current) {
                                    skipTitleCommitOnBlurRef.current = false;
                                    return;
                                }
                                onCommitTitle();
                            }}
                            onFocus={() => {
                                skipTitleCommitOnBlurRef.current = false;
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                    skipTitleCommitOnBlurRef.current = true;
                                    onResetTitle();
                                    e.currentTarget.blur();
                                }
                            }}
                            title={readOnly ? readOnlyHint : (editTitle || project.title)}
                            rows={1}
                            readOnly={readOnly}
                            aria-readonly={readOnly}
                            className="project-details-header__titleInput min-w-0 flex-1 resize-none overflow-hidden break-words bg-transparent border-b border-transparent text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-tight leading-tight focus:border-border focus:outline-none read-only:cursor-default read-only:focus:border-transparent"
                            aria-label={t('projects.title')}
                        />
                    </div>

                </div>
                <div className="project-details-header__actions flex flex-none items-center gap-2">
                    <button
                        type="button"
                        onClick={onToggleDetails}
                        aria-expanded={detailsExpanded}
                        aria-controls="project-details-fields"
                        className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${detailsExpanded ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'}`}
                    >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                        {detailsLabel}
                    </button>
                    <div ref={menuRef} className="relative">
                        <button
                            ref={menuTriggerRef}
                            type="button"
                            onClick={() => setMenuOpen((open) => !open)}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={menuLabel}
                            title={moreOptionsLabel}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                            {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
                        </button>
                        {menuOpen && createPortal(
                            <div
                                ref={menuPanelRef}
                                role="menu"
                                style={menuStyle}
                                className="z-50 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-lg"
                            >
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => runMenuAction(onDuplicate)}
                                    className={MENU_ITEM_CLASS}
                                >
                                    <Copy className="w-4 h-4" />
                                    {t('projects.duplicate')}
                                </button>
                                {onConvertToSection && <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => runMenuAction(onConvertToSection)}
                                    disabled={Boolean(convertToSectionBlockedReason)}
                                    title={convertToSectionBlockedReason}
                                    aria-describedby={convertToSectionBlockedReason ? `convert-disabled-${project.id}` : undefined}
                                    className={MENU_ITEM_CLASS}
                                >
                                    <FolderPlus className="w-4 h-4" />
                                    {tFallback(t, 'projects.convertToSection', 'Convert to section…')}
                                </button>}
                                {onConvertToSection && convertToSectionBlockedReason && <p id={`convert-disabled-${project.id}`} className="px-3 pb-1 text-xs text-muted-foreground">{convertToSectionBlockedReason}</p>}
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
                                    <>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => runMenuAction(onArchive)}
                                            className={MENU_ITEM_CLASS}
                                        >
                                            <CheckCircle className="w-4 h-4" />
                                            {t('projects.complete')}
                                        </button>
                                        {onCancel && (
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => runMenuAction(onCancel)}
                                                className={`${MENU_ITEM_CLASS} text-destructive hover:bg-destructive/10 focus:bg-destructive/10`}
                                            >
                                                <XCircle className="w-4 h-4" />
                                                {tFallback(t, 'projects.cancel', 'Cancel project')}
                                            </button>
                                        )}
                                    </>
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
                            </div>,
                            document.body,
                        )}
                    </div>
                    {primaryAction}
                </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                {projectProgress && <>
                    {projectProgress.total > 0 && <progress aria-label={t('status.done')} value={projectProgress.doneCount} max={projectProgress.total} className="project-progress h-2 w-56 overflow-hidden rounded-full" />}
                    <span>{progressText}</span>
                </>}
                    <div className="flex flex-wrap items-center gap-4">
                        {summaryItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <span
                                    key={item.key}
                                    className="inline-flex max-w-full items-center gap-2 text-sm text-muted-foreground"
                                >
                                    {item.key === 'status' ? <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${project.status === 'active' && !project.cancelledAt ? 'bg-success' : 'bg-muted-foreground'}`} /> : <Icon className="h-4 w-4 flex-none" />}
                                    <span className="min-w-0 truncate">{item.label}</span>
                                </span>
                            );
                        })}
                    </div>
            </div>
        </header>
    );
}
