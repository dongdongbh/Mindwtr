import type { ReactNode } from 'react';
import { ArrowUpDown } from 'lucide-react';
import {
    DONE_TASK_LIST_SORT_OPTIONS,
    TASK_LIST_SORT_OPTIONS,
    resolveFeatureFlags,
    tFallback,
    useTaskStore,
    type SortField,
    type TaskSortBy,
} from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { ToolbarSelect } from './ToolbarSelect';


export const TOOLBAR_CONTROL_BASE = 'h-9 text-xs border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40';
export const TOOLBAR_CONTROL_MUTED = 'bg-card text-muted-foreground border-border hover:bg-muted/70 hover:text-foreground';
export const TOOLBAR_CONTROL_ACTIVE = 'bg-primary/10 text-primary border-primary';


export const VIEW_FILTER_INPUT = 'w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30';


export const LIST_END_GAP = 'pb-4';

export { DONE_TASK_LIST_SORT_OPTIONS, TASK_LIST_SORT_OPTIONS };

type ToolbarButtonProps = {
    active?: boolean;
    children: ReactNode;
    disabled?: boolean;
    icon?: ReactNode;
    onClick: () => void;
    title?: string;
    'aria-controls'?: string;
    'aria-expanded'?: boolean;
    'aria-pressed'?: boolean;
    'data-task-selection-toggle'?: boolean;
};


export function ToolbarButton({ active = false, children, disabled = false, icon, onClick, title, ...aria }: ToolbarButtonProps) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            title={title}
            {...aria}
            className={cn(
                TOOLBAR_CONTROL_BASE,
                'inline-flex items-center gap-1.5 rounded-lg px-3',
                active ? TOOLBAR_CONTROL_ACTIVE : TOOLBAR_CONTROL_MUTED,
                'disabled:cursor-not-allowed disabled:opacity-50',
            )}
        >
            {icon}
            {children}
        </button>
    );
}

type SortBySelectProps<Sort extends SortField> = {
    value: Sort;
    defaultValue?: Sort;
    onChange: (value: Sort) => void;
    t: (key: string) => string;
    className?: string;
    iconTestId?: string;

    options?: readonly Sort[];

    inheritOption?: { label: string; selected: boolean; onSelect: () => void };
};

const INHERIT_SORT_VALUE = '__inherit';


export function SortBySelect<Sort extends SortField = TaskSortBy>({ value, defaultValue, onChange, t, className, iconTestId, options, inheritOption }: SortBySelectProps<Sort>) {
    const sortLabel = tFallback(t, 'sort.label', 'Sort');


    const { timeEstimatesEnabled, prioritiesEnabled } = useTaskStore((state) => {
        const flags = resolveFeatureFlags(state.settings);
        return { timeEstimatesEnabled: flags.timeEstimates, prioritiesEnabled: flags.priorities };
    });
    const sortOptions = (options ?? TASK_LIST_SORT_OPTIONS).filter(
        (option) => (option !== 'timeEstimate' || timeEstimatesEnabled)
            && (option !== 'priority' || prioritiesEnabled)
    );
    return (
        <ToolbarSelect
            active={defaultValue !== undefined && value !== defaultValue}
            className={cn('w-[160px] min-w-0 max-w-full', className)}
            label={sortLabel}
            icon={(
                <ArrowUpDown
                    className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                    data-testid={iconTestId}
                />
            )}
            value={inheritOption?.selected ? INHERIT_SORT_VALUE : value}
            options={[
                ...(inheritOption ? [{ value: INHERIT_SORT_VALUE, label: inheritOption.label }] : []),
                ...sortOptions.map((option) => ({
                    value: option,
                    label: option === 'priority' ? t('filters.priority') : t(`sort.${option}`),
                })),
            ]}
            onChange={(next) => (next === INHERIT_SORT_VALUE ? inheritOption?.onSelect() : onChange(next as Sort))}
        />
    );
}
