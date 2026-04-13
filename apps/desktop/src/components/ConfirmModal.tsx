import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/Button';

interface ConfirmModalProps {
    isOpen: boolean;
    title: string;
    description?: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmModal({
    isOpen,
    title,
    description,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: ConfirmModalProps) {
    const confirmRef = useRef<HTMLButtonElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const lastActiveElement = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const descriptionId = useId();

    const getFocusable = () => {
        const root = modalRef.current;
        if (!root) return [];
        return Array.from(
            root.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'));
    };

    useEffect(() => {
        if (isOpen) {
            lastActiveElement.current = document.activeElement as HTMLElement | null;
            setTimeout(() => confirmRef.current?.focus(), 50);
        } else if (lastActiveElement.current) {
            lastActiveElement.current.focus();
            lastActiveElement.current = null;
        }
    }, [isOpen]);

    if (!isOpen) return null;
    if (typeof document === 'undefined') return null;

    return createPortal(
        <div
            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            onClick={onCancel}
        >
            <div
                ref={modalRef}
                className="w-full max-w-md bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onCancel();
                        return;
                    }
                    if (e.key === 'Tab') {
                        const focusable = getFocusable();
                        if (focusable.length === 0) return;
                        const first = focusable[0];
                        const last = focusable[focusable.length - 1];
                        const active = document.activeElement as HTMLElement | null;

                        if (!active || !focusable.includes(active)) {
                            e.preventDefault();
                            first.focus();
                            return;
                        }

                        if (e.shiftKey && active === first) {
                            e.preventDefault();
                            last.focus();
                        } else if (!e.shiftKey && active === last) {
                            e.preventDefault();
                            first.focus();
                        }
                    }
                }}
            >
                <div className="px-4 py-3 border-b">
                    <h3 id={titleId} className="font-semibold">{title}</h3>
                    {description && (
                        <p id={descriptionId} className="text-xs text-muted-foreground mt-1">
                            {description}
                        </p>
                    )}
                </div>
                <div className="p-4 flex justify-end gap-2">
                    <Button variant="secondary" onClick={onCancel}>
                        {cancelLabel}
                    </Button>
                    <Button ref={confirmRef} onClick={onConfirm}>
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </div>
        ,
        document.body,
    );
}
