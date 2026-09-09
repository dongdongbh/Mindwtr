import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Area } from '@mindwtr/core';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ModalPortal } from '../ModalPortal';
import { useDropdownPosition } from './use-dropdown-position';

interface AreaSelectorProps {
    areas: Area[];
    value: string;
    onChange: (areaId: string) => void;
    onCreateArea?: (name: string) => Promise<string | null>;
    placeholder?: string;
    noAreaLabel?: string;
    searchPlaceholder?: string;
    noMatchesLabel?: string;
    createAreaLabel?: string;
    leadingOption?: { value: string; label: string };
    noAreaValue?: string;
    ariaLabel?: string;
    disabled?: boolean;
    closeOnCreateFailure?: boolean;
    className?: string;
    controlClassName?: string;
    menuClassName?: string;
}

export function AreaSelector({
    areas,
    value,
    onChange,
    onCreateArea,
    placeholder = 'Select area',
    noAreaLabel = 'No area',
    searchPlaceholder = 'Search areas',
    noMatchesLabel = 'No matches',
    createAreaLabel = 'Create area',
    leadingOption,
    noAreaValue = '',
    ariaLabel,
    disabled = false,
    closeOnCreateFailure = true,
    className,
    controlClassName,
    menuClassName,
}: AreaSelectorProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const restoreFocusRef = useRef(false);
    const createPendingRef = useRef(false);
    const mountedRef = useRef(true);
    const [isCreating, setIsCreating] = useState(false);
    const selected = areas.find((area) => area.id === value);
    const selectedLabel = leadingOption?.value === value
        ? leadingOption.label
        : value === noAreaValue && noAreaValue !== ''
            ? noAreaLabel
            : selected?.name ?? placeholder;
    const hasSelectedLabel = Boolean(selected)
        || leadingOption?.value === value
        || (noAreaValue !== '' && value === noAreaValue);
    const { fixedDropdownStyle, listMaxHeight } = useDropdownPosition({
        open,
        containerRef,
        dropdownRef,
    });

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => {
        if (!normalizedQuery) return areas;
        return areas.filter((area) => area.name.toLowerCase().includes(normalizedQuery));
    }, [areas, normalizedQuery]);

    const hasExactMatch = useMemo(() => {
        if (!normalizedQuery) return false;
        return areas.some((area) => area.name.toLowerCase() === normalizedQuery);
    }, [areas, normalizedQuery]);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Keyboard/selection closes return focus to the trigger so the user is not
    // stranded on a removed node (outside clicks bypass this on purpose).
    const closeDropdown = () => {
        setOpen(false);
        setQuery('');
        restoreFocusRef.current = true;
    };

    useEffect(() => {
        if (open || disabled || !restoreFocusRef.current) return;
        restoreFocusRef.current = false;
        triggerRef.current?.focus();
    }, [disabled, open]);

    const focusSelectableOption = (direction: 1 | -1) => {
        const options = dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-selector-option="true"]');
        if (!options || options.length === 0) return;
        const list = Array.from(options);
        const active = document.activeElement as HTMLElement | null;
        let index = list.findIndex((option) => option === active);
        if (index < 0) {
            if (normalizedQuery && filtered.length > 0) {
                const areaOptions = list.filter((option) => option.dataset.selectorOptionKind === 'item');
                const nextOption = direction > 0 ? areaOptions[0] : areaOptions[areaOptions.length - 1];
                nextOption?.focus();
                return;
            }
            index = direction > 0 ? -1 : 0;
        }
        const nextIndex = (index + direction + list.length) % list.length;
        list[nextIndex].focus();
    };

    // stopPropagation keeps the app-wide shortcut handler (and an enclosing
    // quick-action menu) from reacting to keys the open dropdown consumes —
    // the dropdown is portaled outside any [role="menu"] ancestor.
    const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeDropdown();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            focusSelectableOption(1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            focusSelectableOption(-1);
        }
    };

    const handleCreate = async () => {
        if (!onCreateArea || disabled || createPendingRef.current) return;
        const name = query.trim();
        if (!name) return;
        createPendingRef.current = true;
        setIsCreating(true);
        try {
            const id = await onCreateArea(name);
            if (!mountedRef.current) return;
            if (id) {
                onChange(id);
                closeDropdown();
            } else if (closeOnCreateFailure) {
                closeDropdown();
            }
        } finally {
            createPendingRef.current = false;
            if (mountedRef.current) setIsCreating(false);
        }
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return;
        const name = query.trim();
        if (!name) return;

        const firstMatch = filtered[0];
        if (firstMatch) {
            event.preventDefault();
            onChange(firstMatch.id);
            closeDropdown();
            return;
        }

        if (!hasExactMatch && onCreateArea) {
            event.preventDefault();
            void handleCreate();
        }
    };

    return (
        <div ref={containerRef} className={cn('relative', className)} aria-busy={isCreating || undefined}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        event.stopPropagation();
                        closeDropdown();
                        return;
                    }
                    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(true);
                    }
                }}
                aria-label={ariaLabel}
                disabled={disabled}
                className={cn(
                    'w-full flex items-center justify-between text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    controlClassName,
                )}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className={cn('truncate', !hasSelectedLabel && 'text-muted-foreground/70')}>{selectedLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
            </button>
            {open && (
                <ModalPortal>
                    <div
                        ref={dropdownRef}
                        data-selector-dropdown="true"
                        style={fixedDropdownStyle}
                        className={cn(
                            'z-[70] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 text-xs',
                            menuClassName,
                        )}
                        onKeyDown={handleDropdownKeyDown}
                    >
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            disabled={disabled || isCreating}
                            placeholder={searchPlaceholder}
                            aria-label={searchPlaceholder}
                            className="w-full mb-1 rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                        />
                        <div role="listbox" aria-label={ariaLabel ?? placeholder}>
                            {leadingOption && (
                                <button
                                    type="button"
                                    data-selector-option="true"
                                    data-selector-option-kind="leading"
                                    role="option"
                                    aria-selected={value === leadingOption.value}
                                    disabled={disabled || isCreating}
                                    onClick={() => {
                                        onChange(leadingOption.value);
                                        closeDropdown();
                                    }}
                                    className={cn(
                                        'w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                                        value === leadingOption.value && 'bg-muted/70'
                                    )}
                                >
                                    {leadingOption.label}
                                </button>
                            )}
                            <button
                                type="button"
                                data-selector-option="true"
                                data-selector-option-kind="none"
                                role="option"
                                aria-selected={value === noAreaValue}
                                disabled={disabled || isCreating}
                                onClick={() => {
                                    onChange(noAreaValue);
                                    closeDropdown();
                                }}
                                className={cn(
                                    'w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                                    value === noAreaValue && 'bg-muted/70'
                                )}
                            >
                                {noAreaLabel}
                            </button>
                            {!hasExactMatch && query.trim() && onCreateArea && (
                                <button
                                    type="button"
                                    data-selector-option="true"
                                    data-selector-option-kind="create"
                                    role="option"
                                    aria-selected={false}
                                    disabled={disabled || isCreating}
                                    onClick={handleCreate}
                                    className="w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none text-primary flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                    {createAreaLabel} &quot;{query.trim()}&quot;
                                </button>
                            )}
                            <div className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                                {filtered.map((area) => (
                                    <button
                                        key={area.id}
                                        type="button"
                                        data-selector-option="true"
                                        data-selector-option-kind="item"
                                        role="option"
                                        aria-selected={area.id === value}
                                        disabled={disabled || isCreating}
                                        onClick={() => {
                                            onChange(area.id);
                                            closeDropdown();
                                        }}
                                        className={cn(
                                            'w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                                            area.id === value && 'bg-muted/70'
                                        )}
                                    >
                                        {area.name}
                                    </button>
                                ))}
                                {filtered.length === 0 && (
                                    <div className="px-2 py-1 text-muted-foreground">{noMatchesLabel}</div>
                                )}
                            </div>
                        </div>
                    </div>
                </ModalPortal>
            )}
        </div>
    );
}
