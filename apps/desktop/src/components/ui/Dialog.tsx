import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../lib/utils';
import { isImeComposing } from '../../lib/ime';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';


export function getDialogFocusableElements(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => (
        element.tabIndex >= 0
        && !element.hasAttribute('disabled')
        && element.getAttribute('aria-hidden') !== 'true'
    ));
}

export type DialogProps = {
    onClose: () => void;

    labelledBy?: string;
    describedBy?: string;
    label?: string;

    placement?: 'center' | 'top';
    overlayClassName?: string;
    panelClassName?: string;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    panelRef?: RefObject<HTMLDivElement | null>;

    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    children: ReactNode;
};


export function Dialog({
    onClose,
    labelledBy,
    describedBy,
    label,
    placement = 'center',
    overlayClassName,
    panelClassName,
    closeOnBackdrop = true,
    closeOnEscape = true,
    panelRef,
    onKeyDown,
    children,
}: DialogProps) {
    const fallbackPanelRef = useRef<HTMLDivElement | null>(null);
    const panel = panelRef ?? fallbackPanelRef;


    const pressStartedOnBackdrop = useRef(false);
    const returnFocusTarget = useRef<HTMLElement | null | undefined>(undefined);
    if (returnFocusTarget.current === undefined) {
        returnFocusTarget.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
    }

    useEffect(() => {
        const mountedPanel = panel.current;


        if (!mountedPanel?.contains(document.activeElement)) {
            mountedPanel?.focus();
        }
        return () => {


            if (mountedPanel?.isConnected) return;
            if (returnFocusTarget.current?.isConnected) {
                returnFocusTarget.current.focus();
            }
        };
    }, [panel]);

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (isImeComposing(event)) return;
        onKeyDown?.(event);

        if (event.defaultPrevented) return;

        if (closeOnEscape && event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = getDialogFocusableElements(panel.current);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (!active || !focusable.includes(active)) {
            event.preventDefault();
            first.focus();
            return;
        }
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const dialog = (
        <div
            role="presentation"
            className={cn(
                'fixed inset-0 z-50 flex justify-center bg-black/50',
                placement === 'center' ? 'items-center' : 'items-start',
                overlayClassName,
            )}
            onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
                pressStartedOnBackdrop.current = event.target === event.currentTarget;
            }}
            onClick={(event: MouseEvent<HTMLDivElement>) => {
                if (!closeOnBackdrop) return;
                if (event.target !== event.currentTarget) return;
                if (!pressStartedOnBackdrop.current) return;
                pressStartedOnBackdrop.current = false;
                onClose();
            }}
        >
            <div
                ref={panel}
                role="dialog"
                aria-modal="true"


                tabIndex={-1}
                aria-label={label}
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
                className={cn(
                    'flex w-full max-w-md max-h-[85vh] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl',
                    panelClassName,
                )}
                onKeyDown={handleKeyDown}
            >
                {children}
            </div>
        </div>
    );

    if (typeof document === 'undefined') return dialog;
    return createPortal(dialog, document.body);
}

type DialogSectionProps = {
    className?: string;
    children: ReactNode;
};


export function DialogHeader({ className, children }: DialogSectionProps) {
    return <div className={cn('shrink-0', className)}>{children}</div>;
}


export function DialogBody({ className, children }: DialogSectionProps) {
    return <div className={cn('min-h-0 overflow-y-auto', className)}>{children}</div>;
}


export function DialogFooter({ className, children }: DialogSectionProps) {
    return <div className={cn('shrink-0', className)}>{children}</div>;
}
