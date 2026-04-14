import type { TaskEnergyLevel, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { Filter } from 'lucide-react';

import { cn } from '../../../lib/utils';

type AgendaFiltersPanelProps = {
    allTokens: string[];
    energyLevelOptions: TaskEnergyLevel[];
    formatEstimate: (estimate: TimeEstimate) => string;
    hasFilters: boolean;
    onClearFilters: () => void;
    onSearchChange: (value: string) => void;
    onToggleEnergy: (energyLevel: TaskEnergyLevel) => void;
    onToggleFiltersOpen: () => void;
    onTogglePriority: (priority: TaskPriority) => void;
    onToggleTime: (estimate: TimeEstimate) => void;
    onToggleToken: (token: string) => void;
    prioritiesEnabled: boolean;
    priorityOptions: TaskPriority[];
    searchQuery: string;
    selectedEnergyLevels: TaskEnergyLevel[];
    selectedPriorities: TaskPriority[];
    selectedTimeEstimates: TimeEstimate[];
    selectedTokens: string[];
    showFiltersPanel: boolean;
    t: (key: string) => string;
    timeEstimateOptions: TimeEstimate[];
    timeEstimatesEnabled: boolean;
};

export function AgendaFiltersPanel({
    allTokens,
    energyLevelOptions,
    formatEstimate,
    hasFilters,
    onClearFilters,
    onSearchChange,
    onToggleEnergy,
    onToggleFiltersOpen,
    onTogglePriority,
    onToggleTime,
    onToggleToken,
    prioritiesEnabled,
    priorityOptions,
    searchQuery,
    selectedEnergyLevels,
    selectedPriorities,
    selectedTimeEstimates,
    selectedTokens,
    showFiltersPanel,
    t,
    timeEstimateOptions,
    timeEstimatesEnabled,
}: AgendaFiltersPanelProps) {
    return (
        <div className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Filter className="h-4 w-4" />
                    {t('filters.label')}
                </div>
                <div className="flex items-center gap-2">
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
                type="text"
                data-view-filter-input
                placeholder={t('common.search')}
                value={searchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {showFiltersPanel && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.contexts')}</div>
                        <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
                            {allTokens.map((token) => {
                                const isActive = selectedTokens.includes(token);
                                return (
                                    <button
                                        key={token}
                                        type="button"
                                        onClick={() => onToggleToken(token)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
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
                    {prioritiesEnabled && (
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
                    )}
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
                    {timeEstimatesEnabled && (
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
                    )}
                </div>
            )}
        </div>
    );
}
