import { CheckSquare, ChevronsDown, ChevronsUp, Filter, List } from 'lucide-react';
import { DEFAULT_FOCUS_SORT_BY, FOCUS_SORT_OPTIONS, tFallback, type SortField } from '@mindwtr/core';

import { ToolbarButton } from '../list/list-toolbar';
import { ViewControls } from '../list/ViewControls';
import { FOCUS_AXES, type NextGroupBy } from '../list/next-grouping';

type AgendaHeaderProps = {
    selectionMode: boolean;
    onToggleSelection: () => void;
    filterCount: number;
    filtersOpen: boolean;
    nextActionsCount: number;
    nextGroupBy: NextGroupBy;
    focusSortBy: SortField;
    canToggleOtherSections: boolean;
    collapseOtherSections: boolean;
    onChangeGroupBy: (value: NextGroupBy) => void;
    onChangeSortBy: (value: SortField) => void;
    onToggleFilters: () => void;
    onToggleDetails: () => void;
    onToggleOtherSections: () => void;
    resolveText: (key: string, fallback: string) => string;
    showListDetails: boolean;
    t: (key: string) => string;
};

export function AgendaHeader({
    selectionMode,
    onToggleSelection,
    filterCount,
    filtersOpen,
    nextActionsCount,
    nextGroupBy,
    focusSortBy,
    canToggleOtherSections,
    collapseOtherSections,
    onChangeGroupBy,
    onChangeSortBy,
    onToggleFilters,
    onToggleDetails,
    onToggleOtherSections,
    resolveText,
    showListDetails,
    t,
}: AgendaHeaderProps) {
    const filtersActive = filtersOpen || filterCount > 0;
    const filtersLabel = resolveText('filters.label', 'Filters');
    const detailsLabel = showListDetails
        ? tFallback(t, 'list.hideDetails', 'Hide details')
        : tFallback(t, 'list.showDetails', 'Show details');
    const otherSectionsLabel = collapseOtherSections
        ? tFallback(t, 'agenda.collapseOtherSections', 'Focus only')
        : tFallback(t, 'agenda.expandOtherSections', 'Expand sections');

    return (
        <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">
                    {t('agenda.title')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    {nextActionsCount} {tFallback(t, 'list.next', t('agenda.nextActions'))}
                </p>
            </div>
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                <ToolbarButton
                    onClick={onToggleOtherSections}
                    disabled={!canToggleOtherSections}
                    title={otherSectionsLabel}
                    icon={collapseOtherSections
                        ? <ChevronsUp className="h-3.5 w-3.5" aria-hidden="true" />
                        : <ChevronsDown className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                    {otherSectionsLabel}
                </ToolbarButton>
                <ToolbarButton
                    active={filtersActive}
                    onClick={onToggleFilters}
                    aria-expanded={filtersOpen}
                    aria-controls="agenda-filters-panel"
                    aria-pressed={filtersActive}
                    title={filtersLabel}
                    icon={<Filter className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                    <span>{filtersLabel}</span>
                    {filterCount > 0 && (
                        <span className="ml-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
                            {filterCount}
                        </span>
                    )}
                </ToolbarButton>
                <ViewControls
                    sortBy={focusSortBy}
                    defaultSortBy={DEFAULT_FOCUS_SORT_BY}
                    sortByOptions={FOCUS_SORT_OPTIONS}
                    onChangeSortBy={onChangeSortBy}
                    groupBy={nextGroupBy}
                    defaultGroupBy="none"
                    groupByOptions={FOCUS_AXES}
                    onChangeGroupBy={onChangeGroupBy}
                    t={t}
                />
                <ToolbarButton
                    active={showListDetails}
                    onClick={onToggleDetails}
                    title={detailsLabel}
                    icon={<List className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                    {detailsLabel}
                </ToolbarButton>
                <ToolbarButton
                    active={selectionMode}
                    data-task-selection-toggle
                    onClick={onToggleSelection}
                    aria-pressed={selectionMode}
                    icon={<CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                    {t(selectionMode ? 'bulk.exitSelect' : 'bulk.select')}
                </ToolbarButton>
            </div>
        </header>
    );
}
