import { TaskDateFilter } from '../list/TaskDateFilter';
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { SAVED_FILTER_NO_PROJECT_ID, tFallback } from '@mindwtr/core';
import type { DateRange, MultiValueFilterMatchMode, TaskEnergyLevel, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { Filter, Save } from 'lucide-react';

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
} from '../list/FilterDisclosure';
import { VIEW_FILTER_INPUT } from '../list/list-toolbar';

export type AgendaProjectFilterOption = {
    id: string;
    title: string;
    dotColor?: string;
};

export type AgendaActiveFilterChip = DesktopActiveFilterChip;

type FilterCategoryId = 'dates' | 'tokens' | 'projects' | 'location' | 'priority' | 'energy' | 'time';

type AgendaFiltersPanelProps = {
    anyDateRange?: DateRange;
    onAnyDateRangeChange?: (value: DateRange | undefined) => void;
    allTokens: string[];
    activeFilterChips: AgendaActiveFilterChip[];
    energyLevelOptions: TaskEnergyLevel[];
    formatEstimate: (estimate: TimeEstimate) => string;
    canSaveFilter: boolean;
    contextMatchMode: MultiValueFilterMatchMode;
    contextMatchModeLabels: { title: string; any: string; all: string };
    tagMatchMode: MultiValueFilterMatchMode;
    tagMatchModeLabels: { title: string; any: string; all: string };
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

const focusFiltersTrigger = () => {
    window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('button[aria-controls="agenda-filters-panel"]')?.focus();
    });
};

