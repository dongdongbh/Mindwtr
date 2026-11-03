import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { TaskListHeader } from './TaskListHeader';

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: (callback: () => void) => ({ cancel: vi.fn(), then: callback() }) },
  Modal: ({ children, visible, ...props }: any) => visible ? React.createElement('div', props, children) : null,
  Platform: { OS: 'android' },
  Pressable: ({ accessibilityLabel, accessibilityRole, onPress, style, ...props }: any) =>
    React.createElement('button', { ...props, 'aria-label': accessibilityLabel, role: accessibilityRole, onClick: onPress }, props.children),
  ScrollView: ({ children, contentContainerStyle, horizontal, showsHorizontalScrollIndicator, style, ...props }: any) =>
    React.createElement('div', props, children),
  StyleSheet: { create: (styles: any) => styles },
  Text: ({ accessibilityLabel, accessibilityRole, numberOfLines, ...props }: any) =>
    React.createElement('span', { ...props, 'aria-label': accessibilityLabel, role: accessibilityRole }, props.children),
  TouchableOpacity: ({ accessibilityLabel, accessibilityRole, accessibilityState, hitSlop, onPress, style, ...props }: any) =>
    React.createElement('button', {
      ...props,
      'aria-label': accessibilityLabel,
      'aria-selected': accessibilityState?.selected,
      role: accessibilityRole,
      onClick: onPress,
    }, props.children),
  View: ({ accessibilityLabel, accessibilityRole, style, ...props }: any) =>
    React.createElement('div', { ...props, 'aria-label': accessibilityLabel, role: accessibilityRole }, props.children),
}));

vi.mock('lucide-react-native', () => ({
  ArrowUpDown: ({ size }: { size?: number }) => React.createElement('span', { 'data-icon': 'arrow-up-down', 'data-size': size }),
  ChevronLeft: () => React.createElement('span', { 'data-icon': 'chevron-left' }),
  ChevronRight: () => React.createElement('span', { 'data-icon': 'chevron-right' }),
  Folder: ({ size }: { size?: number }) => React.createElement('span', { 'data-icon': 'folder', 'data-size': size }),
  MoreHorizontal: () => React.createElement('span', { 'data-icon': 'more-horizontal' }),
  Settings2: () => React.createElement('span', { 'data-icon': 'settings-2' }),
  SlidersHorizontal: ({ size }: { size?: number }) => React.createElement('span', { 'data-icon': 'sliders-horizontal', 'data-size': size }),
  X: () => React.createElement('span', { 'data-icon': 'x' }),
}));

vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => false }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));

const themeColors = {
  border: '#d1d5db',
  cardBg: '#ffffff',
  danger: '#ef4444',
  filterBg: '#f3f4f6',
  onTint: '#ffffff',
  secondaryText: '#6b7280',
  text: '#111827',
  tint: '#2563eb',
};

const renderHeader = (overrides: Partial<React.ComponentProps<typeof TaskListHeader>> = {}) => renderToStaticMarkup(
  <TaskListHeader
    activeFilterChips={[]}
    count={3}
    filterActiveCount={0}
    hasActiveFilters={false}
    onClearFilters={vi.fn()}
    onOpenFilters={vi.fn()}
    onOpenSort={vi.fn()}
    showHeader={false}
    showSort
    sortByLabel="Newest"
    t={(key) => ({
      'common.clear': 'Clear',
      'common.back': 'Back',
      'common.all': 'All',
      'common.tasks': 'tasks',
      'common.viewOptions': 'View options',
      'common.close': 'Close',
      'filters.label': 'Filters',
      'list.groupBy': 'Group',
      'sort.label': 'Sort',
      'taskEdit.moreOptions': 'More options',
    }[key] ?? key)}
    themeColors={themeColors}
    title="Inbox"
    {...overrides}
  />
);

