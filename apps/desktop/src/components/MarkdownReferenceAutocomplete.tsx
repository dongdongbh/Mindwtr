import React from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare2, Folder } from 'lucide-react';
import {
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    searchMarkdownReferences,
    shallow,
    tFallback,
    useTaskStore,
    type MarkdownReferenceSearchResult,
    type MarkdownSelection,
    type MarkdownToolbarResult,
} from '@mindwtr/core';

import { cn } from '../lib/utils';
import {
    getTextareaCaretViewportRect,
    resolveAutocompletePopoverPosition,
    type AutocompletePopoverPosition,
} from './markdown-reference-autocomplete-position';

type UseMarkdownReferenceAutocompleteOptions = {
    currentTaskId?: string;
    value: string;
    selection: MarkdownSelection;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    onApplyResult: (result: MarkdownToolbarResult) => void;
};

const AUTOCOMPLETE_MENU_ITEM_HEIGHT = 52;
const AUTOCOMPLETE_MENU_PADDING = 8;

const estimateAutocompleteMenuHeight = (count: number) => (
    Math.min(count, 6) * AUTOCOMPLETE_MENU_ITEM_HEIGHT + AUTOCOMPLETE_MENU_PADDING
);

export function useMarkdownReferenceAutocomplete({
    currentTaskId,
    value,
    selection,
    textareaRef,
    onApplyResult,
}: UseMarkdownReferenceAutocompleteOptions) {
    const { tasks, projects } = useTaskStore((state) => ({
        tasks: state._allTasks,
        projects: state.projects,
    }), shallow);
    const activeQuery = React.useMemo(
        () => getActiveMarkdownReferenceQuery(value, selection),
        [selection.end, selection.start, value],
    );
    const activeKey = activeQuery ? `${activeQuery.start}:${activeQuery.query}` : null;
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const [dismissedKey, setDismissedKey] = React.useState<string | null>(null);
    const [position, setPosition] = React.useState<AutocompletePopoverPosition | null>(null);
    const menuRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!activeKey) {
            setSelectedIndex(0);
            return;
        }
        if (activeKey !== dismissedKey) {
            setSelectedIndex(0);
        }
    }, [activeKey, dismissedKey]);

    const suggestions = React.useMemo(
        () => (activeQuery
            ? searchMarkdownReferences(tasks, projects, activeQuery.query, 8, {
                excludeTaskIds: currentTaskId ? [currentTaskId] : undefined,
            })
            : []),
        [activeQuery, currentTaskId, projects, tasks],
    );
    const isFocused = typeof document !== 'undefined' && textareaRef.current === document.activeElement;
    const isOpen = Boolean(isFocused && activeQuery && activeKey !== dismissedKey && suggestions.length > 0);
    const dismiss = React.useCallback(() => {
        setDismissedKey(activeKey ?? null);
    }, [activeKey]);

    const applySuggestion = React.useCallback((suggestion: MarkdownReferenceSearchResult) => {
        if (!activeQuery) return;
        const next = insertMarkdownReferenceAtQuery(value, activeQuery, {
            entityType: suggestion.entityType,
            id: suggestion.id,
            label: suggestion.title,
        });
        onApplyResult(next);
        setDismissedKey(null);
        setSelectedIndex(0);
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(next.selection.start, next.selection.end);
        });
    }, [activeQuery, onApplyResult, textareaRef, value]);

    React.useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!isOpen || !activeQuery || !textarea || typeof window === 'undefined') {
            setPosition(null);
            return;
        }

        const updatePosition = () => {
            const anchorRect = getTextareaCaretViewportRect(textarea, activeQuery.end);
            if (!anchorRect) return;
            setPosition(resolveAutocompletePopoverPosition({
                anchorRect,
                estimatedHeight: estimateAutocompleteMenuHeight(suggestions.length),
                viewportHeight: window.innerHeight,
                viewportWidth: window.innerWidth,
            }));
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        textarea.addEventListener('scroll', updatePosition);

        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
            textarea.removeEventListener('scroll', updatePosition);
        };
    }, [activeQuery, isOpen, suggestions.length, textareaRef]);

    React.useEffect(() => {
        if (!isOpen || typeof document === 'undefined') return;

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (textareaRef.current?.contains(target) || menuRef.current?.contains(target)) {
                return;
            }
            dismiss();
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
        };
    }, [dismiss, isOpen, textareaRef]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!activeQuery || textareaRef.current !== document.activeElement) return false;
        if (event.key === 'Escape') {
            dismiss();
            if (suggestions.length > 0) {
                event.preventDefault();
                return true;
            }
            return false;
        }
        if (suggestions.length === 0 || !isOpen) return false;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((current) => Math.min(current + 1, suggestions.length - 1));
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((current) => Math.max(current - 1, 0));
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            applySuggestion(suggestions[selectedIndex] ?? suggestions[0]);
            return true;
        }
        return false;
    }, [activeKey, activeQuery, applySuggestion, isOpen, selectedIndex, suggestions, textareaRef]);

    return {
        isOpen,
        suggestions,
        selectedIndex,
        setSelectedIndex,
        applySuggestion,
        handleKeyDown,
        dismiss,
        menuRef,
        position,
    };
}

type MarkdownReferenceAutocompleteMenuProps = {
    isOpen: boolean;
    suggestions: MarkdownReferenceSearchResult[];
    selectedIndex: number;
    setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    applySuggestion: (suggestion: MarkdownReferenceSearchResult) => void;
    t: (key: string) => string;
    menuRef?: React.RefObject<HTMLDivElement | null>;
    position?: AutocompletePopoverPosition | null;
    className?: string;
};

export function MarkdownReferenceAutocompleteMenu({
    isOpen,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    applySuggestion,
    t,
    menuRef,
    position,
    className,
}: MarkdownReferenceAutocompleteMenuProps) {
    if (!isOpen || suggestions.length === 0 || !position) return null;
    if (typeof document === 'undefined') return null;

    const taskLabel = tFallback(t, 'taskEdit.tab.task', 'Task');
    const projectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');

    return createPortal(
        <div
            ref={menuRef}
            className={cn(
                'fixed z-[80] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl',
                className,
            )}
            style={{
                left: `${position.left}px`,
                maxHeight: `${position.maxHeight}px`,
                top: `${position.top}px`,
                width: `${position.width}px`,
            }}
            data-placement={position.placement}
        >
            {suggestions.map((suggestion, index) => {
                const statusKey = `status.${suggestion.status}` as const;
                const translatedStatus = t(statusKey);
                const statusLabel = translatedStatus === statusKey ? suggestion.status : translatedStatus;
                const typeLabel = suggestion.entityType === 'task' ? taskLabel : projectLabel;
                const isSelected = index === selectedIndex;

                return (
                    <button
                        key={`${suggestion.entityType}:${suggestion.id}`}
                        type="button"
                        className={cn(
                            'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                            isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/70',
                        )}
                        onMouseDown={(event) => {
                            event.preventDefault();
                        }}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => applySuggestion(suggestion)}
                    >
                        <span className="mt-0.5 text-muted-foreground">
                            {suggestion.entityType === 'task' ? <CheckSquare2 className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">
                                {suggestion.title}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                                {typeLabel} • {statusLabel}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}
