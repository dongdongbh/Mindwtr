import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Area } from '@mindwtr/core';
import { Check, ChevronDown } from 'lucide-react';

import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '../../lib/area-filter';
import { cn } from '../../lib/utils';
import { useDropdownPosition } from './use-dropdown-position';

interface SidebarAreaFilterProps {
    areas: Area[];
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    allAreasLabel: string;
    noAreaLabel: string;
}

export function SidebarAreaFilter({
    areas,
    value,
    onChange,
    ariaLabel,
    allAreasLabel,
    noAreaLabel,
}: SidebarAreaFilterProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const { dropdownClassName, listMaxHeight } = useDropdownPosition({
        open,
        containerRef,
        dropdownRef,
    });

    const options = useMemo(() => ([
        { id: AREA_FILTER_ALL, label: allAreasLabel },
        ...areas.map((area) => ({ id: area.id, label: area.name })),
        { id: AREA_FILTER_NONE, label: noAreaLabel },
    ]), [allAreasLabel, areas, noAreaLabel]);

    const selectedLabel = options.find((option) => option.id === value)?.label ?? allAreasLabel;

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

    const closeDropdown = () => setOpen(false);

    const focusSelectableOption = (direction: 1 | -1) => {
        const items = dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-area-filter-option="true"]');
        if (!items || items.length === 0) return;
        const list = Array.from(items);
        const active = document.activeElement as HTMLElement | null;
        let index = list.findIndex((item) => item === active);
        if (index < 0) {
            index = direction > 0 ? -1 : 0;
        }
        const nextIndex = (index + direction + list.length) % list.length;
        list[nextIndex].focus();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        closeDropdown();
                    }
                }}
                className="w-full flex items-center justify-between text-[13px] bg-muted/40 border-none rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel}
            >
                <span className="truncate">{selectedLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
            {open && (
                <div
                    ref={dropdownRef}
                    className={cn(
                        'absolute z-20 w-full rounded-lg border border-border bg-popover p-1 shadow-lg',
                        dropdownClassName,
                    )}
                    onKeyDown={handleKeyDown}
                >
                    <div role="listbox" aria-label={ariaLabel} className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                        {options.map((option) => {
                            const selected = option.id === value;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    data-area-filter-option="true"
                                    role="option"
                                    aria-selected={selected}
                                    onClick={() => {
                                        onChange(option.id);
                                        closeDropdown();
                                    }}
                                    className={cn(
                                        'w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50',
                                        selected && 'bg-muted/70',
                                    )}
                                >
                                    <span className="truncate">{option.label}</span>
                                    <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
