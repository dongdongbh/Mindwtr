import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewFiltersBar } from './ReviewFiltersBar';

describe('ReviewFiltersBar', () => {
    it('keeps the active filter on explicit primary contrast tokens', () => {
        render(
            <ReviewFiltersBar
                filterStatus="all"
                statusOptions={['inbox', 'next']}
                statusCounts={{ all: 2, inbox: 1, next: 1 }}
                onSelect={vi.fn()}
                t={(key) => ({
                    'common.all': 'All',
                    'status.inbox': 'Inbox',
                    'status.next': 'Next',
                })[key] ?? key}
            />
        );

        const activeFilter = screen.getByRole('button', { name: 'All (2)' });
        const inactiveFilter = screen.getByRole('button', { name: 'Inbox (1)' });
        const activeFilterStyle = activeFilter.getAttribute('style') ?? '';

        expect(activeFilterStyle).toContain('background-color: hsl(var(--primary));');
        expect(activeFilterStyle).toContain('border-color: hsl(var(--primary));');
        expect(activeFilterStyle).toContain('color: hsl(var(--primary-foreground));');
        expect(within(inactiveFilter).getByText('(1)')).toHaveClass('text-muted-foreground');
    });
});
