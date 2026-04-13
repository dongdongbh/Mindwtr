import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
    it('renders children and defaults to type=button', () => {
        const { getByRole } = render(<Button>Save</Button>);
        const button = getByRole('button', { name: 'Save' }) as HTMLButtonElement;
        expect(button.type).toBe('button');
    });

    it('forwards ref to the underlying button element', () => {
        const ref = createRef<HTMLButtonElement>();
        render(<Button ref={ref}>Save</Button>);
        expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    });

    it('disables the button and announces aria-busy while loading', () => {
        const handleClick = vi.fn();
        const { getByRole } = render(
            <Button loading onClick={handleClick}>
                Save
            </Button>,
        );
        const button = getByRole('button', { name: 'Save' });
        expect(button).toBeDisabled();
        expect(button.getAttribute('aria-busy')).toBe('true');
        fireEvent.click(button);
        expect(handleClick).not.toHaveBeenCalled();
    });

    it('applies variant, size, and fullWidth class tokens', () => {
        const { getByRole } = render(
            <Button variant="destructive" size="lg" fullWidth>
                Delete
            </Button>,
        );
        const button = getByRole('button', { name: 'Delete' });
        expect(button.className).toContain('bg-destructive');
        expect(button.className).toContain('h-10');
        expect(button.className).toContain('w-full');
    });

    it('merges custom className over defaults via cn/twMerge', () => {
        const { getByRole } = render(
            <Button className="bg-emerald-500">Custom</Button>,
        );
        const button = getByRole('button', { name: 'Custom' });
        expect(button.className).toContain('bg-emerald-500');
        // twMerge should drop the base bg-primary utility (the hover variant stays).
        expect(button.className).not.toMatch(/(^|\s)bg-primary(\s|$)/);
    });
});