export function AgendaFiltersPanel({
    anyDateRange,
    onAnyDateRangeChange,
    allTokens,
    activeFilterChips,
    energyLevelOptions,
    formatEstimate,
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
    const [expandedCategory, setExpandedCategory] = useState<FilterCategoryId | null>(null);
    const [tokenQuery, setTokenQuery] = useState('');
    const [projectQuery, setProjectQuery] = useState('');
    const allLabel = tFallback(t, 'common.all', 'All');
    const noMatchesLabel = tFallback(t, 'common.noMatches', 'No matches');
    const removeLabel = tFallback(t, 'filters.remove', 'Remove filter');
    const searchOptionsLabel = tFallback(t, 'filters.searchOptions', 'Search options');
    const searchTasksLabel = tFallback(t, 'filters.searchTasks', 'Search task titles');
    const tokenCycleHint = tFallback(
        t,
        'filters.tokenCycleHint',
        'Click to include, again to exclude, and once more to clear.',
    );

    const tokenOptions = useMemo(
        () => Array.from(new Set([...allTokens, ...selectedTokens, ...excludedTokens])),
        [allTokens, excludedTokens, selectedTokens],
    );
    const visibleTokens = useMemo(
        () => tokenOptions.filter((token) => matchesFilterOption(token, tokenQuery)),
        [tokenOptions, tokenQuery],
    );
    const visibleProjects = useMemo(
        () => projectOptions.filter((project) => matchesFilterOption(project.title, projectQuery)),
        [projectOptions, projectQuery],
    );
    const projectTitleById = useMemo(
        () => new Map(projectOptions.map((project) => [project.id, project.title])),
        [projectOptions],
    );

    const selectedContextCount = selectedTokens.filter((token) => token.trim().startsWith('@')).length;
    const selectedTagCount = selectedTokens.filter((token) => token.trim().startsWith('#')).length;
    const tokenSummary = summarizeFilterValues([
        ...selectedTokens,
        ...excludedTokens.map((token) => `${excludedStateLabel}: ${token}`),
    ], allLabel);
    const projectSummary = summarizeFilterValues(selectedProjects.map((projectId) => (
        projectId === SAVED_FILTER_NO_PROJECT_ID
            ? tFallback(t, 'taskEdit.noProjectOption', 'No project')
            : projectTitleById.get(projectId) ?? projectId
    )), allLabel);
    const prioritySummary = summarizeFilterValues(
        selectedPriorities.map((priority) => t(`priority.${priority}`)),
        allLabel,
    );
    const energySummary = summarizeFilterValues(
        selectedEnergyLevels.map((level) => t(`energyLevel.${level}`)),
        allLabel,
    );
    const timeSummary = summarizeFilterValues(selectedTimeEstimates.map(formatEstimate), allLabel);

    const closePanel = () => {
        if (!showFiltersPanel) return;
        onToggleFiltersOpen();
        focusFiltersTrigger();
    };

    useEffect(() => {
        if (showFiltersPanel) return;
        setExpandedCategory(null);
        setTokenQuery('');
        setProjectQuery('');
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

    const renderNoMatches = () => <p className="text-sm text-muted-foreground">{noMatchesLabel}</p>;

    return (
        <div id="agenda-filters-panel" className="space-y-3 rounded-lg border border-border/70 bg-card/45 p-3" onKeyDown={handlePanelKeyDown}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Filter className="h-4 w-4" aria-hidden="true" />
                    {t('filters.label')}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canSaveFilter && (
                        <button
                            type="button"
                            onClick={onSaveFilter}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                            {saveFilterLabel}
                        </button>
                    )}
                    {hasFilters && (
                        <button
                            type="button"
                            onClick={onClearFilters}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {t('filters.clear')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={showFiltersPanel ? closePanel : onToggleFiltersOpen}
                        aria-expanded={showFiltersPanel}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                    </button>
                </div>
            </div>
            <div>
                <label htmlFor="agenda-task-filter" className="sr-only">{searchTasksLabel}</label>
                <input
                    id="agenda-task-filter"
                    ref={searchInputRef}
                    type="search"
                    data-view-filter-input
                    placeholder={searchTasksLabel}
                    value={searchQuery}
                    onChange={(event) => onSearchChange(event.target.value)}
                    className={VIEW_FILTER_INPUT}
                />
            </div>
            <ActiveFilterChips chips={activeFilterChips} excludedLabel={excludedStateLabel} removeLabel={removeLabel} />
            {showFiltersPanel && (
                <div className="rounded-md border border-border/60 px-2">
                    {onAnyDateRangeChange && (
                        <TaskDateFilter id="agenda-date-filters" value={anyDateRange} onChange={onAnyDateRangeChange}
                            expanded={expandedCategory === 'dates'} onToggle={() => toggleCategory('dates')} t={t} />
                    )}
                    <FilterCategory
                        id="agenda-token-filters"
                        label={t('filters.contexts')}
                        summary={tokenSummary}
                        expanded={expandedCategory === 'tokens'}
                        onToggle={() => toggleCategory('tokens')}
                    >
                        <FilterOptionSearch id="agenda-token-option-search" label={searchOptionsLabel} value={tokenQuery} onChange={setTokenQuery} />
                        {selectedContextCount > 1 && (
                            <MatchModeControl
                                label={contextMatchModeLabels.title}
                                mode={contextMatchMode}
                                anyLabel={contextMatchModeLabels.any}
                                allLabel={contextMatchModeLabels.all}
                                onChange={onContextMatchModeChange}
                            />
                        )}
                        {selectedTagCount > 1 && (
                            <MatchModeControl
                                label={tagMatchModeLabels.title}
                                mode={tagMatchMode}
                                anyLabel={tagMatchModeLabels.any}
                                allLabel={tagMatchModeLabels.all}
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
                                        </button>
                                    );
                                })}
                            </div>
                        ) : renderNoMatches()}
                    </FilterCategory>

                    {(showNoProjectOption || projectOptions.length > 0 || selectedProjects.length > 0) && (
                        <FilterCategory
                            id="agenda-project-filters"
                            label={t('filters.projects')}
                            summary={projectSummary}
                            expanded={expandedCategory === 'projects'}
                            onToggle={() => toggleCategory('projects')}
                        >
                            <FilterOptionSearch id="agenda-project-option-search" label={searchOptionsLabel} value={projectQuery} onChange={setProjectQuery} />
                            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                                {showNoProjectOption && matchesFilterOption(tFallback(t, 'taskEdit.noProjectOption', 'No project'), projectQuery) && (
                                    <button
                                        type="button"
                                        onClick={() => onToggleProject(SAVED_FILTER_NO_PROJECT_ID)}
                                        aria-pressed={selectedProjects.includes(SAVED_FILTER_NO_PROJECT_ID)}
                                        className={cn(
                                            FILTER_OPTION_BASE,
                                            selectedProjects.includes(SAVED_FILTER_NO_PROJECT_ID)
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {t('taskEdit.noProjectOption')}
                                    </button>
                                )}
                                {visibleProjects.map((project) => {
                                    const isActive = selectedProjects.includes(project.id);
                                    return (
                                        <button
                                            key={project.id}
                                            type="button"
                                            onClick={() => onToggleProject(project.id)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                FILTER_OPTION_BASE,
                                                'inline-flex max-w-full items-center gap-2',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {project.dotColor && (
                                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project.dotColor }} aria-hidden="true" />
                                            )}
                                            <span className="max-w-[240px] break-words text-left">{project.title}</span>
                                        </button>
                                    );
                                })}
                                {visibleProjects.length === 0
                                    && !(showNoProjectOption && matchesFilterOption(tFallback(t, 'taskEdit.noProjectOption', 'No project'), projectQuery))
                                    && renderNoMatches()}
                            </div>
                        </FilterCategory>
                    )}

                    {(showLocationFilter || Boolean(locationFilter.trim())) && (
                        <FilterCategory
                            id="agenda-location-filters"
                            label={t('taskEdit.locationLabel')}
                            summary={locationFilter.trim() || allLabel}
                            expanded={expandedCategory === 'location'}
                            onToggle={() => toggleCategory('location')}
                        >
                            <label htmlFor="agenda-location-filter" className="sr-only">{t('taskEdit.locationLabel')}</label>
                            <input
                                id="agenda-location-filter"
                                type="text"
                                value={locationFilter}
                                onChange={(event) => onLocationChange(event.target.value)}
                                placeholder={t('taskEdit.locationPlaceholder')}
                                className={VIEW_FILTER_INPUT}
                            />
                        </FilterCategory>
                    )}

                    {(showPriorityFilters || selectedPriorities.length > 0) && (
                        <FilterCategory
                            id="agenda-priority-filters"
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

                    {(showEnergyLevelFilters || selectedEnergyLevels.length > 0) && (
                        <FilterCategory
                            id="agenda-energy-filters"
                            label={t('taskEdit.energyLevel')}
                            summary={energySummary}
                            expanded={expandedCategory === 'energy'}
                            onToggle={() => toggleCategory('energy')}
                        >
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
                                                FILTER_OPTION_BASE,
                                                isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {t(`energyLevel.${energyLevel}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </FilterCategory>
                    )}

                    {(showTimeEstimateFilters || selectedTimeEstimates.length > 0) && (
                        <FilterCategory
                            id="agenda-time-filters"
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
                                            onClick={() => onToggleTime(estimate)}
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
            )}
        </div>
    );
}
