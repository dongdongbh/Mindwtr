import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Download, MoreHorizontal } from 'lucide-react';
import { getInMemoryAppDataSnapshot, tFallback } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { useViewExport } from '../contexts/view-export-context';
import { reportError } from '../lib/report-error';
import { useUiStore } from '../store/ui-store';

export function ViewActionsMenu({ collapsed = false }: { collapsed?: boolean }) {
    const { tasks } = useViewExport();
    const { t } = useLanguage();
    const showToast = useUiStore((state) => state.showToast);
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const exportItemRef = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const moreLabel = tFallback(t, 'common.more', 'More');
    const exportLabel = tFallback(t, 'list.exportCsvFiltered', 'Export current results as CSV');
    const exportDisabled = pending || !tasks?.length;

    useEffect(() => {
        if (!open) return;
        const handleOutsidePointer = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleOutsidePointer);
        return () => document.removeEventListener('mousedown', handleOutsidePointer);
    }, [open]);

    useLayoutEffect(() => {
        if (!open) return;
        if (exportItemRef.current && !exportDisabled) {
            exportItemRef.current.focus();
            return;
        }
        menuRef.current?.focus();
    }, [exportDisabled, open]);

    const closeAndReturnFocus = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };

    const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeAndReturnFocus();
            return;
        }
        if (event.key === 'Tab') {
            setOpen(false);
        }
    };

    const handleExport = async () => {
        if (pendingRef.current || !tasks?.length) return;

        // Freeze the registered result set before either dynamic import or the
        // Save dialog yields; navigation and live filters must not change what
        // this particular action exports.
        const exportTasks = [...tasks];
        const exportData = getInMemoryAppDataSnapshot();
        pendingRef.current = true;
        setPending(true);
        closeAndReturnFocus();

        try {
            const { exportDesktopCsv } = await import('../lib/data-transfer');
            const saved = await exportDesktopCsv(exportData, exportTasks);
            if (saved) {
                showToast(tFallback(t, 'settings.exportCsvSuccess', 'CSV exported successfully!'), 'success');
            }
        } catch (error) {
            reportError('Failed to export filtered CSV', error);
            showToast(tFallback(t, 'settings.exportCsvFailed', 'Failed to export CSV'), 'error');
        } finally {
            pendingRef.current = false;
            setPending(false);
        }
    };

    return (
        <div ref={containerRef} className="relative shrink-0">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((current) => !current)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setOpen(true);
                    } else if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        closeAndReturnFocus();
                    }
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                title={moreLabel}
                aria-label={moreLabel}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
            >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            {open && (
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    tabIndex={-1}
                    aria-label={moreLabel}
                    aria-busy={pending || undefined}
                    onKeyDown={handleMenuKeyDown}
                    className={`absolute top-full z-30 mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg focus:outline-none ${collapsed ? 'left-0' : 'right-0'}`}
                >
                    <button
                        ref={exportItemRef}
                        type="button"
                        role="menuitem"
                        disabled={exportDisabled}
                        onClick={() => { void handleExport(); }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{exportLabel}</span>
                    </button>
                </div>
            )}
        </div>
    );
}
