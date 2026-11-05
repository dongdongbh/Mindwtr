import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgendaFiltersPanel } from './AgendaFiltersPanel';

const translations: Record<string, string> = {
    'common.all': 'All',
    'common.noMatches': 'No matches',
    'filters.clear': 'Clear',
    'filters.contexts': 'Contexts & tags',
    'filters.hide': 'Hide',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'filters.projects': 'Projects',
    'filters.remove': 'Remove filter',
    'filters.searchOptions': 'Search options',
    'filters.searchTasks': 'Search task titles',
    'filters.show': 'Show',
    'filters.timeEstimate': 'Time estimate',
    'filters.tokenCycleHint': 'Click to include, again to exclude, and once more to clear.',
    'priority.urgent': 'Urgent priority',
    'taskEdit.energyLevel': 'Energy level',
    'taskEdit.locationLabel': 'Location',
    'taskEdit.locationPlaceholder': 'Office',
    'taskEdit.noProjectOption': 'No project',
    'energyLevel.high': 'High energy',
};

const t = (key: string) => translations[key] ?? key;

const createProps = (overrides: Partial<Parameters<typeof AgendaFiltersPanel>[0]> = {}): Parameters<typeof AgendaFiltersPanel>[0] => ({
    activeFilterChips: [],
    allTokens: [],
    canSaveFilter: false,
    contextMatchMode: 'all',
    contextMatchModeLabels: { title: 'Context match', any: 'Any', all: 'All' },
    tagMatchMode: 'all',
    tagMatchModeLabels: { title: 'Tag match', any: 'Any', all: 'All' },
    energyLevelOptions: ['high'],
    formatEstimate: () => '30m',
    hasFilters: false,
    locationFilter: '',
    onClearFilters: vi.fn(),
    onContextMatchModeChange: vi.fn(),
    onTagMatchModeChange: vi.fn(),
    onLocationChange: vi.fn(),
    onSaveFilter: vi.fn(),
    onSearchChange: vi.fn(),
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
    it('discloses the task date presets and clears through Any time', () => {
        const onAnyDateRangeChange = vi.fn();
        render(<AgendaFiltersPanel {...createProps({ anyDateRange: { preset: 'next_7_days' }, onAnyDateRangeChange })} />);
        expect(screen.queryByRole('button', { name: 'filters.datePreset.overdue_next_7_days' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'filters.taskDates' }));
        expect(screen.getByRole('button', { name: 'filters.datePreset.next_7_days' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'filters.datePreset.overdue_next_7_days' }));
        expect(onAnyDateRangeChange).toHaveBeenCalledWith({ preset: 'overdue_next_7_days' });
        fireEvent.click(screen.getByRole('button', { name: 'filters.anyTime' }));
        expect(onAnyDateRangeChange).toHaveBeenLastCalledWith(undefined);
    });

    it('labels the Focus task query explicitly and starts categories collapsed', () => {
        render(<AgendaFiltersPanel {...createProps({ allTokens: ['@home'] })} />);

        expect(screen.getByRole('searchbox', { name: 'Search task titles' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Contexts & tags' })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: '@home' })).not.toBeInTheDocument();
    });

    it('shows gated metadata as compact categories and only mounts options after disclosure', () => {
        render(<AgendaFiltersPanel {...createProps({
            showEnergyLevelFilters: true,
            showLocationFilter: true,
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
        })} />);

        expect(screen.queryByRole('button', { name: 'Urgent priority' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
        expect(screen.getByRole('button', { name: 'Urgent priority' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Urgent priority' }).querySelector('[data-priority-flag="urgent"]'))
            .toHaveAttribute('stroke', '#dc2626');
    });

    it('opens at most one category and searches options without changing the task query', () => {
        const onSearchChange = vi.fn();
        render(<AgendaFiltersPanel {...createProps({
            allTokens: ['@home', '@office'],
            onSearchChange,
            projectOptions: [{ id: 'project', title: 'A very long project title that remains fully accessible' }],
        })} />);

        const tokens = screen.getByRole('button', { name: 'Contexts & tags' });
        const projects = screen.getByRole('button', { name: 'Projects' });
        fireEvent.click(tokens);
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: 'office' } });
        expect(screen.getByRole('button', { name: '@office' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '@home' })).not.toBeInTheDocument();
        expect(onSearchChange).not.toHaveBeenCalled();

        fireEvent.click(projects);
        expect(tokens).toHaveAttribute('aria-expanded', 'false');
        expect(projects).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'A very long project title that remains fully accessible' })).toBeInTheDocument();
    });

    it('preserves token tri-state and Any/All controls inside the open token category', () => {
        render(<AgendaFiltersPanel {...createProps({
            allTokens: ['@home', '@errands', '#waiting'],
            selectedTokens: ['@home', '@errands'],
            excludedTokens: ['#waiting'],
        })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Contexts & tags' }));
        expect(screen.getByRole('button', { name: '@home' })).toHaveAttribute('aria-pressed', 'true');
        const excluded = screen.getByRole('button', { name: '#waiting (Excluded)' });
        expect(excluded).toHaveAttribute('aria-pressed', 'mixed');
        expect(screen.getByRole('group', { name: 'Context match' })).toBeInTheDocument();
        expect(screen.getByText('Click to include, again to exclude, and once more to clear.')).toBeInTheDocument();
    });

    it('closes on Escape from inside the panel and ignores Escape from elsewhere', () => {
        const onToggleFiltersOpen = vi.fn();
        render(<AgendaFiltersPanel {...createProps({ onToggleFiltersOpen })} />);

        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onToggleFiltersOpen).not.toHaveBeenCalled();

        fireEvent.keyDown(screen.getByRole('button', { name: 'Contexts & tags' }), { key: 'Escape' });
        expect(onToggleFiltersOpen).toHaveBeenCalledTimes(1);
    });

    it('keeps excluded and advanced chips visible and removable while categories are collapsed', () => {
        const removeExcluded = vi.fn();
        const removeAdvanced = vi.fn();
        render(<AgendaFiltersPanel {...createProps({
            activeFilterChips: [
                { id: 'excluded-token:#waiting', label: '#waiting', excluded: true, onRemove: removeExcluded },
                { id: 'advanced:status:waiting', label: 'Status: Waiting', isAdvanced: true, onRemove: removeAdvanced },
            ],
            showFiltersPanel: false,
        })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Remove filter: #waiting' }));
        fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Status: Waiting' }));
        expect(removeExcluded).toHaveBeenCalledTimes(1);
        expect(removeAdvanced).toHaveBeenCalledTimes(1);
    });
});
