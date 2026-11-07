import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Area, AreaFilterSelection } from '@mindwtr/core';
import { Layers } from 'lucide-react';

import {
    AREA_FILTER_NONE,
    excludeAllAreas,
    isAreaFilterSelectionActive,
    isAreaVisibleInSelection,
    toggleAreaVisibility,
} from '@mindwtr/core';
import { cn } from '../../lib/utils';

interface SidebarAreaChipsProps {
    areas: Area[];
    selection: AreaFilterSelection;
    onChange: (selection: AreaFilterSelection) => void;
    ariaLabel: string;
    allAreasLabel: string;
    noAreaLabel: string;
    excludedLabel: string;
    selectAllLabel: string;
    excludeAllLabel: string;
    collapsed?: boolean;
}

interface ChipOption {
    id: string;
    label: string;
    color?: string;
}

export function SidebarAreaChips({
    areas,
    selection,
    onChange,
    ariaLabel,
    allAreasLabel,
    noAreaLabel,
    excludedLabel,
    selectAllLabel,
    excludeAllLabel,
    collapsed = false,
}: SidebarAreaChipsProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const options = useMemo<ChipOption[]>(() => ([
        ...areas.map((area) => ({ id: area.id, label: area.name, color: area.color })),
        { id: AREA_FILTER_NONE, label: noAreaLabel },
    ]), [areas, noAreaLabel]);
    const optionIds = useMemo(() => options.map((option) => option.id), [options]);

    const isActive = isAreaFilterSelectionActive(selection);
    const visibleIds = optionIds.filter((id) => isAreaVisibleInSelection(selection, id));

    const labelFor = (id: string) => options.find((option) => option.id === id)?.label ?? noAreaLabel;
    const summary = !isActive
        ? allAreasLabel
        : [
            selection.included.map(labelFor).join(', '),
            selection.excluded.length > 0 ? `${excludedLabel}: ${selection.excluded.map(labelFor).join(', ')}` : '',
        ].filter(Boolean).join(' · ');
    const triggerLabel = `${ariaLabel}: ${summary}`;

    useEffect(() => {
        if (!open) return;
        const handleMouseDown = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [open]);

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
    };

    const cloud = (
        <div role="group" aria-label={ariaLabel} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 px-1">
                <span className="truncate text-[11px] font-medium text-muted-foreground">{ariaLabel}</span>
                <span className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={() => onChange({ included: [], excluded: [] })}
                        disabled={!isActive}
                        className="text-[11px] text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    >
                        {selectAllLabel}
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange(excludeAllAreas(optionIds))}
                        disabled={visibleIds.length === 0}
                        className="text-[11px] text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    >
                        {excludeAllLabel}
                    </button>
                </span>
            </div>
            <div className="flex max-h-[12rem] flex-wrap gap-1 overflow-y-auto">
                {options.map((option) => {
                    const visible = visibleIds.includes(option.id);
                    return (
                        <button
                            key={option.id}
                            type="button"
                            aria-pressed={visible}
                            title={option.label}
                            onClick={() => onChange(toggleAreaVisibility(selection, option.id, optionIds))}
                            className={cn(
                                'inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                                visible
                                    ? 'border-border bg-muted/70 text-foreground'
                                    : 'border-transparent text-muted-foreground hover:bg-muted/40',
                            )}
                        >
                            <span
                                aria-hidden="true"
                                className={cn('h-2 w-2 shrink-0 rounded-full', !option.color && 'bg-muted-foreground', !visible && 'opacity-40')}
                                style={option.color ? { backgroundColor: option.color } : undefined}
                            />
                            <span className="truncate">{option.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );

    if (!collapsed) return cloud;

    return (
        <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/40 text-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={triggerLabel}
                title={triggerLabel}
            >
                <span className="relative">
                    <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {isActive && (
                        <span className="absolute -right-1.5 -top-1.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                    )}
                </span>
            </button>
            {open && (
                <div className="absolute bottom-0 left-full z-20 ml-2 w-56 rounded-lg border border-border bg-popover p-2 shadow-lg">
                    {cloud}
                </div>
            )}
        </div>
    );
}
