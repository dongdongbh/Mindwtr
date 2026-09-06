import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react';
import { resolveFeatureFlags, useTaskStore, type Area, type Project, type TaskPriority } from '@mindwtr/core';
import { cn } from '../../lib/utils';
import {
    compareAutocompleteLabels,
    matchesAutocompleteQuery,
    normalizeAutocompleteTokens,
} from './token-autocomplete';
import { PriorityFlag } from './PriorityFlag';
import { Sparkles } from 'lucide-react';

type TriggerType = 'project' | 'context' | 'tag' | 'area' | 'person' | 'command';
type SlashCommand =
    | 'due' | 'start' | 'review' | 'note' | 'link' | 'energy' | 'priority' | 'area'
    | 'inbox' | 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'archived' | '*';

interface TriggerState {
    type: TriggerType;
    start: number;
    end: number;
    query: string;
}

interface InputSelection {
    start: number;
    end: number;
}

type PendingSelectionRestore = {
    selection: InputSelection;
    expectedValue: string;
};

type ActiveTrigger = {
    text: string;
    trigger: TriggerState;
    selection: InputSelection;
};

type Option =
    | { kind: 'create'; label: string; value: string }
    | { kind: 'project'; label: string; value: string; id: string }
    | { kind: 'context'; label: string; value: string }
    | { kind: 'tag'; label: string; value: string }
    | { kind: 'area'; label: string; value: string; id: string }
    | { kind: 'person'; label: string; value: string }
    | { kind: 'command'; label: string; value: string; command: SlashCommand; requiresArgument: boolean; priority?: TaskPriority };

// WebKit does not scroll an input to a caret set via setSelectionRange, so we
// measure the caret's pixel offset and adjust scrollLeft ourselves (LTR only).
let caretMeasureContext: CanvasRenderingContext2D | null | undefined;

const ensureCaretVisible = (input: HTMLInputElement, caret: number) => {
    if (typeof window === 'undefined') return;
    const style = window.getComputedStyle(input);
    if (style.direction === 'rtl') return;
    if (caretMeasureContext === undefined) {
        caretMeasureContext = document.createElement('canvas').getContext('2d');
    }
    const context = caretMeasureContext;
    if (!context) return;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const caretX = context.measureText(input.value.slice(0, caret)).width;
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const visibleWidth = input.clientWidth - paddingLeft - paddingRight;
    if (visibleWidth <= 0) return;
    if (caretX < input.scrollLeft) {
        input.scrollLeft = Math.max(0, caretX - visibleWidth / 4);
    } else if (caretX > input.scrollLeft + visibleWidth) {
        input.scrollLeft = caretX - (visibleWidth * 3) / 4;
    }
};

export type TaskInputAcceptedSuggestion =
    | { kind: 'project'; label: string; value: string; projectId: string }
    | { kind: 'createProject'; label: string; value: string; projectId: string | null }
    | { kind: 'context'; label: string; value: string }
    | { kind: 'tag'; label: string; value: string }
    | { kind: 'area'; label: string; value: string; areaId: string }
    | { kind: 'person'; label: string; value: string }
    | { kind: 'command'; label: string; value: string; command: SlashCommand };

interface TaskInputProps {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    projects: Project[];
    contexts: readonly string[];
    areas?: Area[];
    people?: readonly string[];
    onCreateProject?: (title: string) => Promise<string | null>;
    onAcceptSuggestion?: (suggestion: TaskInputAcceptedSuggestion) => boolean | Promise<boolean>;
    placeholder?: string;
    className?: string;
    containerClassName?: string;
    autoFocus?: boolean;
    inputRef?: RefObject<HTMLInputElement | null>;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    onPaste?: ClipboardEventHandler<HTMLInputElement>;
    dir?: 'ltr' | 'rtl';
    ariaLabel?: string;
}

const SLASH_COMMANDS: Array<{
    command: SlashCommand;
    hint?: string;
    requiresArgument: boolean;
}> = [
    { command: 'due', hint: '<when>', requiresArgument: true },
    { command: 'start', hint: '<when>', requiresArgument: true },
    { command: 'review', hint: '<when>', requiresArgument: true },
    { command: 'note', hint: '<text>', requiresArgument: true },
    { command: 'link', hint: '<url>', requiresArgument: true },
    { command: 'energy', hint: '<level>', requiresArgument: true },
    { command: 'priority', hint: '<level>', requiresArgument: true },
    { command: 'area', hint: '<name>', requiresArgument: true },
    { command: 'next', requiresArgument: false },
    { command: 'waiting', requiresArgument: false },
    { command: 'someday', requiresArgument: false },
    { command: 'reference', requiresArgument: false },
    { command: 'inbox', requiresArgument: false },
    { command: 'done', requiresArgument: false },
    { command: 'archived', requiresArgument: false },
    { command: '*', requiresArgument: false },
];

