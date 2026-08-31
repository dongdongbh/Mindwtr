import type { ReactNode } from 'react';
import { ArrowUpDown } from 'lucide-react';
import { resolveFeatureFlags, tFallback, useTaskStore, type TaskSortBy } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { DONE_SORT_OPTIONS, SORT_OPTIONS } from '../../../lib/task-list-sort';
import { ToolbarSelect } from './ToolbarSelect';

// One toolbar style for every list view. Focus, Review, Contexts and the status
// lists all render the same row of controls, and each kept its own copy until
// they drifted apart in height, radius and labelling (#861).
export const TOOLBAR_CONTROL_BASE = 'h-9 text-xs border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40';
export const TOOLBAR_CONTROL_MUTED = 'bg-card text-muted-foreground border-border hover:bg-muted/70 hover:text-foreground';
export const TOOLBAR_CONTROL_ACTIVE = 'bg-primary/10 text-primary border-primary';

// Same story for the search box each view puts above its list: Archive and
// Trash had grown a card-and-shadow variant of their own, so the app showed
// three different search fields depending on where you were (#959). Views that
// need an icon or a clear button add padding on top of this, nothing else.
export const VIEW_FILTER_INPUT = 'w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';

// The gap every list leaves below its last row. It belongs to the SCROLLED
// CONTENT — on a scroll viewport or a wrapper around one it becomes a dead band
// the list can never reach, which is how half the views ended short of the
// window edge while the other half ran straight into it (#977). Sites that add
// it also carry `data-list-end` so the tripwire tests can find it.
export const LIST_END_GAP = 'pb-4';

export { DONE_SORT_OPTIONS, SORT_OPTIONS };

type ToolbarButtonProps = {
    active?: boolean;
    children: ReactNode;
    icon?: ReactNode;
    onClick: () => void;
    title?: string;
    'aria-controls'?: string;
    'aria-expanded'?: boolean;
    'aria-pressed'?: boolean;
    'data-task-selection-toggle'?: boolean;
};

/** A toggle in a list toolbar: same height and radius as the selects beside it. */
export function ToolbarButton({ active = false, children, icon, onClick, title, ...aria }: ToolbarButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            {...aria}
            className={cn(
                TOOLBAR_CONTROL_BASE,
                'inline-flex items-center gap-1.5 rounded-lg px-3',
                active ? TOOLBAR_CONTROL_ACTIVE : TOOLBAR_CONTROL_MUTED,
            )}
        >
            {icon}
            {children}
        </button>
    );
}

type SortBySelectProps = {
    value: TaskSortBy;
    onChange: (value: TaskSortBy) => void;
    t: (key: string) => string;
    className?: string;
    iconTestId?: string;
    /** Defaults to SORT_OPTIONS; the Done list passes DONE_SORT_OPTIONS. */
    options?: readonly TaskSortBy[];
};

/** The labelled SORT select shared by every list toolbar. */
export function SortBySelect({ value, onChange, t, className, iconTestId, options }: SortBySelectProps) {
    const sortLabel = tFallback(t, 'sort.label', 'Sort');
    // Gated here rather than at each toolbar: Focus, Review, Contexts, Archive
    // and the project workspace all render this select, and a new one must not
    // be able to leak a disabled feature's sort. Callers pass the resolved sort
    // ('timeEstimate' reads as 'default' while the feature is off), so dropping
    // the option can never leave the trigger blank (#1107).
    const timeEstimatesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).timeEstimates);
    const sortOptions = (options ?? SORT_OPTIONS).filter(
        (option) => option !== 'timeEstimate' || timeEstimatesEnabled
    );
    return (
        <ToolbarSelect
            className={cn('min-w-[160px]', className)}
            label={sortLabel}
            icon={(
                <ArrowUpDown
                    className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                    data-testid={iconTestId}
                />
            )}
            value={value}
            options={sortOptions.map((option) => ({ value: option, label: t(`sort.${option}`) }))}
            onChange={(next) => onChange(next as TaskSortBy)}
        />
    );
}
