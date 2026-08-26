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
        // None + one button per preset + the custom swatch.
        expect(menu.querySelectorAll('button')).toHaveLength(AREA_PRESET_COLORS.length + 2);
        expect(menu.className).toContain('grid-cols-7');
        expect(menu.className).not.toContain('flex gap-2');
    });

    it('marks the custom swatch selected for a non-preset color', () => {
        const { getByLabelText, getByTestId } = render(
            <AreaColorPicker value="#123456" onChange={vi.fn()} title="Area color" />,
        );

        fireEvent.click(getByLabelText('Area color'));

        const custom = getByTestId('area-color-picker-custom');
        expect(custom.className).toContain('border-foreground');
        expect(custom.getAttribute('style')).toContain('rgb(18, 52, 86)');
        // No preset may claim the selection at the same time.
        expect(getByLabelText('Area color: #3b82f6').className).not.toContain('border-foreground');
    });

    describe('custom color panel', () => {
        // jsdom serializes inline colors as rgb().
        const rgb = (hex: string) =>
            `rgb(${[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;

        const openPanel =(props: Partial<Parameters<typeof AreaColorPicker>[0]> = {}) => {
            const onChange = vi.fn();
            const utils = render(
                <AreaColorPicker
                    value="#3b82f6"
                    onChange={onChange}
                    title="Area color"
                    {...props}
                />,
            );
            fireEvent.click(utils.getByLabelText('Area color'));
            fireEvent.click(utils.getByLabelText('Custom color'));
            return { ...utils, onChange };
        };

        it('toggles the panel from the custom swatch without committing anything', () => {
            const { getByLabelText, getByTestId, queryByTestId, onChange } = openPanel();

            expect(getByTestId('area-color-picker-panel')).toBeTruthy();
            expect(getByLabelText('Custom color').getAttribute('aria-expanded')).toBe('true');
            // Seeded from the current color.
            expect((getByLabelText('Area color: Custom color') as HTMLInputElement).value).toBe(
                '#3b82f6',
            );

            fireEvent.click(getByLabelText('Custom color'));
            expect(queryByTestId('area-color-picker-panel')).toBeNull();
            expect(onChange).not.toHaveBeenCalled();
        });

        it('previews a color picked on the surface without committing it', () => {
            const { getByTestId, getByLabelText, onChange } = openPanel();

            const surface = getByTestId('area-color-picker-surface');
            surface.getBoundingClientRect = () =>
                ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
            // Full saturation, full value at the current hue (blue).
            fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 0 });

            const hex = (getByLabelText('Area color: Custom color') as HTMLInputElement).value;
            expect(hex).toMatch(/^#[0-9a-f]{6}$/);
            expect(hex).not.toBe('#3b82f6');
            expect(getByTestId('area-color-picker-preview').getAttribute('style')).toContain(rgb(hex));
            expect(onChange).not.toHaveBeenCalled();
        });

        it('drives the whole surface from the hue track', () => {
            const { getByTestId, getByLabelText } = openPanel();

            const hue = getByTestId('area-color-picker-hue');
            hue.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 12 }) as DOMRect;
            fireEvent.pointerDown(hue, { button: 0, clientX: 0, clientY: 6 });

            // Hue 0 keeps the saturation/value of #3b82f6, so it lands on a red.
            const hexField = getByLabelText('Area color: Custom color') as HTMLInputElement;
            expect(hexField.value).toBe('#f63b3b');
        });

        it('commits the picked color once on apply and closes the popover', () => {
            const { getByLabelText, getByText, queryByTestId, onChange } = openPanel({
                applyLabel: 'OK',
            });

            fireEvent.change(getByLabelText('Area color: Custom color'), {
                target: { value: '#ABCDEF' },
            });
            expect(onChange).not.toHaveBeenCalled();

            fireEvent.click(getByText('OK'));

            expect(onChange).toHaveBeenCalledExactlyOnceWith('#abcdef');
            expect(queryByTestId('area-color-picker-menu')).toBeNull();
        });

        it('accepts a hex typed without the leading hash', () => {
            const { getByLabelText, getByText, onChange } = openPanel({ applyLabel: 'OK' });

            fireEvent.change(getByLabelText('Area color: Custom color'), {
                target: { value: 'abcdef' },
            });
            fireEvent.click(getByText('OK'));

            expect(onChange).toHaveBeenCalledExactlyOnceWith('#abcdef');
        });

        it('cannot apply an invalid hex', () => {
            const { getByLabelText, getByText, onChange } = openPanel({ applyLabel: 'OK' });

            fireEvent.change(getByLabelText('Area color: Custom color'), {
                target: { value: '#12345' },
            });

            const apply = getByText('OK') as HTMLButtonElement;
            expect(apply.disabled).toBe(true);
            fireEvent.click(apply);
            expect(onChange).not.toHaveBeenCalled();
        });

        it('commits nothing on cancel, on Escape, or on an outside click', () => {
            const { getByLabelText, getByText, queryByTestId, onChange } = openPanel({
                cancelLabel: 'Cancel',
            });
            const hexField = () => getByLabelText('Area color: Custom color');

            fireEvent.change(hexField(), { target: { value: '#abcdef' } });
            fireEvent.click(getByText('Cancel'));
            expect(queryByTestId('area-color-picker-panel')).toBeNull();

            fireEvent.click(getByLabelText('Custom color'));
            fireEvent.change(hexField(), { target: { value: '#abcdef' } });
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(queryByTestId('area-color-picker-menu')).toBeNull();

            fireEvent.click(getByLabelText('Area color'));
            fireEvent.click(getByLabelText('Custom color'));
            fireEvent.change(hexField(), { target: { value: '#abcdef' } });
            fireEvent.mouseDown(document.body);
            expect(queryByTestId('area-color-picker-menu')).toBeNull();

            expect(onChange).not.toHaveBeenCalled();
        });

        it('reopens the panel seeded from the current color, not the last draft', () => {
            const { getByLabelText, getByText } = openPanel({ cancelLabel: 'Cancel' });

            fireEvent.change(getByLabelText('Area color: Custom color'), {
                target: { value: '#abcdef' },
            });
            fireEvent.click(getByText('Cancel'));
            fireEvent.click(getByLabelText('Custom color'));

            expect(
                (getByLabelText('Area color: Custom color') as HTMLInputElement).value,
            ).toBe('#3b82f6');
        });
    });
});
