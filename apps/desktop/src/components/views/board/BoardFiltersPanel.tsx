import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Filter } from 'lucide-react';
import { SAVED_FILTER_NO_PROJECT_ID, tFallback } from '@mindwtr/core';
import type { MultiValueFilterMatchMode } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
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

type BoardCategoryId = 'tokens' | 'due' | 'projects';

type BoardProjectFilterOption = {
    id: string;
    title: string;
    dotColor?: string;
};

type BoardFiltersPanelProps = {
    activeFilterChips: DesktopActiveFilterChip[];
    allTokens: string[];
    contextMatchMode: MultiValueFilterMatchMode;
    duePresets: readonly string[];
    excludedTokens: string[];
    hasFilters: boolean;
    onClearFilters: () => void;
    onClose: () => void;
    onContextMatchModeChange: (mode: MultiValueFilterMatchMode) => void;
    onTagMatchModeChange: (mode: MultiValueFilterMatchMode) => void;
    onToggleDuePreset: (preset: string) => void;
    onToggleProject: (projectId: string) => void;
    onToggleToken: (token: string) => void;
    projectOptions: BoardProjectFilterOption[];
    selectedDuePreset?: string;
    selectedProjectIds: string[];
    selectedTokens: string[];
    showFiltersPanel: boolean;
    tagMatchMode: MultiValueFilterMatchMode;
    t: (key: string) => string;
};

const focusFiltersTrigger = () => {
    window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('button[aria-controls="board-filters-panel"]')?.focus();
    });
};

