import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  taskMatchesFilterSelections,
  useTaskFilterSelections,
  type TaskFilterSelections,
  type TaskFilterSelectionsOptions,
} from '@mindwtr/core/task-filter-selections';
import type { SavedFilter, Task, TaskMetadataFilterVisibility } from '@mindwtr/core';

// The hook only. The predicates it feeds are shared with desktop, so they are
// covered where they live: packages/core/src/task-filter-selections.test.ts.

const ALL_VISIBLE: TaskMetadataFilterVisibility = {
  energyLevel: true,
  location: true,
  priority: true,
  timeEstimate: true,
};

const t = (key: string) => ({
  'common.search': 'Search',
  'search.title': 'Search',
  'taskEdit.locationLabel': 'Location',
  'priority.urgent': 'Urgent',
  'energyLevel.high': 'High energy',
}[key] ?? key);

const task: Task = {
  contexts: ['@work/deep'],
  createdAt: '2026-05-27T10:00:00.000Z',
  description: 'Draft launch notes',
  energyLevel: 'high',
  id: 'c5290e2c-1b77-4f77-8927-6d187e141891',
  location: 'Office',
  priority: 'urgent',
  status: 'next',
  tags: ['#client/acme'],
  timeEstimate: '30min',
  title: 'Prepare release checklist',
  updatedAt: '2026-05-27T10:00:00.000Z',
};

let tree: ReactTestRenderer | null = null;

/** Renders the hook and returns a handle whose `.current` is always the latest result. */
function renderSelections(options: Partial<TaskFilterSelectionsOptions> = {}) {
  const handle: { current: TaskFilterSelections } = { current: null as never };
  function Harness(props: { options: Partial<TaskFilterSelectionsOptions> }) {
    handle.current = useTaskFilterSelections({
      view: 'list',
      t,
      visibility: ALL_VISIBLE,
      ...props.options,
    });
    return null;
  }
  act(() => {
    tree = create(<Harness options={options} />);
  });
  return {
    handle,
    rerender: (next: Partial<TaskFilterSelectionsOptions>) => act(() => {
      tree!.update(<Harness options={next} />);
    }),
  };
}

afterEach(() => {
  act(() => {
    tree?.unmount();
  });
  tree = null;
  vi.restoreAllMocks();
});

