import { useEffect, useId, useRef } from 'react';
import { Button } from './ui/Button';
import { Dialog, DialogBody, DialogFooter } from './ui/Dialog';

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
    const titleId = useId();
    const descriptionId = useId();

    useEffect(() => {
        if (!isOpen) return;
        const timer = window.setTimeout(() => confirmRef.current?.focus(), 50);
        return () => window.clearTimeout(timer);
    }, [isOpen]);

    if (!isOpen) return null;
    return (
        <Dialog
            onClose={onCancel}
            labelledBy={titleId}
            describedBy={description ? descriptionId : undefined}
            placement="top"
            overlayClassName="pt-[20vh]"


            panelClassName="max-h-[60vh]"
        >
            {
                                                                                }
            <DialogBody className="px-4 py-3 border-b">
                <h3 id={titleId} className="font-semibold break-words">{title}</h3>
                {description && (
                    <p
                        id={descriptionId}
                        className="mt-1 whitespace-pre-line break-words text-xs leading-relaxed text-muted-foreground"
                    >
                        {description}
                    </p>
                )}
            </DialogBody>
            <DialogFooter className="p-4 flex justify-end gap-2">
                <Button variant="secondary" onClick={onCancel}>
                    {cancelLabel}
                </Button>
                <Button ref={confirmRef} onClick={onConfirm}>
                    {confirmLabel}
                </Button>
            </DialogFooter>
        </Dialog>
    );
}