export function BoardFiltersPanel({
    activeFilterChips,
    allTokens,
    contextMatchMode,
    duePresets,
    excludedTokens,
    hasFilters,
    onClearFilters,
    onClose,
    onContextMatchModeChange,
    onTagMatchModeChange,
    onToggleDuePreset,
    onToggleProject,
    onToggleToken,
    projectOptions,
    selectedDuePreset,
    selectedProjectIds,
    selectedTokens,
    showFiltersPanel,
    tagMatchMode,
    t,
}: BoardFiltersPanelProps) {
    const [expandedCategory, setExpandedCategory] = useState<BoardCategoryId | null>(null);
    const [tokenQuery, setTokenQuery] = useState('');
    const [projectQuery, setProjectQuery] = useState('');
    const allLabel = tFallback(t, 'common.all', 'All');
    const noMatchesLabel = tFallback(t, 'common.noMatches', 'No matches');
    const excludedLabel = tFallback(t, 'filters.excluded', 'Excluded');
    const removeLabel = tFallback(t, 'filters.remove', 'Remove filter');
    const searchOptionsLabel = tFallback(t, 'filters.searchOptions', 'Search options');
    const tokenCycleHint = tFallback(
        t,
        'filters.tokenCycleHint',
        'Click to include, again to exclude, and once more to clear.',
    );
    const noProjectLabel = tFallback(t, 'taskEdit.noProjectOption', 'No project');

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
        ...excludedTokens.map((token) => `${excludedLabel}: ${token}`),
    ], allLabel);
    const dueSummary = selectedDuePreset ? t(`filters.datePreset.${selectedDuePreset}`) : allLabel;
    const projectSummary = summarizeFilterValues(selectedProjectIds.map((projectId) => (
        projectId === SAVED_FILTER_NO_PROJECT_ID ? noProjectLabel : projectTitleById.get(projectId) ?? projectId
    )), allLabel);

    const closePanel = () => {
        onClose();
        focusFiltersTrigger();
    };

    useEffect(() => {
        if (showFiltersPanel) return;
        setExpandedCategory(null);
        setTokenQuery('');
        setProjectQuery('');
    }, [showFiltersPanel]);


    const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !showFiltersPanel) return;
        event.preventDefault();
        closePanel();
    };

    const toggleCategory = (category: BoardCategoryId) => {
        setExpandedCategory((current) => current === category ? null : category);
    };

    return (
        <div id="board-filters-panel" className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3" onKeyDown={handlePanelKeyDown}>
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
            <ActiveFilterChips chips={activeFilterChips} excludedLabel={excludedLabel} removeLabel={removeLabel} />
            {showFiltersPanel && (
                <div className="rounded-md border border-border/60 px-2">
                    <FilterCategory
                        id="board-token-filters"
                        label={t('filters.contexts')}
                        summary={tokenSummary}
                        expanded={expandedCategory === 'tokens'}
                        onToggle={() => toggleCategory('tokens')}
                    >
                        <FilterOptionSearch id="board-token-option-search" label={searchOptionsLabel} value={tokenQuery} onChange={setTokenQuery} />
                        {selectedContextCount > 1 && (
                            <MatchModeControl
                                label={tFallback(t, 'filters.contextMatchMode', 'Context match')}
                                mode={contextMatchMode}
                                anyLabel={tFallback(t, 'filters.matchAny', 'Any')}
                                allLabel={allLabel}
                                onChange={onContextMatchModeChange}
                            />
                        )}
                        {selectedTagCount > 1 && (
                            <MatchModeControl
                                label={tFallback(t, 'filters.tagMatchMode', 'Tag match')}
                                mode={tagMatchMode}
                                anyLabel={tFallback(t, 'filters.matchAny', 'Any')}
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
                                            aria-label={isExcluded ? `${token} (${excludedLabel})` : undefined}
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
                        ) : (
                            <p className="text-sm text-muted-foreground">{noMatchesLabel}</p>
                        )}
                    </FilterCategory>

                    <FilterCategory
                        id="board-due-filters"
                        label={t('search.due.label')}
                        summary={dueSummary}
                        expanded={expandedCategory === 'due'}
                        onToggle={() => toggleCategory('due')}
                    >
                        <div className="flex flex-wrap gap-2">
                            {duePresets.map((preset) => {
                                const isActive = selectedDuePreset === preset;
                                return (
                                    <button
                                        key={preset}
                                        type="button"
                                        onClick={() => onToggleDuePreset(preset)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            FILTER_OPTION_BASE,
                                            isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {t(`filters.datePreset.${preset}`)}
                                    </button>
                                );
                            })}
                        </div>
                    </FilterCategory>

                    <FilterCategory
                        id="board-project-filters"
                        label={t('filters.projects')}
                        summary={projectSummary}
                        expanded={expandedCategory === 'projects'}
                        onToggle={() => toggleCategory('projects')}
                    >
                        <FilterOptionSearch id="board-project-option-search" label={searchOptionsLabel} value={projectQuery} onChange={setProjectQuery} />
                        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                            {matchesFilterOption(noProjectLabel, projectQuery) && (
                                <button
                                    type="button"
                                    onClick={() => onToggleProject(SAVED_FILTER_NO_PROJECT_ID)}
                                    aria-pressed={selectedProjectIds.includes(SAVED_FILTER_NO_PROJECT_ID)}
                                    className={cn(
                                        FILTER_OPTION_BASE,
                                        selectedProjectIds.includes(SAVED_FILTER_NO_PROJECT_ID)
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                    )}
                                >
                                    {noProjectLabel}
                                </button>
                            )}
                            {visibleProjects.map((project) => {
                                const isActive = selectedProjectIds.includes(project.id);
                                return (
                                    <button
                                        key={project.id}
                                        type="button"
                                        onClick={() => onToggleProject(project.id)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            FILTER_OPTION_BASE,
                                            'inline-flex max-w-full items-center gap-2',
                                            isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        <span
                                            className="h-2 w-2 shrink-0 rounded-full"
                                            style={{ backgroundColor: project.dotColor || 'hsl(var(--muted-foreground))' }}
                                            aria-hidden="true"
                                        />
                                        <span className="max-w-[240px] break-words text-left">{project.title}</span>
                                    </button>
                                );
                            })}
                            {visibleProjects.length === 0 && !matchesFilterOption(noProjectLabel, projectQuery) && (
                                <p className="text-sm text-muted-foreground">{noMatchesLabel}</p>
                            )}
                        </div>
                    </FilterCategory>
                </div>
            )}
        </div>
    );
}
