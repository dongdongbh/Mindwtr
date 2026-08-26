import { fireEvent, render } from '@testing-library/react';
import { AREA_PRESET_COLORS } from '@mindwtr/core';
import { describe, expect, it, vi } from 'vitest';
import { AreaColorPicker } from './AreaColorPicker';

describe('AreaColorPicker', () => {
    it('applies a preset color selection', () => {
        const onChange = vi.fn();
        const { getByLabelText } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={onChange}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));
        fireEvent.click(getByLabelText('Area color: #10b981'));

        expect(onChange).toHaveBeenCalledWith('#10b981');
    });

    it('clears the color via the None option', () => {
        const onChange = vi.fn();
        const { getByLabelText } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={onChange}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));
        fireEvent.click(getByLabelText('None'));

        expect(onChange).toHaveBeenCalledWith(undefined);
    });

    it('does not call onChange when None is clicked while already unset', () => {
        const onChange = vi.fn();
        const { getByLabelText } = render(
            <AreaColorPicker
                onChange={onChange}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));
        fireEvent.click(getByLabelText('None'));

        expect(onChange).not.toHaveBeenCalled();
    });

    it('raises the open menu above manage panels', () => {
        const onChange = vi.fn();
        const { getByLabelText, getByTestId } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={onChange}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));

        expect(getByTestId('area-color-picker-root').className).toContain('z-50');
        expect(getByTestId('area-color-picker-menu').className).toContain('z-50');
    });

    it('offers every preset color, wrapped into a grid', () => {
        const { getByLabelText, getByTestId } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={vi.fn()}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));

        const menu = getByTestId('area-color-picker-menu');
        // None + one button per preset. jsdom cannot measure, so the wrap is
        // pinned as a declaration: a single flex row overflows past six colors.
        expect(menu.querySelectorAll('button')).toHaveLength(AREA_PRESET_COLORS.length + 1);
        expect(menu.className).toContain('grid-cols-7');
        expect(menu.className).not.toContain('flex gap-2');
    });

    it('offers a custom swatch that starts from the current color', () => {
        const { getByLabelText, getByTestId } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={vi.fn()}
                title="Area color"
                customLabel="Custom color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));

        const input = getByLabelText('Custom color') as HTMLInputElement;
        expect(input.type).toBe('color');
        expect(input.value).toBe('#3b82f6');
        // A preset is selected, so the custom cell stays the "pick something
        // else" affordance rather than claiming the selection.
        expect(getByTestId('area-color-picker-custom').className).not.toContain('border-foreground');
    });

    it('commits a custom color on change, not on every input event', () => {
        const onChange = vi.fn();
        const { getByLabelText } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={onChange}
                title="Area color"
                customLabel="Custom color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));
        const input = getByLabelText('Custom color') as HTMLInputElement;

        fireEvent.input(input, { target: { value: '#123456' } });
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.change(input, { target: { value: '#123456' } });
        expect(onChange).toHaveBeenCalledExactlyOnceWith('#123456');
    });

    it('marks the custom swatch selected for a non-preset color', () => {
        const { getByLabelText, getByTestId } = render(
            <AreaColorPicker
                value="#123456"
                onChange={vi.fn()}
                title="Area color"
                customLabel="Custom color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));

        const custom = getByTestId('area-color-picker-custom');
        expect(custom.className).toContain('border-foreground');
        expect(custom.getAttribute('style')).toContain('rgb(18, 52, 86)');
        expect((getByLabelText('Custom color') as HTMLInputElement).value).toBe('#123456');
        // No preset may claim the selection at the same time.
        expect(getByLabelText('Area color: #3b82f6').className).not.toContain('border-foreground');
    });
});