describe('useTaskFilterSelections', () => {
  it('cycles a token neutral → included → excluded → neutral, one side at a time', () => {
    const { handle } = renderSelections();

    act(() => handle.current.toggleToken('@desk'));
    expect(handle.current.tokens).toEqual(['@desk']);
    expect(handle.current.excludedTokens).toEqual([]);
    expect(handle.current.criteria).toMatchObject({ contexts: ['@desk'] });

    act(() => handle.current.toggleToken('@desk'));
    expect(handle.current.tokens).toEqual([]);
    expect(handle.current.excludedTokens).toEqual(['@desk']);
    expect(handle.current.criteria).toMatchObject({ excludedContexts: ['@desk'] });
    expect(handle.current.criteria.contexts).toBeUndefined();

    act(() => handle.current.toggleToken('@desk'));
    expect(handle.current.tokens).toEqual([]);
    expect(handle.current.excludedTokens).toEqual([]);
    expect(handle.current.activeCount).toBe(0);
  });

  it('subtracts a task carrying an excluded token even when it matches every include', () => {
    const { handle } = renderSelections();

    act(() => handle.current.toggleToken('@work'));
    expect(taskMatchesFilterSelections(task, handle.current)).toBe(true);

    // Excluding the parent tag drops the child tag too.
    act(() => handle.current.toggleToken('#client'));
    act(() => handle.current.toggleToken('#client'));
    expect(handle.current.excludedTokens).toEqual(['#client']);
    expect(taskMatchesFilterSelections(task, handle.current)).toBe(false);
  });

  it('counts every selected value, plus the search box, as one active filter', () => {
    const { handle } = renderSelections();
    expect(handle.current.activeCount).toBe(0);

    act(() => {
      handle.current.setSearchQuery('release');
      handle.current.toggleToken('@work');
      handle.current.toggleToken('#client');
      handle.current.togglePriority('urgent');
      handle.current.toggleEnergyLevel('high');
      handle.current.toggleTimeEstimate('30min');
      handle.current.setLocation('office');
    });

    expect(handle.current.activeCount).toBe(7);
    expect(handle.current.hasActive).toBe(true);
    expect(taskMatchesFilterSelections(task, handle.current)).toBe(true);
  });

  it('clears every selection at once and runs the view-supplied reset', () => {
    const onClear = vi.fn();
    const { handle } = renderSelections({ onClear });

    act(() => {
      handle.current.setSearchQuery('release');
      handle.current.toggleToken('@work');
      handle.current.toggleToken('@home');
      handle.current.toggleToken('@home');
      handle.current.togglePriority('urgent');
      handle.current.setLocation('office');
      handle.current.setMatchMode('context', 'any');
    });
    expect(handle.current.hasActive).toBe(true);

    act(() => handle.current.clear());

    expect(handle.current).toMatchObject({
      searchQuery: '',
      tokens: [],
      excludedTokens: [],
      projects: [],
      priorities: [],
      energyLevels: [],
      timeEstimates: [],
      locationQuery: '',
      contextMatchMode: 'all',
      tagMatchMode: 'all',
      activeCount: 0,
      hasActive: false,
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('applies a saved filter and drops the binding as soon as a selection changes', () => {
    const savedFilter: SavedFilter = {
      id: 'filter-desk',
      name: 'Desk',
      view: 'focus',
      criteria: { contexts: ['@desk'], areas: ['area-1'] },
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const { handle } = renderSelections({ view: 'focus', savedFilters: [savedFilter] });

    act(() => handle.current.applySaved(savedFilter));
    expect(handle.current.activeSavedFilterId).toBe('filter-desk');
    expect(handle.current.tokens).toEqual(['@desk']);
    // The saved filter still filters by its own criteria, including the area
    // no picker can express.
    expect(handle.current.criteria).toMatchObject({ contexts: ['@desk'], areas: ['area-1'] });
    expect(handle.current.canSave).toBe(false);

    act(() => handle.current.togglePriority('urgent'));
    expect(handle.current.activeSavedFilterId).toBeNull();
    expect(handle.current.criteria.areas).toBeUndefined();
    expect(handle.current.canSave).toBe(true);
  });

  it('drops the binding when the saved filter disappears, keeping the selections', () => {
    const savedFilter: SavedFilter = {
      id: 'filter-desk',
      name: 'Desk',
      view: 'focus',
      criteria: { contexts: ['@desk'] },
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const { handle, rerender } = renderSelections({ view: 'focus', savedFilters: [savedFilter] });

    act(() => handle.current.applySaved(savedFilter));
    expect(handle.current.activeSavedFilterId).toBe('filter-desk');

    rerender({ view: 'focus', savedFilters: [] });

    expect(handle.current.activeSavedFilterId).toBeNull();
    expect(handle.current.tokens).toEqual(['@desk']);
  });

  it('stops filtering by metadata the view no longer shows, and forgets the selection', () => {
    const { handle, rerender } = renderSelections();

    act(() => {
      handle.current.togglePriority('urgent');
      handle.current.setLocation('office');
    });
    expect(handle.current.criteria).toMatchObject({ priority: ['urgent'], locations: ['office'] });

    rerender({ visibility: { ...ALL_VISIBLE, location: false, priority: false } });

    expect(handle.current.priorities).toEqual([]);
    expect(handle.current.locationQuery).toBe('');
    expect(handle.current.criteria.priority).toBeUndefined();
    expect(handle.current.criteria.locations).toBeUndefined();
  });

  it('drops selections whose chip the view stopped offering', () => {
    const { handle, rerender } = renderSelections({ view: 'focus', retainTokens: ['@desk', '@phone'] });

    act(() => {
      handle.current.toggleToken('@desk');
      handle.current.toggleToken('@phone');
      handle.current.toggleToken('@phone');
    });
    expect(handle.current.tokens).toEqual(['@desk']);
    expect(handle.current.excludedTokens).toEqual(['@phone']);

    rerender({ view: 'focus', retainTokens: ['@desk'] });

    expect(handle.current.tokens).toEqual(['@desk']);
    expect(handle.current.excludedTokens).toEqual([]);
  });

  it('drops what an applied saved filter selects in a hidden section or for a chip the view does not offer', () => {
    const savedFilter: SavedFilter = {
      id: 'filter-urgent',
      name: 'Urgent',
      view: 'focus',
      criteria: {
        contexts: ['@desk', '@gone'],
        projects: ['project-1', 'project-gone'],
        priority: ['urgent', 'high'],
        energy: ['high'],
        timeEstimates: ['30min'],
        locations: ['Office'],
      },
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const hidden: TaskMetadataFilterVisibility = { energyLevel: false, location: false, priority: false, timeEstimate: false };
    const retain = { retainTokens: ['@desk'], retainProjects: ['project-1'] };
    const { handle, rerender } = renderSelections({ view: 'focus', visibility: hidden, savedFilters: [savedFilter], ...retain });

    act(() => handle.current.applySaved(savedFilter));
    expect(handle.current.activeSavedFilterId).toBe('filter-urgent');
    expect(handle.current).toMatchObject({
      tokens: ['@desk'],
      projects: ['project-1'],
      priorities: [],
      energyLevels: [],
      timeEstimates: [],
      locationQuery: '',
    });

    // Detached and shown again, the hidden selections do not come back.
    act(() => handle.current.unbindSaved());
    rerender({ view: 'focus', visibility: ALL_VISIBLE, savedFilters: [savedFilter], ...retain });
    expect(handle.current).toMatchObject({ priorities: [], energyLevels: [], timeEstimates: [], locationQuery: '' });
    expect(handle.current.criteria.priority).toBeUndefined();
  });

  it('offers one removable chip per selection, in picker order', () => {
    const { handle } = renderSelections({
      view: 'focus',
      getProjectLabel: (projectId) => (projectId === 'project-1' ? 'Launch' : undefined),
    });

    act(() => {
      handle.current.setSearchQuery('release');
      handle.current.toggleToken('@work');
      handle.current.toggleToken('#waiting');
      handle.current.toggleToken('#waiting');
      handle.current.toggleProject('project-1');
      handle.current.toggleProject('project-gone');
      handle.current.togglePriority('urgent');
      handle.current.toggleEnergyLevel('high');
      handle.current.toggleTimeEstimate('30min');
      handle.current.setLocation('office');
    });

    expect(handle.current.chips.map((chip) => [chip.id, chip.label, chip.excluded ?? false])).toEqual([
      ['search', 'Search: release', false],
      ['token:@work', '@work', false],
      ['excluded-token:#waiting', '#waiting', true],
      ['project:project-1', 'Launch', false],
      ['priority:urgent', 'Urgent', false],
      ['energy:high', 'High energy', false],
      ['time:30min', '30m', false],
      ['location', 'Location: office', false],
    ]);

    act(() => handle.current.chips[1].onPress());
    expect(handle.current.tokens).toEqual([]);
    expect(handle.current.excludedTokens).toEqual(['#waiting']);
  });

  it('removes included and excluded token chips without cycling their picker state', () => {
    const { handle } = renderSelections({ view: 'focus' });
    act(() => { handle.current.toggleToken('@work'); });
    act(() => { handle.current.chips.find((chip) => chip.id === 'token:@work')?.onPress(); });
    expect(handle.current.tokens).toEqual([]);
    expect(handle.current.excludedTokens).toEqual([]);
    act(() => { handle.current.toggleToken('@work'); handle.current.toggleToken('@work'); });
    act(() => { handle.current.chips.find((chip) => chip.id === 'excluded-token:@work')?.onPress(); });
    expect(handle.current.tokens).toEqual([]);
    expect(handle.current.excludedTokens).toEqual([]);
  });

  it('shows the match-mode control only once several tokens of a kind compete', () => {
    const { handle } = renderSelections();

    act(() => handle.current.toggleToken('@desk'));
    expect(handle.current.showContextMatchMode).toBe(false);
    expect(handle.current.criteria.contextMatchMode).toBeUndefined();

    act(() => handle.current.toggleToken('@phone'));
    expect(handle.current.showContextMatchMode).toBe(true);
    expect(handle.current.showTagMatchMode).toBe(false);

    // 'all' is the default, so the task carrying only one of them drops out.
    expect(taskMatchesFilterSelections(task, handle.current)).toBe(false);
    act(() => handle.current.setMatchMode('context', 'any'));
    expect(handle.current.criteria.contextMatchMode).toBe('any');
    expect(taskMatchesFilterSelections({ ...task, contexts: ['@desk'] }, handle.current)).toBe(true);
  });
});
