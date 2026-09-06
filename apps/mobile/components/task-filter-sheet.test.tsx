import React from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskMetadataFilterVisibility } from '@mindwtr/core';

vi.mock('lucide-react-native', () => ({
  X: () => null,
  Flag: (props: Record<string, unknown>) => React.createElement('Flag', props),
}));

import { TaskFilterSheet, type TaskFilterSheetOptions } from './task-filter-sheet';
import {
  useTaskFilterSelections,
  type TaskFilterSelections,
  type TaskFilterView,
} from '@/hooks/use-task-filter-selections';

const themeColors = {
  bg: '#0f172a',
  border: '#334155',
  cardBg: '#111827',
  danger: '#ef4444',
  filterBg: '#1f2937',
  onTint: '#ffffff',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const NOTHING_VISIBLE: TaskMetadataFilterVisibility = {
  energyLevel: false,
  location: false,
  priority: false,
  timeEstimate: false,
};

const t = (key: string) => ({
  'common.all': 'All',
  'common.close': 'Close',
  'common.search': 'Search',
  'energyLevel.low': 'Low energy',
  'filters.clear': 'Clear',
  'filters.label': 'Filters',
  'filters.matchAny': 'Any',
  'filters.priority': 'Priority',
  'filters.timeEstimate': 'Time estimate',
  'priority.urgent': 'Urgent priority',
  'search.placeholder': 'Search tasks',
  'taskEdit.energyLevel': 'Energy level',
  'taskEdit.locationLabel': 'Location',
}[key] ?? key);

let tree: ReactTestRenderer | null = null;

/** Renders the sheet over a real selections hook, as both screens do. */
function renderSheet({
  view = 'list',
  options,
  topContent,
}: {
  view?: TaskFilterView;
  options?: Partial<TaskFilterSheetOptions>;
  topContent?: React.ReactNode;
} = {}) {
  const handle: { current: TaskFilterSelections } = { current: null as never };
  const sheetOptions: TaskFilterSheetOptions = {
    tokens: [],
    timeEstimates: [],
    visibility: NOTHING_VISIBLE,
    ...options,
  };
  function Harness() {
    handle.current = useTaskFilterSelections({ view, t, visibility: sheetOptions.visibility });
    return (
      <TaskFilterSheet
        visible
        onClose={vi.fn()}
        selections={handle.current}
        options={sheetOptions}
        themeColors={themeColors}
        t={t}
        topContent={topContent}
      />
    );
  }
  act(() => {
    tree = create(<Harness />);
  });
  return handle;
}

const hasText = (text: string): boolean => (
  tree!.root.findAllByType(Text).some((node) => node.props.children === text)
);

/** Depth-first index of the first node matching, i.e. its place in the sheet. */
const renderOrderIndexOf = (predicate: (node: { type: unknown; props: Record<string, unknown> }) => boolean): number => (
  tree!.root.findAll(() => true).findIndex(predicate as never)
);

const flattenStyle = (style: unknown): Record<string, unknown> => (
  Array.isArray(style)
    ? style.reduce<Record<string, unknown>>((result, item) => ({ ...result, ...flattenStyle(item) }), {})
    : (style && typeof style === 'object' ? style as Record<string, unknown> : {})
);

const findButtonByText = (text: string) => tree!.root.find((node) => (
  node.props.accessibilityRole === 'button'
  && node.findAllByType(Text).some((textNode) => textNode.props.children === text)
));

afterEach(() => {
  act(() => {
    tree?.unmount();
  });
  tree = null;
});

describe('TaskFilterSheet', () => {
  it('keeps search above the view-supplied top content', () => {
    renderSheet({
      topContent: (
        <View testID="focus-sort-content">
          <Text>Sort controls</Text>
        </View>
      ),
    });

    const searchLabelIndex = renderOrderIndexOf((node) => node.type === Text && node.props.children === 'Search');
    const searchInputIndex = renderOrderIndexOf((node) => node.type === TextInput);
    const topContentIndex = renderOrderIndexOf((node) => node.props.testID === 'focus-sort-content');

    expect(searchLabelIndex).toBeGreaterThanOrEqual(0);
    expect(searchInputIndex).toBeGreaterThan(searchLabelIndex);
    expect(topContentIndex).toBeGreaterThan(searchInputIndex);
  });

  it('leaves the search box out of Focus, which has no search', () => {
    renderSheet({ view: 'focus' });

    expect(hasText('Search')).toBe(false);
  });

  it('renders token chips tri-state: included selected, excluded struck through with a state label', () => {
    const handle = renderSheet({ options: { tokens: ['@home', '@errands', '#waiting'] } });

    act(() => {
      handle.current.toggleToken('@errands');
    });
    act(() => {
      handle.current.toggleToken('#waiting');
    });
    act(() => {
      handle.current.toggleToken('#waiting');
    });

    expect(findButtonByText('@errands').props.accessibilityState).toEqual({ selected: true });

    const excludedChip = tree!.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === '#waiting (Excluded)'
    ));
    expect(excludedChip.props.accessibilityState).toEqual({ selected: false });
    const excludedText = excludedChip.findAllByType(Text).find((node) => node.props.children === '#waiting');
    expect(flattenStyle(excludedText?.props.style).textDecorationLine).toBe('line-through');

    act(() => {
      excludedChip.props.onPress();
    });
    expect(handle.current.excludedTokens).toEqual([]);
    expect(handle.current.tokens).toEqual(['@errands']);
  });

  it('shows the match mode controls only once several tokens of a kind compete', () => {
    const handle = renderSheet({ options: { tokens: ['@desk', '@phone'] } });

    act(() => {
      handle.current.toggleToken('@desk');
    });
    expect(hasText('Any')).toBe(false);

    act(() => {
      handle.current.toggleToken('@phone');
    });
    expect(findButtonByText('All').props.accessibilityState).toEqual({ selected: true });

    act(() => {
      findButtonByText('Any').props.onPress();
    });
    expect(handle.current.contextMatchMode).toBe('any');
  });

  it('hides metadata filter sections when no visible tasks use those fields', () => {
    renderSheet();

    expect(hasText('Priority')).toBe(false);
    expect(hasText('Energy level')).toBe(false);
    expect(hasText('Time estimate')).toBe(false);
    expect(hasText('Location')).toBe(false);
    expect(hasText('Projects')).toBe(false);
  });

  it('shows metadata filter sections when visible tasks use those fields', () => {
    renderSheet({
      options: {
        timeEstimates: ['30min'],
        visibility: { energyLevel: true, location: true, priority: true, timeEstimate: true },
      },
    });

    expect(hasText('Priority')).toBe(true);
    expect(hasText('Urgent priority')).toBe(true);
    // Each priority chip carries the canonical decorative flag.
    const flagColor = (priority: string) =>
      tree!.root.findByProps({ testID: `priority-flag-${priority}` }).props.color;
    expect(flagColor('low')).toBe('#3b82f6');
    expect(flagColor('medium')).toBe('#ca8a04');
    expect(flagColor('high')).toBe('#f97316');
    expect(flagColor('urgent')).toBe('#dc2626');
    expect(hasText('Energy level')).toBe(true);
    expect(hasText('Low energy')).toBe(true);
    expect(hasText('Time estimate')).toBe(true);
    expect(hasText('30m')).toBe(true);
    expect(hasText('Location')).toBe(true);
  });

  it('offers project chips only where the view supplies them', () => {
    const handle = renderSheet({
      view: 'focus',
      options: { projects: [{ id: 'no-project', title: 'No project' }, { id: 'p1', title: 'Launch' }] },
    });

    expect(hasText('Projects')).toBe(true);

    act(() => {
      findButtonByText('Launch').props.onPress();
    });
    expect(handle.current.projects).toEqual(['p1']);
  });

  it('offers Clear only while something is selected', () => {
    const handle = renderSheet({ options: { tokens: ['@desk'] } });

    expect(hasText('Clear')).toBe(false);

    act(() => {
      handle.current.toggleToken('@desk');
    });
    expect(hasText('Clear')).toBe(true);

    act(() => {
      findButtonByText('Clear').props.onPress();
    });
    expect(handle.current.tokens).toEqual([]);
    expect(hasText('Clear')).toBe(false);
  });

  it('renders no priority flag on non-priority chips', () => {
    renderSheet({
      options: {
        timeEstimates: ['30min'],
        visibility: { energyLevel: true, location: true, priority: true, timeEstimate: true },
      },
    });

    // Energy and time chips stay flag-free: exactly the four priority flags render.
    // Count host instances only — the lucide mock also surfaces a wrapper match.
    const hostFlags = (priority: string) => tree!.root
      .findAllByProps({ testID: `priority-flag-${priority}` })
      .filter((node) => typeof node.type === 'string');
    expect(hostFlags('low')).toHaveLength(1);
    expect(hostFlags('medium')).toHaveLength(1);
    expect(hostFlags('high')).toHaveLength(1);
    expect(hostFlags('urgent')).toHaveLength(1);
  });
});