// The parser only accepts these exact tokens for /energy: — suggest them so
// a partial token like "l" never ends up in the task title.
const ENERGY_LEVEL_VALUES = ['low', 'medium', 'high'];
const PRIORITY_VALUES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

function getSlashCommandOptions(query: string, prioritiesEnabled: boolean): Option[] {
    const separatorIndex = query.indexOf(':');
    const rawCommandQuery = (separatorIndex >= 0 ? query.slice(0, separatorIndex) : query).trim().toLowerCase();
    const rawValue = separatorIndex >= 0 ? query.slice(separatorIndex + 1).trim() : '';

    if (separatorIndex >= 0 && rawCommandQuery === 'energy') {
        return ENERGY_LEVEL_VALUES
            .filter((level) => level.startsWith(rawValue.toLowerCase()))
            .map((level) => ({
                kind: 'command' as const,
                label: `/energy:${level}`,
                value: level,
                command: 'energy' as const,
                requiresArgument: true,
            }));
    }

    if (separatorIndex >= 0 && rawCommandQuery === 'priority' && prioritiesEnabled) {
        return PRIORITY_VALUES
            .filter((level) => level.startsWith(rawValue.toLowerCase()))
            .map((level) => ({
                kind: 'command' as const,
                label: `/priority:${level}`,
                value: level,
                command: 'priority' as const,
                requiresArgument: true,
                priority: level,
            }));
    }

    return SLASH_COMMANDS
        // The parser ignores /priority: while the feature is off, so suggesting
        // it would hand the user a token that stays in their title (#1107).
        .filter(({ command }) => command !== 'priority' || prioritiesEnabled)
        .filter(({ command }) => (
            rawCommandQuery.length === 0
            || command.startsWith(rawCommandQuery)
            || command.includes(rawCommandQuery)
        ))
        .map(({ command, hint, requiresArgument }) => {
            const label = requiresArgument
                ? `/${command}:${rawValue || hint || ''}`
                : `/${command}`;
            return {
                kind: 'command' as const,
                label,
                value: rawValue,
                command,
                requiresArgument,
            };
        });
}

function getTrigger(text: string, caret: number): TriggerState | null {
    if (caret < 0) return null;
    const before = text.slice(0, caret);
    const commandMatch = /(?:^|\s)\/(\*|[a-z-]*)(?::([\s\S]*))?$/i.exec(before);
    if (commandMatch) {
        const rawMatch = commandMatch[0] ?? '';
        const slashOffset = rawMatch.indexOf('/');
        if (slashOffset >= 0) {
            const start = (commandMatch.index ?? 0) + slashOffset;
            return {
                type: 'command',
                start,
                end: caret,
                query: before.slice(start + 1),
            };
        }
    }
    const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'));
    const start = lastSpace + 1;
    const token = before.slice(start);
    if (!token.startsWith('+') && !token.startsWith('@') && !token.startsWith('#') && !token.startsWith('!') && !token.startsWith('%') && !token.startsWith('/')) return null;
    const type: TriggerType = token.startsWith('+')
        ? 'project'
        : token.startsWith('@')
            ? 'context'
            : token.startsWith('#')
                ? 'tag'
                : token.startsWith('!')
                    ? 'area'
                    : token.startsWith('%')
                        ? 'person'
                        : 'command';
    return {
        type,
        start,
        end: caret,
        query: token.slice(1),
    };
}

function removeAcceptedTriggerText(text: string, trigger: TriggerState): { value: string; caret: number } {
    const before = text.slice(0, trigger.start);
    const after = text.slice(trigger.end);
    if (before.length === 0) {
        return {
            value: after.replace(/^\s+/, ''),
            caret: 0,
        };
    }
    if (after.length === 0) {
        const value = before.replace(/\s+$/, '');
        return {
            value,
            caret: value.length,
        };
    }
    if (/\s$/.test(before) && /^\s+/.test(after)) {
        return {
            value: `${before}${after.replace(/^\s+/, '')}`,
            caret: before.length,
        };
    }
    return {
        value: `${before}${after}`,
        caret: before.length,
    };
}

