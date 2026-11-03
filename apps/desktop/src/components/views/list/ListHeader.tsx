import { useEffect, useRef, useState } from 'react';
import { CheckSquare, Filter, List, MoreHorizontal, Plus, SlidersHorizontal } from 'lucide-react';
import { tFallback, type TaskSortBy } from '@mindwtr/core';
import { FOCUS_AXES, type TaskListGroupBy } from './next-grouping';
import { ToolbarButton } from './list-toolbar';
import { ViewControls } from './ViewControls';
import { ViewHeaderActions } from './ViewHeaderActions';

type ListHeaderProps = {
    title: string;
    showNextCount: boolean;
    nextCount: number;
    taskCount: number;
    scopeLabel?: string;
    hasFilters: boolean;
    filterSummaryLabel: string;
    filterSummarySuffix: string;
    sortBy: TaskSortBy;
    defaultSortBy?: TaskSortBy;
    sortByOptions?: readonly TaskSortBy[];
    onChangeSortBy: (value: TaskSortBy) => void;
    showGroupBy?: boolean;
    groupBy?: TaskListGroupBy;
    defaultGroupBy?: TaskListGroupBy;
    groupByOptions?: readonly TaskListGroupBy[];
    onChangeGroupBy?: (value: TaskListGroupBy) => void;
    showFiltersButton?: boolean;
    filtersOpen?: boolean;
    onToggleFilters?: () => void;
    selectionMode: boolean;
    onToggleSelection: () => void;
    showDetailsToggle?: boolean;
    showListDetails: boolean;
    onToggleDetails: () => void;
    onNewSomedaySection?: () => void;
    t: (key: string) => string;
};

export function ListHeader({
    title,
    showNextCount,
    nextCount,
    taskCount,
    scopeLabel,
    hasFilters,
    filterSummaryLabel,
    filterSummarySuffix,
    sortBy,
    defaultSortBy = 'default',
    sortByOptions,
    onChangeSortBy,
    showGroupBy = false,
    groupBy = 'none',
    defaultGroupBy = 'none',
    groupByOptions = FOCUS_AXES,
    onChangeGroupBy,
    showFiltersButton = false,
    filtersOpen = false,
    onToggleFilters,
    selectionMode,
    onToggleSelection,
    showDetailsToggle = true,
    showListDetails,
    onToggleDetails,
    onNewSomedaySection,
    t,
}: ListHeaderProps) {
    const [overflowOpen, setOverflowOpen] = useState(false);
    const overflowRef = useRef<HTMLDivElement | null>(null);
    const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    const detailsLabel = showListDetails
        ? tFallback(t, 'list.hideDetails', 'Hide details')
        : tFallback(t, 'list.showDetails', 'Show details');

    useEffect(() => {
        if (!overflowOpen) return;
        const handleMouseDown = (event: MouseEvent) => {
            if (!overflowRef.current?.contains(event.target as Node)) setOverflowOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setOverflowOpen(false);
            overflowTriggerRef.current?.focus();
        };
        window.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [overflowOpen]);

    return (
        <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            {


                                                                    }
            <div className="space-y-1">
                <h2 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    {title}
                    {showNextCount && (
                        <span className="ml-2 align-baseline text-base font-medium text-muted-foreground sm:text-lg">
                            ({nextCount})
                        </span>
                    )}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                    <span>{taskCount} {t('common.tasks')}</span>
                    {scopeLabel && (
                        <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium">
                            {scopeLabel}
                        </span>
                    )}
                    {hasFilters && (
                        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary sm:max-w-[420px]">
                            <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{filterSummaryLabel}{filterSummarySuffix}</span>
                        </span>
                    )}
                </div>
            </div>

            <ViewHeaderActions>
                <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                    {showFiltersButton && onToggleFilters && (
                        <ToolbarButton
                            active={filtersOpen}
                            onClick={onToggleFilters}
                            aria-expanded={filtersOpen}
                            aria-controls="list-filters-panel"
                            icon={<Filter className="h-3.5 w-3.5" aria-hidden="true" />}
                        >
                            {t('filters.label')}
                        </ToolbarButton>
                    )}
                    <ToolbarButton
                        active={selectionMode}
                        onClick={onToggleSelection}
                        aria-pressed={selectionMode}
                        icon={<CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                        {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                    </ToolbarButton>
                    <ViewControls
                        sortBy={sortBy}
                        defaultSortBy={defaultSortBy}
                        sortByOptions={sortByOptions}
                        onChangeSortBy={onChangeSortBy}
                        groupBy={showGroupBy && onChangeGroupBy ? groupBy : undefined}
                        defaultGroupBy={showGroupBy && onChangeGroupBy ? defaultGroupBy : undefined}
                        groupByOptions={showGroupBy && onChangeGroupBy ? groupByOptions : undefined}
                        onChangeGroupBy={onChangeGroupBy}
                        t={t}
                    />
                    {showDetailsToggle && (
                        <ToolbarButton
                            active={showListDetails}
                            onClick={onToggleDetails}
                            title={detailsLabel}
                            icon={<List className="h-3.5 w-3.5" aria-hidden="true" />}
                        >
                            {detailsLabel}
                        </ToolbarButton>
                    )}
                    {onNewSomedaySection && (
                        <div ref={overflowRef} className="relative">
                            <button
                                ref={overflowTriggerRef}
                                type="button"
                                aria-label={moreOptionsLabel}
                                aria-haspopup="menu"
                                aria-expanded={overflowOpen}
                                onClick={() => setOverflowOpen((open) => !open)}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                            </button>
                            {overflowOpen && (
                                <div role="menu" aria-label={moreOptionsLabel} className="absolute right-0 top-full z-50 mt-2 w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setOverflowOpen(false);
                                            onNewSomedaySection();
                                        }}
                                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:outline-none focus:bg-muted"
                                    >
                                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                        {tFallback(t, 'viewSections.add', 'New section…')}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </ViewHeaderActions>
        </header>
    );
}
