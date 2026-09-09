import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Area } from '@mindwtr/core';

import { AreaSelector } from './AreaSelector';

const areas: Area[] = [
    { id: 'a1', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
    { id: 'a2', name: 'Home', color: '#10b981', order: 1, createdAt: '', updatedAt: '' },
];

describe('AreaSelector', () => {
    it('offers distinct Keep and No area choices and supports a disabled field label', () => {
        const onChange = vi.fn();
        const { getByRole, rerender } = render(
            <AreaSelector
                areas={areas}
                value="__KEEP__"
                onChange={onChange}
                leadingOption={{ value: '__KEEP__', label: 'Keep area' }}
                noAreaValue="__NONE__"
                noAreaLabel="No area"
                ariaLabel="Area"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Area' }));
        expect(getByRole('option', { name: 'Keep area' })).toHaveAttribute('aria-selected', 'true');
        fireEvent.click(getByRole('option', { name: 'No area' }));
        expect(onChange).toHaveBeenCalledWith('__NONE__');

        rerender(
            <AreaSelector
                areas={areas}
                value="__KEEP__"
                onChange={onChange}
                ariaLabel="Area"
                disabled
            />
        );
        expect(getByRole('button', { name: 'Area' })).toBeDisabled();
    });

    it('renders the dropdown in a body portal so task rows cannot clip it', () => {
        const { getByRole } = render(
            <AreaSelector
                areas={areas}
                value=""
                onChange={vi.fn()}
                placeholder="Select area"
                searchPlaceholder="Search areas"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select area' }));

        const dropdown = getByRole('listbox', { name: 'Select area' }).closest('[data-selector-dropdown="true"]');
        expect(dropdown).toHaveClass('z-[70]');
        expect(dropdown?.parentElement).toBe(document.body);
        expect(dropdown).toHaveStyle({ position: 'fixed' });
    });

    it('opens the dropdown with ArrowDown on the closed trigger', () => {
        const { getByRole, queryByRole } = render(
            <AreaSelector
                areas={areas}
                value=""
                onChange={vi.fn()}
                placeholder="Select area"
                searchPlaceholder="Search areas"
            />
        );

        expect(queryByRole('listbox', { name: 'Select area' })).not.toBeInTheDocument();

        const trigger = getByRole('button', { name: 'Select area' });
        trigger.focus();
        fireEvent.keyDown(trigger, { key: 'ArrowDown' });

        expect(getByRole('listbox', { name: 'Select area' })).toBeInTheDocument();
    });

    it('returns focus to the trigger after selecting an option with the keyboard', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <AreaSelector
                areas={areas}
                value=""
                onChange={onChange}
                placeholder="Select area"
                searchPlaceholder="Search areas"
            />
        );

        const trigger = getByRole('button', { name: 'Select area' });
        fireEvent.click(trigger);
        fireEvent.click(getByRole('option', { name: 'Work' }));

        expect(onChange).toHaveBeenCalledWith('a1');
        expect(document.activeElement).toBe(trigger);
    });

    it('closes only the dropdown on Escape, returning focus to the trigger', () => {
        const { getByRole, queryByRole } = render(
            <AreaSelector
                areas={areas}
                value=""
                onChange={vi.fn()}
                placeholder="Select area"
                searchPlaceholder="Search areas"
            />
        );

        const trigger = getByRole('button', { name: 'Select area' });
        fireEvent.click(trigger);
        const search = getByRole('textbox', { name: 'Search areas' });
        fireEvent.keyDown(search, { key: 'Escape' });

        expect(queryByRole('listbox', { name: 'Select area' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
    });
});
