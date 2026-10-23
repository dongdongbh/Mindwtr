import React from 'react';
import { Pressable, TouchableOpacity } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';

const mocks = vi.hoisted(() => {
  const batchUpdateTasks = vi.fn(async () => undefined);
  const batchMoveTasks = vi.fn(async () => undefined);
  const batchDeleteTasks = vi.fn(async () => undefined);
  const updateTask = vi.fn(async (_id: string, _updates: Partial<Task>): Promise<{ success: boolean } | undefined> => undefined);
  const deleteTask = vi.fn(async () => undefined);
  const restoreTask = vi.fn(async () => undefined);
  const modalPropsSpy = vi.fn();
  const showToast = vi.fn();
  const flushPendingSave = vi.fn(async () => undefined);
  const backListeners: (() => boolean)[] = [];

  return {
    backListeners,
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    deleteTask,
    modalPropsSpy,
    showToast,
    flushPendingSave,
    areaFilter: { included: [] as string[], excluded: [] as string[] },
    restoreTask,
    updateTask,
    storeState: {
      tasks: [] as Task[],
      // Bulk organize reads the stored rows by id when its write is admitted.
      get _tasksById() { return new Map(this.tasks.map((task) => [task.id, task])); },
      projects: [] as Project[],
      areas: [] as Area[],
      settings: {
        appearance: {},
        taskSortBy: 'default',
      },
      batchDeleteTasks,
      batchMoveTasks,
      batchUpdateTasks,
      deleteTask,
      restoreTask,
      updateTask,
    },
  };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    flushPendingSave: mocks.flushPendingSave,
    shallow: Object.is,
    useTaskStore: Object.assign(
      (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
      { getState: () => mocks.storeState },
    ),
  };
});

vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock('@react-navigation/native', () => ({
  NavigationContext: React.createContext(undefined),
  useFocusEffect: () => undefined,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({ showToast: mocks.showToast, dismissToast: vi.fn() }),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'bulk.addTag': 'Add tag',
      'bulk.delete': 'Delete',
      'bulk.moveTo': 'Move to',
      'bulk.organize': 'Organize',
      'bulk.selected': 'selected',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete',
      'common.share': 'Share',
      'common.tasks': 'tasks',
      'persistence.saved': 'Changes saved',
      'dailyReview.title': 'Daily Review',
      'review.activeTasks': 'active tasks',
      'review.expandAreas': 'Expand areas',
      'review.expandEverything': 'Expand projects',
      'review.hasNextAction': 'Has next action',
      'review.needsAction': 'Needs action',
      'review.needsActionSummary': 'needs action',
      'review.noArea': 'No area',
      'review.noTasks': 'No tasks',
      'review.openGuide': 'Guided review',
      'review.projectsLabel': 'projects',
      'review.singleActions': 'Single actions',
      'review.startReview': 'Start Review',
      'review.scopeDue': 'Due for review',
      'review.scopeAll': 'All open tasks',
      'review.dueHelp': 'Due reminders',
      'review.overviewHelp': 'All open tasks',
      'review.dueEmpty': 'No reminders due',
      'review.overviewEmpty': 'No open tasks',
      'review.markReviewed': 'Mark reviewed',
      'review.markReviewedDone': 'Marked reviewed',
      'review.advanceWeek': 'Review in 1 week',
      'review.unassigned': 'Unassigned',
      'review.withoutArea': 'without an area',
      'status.done': 'Done',
      'status.inbox': 'Inbox',
      'status.next': 'Next',
      'status.reference': 'Reference',
      'status.someday': 'Someday',
      'status.waiting': 'Waiting',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => {
  // One object, like the real hook: rows compare `tc` by identity (#766).
  const themeColors = {
    bg: '#ffffff',
    border: '#d1d5db',
    cardBg: '#ffffff',
    danger: '#dc2626',
    filterBg: '#f8fafc',
    inputBg: '#ffffff',
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
    areaById: new Map(mocks.storeState.areas.map((area) => [area.id, area])),
    resolvedAreaFilter: mocks.areaFilter,
    sortedAreas: mocks.storeState.areas,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('@/components/review-modal', () => ({
  ReviewModal: (props: any) => React.createElement('ReviewModal', props),
}));

vi.mock('@/components/swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('@/components/task-list/TaskListBulkOrganizeModal', () => ({
  TaskListBulkOrganizeModal: (props: any) => {
    mocks.modalPropsSpy(props);
    return React.createElement('TaskListBulkOrganizeModal', props);
  },
}));

vi.mock('lucide-react-native', () => ({
  ChevronDown: (props: any) => React.createElement('ChevronDown', props),
  ChevronRight: (props: any) => React.createElement('ChevronRight', props),
  ChevronsDown: (props: any) => React.createElement('ChevronsDown', props),
  ChevronsUp: (props: any) => React.createElement('ChevronsUp', props),
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    BackHandler: {
      addEventListener: (_event: string, listener: () => boolean) => {
        mocks.backListeners.push(listener);
        return { remove: () => { mocks.backListeners.splice(mocks.backListeners.indexOf(listener), 1); } };
      },
    },
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => {
      const children = data.length > 0
        ? data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? item.id ?? index}>
            {renderItem?.({ item, index })}
          </React.Fragment>
        ))
        : typeof ListEmptyComponent === 'function'
          ? <ListEmptyComponent />
          : ListEmptyComponent;
      return React.createElement('FlatList', props, children);
    },
    Share: {
      share: vi.fn().mockResolvedValue({ action: 'sharedAction' }),
    },
  };
});

