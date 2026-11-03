import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { ConfirmModal } from './ConfirmModal';

describe('ConfirmModal', () => {
    it('renders via portal outside transformed ancestors', () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const { container, getByRole } = render(
            <div style={{ transform: 'translateY(50px)' }}>
                <ConfirmModal
                    isOpen
                    title="Delete task"
                    description="Delete selected tasks?"
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                />
            </div>,
        );

        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(getByRole('dialog')).toBeInTheDocument();
    });

    it('supports confirm/cancel actions', () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const { getByText } = render(
            <ConfirmModal
                isOpen
                title="Delete task"
                description="Delete selected tasks?"
                confirmLabel="Delete"
                cancelLabel="Cancel"
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        fireEvent.click(getByText('Delete'));
        fireEvent.click(getByText('Cancel'));

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('preserves line breaks in multiline descriptions', () => {
        const { getByText } = render(
            <ConfirmModal
                isOpen
                title="Import data"
                description={'Import 10 tasks?\n\n- Project A: 4\n- Project B: 6'}
                confirmLabel="Import"
                cancelLabel="Cancel"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        expect(getByText(/Import 10 tasks\?/)).toHaveClass('whitespace-pre-line');
    });

    it('keeps the buttons reachable when the title is very long (#947)', () => {


        const { getByRole } = render(
            <ConfirmModal
                isOpen
                title={'Paragraph pasted as a task title. '.repeat(200)}
                description="This cannot be undone."
                confirmLabel="Delete"
                cancelLabel="Cancel"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        const scroller = getByRole('heading').parentElement;
        expect(scroller?.className).toContain('overflow-y-auto');
        expect(scroller?.contains(getByRole('button', { name: 'Delete' }))).toBe(false);
        expect(scroller?.parentElement?.className).toMatch(/\bmax-h-/);
    });
});
