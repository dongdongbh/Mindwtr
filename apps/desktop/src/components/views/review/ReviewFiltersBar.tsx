import type { TaskStatus } from '@mindwtr/core';
import { cn } from '../../../lib/utils';

type ReviewFiltersBarProps = {
    filterStatus: TaskStatus | 'all';
    statusOptions: TaskStatus[];
    statusCounts: Record<string, number>;
    onSelect: (status: TaskStatus | 'all') => void;
    t: (key: string) => string;
};

export function ReviewFiltersBar({
    filterStatus,
    statusOptions,
    statusCounts,
    onSelect,
    t,
}: ReviewFiltersBarProps) {
    const renderFilterButton = (
        status: TaskStatus | 'all',
        label: string,
        count: number,
    ) => {
        const isActive = filterStatus === status;
        const activeFilterStyle = isActive
            ? {
                backgroundColor: 'hsl(var(--primary))',
                borderColor: 'hsl(var(--primary))',
                color: 'hsl(var(--primary-foreground))',
            }
            : undefined;

        return (
            <button
                key={status}
                onClick={() => onSelect(status)}
                aria-label={`${label} (${count})`}
                style={activeFilterStyle}
                className={cn(
                    "inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-full border transition-colors whitespace-nowrap shrink-0",
                    isActive
                        ? "bg-primary border-primary"
                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                )}
            >
                <span>{label}</span>
                <span className={cn(
                    "tabular-nums",
                    !isActive && "text-muted-foreground"
                )}>
                    ({count})
                </span>
            </button>
        );
    };

    return (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {renderFilterButton('all', t('common.all'), statusCounts.all)}
            {statusOptions.map((status) => (
                renderFilterButton(status, t(`status.${status}`), statusCounts[status])
            ))}
        </div>
    );
}
