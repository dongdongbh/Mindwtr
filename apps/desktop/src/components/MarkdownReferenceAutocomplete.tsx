import React from 'react';
import { CheckSquare2, Folder } from 'lucide-react';
import {
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    searchMarkdownReferences,
    shallow,
    useTaskStore,
    type MarkdownReferenceSearchResult,
    type MarkdownSelection,
    type MarkdownToolbarResult,
} from '@mindwtr/core';

import { cn } from '../lib/utils';

type UseMarkdownReferenceAutocompleteOptions = {
    value: string;
    selection: MarkdownSelection;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    onApplyResult: (result: MarkdownToolbarResult) => void;
};

export function useMarkdownReferenceAutocomplete({
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
        () => (activeQuery ? searchMarkdownReferences(tasks, projects, activeQuery.query) : []),
        [activeQuery, projects, tasks],
    );
    const isFocused = typeof document !== 'undefined' && textareaRef.current === document.activeElement;
    const isOpen = Boolean(isFocused && activeQuery && activeKey !== dismissedKey && suggestions.length > 0);

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

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!activeQuery || textareaRef.current !== document.activeElement) return false;
        if (event.key === 'Escape') {
            setDismissedKey(activeKey);
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
    };
}

type MarkdownReferenceAutocompleteMenuProps = {
    isOpen: boolean;
    suggestions: MarkdownReferenceSearchResult[];
    selectedIndex: number;
    setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    applySuggestion: (suggestion: MarkdownReferenceSearchResult) => void;
    t: (key: string) => string;
    className?: string;
};

export function MarkdownReferenceAutocompleteMenu({
    isOpen,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    applySuggestion,
    t,
    className,
}: MarkdownReferenceAutocompleteMenuProps) {
    if (!isOpen || suggestions.length === 0) return null;

    const taskLabel = (() => {
        const translated = t('taskEdit.tab.task');
        return translated === 'taskEdit.tab.task' ? 'Task' : translated;
    })();
    const projectLabel = (() => {
        const translated = t('taskEdit.projectLabel');
        return translated === 'taskEdit.projectLabel' ? 'Project' : translated;
    })();

    return (
        <div
            className={cn(
                'absolute left-0 right-0 top-full z-30 mt-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl',
                className,
            )}
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
        </div>
    );
}
