import { CheckSquare, List } from 'lucide-react';
import { tFallback, type TaskSortBy } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { CONTEXTS_AXES, type ContextsGroupBy } from '../list/next-grouping';
import { GroupBySelect } from '../list/GroupBySelect';
import {
    SortBySelect,
    ToolbarButton,
    TOOLBAR_CONTROL_BASE,
    TOOLBAR_CONTROL_MUTED,
} from '../list/list-toolbar';

type ReviewHeaderProps = {
    title: string;
    taskCountLabel: string;
    onShowDailyGuide: () => void;
    onShowGuide: () => void;
    labels: {
        dailyReview: string;
        weeklyReview: string;
    };
};


export function ReviewHeader({
    title,
    taskCountLabel,
    onShowDailyGuide,
    onShowGuide,
    labels,
}: ReviewHeaderProps) {
    return (
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
                <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
                <p className="text-sm text-muted-foreground">{taskCountLabel}</p>
            </div>
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:justify-end">
                <button
                    type="button"
                    onClick={onShowDailyGuide}
                    title={labels.dailyReview}
                    className={cn(TOOLBAR_CONTROL_BASE, TOOLBAR_CONTROL_MUTED, 'inline-flex min-w-0 max-w-full items-center justify-center rounded-lg px-3 font-medium')}
                >
                    <span className="truncate">{labels.dailyReview}</span>
                </button>
                <button
                    type="button"
                    onClick={onShowGuide}
                    title={labels.weeklyReview}
                    className={cn(TOOLBAR_CONTROL_BASE, 'inline-flex min-w-0 max-w-full items-center justify-center rounded-lg border-primary bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90')}
                >
                    <span className="truncate">{labels.weeklyReview}</span>
                </button>
            </div>
        </header>
    );
}

type ReviewListControlsProps = {
    selectionMode: boolean;
    onToggleSelection: () => void;
    sortBy: TaskSortBy;
    onChangeSortBy: (value: TaskSortBy) => void;
    groupBy: ContextsGroupBy;
    onChangeGroupBy: (value: ContextsGroupBy) => void;
    showListDetails: boolean;
    onToggleDetails: () => void;
    disableStatusGrouping: boolean;
    t: (key: string) => string;
    labels: {
        select: string;
        exitSelect: string;
    };
};

export function ReviewListControls({
    selectionMode,
    onToggleSelection,
    sortBy,
    onChangeSortBy,
    groupBy,
    onChangeGroupBy,
    showListDetails,
    onToggleDetails,
    disableStatusGrouping,
    t,
    labels,
}: ReviewListControlsProps) {
    const detailsLabel = showListDetails
        ? tFallback(t, 'list.hideDetails', 'Hide details')
        : tFallback(t, 'list.showDetails', 'Show details');

    return (
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            <SortBySelect
                value={sortBy}
                defaultValue="default"
                onChange={onChangeSortBy}
                t={t}
                className="min-w-0 max-w-full"
            />
            <GroupBySelect
                value={groupBy}
                defaultValue="none"
                axes={CONTEXTS_AXES}
                disabledAxes={disableStatusGrouping ? ['status'] : []}
                onChange={onChangeGroupBy}
                t={t}
                className="min-w-0 max-w-full"
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
                {selectionMode ? labels.exitSelect : labels.select}
            </ToolbarButton>
        </div>
    );
}
