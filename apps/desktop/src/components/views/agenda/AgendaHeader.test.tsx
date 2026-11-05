import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgendaHeader } from './AgendaHeader';
import { selectToolbarOption } from '../../../test/toolbar-select';

const resolveText = (key: string, fallback: string) => {
    if (key === 'tags.title') return 'Tags';
    return fallback;
};

const t = (key: string) => resolveText(key, key);

const renderHeader = (overrides: Partial<Parameters<typeof AgendaHeader>[0]> = {}) => render(
    <AgendaHeader
        filterCount={0}
        filtersOpen={false}
        nextActionsCount={3}
        nextGroupBy="none"
        focusSortBy="default"
        canToggleOtherSections
        collapseOtherSections
        onChangeGroupBy={vi.fn()}
        onChangeSortBy={vi.fn()}
        onToggleDetails={vi.fn()}
        onToggleFilters={vi.fn()}
        onToggleOtherSections={vi.fn()}
        resolveText={resolveText}
        showListDetails={false}
        t={t}
        {...overrides}
    />
);

describe('AgendaHeader', () => {
    it('shows direct Sort and Group controls and highlights each non-default value independently', () => {
        const view = renderHeader();
        const sort = view.getByRole('combobox', { name: 'Sort' });
        const group = view.getByRole('combobox', { name: 'Group' });

        expect(view.queryByRole('button', { name: 'common.viewOptions' })).not.toBeInTheDocument();
        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-card');

        view.rerender(
            <AgendaHeader
                filterCount={0}
                filtersOpen={false}
                nextActionsCount={3}
                nextGroupBy="none"
                focusSortBy="due"
                canToggleOtherSections
                collapseOtherSections
                onChangeGroupBy={vi.fn()}
                onChangeSortBy={vi.fn()}
                onToggleDetails={vi.fn()}
                onToggleFilters={vi.fn()}
                onToggleOtherSections={vi.fn()}
                resolveText={resolveText}
                showListDetails={false}
                t={t}
            />
        );
        expect(sort).toHaveClass('bg-primary/10');
        expect(group).toHaveClass('bg-card');

        view.rerender(
            <AgendaHeader
                filterCount={0}
                filtersOpen={false}
                nextActionsCount={3}
                nextGroupBy="project"
                focusSortBy="default"
                canToggleOtherSections
                collapseOtherSections
                onChangeGroupBy={vi.fn()}
                onChangeSortBy={vi.fn()}
                onToggleDetails={vi.fn()}
                onToggleFilters={vi.fn()}
                onToggleOtherSections={vi.fn()}
                resolveText={resolveText}
                showListDetails={false}
                t={t}
            />
        );
        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-primary/10');
        expect(group).toHaveTextContent('Project');
        expect(group).toHaveAttribute('title', 'Group');

        view.rerender(
            <AgendaHeader
                filterCount={0}
                filtersOpen={false}
                nextActionsCount={3}
                nextGroupBy="none"
                focusSortBy="default"
                canToggleOtherSections
                collapseOtherSections
                onChangeGroupBy={vi.fn()}
                onChangeSortBy={vi.fn()}
                onToggleDetails={vi.fn()}
                onToggleFilters={vi.fn()}
                onToggleOtherSections={vi.fn()}
                resolveText={resolveText}
                showListDetails={false}
                t={t}
            />
        );
        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-card');
    });

    it('offers tag as a Focus grouping option', () => {
        const onChangeGroupBy = vi.fn();
        renderHeader({ onChangeGroupBy });

        selectToolbarOption('Group', 'Tags');

        expect(onChangeGroupBy).toHaveBeenCalledWith('tag');
    });


    it('names the details button by its action without also claiming a pressed state', () => {
        const { getByRole, rerender } = renderHeader();
        expect(getByRole('button', { name: 'Show details' })).not.toHaveAttribute('aria-pressed');

        rerender(
            <AgendaHeader
                filterCount={0}
                filtersOpen={false}
                nextActionsCount={3}
                nextGroupBy="none"
                focusSortBy="default"
                canToggleOtherSections
                collapseOtherSections
                onChangeGroupBy={vi.fn()}
                onChangeSortBy={vi.fn()}
                onToggleDetails={vi.fn()}
                onToggleFilters={vi.fn()}
                onToggleOtherSections={vi.fn()}
                resolveText={resolveText}
                showListDetails
                t={t}
            />
        );
        expect(getByRole('button', { name: 'Hide details' })).not.toHaveAttribute('aria-pressed');
    });

    it('names the section shortcut by its action without claiming a pressed state', () => {
        const { getByRole, rerender } = renderHeader();

        expect(getByRole('button', { name: 'Focus only' }))
            .not.toHaveAttribute('aria-pressed');

        rerender(
            <AgendaHeader
                filterCount={0}
                filtersOpen={false}
                nextActionsCount={3}
                nextGroupBy="none"
                focusSortBy="default"
                canToggleOtherSections
                collapseOtherSections={false}
                onChangeGroupBy={vi.fn()}
                onChangeSortBy={vi.fn()}
                onToggleDetails={vi.fn()}
                onToggleFilters={vi.fn()}
                onToggleOtherSections={vi.fn()}
                resolveText={resolveText}
                showListDetails={false}
                t={t}
            />
        );

        expect(getByRole('button', { name: 'Expand sections' }))
            .not.toHaveAttribute('aria-pressed');
    });

    it('disables the section shortcut when there are no sections to change', () => {
        const { getByRole } = renderHeader({
            canToggleOtherSections: false,
            collapseOtherSections: false,
        });

        expect(getByRole('button', { name: 'Expand sections' })).toBeDisabled();
    });


    it('renders its controls in the shared list-toolbar style', () => {
        const { container, getByRole } = renderHeader();

        const groupTrigger = getByRole('combobox', { name: 'Group' });
        expect(groupTrigger.className).toContain('h-9');
        expect(groupTrigger.className).toContain('rounded-lg');
        expect(groupTrigger).toHaveAttribute('title', 'Group');

        const buttons = [...container.querySelectorAll('button')];
        expect(buttons.length).toBeGreaterThan(0);
        buttons.forEach((button) => {
            expect(button.className).toContain('h-9');
            expect(button.className).toContain('rounded-lg');
            expect(button.className).not.toContain('rounded-full');
        });
    });

    it('keeps density out of the Focus toolbar', () => {
        const { queryByRole } = renderHeader();

        expect(queryByRole('button', { name: /Density:/ })).not.toBeInTheDocument();
    });
});
