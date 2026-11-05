import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Area, AreaFilterSelection } from '@mindwtr/core';
import { Check, ChevronDown, Layers, X } from 'lucide-react';

import {
    AREA_FILTER_NONE,
    cycleAreaFilterSelection,
    isAreaFilterSelectionActive,
} from '@mindwtr/core';
import { cn } from '../../lib/utils';
import { useDropdownPosition } from './use-dropdown-position';

interface SidebarAreaFilterProps {
    areas: Area[];
    selection: AreaFilterSelection;
    onChange: (selection: AreaFilterSelection) => void;
    ariaLabel: string;
    allAreasLabel: string;
    noAreaLabel: string;
    excludedLabel: string;
    collapsed?: boolean;
}

export function SidebarAreaFilter({
    areas,
    selection,
    onChange,
    ariaLabel,
    allAreasLabel,
    noAreaLabel,
    excludedLabel,
    collapsed = false,
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
        ...areas.map((area) => ({ id: area.id, label: area.name })),
        { id: AREA_FILTER_NONE, label: noAreaLabel },
    ]), [areas, noAreaLabel]);

    const isActive = isAreaFilterSelectionActive(selection);
    const activeCount = selection.included.length + selection.excluded.length;


    const labelFor = (id: string) => options.find((option) => option.id === id)?.label ?? noAreaLabel;
    const selectedLabel = !isActive
        ? allAreasLabel
        : [
            selection.included.map(labelFor).join(', '),
            selection.excluded.length > 0 ? `${excludedLabel}: ${selection.excluded.map(labelFor).join(', ')}` : '',
        ].filter(Boolean).join(' · ');
    const triggerLabel = collapsed ? `${ariaLabel}: ${selectedLabel}` : ariaLabel;

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
                className={cn(
                    'flex items-center text-[13px] bg-muted/40 border-none rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
                    collapsed
                        ? 'h-10 w-10 justify-center hover:bg-accent hover:text-accent-foreground'
                        : 'h-9 w-full justify-between px-3',
                )}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={triggerLabel}
                title={triggerLabel}
            >
                {collapsed ? (
                    <span className="relative">
                        <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {isActive && (
                            <span className="absolute -right-1.5 -top-1.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                        )}
                    </span>
                ) : (
                    <>
                        <span className="truncate">{selectedLabel}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                            {activeCount > 1 && (
                                <span className="rounded-full bg-primary px-1.5 text-[11px] leading-4 text-primary-foreground">
                                    {activeCount}
                                </span>
                            )}
                            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                        </span>
                    </>
                )}
            </button>
            {open && (
                <div
                    ref={dropdownRef}
                    className={cn(
                        'absolute z-20 rounded-lg border border-border bg-popover p-1 shadow-lg',
                        collapsed ? 'bottom-0 left-full ml-2 w-52' : 'w-full',
                        !collapsed && dropdownClassName,
                    )}
                    onKeyDown={handleKeyDown}
                >
                    <div role="group" aria-label={ariaLabel} className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                        <button
                            type="button"
                            data-area-filter-option="true"
                            onClick={() => onChange({ included: [], excluded: [] })}
                            aria-pressed={!isActive}
                            className={cn(
                                'w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50',
                                !isActive && 'bg-muted/70',
                            )}
                        >
                            <span className="truncate">{allAreasLabel}</span>
                            <Check className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'opacity-0' : 'opacity-100')} />
                        </button>
                        {options.map((option) => {
                            const isIncluded = selection.included.includes(option.id);
                            const isExcluded = selection.excluded.includes(option.id);
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    data-area-filter-option="true"
                                    onClick={() => onChange(cycleAreaFilterSelection(selection, option.id))}

                                    aria-pressed={isExcluded ? 'mixed' : isIncluded}
                                    aria-label={isExcluded ? `${option.label} (${excludedLabel})` : undefined}
                                    className={cn(
                                        'w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50',
                                        isExcluded
                                            ? 'border border-destructive bg-destructive/10 text-destructive line-through'
                                            : isIncluded
                                                ? 'bg-muted/70 text-foreground'
                                                : 'text-foreground',
                                    )}
                                >
                                    <span className="truncate">{option.label}</span>
                                    {isExcluded
                                        ? <X className="h-3.5 w-3.5 shrink-0" />
                                        : <Check className={cn('h-3.5 w-3.5 shrink-0', isIncluded ? 'opacity-100' : 'opacity-0')} />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
