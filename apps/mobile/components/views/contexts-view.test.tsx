import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { runStoreCommand, runSyncStoreSave, type Task } from '@mindwtr/core';
import { Pressable, ScrollView, TouchableOpacity } from 'react-native';
import { ContextsView } from './contexts-view';

const now = '2026-06-11T00:00:00.000Z';

const makeTask = (id: string, title: string): Task => ({
  id,
  title,
  status: 'next',
  contexts: ['@work'],
  tags: [],
  createdAt: now,
  updatedAt: now,
} as Task);

const storeState = vi.hoisted(() => ({
  tasks: [] as Task[],
  _tasksById: new Map<string, Task>(),
  projects: [],
  settings: { appearance: {}, taskSortBy: 'default' },
  updateTask: vi.fn(async () => undefined),
  deleteTask: vi.fn(async () => undefined),
  restoreTask: vi.fn(async () => undefined),
  batchMoveTasks: vi.fn(async () => undefined),
  batchDeleteTasks: vi.fn(async () => undefined),
  batchUpdateTasks: vi.fn(async (_updates: { id: string; updates: Partial<Task> }[]): Promise<unknown> => undefined),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: Object.is,
    useTaskStore: Object.assign(
      (selector: (state: typeof storeState) => unknown) => selector(storeState),
      { getState: () => storeState },
    ),
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
}));

vi.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));

vi.mock('@/hooks/use-theme-colors', () => {
  // One object, like the real hook: rows compare `tc` by identity (#766).
  const themeColors = {
    bg: '#ffffff',
    border: '#d1d5db',
    cardBg: '#ffffff',
    filterBg: '#f8fafc',
    onTint: '#ffffff',
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

vi.mock('../task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('../token-picker-modal', () => ({
  TokenPickerModal: (props: any) => React.createElement('TokenPickerModal', props),
}));

vi.mock('../swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
}));

vi.mock('lucide-react-native', () => ({
  CheckCircle2: (props: any) => React.createElement('CheckCircle2', props),
  Tag: (props: any) => React.createElement('Tag', props),
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => (
      React.createElement(
        'FlatList',
        props,
        data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? item.id ?? index}>
            {renderItem?.({ item, index })}
          </React.Fragment>
        )),
      )
    ),
  };
});

