import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ListFiltersPanel } from './ListFiltersPanel';

const translations: Record<string, string> = {
    'filters.clear': 'Clear',
    'filters.contexts': 'Contexts & tags',
    'filters.excluded': 'Excluded',
    'filters.hide': 'Hide',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'filters.timeEstimate': 'Time estimate',
    'priority.urgent': 'Urgent priority',
};

const t = (key: string) => translations[key] ?? key;

const createProps = (overrides: Partial<Parameters<typeof ListFiltersPanel>[0]> = {}): Parameters<typeof ListFiltersPanel>[0] => ({
    allTokens: ['@home'],
    formatEstimate: () => '30m',
    hasFilters: false,
    onClearFilters: vi.fn(),
    onToggleEstimate: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleToken: vi.fn(),
    priorityOptions: ['urgent'],
    selectedPriorities: [],
    selectedTimeEstimates: [],
    selectedTokens: [],
    excludedTokens: [],
    showPriorityFilters: false,
    showTimeEstimateFilters: false,
    t,
    timeEstimateOptions: ['30min'],
    tokenCounts: { '@home': 1 },
    ...overrides,
});

describe('ListFiltersPanel', () => {
    it('hides optional metadata filters until the current list uses those fields', () => {
        render(<ListFiltersPanel {...createProps()} />);

        expect(screen.getByText('Contexts & tags')).toBeInTheDocument();
        expect(screen.queryByText('Urgent priority')).not.toBeInTheDocument();
        expect(screen.queryByText('Time estimate')).not.toBeInTheDocument();
    });

    it('shows optional metadata filters when the current list uses those fields', () => {
        render(<ListFiltersPanel {...createProps({
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
        })} />);

        expect(screen.getByText('Urgent priority')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Urgent priority' }).querySelector('[data-priority-flag="urgent"]'))
            .toHaveAttribute('stroke', '#dc2626');
        expect(screen.getByText('Time estimate')).toBeInTheDocument();
        expect(screen.getByText('30m')).toBeInTheDocument();
    });

    it('renders token chips in three accessible states: neutral, included, excluded', () => {
        render(<ListFiltersPanel {...createProps({
            allTokens: ['@home', '@errands', '#waiting'],
            selectedTokens: ['@errands'],
            excludedTokens: ['#waiting'],
            tokenCounts: { '@home': 1, '@errands': 2, '#waiting': 3 },
        })} />);

        expect(screen.getByRole('button', { name: /^@home/ })).toHaveAttribute('aria-pressed', 'false');
        const included = screen.getByRole('button', { name: /^@errands/ });
        expect(included).toHaveAttribute('aria-pressed', 'true');
        expect(included).not.toHaveClass('line-through');
        const excluded = screen.getByRole('button', { name: '#waiting (Excluded)' });
        expect(excluded).toHaveAttribute('aria-pressed', 'mixed');
        expect(excluded).toHaveClass('line-through');
        expect(excluded).toHaveClass('border-destructive');
    });
});