import ReviewScreen from '../app/(drawer)/review';

const now = '2026-06-11T00:00:00.000Z';

const makeArea = (id: string, name: string): Area => ({
  id,
  name,
  color: '#2563eb',
  order: 0,
  createdAt: now,
  updatedAt: now,
});

const makeTask = (id: string, title: string, updates: Partial<Task> = {}): Task => ({
  id,
  title,
  status: 'next',
  contexts: [],
  tags: [],
  createdAt: now,
  updatedAt: now,
  ...updates,
});

const flattenText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
  if (React.isValidElement<{ children?: unknown }>(value)) return flattenText(value.props.children);
  return '';
};

const pressButtonWithText = (tree: ReactTestRenderer, text: string) => {
  const button = tree.root.findAllByType(TouchableOpacity).find((node) => (
    flattenText(node.props.children).includes(text)
  ));
  expect(button).toBeTruthy();
  act(() => {
    button?.props.onPress();
  });
};

const pressButtonWithLabel = (tree: ReactTestRenderer, label: string) => {
  const button = tree.root.findAllByType(TouchableOpacity).find((node) => (
    node.props.accessibilityLabel === label
  ));
  expect(button).toBeTruthy();
  act(() => {
    button?.props.onPress();
  });
};

describe('ReviewScreen bulk organize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.batchUpdateTasks.mockResolvedValue(undefined);
    mocks.updateTask.mockResolvedValue(undefined);
    mocks.flushPendingSave.mockResolvedValue(undefined);
    mocks.areaFilter = { included: [], excluded: [] };
    mocks.storeState.areas = [makeArea('area-work', 'Work')];
    mocks.storeState.projects = [];
    mocks.storeState.tasks = [makeTask('task-1', 'Loose next action')];
  });

  it('bulk-applies an area from the review selection organize modal', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ReviewScreen />);
    });

    pressButtonWithText(tree, 'All open tasks');

    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');

    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    act(() => {
      row.props.onLongPressAction(row.props.task);
    });

    pressButtonWithText(tree, 'Organize');
    const modalProps = mocks.modalPropsSpy.mock.calls.at(-1)?.[0];
    expect(modalProps.visible).toBe(true);
    expect(modalProps.areas.map((area: Area) => area.id)).toEqual(['area-work']);

    await act(async () => {
      await modalProps.onApply({ status: 'next', areaId: 'area-work' });
    });

    expect(mocks.batchUpdateTasks).toHaveBeenCalledWith([
      {
        id: 'task-1',
        updates: expect.objectContaining({
          areaId: 'area-work',
          projectId: undefined,
          status: 'next',
        }),
      },
    ]);
  });

  // RN runs Back listeners newest first and stops at the first that returns true.
  it('keeps selection on Android Back while a review dialog is open, then leaves it (#1415)', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ReviewScreen />);
    });
    pressButtonWithText(tree, 'All open tasks');
    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');
    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    act(() => {
      row.props.onLongPressAction(row.props.task);
    });
    const pressBack = () => {
      let handled = false;
      act(() => {
        handled = [...mocks.backListeners].reverse().some((listener) => listener());
      });
      return handled;
    };
    const selecting = () => tree.root.findAllByType(TouchableOpacity).some((node) => flattenText(node.props.children) === 'Organize');

    pressButtonWithText(tree, 'Organize');
    expect(mocks.modalPropsSpy.mock.calls.at(-1)?.[0].visible).toBe(true);
    expect(pressBack()).toBe(false);
    expect(selecting()).toBe(true);

    act(() => {
      mocks.modalPropsSpy.mock.calls.at(-1)?.[0].onClose();
    });
    expect(pressBack()).toBe(true);
    expect(selecting()).toBe(false);
  });

  it('gives every bulk bar action the button role', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ReviewScreen />);
    });
    pressButtonWithText(tree, 'All open tasks');
    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');
    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    act(() => {
      row.props.onLongPressAction(row.props.task);
    });

    const roles = ['Cancel', 'Organize', 'Move to', 'Add tag', 'Remove tag', 'Share', 'Delete'].map((label) => {
      const button = tree.root.findAll((node) => (
        typeof node.type === 'string' && node.props.onPress !== undefined && flattenText(node.props.children) === label
      ))[0];
      return [label, button?.props.accessibilityRole];
    });
    expect(roles).toEqual([
      ['Cancel', 'button'], ['Organize', 'button'], ['Move to', 'button'], ['Add tag', 'button'],
      ['Remove tag', 'button'], ['Share', 'button'], ['Delete', 'button'],
    ]);
  });

  // Rows carry the #766 memo boundary, which only holds while the screen hands
  // untouched rows the same references back.
  it('hands rows stable prop references across a re-render', async () => {
    mocks.storeState.tasks = [
      makeTask('task-1', 'Loose next action'),
      makeTask('task-2', 'Second loose action'),
    ];

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ReviewScreen />);
    });
    pressButtonWithText(tree, 'All open tasks');
    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');

    const rowProps = () => tree.root
      .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
      .map((node) => node.props);
    const before = rowProps();
    expect(before).toHaveLength(2);
    expect(before[0].actions).toBe(before[1].actions);
    expect(before[0].onLongPressAction).toBe(before[1].onLongPressAction);

    await act(async () => {
      tree.update(<ReviewScreen />);
    });

    const after = rowProps();
    expect(after[1].task).toBe(before[1].task);
    expect(after[1].actions).toBe(before[1].actions);
    expect(after[1].tc).toBe(before[1].tc);
    expect(after[1].onLongPressAction).toBe(before[1].onLongPressAction);
  });

  it('shows only due reminders by default, then preserves the whole-system overview', async () => {
    mocks.storeState.tasks = [
      makeTask('due', 'Review me', { reviewAt: '2026-01-01' }),
      makeTask('future', 'Later', { reviewAt: '2099-01-01' }),
      makeTask('undated', 'No reminder'),
    ];
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ReviewScreen />); });
    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');
    const rows = () => tree.root.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem');
    expect(rows().map((row) => row.props.task.id)).toEqual(['due']);

    pressButtonWithText(tree, 'All open tasks');
    expect(rows().map((row) => row.props.task.id)).toEqual(['due', 'future', 'undated']);
  });

  it('waits for a saved mark-reviewed write and leaves a retry on save failure', async () => {
    mocks.storeState.tasks = [makeTask('due', 'Review me', { reviewAt: '2026-01-01' })];
    mocks.updateTask.mockImplementation(async (id: string, updates: Partial<Task>) => {
      mocks.storeState.tasks = mocks.storeState.tasks.map((task) => task.id === id ? { ...task, ...updates } : task);
      return { success: true };
    });
    mocks.flushPendingSave.mockRejectedValueOnce(new Error('disk full'));
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ReviewScreen />); });
    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');
    await act(async () => { tree.root.findByProps({ accessibilityLabel: 'Mark reviewed: Review me' }).props.onPress(); });
    expect(mocks.updateTask).toHaveBeenCalledWith('due', { reviewAt: undefined });
    expect(mocks.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    mocks.storeState.tasks = [makeTask('due', 'Review me', { reviewAt: '2026-01-01' })];
    await act(async () => { tree.update(<ReviewScreen />); });
    await act(async () => { tree.root.findByProps({ accessibilityLabel: 'common.retry' }).props.onPress(); });
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Changes saved', tone: 'success' }));
    expect(mocks.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Marked reviewed', tone: 'success' }));
  });

  it('clears hidden selection after the area filter changes or its project folds', async () => {
    mocks.storeState.areas = [makeArea('area-a', 'A'), makeArea('area-b', 'B')];
    mocks.storeState.tasks = [
      makeTask('a', 'A task', { areaId: 'area-a', reviewAt: '2026-01-01' }),
      makeTask('b', 'B task', { areaId: 'area-b', reviewAt: '2026-01-01' }),
    ];
    mocks.areaFilter = { included: ['area-a'], excluded: [] };
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ReviewScreen />); });
    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');
    const selectedAction = () => tree.root.findAllByType(TouchableOpacity).find((node) => (
      flattenText(node.props.children) === 'Mark reviewed' && !node.props.accessibilityLabel
    ));
    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    act(() => { row.props.onLongPressAction(row.props.task); });
    expect(selectedAction()).toBeTruthy();

    mocks.areaFilter = { included: ['area-b'], excluded: [] };
    await act(async () => { tree.update(<ReviewScreen />); });
    expect(selectedAction()).toBeUndefined();
    expect(mocks.batchUpdateTasks).not.toHaveBeenCalled();

    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');
    const visible = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    act(() => { visible.props.onLongPressAction(visible.props.task); });
    expect(selectedAction()).toBeTruthy();
    const areaHeader = tree.root.findAllByType(Pressable).find((node) => (
      node.props.accessibilityState?.expanded && String(node.props.accessibilityLabel).startsWith('B,')
    ));
    expect(areaHeader).toBeTruthy();
    act(() => { areaHeader?.props.onPress(); });
    expect(selectedAction()).toBeUndefined();
  });
});
