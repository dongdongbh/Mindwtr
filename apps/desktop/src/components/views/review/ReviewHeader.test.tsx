import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewHeader, ReviewListControls } from './ReviewHeader';
import { openToolbarSelect } from '../../../test/toolbar-select';

const translations: Record<string, string> = {
    'common.viewOptions': 'View options',
    'list.details': 'Details',
    'list.showDetails': 'Show details',
    'list.groupBy': 'Group',
    'list.groupByArea': 'Area',
    'list.groupByContext': 'Context',
    'list.groupByNone': 'No grouping',
    'list.groupByProject': 'Project',
    'projects.noTags': 'No tags',
    'sort.default': 'Default',
    'sort.label': 'Sort',
    'sort.title': 'Title',
    'taskEdit.statusLabel': 'Status',
    'taskEdit.tab.view': 'View',
    'taskEdit.tagsLabel': 'Tags',
};

describe('ReviewHeader', () => {
    it('starts each review from a labelled workflow action without a selected filter state', () => {
        const onShowDailyGuide = vi.fn();
        const onShowGuide = vi.fn();
        render(
            <ReviewHeader
                title="Review"
                taskCountLabel="3 tasks"
                onShowDailyGuide={onShowDailyGuide}
                onShowGuide={onShowGuide}
                labels={{ dailyReview: 'Start daily review', weeklyReview: 'Start weekly review' }}
            />
        );

        const daily = screen.getByRole('button', { name: 'Start daily review' });
        const weekly = screen.getByRole('button', { name: 'Start weekly review' });
        expect(daily).not.toHaveAttribute('aria-pressed');
        expect(weekly).not.toHaveAttribute('aria-pressed');
        fireEvent.click(daily);
        expect(onShowDailyGuide).toHaveBeenCalledOnce();
        expect(onShowGuide).not.toHaveBeenCalled();
        fireEvent.click(weekly);
        expect(onShowGuide).toHaveBeenCalledOnce();
        expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
    });
});

describe('ReviewListControls', () => {
    it('shows direct Sort and Group controls and highlights each non-default value independently', () => {
        const controls = (sortBy: 'default' | 'title', groupBy: 'none' | 'project') => (
            <ReviewListControls
                selectionMode={false}
                onToggleSelection={vi.fn()}
                sortBy={sortBy}
                onChangeSortBy={vi.fn()}
                groupBy={groupBy}
                onChangeGroupBy={vi.fn()}
                showListDetails={false}
                onToggleDetails={vi.fn()}
                disableStatusGrouping={false}
                t={(key) => translations[key] ?? key}
                labels={{ select: 'Select', exitSelect: 'Exit select' }}
            />
        );
        const view = render(controls('default', 'none'));
        const sort = screen.getByRole('combobox', { name: 'Sort' });
        const group = screen.getByRole('combobox', { name: 'Group' });

        expect(screen.queryByRole('button', { name: 'View options' })).not.toBeInTheDocument();
        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-card');

        view.rerender(controls('title', 'none'));
        expect(sort).toHaveClass('bg-primary/10');
        expect(group).toHaveClass('bg-card');

        view.rerender(controls('default', 'project'));
        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-primary/10');

        view.rerender(controls('default', 'none'));
        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-card');
    });

    it('keeps selection and Details separate while Sort and Group stay directly accessible', () => {
        const onChangeSortBy = vi.fn();
        const onChangeGroupBy = vi.fn();
        const onToggleDetails = vi.fn();

        render(
            <ReviewListControls
                selectionMode={false}
                onToggleSelection={vi.fn()}
                sortBy="default"
                onChangeSortBy={onChangeSortBy}
                groupBy="none"
                onChangeGroupBy={onChangeGroupBy}
                showListDetails={false}
                onToggleDetails={onToggleDetails}
                disableStatusGrouping
                t={(key) => translations[key] ?? key}
                labels={{ select: 'Select', exitSelect: 'Exit select' }}
            />
        );

        expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Show details' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View options' })).not.toBeInTheDocument();


        openToolbarSelect('Group');
        const statusOption = screen.getByRole('option', { name: 'Status' });
        expect(statusOption).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(statusOption);
        expect(onChangeGroupBy).not.toHaveBeenCalled();

        openToolbarSelect('Sort');
        const titleOption = screen.getByRole('option', { name: 'Title' });
        fireEvent.click(titleOption);
        expect(onChangeSortBy).toHaveBeenCalledWith('title');

        fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
        expect(onToggleDetails).toHaveBeenCalledOnce();
    });
});
