import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';

import { ListHeader } from './ListHeader';
import { resolveNonDoneTaskSortBy } from '@mindwtr/core';
import { openToolbarSelect } from '../../../test/toolbar-select';

const translations: Record<string, string> = {
    'bulk.select': 'Select',
    'common.tasks': 'tasks',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'focus.group.energy': 'Energy',
    'list.details': 'Details',
    'list.showDetails': 'Show details',
    'list.hideDetails': 'Hide details',
    'list.density': 'Density',
    'list.densityComfortable': 'Comfortable',
    'list.densityCompact': 'Compact',
    'list.densityCondensed': 'Condensed',
    'list.groupBy': 'Group',
    'list.groupByArea': 'Area',
    'list.groupByContext': 'Context',
    'list.groupByNone': 'No grouping',
    'list.groupByProject': 'Project',
    'people.title': 'People',
    'sort.created': 'Oldest',
    'sort.created-desc': 'Newest',
    'sort.default': 'Default',
    'sort.due': 'Due date',
    'sort.label': 'Sort',
    'sort.review': 'Review',
    'sort.start': 'Start date',
    'sort.timeEstimate': 'Time estimate',
    'sort.title': 'Title',
    'taskEdit.tagsLabel': 'Tags',
};

const t = (key: string) => translations[key] ?? key;

const setTimeEstimatesEnabled = (enabled: boolean) => {
    act(() => {
        useTaskStore.setState((state) => ({
            ...state,
            settings: { ...state.settings, features: { ...state.settings?.features, timeEstimates: enabled } },
        } as never));
    });
};

const setPrioritiesEnabled = (enabled: boolean) => {
    act(() => {
        useTaskStore.setState((state) => ({
            ...state,
            settings: { ...state.settings, features: { ...state.settings?.features, priorities: enabled } },
        } as never));
    });
};

describe('ListHeader', () => {
    afterEach(() => {
        setTimeEstimatesEnabled(true);
        setPrioritiesEnabled(true);
    });

    // #1107: the sort lives in the shared SortBySelect, so the Time estimates
    // toggle has to reach it there rather than at each individual toolbar.
    it('offers the time-estimate sort only while the Time estimates feature is on', () => {
        const header = (sortBy: 'default' | 'timeEstimate') => (
            <ListHeader
                title="Next"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy={sortBy}
                onChangeSortBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const enabled = render(header('default'));
        openToolbarSelect('Sort');
        expect(screen.getByRole('option', { name: 'Time estimate' })).toBeInTheDocument();
        enabled.unmount();

        setTimeEstimatesEnabled(false);
        const disabled = render(header('default'));
        openToolbarSelect('Sort');
        expect(screen.queryByRole('option', { name: 'Time estimate' })).not.toBeInTheDocument();
        disabled.unmount();

        // A sort stored as 'timeEstimate' now reaches the picker already resolved
        // to 'default' (resolveNonDoneTaskSortBy), so the trigger shows Default
        // and no escape hatch has to keep the disabled option listed (#1107).
        const resolved = resolveNonDoneTaskSortBy('timeEstimate', useTaskStore.getState().settings);
        expect(resolved).toBe('default');
        render(header(resolved as 'default'));
        const trigger = openToolbarSelect('Sort');
        expect(trigger).toHaveTextContent('Default');
        expect(screen.queryByRole('option', { name: 'Time estimate' })).not.toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Default' })).toHaveAttribute('aria-selected', 'true');
    });

    it('labels sort and group controls visibly inside the compact header controls', () => {
        render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByText('Sort')).toBeInTheDocument();
        expect(screen.getByText('Group')).toBeInTheDocument();
        expect(screen.getByTestId('list-sort-icon')).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Group' })).toBeInTheDocument();
    });

    it('wraps translated titles instead of truncating them', () => {
        render(
            <ListHeader
                title="Aguardando"
                showNextCount={false}
                nextCount={0}
                taskCount={12}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails={false}
                onToggleDetails={vi.fn()}
                densityMode="compact"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const title = screen.getByRole('heading', { level: 2, name: 'Aguardando' });
        expect(title).toHaveClass('break-words');
        expect(title).not.toHaveClass('truncate');
        // The heading classes alone are not enough: the title column shares a flex
        // row with the toolbar, so a zero minimum width let the toolbar squeeze a
        // single long word until it broke mid-word ("Aguardand / o"). Keeping the
        // column's content-based floor is what actually holds the word together.
        expect(title.parentElement).not.toHaveClass('min-w-0');
    });

    it('renders supplied group-by options including tags', () => {
        render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                groupByOptions={['none', 'tag']}
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        openToolbarSelect('Group');
        expect(screen.getByRole('option', { name: 'Tags' })).toBeInTheDocument();
    });

    it('drops the Priority group-by axis while the Priorities feature is off', () => {
        const renderHeader = () => render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                groupByOptions={['none', 'priority', 'energy']}
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const { unmount } = renderHeader();
        openToolbarSelect('Group');
        expect(screen.getByRole('option', { name: 'Priority' })).toBeInTheDocument();
        unmount();

        setPrioritiesEnabled(false);
        renderHeader();
        openToolbarSelect('Group');
        expect(screen.queryByRole('option', { name: 'Priority' })).not.toBeInTheDocument();
        // Energy has no feature flag and must survive.
        expect(screen.getByRole('option', { name: 'Energy' })).toBeInTheDocument();
    });

    it('omits the Filters toggle unless the view opts in', () => {
        render(
            <ListHeader
                title="Completed"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    });

    it('shows the condensed density label and marks the control active when condensed', () => {
        render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="condensed"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const button = screen.getByRole('button', { name: 'Condensed' });
        expect(button).toHaveAttribute('aria-pressed', 'true');
    });

    // "Hide details, toggle button, pressed" told a screen-reader user the action
    // and the state at once, and the two read as contradicting each other.
    it('names the details button by its action without also claiming a pressed state', () => {
        const { rerender } = render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails={false}
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const showButton = screen.getByRole('button', { name: 'Show details' });
        expect(showButton).not.toHaveAttribute('aria-pressed');

        rerender(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const hideButton = screen.getByRole('button', { name: 'Hide details' });
        expect(hideButton).not.toHaveAttribute('aria-pressed');
    });

    it('renders a Filters toggle that reflects and drives the panel open state', () => {
        const onToggleFilters = vi.fn();
        render(
            <ListHeader
                title="Completed"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                onChangeGroupBy={vi.fn()}
                showFiltersButton
                filtersOpen={false}
                onToggleFilters={onToggleFilters}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        const button = screen.getByRole('button', { name: 'Filters' });
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(button).toHaveAttribute('aria-controls', 'list-filters-panel');

        fireEvent.click(button);
        expect(onToggleFilters).toHaveBeenCalledTimes(1);
    });
});
