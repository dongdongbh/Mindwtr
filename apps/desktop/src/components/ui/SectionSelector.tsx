import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Section } from '@mindwtr/core';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDropdownPosition } from './use-dropdown-position';

interface SectionSelectorProps {
    sections: Section[];
    value: string;
    onChange: (sectionId: string) => void;
    onCreateSection?: (title: string) => Promise<string | null>;
    placeholder?: string;
    noSectionLabel?: string;
    searchPlaceholder?: string;
    noMatchesLabel?: string;
    createSectionLabel?: string;
    ariaLabel?: string;
    className?: string;
    controlClassName?: string;
}

export function SectionSelector({
    sections,
    value,
    onChange,
    onCreateSection,
    placeholder = 'Select section',
    noSectionLabel = 'No section',
    searchPlaceholder = 'Search sections',
    noMatchesLabel = 'No matches',
    createSectionLabel = 'Create section',
    ariaLabel,
    className,
    controlClassName,
}: SectionSelectorProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const selected = sections.find((section) => section.id === value);
    const { dropdownClassName, listMaxHeight } = useDropdownPosition({
        open,
        containerRef,
        dropdownRef,
    });

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => {
        if (!normalizedQuery) return sections;
        return sections.filter((section) => section.title.toLowerCase().includes(normalizedQuery));
    }, [sections, normalizedQuery]);

    const hasExactMatch = useMemo(() => {
        if (!normalizedQuery) return false;
        return sections.some((section) => section.title.toLowerCase() === normalizedQuery);
    }, [sections, normalizedQuery]);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    const closeDropdown = () => {
        setOpen(false);
        setQuery('');
    };

    const focusSelectableOption = (direction: 1 | -1) => {
        const options = dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-selector-option="true"]');
        if (!options || options.length === 0) return;
        const list = Array.from(options);
        const active = document.activeElement as HTMLElement | null;
        let index = list.findIndex((option) => option === active);
        if (index < 0) {
            if (normalizedQuery && filtered.length > 0) {
                const sectionOptions = list.filter((option) => option.dataset.selectorOptionKind === 'item');
                const nextOption = direction > 0 ? sectionOptions[0] : sectionOptions[sectionOptions.length - 1];
                nextOption?.focus();
                return;
            }
            index = direction > 0 ? -1 : 0;
        }
        const nextIndex = (index + direction + list.length) % list.length;
        list[nextIndex].focus();
    };

    const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDropdown();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusSelectableOption(1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusSelectableOption(-1);
        }
    };

    const handleCreate = async () => {
        if (!onCreateSection) return;
        const title = query.trim();
        if (!title) return;
        const id = await onCreateSection(title);
        if (id) {
            onChange(id);
        }
        closeDropdown();
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return;
        const title = query.trim();
        if (!title) return;

        const firstMatch = filtered[0];
        if (firstMatch) {
            event.preventDefault();
            onChange(firstMatch.id);
            closeDropdown();
            return;
        }

        if (!hasExactMatch && onCreateSection) {
            event.preventDefault();
            void handleCreate();
        }
    };

    return (
        <div ref={containerRef} className={cn('relative', className)}>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        closeDropdown();
                    }
                }}
                aria-label={ariaLabel}
                className={cn('w-full flex items-center justify-between text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground', controlClassName)}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className={cn('truncate', !selected && 'text-muted-foreground/70')}>{selected?.title ?? placeholder}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
            {open && (
                <div
                    ref={dropdownRef}
                    className={cn('absolute z-20 w-full rounded-md border border-border bg-popover shadow-lg p-1 text-xs', dropdownClassName)}
                    onKeyDown={handleDropdownKeyDown}
                >
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        placeholder={searchPlaceholder}
                        aria-label={searchPlaceholder}
                        className="w-full mb-1 rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                    />
                    <div role="listbox" aria-label={placeholder}>
                        <button
                            type="button"
                            data-selector-option="true"
                            data-selector-option-kind="none"
                            role="option"
                            aria-selected={value === ''}
                            onClick={() => {
                                onChange('');
                                closeDropdown();
                            }}
                            className={cn(
                                'w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none',
                                value === '' && 'bg-muted/70'
                            )}
                        >
                            {noSectionLabel}
                        </button>
                        {!hasExactMatch && query.trim() && onCreateSection && (
                            <button
                                type="button"
                                data-selector-option="true"
                                data-selector-option-kind="create"
                                role="option"
                                aria-selected={false}
                                onClick={handleCreate}
                                className="w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none text-primary flex items-center gap-2"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                {createSectionLabel} &quot;{query.trim()}&quot;
                            </button>
                        )}
                        <div className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                            {filtered.map((section) => (
                                <button
                                    key={section.id}
                                    type="button"
                                    data-selector-option="true"
                                    data-selector-option-kind="item"
                                    role="option"
                                    aria-selected={section.id === value}
                                    onClick={() => {
                                        onChange(section.id);
                                        closeDropdown();
                                    }}
                                    className={cn(
                                        'w-full text-left px-2 py-1 rounded hover:bg-muted/50 focus:bg-muted/50 focus:outline-none',
                                        section.id === value && 'bg-muted/70'
                                    )}
                                >
                                    {section.title}
                                </button>
                            ))}
                            {filtered.length === 0 && (
                                <div className="px-2 py-1 text-muted-foreground">{noMatchesLabel}</div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
