import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

const now = '2026-06-11T00:00:00.000Z';

const makeTask = (id: string, title: string): Task => ({
  id,
  title,
  status: 'next',
  contexts: [],
  tags: [],
  createdAt: now,
  updatedAt: now,
} as Task);

const alerts = vi.hoisted(() => [] as { text: string; onPress?: () => unknown }[][]);

const storeState = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [],
  settings: {
    savedSearches: [{ id: 'search-1', name: 'Loose ends', query: 'loose' }],
    taskSortBy: 'default',
  },
  updateTask: vi.fn(async () => undefined),
  deleteTask: vi.fn(async () => undefined),
  fetchData: vi.fn(async () => undefined),
  updateSettings: vi.fn(async () => undefined),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: Object.is,
    useTaskStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
  };
});

vi.mock('expo-router', () => ({
  router: { back: vi.fn(), canGoBack: () => false, replace: vi.fn() },
  useLocalSearchParams: () => ({ id: 'search-1' }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('@/hooks/use-theme-colors', () => {
  // One object, like the real hook: rows compare `tc` by identity (#766).
  const themeColors = {
    bg: '#ffffff',
    border: '#d1d5db',
    cardBg: '#ffffff',
    secondaryText: '#64748b',
    taskItemBg: '#ffffff',
    text: '#0f172a',
    tint: '#2563eb',
  };
  return { useThemeColors: () => themeColors };
});

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({
    areaById: new Map(),
    resolvedAreaFilter: { included: [], excluded: [] },
    sortedAreas: [],
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('@/components/swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('lucide-react-native', () => ({
  ArrowUpDown: (props: any) => React.createElement('ArrowUpDown', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    Alert: { alert: (_title: string, _message: string, buttons: (typeof alerts)[number]) => { alerts.push(buttons); } },
    RefreshControl: (props: any) => React.createElement('RefreshControl', props),
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => (
      React.createElement(
        'FlatList',
        props,
        data.length > 0
          ? data.map((item: any, index: number) => (
            <React.Fragment key={keyExtractor?.(item, index) ?? item.id ?? index}>
              {renderItem?.({ item, index })}
            </React.Fragment>
          ))
          : null,
      )
    ),
  };
});

import SavedSearchScreen from './[id]';

describe('SavedSearchScreen', () => {
  // Rows carry the #766 memo boundary, which only holds while the screen hands
  // untouched rows the same references back.
  it('hands rows stable prop references across a re-render', async () => {
    storeState.tasks = [makeTask('task-1', 'loose one'), makeTask('task-2', 'loose two')];

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<SavedSearchScreen />);
    });

    const rowProps = () => tree.root
      .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
      .map((node) => node.props);
    const before = rowProps();
    expect(before).toHaveLength(2);
    expect(before[0].actions).toBe(before[1].actions);

    await act(async () => {
      tree.update(<SavedSearchScreen />);
    });

    const after = rowProps();
    expect(after[1].task).toBe(before[1].task);
    expect(after[1].actions).toBe(before[1].actions);
    expect(after[1].tc).toBe(before[1].tc);
  });

  it('labels the Delete icon as a button', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<SavedSearchScreen />);
    });

    const [deleteButton] = tree.root.findAll((node) => (
      typeof node.type === 'string' && node.findAll((child) => (child.type as unknown) === 'Trash2').length > 0
      && node.props.onPress !== undefined
    ));
    expect(deleteButton.props.accessibilityRole).toBe('button');
    expect(deleteButton.props.accessibilityLabel).toBeTruthy();
  });

  // The confirmation may stay open while another device or screen changes the
  // saved searches: Delete removes this one from the list as it is then.
  it('deletes against the current saved searches, not the list from render', async () => {
    const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const added = { id: 'search-2', name: 'Added meanwhile', query: 'meanwhile' };
    const updateSettings = vi.fn(async () => undefined);
    core.useTaskStore.setState({
      settings: { savedSearches: [...storeState.settings.savedSearches, added] },
      updateSettings,
    } as never);
    alerts.length = 0;

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<SavedSearchScreen />);
    });
    const deleteButton = tree.root.find((node) => (
      typeof node.type === 'string' && node.props.accessibilityLabel !== undefined
      && node.findAll((child) => (child.type as unknown) === 'Trash2').length > 0
    ));
    await act(async () => { deleteButton.props.onPress(); });
    const confirm = alerts[0].at(-1)!;
    await act(async () => { await confirm.onPress?.(); });

    expect(updateSettings).toHaveBeenCalledWith({ savedSearches: [added] });
  });

  // #1453: a saved search keeps its own sort; "Use global setting" clears it.
  it('sorts by the saved search sort and writes only a user choice', async () => {
    const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const own = { id: 'search-1', name: 'Loose ends', query: 'loose', sort: 'title' };
    const other = { id: 'search-2', name: 'Other', query: 'other' };
    const updateSettings = vi.fn(async () => undefined);
    const previousSettings = storeState.settings;
    storeState.settings = { savedSearches: [own, other], taskSortBy: 'default' } as never;
    storeState.tasks = [makeTask('task-b', 'loose b'), makeTask('task-a', 'loose a')];
    core.useTaskStore.setState({ settings: storeState.settings, updateSettings } as never);

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<SavedSearchScreen />);
    });
    const rowIds = () => tree.root
      .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
      .map((node) => node.props.task.id);
    expect(rowIds()).toEqual(['task-a', 'task-b']);
    // Opening the screen writes nothing.
    expect(updateSettings).not.toHaveBeenCalled();

    const option = (testID: string) => tree.root.find((node) => node.props.testID === testID && node.props.onPress);
    const label = (testID: string) => option(testID).findAll((node) => (node.type as unknown) === 'Text')[0]?.props.children;
    expect(label('sort-option-inherit')).toContain('Use global setting');
    await act(async () => { option('sort-option-start').props.onPress(); });
    expect(updateSettings).toHaveBeenLastCalledWith({ savedSearches: [{ ...own, sort: 'start' }, other] });

    await act(async () => { option('sort-option-inherit').props.onPress(); });
    expect(updateSettings).toHaveBeenLastCalledWith({ savedSearches: [{ id: 'search-1', name: 'Loose ends', query: 'loose' }, other] });
    storeState.settings = previousSettings;
  });
});
