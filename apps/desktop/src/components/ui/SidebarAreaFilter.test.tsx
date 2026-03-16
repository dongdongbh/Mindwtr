import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Area } from '@mindwtr/core';

import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '../../lib/area-filter';
import { SidebarAreaFilter } from './SidebarAreaFilter';

const areas: Area[] = [
    { id: 'a1', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
    { id: 'a2', name: 'Home', color: '#10b981', order: 1, createdAt: '', updatedAt: '' },
];

describe('SidebarAreaFilter', () => {
    it('shows all area options and calls onChange for selected items', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <SidebarAreaFilter
                areas={areas}
                value={AREA_FILTER_ALL}
                onChange={onChange}
                ariaLabel="Area filter"
                allAreasLabel="All areas"
                noAreaLabel="No area"
            />,
        );

        fireEvent.click(getByRole('button', { name: 'Area filter' }));
        const listbox = getByRole('listbox', { name: 'Area filter' });

        within(listbox).getByText('All areas');
        within(listbox).getByText('Work');
        within(listbox).getByText('Home');
        within(listbox).getByText('No area');

        fireEvent.click(within(listbox).getByText('Home'));
        expect(onChange).toHaveBeenCalledWith('a2');
    });

    it('supports selecting the no-area filter', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <SidebarAreaFilter
                areas={areas}
                value="a1"
                onChange={onChange}
                ariaLabel="Area filter"
                allAreasLabel="All areas"
                noAreaLabel="No area"
            />,
        );

        fireEvent.click(getByRole('button', { name: 'Area filter' }));
        fireEvent.click(within(getByRole('listbox', { name: 'Area filter' })).getByText('No area'));

        expect(onChange).toHaveBeenCalledWith(AREA_FILTER_NONE);
    });
});
