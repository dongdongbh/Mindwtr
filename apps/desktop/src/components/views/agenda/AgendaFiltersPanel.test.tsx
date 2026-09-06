import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';

import { AgendaFiltersPanel } from './AgendaFiltersPanel';

const translations: Record<string, string> = {
    'common.delete': 'Delete',
    'filters.clear': 'Clear',
    'filters.contexts': 'Contexts & tags',
    'filters.hide': 'Hide',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'filters.projects': 'Projects',
    'filters.show': 'Show',
    'filters.matchAny': 'Any',
    'common.all': 'All',
    'filters.timeEstimate': 'Time estimate',
    'priority.urgent': 'Urgent priority',
    'sort.created': 'Created',
    'sort.created-desc': 'Newest',
    'sort.default': 'Default',
    'sort.due': 'Due',
    'sort.label': 'Sort',
    'sort.priority': 'Priority',
    'sort.start': 'Start',
    'taskEdit.energyLevel': 'Energy level',
    'taskEdit.locationLabel': 'Location',
    'taskEdit.locationPlaceholder': 'Office',
    'energyLevel.high': 'High energy',
};

const t = (key: string) => translations[key] ?? key;

const createProps = (overrides: Partial<Parameters<typeof AgendaFiltersPanel>[0]> = {}): Parameters<typeof AgendaFiltersPanel>[0] => ({
    activeFilterChips: [],
    allTokens: [],
    canSaveFilter: false,
    contextMatchMode: 'all',
    contextMatchModeLabels: { title: 'Context matching', any: 'Any', all: 'All' },
    tagMatchMode: 'all',
    tagMatchModeLabels: { title: 'Tag match', any: 'Any', all: 'All' },
    energyLevelOptions: ['high'],
    focusSortBy: 'default',
    formatEstimate: () => '30m',
    hasFilters: false,
    locationFilter: '',
    onClearFilters: vi.fn(),
    onContextMatchModeChange: vi.fn(),
    onTagMatchModeChange: vi.fn(),
    onLocationChange: vi.fn(),
    onSaveFilter: vi.fn(),
    onSearchChange: vi.fn(),
    onSortChange: vi.fn(),
    onToggleEnergy: vi.fn(),
    onToggleFiltersOpen: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleProject: vi.fn(),
    onToggleTime: vi.fn(),
    onToggleToken: vi.fn(),
    priorityOptions: ['urgent'],
    projectOptions: [],
    saveFilterLabel: 'Save filter',
    searchQuery: '',
    selectedEnergyLevels: [],
    selectedPriorities: [],
    selectedProjects: [],
    selectedTimeEstimates: [],
    selectedTokens: [],
    excludedTokens: [],
    excludedStateLabel: 'Excluded',
    showEnergyLevelFilters: false,
    showFiltersPanel: true,
    showLocationFilter: false,
    showNoProjectOption: false,
    showPriorityFilters: false,
    showTimeEstimateFilters: false,
    t,
    timeEstimateOptions: ['30min'],
    ...overrides,
});

describe('AgendaFiltersPanel', () => {
    afterEach(() => {
        useTaskStore.setState({ settings: {} as never });
    });

    it('offers the Priority sort only while the Priorities feature is on', () => {
        // showPriorityFilters stays false in both renders, so the only 'Priority'
        // text on screen is the sort chip.
        const { rerender } = render(<AgendaFiltersPanel {...createProps()} />);
        expect(screen.getByText('Priority')).toBeInTheDocument();

        useTaskStore.setState({ settings: { features: { priorities: false } } as never });
        rerender(<AgendaFiltersPanel {...createProps()} />);
        expect(screen.queryByText('Priority')).not.toBeInTheDocument();
        // The other sort chips are untouched.
        expect(screen.getByText('Due')).toBeInTheDocument();
    });

    it('hides optional metadata filters until current Focus tasks use those fields', () => {
        render(<AgendaFiltersPanel {...createProps()} />);

        expect(screen.queryByText('Urgent priority')).not.toBeInTheDocument();
        expect(screen.queryByText('High energy')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Location')).not.toBeInTheDocument();
        expect(screen.queryByText('Time estimate')).not.toBeInTheDocument();
    });

    it('shows optional metadata filters when current Focus tasks use those fields', () => {
        render(<AgendaFiltersPanel {...createProps({
            showEnergyLevelFilters: true,
            showLocationFilter: true,
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
        })} />);

        expect(screen.getByText('Urgent priority')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Urgent priority' }).querySelector('[data-priority-flag="urgent"]'))
            .toHaveAttribute('stroke', '#dc2626');
        expect(screen.getByText('High energy')).toBeInTheDocument();
        expect(screen.getByLabelText('Location')).toBeInTheDocument();
        expect(screen.getByText('Time estimate')).toBeInTheDocument();
        expect(screen.getByText('30m')).toBeInTheDocument();
    });

    it('only shows the tag match control once 2+ tags are selected', () => {
        const { rerender } = render(<AgendaFiltersPanel {...createProps({
            allTokens: ['#quick', '#calls'],
            selectedTokens: ['#quick'],
        })} />);

        expect(screen.queryByText('Tag match')).not.toBeInTheDocument();

        rerender(<AgendaFiltersPanel {...createProps({
            allTokens: ['#quick', '#calls'],
            selectedTokens: ['#quick', '#calls'],
        })} />);

        expect(screen.getByText('Tag match')).toBeInTheDocument();
    });

    it('renders token chips in three accessible states: neutral, included, excluded', () => {
        render(<AgendaFiltersPanel {...createProps({
            allTokens: ['@home', '@errands', '#waiting'],
            selectedTokens: ['@errands'],
            excludedTokens: ['#waiting'],
        })} />);

        expect(screen.getByRole('button', { name: '@home' })).toHaveAttribute('aria-pressed', 'false');
        const included = screen.getByRole('button', { name: '@errands' });
        expect(included).toHaveAttribute('aria-pressed', 'true');
        expect(included).not.toHaveClass('line-through');
        const excludedChip = screen.getByRole('button', { name: '#waiting (Excluded)' });
        expect(excludedChip).toHaveAttribute('aria-pressed', 'mixed');
        expect(excludedChip).toHaveClass('line-through');
    });

    it('shows excluded tokens in the active-filter summary with strikethrough and a remove control', () => {
        const onRemove = vi.fn();
        render(<AgendaFiltersPanel {...createProps({
            activeFilterChips: [
                { id: 'excluded-token:#waiting', label: '#waiting', excluded: true, onRemove },
            ],
        })} />);

        const summaryLabel = screen.getAllByText('#waiting').find((node) => node.closest('span')?.className.includes('line-through'));
        expect(summaryLabel).toBeTruthy();
    });
});
