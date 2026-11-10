import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolbarSelect, type ToolbarSelectOption } from './ToolbarSelect';

const OPTIONS: ToolbarSelectOption[] = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', disabled: true },
    { value: 'c', label: 'Gamma' },
];

function renderSelect(overrides: { value?: string; onChange?: (value: string) => void; active?: boolean } = {}) {
    const onChange = overrides.onChange ?? vi.fn();
    const result = render(
        <ToolbarSelect
            label="Sort"
            value={overrides.value ?? 'a'}
            options={OPTIONS}
            onChange={onChange}
            active={overrides.active}
        />
    );
    return { ...result, onChange };
}

const openListbox = () => {
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    fireEvent.click(trigger);
    return trigger;
};

const focusedOptionLabel = () => (document.activeElement as HTMLElement | null)?.textContent;

describe('ToolbarSelect presentations', () => {
    it('keeps the compact label visible and exposes the full selected value on hover', () => {
        const selectedLabel = 'Voraussichtliches Abschlussdatum des Projekts';
        render(
            <ToolbarSelect
                compact
                label="Sortieren"
                value="date"
                options={[{ value: 'date', label: selectedLabel }]}
                onChange={vi.fn()}
            />
        );

        const trigger = screen.getByRole('combobox', { name: 'Sortieren' });
        expect(trigger).toHaveTextContent(`Sortieren${selectedLabel}`);
        expect(trigger).toHaveAttribute('title', `Sortieren: ${selectedLabel}`);
        fireEvent.click(trigger);
        expect(screen.getByRole('listbox', { name: 'Sortieren' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: selectedLabel })).toHaveAttribute('aria-selected', 'true');
    });

    it('preserves the labelled default presentation', () => {
        renderSelect();

        const trigger = screen.getByRole('combobox', { name: 'Sort' });
        expect(trigger).toHaveTextContent('SortAlpha');
        expect(trigger).not.toHaveAttribute('title');
    });

    it('keeps pills value-only and does not emit an unchanged selection', () => {
        const onChange = vi.fn();
        render(<ToolbarSelect pill label="Status" value="a" options={OPTIONS} onChange={onChange} />);

        const trigger = screen.getByRole('combobox', { name: 'Status' });
        expect(trigger).toHaveTextContent(/^Alpha$/);
        expect(trigger.querySelector('svg')).toBeNull();
        expect(trigger).not.toHaveAttribute('title');
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('option', { name: 'Alpha' }));
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger).toHaveFocus();
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('option', { name: 'Gamma' }));
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith('c');
    });
});

describe('ToolbarSelect keyboard interaction', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('highlights only when its caller marks the current value non-default', () => {
        const view = renderSelect();
        const trigger = screen.getByRole('combobox', { name: 'Sort' });

        expect(trigger).toHaveClass('bg-card');
        view.rerender(
            <ToolbarSelect
                active
                label="Sort"
                value="a"
                options={OPTIONS}
                onChange={view.onChange}
            />
        );
        expect(trigger).toHaveClass('bg-primary/10');
    });

    it('focuses the selected option on open and starts arrow navigation there', () => {
        renderSelect({ value: 'c' });

        openListbox();

        expect(focusedOptionLabel()).toBe('Gamma');
    });

    it('moves focus with arrows, skipping disabled options and wrapping around', () => {
        renderSelect({ value: 'a' });
        openListbox();
        const listbox = screen.getByRole('listbox', { name: 'Sort' });

        expect(focusedOptionLabel()).toBe('Alpha');


        fireEvent.keyDown(listbox, { key: 'ArrowDown' });
        expect(focusedOptionLabel()).toBe('Gamma');


        fireEvent.keyDown(listbox, { key: 'ArrowDown' });
        expect(focusedOptionLabel()).toBe('Alpha');


        fireEvent.keyDown(listbox, { key: 'ArrowUp' });
        expect(focusedOptionLabel()).toBe('Gamma');
    });

    it('selects the focused option with Enter and closes, refocusing the trigger', () => {
        const { onChange } = renderSelect({ value: 'a' });
        const trigger = openListbox();
        const listbox = screen.getByRole('listbox', { name: 'Sort' });

        fireEvent.keyDown(listbox, { key: 'ArrowDown' });
        fireEvent.keyDown(listbox, { key: 'Enter' });

        expect(onChange).toHaveBeenCalledWith('c');
        expect(screen.queryByRole('listbox', { name: 'Sort' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
    });

    it('selects the focused option with Space', () => {
        const { onChange } = renderSelect({ value: 'a' });
        openListbox();
        const listbox = screen.getByRole('listbox', { name: 'Sort' });

        fireEvent.keyDown(listbox, { key: ' ' });

        expect(onChange).toHaveBeenCalledWith('a');
        expect(screen.queryByRole('listbox', { name: 'Sort' })).not.toBeInTheDocument();
    });

    it('does not select a disabled option that somehow holds focus', () => {
        const { onChange } = renderSelect({ value: 'a' });
        openListbox();
        const listbox = screen.getByRole('listbox', { name: 'Sort' });
        screen.getByRole('option', { name: 'Beta' }).focus();

        fireEvent.keyDown(listbox, { key: 'Enter' });

        expect(onChange).not.toHaveBeenCalled();
    });

    it('closes on Escape without selecting and returns focus to the trigger', () => {
        const { onChange } = renderSelect({ value: 'a' });
        const trigger = openListbox();
        const listbox = screen.getByRole('listbox', { name: 'Sort' });

        fireEvent.keyDown(listbox, { key: 'Escape' });

        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByRole('listbox', { name: 'Sort' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
    });

    it('closes on Tab and returns focus to the trigger so focus can move on naturally', () => {
        const { onChange } = renderSelect({ value: 'a' });
        const trigger = openListbox();
        const listbox = screen.getByRole('listbox', { name: 'Sort' });

        fireEvent.keyDown(listbox, { key: 'Tab' });

        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByRole('listbox', { name: 'Sort' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
    });

    it('does not steal focus when the value changes while the popup is open', () => {
        function Harness() {
            const [value, setValue] = useState('a');
            return (
                <div>
                    <button type="button" onClick={() => setValue('c')}>
                        external change
                    </button>
                    <ToolbarSelect label="Sort" value={value} options={OPTIONS} onChange={vi.fn()} />
                </div>
            );
        }
        render(<Harness />);

        fireEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
        expect(focusedOptionLabel()).toBe('Alpha');


        fireEvent.click(screen.getByRole('button', { name: 'external change' }));

        expect(focusedOptionLabel()).toBe('Alpha');
        expect(screen.getByRole('option', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
    });

    it('keeps consumed keys from reaching a window-level keydown listener', () => {
        const windowKeyDown = vi.fn();
        window.addEventListener('keydown', windowKeyDown);

        try {
            renderSelect({ value: 'a' });
            openListbox();
            const listbox = screen.getByRole('listbox', { name: 'Sort' });

            fireEvent.keyDown(listbox, { key: 'ArrowDown' });
            fireEvent.keyDown(listbox, { key: 'Escape' });

            expect(windowKeyDown).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', windowKeyDown);
        }
    });
});
