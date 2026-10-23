import React from 'react';
import { FlatList, Modal, Text, TextInput, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskMetadataFilterVisibility } from '@mindwtr/core';
import { TaskFilterSheet, type TaskFilterSheetOptions } from './task-filter-sheet';
import {
  useTaskFilterSelections,
  type TaskFilterSelections,
  type TaskFilterView,
} from '@/hooks/use-task-filter-selections';

vi.mock('lucide-react-native', () => ({
  ChevronDown: () => null,
  ChevronRight: () => null,
  ChevronUp: () => null,
  X: () => null,
  Flag: (props: Record<string, unknown>) => React.createElement('Flag', props),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));

vi.mock('@/lib/use-android-keyboard-inset', () => ({
  useKeyboardInset: () => 0,
}));

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
  'bulk.selected': 'Selected',
  'common.all': 'All',
  'common.back': 'Back',
  'common.close': 'Close',
  'common.done': 'Done',
  'common.search': 'Search',
  'energyLevel.high': 'High energy',
  'energyLevel.low': 'Low energy',
  'energyLevel.medium': 'Medium energy',
  'filters.active': 'Active filters',
  'filters.clear': 'Clear',
  'filters.contexts': 'Contexts & tags',
  'filters.excluded': 'Excluded',
  'filters.label': 'Filters',
  'filters.matchAny': 'Any',
  'filters.more': 'More filters',
  'filters.priority': 'Priority',
  'filters.projects': 'Projects',
  'filters.remove': 'Remove filter',
  'filters.timeEstimate': 'Time estimate',
  'priority.high': 'High priority',
  'priority.low': 'Low priority',
  'priority.medium': 'Medium priority',
  'priority.urgent': 'Urgent priority',
  'search.noResults': 'No results',
  'search.placeholder': 'Search tasks',
  'taskEdit.energyLevel': 'Energy level',
  'taskEdit.locationLabel': 'Location',
  'taskEdit.locationPlaceholder': 'e.g. Office',
}[key] ?? key);

let tree: ReactTestRenderer | null = null;

