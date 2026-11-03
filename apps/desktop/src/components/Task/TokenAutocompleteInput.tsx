import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FocusEventHandler, KeyboardEventHandler, RefObject } from 'react';

import { cn } from '../../lib/utils';
import { isImeComposing } from '../../lib/ime';
import {
    rankAutocompleteTokens,
    stripTokenPrefix,
    type TokenAutocompletePrefix,
} from './token-autocomplete';

type TokenSegment = {
    start: number;
    end: number;
    query: string;
};

type TokenAutocompleteInputProps = {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    suggestions: readonly string[];
    prefix: TokenAutocompletePrefix;
    placeholder?: string;
    className?: string;
    dropdownClassName?: string;
    ariaLabel?: string;
    inputRef?: RefObject<HTMLInputElement | null>;
    onBlur?: FocusEventHandler<HTMLInputElement>;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    onAcceptToken?: (token: string) => void;
};

const NO_ACTIVE_OPTION = -1;

const getTokenSegment = (text: string, caret: number): TokenSegment | null => {
    const safeCaret = Math.max(0, Math.min(caret, text.length));
    const before = text.slice(0, safeCaret);
    const separatorIndex = Math.max(before.lastIndexOf(','), before.lastIndexOf('\n'));
    const segmentStart = separatorIndex + 1;
    const segmentText = before.slice(segmentStart);
    if (!segmentText.trim()) return null;

    const leadingWhitespaceLength = segmentText.match(/^\s*/)?.[0].length ?? 0;
    const tokenStart = segmentStart + leadingWhitespaceLength;
    const tokenText = before.slice(tokenStart);
    return {
        start: tokenStart,
        end: safeCaret,
        query: stripTokenPrefix(tokenText),
    };
};

const replaceTokenSegment = (
    text: string,
    segment: TokenSegment,
    token: string,
): { value: string; caret: number } => {
    const before = text.slice(0, segment.start);
    const after = text.slice(segment.end);
    const suffix = after.length === 0 ? ', ' : '';
    const value = `${before}${token}${suffix}${after}`;
    return {
        value,
        caret: before.length + token.length + suffix.length,
    };
};

export function TokenAutocompleteInput({
    id,
    value,
    onChange,
    suggestions,
    prefix,
    placeholder,
    className,
    dropdownClassName,
    ariaLabel,
    inputRef,
    onBlur,
    onKeyDown,
    onAcceptToken,
}: TokenAutocompleteInputProps) {
    const localRef = useRef<HTMLInputElement>(null);
    const mergedRef = inputRef ?? localRef;
    const listboxId = useId();
    const valueRef = useRef(value);
    const [segment, setSegment] = useState<TokenSegment | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(NO_ACTIVE_OPTION);

    const options = useMemo(
        () => segment ? rankAutocompleteTokens(suggestions, prefix, segment.query) : [],
        [prefix, segment, suggestions],
    );
    const hasOptions = segment && options.length > 0;
    const activeDescendantId = hasOptions && selectedIndex >= 0
        ? `${listboxId}-option-${selectedIndex}`
        : undefined;

    useEffect(() => {
        valueRef.current = value;
    }, [value]);

    useEffect(() => {
        if (selectedIndex >= options.length) {
            setSelectedIndex(NO_ACTIVE_OPTION);
        }
    }, [options.length, selectedIndex]);

    const closeOptions = () => {
        setSegment(null);
        setSelectedIndex(NO_ACTIVE_OPTION);
    };

    const updateSegment = (input: HTMLInputElement) => {
        setSegment(getTokenSegment(input.value, input.selectionStart ?? input.value.length));
        setSelectedIndex(NO_ACTIVE_OPTION);
    };

    const resolveSegment = (): { text: string; segment: TokenSegment } | null => {
        const input = mergedRef.current;
        const text = input?.value ?? valueRef.current;
        const nextSegment = getTokenSegment(text, input?.selectionStart ?? text.length) ?? segment;
        return nextSegment ? { text, segment: nextSegment } : null;
    };

    const applyToken = (token: string) => {
        const active = resolveSegment();
        if (!active) return;
        const input = mergedRef.current;
        const restoreInputFocus = (caret?: number) => {
            requestAnimationFrame(() => {
                if (!input || mergedRef.current !== input) return;
                if (document.activeElement !== input && document.activeElement !== document.body) return;
                input.focus();
                if (caret !== undefined) {
                    input.setSelectionRange(caret, caret);
                }
            });
        };
        if (onAcceptToken) {
            onAcceptToken(token);
            closeOptions();
            restoreInputFocus();
            return;
        }

        const next = replaceTokenSegment(active.text, active.segment, token);
        valueRef.current = next.value;
        onChange(next.value);
        closeOptions();
        restoreInputFocus(next.caret);
    };

    const handleKeyDown: KeyboardEventHandler<HTMLInputElement> = (event) => {
        if (isImeComposing(event)) return;

        if (hasOptions) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                setSelectedIndex((prev) => (prev < 0 ? 0 : (prev + 1) % options.length));
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                setSelectedIndex((prev) => (prev < 0 ? options.length - 1 : (prev - 1 + options.length) % options.length));
                return;
            }
            if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
                if (selectedIndex >= 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    applyToken(options[selectedIndex]);
                    return;
                }
            }
            if (event.key === 'Escape') {
                event.stopPropagation();
                closeOptions();
                return;
            }
        }

        onKeyDown?.(event);
    };

    return (
        <div className="relative">
            <input
                id={id}
                ref={mergedRef}
                value={value}
                onChange={(event) => {
                    const text = event.target.value;
                    valueRef.current = text;
                    onChange(text);
                    updateSegment(event.target);
                }}
                onKeyDown={handleKeyDown}
                onClick={(event) => updateSegment(event.currentTarget)}
                onKeyUp={(event) => {
                    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) return;
                    updateSegment(event.currentTarget);
                }}
                onSelect={(event) => updateSegment(event.currentTarget)}
                onBlur={(event) => {
                    onBlur?.(event);
                    window.setTimeout(() => closeOptions(), 250);
                }}
                placeholder={placeholder}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={Boolean(hasOptions)}
                aria-controls={hasOptions ? listboxId : undefined}
                aria-owns={hasOptions ? listboxId : undefined}
                aria-activedescendant={activeDescendantId}
                aria-label={ariaLabel}
                className={className}
            />
            {hasOptions && (
                <div
                    id={listboxId}
                    role="listbox"
                    className={cn('absolute z-20 mt-2 w-64 rounded-md border border-border bg-popover shadow-lg p-1 text-xs', dropdownClassName)}
                >
                    {options.map((option, index) => (
                        <button
                            id={`${listboxId}-option-${index}`}
                            key={`${option}-${index}`}
                            type="button"
                            role="option"
                            aria-selected={index === selectedIndex}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => applyToken(option)}
                            className={cn(
                                'w-full text-left px-2 py-1 rounded',
                                index === selectedIndex
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-muted/50',
                            )}
                        >
                            {option}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