export function TaskInput({
    id,
    value,
    onChange,
    projects,
    contexts,
    areas = [],
    people = [],
    onCreateProject,
    onAcceptSuggestion,
    placeholder,
    className,
    containerClassName,
    autoFocus,
    inputRef,
    onKeyDown,
    onPaste,
    dir,
    ariaLabel,
}: TaskInputProps) {
    const localRef = useRef<HTMLInputElement>(null);
    const mergedRef = inputRef ?? localRef;
    const listboxId = useId();
    const [trigger, setTrigger] = useState<TriggerState | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const valueRef = useRef(value);
    const selectionRef = useRef<InputSelection>({
        start: value.length,
        end: value.length,
    });
    const pendingSelectionRef = useRef<PendingSelectionRestore | null>(null);
    const undoRef = useRef<Array<{ value: string; selection: InputSelection }>>([]);
    const prioritiesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);

    const options = useMemo<Option[]>(() => {
        if (!trigger) return [];
        const query = trigger.query.trim().toLowerCase();
        if (trigger.type === 'command') {
            return getSlashCommandOptions(trigger.query, prioritiesEnabled);
        }
        if (trigger.type === 'project') {
            const activeProjects = projects.filter((project) => project.status !== 'archived');
            const matches = activeProjects
                .filter((project) => matchesAutocompleteQuery(project.title, query))
                .sort((a, b) => compareAutocompleteLabels(a.title, b.title, query));
            const hasExact = query.length > 0 && activeProjects.some((project) => project.title.toLowerCase() === query);
            const result: Option[] = matches.map((project) => ({
                kind: 'project' as const,
                label: project.title,
                value: project.title,
                id: project.id,
            }));
            if (!hasExact && query.length > 0) {
                result.push({
                    kind: 'create' as const,
                    label: `Create Project "${trigger.query.trim()}"`,
                    value: trigger.query.trim(),
                });
            }
            return result;
        }
        if (trigger.type === 'area') {
            const matches = areas
                .filter((area) => matchesAutocompleteQuery(area.name, query))
                .sort((a, b) => compareAutocompleteLabels(a.name, b.name, query));
            return matches.map((area) => ({
                kind: 'area' as const,
                label: area.name,
                value: area.name,
                id: area.id,
            }));
        }
        if (trigger.type === 'person') {
            const matches = people
                .filter((name) => matchesAutocompleteQuery(name, query))
                .sort((a, b) => compareAutocompleteLabels(a, b, query));
            return matches.map((name) => ({
                kind: 'person' as const,
                label: name,
                value: name,
            }));
        }
        const expectedPrefix = trigger.type === 'tag' ? '#' : '@';
        const normalizedTokens = normalizeAutocompleteTokens(contexts, expectedPrefix);
        const matches = normalizedTokens
            .filter((token) => matchesAutocompleteQuery(token.slice(1), query))
            .sort((a, b) => compareAutocompleteLabels(a.slice(1), b.slice(1), query));
        return matches.map((token) => ({
            kind: (trigger.type === 'tag' ? 'tag' : 'context') as 'tag' | 'context',
            label: token,
            value: token,
        }));
    }, [trigger, projects, contexts, areas, people, prioritiesEnabled]);

    const closeTrigger = () => {
        setTrigger(null);
        setSelectedIndex(0);
    };

    const pushUndoEntry = (previousValue: string, selection: InputSelection) => {
        const previousEntry = undoRef.current[undoRef.current.length - 1];
        if (
            previousEntry
            && previousEntry.value === previousValue
            && previousEntry.selection.start === selection.start
            && previousEntry.selection.end === selection.end
        ) {
            return;
        }

        const nextUndoEntries = [...undoRef.current, { value: previousValue, selection }];
        undoRef.current = nextUndoEntries.length > 100
            ? nextUndoEntries.slice(nextUndoEntries.length - 100)
            : nextUndoEntries;
    };

    const updateSelection = (input: HTMLInputElement) => {
        selectionRef.current = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
        };
    };

    const resolveInputSelection = (input: HTMLInputElement | null): InputSelection => {
        if (!input) return selectionRef.current;
        const selection = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
        };
        selectionRef.current = selection;
        return selection;
    };

    const restoreSelection = (selection: InputSelection) => {
        const input = mergedRef.current;
        if (input) {
            input.focus();
            input.setSelectionRange(selection.start, selection.end);
            ensureCaretVisible(input, selection.end);
        }
        selectionRef.current = selection;
    };

    const scheduleSelectionRestore = (selection: InputSelection) => {
        const pendingRestore: PendingSelectionRestore = {
            selection,
            expectedValue: valueRef.current,
        };
        pendingSelectionRef.current = pendingRestore;
        requestAnimationFrame(() => {
            if (pendingSelectionRef.current !== pendingRestore) return;
            restoreSelection(pendingRestore.selection);
            const input = mergedRef.current;
            if (!input || input.value === pendingRestore.expectedValue) {
                pendingSelectionRef.current = null;
            }
        });
    };

    useLayoutEffect(() => {
        const pendingRestore = pendingSelectionRef.current;
        if (!pendingRestore) return;
        if (value !== pendingRestore.expectedValue) {
            pendingSelectionRef.current = null;
            return;
        }
        restoreSelection(pendingRestore.selection);
        pendingSelectionRef.current = null;
    }, [value]);

    useEffect(() => {
        const isFocused = typeof document !== 'undefined' && mergedRef.current === document.activeElement;
        if (!isFocused && value !== valueRef.current) {
            undoRef.current = [];
            closeTrigger();
            selectionRef.current = {
                start: value.length,
                end: value.length,
            };
        }
        valueRef.current = value;
    }, [mergedRef, value]);

    const updateTrigger = (text: string, caret: number) => {
        const nextTrigger = getTrigger(text, caret);
        setTrigger(nextTrigger);
        setSelectedIndex(0);
    };

    const resolveActiveTrigger = (): ActiveTrigger | null => {
        const input = mergedRef.current;
        const text = input?.value ?? valueRef.current;
        const selection = resolveInputSelection(input);
        const nextTrigger = getTrigger(text, selection.start);
        if (nextTrigger) {
            return { text, trigger: nextTrigger, selection };
        }
        if (trigger) {
            return { text, trigger, selection };
        }
        return null;
    };

    const applyOption = async (option: Option) => {
        const active = resolveActiveTrigger();
        if (!active) return;
        const activeTrigger = active.trigger;
        const expectedTriggerType = option.kind === 'create' ? 'project' : option.kind;
        if (activeTrigger.type !== expectedTriggerType) return;

        let tokenValue = option.value;
        let createdProjectId: string | null = null;
        if (option.kind === 'command' && option.requiresArgument && !option.value.trim()) {
            tokenValue = `/${option.command}:`;
            const before = active.text.slice(0, activeTrigger.start);
            const after = active.text.slice(activeTrigger.end);
            const nextValue = `${before}${tokenValue}${after}`;
            pushUndoEntry(active.text, active.selection);
            valueRef.current = nextValue;
            onChange(nextValue);
            closeTrigger();
            const caret = before.length + tokenValue.length;
            scheduleSelectionRestore({ start: caret, end: caret });
            return;
        }
        if (option.kind === 'create' && onCreateProject) {
            const title = option.value.trim();
            if (title) {
                createdProjectId = await onCreateProject(title);
            }
        }
        if (onAcceptSuggestion) {
            const acceptedSuggestion: TaskInputAcceptedSuggestion | null = option.kind === 'project'
                ? { kind: 'project', label: option.label, value: option.value, projectId: option.id }
                : option.kind === 'create'
                    ? { kind: 'createProject', label: option.label, value: option.value, projectId: createdProjectId }
                    : option.kind === 'area'
                        ? { kind: 'area', label: option.label, value: option.value, areaId: option.id }
                        : option.kind === 'person'
                            ? { kind: 'person', label: option.label, value: option.value }
                        : option.kind === 'command'
                            ? { kind: 'command', label: option.label, value: option.value, command: option.command }
                        : option.kind === 'context'
                            ? { kind: 'context', label: option.label, value: option.value }
                            : { kind: 'tag', label: option.label, value: option.value };
            const handled = await onAcceptSuggestion(acceptedSuggestion);
            if (handled) {
                const next = removeAcceptedTriggerText(active.text, activeTrigger);
                pushUndoEntry(active.text, active.selection);
                valueRef.current = next.value;
                onChange(next.value);
                closeTrigger();
                scheduleSelectionRestore({ start: next.caret, end: next.caret });
                return;
            }
            if (option.kind === 'command') {
                closeTrigger();
                return;
            }
        }
        if (activeTrigger.type === 'project') {
            tokenValue = `+${tokenValue}`;
        } else if (activeTrigger.type === 'area') {
            tokenValue = `!${tokenValue}`;
        } else if (activeTrigger.type === 'person') {
            // Quote multi-word names so the parser never swallows title words
            // at call sites that do not pass knownPeople.
            tokenValue = /\s/.test(tokenValue) ? `%"${tokenValue}"` : `%${tokenValue}`;
        } else if (activeTrigger.type === 'tag') {
            tokenValue = tokenValue.startsWith('#') ? tokenValue : `#${tokenValue}`;
        } else if (activeTrigger.type === 'command' && option.kind === 'command') {
            tokenValue = option.requiresArgument ? `/${option.command}:${option.value}` : `/${option.command}`;
        } else {
            tokenValue = tokenValue.startsWith('@') ? tokenValue : `@${tokenValue}`;
        }

        const before = active.text.slice(0, activeTrigger.start);
        const after = active.text.slice(activeTrigger.end);
        const needsSpace = after.length === 0 || !/^\s/.test(after);
        const nextValue = `${before}${tokenValue}${needsSpace ? ' ' : ''}${after}`;
        pushUndoEntry(active.text, active.selection);
        valueRef.current = nextValue;
        onChange(nextValue);
        closeTrigger();
        const caret = before.length + tokenValue.length + (needsSpace ? 1 : 0);
        scheduleSelectionRestore({ start: caret, end: caret });
    };

    const handleKeyDown: KeyboardEventHandler<HTMLInputElement> = async (event) => {
        const lowerKey = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && lowerKey === 'z') {
            const previousEntry = undoRef.current[undoRef.current.length - 1];
            if (previousEntry) {
                event.preventDefault();
                undoRef.current = undoRef.current.slice(0, -1);
                valueRef.current = previousEntry.value;
                onChange(previousEntry.value);
                closeTrigger();
                scheduleSelectionRestore(previousEntry.selection);
                return;
            }
        }
        if (event.nativeEvent.isComposing || event.key === 'Process') {
            onKeyDown?.(event);
            return;
        }
        if (trigger && options.length > 0) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                setSelectedIndex((prev) => (prev + 1) % options.length);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
                return;
            }
            // Only plain Enter picks a suggestion; modified Enter falls through
            // so consumer shortcuts (Ctrl+Enter save & edit) win over the popup.
            if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                await applyOption(options[selectedIndex]);
                return;
            }
            if (event.key === 'Tab' && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                await applyOption(options[selectedIndex]);
                return;
            }
            if (event.key === 'Escape') {
                event.stopPropagation();
                closeTrigger();
                return;
            }
        }
        onKeyDown?.(event);
    };

    const hasOptions = trigger && options.length > 0;
    const activeDescendantId = hasOptions ? `${listboxId}-option-${selectedIndex}` : undefined;

    useEffect(() => {
        if (!activeDescendantId) return;
        const activeOption = document.getElementById(activeDescendantId);
        if (activeOption && typeof activeOption.scrollIntoView === 'function') {
            activeOption.scrollIntoView({ block: 'nearest' });
        }
    }, [activeDescendantId]);

    return (
        <div className={cn('relative', containerClassName)}>
            <input
                id={id}
                ref={mergedRef}
                value={value}
                autoFocus={autoFocus}
                onChange={(event) => {
                    const text = event.target.value;
                    if (text !== valueRef.current) {
                        pushUndoEntry(valueRef.current, selectionRef.current);
                    }
                    onChange(text);
                    valueRef.current = text;
                    updateSelection(event.target);
                    updateTrigger(text, event.target.selectionStart ?? text.length);
                }}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                onClick={(event) => {
                    const target = event.target as HTMLInputElement;
                    updateSelection(target);
                    updateTrigger(target.value, target.selectionStart ?? target.value.length);
                }}
                onSelect={(event) => {
                    updateSelection(event.currentTarget);
                }}
                onKeyUp={(event) => {
                    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) return;
                    const target = event.currentTarget;
                    updateSelection(target);
                    updateTrigger(target.value, target.selectionStart ?? target.value.length);
                }}
                onBlur={() => {
                    window.setTimeout(() => closeTrigger(), 250);
                }}
                placeholder={placeholder}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={Boolean(hasOptions)}
                aria-controls={hasOptions ? listboxId : undefined}
                aria-owns={hasOptions ? listboxId : undefined}
                aria-activedescendant={activeDescendantId}
                aria-label={ariaLabel}
                className={cn(className, dir === 'rtl' && 'text-right')}
                dir={dir}
            />
            {hasOptions && (
                <div
                    id={listboxId}
                    role="listbox"
                    className="absolute z-20 mt-2 w-64 max-h-60 overflow-y-auto rounded-md border border-border bg-popover shadow-lg p-1 text-xs"
                >
                    {options.map((option, index) => (
                        <button
                            id={`${listboxId}-option-${index}`}
                            key={`${option.kind}-${option.value}-${index}`}
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-selected={index === selectedIndex}
                            onClick={() => void applyOption(option)}
                            className={cn(
                                'w-full text-left px-2 py-1 rounded',
                                index === selectedIndex
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-muted/50'
                            )}
                        >
                            {option.kind === 'create' ? <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{option.label}</span>
                                : option.kind === 'command' && option.priority
                                    ? <span className="inline-flex items-center gap-1.5"><PriorityFlag priority={option.priority} />{option.label}</span>
                                    : option.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
