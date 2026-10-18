import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Eye, Pencil, X } from 'lucide-react';

import { cn } from '../lib/utils';
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar';
import { MarkdownReferenceAutocompleteMenu, useMarkdownReferenceAutocomplete } from './MarkdownReferenceAutocomplete';
import { RichMarkdown } from './RichMarkdown';
import { Dialog, DialogHeader } from './ui/Dialog';
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
    selection: MarkdownSelection;
    canUndo: boolean;
    onUndo: () => MarkdownSelection | undefined;
    onApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult | void;
    onSelectionChange: (selection: MarkdownSelection) => void;
    onEditorKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onEditorPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    currentTaskId?: string;
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
    selection,
    canUndo,
    onUndo,
    onApplyAction,
    onSelectionChange,
    onEditorKeyDown,
    onEditorPaste,
    currentTaskId,
}: ExpandedMarkdownEditorProps) {
    const [mode, setMode] = useState<'edit' | 'preview'>(initialMode);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const titleId = useId();
    const resolvedHeaderTitle = (headerTitle || '').trim() || title;
    const autocomplete = useMarkdownReferenceAutocomplete({
        currentTaskId,
        value,
        selection,
        textareaRef,
        onApplyResult: (next) => {
            onChange(next.value);
            onSelectionChange(next.selection);
        },
    });

    const isRtl = direction === 'rtl';

    const handleClose = useCallback(() => {
        onCommit?.();
        onClose();
    }, [onClose, onCommit]);

    useEffect(() => {
        if (!isOpen) return;
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

    return (
        <Dialog
            onClose={handleClose}
            labelledBy={titleId}
            overlayClassName="z-[70] p-4"
            // Sized rather than capped: the editor deliberately fills the window
            // and its edit/preview region owns the scrolling.
            panelClassName="h-[min(92vh,960px)] w-[min(1200px,96vw)] max-w-none max-h-[none] rounded-2xl border-border bg-card"
        >
            <DialogHeader className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                    <h2 id={titleId} className="truncate text-sm font-semibold">
                        {resolvedHeaderTitle}
                    </h2>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setMode((prev) => (prev === 'edit' ? 'preview' : 'edit'))}
                        aria-label={mode === 'edit' ? t('markdown.preview') : t('markdown.edit')}
                        title={mode === 'edit' ? t('markdown.preview') : t('markdown.edit')}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                        {mode === 'edit'
                            ? <Eye className="h-4 w-4" aria-hidden="true" />
                            : <Pencil className="h-4 w-4" aria-hidden="true" />}
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
            </DialogHeader>

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
                        <div className="relative flex min-h-0 flex-1 flex-col">
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
                                onKeyDown={(event) => {
                                    if (autocomplete.handleKeyDown(event)) {
                                        return;
                                    }
                                    onEditorKeyDown?.(event);
                                }}
                                onPaste={onEditorPaste}
                                placeholder={placeholder}
                                spellCheck={true}
                                dir={direction}
                                className={cn(
                                    'min-h-0 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/30',
                                    isRtl && 'text-right',
                                )}
                            />
                            <MarkdownReferenceAutocompleteMenu
                                isOpen={autocomplete.isOpen}
                                suggestions={autocomplete.suggestions}
                                selectedIndex={autocomplete.selectedIndex}
                                setSelectedIndex={autocomplete.setSelectedIndex}
                                applySuggestion={autocomplete.applySuggestion}
                                menuRef={autocomplete.menuRef}
                                position={autocomplete.position}
                                t={t}
                            />
                        </div>
                    </div>
                ) : (
                    <div
                        dir={direction}
                        className={cn(
                            'h-full overflow-y-auto rounded-xl border border-border bg-background px-4 py-3',
                            isRtl && 'text-right',
                        )}
                    >
                        <RichMarkdown markdown={value} />
                    </div>
                )}
            </div>
        </Dialog>
    );
}
