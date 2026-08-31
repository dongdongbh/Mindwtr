import type { RefObject } from 'react';
import { resolveFeatureFlags, useTaskStore } from '@mindwtr/core';
import type { MultiValueFilterMatchMode, SortField, TaskEnergyLevel, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { Filter, Save, X } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { VIEW_FILTER_INPUT } from '../list/list-toolbar';

export type AgendaProjectFilterOption = {
    id: string;
    title: string;
    dotColor?: string;
};

export type AgendaActiveFilterChip = {
    id: string;
    label: string;
    dotColor?: string;
    isAdvanced?: boolean;
    /** Excluded (subtracting) token — rendered struck through, not selected. */
    excluded?: boolean;
    onRemove?: () => void;
};

const FOCUS_SORT_OPTIONS: SortField[] = ['default', 'due', 'start', 'priority', 'created', 'created-desc'];

type AgendaFiltersPanelProps = {
    allTokens: string[];
    activeFilterChips: AgendaActiveFilterChip[];
    energyLevelOptions: TaskEnergyLevel[];
    formatEstimate: (estimate: TimeEstimate) => string;
    focusSortBy: SortField;
    canSaveFilter: boolean;
    contextMatchMode: MultiValueFilterMatchMode;
    contextMatchModeLabels: {
        title: string;
        any: string;
        all: string;
    };
    tagMatchMode: MultiValueFilterMatchMode;
    tagMatchModeLabels: {
        title: string;
        any: string;
        all: string;
    };
    hasFilters: boolean;
    locationFilter: string;
    showEnergyLevelFilters: boolean;
    showLocationFilter: boolean;
    onSaveFilter: () => void;
    onClearFilters: () => void;
    onLocationChange: (value: string) => void;
    onContextMatchModeChange: (value: MultiValueFilterMatchMode) => void;
    onTagMatchModeChange: (value: MultiValueFilterMatchMode) => void;
    onSearchChange: (value: string) => void;
    onSortChange: (value: SortField) => void;
    onToggleEnergy: (energyLevel: TaskEnergyLevel) => void;
    onToggleFiltersOpen: () => void;
    onToggleProject: (projectId: string) => void;
    onTogglePriority: (priority: TaskPriority) => void;
    onToggleTime: (estimate: TimeEstimate) => void;
    onToggleToken: (token: string) => void;
    showPriorityFilters: boolean;
    projectOptions: AgendaProjectFilterOption[];
    priorityOptions: TaskPriority[];
    searchQuery: string;
    searchInputRef?: RefObject<HTMLInputElement | null>;
    saveFilterLabel: string;
    selectedEnergyLevels: TaskEnergyLevel[];
    selectedProjects: string[];
    selectedPriorities: TaskPriority[];
    selectedTimeEstimates: TimeEstimate[];
    selectedTokens: string[];
    excludedTokens: string[];
    excludedStateLabel: string;
    showNoProjectOption: boolean;
    showFiltersPanel: boolean;
    t: (key: string) => string;
    timeEstimateOptions: TimeEstimate[];
    showTimeEstimateFilters: boolean;
};

export function AgendaFiltersPanel({
    allTokens,
    activeFilterChips,
    energyLevelOptions,
    formatEstimate,
    focusSortBy,
    canSaveFilter,
    contextMatchMode,
    contextMatchModeLabels,
    tagMatchMode,
    tagMatchModeLabels,
    hasFilters,
    locationFilter,
    showEnergyLevelFilters,
    showLocationFilter,
    onClearFilters,
    onContextMatchModeChange,
    onTagMatchModeChange,
    onLocationChange,
    onSearchChange,
    onSortChange,
    onSaveFilter,
    onToggleEnergy,
    onToggleFiltersOpen,
    onToggleProject,
    onTogglePriority,
    onToggleTime,
    onToggleToken,
    showPriorityFilters,
    projectOptions,
    priorityOptions,
    searchQuery,
    searchInputRef,
    saveFilterLabel,
    selectedEnergyLevels,
    selectedProjects,
    selectedPriorities,
    selectedTimeEstimates,
    selectedTokens,
    excludedTokens,
    excludedStateLabel,
    showNoProjectOption,
    showFiltersPanel,
    t,
    timeEstimateOptions,
    showTimeEstimateFilters,
}: AgendaFiltersPanelProps) {
    // Focus renders its sort as chips rather than the shared SortBySelect, so
    // the Priorities gate is repeated here: with the feature off the option
    // must not be offered, and AgendaView resolves a stored 'priority' sort to
    // 'default' so the missing chip can never leave nothing selected.
    const prioritiesEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
    const sortOptions = prioritiesEnabled
        ? FOCUS_SORT_OPTIONS
        : FOCUS_SORT_OPTIONS.filter((option) => option !== 'priority');
    const selectedContextCount = selectedTokens.filter((token) => token.trim().startsWith('@')).length;
    const showContextMatchMode = selectedContextCount > 1;
    const selectedTagCount = selectedTokens.filter((token) => token.trim().startsWith('#')).length;
    const showTagMatchMode = selectedTagCount > 1;

    return (
        <div id="agenda-filters-panel" className="space-y-3 rounded-lg border border-border/70 bg-card/45 p-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Filter className="h-4 w-4" />
                    {t('filters.label')}
                </div>
                <div className="flex items-center gap-2">
                    {canSaveFilter && (
                        <button
                            type="button"
                            onClick={onSaveFilter}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                            {saveFilterLabel}
                        </button>
                    )}
                    {hasFilters && (
                        <button
                            type="button"
                            onClick={onClearFilters}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {t('filters.clear')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onToggleFiltersOpen}
                        aria-expanded={showFiltersPanel}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                    </button>
                </div>
            </div>
            <input
                ref={searchInputRef}
                type="text"
                data-view-filter-input
                placeholder={t('common.search')}
                aria-label={t('common.search')}
                value={searchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                className={VIEW_FILTER_INPUT}
            />
            {activeFilterChips.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {activeFilterChips.map((chip) => (
                        <span
                            key={chip.id}
                            className={cn(
                                'inline-flex min-h-8 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium',
                                chip.excluded
                                    ? 'border border-destructive bg-destructive/10 text-destructive line-through'
                                    : chip.isAdvanced
                                        ? 'border border-dashed border-primary/50 bg-muted/40 text-primary'
                                        : 'bg-muted text-muted-foreground',
                            )}
                        >
                            {chip.dotColor && (
                                <span
                                    className="h-2 w-2 rounded-full"
                                    style={{ backgroundColor: chip.dotColor }}
                                    aria-hidden="true"
                                />
                            )}
                            {chip.excluded && (
                                <span className="sr-only">{excludedStateLabel}: </span>
                            )}
                            {chip.label}
                            {chip.onRemove && (
                                <button
                                    type="button"
                                    onClick={chip.onRemove}
                                    aria-label={`${t('common.delete')} ${chip.label}`}
                                    className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-current transition-colors hover:bg-background/80"
                                >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                            )}
                        </span>
                    ))}
                </div>
            )}
            {showFiltersPanel && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('sort.label')}</div>
                        <div className="flex flex-wrap gap-2">
                            {sortOptions.map((sortBy) => {
                                const isActive = focusSortBy === sortBy;
                                const label = sortBy === 'priority' ? t('filters.priority') : t(`sort.${sortBy}`);
                                return (
                                    <button
                                        key={sortBy}
                                        type="button"
                                        onClick={() => onSortChange(sortBy)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.contexts')}</div>
                        {showContextMatchMode && (
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">{contextMatchModeLabels.title}</span>
                                <div className="inline-flex rounded-full border border-border bg-muted/50 p-0.5">
                                    {(['any', 'all'] as const).map((mode) => {
                                        const isActive = contextMatchMode === mode;
                                        return (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => onContextMatchModeChange(mode)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                                                    isActive
                                                        ? 'bg-primary text-primary-foreground'
                                                        : 'text-muted-foreground hover:text-foreground',
                                                )}
                                            >
                                                {mode === 'any' ? contextMatchModeLabels.any : contextMatchModeLabels.all}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {showTagMatchMode && (
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">{tagMatchModeLabels.title}</span>
                                <div className="inline-flex rounded-full border border-border bg-muted/50 p-0.5">
                                    {(['any', 'all'] as const).map((mode) => {
                                        const isActive = tagMatchMode === mode;
                                        return (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => onTagMatchModeChange(mode)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                                                    isActive
                                                        ? 'bg-primary text-primary-foreground'
                                                        : 'text-muted-foreground hover:text-foreground',
                                                )}
                                            >
                                                {mode === 'any' ? tagMatchModeLabels.any : tagMatchModeLabels.all}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
                            {allTokens.map((token) => {
                                const isIncluded = selectedTokens.includes(token);
                                const isExcluded = excludedTokens.includes(token);
                                return (
                                    <button
                                        key={token}
                                        type="button"
                                        onClick={() => onToggleToken(token)}
                                        // Three states can't ride a boolean: 'mixed' marks excluded.
                                        aria-pressed={isExcluded ? 'mixed' : isIncluded}
                                        aria-label={isExcluded ? `${token} (${excludedStateLabel})` : undefined}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            isExcluded
                                                ? 'border border-destructive bg-destructive/10 text-destructive line-through'
                                                : isIncluded
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {token}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {(showNoProjectOption || projectOptions.length > 0) && (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.projects')}</div>
                            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
                                {showNoProjectOption && (
                                    <button
                                        type="button"
                                        onClick={() => onToggleProject('__no_project__')}
                                        aria-pressed={selectedProjects.includes('__no_project__')}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            selectedProjects.includes('__no_project__')
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {t('taskEdit.noProjectOption')}
                                    </button>
                                )}
                                {projectOptions.map((project) => {
                                    const isActive = selectedProjects.includes(project.id);
                                    return (
                                        <button
                                            key={project.id}
                                            type="button"
                                            onClick={() => onToggleProject(project.id)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {project.dotColor && (
                                                <span
                                                    className="h-2 w-2 rounded-full"
                                                    style={{ backgroundColor: project.dotColor }}
                                                    aria-hidden="true"
                                                />
                                            )}
                                            <span className="truncate max-w-[140px]">{project.title}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {showLocationFilter ? (
                        <div className="space-y-2">
                            <label
                                htmlFor="agenda-location-filter"
                                className="text-xs uppercase tracking-wide text-muted-foreground"
                            >
                                {t('taskEdit.locationLabel')}
                            </label>
                            <input
                                id="agenda-location-filter"
                                type="text"
                                value={locationFilter}
                                onChange={(event) => onLocationChange(event.target.value)}
                                placeholder={t('taskEdit.locationPlaceholder')}
                                className={VIEW_FILTER_INPUT}
                            />
                        </div>
                    ) : null}
                    {showPriorityFilters ? (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.priority')}</div>
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
                                                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {t(`priority.${priority}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                    {showEnergyLevelFilters ? (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('taskEdit.energyLevel')}</div>
                            <div className="flex flex-wrap gap-2">
                                {energyLevelOptions.map((energyLevel) => {
                                    const isActive = selectedEnergyLevels.includes(energyLevel);
                                    return (
                                        <button
                                            key={energyLevel}
                                            type="button"
                                            onClick={() => onToggleEnergy(energyLevel)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {t(`energyLevel.${energyLevel}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                    {showTimeEstimateFilters ? (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.timeEstimate')}</div>
                            <div className="flex flex-wrap gap-2">
                                {timeEstimateOptions.map((estimate) => {
                                    const isActive = selectedTimeEstimates.includes(estimate);
                                    return (
                                        <button
                                            key={estimate}
                                            type="button"
                                            onClick={() => onToggleTime(estimate)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {formatEstimate(estimate)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}
