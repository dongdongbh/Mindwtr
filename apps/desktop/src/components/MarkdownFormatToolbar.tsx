import { useCallback, type RefObject } from 'react';
import { CheckSquare, List, ListOrdered, Quote, Undo2 } from 'lucide-react';
import {
    MARKDOWN_TOOLBAR_ACTIONS,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
} from '@mindwtr/core';

import { cn } from '../lib/utils';

type MarkdownFormatToolbarProps = {
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    t: (key: string) => string;
    className?: string;
    canUndo: boolean;
    onUndo: () => MarkdownSelection | undefined;
    onApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult | void;
};

const translateWithFallback = (t: (key: string) => string, key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
};

const renderActionLabel = (actionId: MarkdownToolbarActionId, shortLabel: string) => {
    switch (actionId) {
        case 'bulletList':
            return <List className="h-3.5 w-3.5" />;
        case 'orderedList':
            return <ListOrdered className="h-3.5 w-3.5" />;
        case 'taskList':
            return <CheckSquare className="h-3.5 w-3.5" />;
        case 'quote':
            return <Quote className="h-3.5 w-3.5" />;
        default:
            return <span>{shortLabel}</span>;
    }
};

export function MarkdownFormatToolbar({
    textareaRef,
    t,
    className,
    canUndo,
    onUndo,
    onApplyAction,
}: MarkdownFormatToolbarProps) {
    const restoreSelection = useCallback((nextSelection?: MarkdownSelection) => {
        if (!nextSelection) return;

        const focusTextarea = () => {
            const target = textareaRef.current;
            if (!target) return;
            target.focus();
            target.setSelectionRange(nextSelection.start, nextSelection.end);
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(focusTextarea);
            return;
        }

        setTimeout(focusTextarea, 0);
    }, [textareaRef]);

    const getSelection = useCallback((): MarkdownSelection => {
        const textarea = textareaRef.current;
        return {
            start: textarea?.selectionStart ?? 0,
            end: textarea?.selectionEnd ?? 0,
        };
    }, [textareaRef]);

    const handleUndo = useCallback(() => {
        if (!canUndo) return;
        restoreSelection(onUndo() ?? undefined);
    }, [canUndo, onUndo, restoreSelection]);

    const handleApplyAction = useCallback((actionId: MarkdownToolbarActionId) => {
        restoreSelection(onApplyAction(actionId, getSelection())?.selection);
    }, [getSelection, onApplyAction, restoreSelection]);

    return (
        <div className={cn('flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 bg-muted/20 px-2 py-1', className)}>
            {MARKDOWN_TOOLBAR_ACTIONS.map((action) => (
                <button
                    key={action.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleApplyAction(action.id)}
                    className={cn(
                        'flex min-w-8 items-center justify-center rounded-md px-2 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
                        action.id === 'italic' && 'italic',
                    )}
                    aria-label={translateWithFallback(t, action.labelKey, action.fallbackLabel)}
                    title={translateWithFallback(t, action.labelKey, action.fallbackLabel)}
                >
                    {renderActionLabel(action.id, action.shortLabel)}
                </button>
            ))}

            <div className="h-5 w-px bg-border/80" />

            <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleUndo}
                disabled={!canUndo}
                className={cn(
                    'rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35',
                )}
                aria-label={translateWithFallback(t, 'common.undo', 'Undo')}
                title={translateWithFallback(t, 'common.undo', 'Undo')}
            >
                <Undo2 className="h-4 w-4" />
            </button>
        </div>
    );
}