/** Renders the sheet over a real selections hook, as all mobile hosts do. */
function renderSheet({
  view = 'list',
  options,
  topContent,
  hasAdditionalActiveFilters = false,
  onClear,
  onClose = vi.fn(),
  additionalActiveChips,
}: {
  view?: TaskFilterView;
  options?: Partial<TaskFilterSheetOptions>;
  topContent?: React.ReactNode;
  hasAdditionalActiveFilters?: boolean;
  onClear?: () => void;
  onClose?: () => void;
  additionalActiveChips?: React.ComponentProps<typeof TaskFilterSheet>['additionalActiveChips'];
} = {}) {
  const handle: { current: TaskFilterSelections } = { current: null as never };
  const sheetOptions: TaskFilterSheetOptions = {
    tokens: [],
    timeEstimates: [],
    visibility: NOTHING_VISIBLE,
    ...options,
  };
  function Harness() {
    handle.current = useTaskFilterSelections({ view, t, visibility: sheetOptions.visibility, onClear });
    return (
      <TaskFilterSheet
        visible
        onClose={onClose}
        selections={handle.current}
        options={sheetOptions}
        themeColors={themeColors}
        t={t}
        topContent={topContent}
        hasAdditionalActiveFilters={hasAdditionalActiveFilters}
        additionalActiveChips={additionalActiveChips}
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

const findButtonByLabel = (label: string) => {
  const matches = tree!.root.findAll((node) => (
    node.props.accessibilityRole === 'button'
    && node.props.accessibilityLabel === label
    && typeof node.props.onPress === 'function'
  ));
  if (matches.length === 0) throw new Error(`No button found with label: ${label}`);
  return matches[matches.length - 1];
};

const openCategory = (label: string) => {
  act(() => {
    findButtonByText(label).props.onPress();
  });
};

afterEach(() => {
  act(() => {
    tree?.unmount();
  });
  tree = null;
});

describe('TaskFilterSheet', () => {
  it('discloses task dates and clears just the range with Any time', () => {
    const handle = renderSheet();
    expect(hasText('filters.datePreset.next_7_days')).toBe(false);
    openCategory('filters.taskDates');
    act(() => findButtonByText('filters.datePreset.next_7_days').props.onPress());
    expect(handle.current.criteria).toEqual({ anyDateRange: { preset: 'next_7_days' } });
    expect(handle.current.activeCount).toBe(1);
    act(() => findButtonByText('filters.anyTime').props.onPress());
    expect(handle.current.criteria).toEqual({});
  });

  it('opens on compact category summaries instead of rendering every option', () => {
    renderSheet({
      options: {
        tokens: ['@desk'],
        projects: [{ id: 'p1', title: 'Launch' }],
        timeEstimates: ['30min'],
        visibility: { energyLevel: true, location: true, priority: true, timeEstimate: true },
      },
    });

    expect(hasText('Contexts & tags')).toBe(true);
    expect(hasText('Projects')).toBe(true);
    expect(hasText('Time estimate')).toBe(true);
    expect(hasText('Energy level')).toBe(true);
    expect(hasText('More filters')).toBe(true);
    expect(hasText('@desk')).toBe(false);
    expect(hasText('Launch')).toBe(false);
    expect(hasText('30m')).toBe(false);
    expect(hasText('Low energy')).toBe(false);
    expect(hasText('Urgent priority')).toBe(false);
    expect(hasText('Done')).toBe(true);
    expect(tree!.root.findAllByType(FlatList)).toHaveLength(0);
  });

  it('keeps active filters first, task search next, then view-supplied content', () => {
    const handle = renderSheet({
      options: { tokens: ['@desk'] },
      topContent: (
        <View testID="host-content">
          <Text>Host controls</Text>
        </View>
      ),
    });
    openCategory('Contexts & tags');
    act(() => findButtonByText('@desk').props.onPress());
    act(() => findButtonByText('Back').props.onPress());

    const activeIndex = renderOrderIndexOf((node) => node.type === Text && node.props.children === 'Active filters');
    const searchInputIndex = renderOrderIndexOf((node) => node.type === TextInput && node.props.accessibilityLabel === 'Search');
    const hostIndex = renderOrderIndexOf((node) => node.props.testID === 'host-content');

    expect(handle.current.tokens).toEqual(['@desk']);
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(searchInputIndex).toBeGreaterThan(activeIndex);
    expect(hostIndex).toBeGreaterThan(searchInputIndex);
  });

  it('leaves task search out of Focus while keeping picker search local', () => {
    const handle = renderSheet({ view: 'focus', options: { tokens: ['@desk', '@phone'] } });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Search' })).toHaveLength(0);
    openCategory('Contexts & tags');
    const pickerSearch = tree!.root.findByProps({ accessibilityLabel: 'Search Contexts & tags' });
    act(() => pickerSearch.props.onChangeText('desk'));

    expect(handle.current.searchQuery).toBe('');
    expect(hasText('@desk')).toBe(true);
    expect(hasText('@phone')).toBe(false);
  });

  it('searches token options, preserves tri-state selection, and keeps Any/All semantics', () => {
    const handle = renderSheet({ options: { tokens: ['@desk', '@phone', '#waiting'] } });
    openCategory('Contexts & tags');

    act(() => findButtonByText('@desk').props.onPress());
    act(() => findButtonByText('@phone').props.onPress());
    expect(findButtonByText('All').props.accessibilityState).toEqual({ selected: true });

    act(() => findButtonByText('Any').props.onPress());
    expect(handle.current.contextMatchMode).toBe('any');

    act(() => findButtonByText('#waiting').props.onPress());
    act(() => findButtonByText('#waiting').props.onPress());
    const excludedOption = findButtonByLabel('#waiting (Excluded)');
    expect(excludedOption.props.accessibilityState).toEqual({ selected: false });
    const excludedText = excludedOption.findAllByType(Text).find((node) => node.props.children === '#waiting');
    expect(flattenStyle(excludedText?.props.style).textDecorationLine).toBe('line-through');
    expect(hasText('Excluded')).toBe(true);

    act(() => findButtonByText('Back').props.onPress());
    expect(handle.current.excludedTokens).toEqual(['#waiting']);
    expect(findButtonByText('Contexts & tags').findAllByType(Text).some((node) => (
      String(node.props.children).includes('Excluded: #waiting')
    ))).toBe(true);
  });

  it('searches and multi-selects projects in the same sheet', () => {
    const handle = renderSheet({
      view: 'focus',
      options: {
        projects: [
          { id: 'p1', title: 'Launch' },
          { id: 'p2', title: 'Personal' },
        ],
      },
    });
    openCategory('Projects');
    const pickerSearch = tree!.root.findByProps({ accessibilityLabel: 'Search Projects' });

    act(() => pickerSearch.props.onChangeText('launch'));
    expect(hasText('Launch')).toBe(true);
    expect(hasText('Personal')).toBe(false);
    act(() => findButtonByText('Launch').props.onPress());
    act(() => pickerSearch.props.onChangeText(''));
    act(() => findButtonByText('Personal').props.onPress());

    expect(handle.current.projects).toEqual(['p1', 'p2']);
    act(() => findButtonByText('Back').props.onPress());
    expect(hasText('Launch, Personal')).toBe(true);
  });

  it('discloses time and energy inline and keeps priority/location under More filters', () => {
    renderSheet({
      options: {
        timeEstimates: ['30min'],
        visibility: { energyLevel: true, location: true, priority: true, timeEstimate: true },
      },
    });

    openCategory('Time estimate');
    expect(hasText('30m')).toBe(true);
    openCategory('Energy level');
    expect(hasText('Low energy')).toBe(true);
    openCategory('More filters');
    expect(hasText('Priority')).toBe(true);
    expect(hasText('Urgent priority')).toBe(true);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Location' })).toBeTruthy();

    const hostFlags = (priority: string) => tree!.root
      .findAllByProps({ testID: `priority-flag-${priority}` })
      .filter((node) => typeof node.type === 'string');
    expect(hostFlags('low')).toHaveLength(1);
    expect(hostFlags('medium')).toHaveLength(1);
    expect(hostFlags('high')).toHaveLength(1);
    expect(hostFlags('urgent')).toHaveLength(1);
  });

  it('renders ordinary and advanced active chips once and removes them directly', () => {
    const removeAdvanced = vi.fn();
    const handle = renderSheet({
      options: { tokens: ['@desk'] },
      additionalActiveChips: [{
        id: 'advanced:dueDateRange',
        label: 'Due Date: This week',
        onPress: removeAdvanced,
        variant: 'advanced',
      }],
    });
    openCategory('Contexts & tags');
    act(() => findButtonByText('@desk').props.onPress());
    act(() => findButtonByText('Back').props.onPress());

    const hostButtonsWithLabel = (label: string) => tree!.root
      .findAllByProps({ accessibilityLabel: label })
      .filter((node) => typeof node.type === 'string');
    expect(hostButtonsWithLabel('Remove filter: @desk')).toHaveLength(1);
    expect(hostButtonsWithLabel('Remove filter: Due Date: This week')).toHaveLength(1);
    act(() => findButtonByLabel('Remove filter: @desk').props.onPress());
    expect(handle.current.tokens).toEqual([]);
    expect(handle.current.excludedTokens).toEqual([]);

    act(() => findButtonByLabel('Remove filter: Due Date: This week').props.onPress());
    expect(removeAdvanced).toHaveBeenCalledOnce();
  });

  it('offers Clear only while shared or view-local filters are active', () => {
    const onClear = vi.fn();
    const handle = renderSheet({ options: { tokens: ['@desk'] }, onClear });
    expect(hasText('Clear')).toBe(false);

    openCategory('Contexts & tags');
    act(() => findButtonByText('@desk').props.onPress());
    expect(hasText('Clear')).toBe(true);
    act(() => findButtonByText('Clear').props.onPress());
    expect(handle.current.tokens).toEqual([]);
    expect(onClear).toHaveBeenCalledOnce();

    act(() => tree!.unmount());
    tree = null;
    renderSheet({ hasAdditionalActiveFilters: true, onClear });
    expect(hasText('Clear')).toBe(true);
  });

  it('uses Android hardware back for picker navigation before dismissing', () => {
    const onClose = vi.fn();
    const handle = renderSheet({ options: { tokens: ['@desk'] }, onClose });
    openCategory('Contexts & tags');
    act(() => findButtonByText('@desk').props.onPress());

    act(() => tree!.root.findByType(Modal).props.onRequestClose());
    expect(hasText('Back')).toBe(false);
    expect(handle.current.tokens).toEqual(['@desk']);
    expect(onClose).not.toHaveBeenCalled();

    act(() => tree!.root.findByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('resets picker search on entry and resets navigation/disclosures on close', () => {
    const onClose = vi.fn();
    renderSheet({
      onClose,
      options: {
        tokens: ['@desk', '@phone'],
        timeEstimates: ['30min'],
        visibility: { ...NOTHING_VISIBLE, timeEstimate: true },
      },
    });

    openCategory('Contexts & tags');
    let pickerSearch = tree!.root.findByProps({ accessibilityLabel: 'Search Contexts & tags' });
    act(() => pickerSearch.props.onChangeText('desk'));
    act(() => findButtonByText('Back').props.onPress());
    openCategory('Contexts & tags');
    pickerSearch = tree!.root.findByProps({ accessibilityLabel: 'Search Contexts & tags' });
    expect(pickerSearch.props.value).toBe('');
    act(() => findButtonByText('Back').props.onPress());

    openCategory('Time estimate');
    expect(hasText('30m')).toBe(true);
    act(() => findButtonByText('Done').props.onPress());
    expect(onClose).toHaveBeenCalledOnce();
    expect(findButtonByText('Time estimate').props.accessibilityState).toEqual({ expanded: false });
    expect(hasText('30m')).toBe(false);
  });

  it('does not render long option lists until their virtualized picker opens', () => {
    const tokens = Array.from({ length: 1_000 }, (_, index) => `@context-${index}`);
    renderSheet({ options: { tokens } });

    expect(tree!.root.findAllByType(FlatList)).toHaveLength(0);
    expect(hasText('@context-0')).toBe(false);
    openCategory('Contexts & tags');

    const picker = tree!.root.findByType(FlatList);
    expect(picker.props.data).toHaveLength(1_000);
  });

  it('hides metadata categories when visible tasks do not use those fields', () => {
    renderSheet();

    expect(hasText('Priority')).toBe(false);
    expect(hasText('Energy level')).toBe(false);
    expect(hasText('Time estimate')).toBe(false);
    expect(hasText('Location')).toBe(false);
    expect(hasText('Projects')).toBe(false);
    expect(hasText('More filters')).toBe(false);
  });
});
