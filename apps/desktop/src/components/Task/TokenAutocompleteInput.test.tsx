import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TokenAutocompleteInput } from './TokenAutocompleteInput';

describe('TokenAutocompleteInput', () => {
    it.each([
        { key: 'Enter', isComposing: true },
        { key: 'Enter', keyCode: 229 },
        { key: 'Process' },
    ])('keeps IME keys out of consumer submit handlers: %j', (keyEvent) => {
        const onKeyDown = vi.fn();
        const onChange = vi.fn();
        const { getByRole } = render(
            <TokenAutocompleteInput value="中文" suggestions={[]} prefix="@" ariaLabel="Contexts" onChange={onChange} onKeyDown={onKeyDown} />
        );
        const input = getByRole('combobox');

        fireEvent.keyDown(input, keyEvent);
        expect(onKeyDown).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onKeyDown).toHaveBeenCalledOnce();
    });

    it('does not accept a substring match on Enter until an option is selected', async () => {
        const onChange = vi.fn();
        const onKeyDown = vi.fn();
        const { findByRole, getByRole } = render(
            <TokenAutocompleteInput
                value="@home"
                onChange={onChange}
                onKeyDown={onKeyDown}
                suggestions={['@home-office']}
                prefix="@"
                ariaLabel="Contexts"
            />
        );
        const input = getByRole('combobox', { name: 'Contexts' }) as HTMLInputElement;
        input.setSelectionRange(5, 5);

        fireEvent.keyUp(input, { key: 'e' });
        await findByRole('option', { name: '@home-office' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).not.toHaveBeenCalled();
        expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).toHaveBeenCalledWith('@home-office, ');
    });

    it('does not restore focus after the user has moved to another field', async () => {
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        });

        try {
            const { findByRole, getByRole } = render(
                <>
                    <TokenAutocompleteInput
                        value="@home"
                        onChange={vi.fn()}
                        suggestions={['@home-office']}
                        prefix="@"
                        ariaLabel="Contexts"
                    />
                    <button type="button">Next field</button>
                </>
            );
            const input = getByRole('combobox', { name: 'Contexts' }) as HTMLInputElement;
            const nextField = getByRole('button', { name: 'Next field' });
            input.focus();
            input.setSelectionRange(5, 5);
            fireEvent.keyUp(input, { key: 'e' });
            await findByRole('option', { name: '@home-office' });
            fireEvent.keyDown(input, { key: 'ArrowDown' });
            fireEvent.keyDown(input, { key: 'Enter' });

            nextField.focus();
            animationFrames.splice(0).forEach((callback) => callback(0));

            expect(document.activeElement).toBe(nextField);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
