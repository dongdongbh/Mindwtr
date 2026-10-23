import { TaskDateFilter } from './TaskDateFilter';
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Filter } from 'lucide-react';
import { tFallback } from '@mindwtr/core';
import type { DateRange, MultiValueFilterMatchMode, TaskPriority, TimeEstimate } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { PriorityFlag } from '../../Task/PriorityFlag';
import {
    ActiveFilterChips,
    FILTER_OPTION_BASE,
    FilterCategory,
    FilterOptionSearch,
    MatchModeControl,
    matchesFilterOption,
    summarizeFilterValues,
    type DesktopActiveFilterChip,
} from './FilterDisclosure';

type FilterCategoryId = 'dates' | 'tokens' | 'priority' | 'time';

interface ListFiltersPanelProps {
    t: (key: string) => string;
    activeFilterChips: DesktopActiveFilterChip[];
    hasFilters: boolean;
    showFiltersPanel: boolean;
    onClose: () => void;
    onClearFilters: () => void;
    anyDateRange?: DateRange;
    onAnyDateRangeChange?: (value: DateRange | undefined) => void;
    allTokens: string[];
    selectedTokens: string[];
    excludedTokens: string[];
    tokenCounts: Record<string, number>;
    onToggleToken: (token: string) => void;
    contextMatchMode: MultiValueFilterMatchMode;
    tagMatchMode: MultiValueFilterMatchMode;
    onContextMatchModeChange: (mode: MultiValueFilterMatchMode) => void;
    onTagMatchModeChange: (mode: MultiValueFilterMatchMode) => void;
    showPriorityFilters: boolean;
    priorityOptions: TaskPriority[];
    selectedPriorities: TaskPriority[];
    onTogglePriority: (priority: TaskPriority) => void;
    showTimeEstimateFilters: boolean;
    timeEstimateOptions: TimeEstimate[];
    selectedTimeEstimates: TimeEstimate[];
    onToggleEstimate: (estimate: TimeEstimate) => void;
    formatEstimate: (estimate: TimeEstimate) => string;
    showIncludeArchivedProjects?: boolean;
    includeArchivedProjects?: boolean;
    onToggleIncludeArchivedProjects?: () => void;
}

const focusFiltersTrigger = () => {
    window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('button[aria-controls="list-filters-panel"]')?.focus();
    });
};

