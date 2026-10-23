import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, FileText, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';
import { getProjectMenuStyle } from './project-menu-position';

type ProjectSectionActionsMenuProps = {
    sectionTitle: string;
    orientation: 'vertical' | 'horizontal';
    moreOptionsLabel: string;
    moveBackLabel: string;
    moveForwardLabel: string;
    notesLabel: string;
    editLabel: string;
    deleteLabel: string;
    canMoveBack: boolean;
    canMoveForward: boolean;
    readOnly: boolean;
    readOnlyHint?: string;
    notesActive: boolean;
    onMoveBack: () => void;
    onMoveForward: () => void;
    onToggleNotes: () => void;
    onRename: () => void;
    onDelete: () => void;
    /** Present only while the project's Flow mode is Per section (#1429). */
    flow?: {
        label: string;
        parallelLabel: string;
        sequentialLabel: string;
        isSequential: boolean;
        onChange: (isSequential: boolean) => void;
    };
};

const MENU_ITEM_CLASS = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40';

export function ProjectSectionActionsMenu({
    sectionTitle,
    orientation,
    moreOptionsLabel,
    moveBackLabel,
    moveForwardLabel,
    notesLabel,
    editLabel,
    deleteLabel,
    canMoveBack,
    canMoveForward,
    readOnly,
    readOnlyHint,
    notesActive,
    onMoveBack,
    onMoveForward,
    onToggleNotes,
    onRename,
    onDelete,
    flow,
}: ProjectSectionActionsMenuProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const [menuStyle, setMenuStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0 });
    const MoveBackIcon = orientation === 'horizontal' ? ArrowLeft : ArrowUp;
    const MoveForwardIcon = orientation === 'horizontal' ? ArrowRight : ArrowDown;
    const triggerLabel = `${moreOptionsLabel}: ${sectionTitle}`;

    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const triggerRect = triggerRef.current?.getBoundingClientRect();
            const panelRect = panelRef.current?.getBoundingClientRect();
            if (!triggerRect || !panelRect) return;
            setMenuStyle(getProjectMenuStyle(
                triggerRect,
                panelRect,
                window.innerWidth,
                window.innerHeight,
            ));
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
        const handlePointer = (event: MouseEvent) => {
            const target = event.target as Node;
            if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    const runAction = (action: () => void) => {
        setOpen(false);
        triggerRef.current?.focus();
        action();
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={triggerLabel}
                title={moreOptionsLabel}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {open && createPortal(
                <div
                    ref={panelRef}
                    role="menu"
                    style={menuStyle}
                    className="z-50 min-w-[200px] overscroll-contain rounded-md border border-border bg-card p-1 shadow-lg"
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => runAction(onMoveBack)}
                        disabled={readOnly || !canMoveBack}
                        title={readOnly ? readOnlyHint : moveBackLabel}
                        aria-label={`${moveBackLabel}: ${sectionTitle}`}
                        className={MENU_ITEM_CLASS}
                    >
                        <MoveBackIcon className="h-4 w-4" aria-hidden="true" />
                        {moveBackLabel}
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => runAction(onMoveForward)}
                        disabled={readOnly || !canMoveForward}
                        title={readOnly ? readOnlyHint : moveForwardLabel}
                        aria-label={`${moveForwardLabel}: ${sectionTitle}`}
                        className={MENU_ITEM_CLASS}
                    >
                        <MoveForwardIcon className="h-4 w-4" aria-hidden="true" />
                        {moveForwardLabel}
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => runAction(onToggleNotes)}
                        className={cn(MENU_ITEM_CLASS, notesActive && 'text-primary')}
                    >
                        <FileText className="h-4 w-4" aria-hidden="true" />
                        {notesLabel}
                    </button>
                    {flow && (
                        <div role="group" aria-label={flow.label}>
                            <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                {flow.label}
                            </div>
                            {([false, true] as const).map((sequential) => (
                                <button
                                    key={sequential ? 'sequential' : 'parallel'}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={flow.isSequential === sequential}
                                    onClick={() => runAction(() => {
                                        if (flow.isSequential !== sequential) flow.onChange(sequential);
                                    })}
                                    disabled={readOnly}
                                    title={readOnly ? readOnlyHint : undefined}
                                    className={MENU_ITEM_CLASS}
                                >
                                    <Check
                                        className={cn('h-4 w-4', flow.isSequential !== sequential && 'invisible')}
                                        aria-hidden="true"
                                    />
                                    {sequential ? flow.sequentialLabel : flow.parallelLabel}
                                </button>
                            ))}
                            <div className="my-1 border-t border-border/60" role="separator" />
                        </div>
                    )}
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => runAction(onRename)}
                        disabled={readOnly}
                        title={readOnly ? readOnlyHint : editLabel}
                        className={MENU_ITEM_CLASS}
                    >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                        {editLabel}
                    </button>
                    <div className="my-1 border-t border-border/60" role="separator" />
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => runAction(onDelete)}
                        disabled={readOnly}
                        title={readOnly ? readOnlyHint : deleteLabel}
                        className={`${MENU_ITEM_CLASS} text-destructive hover:bg-destructive/10 focus:bg-destructive/10`}
                    >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        {deleteLabel}
                    </button>
                </div>,
                document.body,
            )}
        </div>
    );
}
