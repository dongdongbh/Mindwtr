import { CheckSquare, ChevronsUpDown, Download, Filter, List, SlidersHorizontal } from 'lucide-react';
import { tFallback, type TaskSortBy } from '@mindwtr/core';
import { FOCUS_AXES, type TaskListGroupBy } from './next-grouping';
import { GroupBySelect } from './GroupBySelect';
import { SortBySelect, ToolbarButton } from './list-toolbar';

type ListHeaderProps = {
    title: string;
    showNextCount: boolean;
    nextCount: number;
    taskCount: number;
    hasFilters: boolean;
    filterSummaryLabel: string;
    filterSummarySuffix: string;
    sortBy: TaskSortBy;
    sortByOptions?: readonly TaskSortBy[];
    onChangeSortBy: (value: TaskSortBy) => void;
    showGroupBy?: boolean;
    groupBy?: TaskListGroupBy;
    groupByOptions?: readonly TaskListGroupBy[];
    onChangeGroupBy?: (value: TaskListGroupBy) => void;
    showFiltersButton?: boolean;
    filtersOpen?: boolean;
    onToggleFilters?: () => void;
    selectionMode: boolean;
    onToggleSelection: () => void;
    showListDetails: boolean;
    onToggleDetails: () => void;
    densityMode: 'comfortable' | 'compact' | 'condensed';
    onToggleDensity: () => void;
    /** Exports what the list currently shows, filters and all (#1096). */
    onExportCsv?: () => void;
    t: (key: string) => string;
};

export function ListHeader({
    title,
    showNextCount,
    nextCount,
    taskCount,
    hasFilters,
    filterSummaryLabel,
    filterSummarySuffix,
    sortBy,
    sortByOptions,
    onChangeSortBy,
    showGroupBy = false,
    groupBy = 'none',
    groupByOptions = FOCUS_AXES,
    onChangeGroupBy,
    showFiltersButton = false,
    filtersOpen = false,
    onToggleFilters,
    selectionMode,
    onToggleSelection,
    showListDetails,
    onToggleDetails,
    densityMode,
    onToggleDensity,
    onExportCsv,
    t,
}: ListHeaderProps) {
    // The button names what clicking it does, not the current state — "Details off"
    // read as a disabled control rather than a way to show the dates and project.
    // A flipping name IS the state for a screen reader, so it carries no
    // aria-pressed: "Hide details, pressed" announced the action and the state at
    // once and they contradict each other.
    const detailsLabel = showListDetails
        ? tFallback(t, 'list.hideDetails', 'Hide details')
        : tFallback(t, 'list.showDetails', 'Show details');
    const exportCsvTitle = tFallback(t, 'list.exportCsvFiltered', 'Export current results as CSV');
    const densityTitle = (() => {
        const value = t('list.density');
        return value === 'list.density' ? 'Density' : value;
    })();
    const densityLabel = (() => {
        if (densityMode === 'condensed') {
            const value = t('list.densityCondensed');
            return value === 'list.densityCondensed' ? 'Condensed' : value;
        }
        if (densityMode === 'compact') {
            const value = t('list.densityCompact');
            return value === 'list.densityCompact' ? 'Compact' : value;
        }
        const value = t('list.densityComfortable');
        return value === 'list.densityComfortable' ? 'Comfortable' : value;
    })();

    return (
        <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            {/* No min-w-0: this column shares a flex row with the toolbar, and a
                zero floor let the toolbar squeeze the title below its own longest
                word — first clipping it, then (once it wrapped) breaking it
                mid-word as "Aguardand / o". Its automatic min-content floor keeps
                any single translated word intact and makes the toolbar yield
                instead, which it can do because it wraps (#923). */}
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
                    {hasFilters && (
                        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary sm:max-w-[420px]">
                            <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{filterSummaryLabel}{filterSummarySuffix}</span>
                        </span>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
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
                <SortBySelect
                    options={sortByOptions}
                    value={sortBy}
                    onChange={onChangeSortBy}
                    t={t}
                    iconTestId="list-sort-icon"
                />
                {showGroupBy && onChangeGroupBy && (
                    <GroupBySelect
                        value={groupBy}
                        axes={groupByOptions}
                        onChange={onChangeGroupBy}
                        t={t}
                    />
                )}
                <ToolbarButton
                    active={showListDetails}
                    onClick={onToggleDetails}
                    title={detailsLabel}
                    icon={<List className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                    {detailsLabel}
                </ToolbarButton>
                <ToolbarButton
                    active={densityMode !== 'comfortable'}
                    onClick={onToggleDensity}
                    aria-pressed={densityMode !== 'comfortable'}
                    title={densityTitle}
                    icon={<ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />}
                >
                    {densityLabel}
                </ToolbarButton>
                {onExportCsv && (
                    <ToolbarButton
                        onClick={onExportCsv}
                        title={exportCsvTitle}
                        icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                        {tFallback(t, 'list.exportCsv', 'Export CSV')}
                    </ToolbarButton>
                )}
            </div>
        </header>
    );
}
