import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
    createCustomTimeEstimate,
    formatTimeEstimateLabel,
    isCustomTimeEstimate,
    parseTimeEstimateInput,
    tFallback,
    timeEstimateToMinutes,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { STATUS_PILL_ACTIVE_CLASSES } from '../../../lib/status-colors';
import {
    QUICK_ADD_FIELD_TOKENS,
    QuickAddTokenBadge,
    taskEditorLabelClassName,
} from '../task-editor-label';

type PillOption<TValue extends string> = {
    value: TValue;
    label: string;
    onContextMenu?: () => void;
    /** Overrides the selected look for this option (status pills wear their
     *  Board status color instead of the generic primary). */
    activeClassName?: string;
};

const selectedPillClassName = 'border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90';

const simplePrefixedTokenPattern = /^[@#][^\s,]+$/u;
const customTimeEstimateOptionValue = '__custom';

const canonicalToken = (value: string): string =>
    value.trim().replace(/^[@#]/, '').toLowerCase();

const isSimplePrefixedToken = (value: string): boolean =>
    simplePrefixedTokenPattern.test(value.trim());

const splitTokens = (value: string): string[] =>
    value
        .split(',')
        .flatMap((item) => {
            const trimmed = item.trim();
            if (!trimmed) return [];
            const whitespaceTokens = trimmed.split(/\s+/).filter(Boolean);
            if (whitespaceTokens.length > 1 && whitespaceTokens.every(isSimplePrefixedToken)) {
                return whitespaceTokens;
            }
            return [trimmed];
        });

const uniqueOptions = (options: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    options.forEach((option) => {
        const trimmed = option.trim();
        const key = canonicalToken(trimmed);
        if (!trimmed || seen.has(key)) return;
        seen.add(key);
        result.push(trimmed);
    });
    return result;
};

const matchesOption = (option: string, query: string): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    const bareQuery = canonicalToken(query);
    if (!normalizedQuery && !bareQuery) return false;
    const normalizedOption = option.trim().toLowerCase();
    const bareOption = canonicalToken(option);
    return normalizedOption.includes(normalizedQuery) || bareOption.includes(bareQuery);
};

const getCurrentTokenBounds = (value: string, cursor: number | null): { start: number; end: number } => {
    const index = typeof cursor === 'number' ? cursor : value.length;
    const beforeCursor = value.slice(0, index);
    const afterCursor = value.slice(index);
    let tokenStart = beforeCursor.lastIndexOf(',') + 1;
    const segmentBeforeCursor = beforeCursor.slice(tokenStart);
    const activeAfterSpaceMatch = segmentBeforeCursor.match(/\s+([^\s,]*)$/u);
    if (activeAfterSpaceMatch?.index !== undefined && activeAfterSpaceMatch[1]) {
        const priorTokens = segmentBeforeCursor.slice(0, activeAfterSpaceMatch.index).trim().split(/\s+/);
        const priorToken = priorTokens[priorTokens.length - 1] ?? '';
        if (isSimplePrefixedToken(priorToken)) {
            tokenStart += activeAfterSpaceMatch.index + activeAfterSpaceMatch[0].length - activeAfterSpaceMatch[1].length;
        }
    }
    const nextComma = afterCursor.indexOf(',');
    const tokenEnd = nextComma === -1 ? value.length : index + nextComma;
    return { start: tokenStart, end: tokenEnd };
};

const getCurrentTokenQuery = (value: string, cursor: number | null): string => {
    const { start } = getCurrentTokenBounds(value, cursor);
    const index = typeof cursor === 'number' ? cursor : value.length;
    return value.slice(start, index).trim();
};

const getTokensOutsideCurrentQuery = (value: string, cursor: number | null): string[] => {
    const { start, end } = getCurrentTokenBounds(value, cursor);
    return [
        ...splitTokens(value.slice(0, start)),
        ...splitTokens(value.slice(end)),
    ];
};

const replaceCurrentToken = (value: string, cursor: number | null, token: string): string => {
    const { start, end } = getCurrentTokenBounds(value, cursor);
    const nextTokens = [
        ...splitTokens(value.slice(0, start)),
        token,
        ...splitTokens(value.slice(end)),
    ];
    const seen = new Set<string>();
    return nextTokens
        .filter((item) => {
            const key = canonicalToken(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .join(', ');
};

function SuggestionList({
    activeIndex,
    suggestions,
    onSelect,
}: {
    activeIndex: number;
    suggestions: string[];
    onSelect: (value: string) => void;
}) {
    if (suggestions.length === 0) return null;
    return (
        <div
            role="listbox"
            className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
            {suggestions.map((suggestion, index) => (
                <button
                    key={suggestion}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        onSelect(suggestion);
                    }}
                    className={cn(
                        'flex w-full items-center px-2.5 py-1.5 text-left text-xs transition-colors',
                        index === activeIndex
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted/70'
                    )}
                >
                    {suggestion}
                </button>
            ))}
        </div>
    );
}

function PillOptionField<TValue extends string>({
    t,
    ariaLabel,
    label,
    labelToken,
    options,
    value,
    onChange,
    activeClassName,
}: {
    t: (key: string) => string;
    ariaLabel: string;
    label: string;
    labelToken?: string;
    options: Array<PillOption<TValue>>;
    value: TValue;
    onChange: (value: TValue) => void;
    activeClassName?: string;
}) {
    const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const focusOption = (index: number) => {
        buttonRefs.current[index]?.focus();
        onChange(options[index].value);
    };
    const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            focusOption((index + 1) % options.length);
            return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            focusOption((index - 1 + options.length) % options.length);
            return;
        }
        if (event.key === 'Home') {
            event.preventDefault();
            focusOption(0);
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            focusOption(options.length - 1);
        }
    };

    return (
        <div className="flex flex-col gap-1">
            <label className={`${taskEditorLabelClassName} inline-flex items-center gap-1.5`}>
                {label}
                {labelToken && <QuickAddTokenBadge t={t} token={labelToken} />}
            </label>
            <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
                {options.map((option, index) => {
                    const isActive = value === option.value;
                    return (
                        <button
                            key={option.value || 'none'}
                            ref={(element) => {
                                buttonRefs.current[index] = element;
                            }}
                            type="button"
                            aria-label={option.label}
                            aria-pressed={isActive}
                            onKeyDown={(event) => handleOptionKeyDown(event, index)}
                            onClick={() => onChange(option.value)}
                            onContextMenu={option.onContextMenu ? (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                option.onContextMenu?.();
                            } : undefined}
                            className={cn(
                                'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                                isActive
                                    ? option.activeClassName ?? activeClassName ?? selectedPillClassName
                                    : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                            )}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function ToggleTokenField({
    t,
    ariaLabel,
    label,
    labelToken,
    options,
    suggestions = options,
    placeholder,
    value,
    onChange,
}: {
    t: (key: string) => string;
    ariaLabel: string;
    label: string;
    labelToken?: string;
    options: string[];
    suggestions?: string[];
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [focused, setFocused] = useState(false);
    const [cursor, setCursor] = useState<number | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const query = getCurrentTokenQuery(value, cursor);
    const currentTokens = useMemo(() => splitTokens(value), [value]);
    const otherTokenKeys = useMemo(
        () => new Set(getTokensOutsideCurrentQuery(value, cursor).map(canonicalToken)),
        [cursor, value]
    );
    const suggestionOptions = useMemo(
        () => uniqueOptions([...suggestions, ...options]),
        [options, suggestions]
    );
    const filteredSuggestions = useMemo(() => {
        if (!focused || !query) return [];
        const trimmedQuery = query.trim().toLowerCase();
        return suggestionOptions
            .filter((option) => matchesOption(option, query))
            .filter((option) => option.trim().toLowerCase() !== trimmedQuery)
            .filter((option) => !otherTokenKeys.has(canonicalToken(option)))
            .slice(0, 6);
    }, [focused, otherTokenKeys, query, suggestionOptions]);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const selectSuggestion = (suggestion: string) => {
        onChange(replaceCurrentToken(value, cursor, suggestion));
        setCursor(null);
        setFocused(false);
        requestAnimationFrame(() => inputRef.current?.focus());
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (filteredSuggestions.length === 0) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % filteredSuggestions.length);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + filteredSuggestions.length) % filteredSuggestions.length);
            return;
        }
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            event.stopPropagation();
            selectSuggestion(filteredSuggestions[activeIndex] ?? filteredSuggestions[0]);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setFocused(false);
        }
    };

    return (
        <div className="flex flex-col gap-1 w-full">
            <label className={`${taskEditorLabelClassName} inline-flex items-center gap-1.5`}>
                {label}
                {labelToken && <QuickAddTokenBadge t={t} token={labelToken} />}
            </label>
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    aria-label={ariaLabel}
                    aria-autocomplete="list"
                    aria-expanded={filteredSuggestions.length > 0}
                    value={value}
                    onChange={(event) => {
                        setCursor(event.currentTarget.selectionStart);
                        onChange(event.target.value);
                    }}
                    onClick={(event) => setCursor(event.currentTarget.selectionStart)}
                    onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
                    onKeyDown={handleKeyDown}
                    onFocus={(event) => {
                        setFocused(true);
                        setCursor(event.currentTarget.selectionStart);
                    }}
                    onBlur={() => setFocused(false)}
                    placeholder={placeholder}
                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
                />
                <SuggestionList
                    activeIndex={activeIndex}
                    suggestions={filteredSuggestions}
                    onSelect={selectSuggestion}
                />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
                {options.map((token) => {
                    const isActive = currentTokens.some((item) => canonicalToken(item) === canonicalToken(token));
                    return (
                        <button
                            key={token}
                            type="button"
                            onClick={() => {
                                const nextTokens = isActive
                                    ? currentTokens.filter((item) => canonicalToken(item) !== canonicalToken(token))
                                    : [...currentTokens, token];
                                onChange(nextTokens.join(', '));
                            }}
                            className={cn(
                                'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
                                isActive
                                    ? selectedPillClassName
                                    : 'bg-transparent border-border text-muted-foreground hover:border-primary/50'
                            )}
                        >
                            {token}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function AutocompleteTextField({
    t,
    ariaLabel,
    createLabel,
    label,
    labelToken,
    onCreate,
    options,
    placeholder,
    value,
    onChange,
}: {
    t: (key: string) => string;
    ariaLabel: string;
    createLabel?: string;
    label: string;
    labelToken?: string;
    onCreate?: (value: string) => void | Promise<void>;
    options: string[];
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [focused, setFocused] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const query = value.trim();
    const hasExactMatch = useMemo(() => {
        if (!query) return false;
        const queryKey = query.toLowerCase();
        return uniqueOptions(options).some((option) => option.toLowerCase() === queryKey);
    }, [options, query]);
    const suggestions = useMemo(() => {
        if (!focused || !query) return [];
        const queryKey = query.toLowerCase();
        return uniqueOptions(options)
            .filter((option) => option.toLowerCase().includes(queryKey))
            .filter((option) => option.toLowerCase() !== queryKey)
            .slice(0, 6);
    }, [focused, options, query]);
    const showCreate = Boolean(focused && query && onCreate && createLabel && !hasExactMatch);
    const optionCount = suggestions.length + (showCreate ? 1 : 0);

    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const selectSuggestion = (suggestion: string) => {
        onChange(suggestion);
        setFocused(false);
        requestAnimationFrame(() => inputRef.current?.focus());
    };

    const selectCreate = () => {
        if (!onCreate || !query) return;
        void onCreate(query);
        setFocused(false);
        requestAnimationFrame(() => inputRef.current?.focus());
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (optionCount === 0) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % optionCount);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + optionCount) % optionCount);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (showCreate && activeIndex === suggestions.length) {
                selectCreate();
                return;
            }
            selectSuggestion(suggestions[activeIndex] ?? suggestions[0]);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setFocused(false);
        }
    };

    return (
        <div className="flex flex-col gap-1">
            <label className={`${taskEditorLabelClassName} inline-flex items-center gap-1.5`}>
                {label}
                {labelToken && <QuickAddTokenBadge t={t} token={labelToken} />}
            </label>
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    aria-label={ariaLabel}
                    aria-autocomplete="list"
                    aria-expanded={optionCount > 0}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    placeholder={placeholder}
                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
                />
                {optionCount > 0 && (
                    <div
                        role="listbox"
                        className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
                    >
                        {suggestions.map((suggestion, index) => (
                            <button
                                key={suggestion}
                                type="button"
                                role="option"
                                aria-selected={index === activeIndex}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    selectSuggestion(suggestion);
                                }}
                                onClick={() => selectSuggestion(suggestion)}
                                className={cn(
                                    'flex w-full items-center px-2.5 py-1.5 text-left text-xs transition-colors',
                                    index === activeIndex
                                        ? 'bg-primary text-primary-foreground'
                                        : 'hover:bg-muted/70'
                                )}
                            >
                                {suggestion}
                            </button>
                        ))}
                        {showCreate && (
                            <button
                                type="button"
                                role="option"
                                aria-label={`${createLabel}: ${query}`}
                                aria-selected={activeIndex === suggestions.length}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    selectCreate();
                                }}
                                onClick={selectCreate}
                                className={cn(
                                    'flex w-full items-center px-2.5 py-1.5 text-left text-xs transition-colors',
                                    activeIndex === suggestions.length
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
        </div>
    );
}

export function StatusField({
    t,
    value,
    onChange,
    onRequestBackdatedComplete,
}: {
    t: (key: string) => string;
    value: TaskStatus;
    onChange: (value: TaskStatus) => void;
    onRequestBackdatedComplete?: () => void;
}) {
    const baseOptions: Array<PillOption<TaskStatus>> = [
        { value: 'inbox', label: t('status.inbox') },
        { value: 'next', label: t('status.next') },
        { value: 'waiting', label: t('status.waiting') },
        { value: 'someday', label: t('status.someday') },
        ...(value === 'reference' ? [{ value: 'reference' as const, label: t('status.reference') }] : []),
        { value: 'done', label: t('status.done'), onContextMenu: onRequestBackdatedComplete },
        { value: 'archived', label: t('status.archived') },
    ];
    const options = baseOptions.map((option) => ({
        ...option,
        activeClassName: `${STATUS_PILL_ACTIVE_CLASSES[option.value]} shadow-sm hover:brightness-110`,
    }));

    return (
        <PillOptionField
            t={t}
            ariaLabel={t('task.aria.status')}
            label={t('taskEdit.statusLabel')}
            options={options}
            value={value}
            onChange={onChange}
        />
    );
}

export function PriorityField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: TaskPriority | '';
    onChange: (value: TaskPriority | '') => void;
}) {
    const options: Array<PillOption<TaskPriority | ''>> = [
        { value: '', label: t('common.none') },
        { value: 'low', label: t('priority.low') },
        { value: 'medium', label: t('priority.medium') },
        { value: 'high', label: t('priority.high') },
        { value: 'urgent', label: t('priority.urgent') },
    ];

    return (
        <PillOptionField
            t={t}
            ariaLabel={t('taskEdit.priorityLabel')}
            label={t('taskEdit.priorityLabel')}
            options={options}
            value={value}
            onChange={onChange}
        />
    );
}

export function EnergyLevelField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: NonNullable<TaskEnergyLevel> | '';
    onChange: (value: NonNullable<TaskEnergyLevel> | '') => void;
}) {
    const options: Array<PillOption<NonNullable<TaskEnergyLevel> | ''>> = [
        { value: '', label: t('common.none') },
        { value: 'low', label: t('energyLevel.low') },
        { value: 'medium', label: t('energyLevel.medium') },
        { value: 'high', label: t('energyLevel.high') },
    ];

    return (
        <PillOptionField
            t={t}
            ariaLabel={t('taskEdit.energyLevel')}
            label={t('taskEdit.energyLevel')}
            labelToken={QUICK_ADD_FIELD_TOKENS.energyLevel}
            options={options}
            value={value}
            onChange={onChange}
        />
    );
}

export function AssignedToField({
    t,
    value,
    options = [],
    onChange,
    onCreatePerson,
}: {
    t: (key: string) => string;
    value: string;
    options?: string[];
    onChange: (value: string) => void;
    onCreatePerson?: (name: string) => void | Promise<void>;
}) {
    return (
        <AutocompleteTextField
            t={t}
            ariaLabel={t('taskEdit.assignedTo')}
            createLabel={tFallback(t, 'people.new', 'New Person')}
            label={t('taskEdit.assignedTo')}
            labelToken={QUICK_ADD_FIELD_TOKENS.assignedTo}
            onCreate={onCreatePerson}
            options={options}
            placeholder={t('taskEdit.assignedToPlaceholder')}
            value={value}
            onChange={onChange}
        />
    );
}

export function TimeEstimateField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: TimeEstimate | '';
    onChange: (value: TimeEstimate | '') => void;
}) {
    const customDraftSourceRef = useRef<TimeEstimate | ''>('');
    const [customDraft, setCustomDraft] = useState('');
    const isCustom = isCustomTimeEstimate(value || undefined);

    useEffect(() => {
        if (!isCustom) {
            customDraftSourceRef.current = value;
            setCustomDraft('');
            return;
        }

        if (customDraftSourceRef.current !== value) {
            customDraftSourceRef.current = value;
            setCustomDraft(formatTimeEstimateLabel(value as TimeEstimate));
        }
    }, [isCustom, value]);

    const applyCustomDraft = (draft: string): boolean => {
        const minutes = parseTimeEstimateInput(draft);
        if (minutes === null) return false;
        const next = createCustomTimeEstimate(minutes);
        customDraftSourceRef.current = next;
        onChange(next);
        return true;
    };

    const beginCustomEstimate = () => {
        const next = createCustomTimeEstimate(timeEstimateToMinutes(value || undefined));
        customDraftSourceRef.current = next;
        setCustomDraft(formatTimeEstimateLabel(next));
        onChange(next);
    };

    const selectValue = isCustom ? customTimeEstimateOptionValue : value;

    return (
        <div className="flex flex-col gap-1 w-full">
            <label className={taskEditorLabelClassName}>{t('taskEdit.timeEstimateLabel')}</label>
            <select
                value={selectValue}
                aria-label={t('task.aria.timeEstimate')}
                onChange={(event) => {
                    const next = event.target.value;
                    if (next === customTimeEstimateOptionValue) {
                        beginCustomEstimate();
                        return;
                    }
                    onChange(next as TimeEstimate | '');
                }}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
            >
                <option value="">{t('common.none')}</option>
                <option value="5min">5m</option>
                <option value="10min">10m</option>
                <option value="15min">15m</option>
                <option value="30min">30m</option>
                <option value="1hr">1h</option>
                <option value="2hr">2h</option>
                <option value="3hr">3h</option>
                <option value="4hr">4h</option>
                <option value="4hr+">4h+</option>
                <option value={customTimeEstimateOptionValue}>{t('recurrence.custom')}</option>
            </select>
            {isCustom && (
                <input
                    type="text"
                    value={customDraft}
                    onChange={(event) => {
                        const draft = event.target.value;
                        setCustomDraft(draft);
                        const minutes = parseTimeEstimateInput(draft);
                        if (minutes === null) return;
                        const next = createCustomTimeEstimate(minutes);
                        customDraftSourceRef.current = next;
                        onChange(next);
                    }}
                    onBlur={() => {
                        if (!applyCustomDraft(customDraft)) {
                            setCustomDraft(formatTimeEstimateLabel(value as TimeEstimate));
                        }
                    }}
                    placeholder="2h30"
                    aria-label={`${t('task.aria.timeEstimate')} custom`}
                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
                />
            )}
        </div>
    );
}

export function ContextsField({
    t,
    value,
    options,
    suggestions,
    onChange,
}: {
    t: (key: string) => string;
    value: string;
    options: string[];
    suggestions?: string[];
    onChange: (value: string) => void;
}) {
    return (
        <ToggleTokenField
            t={t}
            ariaLabel={t('task.aria.contexts')}
            label={t('taskEdit.contextsLabel')}
            labelToken={QUICK_ADD_FIELD_TOKENS.contexts}
            options={options}
            suggestions={suggestions}
            placeholder={t('taskEdit.contextsPlaceholder')}
            value={value}
            onChange={onChange}
        />
    );
}

export function TagsField({
    t,
    value,
    options,
    suggestions,
    onChange,
}: {
    t: (key: string) => string;
    value: string;
    options: string[];
    suggestions?: string[];
    onChange: (value: string) => void;
}) {
    return (
        <ToggleTokenField
            t={t}
            ariaLabel={t('task.aria.tags')}
            label={t('taskEdit.tagsLabel')}
            labelToken={QUICK_ADD_FIELD_TOKENS.tags}
            options={options}
            suggestions={suggestions}
            placeholder={t('taskEdit.tagsPlaceholder')}
            value={value}
            onChange={onChange}
        />
    );
}

export function TimeSpentField({
    t,
    value,
    onChange,
}: {
    t: (key: string) => string;
    value: number | undefined;
    onChange: (value: number | undefined) => void;
}) {
    return (
        <div className="flex flex-col gap-1 w-full">
            <label className={taskEditorLabelClassName}>{t('taskEdit.timeSpentLabel')}</label>
            <input
                type="number"
                min={0}
                // step=1 so every whole minute is a valid value. step=5 made the
                // arrows move in fives but marked anything off the grid (7, 23)
                // as stepMismatch, so the browser rejected times people had
                // actually spent (#896).
                step={1}
                inputMode="numeric"
                aria-label={t('taskEdit.timeSpentLabel')}
                value={value ?? ''}
                onChange={(event) => {
                    const raw = event.target.value;
                    if (!raw) {
                        onChange(undefined);
                        return;
                    }
                    const parsed = Number(raw);
                    onChange(Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined);
                }}
                placeholder={t('taskEdit.timeSpentPlaceholder')}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
            />
        </div>
    );
}
