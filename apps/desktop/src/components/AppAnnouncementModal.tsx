import { useEffect, useId, useRef } from 'react';
import { ExternalLink, Megaphone, MessageSquare, X } from 'lucide-react';

import type { AppAnnouncement, AppAnnouncementAction } from '@mindwtr/core';
import { Button } from './ui/Button';
import { Dialog, DialogBody, DialogFooter } from './ui/Dialog';

type AppAnnouncementModalProps = {
    announcement: AppAnnouncement | null;
    isOpen: boolean;
    onAction: (action: AppAnnouncementAction) => void;
    onDismiss: () => void;
    onShown?: () => void;
};

function getActionIcon(action: AppAnnouncementAction) {
    if (action.type === 'feedback') return <MessageSquare className="h-4 w-4" aria-hidden="true" />;
    return <ExternalLink className="h-4 w-4" aria-hidden="true" />;
}

export function AppAnnouncementModal({
    announcement,
    isOpen,
    onAction,
    onDismiss,
    onShown,
}: AppAnnouncementModalProps) {
    const primaryButtonRef = useRef<HTMLButtonElement>(null);
    const dismissButtonRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const bodyId = useId();

    useEffect(() => {
        if (!isOpen || !announcement) return;
        onShown?.();
        const timer = window.setTimeout(() => {
            (primaryButtonRef.current ?? dismissButtonRef.current)?.focus();
        }, 50);
        return () => window.clearTimeout(timer);
    }, [announcement, isOpen, onShown]);

    if (!isOpen || !announcement) return null;

    const action = announcement.action;
    const dismissLabel = announcement.dismissLabel ?? 'Not now';

    return (
        <Dialog
            onClose={onDismiss}
            labelledBy={titleId}
            describedBy={bodyId}
            placement="top"
            overlayClassName="z-[60] px-4 pt-[18vh]"


            panelClassName="max-h-[78vh] rounded-lg border-border"
        >
            <DialogBody className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
                <div className="flex min-w-0 items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Megaphone className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <h3 id={titleId} className="text-base font-semibold leading-6">
                            {announcement.title}
                        </h3>
                        <p id={bodyId} className="mt-1 text-sm leading-6 text-muted-foreground">
                            {announcement.body}
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Dismiss announcement"
                    onClick={onDismiss}
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            </DialogBody>

            <DialogFooter className="flex flex-wrap justify-end gap-2 px-4 py-3">
                <Button ref={dismissButtonRef} variant="secondary" onClick={onDismiss}>
                    {dismissLabel}
                </Button>
                {action ? (
                    <Button
                        ref={primaryButtonRef}
                        leadingIcon={getActionIcon(action)}
                        onClick={() => onAction(action)}
                    >
                        {action.label}
                    </Button>
                ) : null}
            </DialogFooter>
        </Dialog>
    );
}
