import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Area } from '@mindwtr/core';

import { AREA_FILTER_NONE } from '@mindwtr/core';
import { SidebarAreaFilter } from './SidebarAreaFilter';

const areas: Area[] = [
    { id: 'a1', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
    { id: 'a2', name: 'Home', color: '#10b981', order: 1, createdAt: '', updatedAt: '' },
];

const renderFilter = (
    selection: { included: string[]; excluded: string[] },
    onChange = vi.fn(),
    collapsed = false,
) => ({
    onChange,
    ...render(
        <SidebarAreaFilter
            areas={areas}
            selection={selection}
            onChange={onChange}
            ariaLabel="Area filter"
            allAreasLabel="All areas"
            noAreaLabel="No area"
            excludedLabel="Excluded"
            collapsed={collapsed}
        />,
    ),
});

describe('SidebarAreaFilter', () => {
    it('shows all area options and includes the clicked one', () => {
        const { getByRole, onChange } = renderFilter({ included: [], excluded: [] });

        fireEvent.click(getByRole('button', { name: /^Area filter:/ }));
        const group = getByRole('group', { name: 'Area filter' });

        within(group).getByText('All areas');
        within(group).getByText('Work');
        within(group).getByText('Home');
        within(group).getByText('No area');

        fireEvent.click(within(group).getByText('Home'));
        expect(onChange).toHaveBeenCalledWith({ included: ['a2'], excluded: [] });
    });

    it('cycles a row from included to excluded to unselected', () => {
        const onChange = vi.fn();
        const { getByRole, rerender } = renderFilter({ included: ['a1'], excluded: [] }, onChange);

        fireEvent.click(getByRole('button', { name: /^Area filter:/ }));
        fireEvent.click(within(getByRole('group', { name: 'Area filter' })).getByText('Work'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: ['a1'] });

        rerender(
            <SidebarAreaFilter
                areas={areas}
                selection={{ included: [], excluded: ['a1'] }}
                onChange={onChange}
                ariaLabel="Area filter"
                allAreasLabel="All areas"
                noAreaLabel="No area"
                excludedLabel="Excluded"
            />,
        );
        const excludedRow = getByRole('button', { name: 'Work (Excluded)' });
        expect(excludedRow).toHaveAttribute('aria-pressed', 'mixed');

        fireEvent.click(excludedRow);
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: [] });
    });

    it('keeps several areas selected at once', () => {
        const { getByRole, onChange } = renderFilter({ included: ['a1'], excluded: [] });

        fireEvent.click(getByRole('button', { name: /^Area filter:/ }));
        fireEvent.click(within(getByRole('group', { name: 'Area filter' })).getByText('Home'));

        expect(onChange).toHaveBeenCalledWith({ included: ['a1', 'a2'], excluded: [] });
    });

    it('supports selecting the no-area filter', () => {
        const { getByRole, onChange } = renderFilter({ included: ['a1'], excluded: [] });

        fireEvent.click(getByRole('button', { name: /^Area filter:/ }));
        fireEvent.click(within(getByRole('group', { name: 'Area filter' })).getByText('No area'));

        expect(onChange).toHaveBeenCalledWith({ included: ['a1', AREA_FILTER_NONE], excluded: [] });
    });

    it('clears the selection from the all-areas row', () => {
        const { getByRole, onChange } = renderFilter({ included: ['a1'], excluded: ['a2'] });

        fireEvent.click(getByRole('button', { name: /^Area filter:/ }));
        fireEvent.click(within(getByRole('group', { name: 'Area filter' })).getByText('All areas'));

        expect(onChange).toHaveBeenCalledWith({ included: [], excluded: [] });
    });

    it('labels the trigger with the single selected area and a count beyond that', () => {
        const { getByRole, unmount } = renderFilter({ included: ['a1'], excluded: [] });
        getByRole('button', { name: /^Area filter:/ });
        within(getByRole('button', { name: /^Area filter:/ })).getByText('Work');
        unmount();

        const multi = renderFilter({ included: ['a1'], excluded: ['a2'] });
        within(multi.getByRole('button', { name: /^Area filter:/ })).getByText('Work · Excluded: Home');
        expect(multi.getByRole('button', { name: /^Area filter:/ })).toHaveAttribute('title', 'Area filter: Work · Excluded: Home');
    });

    it('summarizes multiple areas and resets without opening the selector', () => {
        const { getByRole, onChange } = renderFilter({ included: ['a1', 'a2'], excluded: [AREA_FILTER_NONE] });
        const trigger = getByRole('button', { name: 'Area filter: Work, Home · Excluded: No area' });
        within(trigger).getByText('Work + 1 · Excluded: No area');
        fireEvent.click(getByRole('button', { name: 'All areas' }));
        expect(onChange).toHaveBeenCalledWith({ included: [], excluded: [] });
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens from the collapsed sidebar trigger', () => {
        const { getByRole, onChange } = renderFilter({ included: ['a1'], excluded: [] }, vi.fn(), true);

        fireEvent.click(getByRole('button', { name: 'Area filter: Work' }));
        fireEvent.click(within(getByRole('group', { name: 'Area filter' })).getByText('Home'));

        expect(onChange).toHaveBeenCalledWith({ included: ['a1', 'a2'], excluded: [] });
    });

    it('moves focus with the arrow keys and closes on Escape', () => {
        const { getByRole, queryByRole } = renderFilter({ included: [], excluded: [] });

        fireEvent.click(getByRole('button', { name: /^Area filter:/ }));
        const group = getByRole('group', { name: 'Area filter' });
        fireEvent.keyDown(group, { key: 'ArrowDown' });
        expect(document.activeElement?.textContent).toContain('All areas');
        fireEvent.keyDown(group, { key: 'ArrowDown' });
        expect(document.activeElement?.textContent).toContain('Work');

        fireEvent.keyDown(group, { key: 'Escape' });
        expect(queryByRole('group', { name: 'Area filter' })).toBeNull();
    });
});