export function ListFiltersPanel({
    t,
    activeFilterChips,
    hasFilters,
    showFiltersPanel,
    onClose,
    onClearFilters,
    anyDateRange,
    onAnyDateRangeChange,
    allTokens,
    selectedTokens,
    excludedTokens,
    tokenCounts,
    onToggleToken,
    contextMatchMode,
    tagMatchMode,
    onContextMatchModeChange,
    onTagMatchModeChange,
    showPriorityFilters,
    priorityOptions,
    selectedPriorities,
    onTogglePriority,
    showTimeEstimateFilters,
    timeEstimateOptions,
    selectedTimeEstimates,
    onToggleEstimate,
    formatEstimate,
    showIncludeArchivedProjects = false,
    includeArchivedProjects = false,
    onToggleIncludeArchivedProjects,
}: ListFiltersPanelProps) {
    const [expandedCategory, setExpandedCategory] = useState<FilterCategoryId | null>(null);
    const [tokenQuery, setTokenQuery] = useState('');
    const allLabel = tFallback(t, 'common.all', 'All');
    const noMatchesLabel = tFallback(t, 'common.noMatches', 'No matches');
    const excludedStateLabel = tFallback(t, 'filters.excluded', 'Excluded');
    const removeLabel = tFallback(t, 'filters.remove', 'Remove filter');
    const searchOptionsLabel = tFallback(t, 'filters.searchOptions', 'Search options');
    const tokenCycleHint = tFallback(
        t,
        'filters.tokenCycleHint',
        'Click to include, again to exclude, and once more to clear.',
    );
    const contextMatchLabel = tFallback(t, 'filters.contextMatchMode', 'Context match');
    const tagMatchLabel = tFallback(t, 'filters.tagMatchMode', 'Tag match');
    const anyLabel = tFallback(t, 'filters.matchAny', 'Any');

    const tokenOptions = useMemo(
        () => Array.from(new Set([...allTokens, ...selectedTokens, ...excludedTokens])),
        [allTokens, excludedTokens, selectedTokens],
    );
    const visibleTokens = useMemo(
        () => tokenOptions.filter((token) => matchesFilterOption(token, tokenQuery)),
        [tokenOptions, tokenQuery],
    );
    const selectedContextCount = selectedTokens.filter((token) => token.trim().startsWith('@')).length;
    const selectedTagCount = selectedTokens.filter((token) => token.trim().startsWith('#')).length;
    const tokenSummary = summarizeFilterValues([
        ...selectedTokens,
        ...excludedTokens.map((token) => `${excludedStateLabel}: ${token}`),
    ], allLabel);
    const prioritySummary = summarizeFilterValues(
        selectedPriorities.map((priority) => t(`priority.${priority}`)),
        allLabel,
    );
    const timeSummary = summarizeFilterValues(selectedTimeEstimates.map(formatEstimate), allLabel);

    const closePanel = () => {
        onClose();
        focusFiltersTrigger();
    };

    useEffect(() => {
        if (showFiltersPanel) return;
        setExpandedCategory(null);
        setTokenQuery('');
    }, [showFiltersPanel]);

    // Only Escape raised inside the panel folds it. A window listener also ate
    // the Escape that closed a dialog or cancelled an edit, and stole focus to
    // the Filters button one frame later.
    const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !showFiltersPanel) return;
        event.preventDefault();
        closePanel();
    };

    const toggleCategory = (category: FilterCategoryId) => {
        setExpandedCategory((current) => current === category ? null : category);
    };

    return (
        <div id="list-filters-panel" className="space-y-3 rounded-lg border border-border bg-card p-3" onKeyDown={handlePanelKeyDown}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Filter className="h-4 w-4" aria-hidden="true" />
                    {t('filters.label')}
                </div>
                <div className="flex items-center gap-2">
                    {hasFilters && (
                        <button
                            type="button"
                            onClick={onClearFilters}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {t('filters.clear')}
                        </button>
                    )}
                    {showFiltersPanel && (
                        <button
                            type="button"
                            onClick={closePanel}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {t('filters.hide')}
                        </button>
                    )}
                </div>
            </div>
            <ActiveFilterChips chips={activeFilterChips} excludedLabel={excludedStateLabel} removeLabel={removeLabel} />
            {showFiltersPanel && (
                <div className="space-y-2">
                    {showIncludeArchivedProjects && (
                        <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm text-foreground focus-within:ring-2 focus-within:ring-primary/40">
                            <input
                                type="checkbox"
                                checked={includeArchivedProjects}
                                onChange={onToggleIncludeArchivedProjects}
                                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                            />
                            <span>{t('reference.includeArchivedProjects')}</span>
                        </label>
                    )}
                    <div className="rounded-md border border-border/60 px-2">
                    {onAnyDateRangeChange && (
                        <TaskDateFilter id="list-date-filters" value={anyDateRange} onChange={onAnyDateRangeChange}
                            expanded={expandedCategory === 'dates'} onToggle={() => toggleCategory('dates')} t={t} />
                    )}
                        <FilterCategory
                            id="list-token-filters"
                            label={t('filters.contexts')}
                            summary={tokenSummary}
                            expanded={expandedCategory === 'tokens'}
                            onToggle={() => toggleCategory('tokens')}
                        >
                            <FilterOptionSearch id="list-token-option-search" label={searchOptionsLabel} value={tokenQuery} onChange={setTokenQuery} />
                            {selectedContextCount > 1 && (
                                <MatchModeControl
                                    label={contextMatchLabel}
                                    mode={contextMatchMode}
                                    anyLabel={anyLabel}
                                    allLabel={allLabel}
                                    onChange={onContextMatchModeChange}
                                />
                            )}
                            {selectedTagCount > 1 && (
                                <MatchModeControl
                                    label={tagMatchLabel}
                                    mode={tagMatchMode}
                                    anyLabel={anyLabel}
                                    allLabel={allLabel}
                                    onChange={onTagMatchModeChange}
                                />
                            )}
                            <p className="text-xs text-muted-foreground">{tokenCycleHint}</p>
                            {visibleTokens.length > 0 ? (
                                <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                                    {visibleTokens.map((token) => {
                                        const isIncluded = selectedTokens.includes(token);
                                        const isExcluded = excludedTokens.includes(token);
                                        return (
                                            <button
                                                key={token}
                                                type="button"
                                                onClick={() => onToggleToken(token)}
                                                aria-pressed={isExcluded ? 'mixed' : isIncluded}
                                                aria-label={isExcluded ? `${token} (${excludedStateLabel})` : undefined}
                                                className={cn(
                                                    FILTER_OPTION_BASE,
                                                    isExcluded
                                                        ? 'border border-destructive bg-destructive/10 text-destructive line-through'
                                                        : isIncluded
                                                            ? 'bg-primary text-primary-foreground'
                                                            : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                                )}
                                            >
                                                {token}
                                                {tokenCounts[token] > 0 && <span className="ml-1 opacity-70">({tokenCounts[token]})</span>}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">{noMatchesLabel}</p>
                            )}
                        </FilterCategory>

                        {(showPriorityFilters || selectedPriorities.length > 0) && (
                            <FilterCategory
                                id="list-priority-filters"
                                label={t('filters.priority')}
                                summary={prioritySummary}
                                expanded={expandedCategory === 'priority'}
                                onToggle={() => toggleCategory('priority')}
                            >
                                <div className="flex flex-wrap gap-2">
                                    {priorityOptions.map((priority) => {
                                        const isActive = selectedPriorities.includes(priority);
                                        return (
                                            <button
                                                key={priority}
                                                type="button"
                                                onClick={() => onTogglePriority(priority)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    FILTER_OPTION_BASE,
                                                    isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                                )}
                                            >
                                                <PriorityFlag priority={priority} />
                                                {t(`priority.${priority}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </FilterCategory>
                        )}

                        {(showTimeEstimateFilters || selectedTimeEstimates.length > 0) && (
                            <FilterCategory
                                id="list-time-filters"
                                label={t('filters.timeEstimate')}
                                summary={timeSummary}
                                expanded={expandedCategory === 'time'}
                                onToggle={() => toggleCategory('time')}
                            >
                                <div className="flex flex-wrap gap-2">
                                    {timeEstimateOptions.map((estimate) => {
                                        const isActive = selectedTimeEstimates.includes(estimate);
                                        return (
                                            <button
                                                key={estimate}
                                                type="button"
                                                onClick={() => onToggleEstimate(estimate)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    FILTER_OPTION_BASE,
                                                    isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                                )}
                                            >
                                                {formatEstimate(estimate)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </FilterCategory>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