describe('ContextsView', () => {
  it('keeps a parent chip selected when its last child task completes', async () => {
    storeState.tasks = [
      { ...makeTask('tool', 'Excavator'), contexts: ['@tools/excavator'] },
      { ...makeTask('other', 'Home'), contexts: ['@home'] },
    ];
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ContextsView />); });
    const chips = () => tree.root.findAllByType(ScrollView).find((node) => node.props.horizontal)!.findAllByType(Pressable);
    const parent = chips().find((node) => node.props.accessibilityLabel === '@tools (1)');
    expect(parent).toBeDefined();
    await act(async () => { parent!.props.onPress(); });
    expect(tree.root.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')).toHaveLength(1);
    storeState.tasks = storeState.tasks.map((entry) => entry.id === 'tool' ? { ...entry, status: 'done' } : entry);
    await act(async () => { tree.update(<ContextsView />); });
    expect(chips().find((node) => node.props.accessibilityLabel === '@tools (0)')?.props.accessibilityState.selected).toBe(true);
    expect(chips().some((node) => node.props.accessibilityLabel === '@tools/excavator (0)')).toBe(false);
    expect(tree.root.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')).toHaveLength(0);
    await act(async () => { chips().find((node) => node.props.accessibilityLabel === '@tools (0)')!.props.onPress(); });
    expect(tree.root.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')).toHaveLength(1);
  });

  it('keeps All, No context, contexts and tags in one scrollable filter row', async () => {
    storeState.tasks = [
      { ...makeTask('work', 'Work'), contexts: ['@work'], tags: ['#admin'] },
      { ...makeTask('none', 'Untagged'), contexts: [], tags: [] },
    ];
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ContextsView />); });
    const rows = tree.root.findAllByType(ScrollView).filter((node) => node.props.horizontal);
    expect(rows).toHaveLength(1);
    const chips = rows[0].findAllByType(Pressable);
    expect(chips).toHaveLength(4);
    expect(chips.map((node) => node.props.accessibilityLabel)).toEqual([
      'contexts.all', 'contexts.none', '@work (1)', '#admin (1)',
    ]);
    await act(async () => { chips[2].props.onPress(); });
    expect(chips[2].props.accessibilityState.selected).toBe(true);
    await act(async () => { chips[0].props.onPress(); });
    expect(chips[0].props.accessibilityState.selected).toBe(true);
    expect(tree.root.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')).toHaveLength(2);
  });

  it('shows All/Any for two combined tokens and keeps No context exclusive', async () => {
    storeState.tasks = [
      { ...makeTask('alice', 'Alice only'), contexts: ['@alice'], tags: [] },
      { ...makeTask('bob', 'Bob only'), contexts: [], tags: ['#bob'] },
      { ...makeTask('both', 'Alice and Bob'), contexts: ['@alice'], tags: ['#bob'] },
      { ...makeTask('other', 'Other'), contexts: ['@other'], tags: [] },
      { ...makeTask('none', 'Untagged'), contexts: [], tags: [] },
    ];
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ContextsView />); });
    const pressToken = async (label: string) => {
      const node = tree.root.find((item) => item.props.accessibilityLabel === label);
      await act(async () => { node.props.onPress(); });
    };
    const titles = () => tree.root.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
      .map((node) => node.props.task.title);
    await pressToken('@alice (2)');
    expect(tree.root.findAllByType(Pressable).filter((node) => node.props.accessibilityRole === 'radio')).toHaveLength(0);
    await pressToken('#bob (2)');
    expect(titles()).toEqual(['Alice and Bob']);
    const modes = tree.root.findAllByType(Pressable).filter((node) => node.props.accessibilityRole === 'radio');
    expect(modes).toHaveLength(2);
    expect(modes[0].props.accessibilityState).toEqual({ selected: true });
    await act(async () => { modes[1].props.onPress(); });
    expect(titles()).toEqual(['Alice only', 'Bob only', 'Alice and Bob']);
    expect(new Set(titles()).size).toBe(3);
    const none = tree.root.find((node) => node.props.accessibilityLabel === 'contexts.none');
    await act(async () => { none.props.onPress(); });
    expect(titles()).toEqual(['Untagged']);
    expect(tree.root.findAllByType(Pressable).filter((node) => node.props.accessibilityRole === 'radio')).toHaveLength(0);
  });

  it('adds a tag to the row a sync save published while the bulk write waited behind it', async () => {
    const setTasks = (tasks: Task[]) => {
      storeState.tasks = tasks;
      storeState._tasksById = new Map(tasks.map((task) => [task.id, task]));
    };
    const original = storeState.batchUpdateTasks;
    // batchUpdateTasks as the store runs it: a command behind the write gate (store-write-gate.ts).
    storeState.batchUpdateTasks = vi.fn((updates) => runStoreCommand(async () => {
      const byId = new Map(updates.map((entry) => [entry.id, entry.updates]));
      setTasks(storeState.tasks.map((task) => ({ ...task, ...byId.get(task.id) })));
      return { success: true };
    }));
    setTasks([{ ...makeTask('task-1', 'First'), tags: ['#old'] }]);
    let tree!: ReactTestRenderer;
    try {
      await act(async () => { tree = create(<ContextsView />); });
      const row = tree.root.find((node) => (node.type as unknown) === 'SwipeableTaskItem');
      await act(async () => { row.props.actions.toggleSelect(row.props.task); });
      const addTag = tree.root.findAllByType(TouchableOpacity).find((node) => node.findAllByProps({ children: 'bulk.addTag' }).length > 0)!;
      await act(async () => { addTag.props.onPress(); });

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      // Another device's tag: the sync save holds the gate, then publishes it.
      const save = runSyncStoreSave(async () => {
        await held;
        setTasks([{ ...storeState.tasks[0], rev: 3, tags: ['#old', '#remote'] }]);
      });
      act(() => { tree.root.find((node) => (node.type as unknown) === 'TokenPickerModal').props.onConfirm(['#new']); });
      release();
      await act(async () => { await save; await runStoreCommand(async () => undefined); });

      expect(storeState.tasks[0].tags).toEqual(['#new', '#old', '#remote']);
    } finally {
      storeState.batchUpdateTasks = original;
      setTasks([]);
    }
  });

  // Rows carry the #766 memo boundary, which only holds while the screen hands
  // untouched rows the same references back.
  it('hands rows stable prop references across a re-render', async () => {
    storeState.tasks = [makeTask('task-1', 'First'), makeTask('task-2', 'Second')];

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ContextsView />);
    });

    const rowProps = () => tree.root
      .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
      .map((node) => node.props);
    const before = rowProps();
    expect(before).toHaveLength(2);
    expect(before[0].actions).toBe(before[1].actions);
    expect(before[0].onContextPress).toBe(before[1].onContextPress);

    await act(async () => {
      tree.update(<ContextsView />);
    });

    const after = rowProps();
    expect(after[1].task).toBe(before[1].task);
    expect(after[1].actions).toBe(before[1].actions);
    expect(after[1].tc).toBe(before[1].tc);
    expect(after[1].onContextPress).toBe(before[1].onContextPress);
    expect(after[1].onTagPress).toBe(before[1].onTagPress);
  });
});
