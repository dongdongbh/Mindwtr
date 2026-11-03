import { ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { VIEW_FILTER_INPUT } from './list-toolbar';

export type DesktopActiveFilterChip = {
    id: string;
    label: string;
    dotColor?: string;
    isAdvanced?: boolean;
    excluded?: boolean;

    inactive?: boolean;
    onRemove?: () => void;
};

type ActiveFilterChipsProps = {
    chips: DesktopActiveFilterChip[];
    excludedLabel: string;
    removeLabel: string;
};

export function ActiveFilterChips({ chips, excludedLabel, removeLabel }: ActiveFilterChipsProps) {
    if (chips.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2" aria-live="polite">
            {chips.map((chip) => (
                <span
                    key={chip.id}
                    className={cn(
                        'inline-flex min-h-8 max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium',
                        chip.excluded
                            ? 'border border-destructive bg-destructive/10 text-destructive line-through'
                            : chip.isAdvanced
                                ? 'border border-dashed border-primary/50 bg-muted/40 text-primary'
                                : 'bg-muted text-muted-foreground',
                        chip.inactive && 'opacity-60',
                    )}
                >
                    {chip.dotColor && (
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: chip.dotColor }}
                            aria-hidden="true"
                        />
                    )}
                    {chip.excluded && <span className="sr-only">{excludedLabel}: </span>}
                    <span className="min-w-0 break-words">{chip.label}</span>
                    {chip.onRemove && (
                        <button
                            type="button"
                            onClick={chip.onRemove}
                            aria-label={`${removeLabel}: ${chip.label}`}
                            className="-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-current transition-colors hover:bg-background/80 focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                    )}
                </span>
            ))}
        </div>
    );
}

type FilterCategoryProps = {
    children: ReactNode;
    expanded: boolean;
    id: string;
    label: string;
    onToggle: () => void;
    summary: string;
};

export function FilterCategory({ children, expanded, id, label, onToggle, summary }: FilterCategoryProps) {
    const contentId = `${id}-content`;
    const summaryId = `${id}-summary`;
    return (
        <section className="border-b border-border/60 last:border-b-0">
            <button
                type="button"
                aria-label={label}
                aria-describedby={summaryId}
                aria-controls={contentId}
                aria-expanded={expanded}
                onClick={onToggle}
                className="flex min-h-11 w-full items-center gap-3 rounded-md px-1 text-left transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
                <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</span>
                <span id={summaryId} className="max-w-[55%] truncate text-xs text-muted-foreground">{summary}</span>
                <ChevronDown
                    className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
                    aria-hidden="true"
                />
            </button>
            {expanded && (
                <div id={contentId} className="space-y-3 px-1 pb-3 pt-1">
                    {children}
                </div>
            )}
        </section>
    );
}

type FilterOptionSearchProps = {
    id: string;
    label: string;
    onChange: (value: string) => void;
    value: string;
};

export function FilterOptionSearch({ id, label, onChange, value }: FilterOptionSearchProps) {
    return (
        <div>
            <label htmlFor={id} className="sr-only">{label}</label>
            <input
                id={id}
                type="search"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={label}
                className={VIEW_FILTER_INPUT}
            />
        </div>
    );
}

type MatchModeControlProps = {
    allLabel: string;
    anyLabel: string;
    label: string;
    mode: 'any' | 'all';
    onChange: (mode: 'any' | 'all') => void;
};

export function MatchModeControl({ allLabel, anyLabel, label, mode, onChange }: MatchModeControlProps) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div role="group" aria-label={label} className="inline-flex rounded-full border border-border bg-muted/50 p-0.5">
                {(['any', 'all'] as const).map((option) => (
                    <button
                        key={option}
                        type="button"
                        onClick={() => onChange(option)}
                        aria-pressed={mode === option}
                        className={cn(
                            'rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                            mode === option
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {option === 'any' ? anyLabel : allLabel}
                    </button>
                ))}
            </div>
        </div>
    );
}

export const FILTER_OPTION_BASE = 'rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40';

export function summarizeFilterValues(values: string[], allLabel: string): string {
    if (values.length === 0) return allLabel;
    if (values.length <= 2) return values.join(', ');
    return `${values.slice(0, 2).join(', ')} +${values.length - 2}`;
}

export function matchesFilterOption(label: string, query: string): boolean {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery.length === 0 || label.toLocaleLowerCase().includes(normalizedQuery);
}
