import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Area, AreaFilterSelection } from '@mindwtr/core';

import { AREA_FILTER_NONE } from '@mindwtr/core';
import { SidebarAreaChips } from './SidebarAreaChips';

const areas: Area[] = [
    { id: 'a1', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
    { id: 'a2', name: 'Home', color: '#10b981', order: 1, createdAt: '', updatedAt: '' },
];
const allIds = ['a1', 'a2', AREA_FILTER_NONE];

const renderChips = (
    selection: AreaFilterSelection,
    { collapsed = false, areaList = areas }: { collapsed?: boolean; areaList?: Area[] } = {},
) => {
    const onChange = vi.fn();
    const result = render(
        <SidebarAreaChips
            areas={areaList}
            selection={selection}
            onChange={onChange}
            ariaLabel="Area filter"
            allAreasLabel="All areas"
            noAreaLabel="No area"
            excludedLabel="Excluded"
            selectAllLabel="Select all"
            excludeAllLabel="Exclude all"
            collapsed={collapsed}
        />,
    );
    return { onChange, ...result };
};

const chip = (group: HTMLElement, name: string) => within(group).getByRole('button', { name });

describe('SidebarAreaChips', () => {
    it('shows every area and No area as pressed chips when nothing is filtered', () => {
        const { getByRole } = renderChips({ included: [], excluded: [] });
        const group = getByRole('group', { name: 'Area filter' });

        for (const name of ['Work', 'Home', 'No area']) {
            expect(chip(group, name)).toHaveAttribute('aria-pressed', 'true');
        }
        expect(chip(group, 'Select all')).toBeDisabled();
        expect(chip(group, 'Exclude all')).toBeEnabled();
    });

    it('hides a clicked area and shows it again', () => {
        const { getByRole, onChange, rerender } = renderChips({ included: [], excluded: [] });
        fireEvent.click(chip(getByRole('group', { name: 'Area filter' }), 'Work'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: ['a1'] });

        rerender(
            <SidebarAreaChips
                areas={areas}
                selection={{ included: [], excluded: ['a1'] }}
                onChange={onChange}
                ariaLabel="Area filter"
                allAreasLabel="All areas"
                noAreaLabel="No area"
                excludedLabel="Excluded"
                selectAllLabel="Select all"
                excludeAllLabel="Exclude all"
            />,
        );
        const group = getByRole('group', { name: 'Area filter' });
        expect(chip(group, 'Work')).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(chip(group, 'Work'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: [] });
    });

    it('marks only the included area as visible', () => {
        const { getByRole, onChange } = renderChips({ included: ['a2'], excluded: [] });
        const group = getByRole('group', { name: 'Area filter' });

        expect(chip(group, 'Work')).toHaveAttribute('aria-pressed', 'false');
        expect(chip(group, 'Home')).toHaveAttribute('aria-pressed', 'true');
        expect(chip(group, 'No area')).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(chip(group, 'Work'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: [AREA_FILTER_NONE] });
    });

    it('selects all and excludes all', () => {
        const { getByRole, onChange } = renderChips({ included: [], excluded: ['a1'] });
        const group = getByRole('group', { name: 'Area filter' });

        fireEvent.click(chip(group, 'Select all'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: [] });
        fireEvent.click(chip(group, 'Exclude all'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: allIds });
    });

    it('disables Exclude all once every chip is off', () => {
        const { getByRole } = renderChips({ included: [], excluded: allIds });
        const group = getByRole('group', { name: 'Area filter' });

        for (const name of ['Work', 'Home', 'No area']) {
            expect(chip(group, name)).toHaveAttribute('aria-pressed', 'false');
        }
        expect(chip(group, 'Exclude all')).toBeDisabled();
        expect(chip(group, 'Select all')).toBeEnabled();
    });

    it('keeps a togglable No area chip without areas', () => {
        const { getByRole, onChange } = renderChips({ included: [], excluded: [] }, { areaList: [] });
        const group = getByRole('group', { name: 'Area filter' });

        fireEvent.click(chip(group, 'No area'));
        expect(onChange).toHaveBeenLastCalledWith({ included: [], excluded: [AREA_FILTER_NONE] });
    });

    it('opens the cloud from the collapsed sidebar and closes it on Escape or an outside click', () => {
        const { getByRole, queryByRole } = renderChips({ included: [], excluded: allIds }, { collapsed: true });
        const trigger = getByRole('button', { name: 'Area filter: Excluded: Work, Home, No area' });
        expect(trigger.querySelector('.bg-primary')).not.toBeNull();
        expect(queryByRole('group', { name: 'Area filter' })).toBeNull();

        fireEvent.click(trigger);
        const group = getByRole('group', { name: 'Area filter' });
        fireEvent.keyDown(within(group).getByRole('button', { name: 'Work' }), { key: 'Escape' });
        expect(queryByRole('group', { name: 'Area filter' })).toBeNull();
        expect(trigger).toHaveFocus();

        fireEvent.click(trigger);
        fireEvent.mouseDown(document.body);
        expect(queryByRole('group', { name: 'Area filter' })).toBeNull();
    });

    it('summarizes an unfiltered state on the collapsed trigger', () => {
        const { getByRole } = renderChips({ included: [], excluded: [] }, { collapsed: true });
        const trigger = getByRole('button', { name: 'Area filter: All areas' });
        expect(trigger.querySelector('.bg-primary')).toBeNull();
    });
});
