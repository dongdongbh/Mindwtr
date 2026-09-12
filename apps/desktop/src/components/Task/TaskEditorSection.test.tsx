import { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskEditorSection } from './TaskEditorSection';

function Section({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
        <TaskEditorSection title="Details" count={0} open={open} onToggle={() => setOpen(!open)}>
            <textarea aria-label="Description" />
        </TaskEditorSection>
    );
}

describe('TaskEditorSection', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([false, true])('does not scroll on initial opening or collapse (initially open: %s)', async (initiallyOpen) => {
        const scroll = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
        const view = render(<Section initiallyOpen={initiallyOpen} />);
        if (initiallyOpen) fireEvent.click(view.getByRole('button', { name: 'Details' }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(scroll).not.toHaveBeenCalled();
    });

    it.each([100, 600])('reveals a manually opened section of height %s without losing header focus', async (height) => {
        const scroll = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
        const view = render(<div style={{ overflowY: 'auto' }}><Section /></div>);
        const header = view.getByRole('button', { name: 'Details' });
        const section = header.parentElement!;
        Object.defineProperty(section.parentElement, 'clientHeight', { configurable: true, value: 400 });
        vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect);
        header.focus();
        fireEvent.click(header);

        await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
        expect(scroll.mock.instances[0]).toBe(height <= 400 ? section : header);
        expect(scroll).toHaveBeenCalledWith({ block: height <= 400 ? 'nearest' : 'start', behavior: 'instant' });
        expect(header).toHaveFocus();
        expect(document.getElementById(header.getAttribute('aria-controls')!)).toContainElement(view.getByRole('textbox'));
    });
});
