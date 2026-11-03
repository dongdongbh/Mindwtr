import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ListFiltersPanel } from './ListFiltersPanel';

const translations: Record<string, string> = {
    'common.all': 'All',
    'common.noMatches': 'No matches',
    'filters.clear': 'Clear',
    'filters.contextMatchMode': 'Context match',
    'filters.contexts': 'Contexts & tags',
    'filters.excluded': 'Excluded',
    'filters.hide': 'Hide',
    'filters.label': 'Filters',
    'filters.matchAny': 'Any',
    'filters.priority': 'Priority',
    'filters.remove': 'Remove filter',
    'filters.searchOptions': 'Search options',
    'filters.tagMatchMode': 'Tag match',
    'filters.timeEstimate': 'Time estimate',
    'filters.tokenCycleHint': 'Click to include, again to exclude, and once more to clear.',
    'reference.includeArchivedProjects': 'Include archived projects',
    'priority.urgent': 'Urgent priority',
};

const t = (key: string) => translations[key] ?? key;

const createProps = (overrides: Partial<Parameters<typeof ListFiltersPanel>[0]> = {}): Parameters<typeof ListFiltersPanel>[0] => ({
    activeFilterChips: [],
    allTokens: ['@home'],
    contextMatchMode: 'all',
    excludedTokens: [],
    formatEstimate: () => '30m',
    hasFilters: false,
    includeArchivedProjects: false,
    onClearFilters: vi.fn(),
    onClose: vi.fn(),
    onContextMatchModeChange: vi.fn(),
    onTagMatchModeChange: vi.fn(),
    onToggleEstimate: vi.fn(),
    onToggleIncludeArchivedProjects: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleToken: vi.fn(),
    priorityOptions: ['urgent'],
    selectedPriorities: [],
    selectedTimeEstimates: [],
    selectedTokens: [],
    showFiltersPanel: true,
    showIncludeArchivedProjects: false,
    showPriorityFilters: false,
    showTimeEstimateFilters: false,
    t,
    tagMatchMode: 'all',
    timeEstimateOptions: ['30min'],
    tokenCounts: { '@home': 1 },
    ...overrides,
});

describe('ListFiltersPanel', () => {
    it('discloses the task date presets and clears through Any time', () => {
        const onAnyDateRangeChange = vi.fn();
        render(<ListFiltersPanel {...createProps({ anyDateRange: { preset: 'next_7_days' }, onAnyDateRangeChange })} />);
        expect(screen.queryByRole('button', { name: 'filters.datePreset.overdue_next_7_days' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'filters.taskDates' }));
        expect(screen.getByRole('button', { name: 'filters.datePreset.next_7_days' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'filters.datePreset.overdue_next_7_days' }));
        expect(onAnyDateRangeChange).toHaveBeenCalledWith({ preset: 'overdue_next_7_days' });
        fireEvent.click(screen.getByRole('button', { name: 'filters.anyTime' }));
        expect(onAnyDateRangeChange).toHaveBeenLastCalledWith(undefined);
    });

    it('starts every category collapsed and opens only one category at a time', () => {
        render(<ListFiltersPanel {...createProps({
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
        })} />);

        const tokens = screen.getByRole('button', { name: 'Contexts & tags' });
        const priority = screen.getByRole('button', { name: 'Priority' });
        expect(tokens).toHaveAttribute('aria-expanded', 'false');
        expect(priority).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: 'Urgent priority' })).not.toBeInTheDocument();

        fireEvent.click(tokens);
        expect(tokens).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: /^@home/ })).toBeInTheDocument();

        fireEvent.click(priority);
        expect(tokens).toHaveAttribute('aria-expanded', 'false');
        expect(priority).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'Urgent priority' })).toBeInTheDocument();
    });

    it('keeps a selected metadata category visible when its normal visibility gate is off', () => {
        render(<ListFiltersPanel {...createProps({
            selectedPriorities: ['urgent'],
            showPriorityFilters: false,
        })} />);

        expect(screen.getByRole('button', { name: 'Priority' })).toBeInTheDocument();
    });

    it('searches token options locally without calling the task-search callback', () => {
        const onToggleToken = vi.fn();
        render(<ListFiltersPanel {...createProps({
            allTokens: ['@home', '@office', '#waiting'],
            onToggleToken,
            tokenCounts: { '@home': 1, '@office': 2, '#waiting': 3 },
        })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Contexts & tags' }));
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: 'office' } });

        expect(screen.getByRole('button', { name: /^@office/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^@home/ })).not.toBeInTheDocument();
        expect(onToggleToken).not.toHaveBeenCalled();
    });

    it('renders token options in three accessible states and keeps Any/All matching', () => {
        render(<ListFiltersPanel {...createProps({
            allTokens: ['@home', '@errands', '#quick', '#waiting'],
            selectedTokens: ['@home', '@errands', '#quick'],
            excludedTokens: ['#waiting'],
            tokenCounts: { '@home': 1, '@errands': 2, '#quick': 1, '#waiting': 3 },
        })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Contexts & tags' }));
        expect(screen.getByRole('button', { name: /^@home/ })).toHaveAttribute('aria-pressed', 'true');
        const excluded = screen.getByRole('button', { name: '#waiting (Excluded)' });
        expect(excluded).toHaveAttribute('aria-pressed', 'mixed');
        expect(excluded).toHaveClass('line-through');
        expect(screen.getByRole('group', { name: 'Context match' })).toBeInTheDocument();
    });

    it('keeps active chips visible and removable while the categories are collapsed', () => {
        const onRemove = vi.fn();
        render(<ListFiltersPanel {...createProps({
            activeFilterChips: [{ id: 'token:@home', label: '@home', onRemove }],
            hasFilters: true,
            showFiltersPanel: false,
        })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Remove filter: @home' }));
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: /Contexts & tags/ })).not.toBeInTheDocument();
    });

    it('closes on Escape from inside the panel and ignores Escape from elsewhere', () => {
        const onClose = vi.fn();
        render(<ListFiltersPanel {...createProps({ onClose })} />);

        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(screen.getByRole('button', { name: 'Contexts & tags' }), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders the Reference archive toggle as an accessible checkbox', () => {
        render(<ListFiltersPanel {...createProps({
            showIncludeArchivedProjects: true,
            includeArchivedProjects: true,
        })} />);

        expect(screen.getByRole('checkbox', { name: 'Include archived projects' })).toBeChecked();
    });
});
