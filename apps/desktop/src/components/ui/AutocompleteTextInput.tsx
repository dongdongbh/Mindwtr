import { useEffect, useId, useMemo, useState } from 'react';
import type { InputHTMLAttributes, KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';
import { isImeComposing } from '../../lib/ime';

type AutocompleteTextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: string;
    onChange: (value: string) => void;
    suggestions: readonly string[];
    maxSuggestions?: number;

    showAllWhenEmpty?: boolean;
    createLabel?: string;
    onCreate?: (value: string) => void | Promise<void>;
};


export function AutocompleteTextInput({
    value,
    onChange,
    suggestions,
    maxSuggestions = 6,
    showAllWhenEmpty = false,
    createLabel,
    onCreate,
    className,
    onKeyDown,
    onFocus,
    onBlur,
    ...inputProps
}: AutocompleteTextInputProps) {
    const [focused, setFocused] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const listboxId = `${useId()}listbox`;
    const query = value.trim();
    const hasCreateAction = Boolean(createLabel && onCreate);
    const hasExactMatch = useMemo(() => {
        if (!query) return false;
        const queryKey = query.toLowerCase();
        return suggestions.some((option) => option.trim().toLowerCase() === queryKey);
    }, [query, suggestions]);

    const matches = useMemo(() => {
        if (!focused || (!query && !showAllWhenEmpty)) return [];
        const queryKey = query.toLowerCase();
        const seen = new Set<string>();
        const result: string[] = [];
        for (const option of suggestions) {
            const key = option.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            if (query && (key === queryKey || !key.includes(queryKey))) continue;
            seen.add(key);
            result.push(option);
            if (result.length >= maxSuggestions) break;
        }
        return result;
    }, [focused, query, suggestions, maxSuggestions, showAllWhenEmpty]);
    const showCreate = Boolean(focused && query && hasCreateAction && !hasExactMatch);
    const optionCount = matches.length + (showCreate ? 1 : 0);

    useEffect(() => {
        setActiveIndex(hasCreateAction ? 0 : -1);
    }, [hasCreateAction, query]);


    useEffect(() => {
        if (activeIndex < 0) return;
        document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [activeIndex, listboxId, optionCount]);

    const selectSuggestion = (option: string) => {
        onChange(option);
        setActiveIndex(-1);
    };

    const selectCreate = () => {
        if (!onCreate || !query) return;
        onChange(query);
        void onCreate(query);
        setFocused(false);
        setActiveIndex(-1);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (isImeComposing(event)) return;
        if (optionCount > 0) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => (index + 1) % optionCount);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();

                setActiveIndex((index) => (index <= 0 ? optionCount - 1 : index - 1));
                return;
            }
            if (event.key === 'Enter' && (hasCreateAction || activeIndex >= 0)) {
                event.preventDefault();
                event.stopPropagation();
                if (showCreate && (matches.length === 0 || activeIndex === matches.length)) {
                    selectCreate();
                    return;
                }
                selectSuggestion(matches[activeIndex] ?? matches[0]);
                return;
            }
            if (event.key === 'Escape' && activeIndex >= 0) {
                event.stopPropagation();
                if (hasCreateAction) {
                    setFocused(false);
                } else {
                    setActiveIndex(-1);
                }
                return;
            }
        }
        onKeyDown?.(event);
    };

    return (
        <div className="relative">
            <input
                {...inputProps}
                type={inputProps.type ?? 'text'}
                value={value}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={optionCount > 0}
                aria-controls={listboxId}
                aria-activedescendant={activeIndex >= 0 && activeIndex < optionCount ? `${listboxId}-option-${activeIndex}` : undefined}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={(event) => {
                    setFocused(true);
                    onFocus?.(event);
                }}
                onBlur={(event) => {
                    setFocused(false);
                    onBlur?.(event);
                }}
                className={className}
            />
            {optionCount > 0 && (
                <div
                    id={listboxId}
                    role="listbox"


                    onMouseDown={(event) => event.preventDefault()}
                    className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
                >
                    {matches.map((option, index) => (
                        <button
                            key={option}
                            id={`${listboxId}-option-${index}`}
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-selected={index === activeIndex}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                selectSuggestion(option);
                            }}
                            className={cn(
                                'flex w-full items-center px-2.5 py-1.5 text-left text-xs transition-colors',
                                index === activeIndex
                                    ? 'bg-primary text-primary-foreground'
                                    : 'hover:bg-muted/70'
                            )}
                        >
                            {option}
                        </button>
                    ))}
                    {showCreate && (
                        <button
                            id={`${listboxId}-option-${matches.length}`}
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-label={`${createLabel}: ${query}`}
                            aria-selected={activeIndex === matches.length}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                selectCreate();
                            }}
                            className={cn(
                                'flex w-full items-center px-2.5 py-1.5 text-left text-xs transition-colors',
                                activeIndex === matches.length
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-primary hover:bg-muted/70'
                            )}
                        >
                            + {createLabel} &quot;{query}&quot;
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
