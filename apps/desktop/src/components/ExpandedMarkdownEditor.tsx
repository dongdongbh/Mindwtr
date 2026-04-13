import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { cn } from '../lib/utils';
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar';
import { Markdown } from './Markdown';
import type { MarkdownSelection, MarkdownToolbarActionId, MarkdownToolbarResult } from '@mindwtr/core';

type ExpandedMarkdownEditorProps = {
    isOpen: boolean;
    onClose: () => void;
    value: string;
    onChange: (value: string) => void;
    onCommit?: () => void;
    title: string;
    headerTitle?: string;
    placeholder: string;
    t: (key: string) => string;
    initialMode?: 'edit' | 'preview';
    direction?: 'ltr' | 'rtl';
    canUndo: boolean;
    onUndo: () => MarkdownSelection | undefined;
    onApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult | void;
    onSelectionChange: (selection: MarkdownSelection) => void;
    onEditorKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

export function ExpandedMarkdownEditor({
    isOpen,
    onClose,
    value,
    onChange,
    onCommit,
    title,
    headerTitle,
    placeholder,
    t,
    initialMode = 'edit',
    direction = 'ltr',
    canUndo,
    onUndo,
    onApplyAction,
    onSelectionChange,
    onEditorKeyDown,
}: ExpandedMarkdownEditorProps) {
    const [mode, setMode] = useState<'edit' | 'preview'>(initialMode);
    const modalRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const lastActiveElement = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const resolvedHeaderTitle = (headerTitle || '').trim() || title;

    const isRtl = direction === 'rtl';

    const getFocusable = () => {
        const root = modalRef.current;
        if (!root) return [];
        return Array.from(
            root.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden'));
    };

    const handleClose = useCallback(() => {
        onCommit?.();
        onClose();
    }, [onClose, onCommit]);

    useEffect(() => {
        if (!isOpen) {
            if (lastActiveElement.current) {
                lastActiveElement.current.focus();
                lastActiveElement.current = null;
            }
            return;
        }
        lastActiveElement.current = document.activeElement as HTMLElement | null;
        setMode(initialMode);
    }, [initialMode, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const timer = window.setTimeout(() => {
            if (mode === 'edit') {
                textareaRef.current?.focus();
                return;
            }
            closeButtonRef.current?.focus();
        }, 30);
        return () => window.clearTimeout(timer);
    }, [isOpen, mode]);

    if (!isOpen) return null;
    if (typeof document === 'undefined') return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(event) => {
                if (event.target !== event.currentTarget) return;
                handleClose();
            }}
        >
            <div
                ref={modalRef}
                className="flex h-[min(92vh,960px)] w-[min(1200px,96vw)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        handleClose();
                        return;
                    }
                    if (event.key !== 'Tab') return;
                    const focusable = getFocusable();
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
                        return;
                    }

                    if (!event.shiftKey && active === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }}
            >
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <div className="min-w-0">
                        <h2 id={titleId} className="truncate text-sm font-semibold">
                            {resolvedHeaderTitle}
                        </h2>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setMode((prev) => (prev === 'edit' ? 'preview' : 'edit'))}
                            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40"
                        >
                            {mode === 'edit' ? t('markdown.preview') : t('markdown.edit')}
                        </button>
                        <button
                            ref={closeButtonRef}
                            type="button"
                            onClick={handleClose}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                            aria-label={t('markdown.collapse')}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 p-4">
                    {mode === 'edit' ? (
                        <div className="flex h-full flex-col gap-3">
                            <MarkdownFormatToolbar
                                textareaRef={textareaRef}
                                t={t}
                                canUndo={canUndo}
                                onUndo={onUndo}
                                onApplyAction={onApplyAction}
                            />
                            <textarea
                                ref={textareaRef}
                                value={value}
                                onChange={(event) => {
                                    onChange(event.target.value);
                                    onSelectionChange({
                                        start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                        end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                                    });
                                }}
                                onSelect={(event) => {
                                    onSelectionChange({
                                        start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                        end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                                    });
                                }}
                                onKeyDown={onEditorKeyDown}
                                placeholder={placeholder}
                                dir={direction}
                                className={cn(
                                    'min-h-0 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/30',
                                    isRtl && 'text-right',
                                )}
                            />
                        </div>
                    ) : (
                        <div
                            dir={direction}
                            className={cn(
                                'h-full overflow-y-auto rounded-xl border border-border bg-background px-4 py-3',
                                isRtl && 'text-right',
                            )}
                        >
                            <Markdown markdown={value} className={isRtl ? 'text-right' : undefined} />
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