describe('TaskListHeader', () => {
  it('uses localized singular counts for visible text and accessibility', () => {
    const html = renderHeader({ showHeader: true, count: 1, t: (key) => ({
      'list.countTaskSingular': 'tâche', 'common.tasks': 'tâches',
    }[key] ?? key) });
    expect(html).toContain('aria-label="1 tâche"');
    expect(html).toContain('1 tâche');
    expect(html).not.toContain('1 tasks');
  });
  it('restores direct Inbox Sort, Group, and Filters controls before Mind Sweep', () => {
    const html = renderHeader({
      directControls: true,
      filterActiveCount: 2,
      groupByLabel: 'Status',
      hasActiveFilters: true,
      headerAccessory: React.createElement('span', { 'data-testid': 'mind-sweep' }, 'Mind Sweep'),
      onOpenGroup: vi.fn(),
    } as Partial<React.ComponentProps<typeof TaskListHeader>>);

    expect(html).toContain('aria-label="Sort: Newest"');
    expect(html).toContain('aria-label="Group: Status"');
    expect(html).toContain('aria-label="Filters: 2"');
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/data-icon="sliders-horizontal"/g)).toHaveLength(1);
    expect(html.match(/data-size="16"/g)).toHaveLength(3);
    expect(html).not.toContain('aria-label="More options"');
    expect(html).not.toContain('Filters · 2');
    expect(html.indexOf('data-icon="arrow-up-down"')).toBeLessThan(html.indexOf('data-icon="folder"'));
    expect(html.indexOf('data-icon="folder"')).toBeLessThan(html.indexOf('data-icon="sliders-horizontal"'));
    expect(html.indexOf('data-icon="sliders-horizontal"')).toBeLessThan(html.indexOf('Mind Sweep'));
  });


  it('shows how many filters are active on the compact Inbox filter button', () => {
    const html = renderHeader({
      directControls: true,
      filterActiveCount: 3,
      hasActiveFilters: true,
      onOpenGroup: vi.fn(),
    } as Partial<React.ComponentProps<typeof TaskListHeader>>);

    expect(html).toContain('aria-label="Filters: 3"');
    expect(html).toContain('>3<');

    expect(renderHeader({ directControls: true, onOpenGroup: vi.fn() } as Partial<React.ComponentProps<typeof TaskListHeader>>))
      .not.toContain('>0<');
  });

  it('keeps inactive filters and view options behind one neutral overflow control', () => {
    const html = renderHeader();

    expect(html).toContain('aria-label="More options"');
    expect(html).toContain('data-icon="more-horizontal"');
    expect(html).not.toContain('aria-label="Sort: Newest"');
    expect(html).not.toContain('aria-label="Filters"');
    expect(html).not.toContain('data-icon="sliders-horizontal"');
    expect(html).not.toContain('Inbox');
  });

  it('keeps the overflow available when filtering is the only capability', () => {
    const html = renderHeader({ showSort: false });

    expect(html).toContain('aria-label="More options"');
    expect(html).toContain('data-icon="more-horizontal"');
    expect(html).not.toContain('aria-label="Filters"');
  });

  it('shows active filter chips and a count badge', () => {
    const html = renderHeader({
      activeFilterChips: [
        { id: 'search', label: 'Search: errand', onPress: vi.fn() },
        { id: 'priority:high', label: 'High', onPress: vi.fn() },
      ],
      filterActiveCount: 2,
      hasActiveFilters: true,
    });

    expect(html).toContain('aria-label="Filters · 2"');
    expect(html).toContain('Filters · 2');
    expect(html).toContain('aria-label="Remove filter: Search: errand"');
    expect(html).toContain('aria-label="Remove filter: High"');
    expect(html).toContain('Search: errand');
    expect(html).toContain('High');
    expect(html).toContain('Clear');
    expect(html).toContain('data-icon="x"');
  });

  it('renders excluded token chips with a strikethrough label', () => {
    const html = renderHeader({
      activeFilterChips: [
        { id: 'excluded-token:#waiting', label: '#waiting', excluded: true, onPress: vi.fn() },
      ],
      filterActiveCount: 1,
      hasActiveFilters: true,
    });


    expect(html).toContain('aria-label="Remove filter: #waiting (Excluded)"');


    expect(html).toContain('2:[object Object]">#waiting');
  });

  it('keeps compact tools left and the primary accessory on the outside edge without Select chrome', () => {
    const html = renderHeader({
      headerAccessory: React.createElement('span', { 'data-testid': 'process-inbox' }, 'Process Inbox'),
    });

    expect(html).not.toContain('aria-label="Select"');
    expect(html).toContain('data-icon="more-horizontal"');
    expect(html).not.toContain('data-icon="sliders-horizontal"');
    expect(html.indexOf('Process Inbox')).toBeLessThan(html.indexOf('data-icon="more-horizontal"'));
  });

  it('shows Sort and Group immediately in the overflow menu without View options', () => {
    const onOpenFilters = vi.fn();
    const onOpenSort = vi.fn();
    const onOpenGroup = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskListHeader
          activeFilterChips={[]}
          count={3}
          filterActiveCount={0}
          groupByLabel="Tags"
          hasActiveFilters={false}
          onClearFilters={vi.fn()}
          onOpenFilters={onOpenFilters}
          onOpenGroup={onOpenGroup}
          onOpenSort={onOpenSort}
          showHeader={false}
          showSort
          sortByLabel="Newest"
          t={(key) => ({
            'common.back': 'Back',
            'common.viewOptions': 'View options',
            'common.close': 'Close',
            'filters.label': 'Filters',
            'list.groupBy': 'Group',
            'sort.label': 'Sort',
            'taskEdit.moreOptions': 'More options',
          }[key] ?? key)}
          themeColors={themeColors}
          title="Inbox"
        />,
      );
    });

    const button = (label: string) => tree.root.findAllByType('button').find(
      (node) => node.props['aria-label'] === label,
    );
    act(() => button('More options')!.props.onClick());

    expect(button('Filters')).toBeTruthy();
    expect(button('Sort: Newest')).toBeTruthy();
    expect(button('Group: Tags')).toBeTruthy();
    expect(button('View options')).toBeUndefined();
    act(() => button('Group: Tags')!.props.onClick());
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenSort).not.toHaveBeenCalled();
    expect(onOpenFilters).not.toHaveBeenCalled();
  });

  it('marks the compact Filters count selected when filters are active', () => {
    const html = renderHeader({
      filterActiveCount: 1,
      hasActiveFilters: true,
    });

    expect(html).toContain('aria-label="Filters · 1"');
    expect(html).toContain('Filters · 1');
    expect(html).toContain('aria-selected="true"');
  });
});
